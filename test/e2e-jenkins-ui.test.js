'use strict';
/* L'onglet Jenkins dans un VRAI navigateur, contre un faux serveur Jenkins.
 *
 * Deux choses ne se prouvent que là. La première : LANCER DEMANDE CONFIRMATION, et un job
 * PARAMÉTRÉ n'est jamais lancé depuis la liste — on ouvre sa fiche, où les paramètres se
 * lisent. Lancer avec des valeurs par défaut qu'on n'a pas vues, c'est déployer la mauvaise
 * version. La seconde : le jeton saisi dans les réglages arrive bien jusqu'à la requête —
 * un champ oublié dans une des deux listes blanches s'affiche, accepte la frappe, et n'est
 * jamais enregistré.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Onglet Jenkins', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let srv;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [
      { name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'api-build', color: 'blue', buildable: true },
        { name: 'deploy-prod', color: 'blue', buildable: true },
        { name: 'front-build', color: 'red', buildable: true },
      ] },
      { name: 'archive', color: 'disabled', buildable: false },
    ];
    mock.state.details['/job/boutique/job/api-build'] = {
      name: 'api-build', color: 'blue', buildable: true, property: [], builds: [
        { number: 8, result: 'SUCCESS', building: false, timestamp: Date.now(), duration: 4000, url: '' },
      ],
    };
    mock.state.details['/job/boutique/job/deploy-prod'] = {
      name: 'deploy-prod', color: 'blue', buildable: true, builds: [],
      property: [{ parameterDefinitions: [
        { name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '1.0' } },
        { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['recette', 'prod'], defaultParameterValue: { value: 'recette' } },
      ] }],
    };
    mock.state.console['/job/boutique/job/api-build/8'] = 'tout va bien\nFinished: SUCCESS';

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1300, height: 900 } });
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  const allerJenkins = async () => {
    await page.locator('nav button[data-tab="jenkins"]').click();
    await page.waitForSelector('#jenkinsBox');
  };

  /* On commence NON CONFIGURÉ, comme une installation neuve : l'onglet doit expliquer, pas
     afficher une erreur rouge — et son bouton doit mener au bon sous-onglet de réglages. */
  test('sans connexion, l’onglet explique et mène aux réglages', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .empty');
    await page.locator('#jenkinsBox [data-empty-act="jenkins-config"]').click();
    await page.waitForSelector('#sub-jenkinscfg.active');
    assert.equal(await page.locator('#configForm [name="jenkins_url"], [name="jenkins_url"]').first().isVisible(), true);
  });

  /* LE PIÈGE DES LISTES BLANCHES : un champ de config vit dans CONFIG_FIELDS (écran) et dans
     ALLOWED + l'UPDATE (serveur). En manquer une le laisse s'afficher, accepter la frappe, et
     n'être jamais enregistré. On le saisit donc à l'écran, et on le relit par son EFFET. */
  test('les identifiants saisis dans les réglages arrivent jusqu’à Jenkins', async () => {
    await page.locator('[name="jenkins_url"]').fill(srv.url);
    await page.locator('[name="jenkins_user"]').fill(mock.state.user);
    await page.locator('[name="jenkins_token"]').fill(mock.state.token);
    await page.locator('#btnTestJenkins').click();
    await page.waitForFunction(() => /Moi Même/.test(document.querySelector('#configInfoJenkins').textContent),
      null, { timeout: 5000 });

    await page.locator('#sub-jenkinscfg button[type="submit"]').first().click();
    await page.waitForTimeout(300);
    await page.reload();
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    assert.equal(await page.locator('#jenkinsBox .jk-row').count(), 4,
      'après enregistrement ET rechargement, la liste vient du serveur : le jeton a survécu');
  });

  test('les jobs sont groupés par dossier, et la recherche filtre', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    assert.deepEqual(await page.locator('#jenkinsBox .jk-folder').allTextContents(), ['boutique']);

    await page.locator('#jenkinsSearch').fill('front');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    await page.locator('#jenkinsSearch').fill('');

    await page.locator('#jenkinsFailOnly').check();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /front-build/,
      '« ce qui ne va pas » retient l’échec et l’instable, pas le vert');
    await page.locator('#jenkinsFailOnly').uncheck();
  });

  test('un job désactivé n’a pas de bouton « Lancer »', async () => {
    await allerJenkins();
    const ligne = page.locator('#jenkinsBox .jk-row').filter({ hasText: 'archive' }).first();
    assert.equal(await ligne.locator('[data-jkrun]').count(), 0,
      'proposer de lancer ce que Jenkins refusera est une promesse qu’on ne tient pas');
  });

  /* Lancer un job sans paramètre : confirmation, puis la requête part vraiment. Le témoin est
     la requête reçue par Jenkins — un toast de succès ne prouve rien. */
  test('lancer demande confirmation, et annuler n’envoie rien', async () => {
    await allerJenkins();
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;
    await page.locator('[data-jkrun="boutique/api-build"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /api-build/,
      'la question nomme le job : c’est ce qui permet de s’apercevoir qu’on s’est trompé de ligne');

    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, avant,
      'annuler doit vraiment ne rien lancer');

    await page.locator('[data-jkrun="boutique/api-build"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => !!document.querySelector('#toasts .toast'));
    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant);
    assert.equal(post.length, 1);
    assert.ok(post[0].path.endsWith('/build'), 'un job sans paramètre part sur /build');
  });

  /* UN JOB PARAMÉTRÉ NE SE LANCE PAS À L'AVEUGLE. Le bouton de la liste ouvre sa fiche : on
     voit ce qu'on va envoyer, et on peut le changer avant. */
  test('un job paramétré ouvre sa fiche au lieu de partir', async () => {
    await allerJenkins();
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;
    await page.locator('[data-jkrun="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jkparam="VERSION"]');
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, avant,
      'ouvrir la fiche ne lance rien');
    assert.equal(await page.locator('#confirmModal').isHidden(), true);

    await page.locator('[data-jkparam="VERSION"]').fill('2.4.1');
    await page.locator('[data-jkparam="ENV"]').selectOption('prod');
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction((n) => document.querySelectorAll('#toasts .toast').length >= n, 1);

    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant);
    assert.equal(post.length, 1);
    assert.ok(post[0].path.endsWith('/buildWithParameters'));
    assert.equal(post[0].body, 'VERSION=2.4.1&ENV=prod',
      'ce sont les valeurs SAISIES qui partent, pas les défauts du job');
  });

  test('la console d’un build s’ouvre depuis la fiche', async () => {
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/api-build"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jklog]');
    await page.locator('[data-jklog]').first().click();
    await page.waitForFunction(() => /Finished: SUCCESS/.test(document.querySelector('#jenkinsLogBody').textContent));
    await page.locator('#jenkinsLogClose').click();
    await page.locator('#jenkinsClose').click();
  });
});
