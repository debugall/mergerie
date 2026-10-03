'use strict';
/* Le plugin, SANS Mergerie : un ctx en mémoire (createTestContext), `activate()`, de vrais événements `jenkins.job.*`,
   et un FAUX `bin/teams-post.js` qui note ses appels. On prouve ce qui part (arguments, ordre), ce qui reste au
   journal, et ce que devient l'état de la session — de vrais processus enfants, sans navigateur. */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activatePlugin } = require('../../../sdk');
const { copierAvecFaux, attendre, LIEN, SUCCES, DEBUT } = require('./helpers');

const ouverts = [];
afterEach(async () => { while (ouverts.length) { const t = ouverts.pop(); try { await t.deactivate(); t.close(); } catch { /* déjà fermé */ } } });

async function monter({ config = { team_link: LIEN }, jenkins = true, demo = false, mode = { code: 0 } } = {}) {
  const faux = copierAvecFaux();
  faux.mode(mode);
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenkins-teams-notify-data-'));
  const t = await activatePlugin(faux.dir, { dataDir, demo });
  ouverts.push(t);
  if (jenkins) t.registre.registerService('jenkins', 'status', () => ({ active: true, configured: true }));
  if (config) t.ctx.settings.set(config);
  const rows = () => t.db.prepare('SELECT job, event, status, error FROM plugin_jenkins_teams_notify_log ORDER BY id').all();
  const statut = async () => (await t.http.call('GET', '/status')).body;
  const reglage = (k) => t.ctx.settings.get(k);
  return { t, faux, dataDir, rows, statut, reglage };
}

describe('les événements Jenkins produisent un appel du script', () => {
  test('jenkins.job.started : UN appel, avec les bons arguments', async () => {
    const { t, faux, dataDir, rows } = await monter();
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'une ligne au journal');
    assert.equal(faux.appels().length, 1);
    assert.equal(faux.arg('message'), '▶️ boutique/deploy démarré par moi — https://jenkins.test/job/boutique/job/deploy/');
    assert.equal(faux.arg('channel-url'), LIEN);
    assert.equal(faux.arg('profile-dir'), path.join(dataDir, 'profile'), 'le profil vit dans le dossier privé du plugin (ctx.dataDir)');
    assert.equal(faux.arg('headless'), 'true');
    assert.equal(faux.arg('cdp-url'), undefined);
    assert.equal(faux.aDrapeau('dry-run'), false);
    assert.deepEqual(rows().map((r) => [r.job, r.event, r.status]), [['boutique/deploy', 'started', 'ok']]);
  });

  test('jenkins.job.finished : le message dit le numéro, la durée, l’adresse — SUCCESS, FAILURE et ABORTED ont chacun le leur', async () => {
    const { t, faux, rows } = await monter();
    await t.emit('jenkins.job.finished', SUCCES);
    await t.emit('jenkins.job.finished', { ...SUCCES, number: 13, result: 'FAILURE', ok: false, duration: 5000 });
    await t.emit('jenkins.job.finished', { ...SUCCES, number: 14, result: 'ABORTED', ok: false });
    await attendre(() => rows().length === 3, 'trois lignes');
    const messages = faux.appels().map((c) => c.argv.find((a) => a.startsWith('--message=')).slice(10));
    assert.deepEqual(messages, [
      '✅ boutique/deploy #12 réussi en 1 min 23 s — https://jenkins.test/job/boutique/job/deploy/12/',
      '❌ boutique/deploy #13 en échec (FAILURE) après 5 s — https://jenkins.test/job/boutique/job/deploy/12/',
      '⏹️ boutique/deploy #14 interrompu — https://jenkins.test/job/boutique/job/deploy/12/',
    ]);
    assert.deepEqual(rows().map((r) => r.event), ['success', 'failure', 'aborted']);
  });

  test('les modèles se règlent ; une variable manquante donne un texte vide, sans crash', async () => {
    const { t, faux, rows } = await monter({ config: { team_link: LIEN, template_started: 'GO {{job}} par {{startedBy}} #{{number}}{{nimporte}}!' } });
    await t.emit('jenkins.job.started', { ...DEBUT, startedBy: undefined });
    await attendre(() => rows().length === 1, 'envoyé');
    assert.equal(faux.arg('message'), 'GO boutique/deploy par #!');
  });

  test('le filtre glob : un job hors filtre ne produit ni appel ni ligne', async () => {
    const { t, faux, rows } = await monter({ config: { team_link: LIEN, job_filter: 'boutique/*\nequipe/**' } });
    await t.emit('jenkins.job.started', { ...DEBUT, path: 'autre/job' });
    await t.emit('jenkins.job.started', { ...DEBUT, path: 'boutique/a/b' });
    await t.emit('jenkins.job.started', { ...DEBUT, path: 'equipe/x/y' });
    await attendre(() => rows().length === 1, 'un seul envoi');
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(rows().map((r) => r.job), ['equipe/x/y']);
    assert.equal(faux.appels().length, 1);
  });

  test('pas de lien configuré : le plugin se tait — pas d’appel, pas de bruit au journal', async () => {
    const { t, faux, rows } = await monter({ config: null });
    await t.emit('jenkins.job.started', DEBUT);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual([faux.appels().length, rows().length], [0, 0]);
  });

  test('mode CDP : l’adresse est passée, le profil non', async () => {
    const { t, faux, rows } = await monter({ config: { team_link: LIEN, session_mode: 'cdp', cdp_url: 'http://127.0.0.1:9222' } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'envoyé');
    assert.equal(faux.arg('cdp-url'), 'http://127.0.0.1:9222');
    assert.equal(faux.arg('profile-dir'), undefined);
  });

  test('l’événement rend la main tout de suite : le bus n’attend pas le navigateur', async () => {
    const { t, faux, rows } = await monter({ mode: { code: 0, delay: 700 } });
    const t0 = Date.now();
    await t.emit('jenkins.job.started', DEBUT);
    assert.ok(Date.now() - t0 < 300, `emit a duré ${Date.now() - t0} ms : le handler a attendu le script`);
    await attendre(() => rows().length === 1, 'fini après coup');
    assert.equal(faux.appels().length, 1);
  });
});

describe('un message plein de métacaractères arrive intact — sans shell', () => {
  test('`; | $( )` et guillemets passent en UN argument, rien ne s’exécute', async () => {
    const piege = 'a; touch PWN1 | touch PWN2 $(touch PWN3) `touch PWN4` "q" \'r\' && touch PWN5 > PWN6';
    const { t, faux, rows } = await monter({ config: { team_link: LIEN, template_started: piege } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'envoyé');
    assert.equal(faux.arg('message'), piege, 'le message est arrivé tel quel');
    const appel = faux.appels()[0];
    assert.equal(appel.argv.filter((a) => a.startsWith('--message=')).length, 1, 'un seul élément d’argument');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      assert.ok(!fs.existsSync(path.join(faux.dir, 'bin', `PWN${n}`)) && !fs.existsSync(path.join(appel.cwd, `PWN${n}`)), `PWN${n} : rien n’a été exécuté`);
    }
  });
  test('l’environnement du script est minimal : ni jeton, ni variable du serveur', async () => {
    process.env.JENKINS_TOKEN_SECRET_DE_TEST = 'ne-doit-pas-fuiter';
    try {
      const { t, faux, rows } = await monter();
      await t.emit('jenkins.job.started', DEBUT);
      await attendre(() => rows().length === 1, 'envoyé');
      const env = faux.appels()[0].env;
      assert.ok(!env.includes('JENKINS_TOKEN_SECRET_DE_TEST'));
      assert.ok(env.includes('PATH'));
    } finally { delete process.env.JENKINS_TOKEN_SECRET_DE_TEST; }
  });
});

describe('la file sérialise les envois', () => {
  test('trois événements rapprochés : trois processus, JAMAIS deux en même temps', async () => {
    const { t, faux, rows } = await monter({ mode: { code: 0, delay: 120 } });
    for (const n of [1, 2, 3]) await t.emit('jenkins.job.finished', { ...SUCCES, number: n });
    await attendre(() => rows().length === 3, 'trois envois', 15000);
    const debuts = faux.appels().map((c) => c.start); const fins = faux.fins().map((c) => c.end);
    assert.equal(debuts.length, 3);
    assert.ok(debuts[1] >= fins[0] && debuts[2] >= fins[1], `chevauchement : débuts ${debuts} fins ${fins}`);
    assert.deepEqual(faux.appels().map((c) => c.argv.find((a) => a.startsWith('--message=')).match(/#(\d)/)[1]), ['1', '2', '3'], 'dans l’ordre d’arrivée');
  });
});

describe('codes de sortie, tentatives et connexion requise', () => {
  test('un échec ordinaire (code 1) est réessayé UNE fois puis journalisé ; la session reste inchangée', async () => {
    const { t, faux, rows, reglage } = await monter({ mode: { code: 1, stderr: 'Éditeur de message introuvable (sélecteur à mettre à jour ?)' } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.equal(faux.appels().length, 2, 'un essai + un réessai');
    assert.deepEqual([rows()[0].status, reglage('session_state')], ['echec', 'inconnu']);
    assert.match(rows()[0].error, /Éditeur de message introuvable/);
  });

  test('le code 2 : « connexion requise » — UN seul appel, pas de réessai, pas de boucle', async () => {
    const { t, faux, rows, reglage, statut } = await monter({ mode: { code: 2, stderr: 'Session Teams expirée' } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.equal(faux.appels().length, 1, 'aucun réessai sur une session expirée');
    assert.deepEqual([rows()[0].status, reglage('session_state'), (await statut()).state], ['session', 'connexion-requise', 'connexion-requise']);
  });

  test('connexion requise : les événements suivants N’APPELLENT PLUS le script, jusqu’au prochain test manuel RÉUSSI', async () => {
    const { t, faux, rows, reglage, statut } = await monter({ mode: { code: 2 } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => reglage('session_state') === 'connexion-requise', 'état posé');
    assert.equal(faux.appels().length, 1);

    // Les événements suivants sont notés « ignoré », sans lancer le script (même si le script irait mieux entre-temps).
    faux.mode({ code: 0 });
    await t.emit('jenkins.job.finished', SUCCES);
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 3, 'deux lignes « ignoré »');
    assert.equal(faux.appels().length, 1, 'le script n’a pas été rappelé');
    assert.deepEqual(rows().slice(1).map((r) => r.status), ['ignoree', 'ignoree']);

    // Un test manuel qui ÉCHOUE ne lève pas le blocage.
    faux.mode({ code: 2 });
    assert.equal((await t.http.call('POST', '/test')).body.accepted, true);
    await attendre(async () => (await statut()).busy === null && faux.appels().length === 2, 'le test a tourné');
    assert.equal(reglage('session_state'), 'connexion-requise');
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 5, 'ligne du test + ligne ignorée');
    assert.equal(faux.appels().length, 2, 'toujours bloqué');

    // Un test manuel qui RÉUSSIT : la session est de nouveau « ok », les envois reprennent.
    faux.mode({ code: 0 });
    await t.http.call('POST', '/test');
    await attendre(() => reglage('session_state') === 'ok', 'session ok');
    assert.equal(faux.appels().length, 3);
    assert.match(faux.arg('message'), /message de test/);
    await t.emit('jenkins.job.finished', SUCCES);
    await attendre(() => faux.appels().length === 4, 'les envois reprennent');
  });

  test('« Ouvrir Teams pour se connecter » : sans fenêtre masquée, en dry-run, avec le délai de connexion — et il lève le blocage', async () => {
    const { t, faux, reglage, statut } = await monter({ config: { team_link: LIEN, headless: true, session_state: 'connexion-requise' }, mode: { code: 0, delay: 250 } });
    const r = await t.http.call('POST', '/login');
    assert.deepEqual([r.body.accepted, r.body.busy], [true, 'login']);
    assert.equal((await statut()).busy, 'login', 'l’écran voit l’action en cours');
    assert.equal((await t.http.call('POST', '/login')).status, 409, 'une seule action Teams à la fois');
    await attendre(async () => (await statut()).busy === null && faux.appels().length === 1, 'fini');
    assert.ok(faux.aDrapeau('dry-run'));
    assert.equal(faux.arg('headless'), 'false', 'fenêtre visible : même si le réglage dit « sans fenêtre »');
    assert.equal(faux.arg('login-timeout-ms'), '300000');
    assert.equal(faux.arg('message'), '', 'rien à poster');
    assert.equal(reglage('session_state'), 'ok');
  });

  test('prérequis manquant (code 3) : un appel, journalisé tel quel, la session n’est pas touchée', async () => {
    const { t, faux, rows, reglage } = await monter({ mode: { code: 3, stderr: 'Playwright introuvable : npm i playwright' } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.deepEqual([faux.appels().length, rows()[0].status, reglage('session_state')], [1, 'prerequis', 'inconnu']);
  });

  test('« Oublier la session » efface le profil et rend l’état « inconnu »', async () => {
    const { t, dataDir, reglage } = await monter({ config: { team_link: LIEN, session_state: 'ok' } });
    fs.mkdirSync(path.join(dataDir, 'profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'profile', 'Default', 'Cookies'), 'secret');
    assert.equal((await t.http.call('POST', '/session/reset')).body.ok, true);
    assert.ok(!fs.existsSync(path.join(dataDir, 'profile')));
    assert.equal(reglage('session_state'), 'inconnu');
  });
});

describe('Jenkins éteint', () => {
  test('le plugin reste chargé mais l’écran le dit ; rallumé, le message disparaît', async () => {
    const { t, statut } = await monter({ jenkins: false });
    let s = await statut();
    assert.deepEqual([s.jenkins.present, s.jenkins.configured], [false, false]);
    t.registre.registerService('jenkins', 'status', () => ({ active: true, configured: true }));
    s = await statut();
    assert.deepEqual([s.jenkins.present, s.jenkins.configured], [true, true]);
  });
});

describe('sécurité des réglages', () => {
  test('le lien Teams doit être en https ; l’adresse CDP doit être locale — refusés à l’enregistrement', async () => {
    const { t } = await monter({ config: null });
    for (const lien of ['http://teams.microsoft.com/x', 'ftp://x/y', 'javascript:alert(1)']) assert.throws(() => t.ctx.settings.set({ team_link: lien }), /motif|adresse|https/i, lien);
    for (const cdp of ['http://evil.example:9222', 'http://localhost.evil.com:9222', 'http://127.0.0.1@evil.com:9222', 'http://10.0.0.1:9222']) assert.throws(() => t.ctx.settings.set({ cdp_url: cdp }), /motif/i, cdp);
    assert.doesNotThrow(() => t.ctx.settings.set({ team_link: LIEN, cdp_url: 'http://127.0.0.1:9222' }));
    assert.doesNotThrow(() => t.ctx.settings.set({ cdp_url: 'http://localhost:9222' }));
  });
  test('et si une valeur interdite a tout de même atteint la base : rien n’est lancé, l’écran le dit', async () => {
    const { t, faux, rows, statut } = await monter({ config: null });
    t.db.prepare("INSERT OR REPLACE INTO plugin_setting (plugin, key, value, updated_at) VALUES ('jenkins-teams-notify', 'team_link', ?, ?)").run(JSON.stringify('http://pas-https.example/x'), new Date().toISOString());
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.equal(faux.appels().length, 0, 'aucun processus');
    assert.equal(rows()[0].status, 'echec');
    assert.deepEqual((await statut()).problems.map((p) => p.champ), ['team_link']);
  });
  test('seuls les champs du payload jenkins.job.* sortent : une session, une MR ou un jeton portés par un payload n’arrivent pas au script', async () => {
    const { t, faux, rows } = await monter({ config: { team_link: LIEN, template_started: '{{job}} {{session}} {{mr}} {{token}}' } });
    await t.emit('jenkins.job.started', { ...DEBUT, session: 'SESSION-SECRETE', mr: 'MR-PRIVEE', token: 'JETON' });
    await attendre(() => rows().length === 1, 'envoyé');
    const brut = JSON.stringify(faux.appels()[0].argv);
    assert.ok(!/SESSION-SECRETE|MR-PRIVEE|JETON/.test(brut), brut);
    assert.equal(faux.arg('message'), 'boutique/deploy');
  });
});

describe('journal, rétention, classement', () => {
  const ancien = (jours) => new Date(Date.now() - jours * 86_400_000).toISOString();
  const poser = (t, jours, job) => t.db.prepare('INSERT INTO plugin_jenkins_teams_notify_log (at, job, event, status, error) VALUES (?, ?, ?, ?, ?)').run(ancien(jours), job, 'started', 'ok', '');

  test('la table est locale (L) et porte le préfixe du plugin ; le journal ne garde pas le texte du message', async () => {
    const { t, rows } = await monter();
    assert.deepEqual(t.ctx.db.tables(), ['plugin_jenkins_teams_notify_log']);
    assert.equal(t.sortie.classements.plugin_jenkins_teams_notify_log, 'L');
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'envoyé');
    assert.deepEqual(Object.keys(rows()[0]).sort(), ['error', 'event', 'job', 'status'], 'horodatage, job, événement, statut, erreur — pas de message');
    assert.deepEqual(t.db.prepare("PRAGMA table_info('plugin_jenkins_teams_notify_log')").all().map((c) => c.name), ['id', 'at', 'job', 'event', 'status', 'error']);
  });
  test('la rétention : 90 jours par défaut ; au-delà, purgé à l’écriture', async () => {
    const { t, rows } = await monter();
    poser(t, 200, 'vieux'); poser(t, 91, 'vieux2'); poser(t, 80, 'recent');
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => t.db.prepare("SELECT COUNT(*) n FROM plugin_jenkins_teams_notify_log WHERE job = 'boutique/deploy'").get().n === 1, 'envoyé');
    assert.deepEqual(rows().map((r) => r.job), ['recent', 'boutique/deploy']);
  });
  test('0 = pour toujours ; un réglage entre 1 et 6 vaut 7, comme la rétention du cœur', async () => {
    const a = await monter({ config: { team_link: LIEN, retention_days: 0 } });
    poser(a.t, 1000, 'tres-vieux');
    await a.t.emit('jenkins.job.started', DEBUT);
    await attendre(() => a.rows().length === 2, 'envoyé');
    assert.deepEqual(a.rows().map((r) => r.job), ['tres-vieux', 'boutique/deploy']);

    const b = await monter({ config: { team_link: LIEN, retention_days: 3 } });
    poser(b.t, 6, 'six-jours'); poser(b.t, 8, 'huit-jours');
    await b.t.emit('jenkins.job.started', DEBUT);
    await attendre(() => b.t.db.prepare("SELECT COUNT(*) n FROM plugin_jenkins_teams_notify_log WHERE job = 'boutique/deploy'").get().n === 1, 'envoyé');
    assert.deepEqual(b.rows().map((r) => r.job), ['six-jours', 'boutique/deploy']);
  });
  test('le texte d’erreur gardé est tronqué', async () => {
    const { t, rows } = await monter({ mode: { code: 1, stderr: 'E'.repeat(900) } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.ok(rows()[0].error.length <= 200);
  });
  test('la route /log rend les lignes, la plus récente d’abord', async () => {
    const { t, rows } = await monter();
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'envoyé');
    await t.emit('jenkins.job.finished', SUCCES);
    await attendre(() => rows().length === 2, 'envoyé');
    const r = (await t.http.call('GET', '/log?limit=10')).body.rows;
    assert.deepEqual(r.map((x) => x.event), ['success', 'started']);
  });
});

describe('mode démo', () => {
  test('le processus est un faux qui réussit, sans Playwright ni script : la notification est journalisée', async () => {
    const { t, faux, rows, statut } = await monter({ demo: true, mode: { code: 1 } });
    await t.emit('jenkins.job.started', DEBUT);
    await attendre(() => rows().length === 1, 'journalisé');
    assert.equal(faux.appels().length, 0, 'le script n’a pas été lancé');
    assert.equal(rows()[0].status, 'ok');
    assert.equal((await statut()).demo, true);
  });
  test('ctx.demo.seed enregistre DEUX notifications fictives dans le journal', async () => {
    const { t, rows } = await monter({ demo: true, config: null });
    assert.equal(await t.seed(), 1);
    const lignes = rows();
    assert.equal(lignes.length, 2);
    assert.deepEqual(lignes.map((l) => [l.event, l.status]), [['started', 'ok'], ['success', 'ok']]);
  });
});

describe('le plugin : manifeste, permissions, écrans', () => {
  test('permissions au plus juste : chacune est réellement utilisée, et aucune autre n’est demandée', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const usages = { events: /ctx\.events\.on/, settings: /ctx\.settings\./, db: /ctx\.db\./, http: /ctx\.http\.router/, exec: /ctx\.exec\(/, storage: /ctx\.dataDir/, 'ui.tab': /ctx\.ui\.registerTab/, 'ui.actions': /ctx\.ui\.registerBriefSection/, demo: /ctx\.demo\./, services: /ctx\.services\./ };
    assert.deepEqual([...m.permissions].sort(), Object.keys(usages).sort());
    for (const [p, re] of Object.entries(usages)) assert.match(src, re, `la permission « ${p} » n’est pas utilisée`);
    assert.deepEqual(m.events, { listens: ['jenkins.job.started', 'jenkins.job.finished'], emits: [] });
    assert.deepEqual([m.builtin, m.enabledByDefault, m.apiVersion], [true, false, '1']);
  });
  test('un onglet (pastille), un sous-onglet de réglages et une section du brief sont déclarés', async () => {
    const { t } = await monter();
    const ui = t.ui();
    assert.deepEqual(ui.tabs.map((x) => x.id), ['jenkins-teams-notify']);
    assert.deepEqual(ui.settingsTabs.map((x) => [x.id, x.schemaForm]), [['jenkins-teams-notifycfg', false]]);
    assert.deepEqual(ui.briefSections.map((x) => x.id), ['connexion']);
  });
  test('désactiver retire abonnements et routes ; les tables restent', async () => {
    const { t } = await monter();
    assert.ok(t.bus.ecoutesPar('jenkins-teams-notify').length >= 2);
    await t.deactivate(); t.close();
    assert.equal(t.bus.ecoutesPar('jenkins-teams-notify').length, 0);
  });
});
