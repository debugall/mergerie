'use strict';
const Database = require('better-sqlite3');
const { DB_PATH, DEFAULT_CLONE_DIR, initDirs } = require('./paths');

initDirs();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gitlab_url TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  clone_path TEXT DEFAULT '',
  prompt_review TEXT DEFAULT '',
  prompt_explain TEXT DEFAULT '',
  prompt_modify TEXT DEFAULT '',
  review_skill TEXT DEFAULT 'git-review'
);

CREATE TABLE IF NOT EXISTS repo (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  url TEXT NOT NULL,
  branch_pattern TEXT DEFAULT 'PROJ-',
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS mr (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  iid INTEGER NOT NULL,
  title TEXT,
  source_branch TEXT,
  target_branch TEXT,
  web_url TEXT,
  current_sha TEXT,
  reviewed_sha TEXT,
  status TEXT DEFAULT 'to_review',
  updated_at TEXT,
  UNIQUE(repo_id, iid)
);

CREATE TABLE IF NOT EXISTS review (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL UNIQUE REFERENCES mr(id) ON DELETE CASCADE,
  md_path TEXT,
  explanation_path TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY,
  kind TEXT,
  status TEXT,
  total INTEGER DEFAULT 0,
  done_count INTEGER DEFAULT 0,
  current_mr_id INTEGER,
  message TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_log (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  mr_id INTEGER,
  ts TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_log_job ON job_log(job_id, id);

CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT,
  commit_message TEXT,
  auto_push INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',          -- new | running | committed | pushed | error
  commit_sha TEXT,
  diff_path TEXT,
  push_command TEXT,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS task_image (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_rule (
  id INTEGER PRIMARY KEY,
  branch_match TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);

/* LES COMMENTAIRES INLINE EN ATTENTE. On relit une MR fichier par fichier et on écrit ses
   remarques au fil de la lecture ; les envoyer une par une bombarde l'auteur de notifications
   et fige des remarques qu'on aurait retirées trois fichiers plus loin. On les garde donc ICI,
   modifiables, jusqu'à un envoi explicite — le geste direct reste possible et inchangé.

   Aucune SHA n'est stockée : la position est recalculée à l'envoi, comme pour un commentaire
   direct. Une MR qui a bougé entre-temps recevrait sinon des commentaires accrochés à un état
   du code qui n'existe plus. */
CREATE TABLE IF NOT EXISTS mr_comment_draft (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  old_path TEXT,
  new_path TEXT,
  old_line INTEGER,
  new_line INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_log (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  body TEXT,
  gitlab_note_id INTEGER,
  sent_at TEXT
);
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_mr_comment_draft_mr ON mr_comment_draft(mr_id)');

// Migration : forge d'un dépôt ('gitlab' | 'github'). Les dépôts existants restent
// GitLab — la valeur par défaut suffit, aucune donnée à réécrire.
try { db.exec("ALTER TABLE repo ADD COLUMN forge TEXT DEFAULT 'gitlab'"); } catch { /* déjà présente */ }
/* Migration : récupération des MR, dépôt par dépôt. Distincte de `enabled`, qui retire le
   dépôt de PARTOUT (git, sessions, recherche de ref). Ici on garde le dépôt utilisable et on
   cesse seulement de ramener ses MR. Par défaut à 1 : les dépôts existants ne changent pas
   de comportement. */
try { db.exec('ALTER TABLE repo ADD COLUMN fetch_mrs INTEGER DEFAULT 1'); } catch { /* déjà présente */ }
// Migration : connexion GitHub (URL vide = github.com ; sinon GitHub Enterprise).
try { db.exec("ALTER TABLE config ADD COLUMN github_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN github_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Migration : colonne d'erreur persistée par MR (texte complet, non tronqué).
try { db.exec('ALTER TABLE mr ADD COLUMN last_error TEXT'); } catch { /* déjà présente */ }
/* Pourquoi la session d'agent en cours n'est PAS celle qu'on avait demandée. Le repli sur une
   session neuve est délibéré (mieux vaut travailler que renoncer), mais il remplace un
   identifiant que l'utilisateur a saisi lui-même : le taire reviendrait à lui faire croire que
   sa session continue. Une ligne de journal ne suffit pas — elle défile. */
try { db.exec('ALTER TABLE task_target ADD COLUMN session_note TEXT'); } catch { /* déjà présente */ }
/* De QUOI un job s'occupe-t-il. La table ne portait que `current_mr_id` : rien ne reliait un job
   à la session de codage qu'il exécutait, donc impossible de dire après coup « ce job-là, c'était
   la session sur api-core ». C'est ce qui rend le journal d'activité lisible. */
try { db.exec('ALTER TABLE job ADD COLUMN target_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE job ADD COLUMN target_id INTEGER'); } catch { /* déjà présente */ }
// Migration : date de création de la MR côté GitLab (pour le tri).
try { db.exec('ALTER TABLE mr ADD COLUMN gitlab_created_at TEXT'); } catch { /* déjà présente */ }
// Migration : auteur de la MR.
try { db.exec('ALTER TABLE mr ADD COLUMN author TEXT'); } catch { /* déjà présente */ }
// Migration : chemin du diff sauvegardé (pour la vue rapport + diff).
try { db.exec('ALTER TABLE review ADD COLUMN diff_path TEXT'); } catch { /* déjà présente */ }
// Migration : note globale numérique (0..1) pour le dashboard.
try { db.exec('ALTER TABLE review ADD COLUMN note_value REAL'); } catch { /* déjà présente */ }
// Migration : contexte du ticket (texte + capture) fourni par le relecteur.
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_text TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_image TEXT'); } catch { /* déjà présente */ }
// Migration : contexte Jira récupéré automatiquement (distinct du contexte manuel
// ci-dessus, pour ne jamais l'écraser — les deux sont concaténés à la review).
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_text TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_at TEXT'); } catch { /* déjà présente */ }
// Session d'agent de la review (continuité : « Relancer la review » reprend la même session).
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_backend TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_cwd TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_error TEXT'); } catch { /* déjà présente */ }
// Migration : chemins des fichiers modifiés par la MR (pour le badge « risque » et
// les règles par chemin), un par ligne. Rempli au discover / à la review.
try { db.exec('ALTER TABLE mr ADD COLUMN changed_paths TEXT'); } catch { /* déjà présente */ }
/* Options de merge choisies à la création de la MR. GitLab les applique nativement dès
   la création ; GitHub ne sait pas les exprimer là (ce sont des décisions de merge), on
   les mémorise donc ici pour pré-cocher — et appliquer — la modale de merge. */
try { db.exec('ALTER TABLE mr ADD COLUMN squash INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN remove_source_branch INTEGER'); } catch { /* déjà présente */ }
// Migration : règles de review par CHEMIN de fichier (glob) — plus précis que la
// branche. Une règle peut avoir branch_match et/ou path_match. label = badge court.
try { db.exec('ALTER TABLE review_rule ADD COLUMN path_match TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE review_rule ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
// Projets liés à une MR : l'IA analyse l'impact des changements sur ces dépôts
// (lecture seule) lors de la review. Un lien = un dépôt connu + une branche.
db.exec(`CREATE TABLE IF NOT EXISTS mr_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL,
  branch TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mr_link_mr ON mr_link(mr_id)');
// Liens par DÉFAUT au niveau dépôt : `quand on review repo_id, lier linked_repo_id`.
// Copiés dans mr_link à la découverte d'une nouvelle MR de repo_id (zéro clic).
db.exec(`CREATE TABLE IF NOT EXISTS repo_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  linked_repo_id INTEGER NOT NULL,
  branch TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_repo_link_repo ON repo_link(repo_id)');
// Migration : URL de base Jira (configurable dans l'admin).
try { db.exec("ALTER TABLE config ADD COLUMN jira_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Migration : identifiants Jira Cloud (email + jeton d'API) pour le fetch automatique.
try { db.exec("ALTER TABLE config ADD COLUMN jira_email TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jira_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Migration : connexion Jenkins (URL + utilisateur + jeton d'API). Jenkins authentifie en
   Basic `utilisateur:jeton` — le jeton seul ne suffit pas, d'où les deux champs. */
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_user TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Migration : message de commit personnalisable des tâches.
/* LE VÉRIFICATEUR D'UNE SESSION, facultatif. Rattaché à la session et non au lancement :
   relancer la même session doit revérifier de la même façon, sans qu'on ait à s'en souvenir.
   `SET NULL` — supprimer un vérificateur ne doit pas emporter les sessions qui s'en servaient. */
try { db.exec('ALTER TABLE task ADD COLUMN verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL'); } catch { /* déjà présente */ }
/* UN LIBELLÉ, FACULTATIF. Une liste de sessions se lit par son prompt — trois lignes repliées
   dont les premiers mots se ressemblent souvent d'une session à l'autre. Un titre court écrit
   par qui la lance dit en un coup d'œil ce qu'elle fait ; vide, on retombe sur le prompt. */
try { db.exec('ALTER TABLE task ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
/* UN SUIVI EN ATTENTE. On lit le travail de l'IA pendant qu'elle travaille, et la remarque
   vient là — pas vingt minutes plus tard quand la session est finie et qu'on est passé à
   autre chose. On l'écrit donc quand elle vient, elle attend ici, et c'est un geste explicite
   qui l'envoie : rien dans `jobs.js` ni `taskrunner.js` ne lit cette colonne, une session ne
   doit jamais repartir toute seule sur un texte écrit une heure plus tôt. */
try { db.exec('ALTER TABLE task ADD COLUMN followup_draft TEXT'); } catch { /* déjà présente */ }
/* … sauf si on demande explicitement le contraire. Coché, le suivi part de lui-même à la fin de
   la session. Le défaut reste 0 : un envoi automatique doit être un choix, jamais un oubli. */
try { db.exec('ALTER TABLE task ADD COLUMN followup_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN commit_message TEXT'); } catch { /* déjà présente */ }
// Migration : MR créée depuis une tâche.
try { db.exec('ALTER TABLE task ADD COLUMN mr_iid INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_url TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_target TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_merged INTEGER'); } catch { /* déjà présente */ }
// Migration : langue de l'interface. En base et non seulement en localStorage,
// car les messages d'erreur du serveur sont affichés à l'utilisateur (i18n.md §2.1).
try { db.exec("ALTER TABLE config ADD COLUMN language TEXT DEFAULT 'fr'"); } catch { /* déjà présente */ }
// Migration : rafraîchissement automatique des MR (minutes, 0 = désactivé).
try { db.exec('ALTER TABLE config ADD COLUMN auto_refresh_minutes INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
// Migration : cadence de vérification des tickets Jira surveillés (0 = désactivée).
try { db.exec('ALTER TABLE config ADD COLUMN jira_watch_minutes INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
/* Rétention de l'historique, en JOURS (0 = illimité). `job_log`, `job` et `feed` accumulent
   sans jamais se vider ; sur une instance utilisée tous les jours, ce sont elles qui finissent
   par peser. 90 jours par défaut : assez long pour relire le journal d'un job d'il y a deux
   mois, assez court pour que la base ne double pas chaque année. Voir `retention.js` pour ce
   qui n'est PAS purgé, et pourquoi. */
try { db.exec('ALTER TABLE config ADD COLUMN retention_days INTEGER DEFAULT 90'); } catch { /* déjà présente */ }
/* Tickets Jira surveillés. `status` est le DERNIER état connu : c'est lui qu'on compare au
   prochain passage pour décider s'il y a eu changement. Un ticket ajouté part donc avec
   l'état courant, sinon la première vérification notifierait un faux changement. */
db.exec(`CREATE TABLE IF NOT EXISTS jira_watch (
  key TEXT PRIMARY KEY,
  summary TEXT,
  status TEXT,
  status_category TEXT,
  added_at TEXT,
  checked_at TEXT,
  changed_at TEXT,
  error TEXT
)`);
/* Pourquoi on surveille CE ticket. Trois mois plus tard, une clé et un résumé ne le disent
   plus — « il bloque la migration de la facturation » si. La colonne est ajoutée à part :
   les bases existantes ont déjà la table. */
try { db.exec('ALTER TABLE jira_watch ADD COLUMN note TEXT'); } catch { /* déjà présente */ }
// Migration : générer l'explication pédagogique lors d'une review ('1' par défaut =
// comportement historique). '0' = review seule (on saute le 2e appel IA), l'explication
// restant disponible à la demande via le bouton « Générer l'explication » du rapport.
/* Fin de la dernière EXÉCUTION d'une session (codage, hors dépôt, exploration). Distinct
   d'`updated_at`, qui bouge aussi quand on corrige un prompt, qu'on pousse une branche ou
   qu'on range la session — trier là-dessus ferait remonter en tête une session qu'on vient
   seulement de relire. Sert à montrer d'abord ce qui vient de finir de tourner. */
try { db.exec('ALTER TABLE task ADD COLUMN finished_at TEXT'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN review_explain TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
// Consommation de tokens de l'agent IA (estimée) — alimente le footer télémétrie.
db.exec(`CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  kind TEXT,
  prompt_chars INTEGER,
  output_chars INTEGER,
  tokens_est INTEGER,
  created_at TEXT
)`);
// Type de session de dev : 'code' (l'IA modifie le code) ou 'explore' (lecture seule,
// l'IA répond à une question et sa réponse est stockée dans un .md).
try { db.exec("ALTER TABLE task ADD COLUMN kind TEXT DEFAULT 'code'"); } catch { /* déjà présente */ }
// Chemin du .md de synthèse produit par une exploration.
try { db.exec('ALTER TABLE task ADD COLUMN md_path TEXT'); } catch { /* déjà présente */ }

// Une session peut porter sur PLUSIEURS projets : l'état d'exécution (commit, diff,
// push, MR, merge) est donc par projet, pas par tâche.
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
// Rangement d'une session hors dépôt — même principe que `task.hidden`.
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

/* HISTORIQUE DES PASSES d'agent — une ligne par itération, pour une session sur dépôt
   comme pour un codage hors dépôt. Même esprit que `review_version` : chaque passe écrit
   son propre fichier (`output-v<N>.md`) au lieu d'écraser le précédent, et la colonne
   `output_path` de l'unité continue de pointer la DERNIÈRE — le reste de l'app n'a rien
   à changer. On garde le PROMPT réellement envoyé : sans lui, relire un retour d'IA
   trois itérations plus tard ne dit pas à quoi il répondait.

   Une seule table pour les deux familles (`scope`), plutôt que deux tables jumelles :
   le serveur et l'interface n'ont ainsi qu'une implémentation. Contrepartie assumée :
   pas de clé étrangère possible (deux tables parentes), donc les suppressions de session
   nettoient explicitement cette table. */
db.exec(`CREATE TABLE IF NOT EXISTS agent_pass (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,          -- 'task' (session sur dépôt) | 'local' (hors dépôt)
  task_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,     -- task_target.id | local_task_dir.id
  n INTEGER NOT NULL,           -- numéro de passe, par unité
  kind TEXT,                    -- run | followup | answer | converge-fix
  prompt TEXT,                  -- ce qui a RÉELLEMENT été envoyé à l'agent
  output_path TEXT,             -- retour de l'agent pour cette passe
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_agent_pass_unit ON agent_pass(scope, task_id, unit_id, n)');
// Captures jointes au prompt d'un codage hors dépôt (mêmes que task_image, table dédiée).
/* APRÈS la création de la table, et pas avant : un `ALTER` posé plus haut dans ce fichier
   échoue sur une table qui n'existe pas encore, et le `catch` l'avale sans un mot. La colonne
   n'apparaît alors que sur les bases où la table préexistait — le genre de différence qui ne
   se voit qu'en production. */
try { db.exec('ALTER TABLE local_task ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_draft TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

db.exec(`CREATE TABLE IF NOT EXISTS local_task_image (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES local_task(id) ON DELETE CASCADE,
  path TEXT NOT NULL
)`);

/* « Répertoires locaux » : un dossier de la machine contenant un sous-dossier par
   projet git déjà cloné à la main (~/dev). Sert à l'onglet Git → Navigation et au
   choix du dossier de travail du codage hors dépôt. On ne stocke QUE la racine :
   la liste des projets se relit du disque à chaque fois, sinon un projet cloné ou
   supprimé entre deux ouvertures d'écran n'existerait que dans la base. */
db.exec(`CREATE TABLE IF NOT EXISTS local_root (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT
)`);

// Onglet Docker : avant tout `docker rm` d'un container HORS-COMPOSE, on sauvegarde son
// `docker inspect` complet ici — filet de restauration (sans définition déclarative, ce JSON
// est la seule trace pour régénérer un `docker run` équivalent). Esprit des branches restaurables.
db.exec(`CREATE TABLE IF NOT EXISTS docker_backup (
  id INTEGER PRIMARY KEY,
  container_id TEXT,
  name TEXT,
  image TEXT,
  inspect_json TEXT NOT NULL,
  run_command TEXT,
  created_at TEXT
)`);

// Migration : les tâches mono-projet existantes deviennent une tâche à un seul target.
// Idempotent (on ne migre que les tâches qui n'ont encore aucun target).
try {
  const orphans = db.prepare(`SELECT t.* FROM task t
    WHERE NOT EXISTS (SELECT 1 FROM task_target tt WHERE tt.task_id = t.id)`).all();
  if (orphans.length) {
    const ins = db.prepare(`INSERT INTO task_target
      (task_id, repo_id, branch, base_branch, status, commit_sha, diff_path, push_command,
       mr_iid, mr_url, mr_target, mr_merged, last_error, updated_at)
      VALUES (@task_id, @repo_id, @branch, @base_branch, @status, @commit_sha, @diff_path, @push_command,
              @mr_iid, @mr_url, @mr_target, @mr_merged, @last_error, @updated_at)`);
    const run = db.transaction((rows) => {
      for (const t of rows) {
        ins.run({
          task_id: t.id, repo_id: t.repo_id, branch: t.branch, base_branch: t.base_branch,
          status: t.status || 'new', commit_sha: t.commit_sha, diff_path: t.diff_path,
          push_command: t.push_command, mr_iid: t.mr_iid, mr_url: t.mr_url,
          mr_target: t.mr_target, mr_merged: t.mr_merged || 0, last_error: t.last_error,
          updated_at: t.updated_at,
        });
      }
    });
    run(orphans);
    console.log(`[migration] ${orphans.length} tâche(s) mono-projet converties en task_target`);
  }
} catch (e) { console.error('[migration] task_target :', e.message); }

// Historique des reviews : chaque passe produit une VERSION conservée, au lieu
// d'écraser la précédente. Permet de relire une review antérieure, et ouvre la voie
// au suivi de résolution (quels constats persistent d'une passe à l'autre).
db.exec(`CREATE TABLE IF NOT EXISTS review_version (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  md_path TEXT,
  explanation_path TEXT,
  note_value REAL,
  reviewed_sha TEXT,
  kind TEXT DEFAULT 'review',
  created_at TEXT
)`);
// Migration : demande de modification à l'origine d'une version de rapport (kind='modify').
// Sans elle, l'historique des régénérations ne dit pas CE QUI avait été demandé.
try { db.exec('ALTER TABLE review_version ADD COLUMN instruction TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_review_version_mr ON review_version(mr_id, version)');

/* Suivi de résolution entre deux passes de review (ideas.md « Suivi de résolution »).
   Chaque passe émet des CONSTATS structurés (fichier, ligne, sévérité, titre). Le
   `fingerprint` — hash(fichier + titre normalisé), SANS la ligne (elle bouge) —
   donne une identité stable pour apparier un constat d'une passe à l'autre.
   Une ligne par (version, constat). Le `status` raconte l'histoire du constat À
   CETTE passe :
     - new         : apparu à cette passe
     - persistent  : déjà présent à la passe précédente, toujours là
     - resolved    : présent avant, disparu ICI, ET la ligne a changé (vérifié git)
     - disappeared : présent avant, disparu ICI, mais code inchangé → NON vérifié
   resolved/disappeared portent le fichier/titre de l'ANCIEN constat (celui qui a
   disparu), rattachés à la version courante pour que « les constats de la v3 »
   racontent tout le delta en une requête. */
db.exec(`CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  severity TEXT,
  title TEXT,
  status TEXT NOT NULL,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_finding_mr_version ON finding(mr_id, version)');

// Agrégats du delta, portés par la version : lecture directe pour le bandeau du
// rapport et le taux de résolution des statistiques, sans recompter les constats.
for (const col of ['n_new', 'n_persistent', 'n_resolved', 'n_disappeared']) {
  try { db.exec(`ALTER TABLE review_version ADD COLUMN ${col} INTEGER`); } catch { /* déjà présente */ }
}

// Migration : les reviews existantes deviennent leur propre version 1, en pointant
// les fichiers déjà sur disque. Idempotent (seules les MR sans version sont traitées).
try {
  const orphans = db.prepare(`SELECT r.* FROM review r
    WHERE NOT EXISTS (SELECT 1 FROM review_version v WHERE v.mr_id = r.mr_id)`).all();
  if (orphans.length) {
    const ins = db.prepare(`INSERT INTO review_version
      (mr_id, version, md_path, explanation_path, note_value, reviewed_sha, kind, created_at)
      VALUES (?, 1, ?, ?, ?, ?, 'review', ?)`);
    const run = db.transaction((rows) => {
      for (const r of rows) {
        const sha = db.prepare('SELECT reviewed_sha FROM mr WHERE id = ?').get(r.mr_id);
        ins.run(r.mr_id, r.md_path, r.explanation_path, r.note_value,
          sha ? sha.reviewed_sha : null, r.created_at || r.updated_at);
      }
    });
    run(orphans);
    console.log(`[migration] ${orphans.length} review(s) existantes historisées en version 1`);
  }
} catch (e) { console.error('[migration] review_version :', e.message); }

// Journal d'événements « frais » pour le footer (MR arrivée / mergée, par auteur).
db.exec(`CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY,
  type TEXT,
  mr_iid INTEGER,
  project TEXT,
  author TEXT,
  title TEXT,
  at TEXT
)`);
// Flag : MR ouverte connue qui a disparu de GitLab (mergée/fermée) déjà signalée.
try { db.exec('ALTER TABLE mr ADD COLUMN closed_seen INTEGER DEFAULT 0'); } catch { /* déjà présente */ }

/* Journal des opérations Git multi-dépôts (onglet Git).
   Sert à deux choses : l'historique consultable, et surtout la RESTAURATION.
   Une suppression de branche n'efface pas les commits, elle efface un pointeur :
   en gardant le SHA on peut le reposer. On stocke aussi tag_sha séparément car,
   pour un tag annoté, l'objet tag et le commit ont deux SHA distincts — restaurer
   avec le seul SHA de commit perdrait le message du tag. */
db.exec(`CREATE TABLE IF NOT EXISTS git_op (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  repo_id INTEGER,
  project TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  ref_sha TEXT,
  tag_sha TEXT,
  tag_message TEXT,
  source_ref TEXT,
  status TEXT NOT NULL,
  error TEXT,
  fetched INTEGER DEFAULT 0,
  restored_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_git_op_batch ON git_op(batch_id)');

// Ligne de config unique (id=1). Les gabarits de prompt par défaut vivent dans
// prompts.js, qui les tient dans les deux langues (i18n.md lot 5).
const { PROMPTS } = require('./prompts');
// Convergence (« Converger ») : réglages par défaut (surchargeables au lancement).
// Seuil cible en /10, plafond de passes de correction.
try { db.exec("ALTER TABLE config ADD COLUMN converge_threshold TEXT DEFAULT '8'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN converge_max_passes TEXT DEFAULT '3'"); } catch { /* déjà présente */ }

// Une RUN de convergence rattachée à une MR : la machine à états qui enchaîne
// review → correction IA (commit + push) → re-review incrémentale, jusqu'au seuil,
// à la régression, ou au plafond de passes. L'historique fin (notes par passe) vit
// déjà dans review_version ; cette table porte l'état global de la boucle.
/* ---------- Vérification objective (plan_add_verify.md) ----------
   Un verdict de tests produit HORS du circuit IA : l'orchestrateur appelle un script de
   l'utilisateur, jamais l'agent. Le verdict est un FAIT attaché à des SHAs — il se périme
   si la branche avance — et il n'est jamais bloquant : il informe, l'humain merge. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,               -- kind 'script' : chemin absolu. kind 'commands' : ''
  timeout_s INTEGER NOT NULL DEFAULT 900,
  run_base INTEGER NOT NULL DEFAULT 1, -- double run causal : la base était-elle déjà rouge ?
  comment_on_forge INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);
/* Deux familles de vérificateurs, même verdict, même rapport, mêmes badges :
     'script'   — un exécutable qui s'engage sur le contrat JSON. Multi-dépôts.
     'commands' — une liste de commandes ; le verdict vient des CODES DE SORTIE. Multi-dépôts
                  aussi : la liste est rejouée dans CHAQUE dépôt visé, le verdict est le ET.
   Colonnes idempotentes plutôt qu'une table à part : ce sont des attributs du vérificateur,
   et les bases existantes n'ont qu'à recevoir le défaut 'script' pour rester exactes. */
try { db.exec("ALTER TABLE verifier ADD COLUMN kind TEXT NOT NULL DEFAULT 'script'"); } catch { /* déjà présente */ }
// Ajoutées à l'environnement minimal. Sans elles, un `npm` installé par nvm reste introuvable
// quand Mergerie est lancé par un service plutôt que depuis un terminal.
try { db.exec('ALTER TABLE verifier ADD COLUMN env_json TEXT'); } catch { /* déjà présente */ }
// Rapport JUnit produit par les commandes (chemin RELATIF au dépôt testé) : donne les noms
// des tests là où la sortie ne les livre pas, et sans subir la troncature du journal.
try { db.exec('ALTER TABLE verifier ADD COLUMN report_path TEXT'); } catch { /* déjà présente */ }
// Interpréter le TAP trouvé dans la sortie. Activé par défaut ; l'interrupteur existe pour
// le jour où une sortie exotique déclenche la détection à tort.
try { db.exec('ALTER TABLE verifier ADD COLUMN parse_tap INTEGER NOT NULL DEFAULT 1'); } catch { /* déjà présente */ }

/* Les commandes d'un vérificateur 'commands', DANS L'ORDRE. Une table plutôt qu'une colonne
   JSON : l'ordre est porteur de sens (`npm ci` avant `npm test`) et l'interface les édite
   une par une. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier_command (
  verifier_id INTEGER NOT NULL REFERENCES verifier(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY (verifier_id, position)
)`);

/* Couverture DÉCLARATIVE : quels dépôts ce vérificateur sait tester, et comment. Déclarer
   n'est pas exécuter — un dépôt couvert hors du lot ne sert qu'à consigner le contexte. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier_repo (
  verifier_id INTEGER NOT NULL REFERENCES verifier(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('worktree','in_place')),
  workdir TEXT,                        -- requis en in_place (chemin absolu de l'utilisateur)
  checkout_allowed INTEGER NOT NULL DEFAULT 0,  -- consentement explicite : on va y faire un checkout
  PRIMARY KEY (verifier_id, repo_id)
)`);

// Un lot = des MR (ou des sessions) vérifiées ensemble, parce qu'elles ne valent qu'ensemble.
db.exec(`CREATE TABLE IF NOT EXISTS lot (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mr','session')),
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS lot_member (
  lot_id INTEGER NOT NULL REFERENCES lot(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mr','task')),
  ref_id INTEGER NOT NULL,
  PRIMARY KEY (lot_id, kind, ref_id)
)`);

/* Un rapport de vérification est une ARCHIVE : il dit ce qui a été testé, quand, et avec quel
   verdict. Supprimer le vérificateur ou le lot ne doit donc ni effacer les verdicts déjà
   rendus, ni — pire — être refusé à cause d'eux. Les noms sont recopiés à la création et les
   clés étrangères se détachent. */
db.exec(`CREATE TABLE IF NOT EXISTS verification (
  id INTEGER PRIMARY KEY,
  verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL,
  verifier_name TEXT NOT NULL DEFAULT '',
  lot_id INTEGER REFERENCES lot(id) ON DELETE SET NULL,  -- NULL = MR seule (lot implicite)
  lot_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  verdict TEXT CHECK (verdict IN ('verified_pass','verified_fail','broken_base','verify_error')),
  targets_json TEXT NOT NULL,          -- [{repo_id, mr_id, head_sha, base_sha, branch, mode}]
  context_json TEXT,                   -- dépôts couverts hors lot : sha/branche/dirty constatés
  base_run_json TEXT,
  head_run_json TEXT,
  imputable_json TEXT,                 -- failed(head) − failed(base)
  log_excerpt TEXT,
  started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verification_lot ON verification(lot_id, id)');
/* Échec de restauration d'un répertoire « in place » : signalé de façon PERSISTANTE, jamais
   noyé dans un journal. Le dépôt de l'utilisateur est resté sur un commit détaché. */
try { db.exec('ALTER TABLE verification ADD COLUMN restore_error TEXT'); } catch { /* déjà présente */ }

/* Bases créées avant que le rapport ne devienne une archive : la table portait des clés
   étrangères bloquantes vers `verifier` et `lot`. SQLite ne sait pas modifier une contrainte,
   il faut rebâtir — en recopiant au passage les noms depuis les lignes encore présentes. */
if (!db.prepare('PRAGMA table_info(verification)').all().some((c) => c.name === 'verifier_name')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE verification_new (
    id INTEGER PRIMARY KEY,
    verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL,
    verifier_name TEXT NOT NULL DEFAULT '',
    lot_id INTEGER REFERENCES lot(id) ON DELETE SET NULL,
    lot_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
    verdict TEXT CHECK (verdict IN ('verified_pass','verified_fail','broken_base','verify_error')),
    targets_json TEXT NOT NULL,
    context_json TEXT,
    base_run_json TEXT,
    head_run_json TEXT,
    imputable_json TEXT,
    log_excerpt TEXT,
    started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
    restore_error TEXT
  );
  INSERT INTO verification_new
    SELECT id, verifier_id,
      COALESCE((SELECT name FROM verifier WHERE verifier.id = verification.verifier_id), ''),
      lot_id, (SELECT name FROM lot WHERE lot.id = verification.lot_id),
      status, verdict, targets_json, context_json, base_run_json, head_run_json,
      imputable_json, log_excerpt, started_at, finished_at, created_at, restore_error
    FROM verification;
  DROP TABLE verification;
  ALTER TABLE verification_new RENAME TO verification;
  CREATE INDEX IF NOT EXISTS idx_verification_lot ON verification(lot_id, id);`);
  db.pragma('foreign_keys = ON');
}

/* Le run BASE était mis en cache par jeu de SHAs. Supprimé : le cache pariait sur un
   environnement inchangé — ce que Mergerie ne peut pas vérifier —, et le pari se payait des
   deux côtés (un rouge corrigé hors git restait collé, un vert périmé faisait accuser la
   branche à tort). La table ne contenait que ce cache : rien à conserver. */
try { db.exec('DROP TABLE IF EXISTS verification_run_cache'); } catch { /* déjà absente */ }

db.exec(`CREATE TABLE IF NOT EXISTS convergence_run (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- running | converged | capped | regressed | no_change | error | stopped
  threshold REAL NOT NULL,         -- cible en /10
  max_passes INTEGER NOT NULL,
  passes_done INTEGER DEFAULT 0,   -- nombre de corrections appliquées
  start_note REAL,                 -- note /10 de départ
  best_note REAL,                  -- meilleure note /10 atteinte
  best_version INTEGER,            -- version review_version correspondante
  message TEXT,
  started_at TEXT,
  finished_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_convergence_run_mr ON convergence_run(mr_id)');

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

/* ---------- Notes, todos et rappels (plan_add_notes.md) ----------
   Des notes de POSTE DE TRAVAIL, pas une base de connaissances : des pages plates (ni
   dossiers ni hiérarchie), une liste de todos et des rappels datés. Tout vit dans cette
   base, donc dans la sauvegarde existante — c'est la raison pour laquelle ces post-it
   valent mieux qu'un fichier texte à côté. */
db.exec(`CREATE TABLE IF NOT EXISTS note_page (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_note_page_ordre ON note_page(pinned DESC, updated_at DESC)');

/* `due_at` porte À LA FOIS l'échéance et le rappel — une seule vérité plutôt qu'une entité
   `reminder` séparée qu'il faudrait réconcilier. `reminded_at` empêche la re-notification,
   et tout changement de `due_at` le remet à NULL (voir src/notes.js). `archived_at` sort des
   listes une todo faite depuis plus de sept jours, sans jamais la supprimer. */
db.exec(`CREATE TABLE IF NOT EXISTS todo (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  note TEXT,
  link_kind TEXT CHECK (link_kind IN ('mr','ticket','repo')),
  link_ref TEXT,
  due_at TEXT,
  reminded_at TEXT,
  done_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_due ON todo(status, archived_at, due_at)');

/* UN ORDRE À SOI. Le tri automatique (priorité, puis échéance) répond à « qu'est-ce qui
   presse » ; il ne répond pas à « dans quel ordre je vais m'y prendre ce matin ». Les deux
   coexistent : la liste « à faire » suit désormais l'ordre qu'on lui donne, pendant que la
   priorité et l'échéance continuent d'alimenter le brief et les pastilles du menu.

   APRÈS la création de la table, comme toute migration ici. Le remplissage reprend EXACTEMENT
   l'ordre affiché jusqu'ici : le premier jour, personne ne voit sa liste changer — on ne
   réordonne pas les todos de quelqu'un pour lui annoncer qu'il peut les réordonner. */
try {
  db.exec('ALTER TABLE todo ADD COLUMN position INTEGER');
  db.exec(`UPDATE todo SET position = (SELECT n FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id DESC) AS n
      FROM todo) x WHERE x.id = todo.id)`);
} catch { /* déjà présente */ }
/* Une todo arrivée après la migration n'a pas de position : elle se range en TÊTE (position
   NULL triée en premier), là où on vient de la taper — la chercher en bas d'une liste de
   trente serait absurde. */
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_position ON todo(status, archived_at, position)');

/* CE QU'ON A ÉCARTÉ DU BRIEF. Le brief recalcule tout à chaque ouverture : un fait qui reste
   vrai reparaît tous les matins, même traité ailleurs — une vérification rouge dont on a déjà
   fait le tour revient indéfiniment et finit par apprendre à ne plus lire la section.

   On écarte donc la LIGNE, pas le sujet : la clé est l'identifiant de l'objet vu (ce verdict-ci,
   cette MR-là). Une nouvelle vérification du même lot porte un autre identifiant et reparaît —
   c'est voulu : on a écarté un constat, pas éteint une alarme. Rien n'est supprimé, et tout se
   réaffiche d'un bouton. */
db.exec(`CREATE TABLE IF NOT EXISTS brief_hidden (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
)`);

/* Atterrissage sur le brief à la première ouverture de la journée. En base et non en
   localStorage : c'est un RÉGLAGE (comme la langue), et il doit valoir pour l'outil, pas
   pour un navigateur. La date du dernier affichage, elle, reste locale — deux navigateurs
   ouverts n'ont pas à se voler le brief l'un l'autre. */
try { db.exec("ALTER TABLE config ADD COLUMN brief_on_open TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
/* Au-delà de combien de jours une MR reviewée et toujours ouverte est « dormante ». Cinq
   jours : au-dessous, on signalerait la MR d'avant-hier, qu'on n'a pas oubliée. */
try { db.exec('ALTER TABLE config ADD COLUMN stale_mr_days INTEGER DEFAULT 5'); } catch { /* déjà présente */ }

const DEFAULT_PROMPT_REVIEW = PROMPTS.fr.prompt_review;
const DEFAULT_PROMPT_EXPLAIN = PROMPTS.fr.prompt_explain;
const DEFAULT_PROMPT_MODIFY = PROMPTS.fr.prompt_modify;

const hasConfig = db.prepare('SELECT 1 FROM config WHERE id = 1').get();
if (!hasConfig) {
  db.prepare(`INSERT INTO config
    (id, gitlab_url, access_token, clone_path, prompt_review, prompt_explain, prompt_modify, review_skill)
    VALUES (1, '', '', ?, ?, ?, ?, 'git-review')`)
    .run(DEFAULT_CLONE_DIR, DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY);
}

// Palette de commandes git (onglet « Commandes Git »), gérée dans Réglages → Git.
// `command` = arguments git figés (ex. « fetch --all --prune »), sans le mot « git ».
db.exec(`CREATE TABLE IF NOT EXISTS git_command (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT
)`);
// Amorçage UNE SEULE FOIS (drapeau en config) : quelques commandes usuelles. Supprimer
// toutes les entrées ne les réintroduit donc pas — c'est un choix de l'utilisateur.
try { db.exec("ALTER TABLE config ADD COLUMN git_commands_seeded INTEGER DEFAULT 0"); } catch { /* déjà présente */ }
const seeded = db.prepare('SELECT git_commands_seeded AS s FROM config WHERE id = 1').get();
if (seeded && !seeded.s) {
  const ins = db.prepare('INSERT INTO git_command (label, command, sort_order, created_at) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  [
    ['Récupérer tout (fetch)', 'fetch --all --prune'],
    ['Statut court', 'status --short --branch'],
    ['Tirer (fast-forward only)', 'pull --ff-only'],
    ['Élaguer les branches distantes disparues', 'remote prune origin'],
    ['10 derniers commits', 'log --oneline -10'],
  ].forEach(([label, command], i) => ins.run(label, command, i, now));
  db.prepare('UPDATE config SET git_commands_seeded = 1 WHERE id = 1').run();
}

/* Nettoyage de tables et colonnes qui ne servent plus. Elles ne visent que les bases DÉJÀ EN
   SERVICE — une base neuve ne les crée simplement pas. La donnée qu'elles portaient était
   dérivée, rien à conserver. Idempotents comme les migrations voisines : la seconde exécution
   ne trouve plus rien et ne dit rien. */
try { db.exec('DROP TABLE IF EXISTS health_status'); } catch { /* déjà partie */ }
try { db.exec('ALTER TABLE environment DROP COLUMN health_check'); } catch { /* déjà retirée */ }
try { db.exec('ALTER TABLE config DROP COLUMN health_check'); } catch { /* déjà retirée */ }
try { db.exec('ALTER TABLE config DROP COLUMN health_minutes'); } catch { /* déjà retirée */ }

// Au démarrage : tout job resté "running" a été coupé -> interrupted.
db.prepare(`UPDATE job SET status = 'interrupted', finished_at = ?
            WHERE status IN ('running', 'queued')`).run(new Date().toISOString());

module.exports = db;
module.exports.DEFAULTS = {
  DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY,
};
