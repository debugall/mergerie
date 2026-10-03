'use strict';
/* Le lanceur : la frécence de ce qu'on ouvre depuis la palette Ctrl+K.
   Les liens de travail (grille services × environnements, liens libres, liens de contexte) ont quitté cette tranche : ils sont le
   plugin `links`, et leurs tables — `environment`, `service`, `service_url`, `context_link`, `free_link` — sont devenues
   `plugin_links_*` par `18-plugins.js`, une fois, avec leur historique de schéma (colonnes ajoutées, `service_url` reconstruite). */
const db = require('../connexion');

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
