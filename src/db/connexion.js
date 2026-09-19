'use strict';
/* OUVRIR LA BASE — et rien d'autre. Les tranches de `schema/` s'y accrochent en l'important ;
   `index.js` les joue dans l'ordre et exporte la base prête (refacto.md, étape 3). */
const Database = require('better-sqlite3');
const { DB_PATH, DEFAULT_CLONE_DIR, initDirs } = require('../core/paths');

initDirs();

const { ulid, slugLibre } = require('../core/ulid');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* `mergerie_ulid()` APPELABLE DEPUIS SQL. C'est ce qui permet aux déclencheurs du bas de ce
   fichier de poser un `uid` sur chaque ligne partagée sans qu'aucun des ~100 `INSERT` de
   l'application n'ait à y penser. Enregistrée ici, tout en haut : une insertion faite plus bas
   pendant les migrations doit déjà la trouver.
   `{ deterministic: false }` est le défaut et c'est ce qu'on veut — SQLite ne doit surtout pas
   mettre en cache le résultat d'un générateur d'identité. */
db.function('mergerie_ulid', () => ulid());

module.exports = db;
