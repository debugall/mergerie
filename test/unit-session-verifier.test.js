'use strict';
/* Le vérificateur d'une session de dev IA — la DÉCISION, pas l'exécution.
 *
 * Ce qui se joue ici : un vérificateur choisi au lancement doit partir tout seul, une fois, à la
 * fin — et surtout ne PAS partir dans les trois cas où son verdict ne voudrait rien dire. Ces
 * refus sont silencieux pour la session (le code est écrit, la session a réussi) mais dits dans
 * son journal ; les éprouver demande de les distinguer, d'où une fonction qui rend sa raison.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sessverif-'));

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const jobs = require('../src/jobs');

const now = new Date().toISOString();

function decor({ couvre = [1], pousse = true, avecMr = false, verifierId = 1 } = {}) {
  for (const t of ['verifier_repo', 'verifier', 'task_target', 'task', 'mr', 'repo', 'verification']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO repo (id, project, url, enabled) VALUES (1,'grp/a','u',1),(2,'grp/b','u',1)").run();
  db.prepare("INSERT INTO verifier (id, name, command, timeout_s, created_at) VALUES (1,'integ','/bin/true',60,?)").run(now);
  for (const r of couvre) {
    db.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (1, ?, 'worktree')").run(r);
  }
  db.prepare(`INSERT INTO task (id, repo_id, kind, prompt, branch, auto_push, verifier_id, status, created_at, updated_at)
    VALUES (1, 1, 'code', 'p', 'feat/x', 1, ?, 'new', ?, ?)`).run(verifierId, now, now);
  if (avecMr) {
    db.prepare(`INSERT INTO mr (id, repo_id, iid, title, status, updated_at) VALUES (7, 1, 42, 't', 'to_review', ?)`).run(now);
  }
  db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, commit_sha, mr_iid, status)
    VALUES (1, 1, 'feat/x', 'main', ?, ?, 'pushed')`).run(pousse ? 'abc123' : null, avecMr ? 42 : null);
  return db.prepare('SELECT * FROM task WHERE id = 1').get();
}

describe('vérificateur de session : quand il part, et quand il ne part pas', () => {
  beforeEach(() => { db.prepare('DELETE FROM verification').run(); });

  test('aucun vérificateur choisi : rien à décider', () => {
    const d = jobs.preparerVerificationApres(decor({ verifierId: null }));
    assert.deepEqual(d, { raison: null });
  });

  /* SANS COMMIT POUSSÉ, rien à vérifier : un vérificateur travaille sur ce que la forge expose.
     C'est la raison pour laquelle choisir un vérificateur coche l'auto-push. */
  test('rien de poussé : on ne lance pas, et on dit pourquoi', () => {
    const d = jobs.preparerVerificationApres(decor({ pousse: false }));
    assert.equal(d.verifier, undefined);
    assert.match(d.raison, /poussé/);
  });

  /* UN VERT PARTIEL ne dit rien de la moitié du lot — pire qu'une absence de verdict. */
  test('un dépôt non couvert : on ne lance pas', () => {
    const t = decor({ couvre: [2] });
    const d = jobs.preparerVerificationApres(t);
    assert.equal(d.verifier, undefined);
    assert.match(d.raison, /couvre pas/);
  });

  test('couvert et poussé : la cible est prête, avec le mode déclaré par le vérificateur', () => {
    const d = jobs.preparerVerificationApres(decor());
    assert.equal(d.verifier.name, 'integ');
    assert.equal(d.cibles.length, 1);
    assert.deepEqual(
      { ...d.cibles[0], workdir: undefined },
      { repo_id: 1, mr_id: null, head_sha: 'abc123', base_sha: 'origin/main', branch: 'feat/x', mode: 'worktree', workdir: undefined },
    );
  });

  /* Après une convergence, la session a ouvert des MR : le verdict doit s'y rattacher, sinon il
     ne remonterait sur aucune merge request. Sans MR — session sans convergence — la cible tient
     quand même : c'est la branche poussée qu'on vérifie. */
  test('avec une merge request, le verdict s’y rattache', () => {
    const d = jobs.preparerVerificationApres(decor({ avecMr: true }));
    assert.equal(d.cibles[0].mr_id, 7);
  });

  test('un vérificateur supprimé entre-temps ne fait pas échouer la session', () => {
    const t = decor();
    db.prepare('DELETE FROM verifier_repo WHERE verifier_id = 1').run();
    db.prepare('DELETE FROM verifier WHERE id = 1').run();
    const d = jobs.preparerVerificationApres(t);
    assert.match(d.raison, /n’existe plus/);
  });

  // Deux projets sur le même dépôt ne font qu'une cible : le vérificateur monte un
  // environnement par dépôt, pas par branche.
  test('deux projets sur le même dépôt ne donnent qu’une cible', () => {
    const t = decor();
    db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, commit_sha, status)
      VALUES (1, 1, 'feat/y', 'main', 'def456', 'pushed')`).run();
    assert.equal(jobs.preparerVerificationApres(t).cibles.length, 1);
  });
});
