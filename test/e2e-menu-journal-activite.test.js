'use strict';
/* LE JOURNAL D'ACTIVITÉ ET LE « RELANCER » DU BANDEAU, DANS UN VRAI NAVIGATEUR.
 *
 * « Qu'est-ce que j'avais lancé, et qu'est-ce qui est fini ? » : le bouton « Activité » du
 * panneau de journal liste les jobs passés (table `job`, persistante), avec leur statut, leur
 * type, l'objet visé (cliquable), la RAISON d'un échec, un bouton pour relancer ce qui se
 * rejoue, un autre pour relire le journal. Un compteur annonce ce qui s'est terminé depuis la
 * dernière ouverture ; l'ouvrir le remet à zéro. Un filtre texte et « Échecs seulement »
 * masquent les lignes sans rien retirer.
 *
 * Et dans le bandeau : un job qui s'est arrêté avant la fin et qui sait se rejouer (une review)
 * propose « Relancer » ; le badge « à traiter » de la barre de navigation suit la fin des
 * reviews sans rechargement.
 *
 * Les reviews tournent en dry-run sur un vrai dépôt local ; les jobs longs ou en échec sont des
 * cibles `make` pilotées par le test (helpers/journal.js).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, attendreServeur, waitForJobs,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker } = require('./helpers/fake-docker');
const { preparerChantier, jobServeur } = require('./helpers/journal');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Panneau de journal — Activité et relance', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux; let chantier;
  const erreurs = [];
  const mr = {};        // iid → id de la merge request en base
  const job = {};       // nom lisible → id de job

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [200, 201].map((iid, i) => ({
      iid, title: `Merge request ${i + 1}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (const iid of [200, 201]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs?status=to_review')).body) mr[m.iid] = m.id;
    assert.ok(mr[200] && mr[201], 'deux merge requests à traiter');

    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    chantier = await preparerChantier(app, racine);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#toReviewList .card', { timeout: ATTENTE });
  });

  after(async () => {
    if (chantier) chantier.toutLiberer();
    if (app) { try { await waitForJobs(app.api, { timeout: 30000 }); } catch { /* on arrête quand même */ } }
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  const rafraichir = () => page.evaluate(() => refreshStatus()); // eslint-disable-line no-undef
  const attendreStatutServeur = (id, st) => attendreServeur(async () => {
    const j = await jobServeur(app, id);
    return j && j.status === st;
  }, `job #${id} ${st}`);
  const tousLesJobs = async () => (await app.api('GET', '/api/jobs/history?limit=200')).body.jobs;
  const attendreBandeau = (re) => page.waitForFunction(
    (src) => new RegExp(src, 'i').test((document.querySelector('#logStatus') || {}).textContent || ''),
    re.source, { timeout: ATTENTE },
  );
  const ligneHist = (id) => page.locator('#logHist .log-queue-row').filter({ has: page.locator(`[data-histlog="${id}"]`) });
  // Les ids des lignes VISIBLES de l'historique, dans l'ordre affiché.
  const lignesVisibles = () => page.evaluate(() => [...document.querySelectorAll('#logHist .log-queue-row')]
    .filter((r) => !r.hidden).map((r) => Number(r.querySelector('[data-histlog]').dataset.histlog)));
  const attendreLignes = (attendus) => page.waitForFunction((a) => {
    const v = [...document.querySelectorAll('#logHist .log-queue-row')].filter((r) => !r.hidden)
      .map((r) => Number(r.querySelector('[data-histlog]').dataset.histlog)).sort((x, y) => x - y);
    return JSON.stringify(v) === JSON.stringify([...a].sort((x, y) => x - y));
  }, attendus, { timeout: ATTENTE });
  async function ouvrirActivite() {
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    if (await page.locator('#logHist').isHidden()) await page.locator('#logHistBtn').click();
    await page.locator('#logHist').waitFor({ state: 'visible' });
  }
  async function fermerActivite() {
    if (await page.locator('#logHist').isVisible()) await page.locator('#logHistBtn').click();
    await page.locator('#logHist').waitFor({ state: 'hidden' });
  }
  const toast = (re) => page.waitForFunction(
    (src) => [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent)),
    re.source, { timeout: ATTENTE },
  );

  /* ----------------------------------------------------- avant tout job ---- */

  test('avant tout job : pas de compteur, et l’Activité dit qu’il n’y a rien', async () => {
    await page.locator('#navCountReview').waitFor({ state: 'visible', timeout: ATTENTE });
    await page.waitForFunction(() => document.querySelector('#navCountReview').textContent === '2');
    assert.equal(await page.locator('#logHistCount').isHidden(), true);
    /* Le panneau n'apparaît qu'avec un premier job : on le montre comme le fait le pied de page,
       pour atteindre le bouton « Activité ». */
    await page.evaluate(() => { document.querySelector('#logPanel').hidden = false; });
    await ouvrirActivite();
    await page.waitForFunction(() => /Rien n'a encore tourné/.test(document.querySelector('#logHist').textContent), null, { timeout: ATTENTE });
    await page.locator('#logHistBar').waitFor({ state: 'visible' });
    await fermerActivite();
    await page.locator('#logHistBar').waitFor({ state: 'hidden' });
  });

  /* ---------------------------------------- une review : badges et compteur ---- */

  test('une review lancée depuis la carte : annonce de fin, badge « à traiter » et compteur « Activité » suivent', async () => {
    const carte = page.locator(`#toReviewList .card[data-id="${mr[200]}"]`);
    await carte.locator('[data-review]').first().click();
    await attendreServeur(async () => (await tousLesJobs()).some((j) => j.kind === 'review' && j.status === 'done'), 'review terminée');
    job.review200 = (await tousLesJobs()).find((j) => j.kind === 'review').id;

    await toast(/Review terminée/);
    await page.waitForFunction(() => document.querySelector('#navCountReview').textContent === '1', null, { timeout: ATTENTE });
    await page.locator('#logHistCount').waitFor({ state: 'visible', timeout: ATTENTE });
    await page.waitForFunction(() => document.querySelector('#logHistCount').textContent === '1', null, { timeout: ATTENTE });
    // La review désigne sa merge request : le bandeau mène au rapport.
    await page.locator('#logResult').waitFor({ state: 'visible', timeout: ATTENTE });
  });

  /* --------------------------------------- « Relancer » dans le bandeau ---- */

  test('une review annulée avant de démarrer propose « Relancer » dans le bandeau, et la relance aboutit', async () => {
    // Un échec (sans relance possible), puis une review mise en file derrière un job long et retirée.
    job.casse = await chantier.lancer('casse');
    await attendreStatutServeur(job.casse, 'error');
    job.porte = await chantier.lancer('porte-a');
    await attendreStatutServeur(job.porte, 'running');
    job.review201 = (await app.api('POST', `/api/mrs/${mr[201]}/review`, {})).body.id;
    assert.equal((await jobServeur(app, job.review201)).status, 'queued');
    assert.equal((await app.api('POST', `/api/jobs/${job.review201}/stop`)).status, 200);
    chantier.feuVert('porte-a');
    await attendreStatutServeur(job.porte, 'done');
    await attendreStatutServeur(job.review201, 'stopped');

    await rafraichir();
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    await attendreBandeau(/arrêté — Annulé \(jamais démarré\)/);
    await page.locator('#logRetry').waitFor({ state: 'visible', timeout: ATTENTE });
    assert.equal(await page.locator('#logNoRetry').isHidden(), true, 'rejouable : aucune raison à donner');

    const avant = new Set((await tousLesJobs()).map((j) => j.id));
    await page.locator('#logRetry').click();
    await toast(/Job relancé/);
    await attendreServeur(async () => (await tousLesJobs()).some((j) => !avant.has(j.id) && j.status === 'done'), 'relance terminée');
    const relance = (await tousLesJobs()).find((j) => !avant.has(j.id));
    assert.equal(relance.kind, 'review');
    assert.equal(relance.target_id, mr[201], 'la relance vise la même merge request');
    job.relance = relance.id;
    await attendreBandeau(/terminé/);
    await page.locator('#logRetry').waitFor({ state: 'hidden', timeout: ATTENTE });
    await page.locator('#navCountReview').waitFor({ state: 'hidden', timeout: ATTENTE });
  });

  /* ------------------------------------------------------ l'Activité ---- */

  test('l’Activité liste les jobs, dit la raison d’un échec, et remet son compteur à zéro', async () => {
    const attendus = [job.review200, job.casse, job.porte, job.review201, job.relance];
    await page.waitForFunction((n) => document.querySelector('#logHistCount').textContent === String(n),
      attendus.length, { timeout: ATTENTE });
    await ouvrirActivite();
    await attendreLignes(attendus);
    await page.locator('#logHistCount').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#logHist .log-queue-row.hist-neuf').count(), attendus.length, 'tout est nouveau à la première ouverture');

    // Statut et type en clair.
    assert.equal(await ligneHist(job.casse).locator('.note').innerText(), 'échec');
    assert.equal(await ligneHist(job.casse).locator('.tag').innerText(), 'Docker');
    assert.equal(await ligneHist(job.review201).locator('.note').innerText(), 'arrêté');
    assert.equal(await ligneHist(job.review200).locator('.tag').innerText(), 'Review');
    // La raison de l'échec, telle que le serveur l'a notée.
    const message = (await jobServeur(app, job.casse)).message;
    assert.ok(message, 'le serveur a noté une raison');
    assert.equal(await ligneHist(job.casse).locator('.hist-raison').innerText(), String(message).split('\n')[0].slice(0, 120));
    // L'objet visé est nommé ; relancer n'est offert que là où le serveur sait rejouer.
    assert.equal(await ligneHist(job.review200).locator('[data-histgo]').innerText(), '!200 — Merge request 1');
    assert.equal(await ligneHist(job.casse).locator('[data-histretry]').count(), 0);
    assert.equal(await ligneHist(job.porte).locator('[data-histretry]').count(), 0);

    // Refermer puis rouvrir : plus rien n'est « nouveau ».
    await fermerActivite();
    await ouvrirActivite();
    await attendreLignes(attendus);
    await page.waitForFunction(() => document.querySelectorAll('#logHist .log-queue-row.hist-neuf').length === 0, null, { timeout: ATTENTE });
  });

  test('filtrer l’Activité : par texte, « Échecs seulement », et les deux ensemble — sans rien retirer', async () => {
    await ouvrirActivite();
    const tous = [job.review200, job.casse, job.porte, job.review201, job.relance];
    await attendreLignes(tous);

    await page.locator('#histFilter').fill('docker');
    await attendreLignes([job.casse, job.porte]);
    await page.locator('#histFilter').fill('!201');
    await attendreLignes([job.review201, job.relance]);

    await page.locator('#histErrOnly').check();
    await attendreLignes([job.review201]);
    await page.locator('#histFilter').fill('');
    await attendreLignes([job.casse, job.review201]);
    await page.locator('#histErrOnly').uncheck();
    await attendreLignes(tous);
    assert.equal((await lignesVisibles()).length, tous.length);
  });

  /* « RELANCER » DANS L'ACTIVITÉ N'APPARAÎT JAMAIS. La route `/api/jobs/history` (src/server.js)
     sélectionne une liste de colonnes qui OMET `retry`, puis calcule `can_retry: jobs.canRetry(j)` —
     qui exige justement `job.retry`. Le résultat est toujours `false` : le bouton `data-histretry`
     n'est jamais rendu, même pour la review arrêtée que le bandeau, lui, sait relancer (il lit la
     ligne complète). */
  test('relancer depuis l’Activité : un nouveau job part sur le même objet', async () => {
    const api = (await tousLesJobs()).find((j) => j.id === job.review201);
    assert.equal(api.can_retry, true, 'une review arrêtée se rejoue (le bandeau le propose) : l’historique doit le dire aussi');
    await ouvrirActivite();
    const bouton = ligneHist(job.review201).locator(`[data-histretry="${job.review201}"]`);
    assert.equal(await bouton.count(), 1, 'le bouton « Relancer » de la ligne');
    const avant = new Set((await tousLesJobs()).map((j) => j.id));
    await bouton.click();
    await toast(/Job relancé/);
    await attendreServeur(async () => (await tousLesJobs()).some((j) => !avant.has(j.id) && j.status === 'done'), 'relance depuis l’Activité terminée');
    const nouveau = (await tousLesJobs()).find((j) => !avant.has(j.id));
    assert.equal(nouveau.kind, 'review');
    assert.equal(nouveau.target_id, mr[201]);
    await ligneHist(nouveau.id).waitFor({ timeout: ATTENTE });
  });

  /* Relire le journal d'un job PASSÉ pendant qu'un autre tourne : la vue reste épinglée sur ce
     qu'on lit, même quand le suivi du job courant reçoit de nouvelles lignes. */
  test('revoir le journal d’un job passé : il s’affiche et reste épinglé pendant qu’un autre job écrit', async () => {
    job.porteB = await chantier.lancer('porte-b');
    await rafraichir();
    await page.waitForFunction((j) => {
      const p = document.querySelector(`#logBox .logpane[data-job="${j}"]`);
      return p && p.textContent.includes('porte-b : en attente');
    }, job.porteB, { timeout: ATTENTE });
    await ouvrirActivite();
    await ligneHist(job.casse).locator(`[data-histlog="${job.casse}"]`).click();
    await page.locator('#logBox').waitFor({ state: 'visible' });
    const voletAffiche = () => page.evaluate(() => {
      const p = document.querySelector('#logBox .logpane:not([hidden])');
      return p ? { job: Number(p.dataset.job), texte: p.textContent } : null;
    });
    await page.waitForFunction((j) => {
      const p = document.querySelector('#logBox .logpane:not([hidden])');
      return p && Number(p.dataset.job) === j && p.textContent.includes('avant la casse');
    }, job.casse, { timeout: ATTENTE });

    // Le job courant écrit encore : son volet (caché) reçoit la suite, la vue ne bouge pas.
    chantier.feuVert('porte-b');
    await page.waitForFunction((j) => {
      const p = document.querySelector(`#logBox .logpane[data-job="${j}"]`);
      return p && p.textContent.includes('porte-b : feu vert reçu');
    }, job.porteB, { timeout: ATTENTE });
    const vu = await voletAffiche();
    assert.equal(vu.job, job.casse, 'la vue reste sur le journal qu’on relit');
    assert.match(vu.texte, /avant la casse/);
    await attendreStatutServeur(job.porteB, 'done');
  });

  test('l’objet d’un job mène à lui : la merge request reviewée s’ouvre dans Reviews', async () => {
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes.active').waitFor();
    await ouvrirActivite();
    await ligneHist(job.review200).locator('[data-histgo]').click();
    await page.locator('#tab-review.active').waitFor({ timeout: ATTENTE });
    await page.waitForFunction(() => /Merge request 1/.test((document.querySelector('#reportDetail') || {}).textContent || ''),
      null, { timeout: ATTENTE });
  });

  /* LE DOUBLE-CLIC SUR UNE LIGNE DE JOURNAL. Le guide (docs/guide.fr.md, « Un double-clic sur
     une ligne qui parle d'une merge request ouvre son rapport ») et l'écouteur existent
     (public/app.js, `dblclick` sur `[data-log-mr]`), mais aucune ligne ne porte jamais
     `data-log-mr` : `appendLogLines` ne pose que la classe et le texte, alors que le serveur
     renvoie bien `mr_id` pour chaque ligne. Le geste ne fait donc rien. */
  test('double-cliquer une ligne du journal d’une review ouvre la merge request dont elle parle', async () => {
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes.active').waitFor();
    await ouvrirActivite();
    await ligneHist(job.review200).locator(`[data-histlog="${job.review200}"]`).click();
    const ligne = page.locator(`#logBox .logpane[data-job="${job.review200}"] span`, { hasText: 'MR !200' }).first();
    await ligne.waitFor({ timeout: ATTENTE });
    assert.equal(await ligne.getAttribute('data-log-mr'), String(mr[200]),
      'la ligne qui parle de la MR !200 doit porter son id pour que le double-clic y mène');
    await ligne.dblclick();
    await page.locator('#tab-review.active').waitFor({ timeout: ATTENTE });
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
