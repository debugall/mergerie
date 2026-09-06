'use strict';
/* REPARTIR APRÈS UN ARRÊT DU SERVEUR — la sortie de l'impasse.
 *
 * Au chargement de la base, tout job resté « running » devient `interrupted` : le processus
 * est mort avec le serveur, il ne reviendra pas. Mais le job n'était que le PORTEUR. La
 * session de codage, la tâche hors dépôt ou la vérification qu'il faisait tourner restaient,
 * elles, « running » — pour toujours. Et l'écran n'offre « Relancer » que sur `new`, `error`,
 * `committed` ou `pushed` : la carte n'avait plus aucun bouton, ni pour repartir, ni pour
 * s'arrêter, puisque le job à arrêter n'existait plus. L'outil se bloquait tout seul en
 * s'arrêtant au mauvais moment, et rien à l'écran ne disait comment en sortir.
 *
 * Deux choses se prouvent ici :
 *   1. ce qui a été coupé revient dans un état d'où l'on peut repartir, avec la RAISON — et
 *      sans effacer le travail qui, lui, avait abouti (commité, poussé) ;
 *   2. le job coupé est rejouable, alors que `canRetry` ne connaissait que `stopped` et
 *      `error` — le seul job qu'on n'avait pas choisi d'arrêter était le seul irrécupérable.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Reprise après un arrêt du serveur', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app.git' })).body.id;
  });
  after(async () => { await app.stop(); });

  /** Une session de codage figée « en cours », comme un arrêt brutal la laisse. */
  function sessionCoupee(statutsCibles) {
    const now = new Date().toISOString();
    const t = app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'refonte', 'feat/x', 'running', ?, ?)`).run(repoId, now, now);
    for (const st of statutsCibles) {
      app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, status, updated_at)
        VALUES (?,?,?,?,?)`).run(t.lastInsertRowid, repoId, 'feat/x', st, now);
    }
    return Number(t.lastInsertRowid);
  }
  const task = (id) => app.db.prepare('SELECT * FROM task WHERE id = ?').get(id);
  const cibles = (id) => app.db.prepare('SELECT status, last_error FROM task_target WHERE task_id = ? ORDER BY id').all(id);

  test('une session figée « en cours » redevient relançable, avec la raison', () => {
    const id = sessionCoupee(['running']);
    const repris = app.db.reconcilierTravauxCoupes('serveur arrêté');
    assert.ok(repris.sessions >= 1, 'la reprise doit compter ce qu’elle a repris');

    const t = task(id);
    assert.equal(t.status, 'error', '« error » est l’état d’où l’écran propose « Relancer »');
    assert.equal(t.last_error, 'serveur arrêté',
      'sans raison, on croit que l’IA a échoué alors que c’est le serveur qui s’est arrêté');
    assert.deepEqual(cibles(id).map((c) => c.status), ['error']);
  });

  test('le travail DÉJÀ abouti n’est pas effacé au passage', () => {
    // Un projet poussé avant la coupure reste poussé : sa merge request existe, elle.
    const id = sessionCoupee(['running', 'pushed', 'committed']);
    app.db.reconcilierTravauxCoupes('serveur arrêté');
    assert.deepEqual(cibles(id).map((c) => c.status), ['error', 'pushed', 'committed']);
  });

  test('rien à reprendre : la reprise ne touche à rien et ne compte rien', () => {
    const id = sessionCoupee(['pushed']);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(id);
    const repris = app.db.reconcilierTravauxCoupes('serveur arrêté');
    assert.equal(repris.sessions, 0);
    assert.equal(task(id).status, 'pushed');
    assert.equal(task(id).last_error, null, 'une session aboutie ne doit pas hériter d’un message d’erreur');
  });

  test('une vérification coupée repart avec un verdict, pas dans le vide', () => {
    const now = new Date().toISOString();
    const v = app.db.prepare(`INSERT INTO verification (verifier_name, status, targets_json, created_at, started_at)
      VALUES ('integ', 'running', '[]', ?, ?)`).run(now, now);
    app.db.reconcilierTravauxCoupes('serveur arrêté');
    const ligne = app.db.prepare('SELECT * FROM verification WHERE id = ?').get(v.lastInsertRowid);
    assert.equal(ligne.status, 'error');
    assert.equal(ligne.verdict, 'verify_error', 'c’est ce verdict qui rend la relance possible');
  });

  /* ------------------------------------------------------- le job, lui aussi ---- */

  test('un job coupé par l’arrêt est REJOUABLE', async () => {
    const now = new Date().toISOString();
    const j = app.db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at, retry)
      VALUES ('review', 'interrupted', 1, 0, '', ?, ?)`)
      .run(now, JSON.stringify({ fn: 'kind', kind: 'review', mrIds: [], opts: {} }));
    const { body } = await app.api('GET', `/api/jobs/${j.lastInsertRowid}/log`);
    assert.equal(body.can_retry, true,
      'le seul job qu’on n’a PAS choisi d’arrêter ne peut pas être le seul irrécupérable');
  });

  test('un job coupé sans intention connue reste non rejouable — on n’invente pas', async () => {
    const now = new Date().toISOString();
    const j = app.db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
      VALUES ('review', 'interrupted', 1, 0, '', ?)`).run(now);
    const { body } = await app.api('GET', `/api/jobs/${j.lastInsertRowid}/log`);
    assert.equal(body.can_retry, false, 'sans `retry`, on ne sait pas quoi relancer');
  });

  test('le statut « interrompu » est traduit dans les deux langues', () => {
    const I18N = require('../public/i18n.js');
    for (const langue of ['fr', 'en']) {
      assert.ok(I18N[langue]['job.status.interrupted'],
        `job.status.interrupted manque en ${langue} — le panneau afficherait le mot brut`);
    }
  });
});
