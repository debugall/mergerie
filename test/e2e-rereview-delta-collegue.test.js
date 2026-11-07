'use strict';
/* « RELANCER (DELTA) » SUR LA REVIEW D'UN COLLÈGUE.
 *
 * Claire (une vraie seconde instance, `helpers/synchro-collegue`) reviewe une merge request ;
 * sa passe arrive ici par le dépôt de données partagé : `reviewed_sha`, le rapport (réécrit sur
 * ce disque), les constats. La branche bouge encore, et c'est ICI qu'on clique « Relancer
 * (delta) ». Trois choses à prouver :
 *
 *   1. le cas nominal : le delta part du SHA que Claire a relu vers la tête, le rapport de Claire
 *      est donné en contexte, et `reviewed_sha` avance ;
 *   2. la fenêtre : Claire a relu une tête que ce poste n'avait PAS ENCORE DÉCOUVERTE
 *      (`current_sha` en retard sur `reviewed_sha`). Sans relecture de la forge, le delta était
 *      `reviewed..current` — À L'ENVERS — et la passe reculait `reviewed_sha` chez tout le monde ;
 *   3. la garde : un SHA reviewé qui n'est pas un ancêtre de la tête (force-push vers un commit
 *      plus ancien) n'a pas de delta — diff complet, et le journal le dit.
 *
 * L'IA est un mock (dry-run) : on prouve le PLOMBAGE par le journal du job (`git diff a..b`) et
 * par la base, jamais la qualité du rapport. Un seul `startApp()`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, pushChange, waitForJobs, attendreServeur,
} = require('./helpers/app');
const { monterEquipe } = require('./helpers/synchro-ecran');

describe('Relancer (delta) sur la review d’un collègue', () => {
  let app; let claire; let depot; let idIci; let idClaire;
  const PROJET = 'grp/app';
  const mock = () => app.state.mrs[PROJET][0];

  const ici = async () => (await app.api('GET', `/api/mrs/${idIci}`)).body.mr;
  const versionsIci = () => app.db.prepare('SELECT version, reviewed_sha, md_path, n_new FROM review_version WHERE mr_id = ? ORDER BY version').all(idIci);
  const journalDe = async (job) => JSON.stringify((await app.api('GET', `/api/jobs/${job.id}/log`)).body);
  const synchroIci = async () => {
    const r = await app.api('POST', '/api/data-sync/now');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.statut && r.body.statut.erreur, null, `synchro ici sans erreur (${r.body.statut && r.body.statut.erreur})`);
  };

  async function claireAuRepos() {
    await attendreServeur(async () => {
      const { body } = await claire.api('GET', '/api/jobs/current');
      return body && !body.running && !body.queued;
    }, 'les jobs de Claire sont finis', 90000);
  }
  /* Claire relit la MR telle que la forge la montre MAINTENANT : elle redécouvre, puis reviewe. */
  async function claireReviewe(route = 'review') {
    await claire.api('POST', '/api/discover', {});
    const r = await claire.api('POST', `/api/mrs/${idClaire}/${route}`, {});
    assert.equal(r.status, 200, r.text);
    await claireAuRepos();
    const { body } = await claire.api('GET', `/api/mrs/${idClaire}`);
    assert.equal(body.mr.status, 'reviewed', `la review de Claire a abouti (${body.mr.last_error || ''})`);
    return body.mr;
  }
  /* La branche avance d'un commit sur le dépôt distant, et la forge le sait. */
  function laBrancheAvance(fichier, contenu) {
    const sha = pushChange(depot, fichier, contenu, `feat: ${fichier}`);
    mock().sha = sha;
    mock().diff_refs.head_sha = sha;
    return sha;
  }
  async function relancerDeltaIci() {
    const r = await app.api('POST', `/api/mrs/${idIci}/rereview`, { incremental: true });
    assert.equal(r.status, 200, r.text);
    await waitForJobs(app.api, { timeout: 90000 });
    const m = await ici();
    assert.equal(m.last_error, null, `la re-review a abouti : ${m.last_error}`);
    return r.body;
  }

  before(async () => {
    app = await startApp();
    depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-app-')), { branch: 'feature/PROJ-7-delta' });
    app.state.mrs[PROJET] = [{
      iid: 7, title: 'Delta à deux', state: 'opened',
      source_branch: depot.branch, target_branch: 'main',
      web_url: `https://gitlab.test/${PROJET}/-/merge_requests/7`,
      sha: depot.branchSha, created_at: '2026-01-07T10:00:00.000Z', author: { name: 'Auteur' },
      diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
    }];
    app.state.changes[`${PROJET}!7`] = [{ new_path: 'src/app.js' }];
    await app.configure({ review_explain: '0' });
    const repo = await app.api('POST', '/api/repos', { url: depot.url, project: PROJET });
    assert.equal(repo.status, 200, repo.text);
    await app.api('POST', '/api/discover', {});
    idIci = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7).id;

    ({ collegue: claire } = await monterEquipe(app, {
      configCollegue: (c) => ({
        gitlab_url: app.gitlabUrl, access_token: app.state.token, clone_path: path.join(c.dataDir, 'clones'),
        review_explain: '0', brief_on_open: '0',
      }),
    }));
    const rc = await claire.api('POST', '/api/repos', { url: depot.url, project: PROJET });
    assert.equal(rc.status, 200, rc.text);
    await claire.api('POST', '/api/discover', {});
    await attendreServeur(async () => (await claire.api('GET', '/api/mrs')).body.length === 1, 'la MR est arrivée chez Claire');
    idClaire = (await claire.api('GET', '/api/mrs')).body[0].id;
  });

  after(async () => {
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  test('cas nominal : le delta part du SHA relu par Claire, avec son rapport en contexte', async () => {
    const sha1 = depot.branchSha;
    const chezClaire = await claireReviewe();
    assert.equal(chezClaire.reviewed_sha, sha1);
    await claire.synchroniser();
    await synchroIci();

    const avant = await ici();
    assert.equal(avant.status, 'reviewed', 'la review de Claire est arrivée ici');
    assert.equal(avant.reviewed_sha, sha1);
    assert.equal(avant.current_sha, sha1);
    const v1 = versionsIci();
    assert.equal(v1.length, 1);
    assert.ok(v1[0].md_path && fs.existsSync(v1[0].md_path), 'le rapport de Claire est réécrit sur ce disque');
    const rapportCourant = app.db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(idIci).md_path;
    assert.equal(rapportCourant, v1[0].md_path, 'la review courante pointe le rapport de Claire');

    // La branche avance ; ce poste le découvre : la carte est périmée.
    const sha2 = laBrancheAvance('src/delta.js', 'export const d = 1;\n');
    await app.api('POST', '/api/discover', {});
    assert.equal((await ici()).current_sha, sha2);

    const job = await relancerDeltaIci();
    const journal = await journalDe(job);
    assert.match(journal, new RegExp(`git diff ${sha1.slice(0, 8)}\\.\\.${sha2.slice(0, 8)}`), 'le delta va de la review de Claire à la tête');
    assert.match(journal, /delta \+ rapport précédent|delta \+ previous report/, 'le rapport de Claire est donné en contexte');

    const apres = await ici();
    assert.equal(apres.reviewed_sha, sha2, 'reviewed_sha avance jusqu’à la tête');
    const v2 = versionsIci();
    assert.equal(v2.length, 2, 'une seconde passe, après celle de Claire');
    assert.equal(v2[1].reviewed_sha, sha2);
    assert.notEqual(v2[1].n_new, null, 'le suivi des constats a comparé à la passe de Claire');
  });

  test('fenêtre : Claire a relu une tête que ce poste n’avait pas découverte — le delta n’est pas inversé', async () => {
    const sha2 = (await ici()).current_sha;
    // La branche avance ; Claire le voit et reviewe sha3. Ce poste, lui, NE redécouvre PAS.
    const sha3 = laBrancheAvance('src/fenetre.js', 'export const f = 2;\n');
    const chezClaire = await claireReviewe('rereview');
    assert.equal(chezClaire.reviewed_sha, sha3);
    await claire.synchroniser();
    await synchroIci();

    const avant = await ici();
    assert.equal(avant.reviewed_sha, sha3, 'la passe de Claire est arrivée');
    assert.equal(avant.current_sha, sha2, 'ce poste tient encore l’ancienne tête : le cache de la forge est en retard');
    assert.equal((await app.api('GET', `/api/mrs/${idIci}`)).body.stale, true, 'la carte se croit périmée, le bouton delta est là');

    const job = await relancerDeltaIci();
    const journal = await journalDe(job);
    assert.doesNotMatch(journal, new RegExp(`git diff ${sha3.slice(0, 8)}\\.\\.${sha2.slice(0, 8)}`), 'jamais le diff à l’envers');
    const apres = await ici();
    assert.equal(apres.current_sha, sha3, 'la relance a relu la tête auprès de la forge');
    assert.equal(apres.reviewed_sha, sha3, 'reviewed_sha ne recule pas');
    assert.equal(versionsIci().length, 4, 'deux passes de Claire, deux d’ici');
  });

  test('garde : un SHA reviewé qui n’est pas un ancêtre de la tête (force-push en arrière) → diff complet', async () => {
    const sha3 = (await ici()).reviewed_sha;
    // Un nouveau commit, relu par Claire ; puis la forge revient à sha3 (force-push vers l'ancien).
    const sha4 = laBrancheAvance('src/garde.js', 'export const g = 3;\n');
    const chezClaire = await claireReviewe('rereview');
    assert.equal(chezClaire.reviewed_sha, sha4);
    await claire.synchroniser();
    await synchroIci();
    assert.equal((await ici()).reviewed_sha, sha4);
    mock().sha = sha3;
    mock().diff_refs.head_sha = sha3;

    const job = await relancerDeltaIci();
    const journal = await journalDe(job);
    assert.doesNotMatch(journal, new RegExp(`git diff ${sha4.slice(0, 8)}\\.\\.${sha3.slice(0, 8)}`), 'pas de delta entre deux commits sans lien');
    assert.match(journal, /anc[êe]tre|ancestor/, 'le journal dit pourquoi le diff est complet');
    const apres = await ici();
    assert.equal(apres.current_sha, sha3);
    assert.equal(apres.reviewed_sha, sha3, 'la passe complète relit la tête telle que la forge la donne');
  });
});
