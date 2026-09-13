'use strict';
/* LES TROIS DÉFAUTS DU §0 — ceux qui ne se voient pas à l'écran.
 *
 * Chacun est invisible dans le parcours normal : le commentaire Jira ne part pas en mode démo,
 * un sélecteur vide ne se remarque pas, et une promesse jamais résolue ne dit rien. On teste
 * donc à l'endroit exact où la faute était observable, pas à l'endroit où elle se raconte.
 * (Le commentaire Jira est couvert par `unit-jira-comment.test.js` : c'est du réseau, pas de
 * l'écran.)
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('§0 — les défauts silencieux', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const r = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' });
    repoId = r.body.id;
    await app.api('POST', '/api/verifiers', {
      name: 'integ', commands: ['npm test'], repos: [{ repo_id: repoId }],
    });
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('Échap sur une confirmation RÉPOND, il ne laisse pas l’appelant en attente', async () => {
    await page.evaluate(() => {
      window.__confirmEnCours = window.confirmDialog({ title: 'Titre', text: 'Question ?' });
    });
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.keyboard.press('Escape');
    /* On COURSE la promesse contre une attente : sans réponse, l'appelant reste bloqué pour
       toujours et son bouton avec lui. C'est la seule façon de distinguer « annulé » de
       « jamais résolu » — la modale, elle, se referme dans les deux cas. */
    const reponse = await page.evaluate(() => Promise.race([
      window.__confirmEnCours,
      new Promise((r) => setTimeout(() => r('EN-ATTENTE'), 2000)),
    ]));
    assert.equal(reponse, false, 'Échap répond « non »');
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
  });

  test('« Vérifier après » est rempli quand la modale s’ouvre depuis une MR', async () => {
    await page.evaluate((id) => window.openTaskForMr({
      id: 1, repo_id: id, iid: 216, source_branch: 'feat/x', target_branch: 'main',
    }), repoId);
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#taskVerifier option').length > 1);
    const noms = await page.$$eval('#taskVerifier option', (os) => os.map((o) => o.textContent));
    assert.ok(noms.some((n) => n.includes('integ')), 'le vérificateur qui couvre le dépôt est proposé');
    // …et comme il est le seul à couvrir, il est DÉJÀ choisi : un sélecteur vide ne se remarque pas.
    const choisi = await page.locator('#taskVerifier').inputValue();
    assert.ok(choisi, 'le seul vérificateur couvrant est présélectionné');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  test('…et depuis un ticket Jira, même modale, même sélecteur rempli', async () => {
    await page.evaluate(() => window.openTaskForJira('PROJ-1408'));
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#taskVerifier option').length > 1);
    const noms = await page.$$eval('#taskVerifier option', (os) => os.map((o) => o.textContent));
    assert.ok(noms.some((n) => n.includes('integ')), 'la liste n’est pas restée vide');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  test('aucune erreur de page', () => {
    assert.deepEqual(erreurs, []);
  });
});
