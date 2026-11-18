'use strict';
/* GIT → VÉRIFICATEUR : des préparations de vérification. Une préparation = des dépôts, chacun sur une
   branche ou un tag, et des vérificateurs lancés L'UN APRÈS L'AUTRE sur ces refs. Personnelle : rien
   ici ne part dans le dépôt de données partagé.
   — `verif_plan` : `targets_json` = [{ repo_id, branch, tag }] (l'un des deux), `verifier_ids_json` =
     les vérificateurs dans l'ordre où ils tournent.
   — `verif_plan_run` : un lancement. `steps_json` = [{ verifier_id, verifier_name, verification_id,
     chaine, erreur }] ; l'état de chaque étape se DÉDUIT de sa vérification (en file, en cours, verdict)
     au lieu d'être stocké : un serveur coupé au milieu d'une séquence ne laisse pas une étape « en cours »
     pour toujours.
   — `verification.plan_run_id` : le lancement auquel une vérification appartient ;
     `verification.positions_json` : les dépôts du plan que son vérificateur ne couvre pas, mis sur leur
     ref dans le clone local le temps du run (« tout le lot sur ses branches »), puis remis. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS verif_plan (
  id INTEGER PRIMARY KEY,
  targets_json TEXT NOT NULL,
  verifier_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS verif_plan_run (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES verif_plan(id) ON DELETE CASCADE,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verif_plan_run_plan ON verif_plan_run(plan_id, id)');
// Son nom : une préparation se relance, et c'est par lui qu'on la retrouve dans la liste.
try { db.exec("ALTER TABLE verif_plan ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE verification ADD COLUMN plan_run_id INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE verification ADD COLUMN positions_json TEXT'); } catch { /* déjà présente */ }
