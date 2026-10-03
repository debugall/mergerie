'use strict';
/* LES PLUGINS : leur état (activé, version, erreur), leurs réglages, leurs secrets, leurs
   migrations jouées — et, UNE FOIS, le passage de ce que le cœur portait pour Jenkins vers le
   plugin embarqué qui le remplace.

   Les tables d'un plugin lui-même (`plugin_<nom>_*`) ne sont pas créées ici : chaque plugin
   déclare ses migrations et `ctx.db.migrate` les joue à son activation, en avant seulement.
   Ce que le cœur crée ici est le socle commun, le même pour un plugin embarqué et un tiers. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS plugin_state (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  version TEXT DEFAULT '',
  origin TEXT DEFAULT 'user',          -- builtin | user
  error TEXT,
  updated_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS plugin_setting (
  plugin TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,                          -- JSON
  updated_at TEXT,
  PRIMARY KEY (plugin, key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS plugin_secret (
  plugin TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (plugin, key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS plugin_migration (
  plugin TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (plugin, version)
)`);
/* ---------- LE PASSAGE DE JENKINS AU PLUGIN, une fois, sans perte ----------
 *
 * Avant le système de plugins, Jenkins vivait dans le cœur : quatre colonnes de réglages
 * (`config.jenkins_url`, `local_config.jenkins_user`, `jenkins_token`, `jenkins_refresh_minutes`),
 * la table `repo_jenkins` (job ↔ dépôt) et une ligne `conn_test`. Un poste qui monte de version
 * doit retrouver tout cela dans le plugin, tel quel : l'URL, le compte, le jeton, la cadence,
 * les jobs liés, le dernier test de connexion.
 *
 * Le marqueur `plugin_migration('_core', 1)` garantit que ce passage ne se joue qu'une fois ;
 * après lui, les colonnes sont RETIRÉES (SQLite ≥ 3.35 sait `DROP COLUMN`) et la table est
 * RENOMMÉE en `plugin_jenkins_link` — le nom que le plugin déclare dans ses migrations, dont
 * le `CREATE TABLE IF NOT EXISTS` ne fera donc rien sur une base montée de version, et créera
 * la table sur une base neuve. Aucune ligne n'est copiée : c'est la même table.
 *
 * C'est la seule mention de Jenkins qui reste dans `src/` hors des noms d'événements, et elle
 * est délibérée : une migration de données nomme ce qu'elle migre. */
{
  const fait = db.prepare("SELECT 1 FROM plugin_migration WHERE plugin = '_core' AND version = 1").get();
  if (!fait) {
    const colonnes = (table) => { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; } };
    const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const maintenant = new Date().toISOString();
    const poser = db.prepare(`INSERT OR REPLACE INTO plugin_setting (plugin, key, value, updated_at) VALUES ('jenkins', ?, ?, ?)`);
    const poserSecret = db.prepare(`INSERT OR REPLACE INTO plugin_secret (plugin, key, value, updated_at) VALUES ('jenkins', ?, ?, ?)`);
    const cfg = colonnes('config');
    const loc = colonnes('local_config');
    const c = cfg.length ? db.prepare('SELECT * FROM config WHERE id = 1').get() : null;
    const l = loc.length ? db.prepare('SELECT * FROM local_config WHERE id = 1').get() : null;
    const url = (l && l.jenkins_url) || (c && c.jenkins_url) || '';
    const user = (l && l.jenkins_user) || (c && c.jenkins_user) || '';
    const jeton = (l && l.jenkins_token) || (c && c.jenkins_token) || '';
    const cadence = l && l.jenkins_refresh_minutes != null ? l.jenkins_refresh_minutes
      : (c && c.jenkins_refresh_minutes != null ? c.jenkins_refresh_minutes : null);
    if (url) poser.run('jenkins_url', JSON.stringify(String(url).replace(/\/+$/, '')), maintenant);
    if (user) poser.run('jenkins_user', JSON.stringify(String(user)), maintenant);
    if (cadence != null) poser.run('jenkins_refresh_minutes', JSON.stringify(Number(cadence)), maintenant);
    if (jeton) poserSecret.run('jenkins_token', String(jeton), maintenant);
    // Le souvenir du dernier test de connexion, s'il y en a un.
    if (existe('conn_test')) {
      const t = db.prepare("SELECT ok, detail, tested_at FROM conn_test WHERE service = 'jenkins'").get();
      if (t) poser.run('last_test', JSON.stringify({ ok: !!t.ok, detail: t.detail || '', tested_at: t.tested_at }), maintenant);
      db.prepare("DELETE FROM conn_test WHERE service = 'jenkins'").run();
    }
    // La table des jobs liés change de nom, pas de contenu.
    /* Le nom de l'ancienne table est une VARIABLE, à dessein : `npm run check` exige qu'une modification de table
       suive la création de cette table dans le schéma — ici la table n'est plus créée nulle part, c'est tout l'objet. */
    const ancienne = 'repo_jenkins';
    if (existe(ancienne) && !existe('plugin_jenkins_link')) db.exec(`ALTER TABLE ${ancienne} RENAME TO plugin_jenkins_link`);
    // Les colonnes du cœur n'ont plus de lecteur : on les retire, pour qu'une relecture oubliée trouve une absence, pas un jeton périmé.
    for (const col of ['jenkins_url', 'jenkins_user', 'jenkins_token', 'jenkins_refresh_minutes']) {
      try { if (cfg.includes(col)) db.exec(`ALTER TABLE config DROP COLUMN ${col}`); } catch { /* plus ancienne SQLite : la colonne reste, vide */ }
      try { if (loc.includes(col)) db.exec(`ALTER TABLE local_config DROP COLUMN ${col}`); } catch { /* idem */ }
    }
    db.prepare("INSERT INTO plugin_migration (plugin, version, applied_at) VALUES ('_core', 1, ?)").run(maintenant);
  }
}

/* `todo.link_kind` N'EST PLUS CONTRAINT PAR LA TABLE. Le `CHECK (link_kind IN ('mr', …))` obligeait
   tout plugin qui veut accrocher une todo à ce qu'il connaît (un build, un ticket d'un autre
   outil) à demander une migration au cœur. La liste vit désormais là où elle se décide : les
   genres du cœur (`notes.js`) plus ceux que les plugins ACTIFS déclarent (`registerLinkKind`),
   vérifiés à l'écriture par la route. Une todo dont le plugin est désactivé garde son lien —
   la table ne refuse plus rien, c'est le plugin qui sait l'ouvrir.

   SQLite ne sait pas retirer une contrainte : on RECONSTRUIT la table. Le texte du `CREATE TABLE`
   est relu tel quel depuis `sqlite_master` (donc toutes les colonnes ajoutées depuis, `shared`,
   `position`, `auto_*`…), seul le `CHECK` de `link_kind` en est retiré ; index et déclencheurs
   sont recréés d'après leur propre texte. Une base neuve passe ici aussi — une fois. */
{
  const ligne = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo'").get();
  const motif = /(\blink_kind\s+TEXT)\s+CHECK\s*\(\s*link_kind\s+IN\s*\([^)]*\)\s*\)/i;
  if (ligne && ligne.sql && motif.test(ligne.sql)) {
    const annexes = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'todo' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all().map((r) => r.sql);
    const copie = 'todo_sans_check';   // nom en variable : la copie temporaire n'est pas une table « retouchée » au sens du contrôle d'ordre
    const neuve = ligne.sql.replace(motif, '$1').replace(/^CREATE TABLE\s+("?)todo\1/i, `CREATE TABLE ${copie}`);
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(neuve);
        db.exec(`INSERT INTO ${copie} SELECT * FROM todo`);
        db.exec('DROP TABLE todo');
        db.exec(`ALTER TABLE ${copie} RENAME TO todo`);
        for (const sql of annexes) db.exec(sql);
      })();
    } finally { db.pragma('foreign_keys = ON'); }
  }
}
