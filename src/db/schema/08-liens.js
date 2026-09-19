'use strict';
/* Les liens : environnements, services et leurs adresses, liens de contexte, liens libres, lanceur.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- Liens (plan_add_links.md) ----------
   Les liens de travail ont une STRUCTURE que les marque-pages d'un navigateur ne savent pas
   représenter : le même service existe en local, en dev, en preprod, en prod. D'où une
   grille — services en lignes, environnements en colonnes — plutôt qu'un arbre de dossiers
   où chaque service se retrouve éclaté en quatre endroits.

   Ce qui n'entre pas dans cette grille (Confluence, une doc, un outil) reste un LIEN LIBRE,
   à plat, retrouvé par ses tags. Deux formes, parce qu'il y a deux réalités — et non une
   forme unique qui conviendrait mal aux deux. */
db.exec(`CREATE TABLE IF NOT EXISTS environment (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#2f6fe0',
  created_at TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_id INTEGER REFERENCES repo(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);

/* L'ORDRE DES LIGNES, posé à la main. La grille était alphabétique et rien d'autre : on ne
   pouvait pas mettre en tête les trois services qu'on ouvre tous les jours sans les renommer.
   `0` partout signifie « jamais touché » — et l'alphabétique reprend la main derrière, ce qui
   laisse une grille neuve exactement comme avant. */
try { db.exec('ALTER TABLE service ADD COLUMN position INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* Une URL par (service, environnement) — EXPLICITE. On aurait pu deviner une URL de preprod
   depuis celle de dev en remplaçant un morceau de domaine ; c'est exactement le genre de
   magie qui envoie un jour sur le mauvais environnement sans prévenir. */
/* PLUSIEURS ADRESSES PAR CASE. Une case portait une seule URL — clé primaire (service,
   environnement). C'est faux dès qu'un même service expose plusieurs vues au même endroit :
   un Kibana de production, ce sont autant d'adresses que de filtres enregistrés, et chacune
   mérite son nom. D'où une ligne par adresse, avec son libellé et son rang. */
db.exec(`CREATE TABLE IF NOT EXISTS service_url (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  environment_id INTEGER NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
)`);
/* Bases déjà en service : l'ancienne table n'a pas de colonne `id`, et SQLite ne sait pas
   ajouter une clé primaire. On la RECONSTRUIT — la seule migration de ce dépôt à le faire.
   Chaque case existante devient une adresse unique, sans libellé : c'est exactement ce
   qu'elle était. */
{
  const cols = db.prepare('PRAGMA table_info(service_url)').all();
  if (cols.length && !cols.some((c) => c.name === 'id')) {
    /* CLÉS ÉTRANGÈRES DÉSACTIVÉES le temps de la manœuvre, comme le prescrit SQLite pour une
       reconstruction : sans ça, la recopie les vérifie ligne à ligne et une seule adresse
       orpheline empêcherait l'application de démarrer. Le `WHERE EXISTS` les écarte plutôt —
       une URL rattachée à un service disparu ne pointe plus vers rien de toute façon. */
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE service_url_v2 (
        id INTEGER PRIMARY KEY,
        service_id INTEGER NOT NULL REFERENCES service(id) ON DELETE CASCADE,
        environment_id INTEGER NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`INSERT INTO service_url_v2 (service_id, environment_id, label, url, position)
               SELECT u.service_id, u.environment_id, '', u.url, 0 FROM service_url u
               WHERE EXISTS (SELECT 1 FROM service s WHERE s.id = u.service_id)
                 AND EXISTS (SELECT 1 FROM environment e WHERE e.id = u.environment_id)`);
      db.exec('DROP TABLE service_url');
      db.exec('ALTER TABLE service_url_v2 RENAME TO service_url');
    })();
    db.pragma('foreign_keys = ON');
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_service_url_cell ON service_url (service_id, environment_id, position, id)');

/* Les liens CONTEXTUELS vivent à part des URLs de grille : la grille doit rester lisible
   d'un coup d'œil, le contextuel porte des gabarits à variables. Mélanger les deux aurait
   rendu la grille illisible pour servir un cas plus rare. */
db.exec(`CREATE TABLE IF NOT EXISTS context_link (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url_template TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS free_link (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  folder TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)`);
/* LE CHEMIN COMPLET, et pas seulement des tags. Les tags perdent l'ordre et la profondeur :
   `seres/prod` et `logs/prod` se réduisaient tous deux au tag « prod » et se retrouvaient dans
   le même groupe — l'outil détruisait une structure que le navigateur, lui, préserve. */
try { db.exec("ALTER TABLE free_link ADD COLUMN folder TEXT NOT NULL DEFAULT ''"); } catch { /* déjà présente */ }

/* Frécence de la palette : ce qu'on ouvre souvent ET récemment remonte. Un simple compteur
   ferait remonter à vie ce qu'on a beaucoup utilisé le mois dernier ; une simple date
   perdrait ce qu'on ouvre tous les jours depuis un an. */
db.exec(`CREATE TABLE IF NOT EXISTS launcher_usage (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
)`);
