'use strict';
/* Les cibles d’une session de codage, les sessions hors dépôt et leurs dossiers, la question libre, l’activité des commits.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS task_target (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  branch TEXT,
  base_branch TEXT,
  status TEXT DEFAULT 'new',
  commit_sha TEXT,
  diff_path TEXT,
  push_command TEXT,
  mr_iid INTEGER,
  mr_url TEXT,
  mr_target TEXT,
  mr_merged INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_task_target_task ON task_target(task_id)');

// « L'IA pose une question » (ask → stop → resume). Opt-in par session : quand activé, on
// injecte dans le prompt la consigne d'émettre un bloc <<<QUESTIONS>>> plutôt que de trancher
// dans le flou. Le statut de session/cible peut alors devenir `needs_input` (état d'ATTENTE,
// ni succès ni échec) et la file se libère.
try { db.exec('ALTER TABLE task ADD COLUMN ask_questions INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
// Handle de reprise de la session d'agent, persisté par cible (le cwd fait partie de son
// identité — cf. src/agentsession.js). `questions_json` porte les questions posées et les
// réponses de l'utilisateur pour cette cible.
/* Pourquoi la session d'agent en cours n'est PAS celle qu'on avait demandée. Le repli sur une
   session neuve est délibéré (mieux vaut travailler que renoncer), mais il remplace un
   identifiant que l'utilisateur a saisi lui-même : le taire reviendrait à lui faire croire que
   sa session continue. Une ligne de journal ne suffit pas — elle défile. */
try { db.exec('ALTER TABLE task_target ADD COLUMN session_note TEXT'); } catch { /* déjà présente */ }
/* La merge request de ce projet est-elle en conflit ? Trois états : 1 (oui), 0 (non), NULL
   (pas encore su — GitHub calcule `mergeable` de façon asynchrone, et la liste ne le donne
   jamais). Rempli par la passe de découverte qui interroge DÉJÀ ces merge requests une par
   une : le bouton « Mettre à jour avec … » ne coûte donc aucun appel d'API de plus. */
try { db.exec('ALTER TABLE task_target ADD COLUMN mr_conflicts INTEGER'); } catch { /* déjà présente */ }
/* RATTRAPAGE D'UN LIEN PERDU AVANT CE CORRECTIF (voir discover.js, boucle des MR disparues).
 * Une merge request mergée ailleurs qu'ici (GitLab, un merge en différé) sans que
 * `task_target.mr_iid` ait jamais été posé perdait tout lien avec sa session dès que la
 * découverte la marquait `closed_seen` : la carte ne savait plus qu'une MR avait existé, et
 * « Créer la MR » réapparaissait sur une branche déjà mergée.
 * La découverte, corrigée, ne laisse plus ce trou pour ce qui se merge À PARTIR DE MAINTENANT —
 * mais ce qui l'a déjà creusé n'a plus d'occasion de se réparer tout seul : une MR mergée n'est
 * plus jamais revue par `discover.js` une fois `closed_seen` posé. D'où ce repli, IDEMPOTENT
 * (`mr_iid IS NULL` ne retrouve plus rien à corriger une fois fait) : relie chaque cible sans MR
 * connue à la merge request déjà mergée qui existe sur son repo et sa branche. */
db.exec(`UPDATE task_target SET mr_iid = (
    SELECT iid FROM mr WHERE mr.repo_id = task_target.repo_id AND mr.source_branch = task_target.branch
      AND mr.merged_at IS NOT NULL ORDER BY mr.id DESC LIMIT 1
  ), mr_merged = 1, mr_conflicts = 0
  WHERE mr_iid IS NULL AND branch IS NOT NULL AND branch <> '' AND EXISTS (
    SELECT 1 FROM mr WHERE mr.repo_id = task_target.repo_id AND mr.source_branch = task_target.branch
      AND mr.merged_at IS NOT NULL
  )`);
/* Ce projet a-t-il besoin d'un push FORCÉ ? Posé par le rattrapage de la branche de départ,
   qui réécrit l'historique : le push normal est alors refusé par la forge, à juste titre.
   Effacé dès qu'un push réussit — l'état est celui de la branche, pas une préférence. */
try { db.exec('ALTER TABLE task_target ADD COLUMN force_push INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task_target ADD COLUMN session_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task_target ADD COLUMN session_backend TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task_target ADD COLUMN session_cwd TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task_target ADD COLUMN questions_json TEXT'); } catch { /* déjà présente */ }
// Dernier message de l'agent pour ce projet (ce qu'il dit avoir fait) — consultable en fin
// de session, comme la réponse d'une exploration.
try { db.exec('ALTER TABLE task_target ADD COLUMN output_path TEXT'); } catch { /* déjà présente */ }

/* Session RANGÉE : la liste des sessions ne cesse de grandir et rien n'en sort jamais.
   Masquer plutôt que supprimer — l'historique, les diffs et les passes d'agent restent
   consultables en cochant « afficher les sessions masquées ». C'est un rangement, pas une
   suppression : aucune donnée n'est touchée. */
try { db.exec('ALTER TABLE task ADD COLUMN hidden INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
/* Prévenir Jira à la création de chaque merge request de cette session : commentaire avec le
   lien + transition « en revue » si Jira la propose. DÉCOCHÉ par défaut — écrire chez les
   autres se décide, session par session. */
try { db.exec('ALTER TABLE task ADD COLUMN notify_jira INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
/* B9 — REVIEWER LA MR DÈS SA CRÉATION, par session. Sœur de « Vérifier après » : le réglage
   global « reviewer à l'arrivée » engage TOUT le parc, alors qu'on veut souvent l'avis de l'IA
   sur ce que CETTE session vient d'écrire. Décochée par défaut : une review coûte un appel. */
try { db.exec('ALTER TABLE task ADD COLUMN review_after INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
/* B5 — UNE SURVEILLANCE QUI POSE SA TODO. La notification « À faire → En revue » passe pendant
   une réunion et disparaît avec l'onglet ; le MOTIF de surveillance (« prévenir Sofia dès que
   c'est en revue ») dort alors dans la carte. Opt-in, par ticket : on ne veut pas une todo à
   chaque mouvement de chaque ticket surveillé. */
try { db.exec('ALTER TABLE jira_watch ADD COLUMN todo_on_change INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
/* C15 — LE TICKET TÉMOIN JIRA se retapait à chaque test de connexion : le champ existait,
   n'avait pas de `name`, et n'était donc dans aucune des trois listes qui font qu'un réglage
   se garde. Un champ qu'on remplit à chaque fois n'est pas un réglage, c'est une corvée. */
try { db.exec('ALTER TABLE config ADD COLUMN jira_test_key TEXT'); } catch { /* déjà présente */ }
/* A/Réglages 1 — LES DÉFAUTS DE SESSION. Quatre cases repartaient décochées à chaque ouverture
   de la modale, y compris chez quelqu'un qui les coche toutes, tous les jours. Ce ne sont pas
   des habitudes de dépôt (celles-là sont mémorisées par dépôt) mais des habitudes de TRAVAIL :
   elles se règlent une fois. Décochées par défaut, comme aujourd'hui — poser ces réglages ne
   change rien tant qu'on n'y a pas touché. */
try { db.exec('ALTER TABLE config ADD COLUMN task_default_auto_push INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN task_default_ask_questions INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN task_default_notify_jira INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN task_default_converge INTEGER DEFAULT 0'); } catch { /* déjà présente */ }

/* B10 — LE VERDICT REMONTE VERS JIRA. Opt-in, et décoché par défaut comme « Prévenir Jira » :
   écrire chez quelqu'un d'autre (le ticket est lu par la QA, le chef de projet, le support)
   ne se décide pas à notre place. Placée APRÈS le `CREATE TABLE config`, comme toutes les
   migrations de ce fichier. */
try { db.exec('ALTER TABLE config ADD COLUMN verify_jira_comment INTEGER DEFAULT 0'); } catch { /* déjà présente */ }

/* A18 — « ESSAI » ESSAIE VRAIMENT LE PROFIL. Le bouton n'ouvrait qu'une session pré-remplie du
   gabarit : le modèle, les outils, les sous-agents et le prompt système ne partaient pas,
   puisque la session n'avait pas d'`agent_id` — on « essayait » donc tout sauf ce qu'on venait
   de régler. La session porte maintenant le BROUILLON du profil, tel quel, sans créer d'agent :
   essayer ne doit pas laisser derrière soi un profil qu'on n'a pas voulu enregistrer.
   Placée APRÈS le `CREATE TABLE task`. */
try { db.exec('ALTER TABLE task ADD COLUMN agent_draft_json TEXT'); } catch { /* déjà présente */ }

/* De quoi REJOUER un job : l'intention (quelle fonction, sur quel objet), pas son état.
   Sans ça, un job arrêté ne laisse qu'un `kind` — impossible de savoir quelle session ou
   quelles MR relancer. On garde l'intention et non les lignes traitées : pour une review,
   la liste se re-déduit de l'état des MR, et c'est ce qu'on veut (reprendre là où ça s'est
   arrêté, sans refaire ce qui est fait). */
try { db.exec('ALTER TABLE job ADD COLUMN retry TEXT'); } catch { /* déjà présente */ }

// « Codage hors dépôt » : l'IA réalise le prompt DANS des dossiers locaux arbitraires,
// EN PLACE, sans git (ni branche, ni commit, ni push). Table dédiée car sans repo_id.
db.exec(`CREATE TABLE IF NOT EXISTS local_task (
  id INTEGER PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'new',   -- new | running | done | error (agrégé depuis les dossiers)
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS local_task_dir (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES local_task(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT DEFAULT 'new',   -- new | running | done | error
  last_error TEXT,
  updated_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_local_task_dir_task ON local_task_dir(task_id)');
// Codage hors dépôt : session d'agent reprenable par dossier (commande de reprise copiable).
try { db.exec('ALTER TABLE local_task_dir ADD COLUMN session_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task_dir ADD COLUMN session_backend TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task_dir ADD COLUMN session_cwd TEXT'); } catch { /* déjà présente */ }
// Migration : retour de l'agent par dossier (« Retour de l'IA »), comme output_path
// côté task_target. Sans lui, une session hors dépôt qui n'a rien modifié reste opaque.
try { db.exec('ALTER TABLE local_task_dir ADD COLUMN output_path TEXT'); } catch { /* déjà présente */ }
/* « L'IA peut poser des questions » hors dépôt : même boucle que pour un codage de dépôt
   (ask → arrêt → réponses → reprise dans la MÊME session), mais les questions vivent sur le
   DOSSIER — chacun a sa propre session d'agent, donc ses propres hésitations. */
try { db.exec('ALTER TABLE local_task ADD COLUMN ask_questions INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task_dir ADD COLUMN questions_json TEXT'); } catch { /* déjà présente */ }
// Rangement d'une session hors dépôt — même principe que `task.hidden`.

/* ---------- Question libre ----------
   Poser une question à l'IA SANS dépôt ni dossier, et garder la trace de la réponse.

   POURQUOI UNE TABLE À ELLE : `task` porte un `repo_id NOT NULL` (une session de codage ou
   une exploration parle toujours d'un dépôt), et `local_task` agrège son statut depuis ses
   DOSSIERS — une question n'a ni l'un ni l'autre. La greffer sur l'une des deux aurait
   demandé de rendre optionnel ce qui fait justement leur nature, et chaque écran des trois
   saveurs existantes aurait eu à gérer un cas « sans cible » qui ne le concerne pas.

   Tout est dans le CREATE : une table neuve n'a pas d'historique à rattraper. Une colonne
   ajoutée plus tard devra l'être en ALTER, APRÈS ce bloc. */
db.exec(`CREATE TABLE IF NOT EXISTS question (
  id INTEGER PRIMARY KEY,
  prompt TEXT NOT NULL,
  label TEXT,
  status TEXT DEFAULT 'new',        -- new | running | done | error
  md_path TEXT,                     -- la réponse, en Markdown (comme une exploration)
  last_error TEXT,
  session_key TEXT,                 -- session d'agent reprenable : un suivi la reprend
  session_backend TEXT,
  session_cwd TEXT,
  followup_draft TEXT,
  followup_auto INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  finished_at TEXT
)`);
/* Activité mensuelle d'un dépôt (onglet Statistiques). Mise en cache parce qu'elle coûte
   cher à récupérer — six mois d'un dépôt vivant, c'est des centaines de commits paginés —
   et qu'un mois CLOS ne change plus jamais : seul le mois courant se recalcule.
   `authors` = contributeurs distincts du mois ; `partiel` = le plafond de pagination a été
   atteint, donc le compte est un minorant et l'écran doit le dire. */
db.exec(`CREATE TABLE IF NOT EXISTS commit_activity (
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  month TEXT NOT NULL,              -- 'YYYY-MM'
  commits INTEGER NOT NULL,
  authors INTEGER NOT NULL DEFAULT 0,
  partiel INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, month)
)`);
/* `active_days` = jours DISTINCTS où au moins un commit est tombé. C'est cette mesure que le
   graphe met en hauteur : contrairement au nombre de commits, elle ne dépend pas du style
   (squasher ou non ne change pas le nombre de journées travaillées) et elle est bornée, donc
   comparable d'un dépôt à l'autre. Le cache existant ne la connaît pas : on le VIDE plutôt
   que de le laisser servir des barres vides — il se reconstruit tout seul à la prochaine visite. */
try {
  db.exec('ALTER TABLE commit_activity ADD COLUMN active_days INTEGER NOT NULL DEFAULT 0');
  db.exec('DELETE FROM commit_activity');
} catch { /* déjà présente */ }

try { db.exec('ALTER TABLE local_task ADD COLUMN hidden INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
// Même colonne que sur `task` : elle doit être ajoutée APRÈS la création de la table,
// sinon l'ALTER échoue sur une base neuve et la colonne n'existe jamais.
try { db.exec('ALTER TABLE local_task ADD COLUMN finished_at TEXT'); } catch { /* déjà présente */ }
