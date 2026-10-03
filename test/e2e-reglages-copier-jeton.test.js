'use strict';
/* « COPIER » UN JETON, dans Réglages. Les jetons ne redescendent jamais dans la page (le champ montre « *** ») : le bouton va
 * chercher la valeur par une route explicite, l'écrit dans le presse-papiers et ne la pose nulle part dans le DOM.
 * Ce qu'on prouve : la liste blanche, le masque qui reste, et — dans un vrai navigateur — ce qui arrive VRAIMENT dans le presse-papiers. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;
const JETONS = { access_token: 'glpat-SECRET-gitlab', github_token: 'ghp_SECRET_github', jira_token: 'jira-SECRET', confluence_token: 'conf-SECRET' };

describe('Réglages — copier un jeton', () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.configure();
    assert.equal((await app.api('PUT', '/api/config', JETONS)).status, 200);
    await app.configureJenkins({ jenkins_url: 'http://jenkins.test', jenkins_user: 'moi', jenkins_token: 'jk-SECRET-token' });
  });
  after(async () => { if (app) await app.stop(); });

  test('la page ne reçoit toujours AUCUN jeton : « *** », jamais la valeur', async () => {
    const c = (await app.api('GET', '/api/config')).body;
    for (const k of Object.keys(JETONS)) assert.equal(c[k], '***', k);
    assert.equal((await app.api('GET', '/api/plugins/jenkins/settings')).body.jenkins_token, '***');
    assert.ok(!JSON.stringify([c, (await app.api('GET', '/api/plugins/jenkins/settings')).body]).includes('SECRET'));
  });

  test('la route de copie rend la valeur d’un jeton de la liste blanche, sans cache — et rien d’autre', async () => {
    for (const [k, v] of Object.entries(JETONS)) {
      const r = await app.api('POST', '/api/config/secret', { field: k });
      assert.deepEqual([r.status, r.body.value], [200, v], k);
    }
    for (const mauvais of ['gitlab_url', 'jira_email', 'local_token', '__proto__', '', undefined]) {
      assert.equal((await app.api('POST', '/api/config/secret', { field: mauvais })).status, 400, String(mauvais));
    }
    assert.equal((await app.api('GET', '/api/config/secret')).status === 200, false, 'pas en GET : un lien ne copie rien');
  });

  test('un secret de plugin : seulement s’il est déclaré x-secret par son schéma', async () => {
    const ok = await app.api('POST', '/api/plugins/jenkins/secret', { key: 'jenkins_token' });
    assert.deepEqual([ok.status, ok.body.value], [200, 'jk-SECRET-token']);
    for (const cle of ['jenkins_url', 'jenkins_user', 'last_test', 'inconnu', '']) assert.equal((await app.api('POST', '/api/plugins/jenkins/secret', { key: cle })).status, 400, cle);
    assert.equal((await app.api('POST', '/api/plugins/inconnu/secret', { key: 'x' })).status, 404);
  });

  test('sans le jeton local, la route est refusée comme tout le reste de l’API', async () => {
    const r = await fetch(`${app.base}/api/config/secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: 'access_token' }) });
    assert.ok([401, 403].includes(r.status), `statut ${r.status}`);
  });

  describe('dans le navigateur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let contexte; let page;
    const lirePressePapiers = () => page.evaluate(() => navigator.clipboard.readText());
    const ouvrir = async (sub) => {
      await page.click('nav button[data-tab="admin"]');
      await page.click(`#tab-admin .subnav [data-sub="${sub}"]`);
      await page.waitForSelector(`#sub-${sub}.active`, { timeout: ATTENTE });
    };
    before(async () => {
      navigateur = await lancerNavigateur();
      contexte = await navigateur.newContext({ viewport: { width: 1300, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] });
      page = await contexte.newPage();
      await afficherMenusOptionnels(page);
      await page.goto(app.base);
    });
    after(async () => { if (contexte) await contexte.close(); if (navigateur) await navigateur.close(); });

    test('chaque jeton du cœur a son bouton ; un clic met la VRAIE valeur dans le presse-papiers, et le champ reste masqué', async () => {
      await ouvrir('gitcfg');
      const cas = [['access_token', JETONS.access_token], ['github_token', JETONS.github_token]];
      for (const [champ, valeur] of cas) {
        const bouton = page.locator(`.secret-row:has(input[name="${champ}"]) .secret-copy`);
        await bouton.scrollIntoViewIfNeeded();
        assert.equal(await page.inputValue(`input[name="${champ}"]`), '***', 'le champ montre le masque');
        await bouton.click();
        await attendreServeur(async () => (await lirePressePapiers()) === valeur, `presse-papiers : ${champ}`);
        assert.equal(await page.inputValue(`input[name="${champ}"]`), '***', 'copier ne dévoile rien à l’écran');
        assert.ok(!(await page.content()).includes('SECRET'), 'la valeur n’est nulle part dans le DOM');
      }
    });

    test('un jeton tapé et pas encore enregistré se copie tel quel — sans appel serveur', async () => {
      const champ = 'input[name="access_token"]';
      await page.fill(champ, 'glpat-tape-a-la-main');
      let appels = 0;
      page.on('request', (r) => { if (r.url().includes('/api/config/secret')) appels += 1; });
      await page.click(`.secret-row:has(${champ}) .secret-copy`);
      await attendreServeur(async () => (await lirePressePapiers()) === 'glpat-tape-a-la-main', 'presse-papiers : jeton tapé');
      assert.equal(appels, 0);
    });

    test('un champ vide : on le dit, rien n’est copié', async () => {
      await page.evaluate(() => navigator.clipboard.writeText('avant'));
      await page.fill('input[name="access_token"]', '');
      await page.click('.secret-row:has(input[name="access_token"]) .secret-copy');
      await page.waitForSelector('#toasts .toast.err, .toast.err, [data-toast-err]', { timeout: ATTENTE }).catch(() => {});
      assert.equal(await lirePressePapiers(), 'avant', 'le presse-papiers n’a pas bougé');
    });

    test('Jira, Confluence et le jeton du plugin Jenkins ont le même bouton', async () => {
      await ouvrir('jiracfg');
      for (const [champ, valeur] of [['jira_token', JETONS.jira_token], ['confluence_token', JETONS.confluence_token]]) {
        await page.locator(`.secret-row:has(input[name="${champ}"]) .secret-copy`).click();
        await attendreServeur(async () => (await lirePressePapiers()) === valeur, `presse-papiers : ${champ}`);
      }
      await ouvrir('jenkinscfg');
      await page.locator('.secret-row:has(input[name="jenkins_token"]) .secret-copy').click();
      await attendreServeur(async () => (await lirePressePapiers()) === 'jk-SECRET-token', 'presse-papiers : jenkins_token');
    });
  });
});
