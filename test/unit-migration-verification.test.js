'use strict';
/* Migration de la table `verification` vers le rapport-ARCHIVE (plan_add_verify.md §2).
 *
 * Les premières bases portaient des clés étrangères BLOQUANTES vers `verifier` et `lot` :
 * supprimer un vérificateur qui avait déjà rendu un verdict échouait. SQLite ne sait pas
 * modifier une contrainte — il faut rebâtir la table, et ce genre de migration ne se relit pas,
 * ça s'exécute. D'où ce test sur une VRAIE vieille base.
 *
 * `db.js` est un singleton branché sur `MERGERIE_DATA_DIR` au chargement : la migration est
 * donc jouée dans un processus fils, seul moyen de choisir le répertoire de données.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.resolve(__dirname, '..');

// Le schéma tel qu'il était AVANT : `verifier_id` NOT NULL, aucune colonne de nom recopié.
const ANCIEN = `
CREATE TABLE repo (id INTEGER PRIMARY KEY, project TEXT NOT NULL, url TEXT NOT NULL,
  branch_pattern TEXT, enabled INTEGER, created_at TEXT);
CREATE TABLE verifier (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, command TEXT NOT NULL,
  timeout_s INTEGER NOT NULL DEFAULT 900, run_base INTEGER NOT NULL DEFAULT 1,
  comment_on_forge INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE lot (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mr','session')), created_at TEXT NOT NULL);
CREATE TABLE verification (id INTEGER PRIMARY KEY,
  verifier_id INTEGER NOT NULL REFERENCES verifier(id),
  lot_id INTEGER REFERENCES lot(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  verdict TEXT, targets_json TEXT NOT NULL, context_json TEXT, base_run_json TEXT,
  head_run_json TEXT, imputable_json TEXT, log_excerpt TEXT,
  started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, restore_error TEXT);`;

describe('Migration : un rapport de vérification est une archive', () => {
  test('les noms sont recopiés, et supprimer le vérificateur ne casse plus rien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-verif-'));
    const bdd = path.join(dir, 'reviewer.db');

    const semer = `
      const db = require('better-sqlite3')(${JSON.stringify(bdd)});
      db.exec(${JSON.stringify(ANCIEN)});
      db.prepare('INSERT INTO verifier (id,name,command,created_at) VALUES (7,?,?,?)').run('integ', '/bin/x', 'now');
      db.prepare('INSERT INTO lot (id,name,kind,created_at) VALUES (3,?,?,?)').run('sortie 2.4', 'mr', 'now');
      db.prepare("INSERT INTO verification (id,verifier_id,lot_id,status,verdict,targets_json,created_at) VALUES (1,7,3,'done','verified_fail','[]','now')").run();`;
    execFileSync(process.execPath, ['-e', semer], { cwd: RACINE, stdio: 'pipe' });

    // Charger db.js JOUE la migration ; on observe ensuite ce qu'elle a laissé.
    const verifier = `
      const db = require('./src/db');
      const avant = db.prepare('SELECT * FROM verification WHERE id = 1').get();
      db.prepare('DELETE FROM verifier WHERE id = 7').run();
      db.prepare('DELETE FROM lot WHERE id = 3').run();
      const apres = db.prepare('SELECT * FROM verification WHERE id = 1').get();
      process.stdout.write('@@' + JSON.stringify({ avant, apres }));`;
    const sortie = execFileSync(process.execPath, ['-e', verifier], {
      cwd: RACINE, stdio: 'pipe', env: { ...process.env, MERGERIE_DATA_DIR: dir },
    }).toString();
    const { avant, apres } = JSON.parse(sortie.slice(sortie.indexOf('@@') + 2));

    // Le nom est repris des lignes encore présentes : l'historique reste lisible.
    assert.equal(avant.verifier_name, 'integ');
    assert.equal(avant.lot_name, 'sortie 2.4');
    assert.equal(avant.verdict, 'verified_fail', 'la migration ne perd rien de ce qui existait');

    assert.ok(apres, 'le rapport survit à la suppression de son vérificateur ET de son lot');
    assert.equal(apres.verifier_id, null, 'la clé se détache au lieu de bloquer la suppression');
    assert.equal(apres.lot_id, null);
    assert.equal(apres.verifier_name, 'integ', '…et le nom archivé reste, lui');
    assert.equal(apres.lot_name, 'sortie 2.4');
  });
});
