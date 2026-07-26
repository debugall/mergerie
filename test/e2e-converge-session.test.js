'use strict';
/* « Converger » depuis une session de dev IA — du prompt à la MR convergée, de bout en
   bout (vrais dépôts git locaux, agent en dry-run, faux GitLab). Le NOUVEAU morceau est
   l'amorce : dev IA → commit → push → CRÉE la MR → upsert ciblé → délègue à convergeRun
   (déjà testé par ailleurs). En dry-run, le dev produit une branche à 1 fichier de diff
   → review notée 8/10 par le mock → convergence immédiate (le fond de la boucle est
   couvert par e2e-converge.test.js). On vérifie ici l'amorce et le multi-projet en série. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, git } = require('./helpers/app');

describe('Converger depuis une session de dev IA', () => {
  let app;

  async function addRepo(key, project) {
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `remote-${key}-`)), { branch: `feature/${key}` });
    app.state.mrs[project] = app.state.mrs[project] || [];
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project })).body.id;
    return { repo, repoId, project };
  }

  before(async () => {
    app = await startApp();
    await app.configure({ review_explain: '0', converge_threshold: '8', converge_max_passes: '3' });
  });

  after(async () => { await app.stop(); });

  test('mono-projet : dev → push → crée la MR → review → convergé', async () => {
    const { repo, repoId, project } = await addRepo('mono', 'grp/mono');

    // Session de codage sur une branche NEUVE (l'IA la crée depuis main).
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un endpoint /health',
      targets: [{ repo_id: repoId, branch: 'ai/health', base_branch: 'main' }],
    })).body;

    // Converger : seuil 8. Le dev dry-run produit une branche à 1 fichier → review 8/10 → convergé d'emblée.
    const job = await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    assert.equal(job.body.kind, 'converge-session');
    await waitForJobs(app.api);

    // La branche a été CRÉÉE et POUSSÉE sur le dépôt distant.
    assert.doesNotThrow(() => git(repo.bare, ['rev-parse', 'ai/health']), 'la branche ai/health existe sur origin');

    // Une MR a été créée et rattachée au projet de la session.
    const tg = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.ok(tg.mr_iid, 'une MR a été ouverte pour la session');

    // La MR est en base, reviewée, et sa convergence est enregistrée.
    const mrRow = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === project && m.source_branch === 'ai/health');
    assert.ok(mrRow, 'la MR créée est upsertée dans la liste');
    const detail = (await app.api('GET', `/api/mrs/${mrRow.id}`)).body;
    assert.equal(detail.mr.iid, tg.mr_iid);
    assert.ok(detail.convergence, 'une run de convergence existe');
    assert.equal(detail.convergence.status, 'converged');
    assert.equal(detail.convergence.passes_done, 0, 'déjà au seuil : aucune correction');
    assert.equal(detail.convergence.best_note, 8);
  });

  test('converge avec questions : le dev pose une question → en attente, pas de MR ; réponses → reprise', async () => {
    const { repo, repoId } = await addRepo('ask', 'grp/ask');
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un retry', ask_questions: true,
      targets: [{ repo_id: repoId, branch: 'ai/ask', base_branch: 'main' }],
    })).body;

    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    await waitForJobs(app.api);

    // Le dev IA a posé des questions : la session est EN ATTENTE, aucune MR n'a été créée,
    // la branche n'est pas poussée (la convergence ne démarre pas).
    let tg = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.equal(tg.status, 'needs_input', 'la convergence attend les réponses');
    assert.ok(!tg.mr_iid, 'aucune MR tant que la question n’est pas répondue');
    assert.equal(tg.questions.length, 2);
    assert.throws(() => git(repo.bare, ['rev-parse', 'ai/ask']), 'la branche n’est pas poussée');

    // Réponses → reprise (commit), puis on peut relancer Converger.
    await app.api('POST', `/api/tasks/${task.id}/targets/${tg.id}/answer`, { answers: { q1: 'decorator', q2: 'Non' } });
    await waitForJobs(app.api);
    tg = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.equal(tg.status, 'committed', 'après réponses, le dev aboutit');

    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    await waitForJobs(app.api);
    tg = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.ok(tg.mr_iid, 'la convergence relancée crée la MR');
  });

  test('multi-projet : une MR convergée PAR projet, en série', async () => {
    const a = await addRepo('multiA', 'grp/multiA');
    const b = await addRepo('multiB', 'grp/multiB');

    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un logger structuré',
      targets: [
        { repo_id: a.repoId, branch: 'ai/logger', base_branch: 'main' },
        { repo_id: b.repoId, branch: 'ai/logger', base_branch: 'main' },
      ],
    })).body;

    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    await waitForJobs(app.api);

    // Chaque projet : branche poussée + MR ouverte + convergence enregistrée.
    for (const p of [a, b]) {
      assert.doesNotThrow(() => git(p.repo.bare, ['rev-parse', 'ai/logger']), `${p.project} : branche poussée`);
      const mrRow = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === p.project && m.source_branch === 'ai/logger');
      assert.ok(mrRow, `${p.project} : MR upsertée`);
      const detail = (await app.api('GET', `/api/mrs/${mrRow.id}`)).body;
      assert.equal(detail.convergence.status, 'converged', `${p.project} : convergé`);
    }

    // Les deux projets de la session portent chacun leur MR.
    const targets = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets;
    assert.equal(targets.length, 2);
    assert.ok(targets.every((tg) => tg.mr_iid), 'chaque projet a sa MR');
  });

  test('une session déjà exécutée n’est PAS recodée : la MR existante est convergée directement', async () => {
    const { repo, repoId, project } = await addRepo('reuse', 'grp/reuse');
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un cache', auto_push: true,
      targets: [{ repo_id: repoId, branch: 'ai/cache', base_branch: 'main' }],
    })).body;

    // 1) on exécute d'abord la session normalement (code + push), puis on crée la MR.
    await app.api('POST', `/api/tasks/${task.id}/run`);
    await waitForJobs(app.api);
    const tg0 = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.equal(tg0.status, 'pushed');
    const shaAvant = git(repo.bare, ['rev-parse', 'ai/cache']).trim();
    await app.api('POST', `/api/tasks/${task.id}/targets/${tg0.id}/mr`);
    const iidAvant = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0].mr_iid;
    assert.ok(iidAvant);

    // 2) Converger : ne doit NI recoder NI créer une 2e MR — juste converger l'existante.
    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    await waitForJobs(app.api);

    assert.equal(git(repo.bare, ['rev-parse', 'ai/cache']).trim(), shaAvant, 'aucun nouveau commit de dev (pas de recodage)');
    const iidApres = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0].mr_iid;
    assert.equal(iidApres, iidAvant, 'la MR existante est réutilisée (pas de doublon)');
    const mrRow = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === project && m.source_branch === 'ai/cache');
    assert.equal((await app.api('GET', `/api/mrs/${mrRow.id}`)).body.convergence.status, 'converged');
  });

  test('MR ouverte à la main sur GitLab : rattachée, pas de 2e création (409)', async () => {
    const { repo, repoId, project } = await addRepo('manual', 'grp/manual');
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un health check', auto_push: true,
      targets: [{ repo_id: repoId, branch: 'ai/manual', base_branch: 'main' }],
    })).body;

    // 1) la session code et pousse la branche, SANS créer de MR depuis l'app.
    await app.api('POST', `/api/tasks/${task.id}/run`);
    await waitForJobs(app.api);
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0].status, 'pushed');

    // 2) quelqu'un ouvre la MR à la main sur GitLab, et discover la ramasse : la ligne
    //    `mr` existe alors que task_target.mr_iid est toujours NULL.
    app.state.mrs[project].push({
      iid: 4242, title: 'MR ouverte à la main', state: 'opened',
      source_branch: 'ai/manual', target_branch: 'main',
      web_url: `https://gitlab.test/${project}/-/merge_requests/4242`,
      sha: git(repo.bare, ['rev-parse', 'ai/manual']).trim(),
      created_at: new Date().toISOString(), author: { name: 'Humain' },
    });
    await app.api('POST', '/api/discover');
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0].mr_iid, null);

    // 3) Converger : la MR existante est RATTACHÉE (pas de création → pas de 409).
    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    const job = await waitForJobs(app.api);

    const tg = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets[0];
    assert.equal(tg.mr_iid, 4242, 'la MR ouverte à la main est rattachée au projet');
    assert.equal(tg.status, 'pushed', 'le projet converge au lieu de partir en erreur');
    assert.equal(job.status, 'done');
    const opened = app.state.mrs[project].filter((m) => m.source_branch === 'ai/manual');
    assert.equal(opened.length, 1, 'aucune MR en double créée sur GitLab');
    const mrRow = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === project && m.source_branch === 'ai/manual');
    assert.equal((await app.api('GET', `/api/mrs/${mrRow.id}`)).body.convergence.status, 'converged');
  });

  test('MR de session : projets liés par défaut du dépôt recopiés (contexte de review)', async () => {
    const { repoId, project } = await addRepo('ctxMain', 'grp/ctxMain');
    const lib = await addRepo('ctxLib', 'grp/ctxLib');
    // Le dépôt déclare un projet lié par défaut : toute MR neuve doit en hériter.
    await app.api('POST', `/api/repos/${repoId}/links`, { links: [{ repo_id: lib.repoId, branch: 'main' }] });

    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un client HTTP',
      targets: [{ repo_id: repoId, branch: 'ai/ctx', base_branch: 'main' }],
    })).body;
    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    await waitForJobs(app.api);

    const mrRow = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === project && m.source_branch === 'ai/ctx');
    assert.ok(mrRow, 'la MR de session est en base');
    const links = (await app.api('GET', `/api/mrs/${mrRow.id}`)).body.links;
    assert.deepEqual(links.map((l) => l.project), ['grp/ctxLib'], 'la MR hérite des projets liés du dépôt');
  });

  test('un projet en échec n’interrompt pas les suivants ; tout en échec ⇒ job en erreur', async () => {
    // Dépôt volontairement injoignable : le clone git échoue → CE projet part en erreur.
    const brokenId = (await app.api('POST', '/api/repos', {
      url: path.join(app.dataDir, 'nexiste-pas.git'), project: 'grp/broken',
    })).body.id;
    const ok = await addRepo('survivor', 'grp/survivor');

    // Projet cassé EN PREMIER (ordre = tt.id) : le suivant doit quand même converger.
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un retry',
      targets: [
        { repo_id: brokenId, branch: 'ai/retry', base_branch: 'main' },
        { repo_id: ok.repoId, branch: 'ai/retry', base_branch: 'main' },
      ],
    })).body;
    await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    const job = await waitForJobs(app.api);

    const targets = (await app.api('GET', `/api/tasks/${task.id}`)).body.task.targets;
    const broken = targets.find((tg) => tg.repo_id === brokenId);
    const survivor = targets.find((tg) => tg.repo_id === ok.repoId);
    assert.equal(broken.status, 'error', 'le projet injoignable est en erreur');
    assert.ok(broken.last_error, 'son erreur est consignée sur SA ligne');
    assert.equal(survivor.status, 'pushed', 'le projet suivant a bien été traité');
    assert.ok(survivor.mr_iid, 'le projet suivant a sa MR');
    // Au moins un projet a convergé : le job n'est pas en erreur.
    assert.equal(job.status, 'done');

    // Session dont TOUS les projets échouent : le job doit le DIRE (pas « ✅ terminé »).
    const doomed = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un retry',
      targets: [{ repo_id: brokenId, branch: 'ai/doomed', base_branch: 'main' }],
    })).body;
    await app.api('POST', `/api/tasks/${doomed.id}/converge`, { threshold: 8 });
    const failedJob = await waitForJobs(app.api);
    assert.equal(failedJob.status, 'error', 'échec total ⇒ job en erreur');
    assert.equal((await app.api('GET', `/api/tasks/${doomed.id}`)).body.task.status, 'error');
  });

  test('convergence refusée sur une session d’exploration', async () => {
    const { repoId } = await addRepo('explore', 'grp/explore');
    const task = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Comment marche le cache ?',
      targets: [{ repo_id: repoId, branch: 'main' }],
    })).body;
    const res = await app.api('POST', `/api/tasks/${task.id}/converge`, { threshold: 8 });
    assert.equal(res.status, 400);
  });
});
