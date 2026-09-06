'use strict';
/* CE QUE L'ÉCRAN DIT QUAND UNE REVIEW SE TERMINE.
 *
 * Le retour d'action est le point faible n°1 relevé par l'audit : on cliquait « Reviewer », le
 * bandeau annonçait « terminé », et la carte restait en tête des « à traiter » avec des
 * compteurs inchangés — l'API répondant déjà autre chose. Il fallait changer d'onglet pour voir
 * son propre travail.
 *
 * La cause tenait à la détection : le rafraîchissement se déclenchait « s'il y avait un sondage
 * en cours », donc jamais pour un job qui finit avant le premier tour de boucle. Ce fichier
 * exerce précisément ce cas — l'agent est en dry-run, la review dure quelques dizaines de
 * millisecondes — et n'observe QUE l'écran, sans jamais recharger ni changer d'onglet.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

const ATTENTE = 20000;

describe('Retour d’action après une review', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  const NB = 4;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = Array.from({ length: NB }, (_, i) => ({
      iid: 200 + i, title: `Merge request ${i + 1}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${200 + i}`,
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (let i = 0; i < NB; i++) app.state.changes[`grp/app!${200 + i}`] = [{ new_path: 'src/app.js' }];

    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#toReviewList .card', { timeout: ATTENTE });
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const compteurs = () => page.evaluate(() => [...document.querySelectorAll('#tab-review .segmented .seg-count')]
    .map((s) => s.textContent.trim()));

  test('la carte quitte la file et les compteurs suivent, sans changer d’onglet', async () => {
    assert.deepEqual(await compteurs(), [String(NB), '0', '0'], 'état de départ');
    const carte = page.locator('#toReviewList .card').first();
    const titre = await carte.locator('.title').innerText();

    await carte.locator('[data-review]').first().click();

    /* On attend L'EFFET, sur l'écran seul : la carte reviewée n'est plus dans la file. Aucun
       rechargement, aucun changement d'onglet — c'est tout l'objet du test. */
    await page.waitForFunction((t) => ![...document.querySelectorAll('#toReviewList .card .title')]
      .some((e) => e.textContent === t), titre, { timeout: ATTENTE });

    await page.waitForFunction((n) => {
      const c = [...document.querySelectorAll('#tab-review .segmented .seg-count')].map((s) => s.textContent.trim());
      return c[0] === String(n - 1) && c[1] === '1';
    }, NB, { timeout: ATTENTE });

    // Et l'écran dit la même chose que le serveur : c'est la seule comparaison qui tranche.
    const f = (await app.api('GET', '/api/stats')).body.funnel;
    assert.deepEqual(await compteurs(), [String(f.to_review), String(f.reviewed), String(f.done)],
      'l’écran et l’API doivent raconter la même histoire');
  });

  /* LE CAS QUI ÉCHOUAIT VRAIMENT : un job terminé sans qu'aucun sondage n'ait démarré. En
     cliquant le bouton, l'écran demande l'état dans la foulée et voit souvent le job « en
     cours » — le sondage naît, et l'ancien code s'en sortait par chance. On lance donc la
     review PAR L'API, on attend sa fin côté serveur, et on regarde si l'écran finit par
     l'apprendre tout seul. Avec la détection par `pollTimer`, il ne l'apprenait jamais. */
  test('une review terminée sans sondage en cours est quand même vue par l’écran', async () => {
    const avant = await compteurs();
    const restantes = (await app.api('GET', '/api/mrs?status=to_review')).body;
    assert.ok(restantes.length >= 1, 'il faut une merge request à traiter');
    const cible = restantes[0];

    await app.api('POST', `/api/mrs/${cible.id}/review`, {});
    await waitForJobs(app.api);   // le job est fini AVANT que l'écran n'ait rien demandé

    await page.waitForFunction((n) => {
      const c = [...document.querySelectorAll('#tab-review .segmented .seg-count')].map((s) => s.textContent.trim());
      return c[0] === String(n - 1);
    }, Number(avant[0]), { timeout: ATTENTE });

    const f = (await app.api('GET', '/api/stats')).body.funnel;
    assert.deepEqual(await compteurs(), [String(f.to_review), String(f.reviewed), String(f.done)]);
    assert.equal(await page.locator(`#toReviewList .card[data-id="${cible.id}"]`).count(), 0,
      'la carte reviewée a quitté la file, sans qu’on ait rien rechargé');
  });

  /* Le bandeau de job garde son lien vers le résultat au lieu de s'effacer : c'est l'autre
     moitié du retour d'action, et elle ne doit pas disparaître avec la première. */
  test('le bandeau propose d’ouvrir le rapport qui vient d’être produit', async () => {
    const lien = page.locator('#logResult');
    await lien.waitFor({ state: 'visible', timeout: ATTENTE });
    assert.match(await lien.innerText(), /rapport|report/i);
    await lien.click();
    await page.waitForSelector('#reportDetail .detail-actions', { timeout: ATTENTE });
    assert.equal(await page.locator('[data-seg="reviewed"]').evaluate((e) => e.classList.contains('active')), true,
      'ouvrir le résultat amène au stade où il vit');
  });

  /* DEUX CHARGEMENTS DE SESSIONS EN VOL, et rien ne garantit l'ordre de retour : un clic et un
     rafraîchissement de fin de job partent souvent ensemble. Sans garde, la réponse la plus
     ANCIENNE écrasait la plus récente et l'écran revenait en arrière — une session qu'on
     venait de voir disparaître se réaffichait. On force le cas : la première requête est
     retenue et rendra UNE session, la seconde répond aussitôt et n'en rend AUCUNE. */
  test('une réponse de chargement dépassée ne réécrit pas la liste des sessions', async () => {
    await page.locator('nav button[data-tab="task"]').click();

    let liberer;
    const retenue = new Promise((r) => { liberer = r; });
    let premier = true;
    const fausseSession = [{
      id: 4242, kind: 'code', prompt: 'Session fantôme', branch: 'feat/fantome', status: 'new',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), targets: [],
    }];
    await page.route('**/api/tasks', async (route) => {
      const dabord = premier;
      premier = false;
      if (dabord) await retenue;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(dabord ? fausseSession : []),
      }).catch(() => { /* page déjà partie */ });
    });

    const lent = page.evaluate(() => loadTasks());          // eslint-disable-line no-undef
    await new Promise((r) => { setTimeout(r, 50); });       // le premier appel est parti
    const rapide = page.evaluate(() => loadTasks());        // eslint-disable-line no-undef
    await rapide;
    assert.equal(await page.evaluate(() => document.querySelectorAll('#taskList .card').length), 0,
      'la réponse la plus récente (liste vide) est celle qui est affichée');

    liberer();
    await lent;
    assert.equal(await page.evaluate(() => document.querySelectorAll('#taskList .card').length), 0,
      'la réponse retardée ne doit pas ressusciter la session qu’elle avait vue');
    await page.unroute('**/api/tasks').catch(() => {});
  });

  /* MÊME COURSE, SUR LES COMPTEURS. Plusieurs demandes de chiffres partent ensemble (fin de
     job, changement de stade, rafraîchissement périodique) : sans rang, une réponse dépassée
     reposait les valeurs d'avant par-dessus les bonnes, et l'écran repassait de 3 à 4 une
     seconde après avoir dit vrai. Vu sur un runner à deux cœurs, pas en théorie. */
  test('une réponse de compteurs dépassée ne réécrit pas les segments', async () => {
    let liberer;
    const retenue = new Promise((r) => { liberer = r; });
    let premier = true;
    await page.route('**/api/stats', async (route) => {
      const dabord = premier;
      premier = false;
      if (dabord) await retenue;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ funnel: dabord ? { to_review: 99, reviewed: 0, done: 0 } : { to_review: 7, reviewed: 2, done: 1 } }),
      }).catch(() => { /* page déjà partie */ });
    });

    const lent = page.evaluate(() => refreshCounts());       // eslint-disable-line no-undef
    await new Promise((r) => { setTimeout(r, 50); });        // la première demande est partie
    await page.evaluate(() => refreshCounts());              // eslint-disable-line no-undef
    await page.waitForFunction(() => document.querySelector('#segCountToReview').textContent.trim() === '7');

    liberer();
    await lent;
    /* Les compteurs s'ANIMENT (600 ms) : lire dans la foulée montrerait une valeur en cours de
       route. On attend deux relevés identiques, puis on compare. */
    await page.waitForFunction(() => {
      const el = document.querySelector('#segCountToReview');
      const v = el.textContent.trim();
      const stable = el.dataset.vMesure === v;
      el.dataset.vMesure = v;
      return stable;
    });
    assert.deepEqual(await compteurs(), ['7', '2', '1'],
      'la réponse retardée (99) ne doit pas revenir par-dessus la plus récente');
    await page.unroute('**/api/stats').catch(() => {});
  });

  test('aucune erreur JavaScript pendant le parcours', async () => {
    await waitForJobs(app.api);
    assert.deepEqual(erreurs, []);
  });
});
