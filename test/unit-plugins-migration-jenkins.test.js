'use strict';
/* LA MONTÉE DE VERSION NE PERD RIEN. Un poste qui tournait avec Jenkins dans le cœur porte
 * quatre colonnes de réglages, une table de jobs liés et le souvenir d'un test de connexion.
 * Après la montée de version, tout cela doit être dans le plugin — l'URL, le compte, le jeton,
 * la cadence, les jobs liés, le dernier test — et les colonnes du cœur doivent avoir disparu.
 *
 * On ne garde pas une vieille base dans le dépôt : on fabrique une base NEUVE avec le schéma
 * du jour, puis on la RAMÈNE à la forme d'avant (les colonnes et la table de l'ancien schéma,
 * remplies, et le marqueur de migration retiré), et on rejoue le schéma dans un processus
 * frais. C'est exactement ce que voit la migration sur une base montée de version. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
/* Le schéma, et des instructions jouées sur SA connexion (les déclencheurs du cœur appellent des
   fonctions SQL qu'elle seule enregistre) — dans un processus frais, comme un démarrage. Les
   instructions passent par un fichier, une par ligne. */
function ouvrirSchema(dir, instructions = []) {
  const sqlFile = path.join(dir, 'retrofit.sql');
  fs.writeFileSync(sqlFile, instructions.join('\n'));
  execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'schema-sql.js')], { cwd: ROOT, env: { ...process.env, MERGERIE_DATA_DIR: dir, SQL_FILE: sqlFile }, stdio: 'pipe' });
}

describe('Plugins — migration des données Jenkins du cœur vers le plugin', () => {
  test('URL, compte, jeton, cadence, jobs liés et dernier test passent au plugin ; les colonnes du cœur s’en vont', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-migr-jk-'));
    // La forme d'AVANT : les colonnes, la table, le souvenir — remplis comme sur un vrai poste.
    ouvrirSchema(dir, [
      "ALTER TABLE config ADD COLUMN jenkins_url TEXT DEFAULT ''",
      "ALTER TABLE local_config ADD COLUMN jenkins_user TEXT DEFAULT ''",
      "ALTER TABLE local_config ADD COLUMN jenkins_token TEXT DEFAULT ''",
      'ALTER TABLE local_config ADD COLUMN jenkins_refresh_minutes INTEGER DEFAULT 1',
      'CREATE TABLE repo_jenkins (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE, job_path TEXT NOT NULL, param TEXT, uid TEXT, UNIQUE(repo_id, job_path))',
      "INSERT INTO repo (id, project, url, forge, enabled, created_at) VALUES (1, 'grp/app', 'https://gl.test/grp/app.git', 'gitlab', 1, datetime('now'))",
      "INSERT INTO repo_jenkins (repo_id, job_path, param) VALUES (1, 'boutique/deploy', 'BRANCH')",
      "INSERT INTO repo_jenkins (repo_id, job_path, param) VALUES (1, 'boutique/build', NULL)",
      "UPDATE config SET jenkins_url = 'https://jenkins.equipe.test/' WHERE id = 1",
      "UPDATE local_config SET jenkins_user = 'moi', jenkins_token = 'jk-SECRET-DAVANT', jenkins_refresh_minutes = 7 WHERE id = 1",
      "INSERT INTO conn_test (service, ok, detail, tested_at) VALUES ('jenkins', 1, 'moi · 12', '2026-09-30T10:00:00.000Z')",
      "DELETE FROM plugin_migration WHERE plugin = '_core'",
      'DROP TABLE IF EXISTS plugin_jenkins_link',
    ]);
    const repoId = 1;
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3');
    let db;

    ouvrirSchema(dir);   // la montée de version
    db = new Database(path.join(dir, 'reviewer.db'), { readonly: true });
    const reglage = (k) => { const r = db.prepare("SELECT value FROM plugin_setting WHERE plugin = 'jenkins' AND key = ?").get(k); return r ? JSON.parse(r.value) : undefined; };
    assert.equal(reglage('jenkins_url'), 'https://jenkins.equipe.test', 'l’URL (table config) est reprise, sans son slash final — comme le réglage la normalise');
    assert.equal(reglage('jenkins_user'), 'moi');
    assert.equal(reglage('jenkins_refresh_minutes'), 7);
    assert.equal(db.prepare("SELECT value FROM plugin_secret WHERE plugin = 'jenkins' AND key = 'jenkins_token'").get().value, 'jk-SECRET-DAVANT', 'le jeton part dans les secrets du plugin');
    assert.deepEqual(reglage('last_test'), { ok: true, detail: 'moi · 12', tested_at: '2026-09-30T10:00:00.000Z' }, 'le dernier test de connexion est gardé');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM conn_test WHERE service = 'jenkins'").get().c, 0);
    assert.deepEqual(db.prepare('SELECT repo_id, job_path, param FROM plugin_jenkins_link ORDER BY job_path').all(),
      [{ repo_id: repoId, job_path: 'boutique/build', param: null }, { repo_id: repoId, job_path: 'boutique/deploy', param: 'BRANCH' }], 'la table est renommée, pas recopiée : les lignes sont les mêmes');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'repo_jenkins'").get().c, 0);
    const colonnes = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => /jenkins/.test(c));
    assert.deepEqual([colonnes('config'), colonnes('local_config')], [[], []], 'les colonnes du cœur ont disparu');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM plugin_migration WHERE plugin = '_core' AND version = 1").get().c, 1, 'le passage est noté : il ne se rejouera pas');
    db.close();

    // Rejouer le schéma ne refait rien : les valeurs restent, rien n'est dupliqué.
    ouvrirSchema(dir);
    db = new Database(path.join(dir, 'reviewer.db'), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM plugin_jenkins_link").get().c, 2);
    assert.equal(reglage('jenkins_user'), 'moi');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sur une base neuve, le passage ne trouve rien et ne crée rien de Jenkins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-migr-neuve-'));
    ouvrirSchema(dir);
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'reviewer.db'), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM plugin_setting WHERE plugin = 'jenkins'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('repo_jenkins', 'plugin_jenkins_link')").get().c, 0, 'la table du plugin n’existe qu’une fois le plugin activé');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM plugin_migration WHERE plugin = '_core'").get().c, 1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
