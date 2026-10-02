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
