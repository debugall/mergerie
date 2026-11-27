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

/* LA CHAÎNE DE VALIDATION D'UNE SESSION DE CODAGE (`jobs/chaine-verif.js`) : des vérificateurs dans un
   ordre (`task.verify_chain`, ids en JSON), chacun lancé sur la BASE puis sur la BRANCHE, deux essais
   par côté. Une ligne par session : ses étapes portent les vérifications lancées, côté par côté —
   l'état se déduit de leurs verdicts, comme pour les préparations ci-dessus. */
try { db.exec('ALTER TABLE task ADD COLUMN verify_chain TEXT'); } catch { /* déjà présente */ }
db.exec(`CREATE TABLE IF NOT EXISTS verif_chaine (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
  steps_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
try { db.exec('ALTER TABLE verification ADD COLUMN chaine_id INTEGER'); } catch { /* déjà présente */ }
/* Le skill que la session applique pour DIAGNOSTIQUER une branche qui casse un vérificateur de sa chaîne
   (`{ name, repo_id }` en JSON, un skill du dépôt de tests) ; vide = une consigne intégrée qui analyse
   directement le dépôt de tests. */
try { db.exec('ALTER TABLE task ADD COLUMN verify_chain_skill TEXT'); } catch { /* déjà présente */ }
/* LE SCÉNARIO DE COUVERTURE (étape 3) : `task.verify_chain_scenario` = `{ verifier_id, skill }` en JSON — le
   vérificateur qui lance le scénario écrit, et le skill que la session suit pour l'écrire (vide = consigne
   intégrée) ; `verification.scenario` = les chemins passés à ses commandes dans `MERGERIE_SCENARIO`. */
try { db.exec('ALTER TABLE task ADD COLUMN verify_chain_scenario TEXT'); } catch { /* déjà présente */ }
/* LE TICKET D'UNE SESSION DE LA JOURNÉE (cockpit) : « Supprimer » emporte les sessions du même ticket. */
try { db.exec('ALTER TABLE task ADD COLUMN jira_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE verification ADD COLUMN scenario TEXT'); } catch { /* déjà présente */ }
// L'avancement du scénario de couverture d'une chaîne (écrit, couvert, ses lancements) : à part des étapes.
try { db.exec('ALTER TABLE verif_chaine ADD COLUMN scenario_json TEXT'); } catch { /* déjà présente */ }
/* LE DÉPÔT DE TESTS, commun à tous les vérificateurs (Réglages → Vérificateurs) : celui où l'étape 3 de la
   chaîne écrit son scénario. Une référence `forge/projet` et non un id : le réglage est d'équipe, et un id
   entier ne désigne rien sur le poste d'en face. Vide = déduit, s'il n'y a qu'un candidat. */
try { db.exec('ALTER TABLE config ADD COLUMN test_repo TEXT'); } catch { /* déjà présente */ }
/* « …PUIS CONVERGER » SUR UNE SESSION DE CODAGE, retenu : la case se relit à l'édition d'une session pas encore
   lancée, et son premier « Lancer » — de la carte, du cockpit, de « Lancer ma journée » — converge au lieu de
   seulement coder. Avant, la case ne valait qu'au clic de création. */
try { db.exec('ALTER TABLE task ADD COLUMN converge_after INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
