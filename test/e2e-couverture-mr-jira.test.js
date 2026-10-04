'use strict';
/* Les routes d'une merge request et d'un projet de session que les écrans appellent mais
   qu'aucun test ne touchait — ni par l'API, ni par un clic :

   - les commits arrivés DEPUIS la review (`stale-commits`, la bulle du tag « périmé ») ;
   - l'historique des vérifications d'une MR (`verifications/history`, la tendance du rapport) ;
   - prévenir Jira depuis la modale de merge (`mrs/:id/notify-jira`) ;
   - le PORTEUR d'un ticket Jira (`jira/issues/:key/carrier`) : le dépôt et la branche que le plugin Liens
     utilise pour poser ses boutons d'environnement (leur résolution est testée dans son dépôt) ;
   - « repartir d'une session d'agent neuve » (`forget-session`).

   Vrai dépôt git, faux GitLab et faux Jira pilotés par le test : on juge l'EFFET (ce que la
   forge a reçu, ce que la base porte), jamais un libellé. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, pushChange, waitForJobs, attendreServeur } = require('./helpers/app');

describe('Couverture — merge request, projet de session, Jira', () => {
  let app; let repo; let repoId; let mrId; let taskId; let targetId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    // La clé Jira vient de la BRANCHE (feature/PROJ-42-ajout) : le titre n'en porte pas.
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajout de b', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }, {
      // Une seconde MR SANS clé de ticket, ni dans la branche ni dans le titre.
      iid: 8, title: 'Nettoyage', state: 'opened',
      source_branch: 'chore/nettoyage', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/8',
      sha: repo.mainSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }, { new_path: 'db/migration.sql' }];

    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7).id;

    // Un projet de session dont la branche cite un AUTRE ticket : il n'a pas de MR.
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'liens contextuels', targets: [{ repo_id: repoId, branch: 'ai/PROJ-77-liens' }],
    });
    taskId = t.body.id;
    targetId = (await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].id;
  });

  after(async () => { await app.stop(); });

  const mrParIid = async (iid) => (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === iid);

  /* ------------------------------------------------ commits depuis la review ---- */

  test('sans review, il n’y a rien de « depuis la review » : zéro commit, et on le sait', async () => {
    const r = await app.api('GET', `/api/mrs/${mrId}/stale-commits`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { known: true, count: 0, commits: [] });
    assert.ok((await app.api('GET', '/api/mrs/99999/stale-commits')).status >= 400, 'MR inconnue : refusée');
  });

  test('après la review, les commits arrivés sont listés depuis la forge — et l’ignorance est dite', async () => {
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await waitForJobs(app.api);
    assert.equal((await mrParIid(7)).has_review, true, 'préalable : la review a eu lieu');

    // Le code bouge : la forge annonce une nouvelle tête, la découverte la relève.
    const nouveau = pushChange(repo, 'src/app.js', 'const a = 1;\nconst b = 3;\nmodule.exports = { a, b };\n');
    app.state.mrs['grp/app'][0].sha = nouveau;
    app.state.compare['grp/app'] = [{
      id: 'abcdef1234567890abcdef1234567890abcdef12', short_id: 'abcdef12',
      title: 'fix: correction', author_name: 'Bob', committed_date: '2026-09-01T10:00:00.000Z',
    }];
    await app.api('POST', '/api/discover');
    assert.equal((await mrParIid(7)).stale, true, 'préalable : le rapport est périmé');

    const r = await app.api('GET', `/api/mrs/${mrId}/stale-commits`);
    assert.equal(r.status, 200);
    assert.equal(r.body.known, true);
    assert.equal(r.body.count, 1);
    assert.deepEqual(r.body.commits[0], { sha: 'abcdef12', title: 'fix: correction', author: 'Bob', date: '2026-09-01T10:00:00.000Z' });
    // La comparaison a bien été demandée entre le SHA reviewé et la tête courante.
    const appel = app.state.calls.find((c) => c.path.includes('/repository/compare'));
    assert.ok(appel, 'la forge a été interrogée');
    assert.match(appel.path, new RegExp(`from=${repo.branchSha}`));
    assert.match(appel.path, new RegExp(`to=${nouveau}`));

    // Forge injoignable : on ne sait pas, et on le dit — jamais un zéro qui rassure à tort.
    app.state.fail['/repository/compare'] = { status: 500 };
    try {
      const panne = await app.api('GET', `/api/mrs/${mrId}/stale-commits`);
      assert.equal(panne.status, 200, 'la bulle ne casse pas la carte');
      assert.deepEqual(panne.body, { known: false, count: 0, commits: [] });
    } finally { delete app.state.fail['/repository/compare']; }
  });

  /* ------------------------------------------ historique des vérifications ---- */

  test('l’historique des vérifications d’une MR liste ses passages terminés, du plus récent au plus ancien', async () => {
    assert.deepEqual((await app.api('GET', `/api/mrs/${mrId}/verifications/history`)).body, [],
      'jamais vérifiée : historique vide');
    assert.ok((await app.api('GET', '/api/mrs/99999/verifications/history')).status >= 400, 'MR inconnue : refusée');

    const bin = fs.mkdtempSync(path.join(app.dataDir, 'verif-bin-'));
    const script = path.join(bin, 'ok.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const v = await app.api('POST', '/api/verifiers', {
      name: 'hist-vert', kind: 'commands', commands: [script], timeout_s: 60, run_base: false,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(v.status, 200, v.text);

    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.body.id });
    assert.equal(lance.status, 200, lance.text);
    const vid = lance.body.verification.id;
    await attendreServeur(async () => {
      const { body } = await app.api('GET', `/api/verifications/${vid}`);
      return body && ['done', 'error'].includes(body.status);
    }, 'la vérification se termine', 60000);
    await waitForJobs(app.api);

    const hist = (await app.api('GET', `/api/mrs/${mrId}/verifications/history`)).body;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].id, vid);
    assert.equal(hist[0].verifier_id, v.body.id);
    assert.equal(hist[0].verifier_name, 'hist-vert');
    assert.equal(hist[0].verdict, 'verified_pass');
    assert.ok(hist[0].finished_at, 'daté : c’est ce qui fait une tendance');
    assert.ok(hist[0].head_sha, 'le SHA vérifié est gardé — un verdict sans son commit ne dit rien');
    assert.deepEqual(hist[0].failed, [], 'vert : aucun test imputé');

    // L'historique est PAR merge request : celui de l'autre MR reste vide.
    const autre = await mrParIid(8);
    assert.deepEqual((await app.api('GET', `/api/mrs/${autre.id}/verifications/history`)).body, []);
    await app.api('DELETE', `/api/verifiers/${v.body.id}`);
  });

  /* ------------------------------------------------ prévenir Jira (merge) ---- */

  test('prévenir Jira depuis une MR : refusé sans Jira, sinon un commentaire et la transition « en cours »', async () => {
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/notify-jira`)).status, 400, 'Jira non configuré : on le dit');

    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    app.state.calls.length = 0;
    const r = await app.api('POST', `/api/mrs/${mrId}/notify-jira`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.key, 'PROJ-42', 'la clé est relue dans la branche, côté serveur');
    assert.equal(r.body.commented, true);
    assert.equal(r.body.transitioned, true, 'le faux Jira propose « En cours » : on y passe');

    const commentaire = app.state.calls.find((c) => c.method === 'POST' && /\/issue\/PROJ-42\/comment/.test(c.path));
    assert.ok(commentaire, 'un commentaire a été posté sur le ticket');
    assert.match(JSON.stringify(commentaire.body), /merge_requests\/7/, 'le commentaire porte le lien de la MR');
    const transition = app.state.calls.find((c) => c.method === 'POST' && /\/issue\/PROJ-42\/transitions/.test(c.path));
    assert.ok(transition, 'la transition a été demandée');
    assert.equal(String(transition.body.transition.id), '21', 'vers l’état de catégorie « en cours »');

    // Une MR sans clé de ticket ne peut prévenir personne : refus, et aucun appel Jira.
    const sansCle = await mrParIid(8);
    app.state.calls.length = 0;
    assert.equal((await app.api('POST', `/api/mrs/${sansCle.id}/notify-jira`)).status, 400);
    assert.equal(app.state.calls.filter((c) => c.path.startsWith('/rest/api')).length, 0, 'rien n’est parti chez Jira');
    assert.ok((await app.api('POST', '/api/mrs/99999/notify-jira')).status >= 400, 'MR inconnue : refusée');
  });

  test('prévenir Jira avec le gabarit de l’équipe : variables remplacées, inconnue laissée, et un gabarit sans {url} refusé', async () => {
    assert.equal((await app.api('PUT', '/api/config', { jira_notify_template: 'Pas de lien ici' })).status, 400, 'sans {url}, le ticket ne dirait pas laquelle');
    assert.equal((await app.api('GET', '/api/config')).body.jira_notify_template || '', '', 'et rien n’est enregistré');
    assert.equal((await app.api('PUT', '/api/config', { jira_notify_template: '[{key}] MR !{iid} « {title} » ({project}, {branch} → {target}) : {url} {inconnue}' })).status, 200);
    app.state.calls.length = 0;
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/notify-jira`)).status, 200);
    const commentaire = app.state.calls.find((c) => c.method === 'POST' && /\/issue\/PROJ-42\/comment/.test(c.path));
    assert.ok(commentaire, 'un commentaire a été posté');
    const texte = JSON.stringify(commentaire.body);
    assert.match(texte, /\[PROJ-42\] MR !7 « Ajout de b » \(grp\/app, feature\/[^ ]* → main\)/, 'les variables sont remplacées, dont la branche de destination');
    assert.match(texte, /merge_requests\/7/);
    assert.match(texte, /\{inconnue\}/, 'une variable inconnue reste telle quelle');
    await app.api('PUT', '/api/config', { jira_notify_template: '' });
    app.state.calls.length = 0;
    await app.api('POST', `/api/mrs/${mrId}/notify-jira`);
    const parDefaut = app.state.calls.find((c) => c.method === 'POST' && /\/issue\/PROJ-42\/comment/.test(c.path));
    assert.match(JSON.stringify(parDefaut.body), /!7 sur grp\/app|!7 on grp\/app/, 'vide : le message livré');
  });

  /* -------------------------------------- le porteur d'un ticket Jira ---- */

  describe('porteur d’un ticket', () => {
    /* Le dépôt n'est pas écrit dans Jira : le cœur le déduit de ce qui est déjà engagé — la merge request qui porte la clé, sinon la session de codage.
       Rien n'est deviné : sans engagement, pas de porteur, et donc pas de boutons chez le plugin. */
    test('un ticket Jira trouve son dépôt par ce qui est engagé : la MR d’abord, sinon la session', async () => {
      // PROJ-42 : porté par la branche de la MR !7 → le porteur de la MR.
      const viaMr = await app.api('GET', '/api/jira/issues/PROJ-42/carrier');
      assert.equal(viaMr.status, 200, viaMr.text);
      assert.deepEqual(viaMr.body.carrier, { repo_id: repoId, branch: repo.branch, iid: 7 });

      // PROJ-77 : aucune MR, mais une session de codage → le porteur de son projet.
      const viaSession = await app.api('GET', '/api/jira/issues/PROJ-77/carrier');
      assert.equal(viaSession.status, 200, viaSession.text);
      assert.equal(viaSession.body.carrier.repo_id, repoId);
      assert.equal(viaSession.body.carrier.branch, 'ai/PROJ-77-liens');

      // Un ticket que rien n'engage : pas de porteur, et c'est exact — rien n'est deviné.
      const rien = await app.api('GET', '/api/jira/issues/ZZZ-1/carrier');
      assert.equal(rien.status, 200);
      assert.deepEqual(rien.body, { carrier: null });
    });
  });

  /* ------------------------------------------------ session d’agent neuve ---- */

  test('« repartir d’une session neuve » oublie le handle local et la note de session', async () => {
    // eslint-disable-next-line global-require
    const localsession = require('../src/data/localsession');
    const { uid } = app.db.prepare('SELECT uid FROM task_target WHERE id = ?').get(targetId);
    localsession.ecrire('task_target', uid, { session_key: 'sess-abandonnee', session_backend: 'claude' });
    app.db.prepare("UPDATE task_target SET session_note = 'reprise impossible' WHERE id = ?").run(targetId);
    assert.equal(localsession.lire('task_target', uid).session_key, 'sess-abandonnee', 'préalable : un handle existe');

    const r = await app.api('POST', `/api/tasks/${taskId}/targets/${targetId}/forget-session`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(localsession.lire('task_target', uid).session_key, null, 'le prochain run créera une session neuve');
    assert.equal(app.db.prepare('SELECT session_note FROM task_target WHERE id = ?').get(targetId).session_note, null);

    assert.ok((await app.api('POST', `/api/tasks/${taskId}/targets/99999/forget-session`)).status >= 400, 'projet inconnu : refusé');
  });
});
