'use strict';
/* CE QUE GIT A LAISSÉ EN PLAN ENTRE DANS LE BRIEF ET LES STATISTIQUES (B14/B15).
 *
 * Un merge laissé à moitié et une opération en échec sont ce que le brief doit rappeler le matin ; les opérations git entrent aussi dans Statistiques, parce que
 * ce qui sert n'est pas le volume mais le RAPPORT. (La fin d'un build Jenkins lancé d'ici a sa veille dans le plugin Jenkins, la chute d'un conteneur dans le plugin
 * Docker : chacune est testée chez son plugin.)
 *
 * Un seul `startApp()` pour tout le fichier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Le brief et les statistiques — ce que Git a laissé', () => {
  let app;

  before(async () => {
    app = await startApp();
    await app.configure();
  });
  after(async () => { if (app) await app.stop(); });

  test('un merge laissé à moitié et une opération en échec entrent dans le brief', async () => {
    const d = app.db;
    const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/veille','http://v',datetime('now'))").run().lastInsertRowid;
    d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
      VALUES (?, 'main', 'feature/x', '/tmp/w', 'conflict', datetime('now'), datetime('now'))`).run(repoId);
    d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
      VALUES (?, 'main', 'feature/fini', '/tmp/w2', 'pushed', datetime('now'), datetime('now'))`).run(repoId);
    d.prepare(`INSERT INTO git_op (batch_id, created_at, action, repo_id, project, ref_name, status, error)
      VALUES ('lot-1', datetime('now'), 'delete_branch', ?, 'grp/veille', 'old/1', 'error', 'protected branch')`).run(repoId);

    const b = (await app.api('GET', '/api/brief')).body;
    const merges = (b.git || []).filter((g) => g.kind === 'merge');
    assert.equal(merges.length, 1, 'un merge poussé est fini : il n’attend plus rien');
    assert.equal(merges[0].status, 'conflict');
    const ops = (b.git || []).filter((g) => g.kind === 'op');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].batch_id, 'lot-1', 'les échecs sont groupés par lot, comme dans l’historique');
  });

  /* B14 — et la dernière table de trace que Statistiques ignorait. Ce qui sert n'est pas le
     volume mais le RAPPORT : dix suppressions dont quatre refusées ne racontent pas la même
     chose que trente sans un échec. */
  test('les opérations git entrent dans les statistiques', async () => {
    const d = app.db;
    d.prepare(`INSERT INTO git_op (batch_id, created_at, action, project, ref_name, status)
      VALUES ('lot-2', datetime('now'), 'create_tag', 'grp/veille', 'v1.0', 'done')`).run();
    const g = (await app.api('GET', '/api/stats')).body.gitOps;
    assert.ok(g.total >= 2, `total : ${g.total}`);
    assert.ok(g.errors >= 1, 'l’échec du lot précédent est compté');
    const supp = g.byAction.find((a) => a.action === 'delete_branch');
    assert.ok(supp && supp.errors === supp.n, 'la suppression a échoué autant de fois qu’elle a été tentée');
  });
});
