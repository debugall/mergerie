'use strict';
/* MENU « REVIEWS » APRÈS UNE SYNCHRONISATION — l'écran suit-il le travail d'une collègue ?
 *
 * Le cas de l'utilisateur : Claire reviewe une merge request ; chez moi, la carte est dans
 * « À traiter », l'écran est ouvert. Je synchronise (le témoin du pied de page, ou la boucle
 * automatique). La merge request doit passer dans « Reviewées » SOUS MES YEUX : compteurs des
 * stades (`#segCountToReview`, `#segCountReviewed`), badge du menu (`#navCountReview`), listes,
 * et le rapport ouvert s'il y en a un.
 *
 * Claire est une vraie seconde instance (processus enfant, sa base, son port, son identité git)
 * branchée sur le même faux GitLab et le même dépôt nu : ses reviews tournent pour de vrai (en
 * dry-run), son code de synchro pousse au vrai format du store.
 *
 * Forme de chaque test : voir `helpers/synchro-ecran` — effet attendu à l'écran, borné, puis un
 * témoin rechargé (dur), puis le jugement « sans recharger ». L'écran suit grâce au numéro des
 * données (`dataVersion` de `/api/status`), qui avance à chaque synchro apportant du nouveau.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  monterEquipe, synchroniserDepuisLePied, exigerQueLEcranSuive,
} = require('./helpers/synchro-ecran');

const { dispo } = navigateurDispo();

// iid → titre
const MRS = { 1: 'Paiement : ajoute le module', 2: 'Accueil : corrige la bannière', 3: 'Export CSV des factures', 4: 'Client HTTP : relances' };

/* LA CAUSE, UNE FOIS POUR TOUTES — c'est la même pour chaque écran de ce fichier.
   Après un tour de synchro, le client ne rafraîchit que le pied de page : le témoin
   (`public/app.js`, clic sur `#footerSync` → `rafraichirFooterSync()`), le bouton des réglages
   (`#btnDataNow` → `chargerDataSync()`), et la boucle automatique ne prévient personne — le
   serveur hydrate la base (`src/datasync.js`, `tourMaintenant` → `hydraterDepuis`) sans qu'aucun
   signal (numéro de génération dans `/api/status`, événement de notification) ne dise à la page
   que des lignes ont changé. `refreshCounts` / `loadSegment` / `openReport(…, { keep: true })`
   ne sont appelés qu'à la fin d'un job LOCAL (`marquerEnCours`, `refreshStatus`). */

describe('Reviews · l’écran suit ce que la collègue a fait, après une synchro', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let claire;
  const id = {};        // iid → id interne, ICI
  const idClaire = {};  // iid → id interne, chez Claire
  const erreurs = [];

  const statutIci = async (iid) => (await app.api('GET', `/api/mrs/${id[iid]}`)).body.mr.status;
  const versionsIci = async (iid) => (await app.api('GET', `/api/mrs/${id[iid]}/versions`)).body.length;

  async function claireAuRepos() {
    await attendreServeur(async () => {
      const { body } = await claire.api('GET', '/api/jobs/current');
      return body && !body.running && !body.queued;
    }, 'les jobs de Claire sont finis', 90000);
  }
  async function claireReviewe(iid, route = 'review') {
    const r = await claire.api('POST', `/api/mrs/${idClaire[iid]}/${route}`, {});
    assert.equal(r.status, 200, r.text);
    await claireAuRepos();
    const { body } = await claire.api('GET', `/api/mrs/${idClaire[iid]}`);
    assert.equal(body.mr.status, 'reviewed', `la review de Claire a abouti (${body.mr.last_error || ''})`);
  }
  async function claireFait(iid, route) {
    const r = await claire.api('POST', `/api/mrs/${idClaire[iid]}/${route}`, {});
    assert.equal(r.status, 200, r.text);
  }

  // Reviews, sur un stade donné, et la liste chargée.
  async function allerAuStade(seg) {
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#tab-review.active');
    await page.locator(`.segmented [data-seg="${seg}"]`).click();
    await page.waitForFunction((s) => document.querySelector(`.segmented [data-seg="${s}"]`).classList.contains('active')
      && !document.querySelector('#segCountToReview').classList.contains('is-waiting'), seg);
  }
  const recharger = async (seg) => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="review"]');
    await allerAuStade(seg);
  };
  const compteurs = () => page.evaluate(() => ({
    aTraiter: document.querySelector('#segCountToReview').textContent.trim(),
    reviewees: document.querySelector('#segCountReviewed').textContent.trim(),
    traitees: document.querySelector('#segCountDone').textContent.trim(),
    nav: document.querySelector('#navCountReview').textContent.trim(),
  }));

  before(async () => {
    app = await startApp();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-app-')), { branch: 'feature/PROJ-42-ajout' });
    for (const [iid, titre] of Object.entries(MRS)) {
      (app.state.mrs['grp/app'] = app.state.mrs['grp/app'] || []).push({
        iid: Number(iid), title: titre, state: 'opened',
        source_branch: depot.branch, target_branch: 'main',
        web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
        sha: depot.branchSha, created_at: `2026-01-0${iid}T10:00:00.000Z`, author: { name: 'Auteur' },
        diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
      });
      app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js', diff: '@@ -1 +1,2 @@\n+a\n+b\n' }];
    }
    await app.configure();
    const repo = await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' });
    assert.equal(repo.status, 200, repo.text);
    const d = await app.api('POST', '/api/discover', {});
    assert.equal(d.status, 200, d.text);
    await attendreServeur(async () => (await app.api('GET', '/api/mrs')).body.length === 4, 'les 4 MR découvertes ici');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;

    // Claire rejoint : elle a son propre jeton pour la même forge, et ses propres clones.
    ({ collegue: claire } = await monterEquipe(app, {
      configCollegue: (c) => ({
        gitlab_url: app.gitlabUrl, access_token: app.state.token, clone_path: path.join(c.dataDir, 'clones'), brief_on_open: '0',
      }),
    }));
    await attendreServeur(async () => (await claire.api('GET', '/api/mrs')).body.length === 4, 'les 4 MR arrivées chez Claire');
    for (const m of (await claire.api('GET', '/api/mrs')).body) idClaire[m.iid] = m.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  test('le témoin du pied de page rapatrie la review de Claire dans la base de ce poste', async () => {
    /* Le préalable de tout le fichier : sans lui, chaque échec suivant accuserait l'écran d'une
       panne qui serait en fait celle de la synchro. */
    await allerAuStade('to_review');
    await page.waitForFunction(() => document.querySelector('#segCountToReview').textContent.trim() === '4');
    await claireReviewe(1);
    await claire.synchroniser();
    assert.equal(await statutIci(1), 'to_review', 'rien n’arrive tant que ce poste n’a pas synchronisé');
    await synchroniserDepuisLePied(page);
    assert.equal(await statutIci(1), 'reviewed', 'la review de Claire est arrivée ici');
    assert.equal(await versionsIci(1), 1, 'avec sa passe');
    // Le témoin : l'écran, rechargé, la montre bien dans « Reviewées ».
    await recharger('reviewed');
    await page.waitForSelector(`#reportList .card[data-id="${id[1]}"]`);
    await page.waitForFunction(() => ['#segCountToReview', '#segCountReviewed', '#segCountDone', '#navCountReview']
      .map((s) => document.querySelector(s).textContent.trim()).join('/') === '3/1/0/3');
    assert.deepEqual(erreurs, []);
  });

  test('« À traiter » ouvert : la MR reviewée par Claire quitte la liste, compteurs et badge suivent', async () => {
      await recharger('to_review');
      await page.waitForSelector(`#toReviewList .card[data-id="${id[2]}"]`);
      await page.waitForFunction(() => document.querySelector('#segCountToReview').textContent.trim() === '3');
      await claireReviewe(2);
      await claire.synchroniser();
      await synchroniserDepuisLePied(page);
      assert.equal(await statutIci(2), 'reviewed');
      await exigerQueLEcranSuive(page, {
        predicat: (mid) => !document.querySelector(`#toReviewList .card[data-id="${mid}"]`)
          && document.querySelector('#segCountToReview').textContent.trim() === '2'
          && document.querySelector('#segCountReviewed').textContent.trim() === '2'
          && document.querySelector('#navCountReview').textContent.trim() === '2',
        arg: id[2],
        temoin: () => recharger('to_review'),
        bug: 'la carte, « À traiter 3 → 2 », « Reviewées 1 → 2 » et le badge du menu restent figés jusqu’au rechargement',
      });
    });

  test('« Reviewées » ouvert : la MR que Claire vient de reviewer y apparaît', async () => {
    await recharger('reviewed');
    await page.waitForSelector(`#reportList .card[data-id="${id[1]}"]`);
    await claireReviewe(3);
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    assert.equal(await statutIci(3), 'reviewed');
    await exigerQueLEcranSuive(page, {
      predicat: (mid) => Boolean(document.querySelector(`#reportList .card[data-id="${mid}"]`))
        && document.querySelector('#segCountReviewed').textContent.trim() === '3',
      arg: id[3],
      temoin: () => recharger('reviewed'),
      bug: 'la carte n’apparaît pas dans « Reviewées », le compteur reste à 2',
    });
  });

  test('un rapport OUVERT suit la nouvelle passe de Claire (v2 dans le sélecteur de versions)', async () => {
    await recharger('reviewed');
    await page.locator(`#reportList .card[data-id="${id[1]}"]`).click();
    await page.waitForFunction(() => /#\/reviews\/\d+/.test(location.hash) && document.querySelector('#reportDetail .detail-actions'));
    assert.equal(await page.locator('#mdVersion').isHidden(), true, 'une seule passe : pas de sélecteur');
    await claireReviewe(1, 'rereview');
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    assert.equal(await versionsIci(1), 2, 'la seconde passe de Claire est arrivée ici');
    const ouvrir = async () => {
      await recharger('reviewed');
      await page.locator(`#reportList .card[data-id="${id[1]}"]`).click();
    };
    await exigerQueLEcranSuive(page, {
      predicat: () => {
        const sel = document.querySelector('#mdVersion');
        return Boolean(sel && !sel.hidden && sel.options.length === 2);
      },
      temoin: ouvrir,
      bug: 'le rapport ouvert reste sur la passe d’avant : pas de v2, pas de sélecteur, jusqu’au rechargement',
    });
  });

  test('Claire classe une MR « traitée » : elle quitte « Reviewées » et « Traitées » compte +1', async () => {
    await recharger('reviewed');
    await page.waitForSelector(`#reportList .card[data-id="${id[3]}"]`);
    await claireFait(3, 'done');
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    assert.equal(await statutIci(3), 'done');
    await exigerQueLEcranSuive(page, {
      predicat: (mid) => !document.querySelector(`#reportList .card[data-id="${mid}"]`)
        && document.querySelector('#segCountDone').textContent.trim() === '1'
        && document.querySelector('#segCountReviewed').textContent.trim() === '2',
      arg: id[3],
      temoin: () => recharger('reviewed'),
      bug: 'la MR classée par Claire reste affichée dans « Reviewées », « Traitées » reste à 0',
    });
  });

  test('Claire la rouvre : « Traitées » ouvert, elle en ressort', async () => {
    await recharger('done');
    await page.waitForSelector(`#reportList .card[data-id="${id[3]}"]`);
    await claireFait(3, 'reopen');
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    assert.equal(await statutIci(3), 'reviewed');
    await exigerQueLEcranSuive(page, {
      predicat: (mid) => !document.querySelector(`#reportList .card[data-id="${mid}"]`)
        && document.querySelector('#segCountDone').textContent.trim() === '0',
      arg: id[3],
      temoin: () => recharger('done'),
      bug: 'la MR rouverte par Claire reste dans « Traitées »',
    });
  });

  test('Claire SUPPRIME le rapport que j’ai ouvert : sa carte quitte « Reviewées », le compteur suit', async () => {
    await recharger('reviewed');
    await page.locator(`#reportList .card[data-id="${id[2]}"]`).click();
    await page.waitForFunction((mid) => location.hash === `#/reviews/${mid}` && document.querySelector('#reportDetail .detail-actions'), id[2]);
    const n0 = Number((await compteurs()).reviewees);
    await claireFait(2, 'delete-review');
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    await attendreServeur(async () => (await statutIci(2)) === 'to_review', 'la suppression de Claire est arrivée ici');
    await exigerQueLEcranSuive(page, {
      predicat: ({ mid, n }) => !document.querySelector(`#reportList .card[data-id="${mid}"]`)
        && document.querySelector('#segCountReviewed').textContent.trim() === String(n),
      arg: { mid: id[2], n: n0 - 1 },
      temoin: () => recharger('reviewed'),
      bug: 'le rapport supprimé par Claire reste ouvert et sa carte reste dans « Reviewées »',
    });
  });

  /* PAS UN DÉFAUT D'ÉCRAN, UN DÉFAUT DE DONNÉES — relevé en écrivant le test précédent. Claire a
     supprimé son rapport : `reviews/…/2/review.json` a quitté le dépôt, sa merge request est
     repassée « à traiter ». Chez moi, le statut suit mais la LIGNE `review` reste : la
     suppression d'un fichier ne se traduit en suppression de ligne que si le chemin nomme la
     ligne (`src/store.js`, `supprimerLigne`), et `review.json` est nommé par sa merge request.
     Résultat : l'adresse du rapport l'affiche encore ici, alors qu'il n'existe plus nulle part
     ailleurs. */
  test('le rapport supprimé par Claire n’existe plus ici non plus', async () => {
    assert.equal(await statutIci(2), 'to_review', 'le statut, lui, a suivi');
    const { body } = await app.api('GET', `/api/mrs/${id[2]}`);
    assert.equal(body.review, null, 'la review supprimée chez Claire doit disparaître ici aussi');
  });

  test('Statistiques ouvertes : l’entonnoir compte la review de Claire', async () => {
    const ouvrirStats = async () => {
      await page.locator('nav button[data-tab="dashboard"]').click();
      await page.waitForSelector('#tab-dashboard.active');
    };
    await page.reload();
    await page.waitForSelector('nav button[data-tab="dashboard"]');
    await ouvrirStats();
    const avant = (await app.api('GET', '/api/stats')).body.funnel.reviewed;
    const tuileReviewees = (n) => {
      const v = document.querySelector('#tab-dashboard .stat-tile.accent .stat-val');
      return Boolean(v) && v.textContent.trim() === String(n);
    };
    await page.waitForFunction(tuileReviewees, avant);
    await claireReviewe(4);
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    const apres = (await app.api('GET', '/api/stats')).body.funnel;
    assert.equal(apres.reviewed, avant + 1, 'l’API compte déjà la review de Claire');
    await exigerQueLEcranSuive(page, {
      predicat: tuileReviewees,
      arg: apres.reviewed,
      temoin: async () => { await page.reload(); await page.waitForSelector('nav button[data-tab="dashboard"]'); await ouvrirStats(); },
      bug: 'l’écran Statistiques garde les chiffres d’avant la synchro',
    });
  });

  test('synchro AUTOMATIQUE (cadence 10 s) : la MR reviewée par Claire bouge sans un clic', async () => {
    // La boucle ne se réarme qu'au rattachement : on rattache de nouveau, cadence courte.
    await synchroniserDepuisLePied(page);
    await app.api('PUT', '/api/config', { data_sync_seconds: '10' });
    const nu = (await app.api('GET', '/api/config')).body.data_repo_url;
    assert.equal((await app.api('POST', '/api/data-sync/attach', { url: nu })).status, 200);
    await recharger('to_review');
    const n0 = Number((await compteurs()).aTraiter);
    // Claire supprime sa review de !4 : chez moi, la carte doit revenir dans « À traiter ».
    await claireFait(4, 'delete-review');
    await claire.synchroniser();
    await attendreServeur(async () => (await statutIci(4)) === 'to_review', 'la boucle a rapatrié la suppression', 60000);
    await exigerQueLEcranSuive(page, {
      predicat: ({ mid, n }) => Boolean(document.querySelector(`#toReviewList .card[data-id="${mid}"]`))
        && document.querySelector('#segCountToReview').textContent.trim() === String(n),
      arg: { mid: id[4], n: n0 + 1 },
      temoin: () => recharger('to_review'),
      bug: 'la boucle automatique hydrate la base sans que l’écran « À traiter » ne bouge',
    });
  });
});
