'use strict';
/* LANCER PLUS TARD — le tick qui honore une date.
 *
 * Trois choses doivent être exactes, et aucune ne se voit à l'écran :
 *   — la date est REFUSÉE quand elle est passée ou illisible, jamais « arrondie à maintenant » ;
 *   — une programmation part UNE fois : effacée avant le lancement, un second tick ne la
 *     retrouve pas, et un lancement refusé ne la fait pas revenir chaque minute ;
 *   — un suivi programmé part sans la case « automatiquement », et un suivi sans texte ne
 *     lance rien.
 * Le test manipule le TEMPS explicitement : attendre la minute serait un pari sur l'horloge.
 * Les exécutants sont REMPLACÉS par des stubs inscrits au registre : on éprouve ce qui est mis
 * en file, pas l'agent. */

const { test, describe, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'programmation-'));
process.env.MERGERIE_DATA_DIR = tmp;

// eslint-disable-next-line import/order
const db = require('../src/db');
// eslint-disable-next-line import/order
const file = require('../src/jobs/file');
// eslint-disable-next-line import/order
const programmation = require('../src/jobs/programmation');
// eslint-disable-next-line import/order
const { pref } = require('../src/data/localstate');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const NOW = new Date('2030-03-10T09:00:00');
const PLUS_TARD = new Date('2030-03-10T10:30:00');
const iso = (d) => d.toISOString();
const uidDe = (table, id) => db.prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(id).uid;
const dernierJob = () => db.prepare('SELECT * FROM job ORDER BY id DESC LIMIT 1').get();
const nbJobs = () => db.prepare('SELECT COUNT(*) c FROM job').get().c;

let repoId; let taskId; let localId;
before(() => {
  // Les exécutants ne tournent pas ici : un stub par sorte, pour que la file ne casse pas.
  file.enregistrer('task', async () => {});
  file.enregistrer('local', async () => {});
  repoId = db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/api','https://x/a.git',1,'gitlab')").run().lastInsertRowid;
  taskId = db.prepare(`INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, created_at, updated_at)
    VALUES (?, 'faire', 'ai/x', 'main', 'new', 'code', ?, ?)`).run(repoId, iso(NOW), iso(NOW)).lastInsertRowid;
  db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, repoId, 'ai/x', 'main', 'new', iso(NOW));
  localId = db.prepare("INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES ('faire', 'new', ?, ?)")
    .run(iso(NOW), iso(NOW)).lastInsertRowid;
  db.prepare("INSERT INTO local_task_dir (task_id, path, status, updated_at) VALUES (?, '/tmp/x', 'new', ?)").run(localId, iso(NOW));
});

describe('programmation : la date', () => {
  test('une date passée ou illisible est refusée, pas interprétée', () => {
    for (const mauvaise of ['', 'demain', '2030-03-10T08:59', iso(NOW)]) {
      assert.throws(() => programmation.lireDate(mauvaise, NOW), (e) => e.status === 400, mauvaise);
    }
  });
  test('une date à venir est gardée en ISO, à la minute', () => {
    assert.equal(programmation.lireDate('2030-03-10T10:30:45', NOW), iso(PLUS_TARD));
  });
  test('programmer pose, relit, efface', () => {
    const uid = uidDe('task', taskId);
    assert.equal(programmation.programmer('task', uid, 'run', iso(PLUS_TARD), NOW), iso(PLUS_TARD));
    assert.deepEqual(programmation.lire('task', uid), { scheduled_at: iso(PLUS_TARD), followup_at: null });
    assert.equal(programmation.cartes('task').run.get(uid), iso(PLUS_TARD));
    assert.equal(programmation.programmer('task', uid, 'run', null), null);
    assert.deepEqual(programmation.lire('task', uid), { scheduled_at: null, followup_at: null });
  });
  test('une table ou un geste inconnus sont refusés', () => {
    assert.throws(() => programmation.programmer('question', 'x', 'run', iso(PLUS_TARD), NOW), /table inconnue/);
    assert.throws(() => programmation.programmer('task', 'x', 'converge', iso(PLUS_TARD), NOW), /geste inconnu/);
  });
});

describe('programmation : le tick', () => {
  test('une session de codage due part une fois, et sa date s’efface', () => {
    const uid = uidDe('task', taskId);
    programmation.programmer('task', uid, 'run', iso(PLUS_TARD), NOW);
    assert.equal(programmation.dus(NOW).length, 0, 'pas encore due');
    assert.equal(programmation.tick(NOW).length, 0);
    const journal = [];
    const lances = programmation.tick(PLUS_TARD, (m) => journal.push(m));
    assert.equal(lances.length, 1);
    assert.equal(lances[0].id, taskId);
    const job = dernierJob();
    assert.equal(job.kind, 'task');
    assert.equal(job.target_kind, 'task');
    assert.equal(job.target_id, taskId);
    assert.equal(JSON.parse(job.retry).action, 'run');
    assert.equal(programmation.lire('task', uid).scheduled_at, null, 'la date est partie avec le lancement');
    assert.match(journal.join('\n'), /task #\d+/);
    // Un second tick, même bien plus tard, ne relance rien.
    const avant = nbJobs();
    assert.equal(programmation.tick(new Date('2031-01-01T00:00:00')).length, 0);
    assert.equal(nbJobs(), avant);
  });

  test('une session hors dépôt due part par la file « local »', () => {
    const uid = uidDe('local_task', localId);
    programmation.programmer('local_task', uid, 'run', iso(PLUS_TARD), NOW);
    const lances = programmation.tick(PLUS_TARD);
    assert.equal(lances.length, 1);
    assert.equal(dernierJob().kind, 'local');
    assert.equal(dernierJob().target_id, localId);
    assert.equal(programmation.lire('local_task', uid).scheduled_at, null);
  });

  test('un suivi programmé part sans la case « automatiquement », et emporte son texte', () => {
    const uid = uidDe('task', taskId);
    db.prepare('UPDATE task SET followup_draft = ?, followup_auto = 0 WHERE id = ?').run('Ajoute des tests', taskId);
    programmation.programmer('task', uid, 'followup', iso(PLUS_TARD), NOW);
    const lances = programmation.tick(PLUS_TARD);
    assert.equal(lances.length, 1);
    const job = dernierJob();
    assert.equal(job.kind, 'task');
    assert.equal(JSON.parse(job.retry).action, 'followup');
    assert.equal(JSON.parse(job.retry).opts.instruction, 'Ajoute des tests');
    assert.equal(db.prepare('SELECT followup_draft FROM task WHERE id = ?').get(taskId).followup_draft, null, 'le suivi est parti : plus de brouillon');
    assert.equal(programmation.lire('task', uid).followup_at, null);
  });

  test('un suivi programmé SANS texte ne lance rien, et le dit', () => {
    const uid = uidDe('task', taskId);
    programmation.programmer('task', uid, 'followup', iso(PLUS_TARD), NOW);
    const avant = nbJobs();
    const journal = [];
    assert.equal(programmation.tick(PLUS_TARD, (m) => journal.push(m)).length, 0);
    assert.equal(nbJobs(), avant);
    assert.equal(programmation.lire('task', uid).followup_at, null, 'la date ne revient pas à chaque minute');
    assert.equal(journal.length, 1);
  });

  test('une session supprimée entre-temps oublie sa date sans rien lancer', () => {
    pref.ecrire('task', 'uid-qui-n-existe-plus', programmation.CLES.run, iso(PLUS_TARD));
    const avant = nbJobs();
    const journal = [];
    assert.equal(programmation.tick(PLUS_TARD, (m) => journal.push(m)).length, 0);
    assert.equal(nbJobs(), avant);
    assert.equal(pref.lire('task', 'uid-qui-n-existe-plus', programmation.CLES.run), null);
    assert.match(journal.join('\n'), /uid-qui-n-existe-plus/);
  });

  test('lister rend tout ce qui attend, dans l’ordre des dates', () => {
    const uidT = uidDe('task', taskId); const uidL = uidDe('local_task', localId);
    programmation.programmer('task', uidT, 'run', '2030-03-12T07:00:00', NOW);
    programmation.programmer('local_task', uidL, 'followup', '2030-03-11T07:00:00', NOW);
    assert.deepEqual(programmation.lister().map((p) => [p.kind, p.quoi]), [['local_task', 'followup'], ['task', 'run']]);
    programmation.programmer('task', uidT, 'run', null);
    programmation.programmer('local_task', uidL, 'followup', null);
    assert.equal(programmation.lister().length, 0);
  });

  test('demarrer / arreter : un minuteur qui ne retient pas le process', () => {
    const m = programmation.demarrer();
    assert.ok(m);
    programmation.arreter();
    programmation.arreter();   // idempotent
  });
});
