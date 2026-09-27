'use strict';
/* Réparation : une session dont la MR a été mergée SANS passer par `/tasks/.../merge` (mergée
 * directement sur la forge, ou en différé) pouvait perdre tout lien avec cette MR — `mr_iid`
 * jamais posé sur `task_target`, et la découverte qui marque la MR `closed_seen` sans jamais
 * la revoir. Sur une base qui a connu ce trou avant le correctif de `discover.js`, rien ne le
 * refermait tout seul : ce test prouve que `04-sessions.js` le fait au démarrage suivant.
 *
 * `db.js` est un singleton branché sur `MERGERIE_DATA_DIR` au chargement : on seme la base
 * dans un premier processus (son propre `require('./src/db')` ne trouve encore rien à réparer),
 * puis on relit dans un second — un démarrage neuf, comme en production.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.resolve(__dirname, '..');

function surProcessus(dir, code) {
  const sortie = execFileSync(process.execPath, ['-e', `${code}\nprocess.stdout.write('@@' + JSON.stringify(__r));`], {
    cwd: RACINE, stdio: 'pipe', env: { ...process.env, MERGERIE_DATA_DIR: dir },
  }).toString();
  return JSON.parse(sortie.slice(sortie.indexOf('@@') + 2));
}

function semer({ merged = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-mr-link-'));
  surProcessus(dir, `
    const db = require('./src/db');
    db.prepare("INSERT INTO repo (project, url, forge, created_at) VALUES ('grp/app','https://x','gitlab', datetime('now'))").run();
    const repoId = db.prepare("SELECT id FROM repo WHERE project = 'grp/app'").get().id;
    db.prepare("INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at, closed_seen, merged_at) VALUES (?, 42, 'Titre', 'feature/x', 'main', 'to_review', datetime('now'), 1, ${merged ? "datetime('now')" : 'NULL'})").run(repoId);
    db.prepare("INSERT INTO task (repo_id, prompt, branch, status, kind, created_at, updated_at) VALUES (?, 'p', 'feature/x', 'pushed', 'code', datetime('now'), datetime('now'))").run(repoId);
    const taskId = db.prepare('SELECT id FROM task').get().id;
    db.prepare("INSERT INTO task_target (task_id, repo_id, branch, status, updated_at) VALUES (?, ?, 'feature/x', 'pushed', datetime('now'))").run(taskId, repoId);
    var __r = null;
  `);
  return dir;
}

const relire = (dir) => surProcessus(dir, `
  const db = require('./src/db');
  var __r = db.prepare('SELECT mr_iid, mr_merged, mr_conflicts FROM task_target').get();
`);

describe('Migration : le lien MR ↔ session perdu avant le correctif de discover.js', () => {
  /* `semer()` seme la base dans SON PROPRE démarrage (le trou reste ouvert : rien n'a encore
     eu l'occasion de le réparer). `relire()`, un démarrage neuf et séparé, est celui qui répare —
     exactement le redémarrage de l'application après avoir posé ce correctif. */
  test('une MR déjà mergée, jamais rattachée, se relie à sa session au démarrage suivant', () => {
    const dir = semer({ merged: true });
    assert.deepEqual(relire(dir), { mr_iid: 42, mr_merged: 1, mr_conflicts: 0 });
  });

  test('une MR encore ouverte (pas mergée) ne se fait pas inventer un lien', () => {
    const dir = semer({ merged: false });
    assert.deepEqual(relire(dir), { mr_iid: null, mr_merged: 0, mr_conflicts: null },
      'aucune date de merge : rien à réparer, ce n’est pas ce bug-là');
  });

  test('rejouée, la réparation ne touche plus à rien', () => {
    const dir = semer({ merged: true });
    relire(dir); // 1er redémarrage après le correctif : répare
    assert.deepEqual(relire(dir), { mr_iid: 42, mr_merged: 1, mr_conflicts: 0 },
      'le redémarrage suivant laisse le lien déjà posé tel quel');
  });
});
