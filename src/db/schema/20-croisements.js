'use strict';
/* LES CROISEMENTS DE MERGE REQUESTS — deux MR ouvertes du même dépôt qui modifient le même fichier,
 * dit AVANT que la forge ne parle de conflit (voir PLAN.md, « Croisements »).
 *
 * La seule donnée nouvelle est la liste des fichiers modifiés par chaque MR ouverte, relevée sur
 * le SHA de tête : `mr_files`, une ligne par chemin (un renommage en fait deux, l'ancien et le
 * nouveau). `mr_file_fetch` dit SUR QUEL SHA et QUAND la liste a été relevée — et c'est elle, pas
 * `mr_files`, qui distingue « relevée, vide » de « jamais relevée » : une MR sans relevé n'affiche
 * RIEN, jamais « aucun croisement ». `refused` porte le motif d'un relevé refusé (plus de 5 000
 * fichiers) pour ne pas réessayer au tour suivant sur le même SHA.
 *
 * Le croisement lui-même ne se stocke pas : une jointure de `mr_files` sur lui-même, à
 * l'affichage (`src/review/croisements.js`). L'index sur (path, mr_id) la porte.
 *
 * Famille C du registre : relu de la forge, se recrée tout seul. Purgé avec le diff stocké par la
 * rétention des merge requests fermées. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS mr_files (
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (mr_id, path)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mr_files_path ON mr_files(path, mr_id)');
db.exec(`CREATE TABLE IF NOT EXISTS mr_file_fetch (
  mr_id INTEGER PRIMARY KEY REFERENCES mr(id) ON DELETE CASCADE,
  head_sha TEXT,
  fetched_at TEXT NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  refused TEXT
)`);

/* Trois réglages d'équipe (Réglages → Merge Request → Découverte) : l'interrupteur, le plafond
   d'appels forge par tour de découverte (0 = sans limite), et croiser ou non des MR qui ne visent
   pas la même branche cible. Booléens en texte, comme `auto_review_new`. */
try { db.exec("ALTER TABLE config ADD COLUMN mr_files_enabled TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN mr_files_max INTEGER DEFAULT 20'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN mr_files_cross_targets TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
