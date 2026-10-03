'use strict';
/* LES PLUGINS : leur état (activé, version, erreur), leurs réglages, leurs secrets, leurs
   migrations jouées — et, UNE FOIS chacun, les passages de ce que le cœur portait (Jenkins,
   Docker, Liens) vers les plugins qui les remplacent.

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
 * Jenkins a connu deux étapes : le cœur → un plugin EMBARQUÉ (marqueur `_core` 1, ci-dessous), puis l'embarqué → un plugin TIERS, dépôt
 * `jenkins-mergerie` (marqueur `_core` 4, plus bas : l'état passe de `builtin` à `user`, rien d'autre ne bouge — mêmes tables, mêmes
 * réglages, mêmes secrets, sous le même nom de plugin). Une base très ancienne rejoue les deux, dans l'ordre.
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
  /* UNE TRANSACTION : les réglages recopiés, la table renommée, les colonnes retirées et le marqueur passent ensemble ou pas du tout. Un arrêt
     au milieu laisse la base d'avant, que la migration rejouera en entier — pas une base à moitié passée. */
  if (!fait) db.transaction(() => {
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
    /* Un poste qui tournait déjà avait l'onglet Jenkins : il le garde, activé, tel quel — le jour où le plugin tiers est installé (rien ne
       disparaît à la montée de version). Le chargeur n'écrit l'état d'un plugin que s'il n'en a pas : celui-ci est posé AVANT son premier passage. */
    if (db.baseExistante) {
      db.prepare("INSERT OR IGNORE INTO plugin_state (name, enabled, version, origin, updated_at) VALUES ('jenkins', 1, '', 'user', ?)").run(maintenant);
    }
    db.prepare("INSERT INTO plugin_migration (plugin, version, applied_at) VALUES ('_core', 1, ?)").run(maintenant);
  })();
}

/* ---------- LE PASSAGE DE DOCKER AU PLUGIN, une fois, sans perte ----------
 *
 * L'onglet Docker a quitté le cœur : il est le plugin `docker` (dépôt `docker-mergerie`, installé comme n'importe quel plugin tiers). Il avait deux
 * tables, que le plugin déclare sous ses propres noms — `docker_backup` (l'inspect sauvegardé avant chaque suppression d'un conteneur hors-compose,
 * la seule trace pour le refaire) et `make_run` (la dernière exécution de chaque cible `make`). Elles sont RENOMMÉES, pas copiées : le
 * `CREATE TABLE IF NOT EXISTS` du plugin ne fait alors rien, et il retrouve ses sauvegardes telles quelles. Sur une base neuve, il n'y a rien à renommer.
 *
 * Un poste qui montait de version avait l'onglet : l'état `docker` est posé ACTIVÉ, pour que le plugin s'active tout seul le jour où on l'installe — rien ne
 * disparaît à la montée de version, sauf à ne jamais l'installer. Le marqueur `_core` 2 garantit que ce passage ne se joue qu'une fois. */
{
  const fait = db.prepare("SELECT 1 FROM plugin_migration WHERE plugin = '_core' AND version = 2").get();
  if (!fait) db.transaction(() => {
    const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    /* Les noms de l'ancienne table sont des VARIABLES, à dessein : `npm run check` exige qu'une modification de table suive la création de cette
       table dans le schéma — ici elle n'est plus créée nulle part, c'est tout l'objet. */
    const renommages = [['docker_backup', 'plugin_docker_backup'], ['make_run', 'plugin_docker_make_run']];
    for (const [ancienne, nouvelle] of renommages) if (existe(ancienne) && !existe(nouvelle)) db.exec(`ALTER TABLE ${ancienne} RENAME TO ${nouvelle}`);
    if (db.baseExistante) {
      db.prepare("INSERT OR IGNORE INTO plugin_state (name, enabled, version, origin, updated_at) VALUES ('docker', 1, '', 'user', ?)").run(new Date().toISOString());
    }
    db.prepare("INSERT INTO plugin_migration (plugin, version, applied_at) VALUES ('_core', 2, ?)").run(new Date().toISOString());
  })();
}

/* ---------- LE PASSAGE DES LIENS AU PLUGIN, une fois, sans perte ----------
 *
 * L'onglet Liens a quitté le cœur : il est le plugin `links` (dépôt `link-mergerie`, installé comme n'importe quel plugin tiers). Ses cinq tables
 * — les colonnes de la grille (`environment`), ses lignes (`service`), leurs adresses (`service_url`), les gabarits de contexte
 * (`context_link`) et les liens libres (`free_link`) — sont RENOMMÉES en `plugin_links_*`, pas copiées : le `CREATE TABLE IF NOT EXISTS` du plugin
 * ne fait alors rien, et il retrouve la grille, ses dossiers, ses gabarits et ses liens libres tels quels, ids compris (les références des clés
 * étrangères suivent le renommage). Sur une base neuve, il n'y a rien à renommer.
 *
 * AVANT le renommage, ce que l'ancienne tranche `08-liens.js` faisait aux bases d'avant : la colonne `service.position`, la colonne `free_link.folder`, la
 * reconstruction de `service_url` (une ligne par adresse, clé primaire `id`) et le retrait de `environment.health_check`. Elles ne sont plus rejouées
 * ailleurs : une base très ancienne passe par ici avant de changer de nom.
 *
 * La FRÉCENCE des liens suit : les lignes de `launcher_usage` des genres `service_url` et `free_link` passent dans `plugin_links_usage` (la table que le plugin
 * déclare, créée ici sur le même schéma s'il y a de quoi y mettre) ; celles des merge requests, des sessions, etc. restent dans le cœur.
 *
 * Un poste qui montait de version avait l'onglet : l'état `links` est posé ACTIVÉ, pour que le plugin s'active tout seul le jour où on l'installe — rien ne
 * disparaît à la montée de version, sauf à ne jamais l'installer. Le marqueur `_core` 3 garantit que ce passage ne se joue qu'une fois. */
{
  const fait = db.prepare("SELECT 1 FROM plugin_migration WHERE plugin = '_core' AND version = 3").get();
  if (!fait) db.transaction(() => {
    const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const colonnes = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    /* Les noms d'anciennes tables sont des VARIABLES, à dessein : `npm run check` exige qu'une modification de table suive la création de cette table dans
       le schéma — ici elle n'est plus créée nulle part, c'est tout l'objet. */
    const [env, svc, url, ctxl, libre] = ['environment', 'service', 'service_url', 'context_link', 'free_link'];
    const ajouter = (t, col, ddl) => { if (existe(t) && !colonnes(t).includes(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${ddl}`); };
    ajouter(svc, 'position', 'INTEGER NOT NULL DEFAULT 0');
    ajouter(libre, 'folder', "TEXT NOT NULL DEFAULT ''");
    if (existe(env) && colonnes(env).includes('health_check')) { try { db.exec(`ALTER TABLE ${env} DROP COLUMN health_check`); } catch { /* plus ancienne SQLite : la colonne reste, inerte */ } }
    /* `service_url` d'avant les adresses multiples : pas de colonne `id`, et SQLite ne sait pas ajouter une clé primaire — on la reconstruit, chaque case devenant une
       adresse sans libellé. Clés étrangères coupées le temps de la manœuvre, comme le prescrit SQLite ; le `WHERE EXISTS` écarte une adresse orpheline. */
    if (existe(url) && !colonnes(url).includes('id')) {
      const neuve = `${url}_v2`;
      db.exec(`CREATE TABLE ${neuve} (id INTEGER PRIMARY KEY, service_id INTEGER NOT NULL REFERENCES ${svc}(id) ON DELETE CASCADE,
        environment_id INTEGER NOT NULL REFERENCES ${env}(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`);
      db.exec(`INSERT INTO ${neuve} (service_id, environment_id, label, url, position)
        SELECT u.service_id, u.environment_id, '', u.url, 0 FROM ${url} u
        WHERE EXISTS (SELECT 1 FROM ${svc} s WHERE s.id = u.service_id) AND EXISTS (SELECT 1 FROM ${env} e WHERE e.id = u.environment_id)`);
      db.exec(`DROP TABLE ${url}`);
      db.exec(`ALTER TABLE ${neuve} RENAME TO ${url}`);
    }
    // Les parents d'abord : une clé étrangère d'enfant suit le nom de son parent renommé.
    const renommages = [[env, 'plugin_links_environment'], [svc, 'plugin_links_service'], [url, 'plugin_links_service_url'], [ctxl, 'plugin_links_context_link'], [libre, 'plugin_links_free_link']];
    for (const [ancienne, nouvelle] of renommages) if (existe(ancienne) && !existe(nouvelle)) db.exec(`ALTER TABLE ${ancienne} RENAME TO ${nouvelle}`);
    if (db.prepare("SELECT 1 FROM launcher_usage WHERE kind IN ('service_url', 'free_link') LIMIT 1").get()) {
      /* Le nom est une VARIABLE, comme ceux des renommages : la table est celle du plugin (il la déclare, la classe et la possède) ; le cœur ne la fait pas entrer
         dans son registre de familles. */
      const usage = 'plugin_links_usage';
      db.exec(`CREATE TABLE IF NOT EXISTS ${usage} (
        kind TEXT NOT NULL, ref TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL, PRIMARY KEY (kind, ref)
      )`);
      db.exec(`INSERT OR IGNORE INTO ${usage} (kind, ref, uses, last_used_at)
        SELECT kind, ref, uses, last_used_at FROM launcher_usage WHERE kind IN ('service_url', 'free_link')`);
      db.exec("DELETE FROM launcher_usage WHERE kind IN ('service_url', 'free_link')");
    }
    const maintenant = new Date().toISOString();
    if (db.baseExistante) {
      db.prepare("INSERT OR IGNORE INTO plugin_state (name, enabled, version, origin, updated_at) VALUES ('links', 1, '', 'user', ?)").run(maintenant);
    }
    db.prepare("INSERT INTO plugin_migration (plugin, version, applied_at) VALUES ('_core', 3, ?)").run(maintenant);
  })();
}

/* ---------- JENKINS, D'EMBARQUÉ À TIERS, une fois ----------
 *
 * Le plugin `jenkins` n'est plus livré avec Mergerie : il vit dans son dépôt (`jenkins-mergerie`) et s'installe comme n'importe quel plugin tiers. Ses
 * données n'ont pas à bouger — `plugin_jenkins_link`, ses réglages et son jeton portent le nom du plugin, pas celui de son dossier. Ne reste que
 * l'état : un poste qui l'avait activé en `builtin` le garde activé, en `user` — il s'activera tout seul le jour où on l'installe. Une base qui
 * a déjà tout cela (le passage 1 pose désormais `user`) n'a rien à changer. */
{
  const fait = db.prepare("SELECT 1 FROM plugin_migration WHERE plugin = '_core' AND version = 4").get();
  if (!fait) db.transaction(() => {
    db.prepare("UPDATE plugin_state SET origin = 'user' WHERE name = 'jenkins' AND origin = 'builtin'").run();
    db.prepare("INSERT INTO plugin_migration (plugin, version, applied_at) VALUES ('_core', 4, ?)").run(new Date().toISOString());
  })();
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
