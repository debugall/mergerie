'use strict';
/* « ÉQUIPE » OU « CE POSTE » — ce qu'un réglage engage doit se lire À CÔTÉ du réglage.
 *
 * Les réglages ne sont plus tous de même nature. Certains décrivent ce que l'équipe a décidé
 * (gabarits de prompt, seuils, URL de la forge) : ils vivent dans `config` et partiront dans le
 * dépôt de données partagé. D'autres appartiennent à cette machine — les sept jetons d'API, le
 * chemin des clones, la langue, le moteur de dictée : ils vivent dans `local_config` et n'en
 * bougent pas.
 *
 * CE QUE CES ÉPREUVES GARDENT :
 *
 * — LE BADGE EXISTE SUR CHAQUE CHAMP. Un badge sur la moitié des champs est pire que pas de
 *   badge : l'absence se lirait comme « celui-là, on ne sait pas ».
 * — IL DIT LA VÉRITÉ SUR LES JETONS. C'est le seul cas où se tromper coûte cher : un secret
 *   commité dans git est définitif.
 * — LA SOURCE EST LE SERVEUR. `scopes` vient du registre ; recopié côté client, il mentirait au
 *   premier réglage déplacé.
 * — LE JETON ATTERRIT DANS `local_config`, ET `config` RESTE VIDE — après un enregistrement
 *   fait PAR LE FORMULAIRE, pas par l'API : c'est le formulaire qu'on éprouve ici.
 * — LES DEUX LANGUES. Le badge est du texte, pas une couleur.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, lancerNavigateur, navigateurDispo, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

let app; let navigateur; let page;

describe('Réglages · la portée de chaque champ', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirReglages = async (sub) => {
    await page.click('nav button[data-tab="admin"]');
    await page.click(`button[data-sub="${sub}"]`);
    await page.waitForFunction((s) => document.querySelector(`#sub-${s}`).classList.contains('active'),
      sub, { timeout: ATTENTE });
    // Le badge est posé par `loadConfig`, qui part à l'ouverture du sous-onglet.
    await page.waitForSelector(`#sub-${sub} .scope-badge`, { timeout: ATTENTE });
  };

  test('l’API dit la portée de chaque réglage, et le jeton est du côté du poste', async () => {
    const c = (await app.api('GET', '/api/config')).body;
    assert.ok(c.scopes, 'sans `scopes`, l’écran devrait deviner — il se tromperait');
    assert.equal(c.scopes.access_token, 'poste');
    assert.equal(c.scopes.jira_token, 'poste');
    assert.equal(c.scopes.clone_path, 'poste');
    assert.equal(c.scopes.language, 'poste');
    assert.equal(c.scopes.prompt_review, 'equipe');
    /* DES HABITUDES, PAS DES POLITIQUES : le brief du matin au lancement, les cadences de CE
       poste, la fermeture des todos (devenues personnelles) et les cases cochées d'office
       d'une nouvelle session. Les imposer à l'équipe, c'est rendre l'outil désagréable pour
       cinq personnes afin d'en arranger une. */
    assert.equal(c.scopes.brief_on_open, 'poste');
    assert.equal(c.scopes.auto_refresh_minutes, 'poste');
    assert.equal(c.scopes.jira_watch_minutes, 'poste');
    assert.equal(c.scopes.todo_close_on_merge, 'poste');
    assert.equal(c.scopes.task_default_converge, 'poste');
    /* …et ce qui RESTE d'équipe, pour que le reclassement ne déborde pas : une purge retire les
       fichiers du dépôt pour tout le monde, donc une seule valeur. */
    assert.equal(c.scopes.retention_days, 'equipe');
    assert.equal(c.scopes.auto_review_new, 'equipe');
    assert.equal(c.scopes.auto_runner, 'equipe');
    assert.equal(c.scopes.gitlab_url, 'equipe');
    assert.equal(c.scopes.stale_mr_days, 'equipe');
  });

  test('sur l’onglet Git, l’URL est d’équipe et le jeton est de ce poste', async () => {
    await ouvrirReglages('gitcfg');
    const lire = (nom) => page.evaluate((n) => {
      const el = document.querySelector(`[form="configForm"][name="${n}"]`);
      const b = el && el.closest('label') && el.closest('label').querySelector('.scope-badge');
      return b ? { texte: b.textContent.trim(), scope: b.dataset.scope } : null;
    }, nom);
    assert.deepEqual(await lire('gitlab_url'), { texte: 'équipe', scope: 'equipe' });
    assert.deepEqual(await lire('access_token'), { texte: 'ce poste', scope: 'poste' });
    assert.deepEqual(await lire('clone_path'), { texte: 'ce poste', scope: 'poste' });
  });

  test('aucun champ de réglage ne reste sans badge', async () => {
    /* On passe sur TOUS les sous-onglets : les champs sont rattachés à `#configForm` par
       `form="configForm"`, mais leur <label> n'est rendu que dans son sous-onglet. */
    const subs = await page.$$eval('#tab-admin button[data-sub]', (bs) => bs.map((b) => b.dataset.sub));
    const orphelins = new Set();
    for (const sub of subs) {
      await page.click(`button[data-sub="${sub}"]`);
      await page.waitForFunction((s) => document.querySelector(`#sub-${s}`).classList.contains('active'),
        sub, { timeout: ATTENTE });
      for (const nom of await page.$$eval(`#sub-${sub} [form="configForm"][name]`, (els) => els.map((e) => e.name))) {
        const ok = await page.evaluate((n) => {
          const el = document.querySelector(`[form="configForm"][name="${n}"]`);
          const l = el && el.closest('label');
          return !!(l && l.querySelector('.scope-badge'));
        }, nom);
        if (!ok) orphelins.add(`${sub}/${nom}`);
      }
    }
    assert.deepEqual([...orphelins], [], 'un champ sans badge se lit « on ne sait pas ce que ça engage »');
  });

  test('un jeton saisi DANS LE FORMULAIRE va en local_config, et config reste vide', async () => {
    await ouvrirReglages('gitcfg');
    await page.fill('[form="configForm"][name="access_token"]', 'glpat-DU-FORMULAIRE');
    await page.fill('[form="configForm"][name="gitlab_url"]', 'https://gl.test');
    await page.click('#sub-gitcfg button[type="submit"][form="configForm"]');
    /* On attend l'EFFET côté serveur, pas un libellé : « Enregistrement… » et « Enregistré »
       se ressemblent, et le formulaire s'autosauvegarde une seconde après la frappe. */
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.gitlab_url === 'https://gl.test',
      'l’URL enregistrée');
    assert.equal(app.db.prepare('SELECT access_token AS a FROM local_config WHERE id = 1').get().a,
      'glpat-DU-FORMULAIRE');
    assert.equal(app.db.prepare('SELECT access_token AS a FROM config WHERE id = 1').get().a, '',
      'un jeton dans `config` partirait dans le dépôt partagé — et un secret commité est définitif');
    assert.equal(app.db.prepare('SELECT gitlab_url AS u FROM config WHERE id = 1').get().u, 'https://gl.test');
  });

  test('en anglais, le badge se lit en anglais', async () => {
    await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'en'));
    await page.reload();
    await ouvrirReglages('gitcfg');
    const textes = await page.$$eval('#sub-gitcfg .scope-badge', (bs) => [...new Set(bs.map((b) => b.textContent.trim()))].sort());
    assert.deepEqual(textes, ['team', 'this machine']);
    await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'fr'));
    await page.reload();
  });
});
