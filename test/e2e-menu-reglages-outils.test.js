'use strict';
/* MENU « RÉGLAGES » — CE QUI NE PASSE PAS PAR « ENREGISTRER » : L'OUTIL LUI-MÊME.
 *
 * Les gestes des sous-onglets qui agissent tout de suite, et qu'aucun autre fichier ne pilote à
 * l'écran :
 *   - Général : Apparence (auto / sombre / clair), Densité, Langue (qui recharge la page ET
 *     part au serveur), « Sauvegarder les données » (un vrai .zip téléchargé), la zone dangereuse
 *     (« Supprimer tous les rapports », confirmé) ;
 *   - Notifications : l'état de la permission, « Autoriser », « Tester », et chaque préférence
 *     (cases et seuil), mémorisées dans ce navigateur ;
 *   - Git → GitHub et Jira : « Enregistrer et tester » / « Tester Jira », leur garde à vide, et
 *     le souvenir du dernier test relu à la réouverture ;
 *   - AI sessions : le banc d'essai « Tester la reprise de session » (IA simulée).
 *
 * L'API de notification du navigateur est remplacée AVANT le chargement par une doublure qui
 * compte ce qu'on lui demande : un Chromium sans écran n'en affiche aucune, et c'est la demande
 * qu'on éprouve, pas le rendu du système.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Réglages — apparence, langue, notifications, sauvegarde, tests de connexion', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let contexte; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    // Une merge request reviewée : c'est ce que la zone dangereuse doit effacer.
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 1, title: 'Ajoute b', state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/1', sha: repo.branchSha,
      author: { name: 'Alice' }, diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!1'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    await app.api('POST', '/api/jobs/review');
    await waitForJobs(app.api);
    assert.ok(app.db.prepare('SELECT COUNT(*) n FROM review').get().n > 0, 'le décor porte un rapport');
    app.state.jiraIssues['PROJ-9'] = { key: 'PROJ-9', fields: { summary: 'Ticket témoin', status: { name: 'À faire' } } };

    navigateur = await lancerNavigateur();
    contexte = await navigateur.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    /* LA DOUBLURE DE `Notification`, posée avant le premier script de la page et à chaque
       rechargement. Sa permission part de « default » et survit aux rechargements (elle vit dans
       sessionStorage), comme celle du vrai navigateur. */
    await contexte.addInitScript(() => {
      const lire = () => { try { return sessionStorage.getItem('__perm') || 'default'; } catch { return 'default'; } };
      class Doublure {
        constructor(titre, options) {
          const faites = JSON.parse(sessionStorage.getItem('__notifs') || '[]');
          faites.push({ titre, corps: (options && options.body) || '' });
          sessionStorage.setItem('__notifs', JSON.stringify(faites));
        }
        close() {}
        static get permission() { return lire(); }
        static async requestPermission() { sessionStorage.setItem('__perm', 'granted'); return 'granted'; }
      }
      window.Notification = Doublure;
    });
    page = await contexte.newPage();
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrir = async (sub) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
  };
  const recharger = async () => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
  };
  const racine = (attr) => page.evaluate((a) => document.documentElement.getAttribute(a), attr);
  const config = async () => (await app.api('GET', '/api/config')).body;

  /* ------------------------------------------------------------- Général ---- */

  test('Apparence : sombre et clair s’appliquent tout de suite et survivent au rechargement ; auto suit le système', async () => {
    await ouvrir('config');
    await page.locator('#themeSelect').selectOption('light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await recharger();
    assert.equal(await racine('data-theme'), 'light', 'le thème est retenu par ce navigateur');
    await ouvrir('config');
    assert.equal(await page.locator('#themeSelect').inputValue(), 'light', 'et le sélecteur le relit');

    await page.locator('#themeSelect').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

    // « Auto » suit le thème du système — et le suit EN DIRECT.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#themeSelect').selectOption('auto');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  });

  test('Densité : compact resserre tout de suite, et survit au rechargement', async () => {
    await ouvrir('config');
    assert.equal(await racine('data-density'), 'cozy');
    await page.locator('#densitySelect').selectOption('compact');
    await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    await recharger();
    assert.equal(await racine('data-density'), 'compact');
    await ouvrir('config');
    assert.equal(await page.locator('#densitySelect').inputValue(), 'compact');
    await page.locator('#densitySelect').selectOption('cozy');
    await page.waitForFunction(() => document.documentElement.dataset.density === 'cozy');
  });

  test('Langue : l’écran recharge en anglais, et le serveur la retient ; retour au français', async () => {
    await ouvrir('config');
    await Promise.all([
      page.waitForEvent('load'),
      page.locator('#langSelect').selectOption('en'),
    ]);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal((await config()).language, 'en', 'la langue part au serveur (messages d’erreur, rapports)');
    await page.waitForSelector('nav button[data-tab="admin"]');
    await ouvrir('config');
    assert.equal(await page.locator('#langSelect').inputValue(), 'en');
    assert.match(await page.locator('#tab-admin .subnav [data-sub="config"]').textContent(), /General/);

    await Promise.all([
      page.waitForEvent('load'),
      page.locator('#langSelect').selectOption('fr'),
    ]);
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    assert.equal((await config()).language, 'fr');
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  test('« Sauvegarder les données » télécharge une archive zip, et dit ce qu’elle contient', async () => {
    await ouvrir('config');
    const [telechargement] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btnBackup').click(),
    ]);
    assert.match(telechargement.suggestedFilename(), /\.zip$/);
    const fichier = path.join(app.dataDir, 'sauvegarde-ecran.zip');
    await telechargement.saveAs(fichier);
    assert.equal(fs.readFileSync(fichier).subarray(0, 2).toString('latin1'), 'PK', 'c’est bien une archive zip');
    await page.waitForFunction(() => document.querySelector('#backupInfo').textContent.trim() !== ''
      && !/…/.test(document.querySelector('#backupInfo').textContent));
  });

  test('zone dangereuse : renoncer ne supprime rien ; confirmer efface tous les rapports', async () => {
    await ouvrir('config');
    await page.evaluate(() => document.querySelectorAll('#sub-config details').forEach((d) => { d.open = true; }));
    const avant = app.db.prepare('SELECT COUNT(*) n FROM review').get().n;
    await page.locator('#btnResetReports').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM review').get().n, avant, 'renoncer ne touche à rien');

    await page.locator('#btnResetReports').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => app.db.prepare('SELECT COUNT(*) n FROM review').get().n === 0, 'les rapports sont supprimés');
    const mrs = (await app.api('GET', '/api/mrs')).body;
    assert.ok(mrs.length > 0 && mrs.every((m) => m.status === 'to_review'), 'les merge requests reviennent « à traiter »');
    assert.ok(await app.api('GET', '/api/repos').then((r) => r.body.length === 1), 'les dépôts sont conservés');
  });

  /* -------------------------------------------------------- Notifications ---- */

  test('Notifications : « Autoriser » demande la permission, et l’état se met à jour', async () => {
    await ouvrir('notif');
    await page.waitForSelector('#notifRequest:not([hidden])');
    assert.match(await page.locator('#notifPermStatus').getAttribute('class'), /notif-default/);
    await page.locator('#notifRequest').click();
    await page.waitForSelector('#notifRequest', { state: 'hidden' });
    assert.match(await page.locator('#notifPermStatus').getAttribute('class'), /notif-granted/);
  });

  test('Notifications : « Tester » en envoie une vraie', async () => {
    await page.locator('#notifTest').click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('__notifs') || '[]').length === 1);
    const [n] = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__notifs')));
    assert.ok(n.titre, 'la notification porte un titre');
  });

  test('Notifications : chaque case et le seuil sont retenus par ce navigateur', async () => {
    await ouvrir('notif');
    const cases = await page.$$eval('#sub-notif [data-notif]', (els) => els.map((e) => [e.dataset.notif, e.checked]));
    assert.equal(cases.length, 16, 'les seize familles de notifications');
    // On inverse TOUTES les cases, et on règle le seuil.
    for (const [nom] of cases) await page.locator(`#sub-notif [data-notif="${nom}"]`).click();
    await page.locator('#notifThreshold').fill('3.5');
    await page.locator('#notifThreshold').dispatchEvent('change');
    const attendu = Object.fromEntries(cases.map(([n, c]) => [n, !c]));
    await page.waitForFunction((a) => {
      const p = JSON.parse(localStorage.getItem('mergerie_notif') || '{}');
      return Object.entries(a).every(([k, v]) => p[k] === v) && p.threshold === 3.5;
    }, attendu);

    await recharger();
    await ouvrir('notif');
    const relues = await page.$$eval('#sub-notif [data-notif]', (els) => Object.fromEntries(els.map((e) => [e.dataset.notif, e.checked])));
    assert.deepEqual(relues, attendu, 'les cases se relisent inversées');
    assert.equal(await page.locator('#notifThreshold').inputValue(), '3.5');
  });

  /* --------------------------------------------------- Tests de connexion ---- */

  test('GitHub : sans jeton, l’erreur se pose sous le champ ; « Enregistrer et tester » enregistre puis nomme le compte', async () => {
    await ouvrir('gitcfg');
    await page.waitForLoadState('networkidle');
    await page.locator('[form="configForm"][name="github_token"]').fill('');
    await page.locator('#btnTestGithub').click();
    await page.waitForSelector('#sub-gitcfg .field-error');
    assert.equal((await config()).github_token, '', 'la garde à vide n’a rien enregistré');

    await page.locator('[form="configForm"][name="github_url"]').fill(app.githubUrl);
    await page.locator('[form="configForm"][name="github_token"]').fill(app.ghState.token);
    await page.locator('#btnTestGithub').click();
    await page.waitForFunction(() => document.querySelector('#configInfoGithub').classList.contains('ok'));
    assert.match(await page.locator('#configInfoGithub').textContent(), /testeur/);
    const c = await config();
    assert.equal(c.github_url, app.githubUrl, 'tester a d’abord enregistré');
    assert.equal(c.github_token, '***');
  });

  test('Jira : sans ticket témoin, l’erreur se pose sous son champ ; avec, le ticket est lu et tout est enregistré', async () => {
    await ouvrir('jiracfg');
    await page.waitForLoadState('networkidle');
    await page.locator('[form="configForm"][name="jira_url"]').fill(app.gitlabUrl);
    await page.locator('[form="configForm"][name="jira_email"]').fill('moi@exemple.test');
    await page.locator('[form="configForm"][name="jira_token"]').fill('jeton-jira');
    await page.locator('#jiraTestKey').fill('');
    await page.locator('#btnTestJira').click();
    await page.waitForSelector('#sub-jiracfg .field-error');

    await page.locator('#jiraTestKey').fill('PROJ-9');
    await page.locator('#btnTestJira').click();
    await page.waitForFunction(() => /Ticket témoin/.test(document.querySelector('#configInfoJira').textContent));
    const c = await config();
    assert.equal(c.jira_url, app.gitlabUrl);
    assert.equal(c.jira_email, 'moi@exemple.test');
    assert.equal(c.jira_token, '***');
    assert.equal(c.jira_test_key, 'PROJ-9', 'le ticket témoin est un réglage : il ne se retape pas');
  });

  test('le dernier test de connexion se relit en rouvrant les réglages', async () => {
    await recharger();
    await ouvrir('jiracfg');
    await page.waitForFunction(() => document.querySelector('#configInfoJira').classList.contains('ok')
      && /PROJ-9/.test(document.querySelector('#configInfoJira').textContent));
    await ouvrir('gitcfg');
    await page.waitForFunction(() => document.querySelector('#configInfoGithub').classList.contains('ok')
      && /testeur/.test(document.querySelector('#configInfoGithub').textContent));
    assert.equal(await page.locator('#jiraTestKey').inputValue(), 'PROJ-9');
  });

  /* ---------------------------------------------------------- AI sessions ---- */

  test('« Tester la reprise de session » rend un verdict et dit qu’il est simulé', async () => {
    await ouvrir('aisession');
    await page.locator('#aiSessionTest').click();
    await page.waitForSelector('#aiSessionResult .ai-verdict');
    const texte = await page.locator('#aiSessionResult').textContent();
    assert.match(texte, /dry-run/, 'l’IA est simulée, et l’écran le dit');
    assert.equal(await page.locator('#aiSessionResult .ai-pass').count(), 2, 'les deux passes sont montrées');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
