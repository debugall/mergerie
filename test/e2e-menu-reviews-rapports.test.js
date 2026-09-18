'use strict';
/* MENU « REVIEWS » — LES STADES « REVIEWÉES » ET « TRAITÉES », CÔTÉ LISTE.
 *
 * La colonne de gauche des rapports : le résumé qui occupe la droite tant qu'aucun rapport
 * n'est ouvert (et ses raccourcis « par quoi commencer »), la recherche partagée, les pastilles
 * d'auteur (dont « À relire par moi »), les tris par note et par gravité, la case « prêtes à
 * merger », la sortie d'un filtre de note qui ne laisse rien, le bouton « Vérifier » d'une carte
 * de rapport, et le stade « Traitées ».
 *
 * Les cases de couleur elles-mêmes (combinaison, compteurs, « sans note », persistance) sont
 * déjà éprouvées par `e2e-reports-ui` : on ne les rejoue pas ici.
 *
 * L'agent est simulé (COPILOT_DRY_RUN) et rend le même rapport pour toutes : comme
 * `e2e-reports-ui`, on RÉÉCRIT le fichier de chaque rapport pour étaler les notes — la note est
 * relue du fichier à chaque appel — et l'on fixe la gravité des constats en base.
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

// iid → [titre, auteur, note (null = sans note)]
const MRS = {
  11: ['Paiement en trois fois', 'Testeur', '9,1'],
  12: ['Refonte du panier', 'Alice', '7,5'],
  13: ['Cache Redis des sessions', 'Bob', '5,0'],
  14: ['Migration SQL des factures', 'Carole', '2,0'],
  15: ['Traductions de l’accueil', 'Dan', null],
  16: ['Nettoyage des logs', 'Eve', '8,0'],
};

describe('Menu Reviews — liste des rapports', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const id = {};
  const erreurs = [];

  async function auRepos() {
    await attendreServeur(async () => {
      const { body } = await app.api('GET', '/api/status');
      return body && !body.running && !body.queued;
    }, 'plus aucun job en cours', 60000);
  }
  async function verifierParApi(iid) {
    const r = await app.api('POST', '/api/verify/mrs', { mr_ids: [id[iid]] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await attendreServeur(async () => {
      const [v] = (await app.api('GET', `/api/verifications?mr_id=${id[iid]}`)).body.verifications;
      return v && v.status === 'done';
    }, `la vérification de !${iid} se termine`, 60000);
    await auRepos();
  }

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = Object.entries(MRS).map(([iid, [titre, auteur]]) => ({
      iid: Number(iid), title: titre, state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
      sha: repo.branchSha, created_at: `2026-02-${iid}T10:00:00.000Z`, author: { name: auteur },
      // !13 me demande une relecture.
      reviewers: Number(iid) === 13 ? [{ username: 'testeur', name: 'Testeur' }] : [],
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (const iid of Object.keys(MRS)) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.configure();
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/verifiers', {
      name: 'tests unitaires', kind: 'commands', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
    await app.api('POST', '/api/jobs/review');
    await waitForJobs(app.api);
    await auRepos();

    // Les notes, étalées sur les trois couleurs, et un rapport sans note.
    for (const [iid, [, , note]] of Object.entries(MRS)) {
      const { md_path: md } = app.db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(id[iid]);
      fs.writeFileSync(md, note
        ? `# Revue de !${iid}\n\nDu texte.\n\n## Note globale\n\n**${note}/10**\n`
        : `# Revue de !${iid}\n\nDu texte, et pas de note.\n`, 'utf8');
    }
    /* Les gravités : chaque rapport simulé porte deux constats (un bloquant, un majeur). On les
       redistribue pour que « Bloquants d'abord » ait un ordre à imposer : !13 en a deux, !12
       garde les siens, les autres n'en ont plus. */
    const poser = app.db.prepare('UPDATE finding SET severity = ? WHERE mr_id = ?');
    poser.run('blocker', id[13]);
    for (const iid of [11, 14, 15, 16]) poser.run('minor', id[iid]);

    // !11 (9,1) et !14 (2,0) vérifiées vertes ; !16 classée « traitée ».
    await verifierParApi(11);
    await verifierParApi(14);
    await app.api('POST', `/api/mrs/${id[16]}/done`);

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

  // Attend que la liste des rapports montre exactement ces MR (dans cet ordre si `ordre`).
  async function attendreListe(iids, { ordre = false, timeout } = {}) {
    const attendus = iids.map((i) => id[i]);
    await page.waitForFunction(({ a, o }) => {
      const vus = [...document.querySelectorAll('#reportList .card[data-id]')].map((c) => Number(c.dataset.id));
      const norm = (x) => (o ? x : [...x].sort((p, q) => p - q));
      return JSON.stringify(norm(vus)) === JSON.stringify(norm(a));
    }, { a: attendus, o: ordre }, timeout ? { timeout } : undefined);
  }
  /* Pour les tests qui documentent un défaut : on attend l'état voulu un temps borné, puis on
     AFFIRME — l'échec montre alors ce que l'écran affiche (en numéros de MR), pas un délai. */
  async function constaterListe(iids, { ordre = false } = {}) {
    try { await attendreListe(iids, { ordre, timeout: 5000 }); } catch { /* l'assertion dit ce qui est vu */ }
    const parId = Object.fromEntries(Object.entries(id).map(([iid, v]) => [v, Number(iid)]));
    const vus = (await page.$$eval('#reportList .card[data-id]', (cs) => cs.map((c) => Number(c.dataset.id)))).map((v) => parId[v]);
    assert.deepEqual(ordre ? vus : [...vus].sort(), ordre ? iids : [...iids].sort());
  }
  const TOUTES = [11, 12, 13, 14, 15];

  test('« Reviewées » : la liste à gauche, un résumé à droite qui désigne les pires notes', async () => {
    await page.locator('[data-seg="reviewed"]').click();
    await attendreListe(TOUTES);
    await page.waitForFunction(() => document.querySelector('#segCountReviewed').textContent.trim() === '5');
    await page.waitForSelector('#reportDetail .ph-summary');
    assert.match(await page.locator('#reportDetail .ph-summary .empty-t').textContent(), /5 rapports/);
    // Par quoi commencer : les trois notes les plus basses, de la pire à la moins mauvaise.
    const raccourcis = await page.$$eval('#reportDetail [data-open-mr]', (bs) => bs.map((b) => Number(b.dataset.openMr)));
    assert.deepEqual(raccourcis, [id[14], id[13], id[12]]);
  });

  test('un raccourci du résumé ouvre le rapport de cette MR', async () => {
    await page.locator(`#reportDetail [data-open-mr="${id[14]}"]`).click();
    await page.waitForFunction((n) => /!14/.test((document.querySelector('#reportDetail .title') || {}).textContent || '')
      && /Revue de !14/.test(document.querySelector('#mdView').textContent), id[14]);
    await page.waitForSelector(`#reportList .card.active[data-id="${id[14]}"]`);
    assert.match(page.url(), new RegExp(`#/reviews/${id[14]}$`), 'l’adresse désigne le rapport ouvert');
  });

  test('la recherche vaut aussi pour les rapports, et les compteurs de note la suivent', async () => {
    await page.locator('#searchReview').fill('migration');
    await attendreListe([14]);
    await page.waitForFunction(() => document.querySelector('[data-nf-count="bad"]').textContent === '1'
      && document.querySelector('[data-nf-count="good"]').textContent === '0');
    await page.locator('#searchReview').fill('');
    await attendreListe(TOUTES);
  });

  test('un filtre de note qui ne laisse rien le dit, et « tout réafficher » rend la liste', async () => {
    await page.locator('#searchReview').fill('cache');
    await attendreListe([13]);
    await page.locator('#noteFilters .note-pick[value="mid"]').click();
    await page.waitForSelector('#reportList [data-empty-act="clear-note-filter"]');
    await page.locator('#reportList [data-empty-act="clear-note-filter"]').click();
    await attendreListe([13]);
    assert.equal(await page.locator('#noteFilters .note-pick:checked').count(), 4, 'toutes les couleurs sont recochées');
    await page.locator('#searchReview').fill('');
    await attendreListe(TOUTES);
  });

  test('les pastilles d’auteur valent pour les rapports, et « À relire par moi » isole ce qu’on m’a demandé', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#mrAuteurFiltre [data-mr-auteur]').length >= 3);
    await page.locator('[data-mr-auteur="moi"]').click();
    await attendreListe([11]);
    // La pastille « À relire par moi » ne se propose que quand une MR la justifie : !13.
    await page.waitForSelector('[data-mr-auteur="demandee"]');
    await page.locator('[data-mr-auteur="demandee"]').click();
    await attendreListe([13]);
    await page.locator('[data-mr-auteur="autres"]').click();
    await attendreListe([12, 13, 14, 15]);
    await page.locator('[data-mr-auteur="tous"]').click();
    await attendreListe(TOUTES);
  });

  test('« Bloquants d’abord » met en tête les MR qui portent le plus de bloquants', async () => {
    await page.selectOption('#mrTri', 'bloquants');
    await page.waitForFunction(({ a, b }) => {
      const vus = [...document.querySelectorAll('#reportList .card[data-id]')].map((c) => Number(c.dataset.id));
      return vus[0] === a && vus[1] === b;
    }, { a: id[13], b: id[12] });
    await page.selectOption('#mrTri', 'defaut');
    await attendreListe([15, 14, 13, 12, 11], { ordre: true });
  });

  /* La note d'une ligne de liste est un OBJET `{ raw, value }` (value sur 1). Le tri la passait à
     `Number()` : NaN partout, et `sort` gardait l'ordre d'arrivée — « Note la plus basse » ne
     triait rien (le départage de « Bloquants d'abord » non plus). */
  test('« Note la plus basse » range les rapports de la pire note à la meilleure',
    async () => {
      try {
        await page.selectOption('#mrTri', 'note');
        // 2,0 · 5,0 · 7,5 · 9,1, puis le rapport sans note.
        await constaterListe([14, 13, 12, 11, 15], { ordre: true });
      } finally {
        await page.selectOption('#mrTri', 'defaut');
      }
    });

  test('« prêtes à merger » ne garde que des MR vérifiées vertes, et n’existe qu’au stade « Reviewées »', async () => {
    assert.equal(await page.locator('#filtrePret').isVisible(), true);
    await page.locator('#filtrePret').click();
    // !12, !13 et !15 n'ont aucune vérification : elles ne sont jamais « prêtes ».
    await page.waitForFunction((ids) => {
      const vus = [...document.querySelectorAll('#reportList .card[data-id]')].map((c) => Number(c.dataset.id));
      return vus.includes(ids.pret) && !ids.jamais.some((x) => vus.includes(x));
    }, { pret: id[11], jamais: [id[12], id[13], id[15]] });
    await page.locator('#filtrePret').click();
    await attendreListe(TOUTES);
  });

  /* Le brief compte « prête à merger » une note ≥ 8/10 (`note_value * 10 >= seuil`). La case de
     la liste comparait `Number(m.note) < 8` — NaN sur l'objet note, donc jamais vrai : TOUTE
     note, même 2/10, passait, et la liste annonçait plus de MR prêtes que le brief. */
  test('« prêtes à merger » écarte une MR verte dont la note est sous le seuil',
    async () => {
      try {
        await page.locator('#filtrePret').click();
        await constaterListe([11]);
        assert.equal(await page.locator('[data-nf-count="ready"]').textContent(), '1');
      } finally {
        if (await page.locator('#filtrePret').isChecked()) await page.locator('#filtrePret').click();
        await attendreListe(TOUTES);
      }
    });

  test('« Vérifier » sur une carte de rapport lance la vérification sans ouvrir le rapport', async () => {
    const ouvert = await page.$eval('#reportList .card.active', (c) => Number(c.dataset.id));
    await page.locator(`#reportList [data-verify-report="${id[15]}"]`).click();
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    await page.locator('#verifyPickGo').click();
    await attendreServeur(async () => (await app.api('GET', `/api/verifications?mr_id=${id[15]}`)).body.verifications.length > 0,
      'la vérification de !15 existe');
    assert.equal(await page.$eval('#reportList .card.active', (c) => Number(c.dataset.id)), ouvert,
      'le rapport ouvert n’a pas changé');
    await auRepos();
  });

  test('« Traitées » ne montre que les MR classées, sans la case « prêtes à merger »', async () => {
    await page.locator('[data-seg="done"]').click();
    await attendreListe([16]);
    await page.waitForFunction(() => document.querySelector('#segCountDone').textContent.trim() === '1');
    assert.equal(await page.locator('#filtrePret').isVisible(), false);
    await page.locator(`#reportList .card[data-id="${id[16]}"]`).click();
    await page.waitForSelector('#aReopen', { state: 'attached' });
    assert.equal(await page.locator('#aDone').count(), 0, 'une MR traitée se rouvre, elle ne se reclasse pas');
    await page.locator('[data-seg="reviewed"]').click();
    await attendreListe(TOUTES);
  });

  test('aucune erreur de page sur tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
