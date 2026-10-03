'use strict';
/* TEAMS NOTIFY DANS MERGERIE : désactivé d'office, activé à chaud, branché au VRAI plugin Jenkins, et
 * piloté depuis Réglages dans un vrai navigateur — avec un FAUX `bin/teams-post.js` (aucun Playwright
 * ne touche Teams ici).
 *
 * Les plugins embarqués sont des COPIES dans un dossier temporaire (`MERGERIE_BUILTIN_PLUGINS_DIR`, posé
 * AVANT le premier require du serveur) : c'est la seule façon de substituer le script sans qu'un réglage
 * existe « pour les tests ». Les suites qui ont besoin de Chromium se sautent avec la commande à lancer. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EMBARQUES = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-embarques-teams-'));
process.env.MERGERIE_BUILTIN_PLUGINS_DIR = EMBARQUES;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');
const { copierAvecFaux, attendre, LIEN } = require('../plugins/jenkins-teams-notify/test/helpers');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Plugin Jenkins Teams Notify — dans Mergerie', () => {
  let app; let srv; let faux; let jkVeille; let navigateur; let page;

  before(async () => {
    faux = copierAvecFaux();
    fs.cpSync(path.join(__dirname, '..', 'plugins', 'jenkins'), path.join(EMBARQUES, 'jenkins'), { recursive: true });
    fs.cpSync(faux.dir, path.join(EMBARQUES, 'jenkins-teams-notify'), { recursive: true });
    // Le faux vit désormais dans la copie CHARGÉE par le serveur : c'est elle que les tests observent.
    const charge = path.join(EMBARQUES, 'jenkins-teams-notify');
    const lire = (nom) => { try { return fs.readFileSync(path.join(charge, 'bin', nom), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    faux = {
      dir: charge,
      appels: () => lire('calls.jsonl'),
      mode: (m) => fs.writeFileSync(path.join(charge, 'bin', 'mode.json'), JSON.stringify(m)),
      arg: (cle) => { const c = lire('calls.jsonl').at(-1); const x = c && c.argv.find((v) => v.startsWith(`--${cle}=`)); return x === undefined ? undefined : x.slice(cle.length + 3); },
      aDrapeau: (cle) => { const c = lire('calls.jsonl').at(-1); return !!c && c.argv.includes(`--${cle}`); },
    };
    faux.mode({ code: 0 });

    app = await startApp();
    await app.configure();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [{ name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [{ name: 'deploy', color: 'blue', buildable: true }] }];
    mock.state.details['/job/boutique/job/deploy'] = { name: 'deploy', color: 'blue', buildable: true, property: [], builds: [{ number: 41, result: 'SUCCESS', building: false, timestamp: 1, duration: 10, url: '' }] };
    await app.configureJenkins({ jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token });
    // eslint-disable-next-line global-require
    jkVeille = require(path.join(EMBARQUES, 'jenkins', 'src', 'veille'));
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
    fs.rmSync(EMBARQUES, { recursive: true, force: true });
    delete process.env.MERGERIE_BUILTIN_PLUGINS_DIR;
  });

  const fiche = async () => (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === 'jenkins-teams-notify');
  const journal = async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/log')).body.rows;

  test('désactivé par défaut : présent dans la liste, absent de la page, aucun script lancé', async () => {
    const f = await fiche();
    assert.deepEqual([f.builtin, f.enabled, f.active, f.state], [true, false, false, 'inactive']);
    assert.ok(!(await app.api('GET', '/')).text.includes('data-tab="jenkins-teams-notify"'));
    assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).status, 404, 'inactif : aucune route');
  });

  test('activé à chaud : ses permissions, ses événements écoutés, son onglet et son sous-onglet dans la page', async () => {
    const on = await app.api('POST', '/api/plugins/jenkins-teams-notify/enable');
    assert.equal(on.body.ok, true, on.body.error || '');
    const f = await fiche();
    assert.deepEqual([f.active, f.state], [true, 'active']);
    assert.deepEqual([...f.events.listens].sort(), ['jenkins.job.finished', 'jenkins.job.started']);
    assert.ok(f.permissions.includes('exec') && f.permissions.includes('storage'));
    const html = (await app.api('GET', '/')).text;
    assert.ok(html.includes('data-tab="jenkins-teams-notify"') && html.includes('data-sub="jenkins-teams-notifycfg"') && html.includes('id="sub-jenkins-teams-notifycfg"'));
    assert.ok(html.includes('/plugins/jenkins-teams-notify/bundle.js'));
    const s = (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body;
    assert.deepEqual([s.jenkins.present, s.jenkins.configured, s.state], [true, true, 'inconnu'], 'le service jenkins.status du VRAI plugin Jenkins est vu');
  });

  test('de bout en bout : un build lancé depuis Mergerie (vrai plugin Jenkins) puis fini → deux messages, avec l’adresse, la durée et le compte', async () => {
    const r = await app.api('PUT', '/api/plugins/jenkins-teams-notify/settings', { team_link: LIEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lancer = await app.api('POST', '/api/plugins/jenkins/build', { path: 'boutique/deploy', since: 41 });
    assert.equal(lancer.status, 200);
    await attendre(async () => (await journal()).length === 1, 'le message « démarré »');
    assert.equal(faux.arg('message'), `▶️ boutique/deploy démarré par ${mock.state.user} — ${srv.url}/job/boutique/job/deploy/`);
    assert.equal(faux.arg('channel-url'), LIEN);
    assert.ok(faux.arg('profile-dir').endsWith(path.join('plugin-data', 'jenkins-teams-notify', 'profile')), faux.arg('profile-dir'));

    mock.state.details['/job/boutique/job/deploy'].builds.unshift({ number: 42, result: 'SUCCESS', building: false, timestamp: 2, duration: 83000, url: `${srv.url}/job/boutique/job/deploy/42/` });
    assert.equal(await jkVeille.tourJenkins({ jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token }), 1);
    await attendre(async () => (await journal()).length === 2, 'le message « réussi »');
    assert.equal(faux.arg('message'), `✅ boutique/deploy #42 réussi en 1 min 23 s — ${srv.url}/job/boutique/job/deploy/42/`);
    assert.deepEqual((await journal()).map((x) => [x.event, x.status]).reverse(), [['started', 'ok'], ['success', 'ok']]);
  });

  test('Jenkins désactivé : Jenkins Teams Notify reste chargé, mais l’écran le dit', async () => {
    await app.api('POST', '/api/plugins/jenkins/disable');
    const s = (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body;
    assert.equal(s.jenkins.present, false);
    assert.equal((await fiche()).active, true, 'toujours chargé');
    await app.api('POST', '/api/plugins/jenkins/enable');
    assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.jenkins.present, true);
  });

  test('les réglages dangereux sont refusés par l’API : lien http, adresse CDP distante', async () => {
    assert.equal((await app.api('PUT', '/api/plugins/jenkins-teams-notify/settings', { team_link: 'http://teams.example/x' })).status, 400);
    assert.equal((await app.api('PUT', '/api/plugins/jenkins-teams-notify/settings', { cdp_url: 'http://evil.example:9222' })).status, 400);
    assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/settings')).body.team_link, LIEN, 'le lien d’avant est resté');
  });

  describe('dans le navigateur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    const ouvrirReglagesTeams = async () => {
      await page.click('nav button[data-tab="admin"]');
      await page.click('#tab-admin .subnav [data-sub="jenkins-teams-notifycfg"]');
      await page.waitForSelector('#sub-jenkins-teams-notifycfg.active', { timeout: ATTENTE });
      // Le formulaire se remplit APRÈS l'ouverture (il relit le serveur) : on attend la valeur, sinon la frappe d'un test est écrasée par le chargement.
      await page.waitForFunction((lien) => { const c = document.querySelector('#tnForm [name="team_link"]'); return c && c.value === lien; }, LIEN, { timeout: ATTENTE });
    };
    /* Le bouton se rend actif à la fin d'un geste : on attend l'EFFET (l'état serveur, puis l'écran), pas une durée. */
    const attendreLibre = async () => {
      await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.busy === null, 'geste terminé');
      await page.waitForFunction(() => { const b = document.querySelector('#tnTest'); return b && !b.disabled; }, null, { timeout: ATTENTE });
    };

    before(async () => {
      await app.api('PUT', '/api/plugins/jenkins-teams-notify/settings', { team_link: LIEN, session_state: 'inconnu' });
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1300, height: 950 } });
      await afficherMenusOptionnels(page);
      await page.goto(app.base);
    });

    test('Réglages → Teams : on remplit, on enregistre — et le serveur le tient', async () => {
      await ouvrirReglagesTeams();
      assert.equal(await page.inputValue('#tnForm [name="team_link"]'), LIEN, 'le formulaire relit ce que le serveur tient');
      await page.fill('#tnForm [name="channel_name"]', 'Deploiements');
      await page.fill('#tnForm [name="job_filter"]', 'boutique/*');
      await page.fill('#tnForm [name="template_started"]', 'GO {{job}}');
      await page.fill('#tnForm [name="retention_days"]', '30');
      await page.click('#tnForm button[type="submit"]');
      await attendre(async () => { const s = (await app.api('GET', '/api/plugins/jenkins-teams-notify/settings')).body; return s.channel_name === 'Deploiements' && s.job_filter === 'boutique/*' && s.template_started === 'GO {{job}}' && s.retention_days === 30; }, 'les réglages sont enregistrés côté serveur');
      assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/settings')).body.session_state, 'inconnu', 'l’état caché n’a pas été écrasé par le formulaire');
      // Le champ « adresse CDP » n'apparaît qu'en mode CDP.
      assert.equal(await page.locator('#tnCdpRow').isHidden(), true);
      await page.selectOption('#tnForm [name="session_mode"]', 'cdp');
      await page.waitForSelector('#tnCdpRow', { state: 'visible' });
      await page.selectOption('#tnForm [name="session_mode"]', 'profile');
    });

    test('« Envoyer un message de test » : le faux script est appelé, la ligne apparaît au journal', async () => {
      const avant = faux.appels().length;
      await page.click('#tnTest');
      await attendre(() => faux.appels().length === avant + 1, 'le script a été appelé');
      await attendreLibre();
      assert.match(faux.arg('message'), /message de test/);
      assert.equal(faux.arg('channel-name'), 'Deploiements');
      await page.waitForFunction(() => [...document.querySelectorAll('#tnLog .tn-log tbody tr')].some((tr) => /\(test\)/.test(tr.textContent) && /envoyé/.test(tr.textContent)), null, { timeout: ATTENTE });
      assert.equal(await page.locator('#tnStatus .tn-bad').count(), 0, 'aucun problème affiché');
    });

    test('« Enregistrer et envoyer un message de test » : la saisie est enregistrée PUIS testée, sans passer par « Enregistrer »', async () => {
      /* On est DÉJÀ sur la page (le test d'avant l'a laissée ouverte) : la rouvrir relancerait le chargement du formulaire, dont la
         réponse écraserait la frappe qui suit — l'écran n'a rien de faux, c'est le test qui se ferait doubler. */
      await page.waitForSelector('#sub-jenkins-teams-notifycfg.active', { timeout: ATTENTE });
      const avant = faux.appels().length;
      await page.fill('#tnForm [name="channel_name"]', 'Deploiements-2');
      await page.click('#tnSaveTest');
      await attendre(() => faux.appels().length === avant + 1, 'le script a été appelé');
      await attendreLibre();
      assert.equal(faux.arg('channel-name'), 'Deploiements-2', 'le test a utilisé ce qui venait d’être saisi');
      assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/settings')).body.channel_name, 'Deploiements-2', 'et c’est enregistré');
      await page.fill('#tnForm [name="channel_name"]', 'Deploiements');
      await page.click('#tnForm button[type="submit"]');
      await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/settings')).body.channel_name === 'Deploiements', 'remis');
    });

    test('code 2 : la pastille de l’onglet et la section du brief « connexion requise » apparaissent', async () => {
      faux.mode({ code: 2, stderr: 'Session Teams expirée' });
      await page.click('#tnTest');
      await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.state === 'connexion-requise', 'état « connexion requise »');
      await attendreLibre();
      await page.waitForFunction(() => { const b = document.querySelector('#nav-jenkins-teams-notify-warn'); return b && !b.hidden && b.textContent === '1'; }, null, { timeout: ATTENTE });
      await page.waitForFunction(() => [...document.querySelectorAll('#tnLog .tn-log tbody tr')].some((tr) => /connexion requise/.test(tr.textContent)), null, { timeout: ATTENTE });
      await page.click('nav button[data-tab="notes"]');
      await page.waitForSelector('[data-plugin-brief="connexion"] [data-tn-open]', { timeout: ATTENTE });
      await page.click('[data-plugin-brief="connexion"] [data-tn-open]');
      await page.waitForSelector('#sub-jenkins-teams-notifycfg.active', { timeout: ATTENTE });
    });

    test('tant que la connexion est requise, un build n’appelle plus le script ; « Ouvrir Teams » (dry-run, fenêtre visible) lève le blocage', async () => {
      const avant = faux.appels().length;
      await app.api('POST', '/api/plugins/jenkins/build', { path: 'boutique/deploy', since: 42 });
      await attendre(async () => (await journal()).some((x) => x.status === 'ignoree'), 'ligne « ignoré »');
      assert.equal(faux.appels().length, avant, 'le script n’a pas été rappelé');

      faux.mode({ code: 0 });
      await page.click('#tnLogin');
      await attendre(() => faux.appels().length === avant + 1, 'la connexion a lancé le script');
      await attendreLibre();
      assert.ok(faux.aDrapeau('dry-run'));
      assert.equal(faux.arg('headless'), 'false');
      await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.state === 'ok', 'session ok');
      await page.waitForFunction(() => { const b = document.querySelector('#nav-jenkins-teams-notify-warn'); return b && b.hidden; }, null, { timeout: ATTENTE });
    });

    test('« Oublier la session » demande confirmation puis efface le profil', async () => {
      await ouvrirReglagesTeams();
      const profil = faux.arg('profile-dir');
      fs.mkdirSync(path.join(profil, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(profil, 'Default', 'Cookies'), 'secret');
      await page.click('#tnReset');
      await page.click('#confirmOk');
      await attendre(() => !fs.existsSync(profil), 'le profil est effacé');
      await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.state === 'inconnu', 'état inconnu');
    });
  });

  test('désactivé à chaud : onglet et routes retirés, journal et réglages conservés', async () => {
    const lignes = (await journal()).length;
    assert.ok(lignes >= 2);
    assert.equal((await app.api('POST', '/api/plugins/jenkins-teams-notify/disable')).status, 200);
    assert.ok(!(await app.api('GET', '/')).text.includes('data-tab="jenkins-teams-notify"'));
    assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/log')).status, 404);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM plugin_jenkins_teams_notify_log').get().c, lignes, 'le journal est intact');
    assert.equal((await app.api('POST', '/api/plugins/jenkins-teams-notify/enable')).body.ok, true);
    assert.equal((await journal()).length, lignes);
  });
});
