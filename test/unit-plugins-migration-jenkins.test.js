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
  test('base NEUVE : aucun état de plugin n’est posé (donc Jenkins démarre désactivé) ; base EXISTANTE : Jenkins reste activé', () => {
    const lire = (dir, sql) => JSON.parse(execFileSync(process.execPath, ['-e',
      'const d=require("better-sqlite3")(process.argv[1],{readonly:true});console.log(JSON.stringify(d.prepare(process.argv[2]).all()))',
      path.join(dir, 'reviewer.db'), sql], { cwd: ROOT, encoding: 'utf8' }));
    // Première installation : le schéma se joue sur une base qui n'existait pas.
    const neuve = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-neuve-'));
    ouvrirSchema(neuve);
    assert.deepEqual(lire(neuve, "SELECT * FROM plugin_state WHERE name = 'jenkins'"), [], 'rien n’est activé d’office');
    // Un poste qui tournait : la base existe, le marqueur de migration n'a pas encore été posé.
    const ancienne = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-ancienne-'));
    ouvrirSchema(ancienne);
    ouvrirSchema(ancienne, ["DELETE FROM plugin_migration WHERE plugin = '_core'", "DELETE FROM plugin_state WHERE name = 'jenkins'"]);
    ouvrirSchema(ancienne);
    const etat = lire(ancienne, "SELECT enabled, origin FROM plugin_state WHERE name = 'jenkins'");
    assert.deepEqual(etat, [{ enabled: 1, origin: 'builtin' }], 'Jenkins reste activé sur un poste qui monte de version');
    // Et ce n'est pas rejoué : désactivé par la personne, il le reste.
    ouvrirSchema(ancienne, ["UPDATE plugin_state SET enabled = 0 WHERE name = 'jenkins'"]);
    ouvrirSchema(ancienne);
    assert.equal(lire(ancienne, "SELECT enabled FROM plugin_state WHERE name = 'jenkins'")[0].enabled, 0, 'un choix de la personne n’est jamais réécrit');
  });

  test('todo.link_kind perd son CHECK sans rien perdre : lignes, colonnes ajoutées après coup, déclencheurs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-migr-todo-'));
    const lire = (sql) => JSON.parse(execFileSync(process.execPath, ['-e',
      'const d=require("better-sqlite3")(process.argv[1],{readonly:true});console.log(JSON.stringify(d.prepare(process.argv[2]).all()))',
      path.join(dir, 'reviewer.db'), sql], { cwd: ROOT, encoding: 'utf8' }));
    const sqlTodo = () => lire("SELECT sql FROM sqlite_master WHERE name = 'todo'")[0].sql;
    ouvrirSchema(dir);
    const declencheurs = lire("SELECT name FROM sqlite_master WHERE tbl_name = 'todo' AND type = 'trigger' ORDER BY name").map((r) => r.name);
    assert.ok(declencheurs.length >= 1, 'le schéma du jour pose des déclencheurs sur todo');
    // La forme d'AVANT : la même table, le CHECK en plus, une ligne remplie — comme sur un vrai poste.
    const avant = sqlTodo().replace(/(\blink_kind\s+TEXT)/i, "$1 CHECK (link_kind IN ('mr','ticket','repo','branch','verification','build','container'))");
    assert.notEqual(avant, sqlTodo(), 'le CHECK a bien été remis');
    ouvrirSchema(dir, ["INSERT INTO todo (title, link_kind, link_ref, shared, position, auto_kind, created_at, updated_at) VALUES ('a', 'build', 'job#1', 1, 5, 'k', '2026', '2026')"]);
    const copie = avant.replace(/^CREATE TABLE\s+("?)todo\1/i, 'CREATE TABLE todo_avant');
    ouvrirSchema(dir, [
      copie.replace(/--[^\n]*/g, '').replace(/\s+/g, ' '),
      'INSERT INTO todo_avant SELECT * FROM todo',
      'DROP TABLE todo',
      'ALTER TABLE todo_avant RENAME TO todo',
    ]);
    assert.match(sqlTodo(), /CHECK \(link_kind/, 'la forme d’avant est en place');
    ouvrirSchema(dir); // un démarrage : le schéma se rejoue
    assert.doesNotMatch(sqlTodo(), /CHECK \(link_kind/, 'le CHECK de link_kind est parti');
    assert.deepEqual(lire('SELECT title, link_kind, link_ref, shared, position, auto_kind FROM todo'),
      [{ title: 'a', link_kind: 'build', link_ref: 'job#1', shared: 1, position: 5, auto_kind: 'k' }], 'la ligne et ses colonnes sont intactes');
    assert.deepEqual(lire("SELECT name FROM sqlite_master WHERE tbl_name = 'todo' AND type = 'trigger' ORDER BY name").map((r) => r.name), declencheurs, 'les déclencheurs sont recréés');
    ouvrirSchema(dir, ["INSERT INTO todo (title, link_kind, link_ref, created_at, updated_at) VALUES ('b', 'genre-de-plugin', 'x', '2026', '2026')"]);
    assert.equal(lire('SELECT COUNT(*) n FROM todo')[0].n, 2, 'un genre inconnu de la table s’écrit');
  });

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
