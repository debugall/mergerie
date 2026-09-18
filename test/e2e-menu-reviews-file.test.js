'use strict';
/* MENU « REVIEWS » — LA FILE « À TRAITER », DANS UN VRAI NAVIGATEUR.
 *
 * Tout ce que l'utilisateur touche avant qu'un rapport existe : « Chercher les nouvelles MR »,
 * « Reviewer », la recherche, les pastilles d'auteur, le tri, la sélection multiple et sa barre
 * (vérifier ensemble, créer un lot, créer et vérifier, tout décocher), et chaque action d'une
 * carte (review avec ou sans explication, aperçu du diff, contexte, faire coder, vérifier,
 * classer sans review puis annuler, merger).
 *
 * Chaque geste est jugé sur son EFFET côté serveur (statut de la merge request, lot créé,
 * vérification lancée, appel à la forge) — jamais sur le libellé qu'il laisse à l'écran.
 *
 * Deux dépôts (grp/app, grp/lib) : la sélection multiple refuse deux merge requests du même
 * dépôt, il faut donc de quoi composer une sélection valide ET une invalide.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

/* Un diff de `n` lignes ajoutées : c'est ce que la forge renvoie dans `/changes`, et c'est de lui
   que la découverte tire la TAILLE d'une merge request — donc l'ordre « Petites d'abord ». */
const diffDe = (n) => `@@ -1 +1,${n} @@\n${'+ligne\n'.repeat(n)}`;

// iid → [dépôt, titre, auteur, lignes ajoutées]
const MRS = {
  1: ['app', 'Paiement : ajoute le module', 'Testeur', 5],
  2: ['app', 'Accueil : corrige la bannière', 'Alice', 1],
  3: ['app', 'Export CSV des factures', 'Bob', 9],
  4: ['lib', 'Client HTTP : relances', 'Carole', 3],
  5: ['lib', 'Client HTTP : délais', 'Testeur', 7],
  6: ['lib', 'Documentation du client', 'Dan', 2],
};

describe('Menu Reviews — la file « À traiter »', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const id = {};          // iid → id interne
  const repoId = {};      // 'app' | 'lib' → id du dépôt
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const depots = {
      app: makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-app-')), { branch: 'feature/PROJ-42-ajout' }),
      lib: makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-lib-')), { branch: 'feature/PROJ-42-client' }),
    };
    for (const [iid, [dep, titre, auteur, n]] of Object.entries(MRS)) {
      const repo = depots[dep];
      const projet = `grp/${dep}`;
      (app.state.mrs[projet] = app.state.mrs[projet] || []).push({
        iid: Number(iid), title: titre, state: 'opened',
        source_branch: repo.branch, target_branch: 'main',
        web_url: `https://gitlab.test/${projet}/-/merge_requests/${iid}`,
        sha: repo.branchSha, created_at: `2026-01-0${iid}T10:00:00.000Z`, author: { name: auteur },
        // !2 me demande une relecture : c'est ce que lit la pastille « À relire par moi ».
        reviewers: Number(iid) === 2 ? [{ username: 'testeur', name: 'Testeur' }] : [],
        diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
      });
      app.state.changes[`${projet}!${iid}`] = [{ new_path: 'src/app.js', diff: diffDe(n) }];
    }
    await app.configure();
    for (const dep of ['app', 'lib']) {
      repoId[dep] = (await app.api('POST', '/api/repos', { url: depots[dep].url, project: `grp/${dep}` })).body.id;
    }
    // Un vérificateur qui couvre les deux dépôts : sans lui, « Vérifier » naît grisé.
    await app.api('POST', '/api/verifiers', {
      name: 'tests unitaires', kind: 'commands', commands: ['true'],
      repos: [{ repo_id: repoId.app, mode: 'worktree' }, { repo_id: repoId.lib, mode: 'worktree' }],
    });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* ---------------------------------------------------------------- outils ---- */

  const mr = async (i) => (await app.api('GET', `/api/mrs/${id[i]}`)).body.mr;
  const statut = async (i) => (await mr(i)).status;
  // Attend que la file montre exactement ces merge requests (dans cet ordre si `ordre`).
  async function attendreFile(iids, { ordre = false } = {}) {
    const attendus = iids.map((i) => id[i]);
    await page.waitForFunction(({ a, o }) => {
      const vus = [...document.querySelectorAll('#toReviewList .card[data-id]')].map((c) => Number(c.dataset.id));
      const norm = (x) => (o ? x : [...x].sort((p, q) => p - q));
      return JSON.stringify(norm(vus)) === JSON.stringify(norm(a));
    }, { a: attendus, o: ordre });
  }
  async function auRepos() {
    await attendreServeur(async () => {
      const { body } = await app.api('GET', '/api/status');
      return body && !body.running && !body.queued;
    }, 'plus aucun job en cours', 60000);
  }
  const carte = (i) => page.locator(`#toReviewList .card[data-id="${id[i]}"]`);
  async function menuCarte(i) {
    await carte(i).locator(`[data-more="${id[i]}"]`).click();
    await carte(i).locator('.btn-split:has([data-more]) .split-menu:not([hidden])').waitFor();
  }
  const cocher = (i) => carte(i).locator('.mr-pick').click();
  async function toutDecocher() {
    if (!(await page.locator('#mrBulkBar').isHidden())) await page.locator('#btnBulkClear').click();
    await page.waitForSelector('#mrBulkBar', { state: 'hidden' });
  }
  async function choisirVerificateurEtLancer() {
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    assert.equal(await page.locator('#verifyPickList input[type="radio"]:checked').count(), 1,
      'un vérificateur est présélectionné');
    await page.locator('#verifyPickGo').click();
    await page.waitForSelector('#verifyPickModal', { state: 'hidden' });
  }
  const verificationsDe = async (i) => (await app.api('GET', `/api/verifications?mr_id=${id[i]}`)).body.verifications;

  /* --------------------------------------------------------- découverte ---- */

  test('« Chercher les nouvelles MR » interroge la forge et remplit la file', async () => {
    assert.equal((await app.api('GET', '/api/mrs')).body.length, 0, 'rien en base avant le clic');
    await page.locator('#btnDiscover').click();
    await page.waitForFunction(() => /6 MR/.test(document.querySelector('#discoverInfo').textContent));
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
    assert.equal(Object.keys(id).length, 6, 'les six merge requests sont en base');
    await attendreFile([1, 2, 3, 4, 5, 6]);
    assert.equal(await page.locator('#btnDiscover').isDisabled(), false, 'le bouton est rendu après la réponse');
  });

  /* LA FILE SE REMPLIT, LE COMPTEUR ET « REVIEWER » AUSSI. Le clic sur « Chercher les nouvelles
     MR » rechargeait la liste sans `refreshCounts()` : le segment gardait son ancien compte, et
     `majBoutonReview` laissait « Aucune MR à reviewer », grisé, au-dessus de six cartes. */
  test('après la découverte, le compteur du segment et « Reviewer » suivent sans autre geste',
    async () => {
      await page.waitForFunction(() => document.querySelector('#segCountToReview').textContent.trim() === '6',
        null, { timeout: 5000 });
      assert.equal(await page.locator('#btnReview').isDisabled(), false, '« Reviewer » est cliquable');
    });

  test('revenir sur « À traiter » recompte la file et arme « Reviewer »', async () => {
    await page.locator('[data-seg="to_review"]').click();
    await page.waitForFunction(() => document.querySelector('#segCountToReview').textContent.trim() === '6');
    await page.waitForFunction(() => /Reviewer les 6 MR/.test(document.querySelector('#btnReviewLabel').textContent));
    assert.equal(await page.locator('#btnReview').isDisabled(), false);
  });

  test('une forge en panne se signale sous la barre, et le signalement s’efface au passage suivant', async () => {
    app.state.fail['grp%2Flib/merge_requests'] = { status: 500, body: { message: 'panne simulée' } };
    try {
      await page.locator('#btnDiscover').click();
      await page.waitForFunction(() => /grp\/lib/.test(document.querySelector('#reviewErrors').textContent));
      assert.match(await page.locator('#discoverInfo').textContent(), /1 erreur/);
    } finally {
      delete app.state.fail['grp%2Flib/merge_requests'];
    }
    await page.locator('#btnDiscover').click();
    await page.waitForFunction(() => document.querySelector('#reviewErrors').textContent.trim() === '');
    await attendreFile([1, 2, 3, 4, 5, 6]);
  });

  /* ------------------------------------------------ recherche, auteur, tri ---- */

  test('la recherche réduit la file, le bouton « Reviewer » annonce ce qui reste, « Effacer » rend tout', async () => {
    await page.locator('#searchReview').fill('client http');
    await attendreFile([4, 5]);
    await page.waitForFunction(() => /Reviewer les 2 MR/.test(document.querySelector('#btnReviewLabel').textContent));

    await page.locator('#searchReview').fill('zzz-introuvable');
    await page.waitForSelector('#toReviewList [data-empty-act="clear-search"]');
    await page.locator('#toReviewList [data-empty-act="clear-search"]').click();
    await attendreFile([1, 2, 3, 4, 5, 6]);
    assert.equal(await page.locator('#searchReview').inputValue(), '', 'le champ est vidé');
    await page.waitForFunction(() => /Reviewer les 6 MR/.test(document.querySelector('#btnReviewLabel').textContent));
  });

  test('les pastilles d’auteur séparent mes merge requests de celles des autres', async () => {
    await page.waitForFunction(() => {
      const b = document.querySelector('#mrAuteurFiltre');
      return b && !b.hidden && b.querySelectorAll('[data-mr-auteur]').length >= 3;
    });
    await page.locator('[data-mr-auteur="moi"]').click();
    await attendreFile([1, 5]);
    assert.match(await page.locator('[data-mr-auteur="moi"]').getAttribute('class'), /active/);
    await page.locator('[data-mr-auteur="autres"]').click();
    await attendreFile([2, 3, 4, 6]);
    await page.locator('[data-mr-auteur="tous"]').click();
    await attendreFile([1, 2, 3, 4, 5, 6]);
  });

  /* La pastille « À relire par moi » ne s'affiche que si une merge request me demande une
     relecture. Elle ne cherchait que dans les RAPPORTS (`reportRows`), jamais dans la file
     « À traiter », là où ces demandes attendent. !2 me la demande, elle est dans la file. */
  test('la pastille « À relire par moi » apparaît quand une MR de la file me demande une relecture',
    async () => {
      await page.reload();
      await page.locator('nav button[data-tab="review"]').click();
      await attendreFile([1, 2, 3, 4, 5, 6]);
      await page.waitForFunction(() => document.querySelectorAll('#mrAuteurFiltre [data-mr-auteur]').length >= 3);
      assert.equal(await page.locator('[data-mr-auteur="demandee"]').count(), 1,
        '!2 demande ma relecture : la pastille « À relire par moi » doit être proposée');
    });

  test('« Petites d’abord » range la file par nombre de lignes changées, « Ordre habituel » la rétablit', async () => {
    await attendreFile([1, 2, 3, 4, 5, 6]);
    await page.selectOption('#mrTri', 'petites');
    await attendreFile([2, 6, 4, 1, 5, 3], { ordre: true });
    assert.match(await page.locator('.mr-tri').getAttribute('class'), /actif/, 'un tri actif se marque');
    await page.selectOption('#mrTri', 'defaut');
    // Ordre habituel : du plus récent au plus ancien (date de création sur la forge).
    await attendreFile([6, 5, 4, 3, 2, 1], { ordre: true });
    assert.doesNotMatch(await page.locator('.mr-tri').getAttribute('class'), /actif/);
  });

  /* ------------------------------------------------------------- Reviewer ---- */

  test('« Reviewer » sur toute la file demande confirmation au-delà de cinq, et « Annuler » ne lance rien', async () => {
    await page.locator('#btnReview').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmTitle').textContent(), /6 merge requests/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    const { body } = await app.api('GET', '/api/jobs/current');
    assert.ok(!body.running && !body.queued, 'aucun job n’est parti');
    for (const i of [1, 2, 3, 4, 5, 6]) assert.equal(await statut(i), 'to_review');
  });

  /* ------------------------------------------------------ sélection multiple ---- */

  test('cocher deux MR de dépôts différents ouvre la barre, propose le nom du lot et change « Reviewer »', async () => {
    await cocher(1);
    await cocher(4);
    await page.waitForSelector('#mrBulkBar:not([hidden])');
    assert.match(await page.locator('#mrBulkCount').textContent(), /2 merge requests sélectionnées/);
    assert.equal(await page.locator('#mrBulkWarn').isHidden(), true, 'deux dépôts différents : aucun avertissement');
    assert.equal(await page.locator('#btnBulkVerify').isDisabled(), false);
    assert.equal(await page.locator('#mrBulkLotName').inputValue(), 'PROJ-42', 'la clé de ticket commune est proposée');
    assert.match(await page.locator('#btnReviewLabel').textContent(), /2 sélectionnées/);
  });

  test('une troisième MR du même dépôt fait avertir et grise « Vérifier ensemble » et « Créer un lot »', async () => {
    await cocher(2);
    await page.waitForSelector('#mrBulkWarn:not([hidden])');
    assert.equal(await page.locator('#btnBulkVerify').isDisabled(), true);
    assert.equal(await page.locator('#btnBulkLot').isDisabled(), true);
    await cocher(2);
    await page.waitForSelector('#mrBulkWarn', { state: 'hidden' });
    assert.equal(await page.locator('#btnBulkVerify').isDisabled(), false);
  });

  test('« Tout décocher » referme la barre et décoche chaque carte', async () => {
    await page.locator('#btnBulkClear').click();
    await page.waitForSelector('#mrBulkBar', { state: 'hidden' });
    assert.equal(await page.locator('#toReviewList .mr-pick:checked').count(), 0);
    assert.match(await page.locator('#btnReviewLabel').textContent(), /Reviewer les 6 MR/);
  });

  test('« Créer un lot » refuse un nom vide, puis crée le lot avec les MR cochées', async () => {
    await cocher(1);
    await cocher(4);
    await page.waitForSelector('#mrBulkBar:not([hidden])');
    await page.locator('#mrBulkLotName').fill('');
    await page.locator('#btnBulkLot').click();
    await page.waitForSelector('.toast.err');
    assert.equal((await app.api('GET', '/api/lots')).body.length, 0, 'aucun lot sans nom');

    await page.locator('#mrBulkLotName').fill('Lot paiement');
    await page.locator('#btnBulkLot').click();
    await attendreServeur(async () => (await app.api('GET', '/api/lots')).body.some((l) => l.name === 'Lot paiement'),
      'le lot est créé');
    const lot = (await app.api('GET', '/api/lots')).body.find((l) => l.name === 'Lot paiement');
    assert.deepEqual(lot.members.map((m) => m.ref_id).sort((a, b) => a - b), [id[1], id[4]].sort((a, b) => a - b));
    await page.waitForFunction(() => document.querySelector('#mrBulkLotName').value === '');
    await toutDecocher();
  });

  test('« Vérifier ensemble » fait choisir le vérificateur et lance UNE vérification sur les deux MR', async () => {
    await cocher(1);
    await cocher(4);
    await page.locator('#btnBulkVerify').click();
    await choisirVerificateurEtLancer();
    await attendreServeur(async () => (await verificationsDe(1)).length > 0, 'une vérification porte sur !1');
    const [v] = await verificationsDe(1);
    assert.deepEqual(v.targets.map((c) => c.mr_id).sort((a, b) => a - b), [id[1], id[4]].sort((a, b) => a - b),
      'les deux merge requests sont vérifiées ensemble');
    await auRepos();
    await toutDecocher();
  });

  test('« Créer et vérifier » crée le lot ET lance sa vérification', async () => {
    await cocher(3);
    await cocher(6);
    await page.locator('#mrBulkLotName').fill('Lot export');
    await page.locator('#btnBulkLotVerify').click();
    await choisirVerificateurEtLancer();
    await attendreServeur(async () => {
      const lot = (await app.api('GET', '/api/lots')).body.find((l) => l.name === 'Lot export');
      return !!(lot && lot.last_verification);
    }, 'le lot « Lot export » porte une vérification');
    await auRepos();
    await toutDecocher();
  });

  /* ---------------------------------------------------------- actions de carte ---- */

  test('⋯ → « Vérifier » sur une carte lance la vérification de cette seule MR', async () => {
    const avant = (await verificationsDe(2)).length;
    assert.equal(avant, 0);
    await menuCarte(2);
    await carte(2).locator(`[data-verify="${id[2]}"]`).click();
    await choisirVerificateurEtLancer();
    await attendreServeur(async () => (await verificationsDe(2)).length > 0, 'la vérification de !2 existe');
    const [v] = await verificationsDe(2);
    assert.deepEqual(v.targets.map((c) => c.mr_id), [id[2]]);
    await auRepos();
  });

  test('« Contexte » ouvre la modale, et « Enregistrer » écrit le contexte de la MR', async () => {
    await carte(3).locator(`[data-ticket="${id[3]}"]`).click();
    await page.waitForSelector('#ticketModal:not([hidden])');
    assert.match(await page.locator('#ticketMrTitle').textContent(), /!3/);
    await page.locator('#ticketText').fill('Règle métier : les montants sont arrondis au centime.');
    await page.locator('#ticketSave').click();
    await page.waitForSelector('#ticketModal', { state: 'hidden' });
    await attendreServeur(async () => {
      const d = (await app.api('GET', `/api/mrs/${id[3]}`)).body;
      return d.ticket && /arrondis au centime/.test(d.ticket.text || '');
    }, 'le contexte est enregistré');
  });

  test('⋯ → « Faire coder » ouvre la modale de session sur la branche de la MR', async () => {
    await menuCarte(4);
    await carte(4).locator(`[data-dev="${id[4]}"]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.match(await page.locator('#taskModalTitle').textContent(), /feature\/PROJ-42-client/);
    assert.match(await page.locator('#taskExistingImgs').textContent(), /!4/);
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
    assert.equal((await app.api('GET', '/api/tasks')).body.length || 0, 0, 'fermer ne crée aucune session');
  });

  test('⋯ → « Classer sans review » retire la carte, et « Annuler l’action » la ramène', async () => {
    await menuCarte(6);
    await carte(6).locator(`[data-done="${id[6]}"]`).click();
    await attendreFile([1, 2, 3, 4, 5]);
    assert.equal(await statut(6), 'done');
    await page.locator('.toast .toast-btn').filter({ hasText: /Annuler/ }).click();
    await attendreServeur(async () => await statut(6) === 'to_review', '!6 revient dans la file');
    await attendreFile([1, 2, 3, 4, 5, 6]);
  });

  test('« Reviewer » avec une sélection ne reviewe QUE la sélection', async () => {
    await cocher(1);
    await page.waitForFunction(() => /1 sélectionnée|la MR sélectionnée/.test(document.querySelector('#btnReviewLabel').textContent));
    await page.locator('#btnReview').click();
    await attendreServeur(async () => await statut(1) === 'reviewed', '!1 est reviewée');
    await waitForJobs(app.api);
    for (const i of [2, 3, 4, 5, 6]) assert.equal(await statut(i), 'to_review', `!${i} n’a pas été touchée`);
    await toutDecocher();
    await attendreFile([2, 3, 4, 5, 6]);
  });

  test('▾ → « avec explication » produit un rapport ET une explication', async () => {
    await carte(2).locator(`[data-review-menu="${id[2]}"]`).click();
    await carte(2).locator(`[data-review-run="${id[2]}"][data-explain="1"]`).click();
    await attendreServeur(async () => await statut(2) === 'reviewed', '!2 est reviewée');
    await waitForJobs(app.api);
    const { review } = (await app.api('GET', `/api/mrs/${id[2]}`)).body;
    assert.match(review.md || '', /Rapport de revue/);
    assert.match(review.explanation || '', /Explication/, 'l’explication pédagogique est générée');
  });

  test('▾ → « sans explication » produit un rapport sans explication', async () => {
    await carte(3).locator(`[data-review-menu="${id[3]}"]`).click();
    await carte(3).locator(`[data-review-run="${id[3]}"][data-explain="0"]`).click();
    await attendreServeur(async () => await statut(3) === 'reviewed', '!3 est reviewée');
    await waitForJobs(app.api);
    const { review } = (await app.api('GET', `/api/mrs/${id[3]}`)).body;
    assert.match(review.md || '', /Rapport de revue/);
    assert.equal((review.explanation || '').trim(), '', 'aucune explication demandée, aucune produite');
  });

  test('le bouton « Reviewer » d’une carte lance la review de cette MR', async () => {
    await carte(4).locator(`[data-review="${id[4]}"]`).click();
    await attendreServeur(async () => await statut(4) === 'reviewed', '!4 est reviewée');
    await waitForJobs(app.api);
    await attendreFile([5, 6]);
    await page.waitForFunction(() => document.querySelector('#segCountReviewed').textContent.trim() === '4');
  });

  test('« Aperçu du diff » ouvre le code en mode décision, et « Reviewer » de ce panneau lance la review', async () => {
    await carte(5).locator(`[data-diff="${id[5]}"]`).click();
    await page.waitForSelector('#splitView:not([hidden]).preview-mode');
    assert.match(await page.locator('#splitTitle').textContent(), /!5/);
    await page.waitForSelector('#treeList .tree-file[data-path="src/app.js"]');
    await page.locator('#pvReview').click();
    await page.waitForSelector('#splitView', { state: 'hidden' });
    await attendreServeur(async () => await statut(5) === 'reviewed', '!5 est reviewée');
    await waitForJobs(app.api);
    await attendreFile([6]);
  });

  test('⋯ → « Merger » ouvre la modale de merge, et la confirmation merge sur la forge puis sort la MR de la file', async () => {
    await menuCarte(6);
    await carte(6).locator(`[data-merge="${id[6]}"]`).click();
    await page.waitForSelector('#mergeModal:not([hidden])');
    assert.match(await page.locator('#mergeModalIntro').textContent(), /!6/);
    await page.locator('#mergeGo').click();
    await attendreServeur(async () => {
      const m = await mr(6);
      return m.closed_seen === 1 && m.status === 'done';
    }, '!6 est mergée et classée');
    assert.ok(app.state.calls.some((c) => c.method === 'PUT' && /grp%2Flib\/merge_requests\/6\/merge/.test(c.path)),
      'la forge a bien reçu la demande de merge');
    await page.waitForSelector('#toReviewList [data-empty-act="seg-reviewed"]');
  });

  test('file vide : l’état vide propose de chercher et d’aller aux rapports', async () => {
    assert.equal(await page.locator('#toReviewList [data-empty-act="discover"]').count(), 1);
    await page.waitForFunction(() => /Aucune MR à reviewer/.test(document.querySelector('#btnReviewLabel').textContent));
    assert.equal(await page.locator('#btnReview').isDisabled(), true, 'rien à reviewer : bouton grisé');
    await page.locator('#toReviewList [data-empty-act="seg-reviewed"]').click();
    await page.waitForSelector('[data-seg="reviewed"].active');
    await page.waitForSelector('#reportSplit:not([hidden]) #reportList .card');
    await page.waitForFunction(() => document.querySelectorAll('#reportList .card').length === 5);
    // !1 à !5 ont été reviewées ; !6, mergée, est classée « traitée ».
    assert.equal(await page.locator('#reportList .card').count(), 5, 'les cinq MR reviewées sont là');
  });

  test('aucune erreur de page sur tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
