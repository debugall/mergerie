'use strict';
/* MENU « JENKINS » — CE QUE LA LISTE SAIT DU CODE QU'ON SUIT.
 *
 * Trois choses que l'onglet tire des AUTRES données de Mergerie, et qu'aucun test ne pilotait
 * dans un navigateur :
 *   - A/Jenkins 1 : un job lié à un dépôt (Réglages → Jenkins) porte l'étiquette du dépôt, et
 *     la merge request OUVERTE dont la branche est celle du dernier build — un clic ouvre son
 *     rapport dans Reviews ;
 *   - B10 : un build VERT parti avec `ENV=recette` sur un job lié propose d'ouvrir l'adresse de
 *     recette du service du dépôt (grille de Liens) — et rien sur un build rouge, ni sur un job
 *     sans lien ;
 *   - A/Jenkins 2 : « Mes branches » ne garde que les jobs dont le dernier build porte la
 *     branche d'une de MES merge requests ouvertes, et le filtre survit au rechargement.
 *
 * Tout le décor (dépôt, merge requests, lien job ↔ dépôt, environnements, service) est posé par
 * l'API : ce fichier prouve ce que la LISTE en fait, pas les écrans qui les saisissent.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

const DOSSIER = 'com.cloudbees.hudson.plugins.folder.Folder';
const dernier = (ts, numero, params) => ({
  timestamp: ts, number: numero,
  actions: [
    { causes: [{ userName: 'Alice' }] },
    { parameters: params.map(([name, value]) => ({ name, value, _class: 'hudson.model.StringParameterValue' })) },
  ],
});
const URL_RECETTE = 'https://recette.boutique.example.test/';

describe('Menu Jenkins — dépôts liés, merge requests, environnements et « Mes branches »', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let srv; let navigateur; let page;
  const erreurs = [];
  const idMr = {};

  before(async () => {
    app = await startApp();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [
      { name: 'boutique', _class: DOSSIER, jobs: [
        // Lié au dépôt, vert, parti sur MA branche et en recette.
        { name: 'deploy-recette', color: 'blue', buildable: true, lastBuild: dernier(5000, 8, [['ENV', 'recette'], ['BRANCH', 'feature/mine']]) },
        // Lié aussi, mais ROUGE : pas d'adresse à ouvrir — le déploiement n'a pas abouti.
        { name: 'deploy-casse', color: 'red', buildable: true, lastBuild: dernier(4000, 3, [['ENV', 'recette'], ['BRANCH', 'feature/autre']]) },
        // Vert, en recette, mais lié à RIEN : aucune étiquette, aucune adresse.
        { name: 'libre', color: 'blue', buildable: true, lastBuild: dernier(3000, 2, [['ENV', 'recette'], ['BRANCH', 'feature/mine']]) },
      ] },
      { name: 'outils', _class: DOSSIER, jobs: [
        { name: 'lint', color: 'blue', buildable: true, lastBuild: dernier(2000, 1, []) },
      ] },
    ];

    // Deux merge requests ouvertes : l'une de MOI (l'identité du faux GitLab), l'autre d'Alice.
    app.state.mrs['grp/app'] = [
      { iid: 31, title: 'Mon travail', author: { name: 'Testeur', username: 'testeur' }, source_branch: 'feature/mine' },
      { iid: 32, title: 'Le travail d’Alice', author: { name: 'Alice', username: 'alice' }, source_branch: 'feature/autre' },
    ].map((m) => ({
      ...m, state: 'opened', target_branch: 'main', sha: `sha${m.iid}`,
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${m.iid}`, created_at: `2026-03-${m.iid - 10}T10:00:00.000Z`,
    }));
    await app.configure({
      jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token, jenkins_refresh_minutes: '0',
    });
    const repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    assert.ok(repoId, 'le dépôt est suivi');
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) idMr[m.iid] = m.id;
    assert.ok(idMr[31] && idMr[32], 'les deux merge requests sont connues');

    for (const job of ['boutique/deploy-recette', 'boutique/deploy-casse']) {
      const r = await app.api('POST', '/api/jenkins/links', { repo_id: repoId, job_path: job, param: 'BRANCH' });
      assert.equal(r.status, 200);
    }
    const recette = (await app.api('POST', '/api/environments', { name: 'recette', color: '#2f6fe0' })).body;
    await app.api('POST', '/api/environments', { name: 'prod', color: '#d23' });
    const svc = (await app.api('POST', '/api/services', { name: 'boutique-api', repo_id: repoId })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: recette.id, url: URL_RECETTE });
    const liens = (await app.api('GET', '/api/jenkins/build-links?path=boutique%2Fdeploy-recette')).body;
    assert.deepEqual(liens.envs.map((e) => e.env), ['recette'], 'le décor : une adresse de recette pour le service du dépôt');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
  const ligne = (chemin) => page.locator('#jenkinsBox .jk-row').filter({ has: page.locator(`[data-jkjob="${chemin}"]`) });
  async function allerJenkins(n = 4) {
    await page.locator('nav button[data-tab="jenkins"]').click();
    await page.waitForSelector('#tab-jenkins.active');
    await lignes(n);
  }

  test('un job lié porte son dépôt et la merge request de sa branche ; un job libre, rien', async () => {
    // La file des merge requests est celle de l'onglet Reviews : on la laisse se charger d'abord.
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction(() => document.querySelectorAll('#toReviewList .card').length >= 2);
    await allerJenkins();
    await page.waitForSelector('[data-jk-depot="boutique/deploy-recette"] .jk-depot-tag');
    const zone = ligne('boutique/deploy-recette').locator('.jk-depot');
    assert.match(await zone.locator('.jk-depot-tag').textContent(), /grp\/app/);
    assert.match(await zone.locator('.jk-depot-tag').getAttribute('title'), /lié au dépôt grp\/app/);
    await zone.locator('[data-jk-mr]').waitFor();
    assert.equal((await zone.locator('[data-jk-mr]').textContent()).trim(), '!31',
      'la merge request OUVERTE dont la branche est celle du dernier build');

    // Lié, et sa branche est celle de la MR d'Alice : l'étiquette ne choisit pas « les miennes ».
    await page.waitForSelector('[data-jk-depot="boutique/deploy-casse"] [data-jk-mr]');
    assert.equal((await ligne('boutique/deploy-casse').locator('[data-jk-mr]').textContent()).trim(), '!32');

    assert.equal(await ligne('boutique/libre').locator('.jk-depot').innerHTML(), '',
      'un job sans lien n’affiche rien — c’est le cas courant');
    assert.equal(await ligne('outils/lint').locator('.jk-depot').innerHTML(), '');
  });

  test('cliquer la merge request ouvre son rapport dans Reviews', async () => {
    await allerJenkins();
    await page.locator('[data-jk-depot="boutique/deploy-recette"] [data-jk-mr]').click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction(() => /!31/.test((document.querySelector('#reportDetail') || {}).textContent || ''));
    assert.match(await page.locator('#reportDetail').textContent(), /Mon travail/);
  });

  test('un build vert parti en recette propose l’adresse de recette ; un rouge ou un job libre, non', async () => {
    await allerJenkins();
    const zone = ligne('boutique/deploy-recette').locator('[data-jk-liens]');
    await zone.locator('a').first().waitFor();
    const lien = zone.locator('a');
    assert.equal(await lien.count(), 1, 'une seule case remplie dans la grille : un seul bouton');
    assert.equal(await lien.getAttribute('href'), URL_RECETTE);
    assert.equal(await lien.getAttribute('target'), '_blank');
    assert.match(await lien.getAttribute('rel'), /noopener/);
    assert.equal((await lien.textContent()).trim(), 'recette');
    assert.equal(await lien.getAttribute('title'), `Ouvrir recette — ${URL_RECETTE}`);

    /* Le rouge et le libre : leur zone reste vide. Le bouton du job lié est arrivé, et les
       zones se remplissent dans l'ordre de la liste — le rouge et le libre, rendus après, ont
       donc eu leur tour. */
    assert.equal(await ligne('boutique/deploy-casse').locator('[data-jk-liens]').innerHTML(), '',
      'un build rouge n’a rien déployé : aucune adresse à ouvrir');
    assert.equal(await ligne('boutique/libre').locator('[data-jk-liens]').innerHTML(), '',
      'un job sans lien vers un dépôt n’a pas de service, donc pas d’adresse');
  });

  test('« Mes branches » ne garde que les jobs partis sur la branche d’une de MES merge requests', async () => {
    await allerJenkins();
    await page.locator('#jenkinsMineBranches').click();
    await lignes(2);
    const chemins = await page.evaluate(() => [...document.querySelectorAll('#jenkinsBox [data-jkjob]')].map((b) => b.dataset.jkjob));
    assert.deepEqual(chemins.sort(), ['boutique/deploy-recette', 'boutique/libre'],
      'feature/mine est ma branche ; feature/autre est celle d’Alice, et « lint » n’en porte aucune');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mergerie_jenkins_filtres') || '{}'))).mesBranches, true);

    await page.locator('#jenkinsMineBranches').click();
    await lignes(4);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mergerie_jenkins_filtres') || '{}'))).mesBranches, false);
  });

  /* LE FILTRE MÉMORISÉ DOIT FILTRER, PAS VIDER. « Mes branches » est restauré au rechargement
     (A/Jenkins 2) — mais la file des merge requests, elle, n'est chargée que par l'onglet Reviews
     ou par le CLIC sur la case. Rouvrir Mergerie directement sur Jenkins (le dernier onglet est
     restauré) montre donc la case cochée et « Aucun job ne correspond » : ma branche est
     pourtant bien là. */
  test('« Mes branches » restauré au rechargement retrouve mes jobs, sans repasser par Reviews', async (t) => {
    t.after(() => page.evaluate(() => {
      const f = JSON.parse(localStorage.getItem('mergerie_jenkins_filtres') || '{}');
      localStorage.setItem('mergerie_jenkins_filtres', JSON.stringify({ ...f, mesBranches: false }));
    }));
    await allerJenkins();
    await page.locator('#jenkinsMineBranches').click();
    await lignes(2);

    // Rouvrir Mergerie : le dernier onglet (Jenkins) est restauré, Reviews n'est pas ouvert.
    await page.reload();
    await page.waitForSelector('#tab-jenkins.active');
    await page.waitForFunction(() => document.querySelector('#jenkinsMineBranches').checked
      && (document.querySelectorAll('#jenkinsBox .jk-row').length > 0 || /Aucun job ne correspond/.test(document.querySelector('#jenkinsBox').textContent)));
    const vus = await page.evaluate(() => [...document.querySelectorAll('#jenkinsBox [data-jkjob]')].map((b) => b.dataset.jkjob).sort());
    assert.deepEqual(vus, ['boutique/deploy-recette', 'boutique/libre'],
      'la case est cochée à l’écran : elle doit retenir mes jobs, pas vider la liste');
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
