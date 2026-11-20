'use strict';
/* LES SESSIONS RÉCURRENTES (Dev IA → Récurrentes). Un MODÈLE, pas une session : à chaque échéance,
   `jobs/recurrences.js` crée une session NEUVE à partir de `payload_json` — ce que `creerTask`
   reçoit (prompt, projets, cases, vérificateur, binaire) — et la lance. Rejouer la même session ne
   tiendrait pas : dès la deuxième fois, sa branche est poussée, sa MR peut être mergée.

   DE POSTE, comme « Lancer plus tard » : le modèle ne part pas dans le dépôt partagé. Trois instances
   allumées le lanceraient sinon trois fois, chacune persuadée d'être la seule.

   `spec` : la grammaire des horaires d'agent (`agent/horaire.js`), jours multiples compris.
   `last_fired_at` : le dernier CRÉNEAU honoré (lancé ou sauté) — posé à la création, pour qu'un
   modèle neuf ne parte pas sur le créneau de ce matin. `last_shas_json` : la tête de la branche de
   base de chaque projet au dernier lancement, pour « seulement si ça a bougé ». */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS recurrence (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','explore')),
  spec TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  skip_unchanged INTEGER NOT NULL DEFAULT 0,
  keep_last INTEGER NOT NULL DEFAULT 10,
  paused INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  last_run_at TEXT,
  last_task_uid TEXT,
  last_skip TEXT,
  last_skip_at TEXT,
  last_shas_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/* La session née d'une récurrence porte l'uid de son modèle : badge sur la carte, lien retour,
   rétention. Colonne de poste (`store-registry.js`) : le modèle n'existe pas chez le collègue. */
try { db.exec('ALTER TABLE task ADD COLUMN recurrence_uid TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_task_recurrence ON task(recurrence_uid)');
