'use strict';
const Database = require('better-sqlite3');
const { DB_PATH, DEFAULT_CLONE_DIR, initDirs } = require('./paths');

initDirs();

const { ulid, slugLibre } = require('./ulid');

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

/* RÉPARATION, TOUT EN HAUT, AVANT LA MOINDRE ÉCRITURE.
 *
 * `ALTER TABLE … RENAME` réécrit les références au nom de table DANS LE CORPS DES DÉCLENCHEURS.
 * Une reconstruction de la file d'export (`store_sale`) laissait donc des déclencheurs pointant
 * une table renommée puis supprimée : la première écriture venue — une simple mise à jour de la
 * configuration, quelques lignes plus bas — échouait sur « no such table », et le serveur ne
 * démarrait plus.
 *
 * On les retire ici, avant tout : ils sont recréés en fin de fichier, générés depuis le
 * registre. Une base saine n'en a aucun et ne paie rien. */
for (const t of db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%_ancien%'",
).all()) {
  db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
}

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

/* Un merge de branche à branche EN COURS (onglet Git → Merge). La table ne retient que ce que
   git ne sait pas : quel worktree appartient à quelle demande. Tout le reste — fichiers en
   conflit, contenu, message par défaut — se relit dans le worktree, qui fait foi. */
CREATE TABLE IF NOT EXISTS git_merge (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  dir TEXT NOT NULL,
  status TEXT NOT NULL,                 -- conflict | ready | committed | pushed
  commit_sha TEXT,
  created_at TEXT,
  updated_at TEXT
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
/* De QUOI un job s'occupe-t-il. La table ne portait que `current_mr_id` : rien ne reliait un job
   à la session de codage qu'il exécutait, donc impossible de dire après coup « ce job-là, c'était
   la session sur api-core ». C'est ce qui rend le journal d'activité lisible. */
try { db.exec('ALTER TABLE job ADD COLUMN target_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE job ADD COLUMN target_id INTEGER'); } catch { /* déjà présente */ }
// Migration : date de création de la MR côté GitLab (pour le tri).
try { db.exec('ALTER TABLE mr ADD COLUMN gitlab_created_at TEXT'); } catch { /* déjà présente */ }
/* QUAND LA MERGE REQUEST A ÉTÉ MERGÉE — la date de la FORGE, pas celle où ce poste s'en est
   aperçu. Le délai de cycle se mesurait entre l'ouverture et une ligne du journal d'activité,
   écrite par la découverte au moment où elle cessait de voir la MR ouverte : une approximation
   qui n'existe que sur la machine qui regardait ce jour-là. À plusieurs, elle ne veut plus rien
   dire — et sur un poste qui vient de rejoindre, elle n'existe pas du tout, donc le graphique
   restait vide. La forge, elle, connaît l'instant exact et le même pour tout le monde. */
try { db.exec('ALTER TABLE mr ADD COLUMN merged_at TEXT'); } catch { /* déjà présente */ }
// Migration : auteur de la MR.
try { db.exec('ALTER TABLE mr ADD COLUMN author TEXT'); } catch { /* déjà présente */ }
// Migration : chemin du diff sauvegardé (pour la vue rapport + diff).
try { db.exec('ALTER TABLE review ADD COLUMN diff_path TEXT'); } catch { /* déjà présente */ }
// Migration : note globale numérique (0..1) pour le dashboard.
try { db.exec('ALTER TABLE review ADD COLUMN note_value REAL'); } catch { /* déjà présente */ }
/* Migration : quand le rapport a été publié en commentaire sur la merge request. Une trace,
   pas un drapeau : le bouton « Publier » doit pouvoir dire ce qui est DÉJÀ parti chez les
   autres, sinon on republie le même rapport en croyant que le premier envoi a échoué. */
try { db.exec('ALTER TABLE review ADD COLUMN comment_posted_at TEXT'); } catch { /* déjà présente */ }
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
/* La forge refuse-t-elle de fusionner cette merge request ? 1 / 0 / NULL (pas encore su).
   Relevé au moment où l'on ouvre la modale de merge : on est alors à un clic d'une action
   irréversible, un appel d'API pour le dire avant vaut mieux qu'un refus après. */
try { db.exec('ALTER TABLE mr ADD COLUMN has_conflicts INTEGER'); } catch { /* déjà présente */ }
/* BROUILLON (« Draft »/« WIP ») et REVIEWERS DEMANDÉS, relevés à la découverte. Les deux
   viennent de la liste déjà parcourue — on les jetait. Un brouillon n'est pas prêt à être
   relu : la review automatique lui dépensait un appel IA, et rien à l'écran ne disait
   pourquoi ce rapport semblait porter sur du travail inachevé. `reviewers` est stocké en
   texte séparé par des virgules : on ne cherche jamais dedans, on ne fait que l'afficher et
   dire « on m'a demandé de la relire ». */
/* CE QUE LA MERGE REQUEST DIT D'ELLE-MÊME. Sans Jira configuré, l'IA ne connaissait que le
   diff : elle jugeait du code sans savoir ce qu'il prétendait faire, et relevait comme des
   manques des choix assumés, écrits dans la description. Bornée à 4 000 caractères à
   l'écriture — au-delà, c'est le diff qu'on ampute. */
try { db.exec("ALTER TABLE mr ADD COLUMN description TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN is_draft INTEGER'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE mr ADD COLUMN reviewers TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_error TEXT'); } catch { /* déjà présente */ }
/* LE STATUT DU TICKET, POUR TOUTES LES MR — pas seulement celles dont le ticket est surveillé.
   La découverte lit déjà l'issue en entier pour en tirer le contexte : ranger son statut à côté
   ne coûte aucun appel, et fait apparaître « ticket en revue » là où on choisit quoi reviewer. */
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_status TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_category TEXT'); } catch { /* déjà présente */ }
// Migration : chemins des fichiers modifiés par la MR (pour le badge « risque » et
// les règles par chemin), un par ligne. Rempli au discover / à la review.
try { db.exec('ALTER TABLE mr ADD COLUMN changed_paths TEXT'); } catch { /* déjà présente */ }
/* La TAILLE du changement, relevée avec les chemins (même appel) : « 12 fichiers · +340 −80 »
   sur la carte, c'est ce qui décide par quoi commencer sans ouvrir trois merge requests. */
try { db.exec('ALTER TABLE mr ADD COLUMN changed_files INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN changed_additions INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN changed_deletions INTEGER'); } catch { /* déjà présente */ }
/* Options de merge choisies à la création de la MR. GitLab les applique nativement dès
   la création ; GitHub ne sait pas les exprimer là (ce sont des décisions de merge), on
   les mémorise donc ici pour pré-cocher — et appliquer — la modale de merge. */
try { db.exec('ALTER TABLE mr ADD COLUMN squash INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN remove_source_branch INTEGER'); } catch { /* déjà présente */ }
// Migration : règles de review par CHEMIN de fichier (glob) — plus précis que la
// branche. Une règle peut avoir branch_match et/ou path_match. label = badge court.
try { db.exec('ALTER TABLE review_rule ADD COLUMN path_match TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE review_rule ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
/* A/Réglages 2 — UNE RÈGLE PEUT NE VALOIR QUE POUR UN DÉPÔT. Sans cette colonne, la seule
   façon de limiter la portée d'une règle était de deviner un `path_match` que seul ce dépôt
   satisferait — ce qui n'est pas toujours possible, et jamais lisible. NULL = tous les dépôts,
   c'est-à-dire le comportement d'avant : les règles existantes ne changent pas de portée. */
try { db.exec('ALTER TABLE review_rule ADD COLUMN repo_id INTEGER'); } catch { /* déjà présente */ }
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
/* Cadence de rafraîchissement de l'onglet Jenkins, en minutes (0 = jamais). En base et non en
   localStorage, comme celle des MR et celle de Jira : c'est un réglage de l'OUTIL, et il doit
   valoir quel que soit le navigateur d'où on le regarde. */
try { db.exec('ALTER TABLE config ADD COLUMN jenkins_refresh_minutes INTEGER DEFAULT 1'); } catch { /* déjà présente */ }
/* Plafond de vérifications automatiques par tour de découverte. Un lundi matin en ramène
   quinze : quinze batteries fonctionnelles saturent la machine et bloquent la file partagée
   avec les reviews. Le bon chiffre dépend de la machine et de la durée des suites — il se règle
   donc, au lieu d'être une constante que seul le code connaît. 0 = aucune limite (assumé). */
try { db.exec('ALTER TABLE config ADD COLUMN verif_auto_max INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
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
/* ---------- La dernière exécution d'une cible Makefile ----------
   « Ai-je déjà passé les migrations ce matin ? » se répondait en relisant un journal de jobs.
   Une ligne par (répertoire, cible), écrasée à chaque lancement : ce qui compte est le
   DERNIER, pas l'historique. Purement local — Docker et make n'en savent rien. */
db.exec(`CREATE TABLE IF NOT EXISTS make_run (
  dir TEXT NOT NULL,
  target TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  PRIMARY KEY (dir, target)
)`);

/* À QUOI SE RATTACHE UNE DÉPENSE. La table comptait des tokens PAR FAMILLE (review, task,
   explore…) : on savait combien coûtaient les sessions, jamais LESQUELLES. Deux colonnes
   suffisent — l'objet et son identifiant —, et le classement des sessions les plus chères
   devient une requête au lieu d'une estimation. Anciennes lignes : colonnes nulles, elles
   restent comptées dans leur famille. */
try { db.exec('ALTER TABLE usage ADD COLUMN owner_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE usage ADD COLUMN owner_id INTEGER'); } catch { /* déjà présente */ }
// Coût annoncé par le backend, à côté de l'estimation en tokens (cf. `agent_pass.cost_usd`).
try { db.exec('ALTER TABLE usage ADD COLUMN cost_usd REAL'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_usage_owner ON usage(owner_kind, owner_id)');

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

/* REPÉRER UNE ITÉRATION PARMI VINGT. Le numéro et la date ne disent rien de ce qui s'y est
   joué : on marque donc les quelques passes qui comptent (`favori`) et on leur donne un nom
   (`titre`). Ni l'un ni l'autre ne part à l'agent — c'est du rangement, écrit pour l'humain
   qui parcourt la colonne. Migrations APRÈS le `CREATE TABLE` : plus haut, l'ALTER échoue sur
   une table absente et le `catch` l'avale sans un mot. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN favori INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN titre TEXT'); } catch { /* déjà présente */ }
/* COÛT RÉEL D'UNE PASSE, en dollars, quand le backend le donne (`result.total_cost_usd` du
   flux `claude`). L'estimation en tokens reste : elle couvre les backends qui ne disent rien.
   Nulle sur toute passe antérieure, et sur tout backend muet — l'affichage doit le supporter. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN cost_usd REAL'); } catch { /* déjà présente */ }
/* LE DIFF D'UNE SEULE ITÉRATION. Relire une session de codage revenait à relire TOUT le diff
   de la branche à chaque suivi : la correction de trois lignes qu'on vient de demander se
   cherchait au milieu de deux cents. On retient donc les deux bornes de la passe — le HEAD
   avant qu'elle ne commence, celui qu'elle laisse — et le patch qui les sépare. Nulles sur
   toute passe antérieure, sur une passe qui n'a rien commité (l'agent a posé des questions) et
   sur tout le hors-dépôt, qui n'a pas de git : l'affichage doit le supporter.
   `head_sha` sans `diff_path` n'est pas une anomalie : c'est une itération qui n'a rien changé
   au code, et le dire vaut mieux qu'ouvrir une vue vide. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN base_sha TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN head_sha TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN diff_path TEXT'); } catch { /* déjà présente */ }
/* APRÈS la création de la table, et pas avant : un `ALTER` posé plus haut dans ce fichier
   échoue sur une table qui n'existe pas encore, et le `catch` l'avale sans un mot. La colonne
   n'apparaît alors que sur les bases où la table préexistait — le genre de différence qui ne
   se voit qu'en production. */
try { db.exec('ALTER TABLE local_task ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_draft TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* UNE SESSION EST UN PROCESSUS, PAS UN PRODUIT — et elle se partage donc UNE PAR UNE.
 *
 * Ce qu'une session porte, c'est la façon dont quelqu'un a travaillé : le prompt tel qu'il l'a
 * tapé, ses trois relances, la question qu'il n'osait poser à personne, la capture collée qui
 * montre un autre onglet, et le coût en dollars de chaque essai. Le RÉSULTAT, lui, est déjà
 * partagé par un autre canal — la branche et la merge request sur la forge, la carte du code,
 * la page de notes qu'un agent a produite. Partager le processus en bloc, c'est publier le
 * brouillon avec le livre.
 * Même mécanique que les pages de notes, et pas une seconde : une colonne `shared`, `DEFAULT 0`,
 * et le registre qui décide ligne par ligne. Les sessions déjà écrites deviennent donc privées,
 * et leurs fichiers SORTENT du dépôt au premier démarrage (repère `sessions_unshared_swept`).
 * Migrations APRÈS les `CREATE TABLE` correspondants. */
try { db.exec('ALTER TABLE task ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE question ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }


/* LES PIÈCES JOINTES D'UNE SESSION — captures ET documents, une seule table.
 *
 * Une capture d'écran et un PDF de spécification sont la même chose pour l'agent : un fichier
 * à ouvrir. Les tenir dans deux familles de tables aurait fait deux enregistrements, deux
 * lectures, deux blocs de prompt et quatre saveurs à recâbler à chaque fois — pour une
 * distinction qui ne compte qu'à l'affichage (vignette ou nom de fichier).
 *
 * `scope` distingue les familles, comme `agent_pass` : 'task' (codage sur dépôt et
 * exploration), 'local' (hors dépôt), 'ask' (question libre). Pas de clé étrangère possible —
 * trois tables parentes — donc le ménage est explicite à la suppression.
 *
 * `name` est le nom D'ORIGINE, montré à l'écran et donné à l'agent ; le fichier sur disque, lui,
 * porte un nom fabriqué : un nom venu de l'extérieur n'a rien à faire dans un chemin. */
db.exec(`CREATE TABLE IF NOT EXISTS piece_jointe (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  followup INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_piece_jointe_owner ON piece_jointe(scope, owner_id)');

/* Reprise des captures déjà en base. Les deux anciennes tables sont recopiées puis RETIRÉES :
   laisser une table morte derrière soi, c'est garantir qu'un jour quelqu'un l'interrogera et
   lira un état d'il y a six mois. Les fichiers sur disque, eux, ne bougent pas — seule la ligne
   change de table. Idempotent : la table disparue, la reprise ne se pose plus. */
for (const [ancienne, scope] of [['task_image', 'task'], ['local_task_image', 'local']]) {
  try {
    const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ancienne);
    if (!existe) continue;
    /* `followup` est arrivée en cours de route : une base plus ancienne ne l'a pas, et le
       SELECT échouerait dessus. On lit les colonnes réellement présentes plutôt que d'ajouter
       une colonne à une table qu'on s'apprête à supprimer. */
    const colonnes = db.prepare(`PRAGMA table_info(${ancienne})`).all().map((c) => c.name);
    const suivi = colonnes.includes('followup') ? 'followup' : '0';
    db.exec(`INSERT INTO piece_jointe (scope, owner_id, path, name, mime, followup, created_at)
      SELECT '${scope}', task_id, path, path, NULL, ${suivi}, NULL FROM ${ancienne}`);
    db.exec(`DROP TABLE ${ancienne}`);
    /* Le nom affiché est le nom de FICHIER, pas le chemin : ces captures-là n'en avaient pas
       d'autre (elles étaient collées, sans nom d'origine), et montrer `/Users/…/img_3.png`
       dans une puce de formulaire n'apprend rien. */
    const majNom = db.prepare('UPDATE piece_jointe SET name = ? WHERE id = ?');
    for (const l of db.prepare("SELECT id, name FROM piece_jointe WHERE scope = ? AND name LIKE '%/%'").all(scope)) {
      majNom.run(l.name.split('/').filter(Boolean).pop() || l.name, l.id);
    }
  } catch { /* reprise best-effort : une capture perdue ne doit pas empêcher l'app de démarrer */ }
}

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
const { PROMPTS, ANCIENS_PROMPTS } = require('./prompts');
// Convergence (« Converger ») : réglages par défaut (surchargeables au lancement).
// Seuil cible en /10, plafond de passes de correction.
try { db.exec("ALTER TABLE config ADD COLUMN converge_threshold TEXT DEFAULT '8'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN converge_max_passes TEXT DEFAULT '3'"); } catch { /* déjà présente */ }

// Une RUN de convergence rattachée à une MR : la machine à états qui enchaîne
// review → correction IA (commit + push) → re-review incrémentale, jusqu'au seuil,
// à la régression, ou au plafond de passes. L'historique fin (notes par passe) vit
// déjà dans review_version ; cette table porte l'état global de la boucle.
/* A26 — DÉTECTER LES TESTS INSTABLES, sans rien demander à personne. Un test rouge à un run
   et vert au suivant SANS QUE LE CODE AIT BOUGÉ n'est pas un test qui casse : c'est un test
   qui ment, et il coûte plus cher qu'un échec franc — on relance, on hausse les épaules, et le
   jour où il dit vrai on ne le croit plus.

   Ce qu'il faut pour le savoir tient en trois colonnes : le CODE testé (`targets_key` : les
   couples dépôt:sha triés — deux runs sur le même code sont comparables, sur des codes
   différents ils ne le sont pas), et le nom des tests ROUGES de ce run. Une ligne à `test`
   NULL marque le run lui-même : sans elle, un run tout vert ne laisserait aucune trace et on
   ne saurait pas qu'un test rouge ailleurs a été vert ici.

   Seuls les runs qui NOMMENT leurs tests (TAP, JUnit) y entrent : sans noms, il n'y a rien à
   apparier. Purgée par la rétention, comme les autres traces. */
db.exec(`CREATE TABLE IF NOT EXISTS verify_run_test (
  id INTEGER PRIMARY KEY,
  verification_id INTEGER NOT NULL REFERENCES verification(id) ON DELETE CASCADE,
  verifier_id INTEGER,
  targets_key TEXT NOT NULL,
  test TEXT,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verify_run_test ON verify_run_test(verifier_id, targets_key)');

/* ---------- Vérification objective (plan_add_verify.md) ----------
   Un verdict de tests produit HORS du circuit IA : l'orchestrateur appelle un script de
   l'utilisateur, jamais l'agent. Le verdict est un FAIT attaché à des SHAs — il se périme
   si la branche avance — et il n'est jamais bloquant : il informe, l'humain merge. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,               -- toujours '' : les commandes vivent dans verifier_command
  timeout_s INTEGER NOT NULL DEFAULT 900,
  run_base INTEGER NOT NULL DEFAULT 1, -- double run causal : la base était-elle déjà rouge ?
  comment_on_forge INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);
/* `kind` vaut désormais TOUJOURS 'commands' : une liste de commandes rejouée dans chaque dépôt
   visé, le verdict venant des CODES DE SORTIE.

   La colonne SURVIT à la disparition de l'autre famille ('script' : un exécutable s'engageant
   sur un contrat JSON, retirée en 2.0). Les lignes héritées gardent donc leur valeur : elles
   restent visibles dans les réglages, marquées comme telles, et le serveur REFUSE de les
   lancer. Supprimer la colonne aurait effacé la distinction — et avec elle la seule chose qui
   permet d'expliquer à quelqu'un pourquoi son vérificateur ne part plus.
   Le DÉFAUT reste 'script' : il ne s'applique qu'aux lignes créées avant cette migration, et
   le changer réécrirait leur histoire. Toute création passe par le serveur, qui impose
   'commands'. */
try { db.exec("ALTER TABLE verifier ADD COLUMN kind TEXT NOT NULL DEFAULT 'script'"); } catch { /* déjà présente */ }
/* « Automatique » : ce vérificateur part sur toute NOUVELLE merge request des dépôts qu'il
   couvre. Sur le vérificateur et non sur chaque ligne de couverture — automatique ici et
   manuel là est un besoin qu'on n'a pas, et la colonne se déplacera sans casser les données
   le jour où il apparaît. Défaut 0 : rien ne se met à tourner tout seul sans qu'on le demande. */
try { db.exec('ALTER TABLE verifier ADD COLUMN auto_on_mr INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
/* « Relancer quand le verdict se périme » : la MR a reçu de nouveaux commits, le vert obtenu
   sur l'ancien SHA ne vaut plus rien. Séparé de `auto_on_mr` — vérifier une MR à son arrivée et
   la revérifier à chaque poussée sont deux appétits différents : la seconde multiplie la charge
   par le nombre de commits, et c'est un choix qui doit s'assumer ligne par ligne. */
try { db.exec('ALTER TABLE verifier ADD COLUMN auto_on_stale INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
/* Le gabarit du commentaire publié sur la merge request. Vide = le gabarit par défaut, qui vit
   dans `verify.js` — on ne le recopie PAS en base : un défaut recopié se fige, et l'améliorer
   n'atteindrait plus personne. */
try { db.exec("ALTER TABLE verifier ADD COLUMN comment_template TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Les personnes à prévenir quand ça casse — du texte libre repris tel quel dans le commentaire
   (`@amady @bruno`, ou `@mon-groupe`, plus robuste qu'une liste qui bouge). C'est la FORGE qui
   résout les mentions et envoie les mails ; Mergerie ne fait que les écrire. Un identifiant
   numérique ne marche pas : GitLab résout le handle, pas l'id. */
try { db.exec("ALTER TABLE verifier ADD COLUMN mentions TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Ajoutées à l'environnement minimal. Sans elles, un `npm` installé par nvm reste introuvable
// quand Mergerie est lancé par un service plutôt que depuis un terminal.
try { db.exec('ALTER TABLE verifier ADD COLUMN env_json TEXT'); } catch { /* déjà présente */ }
/* LES NOMS SONT D'ÉQUIPE, LES VALEURS NON. Une variable de commande de test est le lieu naturel
   d'un `DATABASE_URL` ou d'un `NPM_TOKEN`, et la liste noire du registre ne regarde que le NOM DE
   COLONNE — `env_json` n'y ressemble pas, donc rien ne l'arrêtait. Le vérificateur reste un
   produit d'équipe : on partage les NOMS qu'il attend, pour que le collègue sache quoi
   renseigner, et les valeurs vivent dans `local_state` sur le poste qui les a saisies.
   `env_json` est donc VIDÉE puis GELÉE, comme les jetons de `config`. */
try { db.exec('ALTER TABLE verifier ADD COLUMN env_keys TEXT'); } catch { /* déjà présente */ }
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
/* Ce qui a été PUBLIÉ, et quand. Sans cette trace, l'écran repropose « Publier » comme si de
   rien n'était et on poste deux fois le même verdict sur la merge request de quelqu'un. */
try { db.exec('ALTER TABLE verification ADD COLUMN comment_posted_at TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE verification ADD COLUMN comment_targets TEXT'); } catch { /* déjà présente */ }

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
/* LES SOUS-PAGES. Une documentation tient rarement en une page : un texte général, et le
   détail de chaque point à côté. Tout mettre dans une seule page la rend illisible ; en faire
   vingt pages sœurs perd le lien entre elles. Un seul niveau, volontairement — une
   arborescence profonde se navigue mal dans une colonne de 300 pixels, et « le détail du
   détail » est le signe qu'il fallait une page de plus, pas un étage de plus. Le parent
   emporte ses sous-pages (cascade, `foreign_keys = ON` en tête de ce fichier).
   Migration APRÈS le `CREATE TABLE note_page` ci-dessus. */
try { db.exec('ALTER TABLE note_page ADD COLUMN parent_id INTEGER REFERENCES note_page(id) ON DELETE CASCADE'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_note_page_parent ON note_page(parent_id)');
/* UNE PAGE DE NOTES SE PARTAGE UNE PAR UNE, ET PAR DÉFAUT NON. Les notes sont le seul endroit
   de l'outil où l'on écrit sans destinataire : un brouillon, un mot de passe temporaire collé
   le temps d'un test, ce qu'on pense d'une architecture avant de savoir le dire. Tout le reste
   du travail accumulé est un produit — une review, une règle, une carte du code — et se partage
   donc en bloc. Les notes, non : elles montent dans le dépôt d'équipe QUAND ON LE DIT.
   `DEFAULT 0` et non `1` : le défaut d'une case qui publie doit être « non ». Une page déjà
   écrite avant cette colonne reste donc à soi, ce qui est aussi le seul défaut rattrapable —
   l'inverse aurait poussé des brouillons chez tout le monde au premier démarrage.
   Migration APRÈS le `CREATE TABLE note_page` ci-dessus. */
try { db.exec('ALTER TABLE note_page ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* Captures collées DANS une page de notes. Le fichier vit sur disque, la page ne garde qu'un
   lien Markdown : mettre l'image en base64 dans `content` ferait grossir la ligne de plusieurs
   mégaoctets et la renverrait en entier à chaque sauvegarde automatique — c'est-à-dire toutes
   les secondes pendant qu'on écrit. La suppression de la page emporte les lignes (cascade) ;
   les fichiers, eux, sont retirés explicitement (voir la route DELETE). */
db.exec(`CREATE TABLE IF NOT EXISTS note_image (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES note_page(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_note_image_page ON note_image(page_id)');

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
  link_kind TEXT CHECK (link_kind IN ('mr','ticket','repo','branch','verification','build','container')),  -- cf. B16 plus bas
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

/* LES TODOS QUE L'OUTIL POSE LUI-MÊME. Une session de dev qui s'arrête sur une question attend
   — parfois des heures, parce qu'on est passé à autre chose et que rien ne le rappelle. Elle
   pose donc sa propre todo, et la referme quand on a répondu.

   Une colonne à part plutôt que `link_kind` : celui-ci est contraint par un CHECK (mr/ticket/
   repo) et sert le lien que l'UTILISATEUR choisit. Mélanger les deux obligerait à reconstruire
   la table pour ajouter un type, et brouillerait « ce que j'ai lié » avec « ce que l'outil a
   posé ». `auto_ref` porte de quoi la retrouver pour la fermer. */
try { db.exec('ALTER TABLE todo ADD COLUMN auto_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE todo ADD COLUMN auto_ref TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_auto ON todo(auto_kind, auto_ref)');

/* B16 — CE À QUOI UNE TODO PEUT SE LIER. Le `CHECK` d'origine ne connaissait que trois objets
   (`mr`, `ticket`, `repo`), et le bouton « Ajouter aux todos » n'existait donc que là où ils
   vivent — la fiche de review et la carte Jira. Or « rebaser cette branche avant lundi »,
   « ce vérificateur est rouge depuis mardi », « ce build casse une fois sur trois », « ce
   conteneur retombe » sont exactement les choses qu'on se note, et elles n'avaient nulle part
   où s'accrocher : on les écrivait en texte libre, sans lien pour y retourner.

   SQLite ne sait pas modifier une contrainte : on RECONSTRUIT la table (deuxième et dernière
   migration de ce fichier à le faire, cf. `service_url`). Tout est recopié tel quel — une todo
   n'est jamais perdue par une migration —, et la table repart avec les mêmes index. */
{
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todo'").get() || {}).sql || '';
  if (sql.includes("link_kind IN ('mr','ticket','repo')")) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE todo_v2 (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
        note TEXT,
        link_kind TEXT CHECK (link_kind IN ('mr','ticket','repo','branch','verification','build','container')),
        link_ref TEXT,
        due_at TEXT,
        reminded_at TEXT,
        done_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        position INTEGER,
        auto_kind TEXT,
        auto_ref TEXT
      )`);
      db.exec(`INSERT INTO todo_v2 (id, title, priority, status, note, link_kind, link_ref, due_at,
          reminded_at, done_at, archived_at, created_at, updated_at, position, auto_kind, auto_ref)
        SELECT id, title, priority, status, note, link_kind, link_ref, due_at,
          reminded_at, done_at, archived_at, created_at, updated_at, position, auto_kind, auto_ref
        FROM todo`);
      db.exec('DROP TABLE todo');
      db.exec('ALTER TABLE todo_v2 RENAME TO todo');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_due ON todo(status, archived_at, due_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_position ON todo(status, archived_at, position)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_auto ON todo(auto_kind, auto_ref)');
    })();
    db.pragma('foreign_keys = ON');
  }
}

/* UNE TODO EST PERSONNELLE PAR NATURE — elle se partage donc une par une, comme une session.
 *
 * Deux indices le disaient déjà : `reminded_at` est local (« un rappel est personnel »), et les
 * todos AUTOMATIQUES naissent de sources classées locales — la veille Jira, la question posée
 * par un agent au milieu d'une session. Partagées en bloc, la veille d'un collègue remplissait
 * la liste de tout le monde. Une todo d'équipe existe (« relire le lot X avant vendredi »),
 * mais c'est la case à cocher, pas le défaut.
 * Migration APRÈS le `CREATE TABLE todo` — y compris la variante `todo_v2` renommée ci-dessus,
 * d'où la place de cette ligne. */
try { db.exec('ALTER TABLE todo ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

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
/* ---------- B8 : quel job Jenkins déploie quel dépôt ----------
   « La QA veut !217 en recette » : on ouvrait Jenkins, on cherchait `api-deploy-recette` dans
   deux cents jobs, on recopiait la branche sans faute de frappe. Le lien dépôt ↔ job se
   déclare une fois — comme service ↔ dépôt dans Liens — et la carte d'une merge request
   VÉRIFIÉE VERTE propose alors le job, la branche pré-remplie. `param` : le nom du paramètre
   Jenkins qui reçoit la branche (souvent `BRANCH`, parfois `VERSION`) ; vide, on ne
   pré-remplit rien et la fiche s'ouvre telle quelle. */
db.exec(`CREATE TABLE IF NOT EXISTS repo_jenkins (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  job_path TEXT NOT NULL,
  param TEXT,
  UNIQUE(repo_id, job_path)
)`);

/* Cocher une todo liée quand sa merge request est mergée. Coché par défaut : la todo perd sa
   raison d'être au merge, et la cocher soi-même après coup est le geste qu'on oublie. */
try { db.exec("ALTER TABLE config ADD COLUMN todo_close_on_merge TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
/* Au-delà de combien de jours une MR reviewée et toujours ouverte est « dormante ». Cinq
   jours : au-dessous, on signalerait la MR d'avant-hier, qu'on n'a pas oubliée. */
try { db.exec('ALTER TABLE config ADD COLUMN stale_mr_days INTEGER DEFAULT 5'); } catch { /* déjà présente */ }

/* Consignes permanentes ajoutées à toutes les sessions de codage (dépôt et hors dépôt). */
try { db.exec('ALTER TABLE config ADD COLUMN ai_extra_instructions TEXT'); } catch { /* déjà présente */ }

/* LE GABARIT DE CORRECTION, qui applique un rapport de revue au code. Il vivait en dur et en
   français, recopié à l'identique dans « Faire corriger par l'IA » et dans chaque passe de
   Converger : ni traduit, ni éditable, et deux copies vouées à diverger. Vide = le défaut de
   la langue courante s'applique (`src/prompts.js`), comme pour les trois autres gabarits. */
try { db.exec("ALTER TABLE config ADD COLUMN prompt_fix TEXT DEFAULT ''"); } catch { /* déjà présente */ }

/* A38 — QUAND CHAQUE CONNEXION A ÉTÉ TESTÉE POUR LA DERNIÈRE FOIS, et avec quel résultat. Le
   bouton « Tester » répondait à l'écran et n'en gardait rien : au retour dans les réglages, les
   quatre connexions étaient muettes — « GitLab marche-t-il encore ? » se rejouait à chaque
   fois. Une ligne par service, écrite par le test lui-même ; rien n'est sondé en fond, c'est le
   souvenir d'un geste, pas une surveillance. */
db.exec(`CREATE TABLE IF NOT EXISTS conn_test (
  service TEXT PRIMARY KEY,            -- gitlab | github | jira | jenkins
  ok INTEGER NOT NULL,
  detail TEXT,                         -- ce que le service a répondu (compte, login, nb de jobs)
  tested_at TEXT NOT NULL
)`);

/* LE SKILL DE REVIEW N'A PLUS DE CHAMP : il s'écrit dans le gabarit de prompt, là où l'on
   choisit déjà tout le reste de ce qu'on demande à l'IA. Les gabarits enregistrés portent
   encore `{skill}`, un trou qui ne serait plus rempli par personne — il partirait tel quel à
   l'agent. On y recopie donc une bonne fois le skill configuré (`git-review` à défaut). La
   valeur choisie n'est pas perdue, elle change simplement de place ; et un gabarit resté au
   défaut redevient exactement le défaut, donc suit encore les changements de langue.

   Rejouable sans dommage : après le premier passage il n'y a plus de `{skill}` à remplacer.
   Placée APRÈS le `CREATE TABLE config`, sans quoi elle échouerait sur une base neuve. */
db.exec(`UPDATE config SET
  prompt_review  = REPLACE(prompt_review,  '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review')),
  prompt_explain = REPLACE(prompt_explain, '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review')),
  prompt_modify  = REPLACE(prompt_modify,  '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review'))
  WHERE prompt_review LIKE '%{skill}%' OR prompt_explain LIKE '%{skill}%' OR prompt_modify LIKE '%{skill}%'`);

/* LE GABARIT LIVRÉ N'INVOQUE PLUS DE SKILL. Celui qui installe Mergerie n'a pas `git-review`,
   et sa première review demandait pourtant à l'agent de s'en servir. Les installations
   existantes portent encore cet ancien texte : on le remplace par le nouveau défaut de la MÊME
   langue, mais UNIQUEMENT s'il est resté rigoureusement identique — un gabarit modifié, ne
   serait-ce que d'un caractère, appartient à son auteur et n'est pas touché.

   Sans cela il resterait tel quel pour toujours : ne correspondant plus à aucun défaut connu,
   il serait tenu pour personnalisé et ne suivrait même plus les changements de langue.

   Rejouable : après le premier passage, plus aucune ligne ne correspond.
   Placée APRÈS le `CREATE TABLE config`, comme la précédente. */
for (const lang of ['fr', 'en']) {
  db.prepare('UPDATE config SET prompt_review = ? WHERE prompt_review = ?')
    .run(PROMPTS[lang].prompt_review, ANCIENS_PROMPTS[lang].prompt_review);
}

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
/* Review automatique à l'arrivée d'une merge request, et son plafond par tour de découverte.
   Décochée par défaut, et plafonnée même une fois cochée : chaque review est un appel IA
   facturé, et la PREMIÈRE découverte d'une installation neuve ramène toutes les MR ouvertes
   du parc d'un coup. Un lundi matin ne doit pas se solder par trente appels non demandés. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_review_new TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN review_auto_max INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
/* Re-review automatique quand le rapport se périme (la branche a avancé depuis la review).
   Séparée de la précédente et décochée elle aussi : reviewer à l'arrivée et suivre une branche
   qui bouge sont deux dépenses différentes, et la seconde se répète à chaque poussée. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_rereview_stale TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* QUI EXÉCUTE LES POLITIQUES AUTOMATIQUES. Réglage d'ÉQUIPE, comme les cases qu'il commande :
   sans lui, deux postes allumés reviewaient deux fois la même merge request — deux appels d'IA,
   deux facturations, deux commentaires sur la forge. Vide = personne n'agit (en mode partagé) ;
   en mono-poste, il est ignoré et tout se comporte comme avant. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_runner TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Publication automatique du rapport de review sur la merge request. DÉCOCHÉ PAR DÉFAUT,
   contrairement à `review_explain` : écrire chez les autres est une décision, et une
   installation neuve ne doit surprendre personne au premier lancement de review. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_post_review TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* Filtre de cette publication : n'envoyer que les rapports qui contiennent au moins un
   constat « blocker ». Décoché par défaut — la publication automatique existante ne doit pas
   se mettre à taire des rapports du seul fait d'une migration. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_post_blocking_only TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* L'amorçage des commandes git a déménagé À LA FIN de ce fichier : son drapeau
   (`git_commands_seeded`) est devenu une donnée de POSTE, et il faut donc que `local_config`
   existe et soit remplie avant de le lire. Lu ici, il aurait valu 0 sur une installation qui
   a déjà ses commandes, et les cinq entrées seraient revenues en double à chaque démarrage. */

/* Nettoyage de tables et colonnes qui ne servent plus. Elles ne visent que les bases DÉJÀ EN
   SERVICE — une base neuve ne les crée simplement pas. La donnée qu'elles portaient était
   dérivée, rien à conserver. Idempotents comme les migrations voisines : la seconde exécution
   ne trouve plus rien et ne dit rien. */
try { db.exec('DROP TABLE IF EXISTS health_status'); } catch { /* déjà partie */ }
try { db.exec('ALTER TABLE environment DROP COLUMN health_check'); } catch { /* déjà retirée */ }
/* ---------- Dictée vocale (whisper.md) ----------
   Treize réglages, tous OPT-IN : `off` par défaut, donc aucun micro à l'écran tant qu'on n'a
   rien choisi. Placées APRÈS le `CREATE TABLE config`, comme toutes les migrations de cette
   table — avant, elles lèveraient « no such table » sur une base neuve et le catch vide
   l'avalerait (la colonne n'existerait alors que sur les bases où la table préexistait). */
try { db.exec("ALTER TABLE config ADD COLUMN dictation_provider TEXT DEFAULT 'off'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_model TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_vad_model TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_command TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_url TEXT DEFAULT 'https://api.openai.com'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_api_key TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_remote_model TEXT DEFAULT 'gpt-4o-mini-transcribe'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_language TEXT DEFAULT 'auto'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_vocabulary TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_replacements TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN dictation_silence_ms INTEGER DEFAULT 700'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN dictation_final_pass TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN dictation_idle_minutes INTEGER DEFAULT 15'); } catch { /* déjà présente */ }

try { db.exec('ALTER TABLE config DROP COLUMN health_check'); } catch { /* déjà retirée */ }
try { db.exec('ALTER TABLE config DROP COLUMN health_minutes'); } catch { /* déjà retirée */ }

/* ---------- AGENTS : des profils de session ----------
   Un « agent » Mergerie n'est pas un orchestrateur : c'est ce qu'on met AUTOUR d'un lancement
   du CLI — un rôle, un périmètre, des outils, des skills, des sous-agents, une sortie, un
   horaire. Un RUN d'agent est une `task` ordinaire portant `agent_id` : suivis, questions,
   passes archivées, file de jobs et coût viennent sans une ligne de plus.

   `builtin_key` marque les agents LIVRÉS (l'enquêteur, le documentaliste, le cartographe) :
   modifiables comme les autres, restaurables d'un bouton. `knowledge_prompt` non nul marque un
   agent de DOMAINE — pas de colonne de famille, la présence du sujet suffit à le dire. */
db.exec(`CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  builtin_key TEXT,
  kind TEXT NOT NULL DEFAULT 'explore' CHECK (kind IN ('explore','code')),
  scope_kind TEXT NOT NULL DEFAULT 'all_repos' CHECK (scope_kind IN ('repos','all_repos')),
  system_prompt TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT '',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  disallowed_tools_json TEXT NOT NULL DEFAULT '[]',
  max_turns INTEGER,
  skills_json TEXT NOT NULL DEFAULT '[]',
  subagents_json TEXT NOT NULL DEFAULT '{}',
  output_kind TEXT NOT NULL DEFAULT 'report' CHECK (output_kind IN ('report','note_page','agent')),
  output_ref TEXT,
  knowledge_prompt TEXT,
  schedule TEXT,
  schedule_fired_at TEXT,
  defaults_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS agent_repo (
  agent_id INTEGER NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  branch TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('target','readonly')),
  PRIMARY KEY (agent_id, repo_id)
)`);
/* La connaissance d'un agent de domaine : un document Markdown VERSIONNÉ et daté par le SHA
   de chaque dépôt au moment où il a été écrit. C'est ce SHA qui permet de dire, sans IA, que
   la carte a vieilli — `git log <sha>..origin/<défaut> -- <chemins>` compte les commits qui
   ont touché ce qu'elle cite. Une seule version `active` à la fois, garantie par l'index. */
db.exec(`CREATE TABLE IF NOT EXISTS agent_knowledge (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  md_path TEXT NOT NULL,
  repos_json TEXT NOT NULL DEFAULT '[]',
  task_id INTEGER,
  diff_summary TEXT,
  gaps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','superseded')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (agent_id, version)
)`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_knowledge_active ON agent_knowledge(agent_id) WHERE status = 'active'");
/* CE QUE LA CARTE COÛTE À LIRE. Une connaissance de domaine est recopiée dans le prompt de
   chaque run de l'agent : sa taille en tokens est donc une dépense RÉCURRENTE, pas une
   curiosité. Comptée à l'écriture et rangée ici — la recalculer à chaque affichage de la
   liste rouvrirait un fichier par version, par agent, à chaque passage sur l'onglet. NULL sur
   les versions écrites avant cette colonne : elles sont comptées à la première relecture.
   Migration APRÈS le `CREATE TABLE agent_knowledge` ci-dessus. */
try { db.exec('ALTER TABLE agent_knowledge ADD COLUMN tokens INTEGER'); } catch { /* déjà présente */ }

/* Un run d'agent EST une session. Trois colonnes suffisent : quel profil, son nom au moment du
   run (la session reste lisible même après suppression du profil), et qui a appuyé — la main
   ou l'horaire. Migrations APRÈS le `CREATE TABLE task`, plus haut dans ce fichier. */
try { db.exec('ALTER TABLE task ADD COLUMN agent_id INTEGER REFERENCES agent(id) ON DELETE SET NULL'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN agent_name TEXT'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE task ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'"); } catch { /* déjà présente */ }
/* LA DEMANDE TELLE QU'ELLE A ÉTÉ TAPÉE, avant composition. `task.prompt` porte la demande
   COMPOSÉE — gabarit, fichiers d'entrée, consignes, protocoles : c'est ce que l'agent reçoit,
   et c'est illisible pour un humain. Le sujet d'un agent de domaine, le titre du rapport et le
   libellé de la carte viennent tous de la question d'origine ; sans cette colonne, ils
   recopiaient la première ligne du gabarit (« Sujet à cartographier : »). */
try { db.exec('ALTER TABLE task ADD COLUMN agent_question TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_task_agent ON task(agent_id)');
// Plafond de runs déclenchés par un horaire, par jour. 0 = illimité.
try { db.exec('ALTER TABLE config ADD COLUMN agent_auto_max INTEGER NOT NULL DEFAULT 10'); } catch { /* déjà présente */ }

/* QUI HONORE L'HORAIRE D'UN AGENT. Trois instances allumées dans une équipe lanceraient trois
   fois le même agent planifié, chacune persuadée d'être la seule — et paieraient trois fois.
   `runner` porte l'identité git de l'exécutant ; vide = personne, l'agent ne tourne qu'à la
   main. Migration APRÈS le `CREATE TABLE agent` ci-dessus. */
try { db.exec('ALTER TABLE agent ADD COLUMN runner TEXT'); } catch { /* déjà présente */ }

/* ---------- CE QUI RESTE SUR CE POSTE : `local_config` ----------
 *
 * `config` est une table d'équipe : gabarits de prompt, seuils, politiques, URL de la forge.
 * Elle porte pourtant sept jetons d'API, le chemin des clones et le moteur de dictée de CETTE
 * machine — autant de choses qui n'ont rien à faire dans un dépôt partagé, et que le lot
 * « base partagée » y enverrait si on ne les sortait pas.
 *
 * Le tri n'est pas fait ici : il est déclaré dans `src/store-registry.js`, où chaque colonne de
 * `config` figure nommément dans `locales` (ce poste) ou dans `partagees` (l'équipe), les deux
 * listes devant couvrir le schéma exactement — un test unitaire s'en assure. Sortir les jetons
 * par une LISTE NOIRE (« tout sauf… ») échouerait en s'ouvrant : la colonne ajoutée l'an
 * prochain partirait par défaut. Ici, une colonne non classée fait rougir les tests.
 *
 * La colonne d'origine n'est pas supprimée, elle est VIDÉE ET GELÉE : `ALTER TABLE … DROP
 * COLUMN` sur une base en service est irréversible, et une lecture oubliée doit trouver du vide
 * plutôt qu'un jeton périmé qu'elle croirait bon. L'assertion qui suit refuse une colonne gelée
 * non vide — après le drain, ce ne peut plus être qu'un bug de ce fichier même.
 *
 * Placé APRÈS tous les `ALTER TABLE config` : le drain lit des colonnes qui doivent exister. */
const REGISTRE_CONFIG = require('./store-registry').pour('config');
/* Les colonnes de poste, avec le défaut de `config` — repris à l'identique, sinon un réglage
   non renseigné changerait de sens en déménageant. `id` est la clé, pas un réglage. */
const COLONNES_LOCALES = [
  ["access_token", "TEXT DEFAULT ''"],
  ["github_token", "TEXT DEFAULT ''"],
  ["jira_email", "TEXT DEFAULT ''"],
  ["jira_token", "TEXT DEFAULT ''"],
  ["jenkins_user", "TEXT DEFAULT ''"],
  ["jenkins_token", "TEXT DEFAULT ''"],
  ["dictation_api_key", "TEXT DEFAULT ''"],
  ["clone_path", "TEXT DEFAULT ''"],
  ["language", "TEXT DEFAULT 'fr'"],
  ['jenkins_refresh_minutes', 'INTEGER DEFAULT 1'],
  ['git_commands_seeded', 'INTEGER DEFAULT 0'],
  ["dictation_provider", "TEXT DEFAULT 'off'"],
  ["dictation_model", "TEXT DEFAULT ''"],
  ["dictation_vad_model", "TEXT DEFAULT ''"],
  ["dictation_command", "TEXT DEFAULT ''"],
  ["dictation_url", "TEXT DEFAULT 'https://api.openai.com'"],
  ["dictation_remote_model", "TEXT DEFAULT 'gpt-4o-mini-transcribe'"],
  ["dictation_language", "TEXT DEFAULT 'auto'"],
  ['dictation_silence_ms', 'INTEGER DEFAULT 700'],
  ["dictation_final_pass", "TEXT DEFAULT '1'"],
  ['dictation_idle_minutes', 'INTEGER DEFAULT 15'],
  /* LE DÉPÔT DE DONNÉES PARTAGÉ. De poste, et non d'équipe : c'est l'adresse par laquelle CE
     poste rejoint l'équipe, et elle doit être renseignée avant que quoi que ce soit soit
     partagé — la mettre dans les réglages d'équipe serait circulaire. Vide = mode mono-poste,
     rien ne change. */
  ["data_repo_url", "TEXT DEFAULT ''"],
  ["data_repo_branch", "TEXT DEFAULT 'main'"],
  ['data_sync_seconds', 'INTEGER DEFAULT 30'],
  /* PARTAGER SA DÉPENSE, ou non. Décoché par défaut, et c'est délibéré : ce que coûte mon
     abonnement ne regarde que moi tant que je n'ai pas décidé le contraire. Coché, il part un
     total PAR JOUR — jamais le détail par appel, qui dirait ce que j'ai demandé et quand. */
  ["usage_share", "TEXT DEFAULT '0'"],
  /* DES HABITUDES, PAS DES POLITIQUES. Le brief du matin qui s'ouvre au lancement, la cadence à
     laquelle CE poste interroge la forge ou Jira, la fermeture des todos à la fusion (la todo
     est devenue personnelle), et les quatre cases cochées d'office d'une nouvelle session : les
     imposer à l'équipe, c'est rendre l'outil désagréable pour cinq personnes afin d'en arranger
     une. Les DÉFAUTS sont repris à l'identique de `config`, sinon un réglage non renseigné
     changerait de sens en déménageant. */
  ["brief_on_open", "TEXT DEFAULT '1'"],
  ['auto_refresh_minutes', 'INTEGER DEFAULT 0'],
  ['jira_watch_minutes', 'INTEGER DEFAULT 5'],
  ["todo_close_on_merge", "TEXT DEFAULT '1'"],
  ['task_default_auto_push', 'INTEGER DEFAULT 0'],
  ['task_default_ask_questions', 'INTEGER DEFAULT 0'],
  ['task_default_notify_jira', 'INTEGER DEFAULT 0'],
  ['task_default_converge', 'INTEGER DEFAULT 0'],
];
db.exec(`CREATE TABLE IF NOT EXISTS local_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ${COLONNES_LOCALES.map(([n, d]) => `${n} ${d}`).join(',\n  ')}
)`);
if (!db.prepare('SELECT 1 FROM local_config WHERE id = 1').get()) {
  db.prepare('INSERT INTO local_config (id) VALUES (1)').run();
}
/* Une colonne de poste ajoutée après coup : même migration idempotente que partout ailleurs,
   APRÈS le CREATE TABLE ci-dessus. */
for (const [nom, decl] of COLONNES_LOCALES) {
  try { db.exec(`ALTER TABLE local_config ADD COLUMN ${nom} ${decl}`); } catch { /* déjà présente */ }
}

/* LE DRAIN. Rejouable : la seconde exécution ne trouve plus rien à déplacer. On ne recopie que
   si la colonne de `config` porte encore quelque chose — sinon on écraserait ce que
   l'utilisateur vient de saisir dans `local_config` par le vide laissé au passage précédent. */
{
  const gelees = REGISTRE_CONFIG.locales.filter((c) => c !== 'id');
  const avant = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  const deplacees = [];
  for (const col of gelees) {
    const v = avant[col];
    if (v === null || v === undefined || v === '') continue;
    db.prepare(`UPDATE local_config SET ${col} = ? WHERE id = 1`).run(v);
    db.prepare(`UPDATE config SET ${col} = '' WHERE id = 1`).run();
    deplacees.push(col);
  }
  /* L'ASSERTION. Après le drain, une colonne gelée non vide ne peut plus venir que d'un bug de
     ce fichier — une faute de frappe dans un nom de colonne, avalée par un `catch {}` voisin.
     On préfère que le serveur refuse de démarrer plutôt que de laisser un jeton là où
     l'exportateur du dépôt partagé pourrait un jour le lire. */
  const apres = db.prepare('SELECT * FROM config WHERE id = 1').get() || {};
  const restantes = gelees.filter((c) => apres[c] !== null && apres[c] !== undefined && apres[c] !== '');
  if (restantes.length) {
    throw new Error(`config : colonnes gelées encore remplies après le drain vers local_config — ${restantes.join(', ')}`);
  }
  if (deplacees.length) {
    console.log(`[db] ${deplacees.length} réglage(s) de poste déplacé(s) de config vers local_config`);
  }
}

/* Amorçage des commandes git — UNE SEULE FOIS par poste. Supprimer toutes les entrées ne les
   réintroduit donc pas : c'est un choix de l'utilisateur. Le drapeau vit dans `local_config`
   parce qu'il décrit CETTE installation, et non ce que l'équipe a décidé ; sans quoi le
   deuxième poste d'une équipe n'aurait jamais ses commandes de départ. */
{
  const seeded = db.prepare('SELECT git_commands_seeded AS s FROM local_config WHERE id = 1').get();
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
    db.prepare('UPDATE local_config SET git_commands_seeded = 1 WHERE id = 1').run();
  }
}

/* ---------- L'IDENTITÉ QUI SURVIT AU PARTAGE : `uid` et `slug` ----------
 *
 * Les entiers auto-incrémentés sont LOCAUX par nature. Deux postes créent chacun le dépôt
 * n° 12 ; deux reviews de la même merge request reçoivent chacune la version 2. Dès que le
 * travail accumulé part dans un dépôt git d'équipe, ces numéros se télescopent — et il n'y a
 * personne pour arbitrer, c'est tout l'intérêt d'une synchronisation sans serveur.
 *
 * Chaque table partagée reçoit donc un `uid` : un ULID, produit sans se concerter, et TRIABLE
 * PAR DATE DE CRÉATION. C'est cette dernière propriété qui fait le travail : les numéros de
 * version (`review_version.version`), de passe (`agent_pass.n`) et de connaissance
 * (`agent_knowledge.version`) deviennent DÉRIVÉS — on les renumérote en lisant les uids dans
 * l'ordre, sans compteur partagé. Deux postes qui reviewent la même MR en même temps produisent
 * v2 et v3, jamais deux v2, et dans le même ordre chez tout le monde.
 *
 * LES 852 REQUÊTES EXISTANTES NE CHANGENT PAS : elles continuent de joindre par `id`. L'uid ne
 * sert qu'à franchir la frontière entre deux postes.
 *
 * COMMENT IL EST POSÉ. Pas par les ~100 `INSERT` de l'application — les oublier un par un est
 * précisément ce qui se produirait —, mais par un DÉCLENCHEUR par table, qui appelle la
 * fonction JS enregistrée plus haut. L'invariant est ainsi tenu par la base elle-même, y
 * compris pour les insertions du mode démo et des scripts. Contrepartie assumée : cette base
 * ne s'écrit plus depuis le `sqlite3` en ligne de commande, qui ne connaît pas `mergerie_ulid`.
 * Elle se LIT toujours, ce qui est le seul usage qu'on en fait de l'extérieur.
 *
 * Placé APRÈS tous les `CREATE TABLE` : un `ALTER TABLE` sur une table qui n'existe pas encore
 * lève, le `catch {}` l'avale, et la colonne n'existe alors que sur les bases où la table
 * préexistait. */
{
  const TABLES_UID = require('./store-registry').REGISTRE.filter((e) => e.uidPropre).map((e) => e.table);
  for (const table of TABLES_UID) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`); } catch { /* déjà présente */ }

    /* REMPLISSAGE DES LIGNES EXISTANTES. On respecte l'ordre de création : l'horodatage en tête
       de l'ULID est repris de `created_at` quand la table en a un, sinon d'un compteur qui suit
       l'ordre des `rowid`. Sans cette précaution, les uids d'une base déjà en service seraient
       tous datés de la migration et leur tri serait aléatoire — or c'est ce tri qui renumérote
       les versions et les passes. Les ex æquo sont départagés par la milliseconde ajoutée. */
    const colonnes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const dateCol = ['created_at', 'started_at', 'added_at', 'at', 'ts'].find((c) => colonnes.includes(c));
    const aRemplir = db.prepare(
      `SELECT rowid AS r${dateCol ? `, ${dateCol} AS d` : ''} FROM ${table} WHERE uid IS NULL ORDER BY rowid`,
    ).all();
    if (aRemplir.length) {
      const poser = db.prepare(`UPDATE ${table} SET uid = ? WHERE rowid = ?`);
      const base = Date.now() - aRemplir.length;
      db.transaction(() => {
        aRemplir.forEach((ligne, i) => {
          const t = dateCol && ligne.d ? Date.parse(ligne.d) : NaN;
          poser.run(ulid(Number.isFinite(t) ? t + i : base + i), ligne.r);
        });
      })();
    }

    /* UNIQUE, et non « UNIQUE NOT NULL » : SQLite ne sait pas ajouter une colonne NOT NULL sans
       valeur par défaut à une table existante, et un index unique laisse passer les NULL. Le
       déclencheur ci-dessous est ce qui garantit qu'il n'en reste jamais. */
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uid ON ${table}(uid)`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_uid AFTER INSERT ON ${table}
             WHEN NEW.uid IS NULL
             BEGIN UPDATE ${table} SET uid = mergerie_ulid() WHERE rowid = NEW.rowid; END`);
  }
}

/* ---------- CE QUI N'APPARTIENT QU'À CETTE MACHINE : `local_state` et `local_pref` ----------
 *
 * Deux tables de même forme, aux durées de vie différentes (voir `src/localstate.js`) :
 * `local_state` porte de l'état DÉRIVÉ (quand cet agent planifié a tourné ici, quand ce ticket
 * Jira a été relu ici) et se recalcule ; `local_pref` porte une PRÉFÉRENCE (une session rangée)
 * et ne se recalcule pas.
 *
 * Elles reprennent des colonnes qui vivaient dans des tables PARTAGÉES, où elles n'avaient rien
 * à faire : `agent.schedule_fired_at` dirait au collègue que SON agent a tourné, `jira_watch`
 * lui montrerait MON erreur réseau, et `task.hidden` rangerait chez lui la session qu'on a
 * rangée chez soi. Les colonnes d'origine sont vidées et gelées, comme celles de `config`.
 *
 * `ref` est l'`uid` du parent, jamais son `id` entier : après une réhydratation venue d'un autre
 * poste, les id se renumérotent et la ligne d'ici se retrouverait accrochée au mauvais parent. */
db.exec(`CREATE TABLE IF NOT EXISTS local_state (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, ref, key)
)`);
/* OÙ SE TROUVE, SUR CETTE MACHINE, LE DOSSIER QU'UNE SESSION HORS DÉPÔT DÉSIGNE.
 *
 * `local_task_dir.path` était un chemin absolu — `/Users/amady/lin/monprojet`. Sur le Linux du
 * collègue, il ne désigne rien. La session, elle, se partage : ses passes se relisent, son
 * verdict compte. Le fichier du dépôt porte donc `dir_hash` (l'empreinte du chemin normalisé),
 * `dir_label` (le dernier segment, pour l'affichage) et `owner` ; chaque poste résout le chemin
 * CHEZ LUI, dans cette table. Ailleurs, la session s'affiche avec son libellé et son
 * propriétaire, et « Relancer » est refusé plutôt que de lancer l'agent dans le vide.
 *
 * Un autre poste peut RATTACHER son propre dossier au même `dir_hash` : il n'écrit alors que
 * dans sa table à lui. */
db.exec(`CREATE TABLE IF NOT EXISTS local_dir_map (
  dir_hash TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  updated_at TEXT
)`);

/* LE HANDLE D'UNE SESSION D'AGENT — et pourquoi il ne peut pas voyager.
 *
 * `claude` et `copilot` gardent leurs sessions dans le `~/.claude` de la MACHINE qui les a
 * créées. Un handle venu d'un collègue ne désigne rien ici : le reprendre échouerait, ou pire,
 * tomberait sur une session homonyme. Le repli existe déjà — on repart sur une session neuve
 * avec le contexte réinjecté — et il devient simplement le cas normal entre deux postes.
 *
 * `scope` dit de quoi c'est le handle (le projet d'une session, un dossier hors dépôt, une
 * question libre, la review d'une merge request), `ref` est l'`uid` du parent : jamais son id
 * entier, que SQLite recycle après une suppression — une MR redécouverte hériterait alors de la
 * session d'une autre. */
db.exec(`CREATE TABLE IF NOT EXISTS local_session (
  scope TEXT NOT NULL,
  ref TEXT NOT NULL,
  session_key TEXT,
  session_backend TEXT,
  session_cwd TEXT,
  updated_at TEXT,
  PRIMARY KEY (scope, ref)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS local_pref (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, ref, key)
)`);

/* LE DRAIN, et le gel qui suit. Rejouable : la seconde exécution ne trouve plus rien à déplacer.
   Placé APRÈS les déclencheurs d'`uid` ci-dessus — il lit la colonne `uid` des parents, qui
   vient d'être remplie sur les lignes existantes. */
{
  const deplacer = (table, cleParent, colonnes, cible, kind) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const aDeplacer = colonnes.filter((c) => cols.includes(c));
    if (!aDeplacer.length) return;
    const poser = db.prepare(`INSERT INTO ${cible} (kind, ref, key, value, updated_at)
                              VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT (kind, ref, key) DO NOTHING`);
    const maintenant = new Date().toISOString();
    /* « REMPLIE » veut dire « porte autre chose que sa valeur neutre ». `task.hidden` a un
       DEFAULT 0 : le traiter comme rempli ferait réécrire toutes les sessions à chaque
       démarrage, et l'assertion du bas se déclencherait dès la première session créée. */
    const remplie = (c) => `${c} IS NOT NULL AND ${c} <> '' AND ${c} <> 0`;
    const lignes = db.prepare(
      `SELECT ${cleParent} AS ref, ${aDeplacer.join(', ')} FROM ${table}
       WHERE ${cleParent} IS NOT NULL AND (${aDeplacer.map(remplie).join(' OR ')})`,
    ).all();
    db.transaction(() => {
      for (const ligne of lignes) {
        for (const col of aDeplacer) {
          if (ligne[col] === null || ligne[col] === undefined || ligne[col] === '') continue;
          poser.run(kind, String(ligne.ref), col, String(ligne[col]), maintenant);
        }
      }
      for (const col of aDeplacer) db.exec(`UPDATE ${table} SET ${col} = NULL WHERE ${remplie(col)}`);
    })();
    /* L'ASSERTION. Après le drain, une colonne gelée encore remplie ne peut plus venir que d'un
       bug de ce fichier — on préfère un serveur qui refuse de démarrer à une donnée de poste
       qui repart un jour dans le dépôt d'équipe. */
    const reste = db.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE ${aDeplacer.map(remplie).join(' OR ')}`,
    ).get().n;
    if (reste) throw new Error(`${table} : ${aDeplacer.join(', ')} encore rempli(s) après le drain vers ${cible}`);
  };

  /* LE DOSSIER D'UNE SESSION HORS DÉPÔT. Trois colonnes partageables remplacent le chemin
     absolu : l'empreinte (qui permet à chacun de rattacher SON dossier), le libellé (pour que
     la carte dise quelque chose chez le voisin) et le propriétaire. Migration APRÈS le
     `CREATE TABLE local_task_dir`, plus haut. */
  for (const [col, decl] of [['dir_hash', 'TEXT'], ['dir_label', 'TEXT'], ['owner', 'TEXT']]) {
    try { db.exec(`ALTER TABLE local_task_dir ADD COLUMN ${col} ${decl}`); } catch { /* déjà présente */ }
  }
  {
    const aFaire = db.prepare(
      "SELECT id, path FROM local_task_dir WHERE path IS NOT NULL AND path <> ''",
    ).all();
    if (aFaire.length) {
      const { empreinte, libelle } = require('./dirhash');
      const moi = require('./identite').nom() || null;
      /* `path` est `NOT NULL` depuis l'origine : on le gèle à la chaîne vide plutôt qu'à NULL,
         qui serait refusé. Vide veut dire « ce n'est plus ici qu'on lit le chemin ». */
      const poser = db.prepare("UPDATE local_task_dir SET dir_hash = ?, dir_label = ?, owner = COALESCE(owner, ?), path = '' WHERE id = ?");
      const carte = db.prepare(`INSERT INTO local_dir_map (dir_hash, path, updated_at) VALUES (?, ?, ?)
                                ON CONFLICT (dir_hash) DO UPDATE SET path = excluded.path`);
      const maintenant = new Date().toISOString();
      db.transaction(() => {
        for (const d of aFaire) {
          const h = empreinte(d.path);
          carte.run(h, d.path, maintenant);
          poser.run(h, libelle(d.path), moi, d.id);
        }
      })();
    }
    const reste = db.prepare("SELECT COUNT(*) n FROM local_task_dir WHERE path IS NOT NULL AND path <> ''").get().n;
    if (reste) throw new Error('local_task_dir.path encore rempli après le drain vers local_dir_map');
  }

  /* LES HANDLES DE SESSION quittent les tables partagées pour `local_session`. Trois colonnes
     qui voyagent ensemble : les déplacer une par une dans `local_state` les séparerait, alors
     qu'un handle sans son `cwd` perd le garde-fou qui empêche de reprendre une session dans un
     autre dossier. Rejouable : la seconde exécution ne trouve plus rien. */
  {
    const poser = db.prepare(`INSERT INTO local_session (scope, ref, session_key, session_backend, session_cwd, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?)
                              ON CONFLICT (scope, ref) DO NOTHING`);
    const maintenant = new Date().toISOString();
    const sources = [
      ['task_target', 'task_target', ['session_key', 'session_backend', 'session_cwd']],
      ['local_task_dir', 'local_task_dir', ['session_key', 'session_backend', 'session_cwd']],
      ['question', 'question', ['session_key', 'session_backend', 'session_cwd']],
      ['mr', 'mr', ['review_session_key', 'review_session_backend', 'review_session_cwd']],
    ];
    for (const [scope, table, cols] of sources) {
      const presentes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.every((c) => presentes.includes(c))) continue;
      const lignes = db.prepare(
        `SELECT uid, ${cols.join(', ')} FROM ${table} WHERE uid IS NOT NULL AND ${cols[0]} IS NOT NULL AND ${cols[0]} <> ''`,
      ).all();
      db.transaction(() => {
        for (const l of lignes) poser.run(scope, l.uid, l[cols[0]], l[cols[1]] || null, l[cols[2]] || null, maintenant);
        for (const c of cols) db.exec(`UPDATE ${table} SET ${c} = NULL WHERE ${c} IS NOT NULL AND ${c} <> ''`);
      })();
      const reste = db.prepare(
        `SELECT COUNT(*) n FROM ${table} WHERE ${cols.map((c) => `(${c} IS NOT NULL AND ${c} <> '')`).join(' OR ')}`,
      ).get().n;
      if (reste) throw new Error(`${table} : handles de session encore remplis après le drain vers local_session`);
    }
  }

  deplacer('agent', 'uid', ['schedule_fired_at'], 'local_state', 'agent');
  deplacer('jira_watch', 'key', ['checked_at', 'error'], 'local_state', 'jira_watch');
  deplacer('task', 'uid', ['hidden'], 'local_pref', 'task');
  deplacer('local_task', 'uid', ['hidden'], 'local_pref', 'local_task');
  deplacer('question', 'uid', ['hidden'], 'local_pref', 'question');

  /* LES VALEURS D'ENVIRONNEMENT D'UN VÉRIFICATEUR. Elles partaient dans le dépôt : un
     `DATABASE_URL`, un `NPM_TOKEN`, la clé d'un bac à sable — et un secret commité dans git est
     définitif. On garde les NOMS côté équipe (`env_keys`, pour que le collègue sache quoi
     renseigner) et on déplace les VALEURS ici, une ligne par variable. Le drain générique ne
     convient pas : une seule colonne porte un objet entier, qu'il faut éclater. */
  {
    const aEclater = db.prepare(
      "SELECT uid, env_json FROM verifier WHERE uid IS NOT NULL AND env_json IS NOT NULL AND env_json <> ''",
    ).all();
    if (aEclater.length) {
      const poser = db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
        VALUES ('verifier_env', ?, ?, ?, ?) ON CONFLICT (kind, ref, key) DO NOTHING`);
      const noms = db.prepare('UPDATE verifier SET env_keys = ?, env_json = NULL WHERE uid = ?');
      const maintenant = new Date().toISOString();
      db.transaction(() => {
        for (const v of aEclater) {
          let obj = {};
          try { obj = JSON.parse(v.env_json) || {}; } catch { obj = {}; }
          const cles = Object.keys(obj).filter(Boolean);
          for (const k of cles) poser.run(v.uid, k, String(obj[k] == null ? '' : obj[k]), maintenant);
          noms.run(JSON.stringify(cles), v.uid);
        }
      })();
    }
    /* L'ASSERTION, comme pour les jetons : une valeur encore là ne peut plus venir que d'un bug
       de ce fichier, et on préfère un serveur qui refuse de démarrer à un secret qui repart. */
    const reste = db.prepare("SELECT COUNT(*) n FROM verifier WHERE env_json IS NOT NULL AND env_json <> ''").get().n;
    if (reste) throw new Error('verifier : env_json encore rempli après le déplacement vers local_state');
  }
}

/* ---------- LE NOM DE FICHIER D'UN OBJET QU'ON NOMME : `slug` ----------
 *
 * Un agent et une page de notes portent un nom lisible, et c'est lui qui doit nommer leur
 * fichier dans le dépôt partagé — `agents/documentaliste/agent.json` se relit, pas
 * `agents/01JCXZ.../agent.json`. Le slug est donc FIGÉ À LA CRÉATION : renommer l'agent ne
 * déplace pas son dossier. Sans ce gel, chaque renommage produirait chez les collègues une
 * suppression suivie d'un ajout au lieu d'un changement de titre, et l'historique git du
 * fichier — précisément ce qu'on gagne à passer par git — serait perdu à chaque fois.
 *
 * Le suffixe `-2`, `-3` règle les homonymes après normalisation (« Déploiement » et
 * « déploiement ! » donnent le même slug). Il demande une lecture de la table, donc il ne peut
 * pas vivre dans un déclencheur : `src/ulid.js` le calcule, les deux points de création
 * l'appellent, et la reprise ci-dessous rattrape tout ce qui aurait été inséré autrement —
 * l'amorçage du mode démo, par exemple, qui tourne dans son propre processus. */
for (const [table, colonne] of [['agent', 'name'], ['note_page', 'title']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN slug TEXT`); } catch { /* déjà présente */ }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_slug ON ${table}(slug)`);
  const sans = db.prepare(`SELECT id, ${colonne} AS nom FROM ${table} WHERE slug IS NULL ORDER BY id`).all();
  if (sans.length) {
    const pris = new Set(db.prepare(`SELECT slug FROM ${table} WHERE slug IS NOT NULL`).all().map((r) => r.slug));
    const poser = db.prepare(`UPDATE ${table} SET slug = ? WHERE id = ?`);
    db.transaction(() => {
      for (const ligne of sans) {
        const s = slugLibre(ligne.nom, (x) => pris.has(x));
        pris.add(s);
        poser.run(s, ligne.id);
      }
    })();
  }
}

/* ---------- CE QUI A CHANGÉ ET N'EST PAS ENCORE ÉCRIT DANS LE DÉPÔT ----------
 *
 * Le dossier `data/shared/` est la source de vérité : chaque ligne partagée y a son fichier. Le
 * problème est de ne JAMAIS en oublier un — l'application compte plus de deux cents écritures,
 * réparties dans vingt modules, et la moitié se produit au fond d'un runner. Les passer une par
 * une en revue, c'est se donner rendez-vous avec l'oubli : il suffirait qu'une écriture ajoutée
 * l'an prochain n'appelle pas le `store` pour qu'un objet cesse silencieusement d'être partagé.
 *
 * On prend donc le même parti que pour les `uid` : c'est LA BASE qui tient l'invariant. Un
 * déclencheur par table partagée note la ligne touchée dans `store_sale` ; `store.ecouler()`
 * réécrit ensuite les fichiers correspondants. Les suppressions, elles, ne peuvent pas dire
 * QUEL fichier retirer (le chemin se calcule en JavaScript) : elles marquent la table dans
 * `store_menage`, et le balayage compare le dossier aux lignes restantes.
 *
 * LA FILE EST DANS LA MÊME TRANSACTION QUE L'ÉCRITURE. C'est ce qui rend l'ensemble sûr à la
 * coupure : si le processus meurt entre la ligne et le fichier, la file a survécu, et le
 * démarrage suivant écrit le fichier manquant. Rien ne peut être perdu, seulement retardé.
 *
 * Une ligne fille marque son PARENT : un constat de review vit dans le fichier de sa passe, une
 * commande de vérificateur dans celui de son vérificateur.
 *
 * Placé APRÈS tous les `CREATE TABLE` : un déclencheur sur une table qui n'existe pas encore
 * lève, et le `catch {}` voisin l'avalerait. */
/* PAS DE CLÉ PRIMAIRE, ET CE N'EST PAS UN OUBLI. `INSERT OR IGNORE` À L'INTÉRIEUR D'UN
   DÉCLENCHEUR NE FAIT RIEN : SQLite ignore la clause `OR IGNORE` du corps d'un déclencheur et
   applique celle de l'instruction EXTÉRIEURE. Un simple `DELETE FROM verifier` — qui cascade sur
   ses commandes et met à NULL la référence de ses vérifications — faisait donc marquer deux fois
   la même ligne, et échouait sur une violation d'unicité. Le doublon ne coûte rien ici : on
   déduplique à la lecture, et l'effacement retire toutes les copies d'un coup. */
{
  /* Une base écrite par une version antérieure porte encore la clé primaire : on la reconstruit
     en gardant la file, qui peut contenir du travail non écrit. */
  const aUnIndex = (t) => {
    try { return db.prepare(`PRAGMA index_list(${t})`).all().length > 0; } catch { return false; }
  };
  const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const [table, colonnes] of [['store_sale', 'tbl, rid'], ['store_menage', 'tbl']]) {
    if (existe(table) && aUnIndex(table)) {
      /* ON RETIRE D'ABORD LES DÉCLENCHEURS. `ALTER TABLE … RENAME` réécrit les références à la
         table DANS LE CORPS DES DÉCLENCHEURS : les anciens se mettraient à viser
         `store_sale_ancien`, qu'on s'apprête à supprimer — et la première écriture venue
         échouerait sur « no such table ». Ils sont recréés juste en dessous, de toute façon. */
      for (const t of db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'trg_%_sale_%' OR name LIKE 'trg_%_menage')",
      ).all()) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_ancien`);
      db.exec(`CREATE TABLE ${table} (${colonnes.split(', ').map((c) => `${c} ${c === 'rid' ? 'INTEGER' : 'TEXT'} NOT NULL`).join(', ')})`);
      db.exec(`INSERT INTO ${table} (${colonnes}) SELECT ${colonnes} FROM ${table}_ancien`);
      db.exec(`DROP TABLE ${table}_ancien`);
    }
  }
}
/* Un vestige de reconstruction interrompue : sans ça, la table renommée resterait à jamais. */
for (const t of ['store_sale_ancien', 'store_menage_ancien']) {
  try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch { /* déjà partie */ }
}
db.exec('CREATE TABLE IF NOT EXISTS store_sale (tbl TEXT NOT NULL, rid INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS store_menage (tbl TEXT NOT NULL)');

{
  const registre = require('./store-registry');
  const aFichier = registre.REGISTRE.filter((e) => e.chemin && e.toFile
    && (e.famille === 'P' || (e.partagees || []).length));
  const parents = new Map();          // table fille -> { parent, colonne }
  for (const e of aFichier) {
    for (const l of e.listes || []) parents.set(l.table, { parent: e.table, colonne: l.colonneParent });
  }

  const marquer = (table, cible, colonne) => {
    /* `rowid` et non `id` : deux tables partagées n'ont pas de colonne `id` — les réglages, une
       veille Jira nommée par la clé du ticket. `rowid` existe partout. */
    const valeur = colonne ? `${cible}.${colonne}` : `${cible}.rowid`;
    const source = colonne
      ? `(SELECT rowid FROM ${table} WHERE ${registre.pour(table).uidPropre || table === 'config' ? 'id' : 'rowid'} = ${valeur})`
      : valeur;
    return `INSERT INTO store_sale (tbl, rid) VALUES ('${table}', ${source});`;
  };

  /* ON RECRÉE TOUJOURS, plutôt que `CREATE TRIGGER IF NOT EXISTS`. Le corps de ces déclencheurs
     est GÉNÉRÉ à partir du registre : s'il change — une table qui rejoint la famille partagée,
     une liste fille qui apparaît —, un déclencheur d'une version antérieure resterait en place
     et marquerait la mauvaise chose. Pire : `ALTER TABLE … RENAME` réécrit les références au
     nom de table DANS le corps des déclencheurs, si bien qu'une reconstruction de la file
     laissait des déclencheurs pointant une table supprimée, et la première écriture venue
     échouait sur « no such table ». Les recréer à chaque démarrage coûte quelques
     millisecondes et supprime toute la classe de problèmes. */
  const recreer = (nom, corps) => { db.exec(`DROP TRIGGER IF EXISTS ${nom}`); db.exec(corps); };
  for (const e of aFichier) {
    for (const evenement of ['INSERT', 'UPDATE']) {
      const nom = `trg_${e.table}_sale_${evenement.toLowerCase()}`;
      recreer(nom, `CREATE TRIGGER ${nom}
               AFTER ${evenement} ON ${e.table}
               BEGIN ${marquer(e.table, 'NEW')} END`);
    }
    recreer(`trg_${e.table}_menage`, `CREATE TRIGGER trg_${e.table}_menage
             AFTER DELETE ON ${e.table}
             BEGIN INSERT INTO store_menage (tbl) VALUES ('${e.table}'); END`);
  }

  /* LE JOUR OÙ LA COLONNE APPARAÎT, LES PAGES DÉJÀ ÉCRITES DEVIENNENT PRIVÉES — et celles qui
     étaient déjà dans le dépôt doivent en SORTIR. Sans ce balayage, leurs fichiers resteraient
     sur le disque, le prochain `git add -A` les emporterait, et la case « partager » aurait été
     mise en place le jour même où l'outil publiait ses brouillons. On passe par la FILE plutôt
     que par le balayage : écouler une ligne non partagée retire ses fichiers ET ses captures,
     là où le balayage ne connaît que le gabarit de la page.
     LE REPÈRE EST UNE MARQUE, PAS LE SUCCÈS DE L'`ALTER` : une base qui a connu une version
     intermédiaire a déjà la colonne, et se serait donc passée du nettoyage — c'est-à-dire
     précisément celle qui en a besoin. */
  const balaye = db.prepare("SELECT value FROM local_state WHERE kind = 'data' AND ref = 'notes' AND key = 'unshared_swept'").get();
  if (!balaye) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'note_page', rowid FROM note_page").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'notes', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* LE MÊME JOUR POUR LES SESSIONS. Elles partaient en bloc : prompt, réponse, chaque passe avec
     son retour complet, les captures jointes, le coût de chaque essai. Devenues privées par
     défaut, elles doivent SORTIR du dépôt — avec leurs passes et leurs pièces, qui suivent leur
     session et n'ont pas de case à elles. On remet donc les cinq tables dans la file : écouler
     une ligne qui ne se partage plus retire ses fichiers et ses binaires. */
  const balayeSessions = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'sessions' AND key = 'unshared_swept'",
  ).get();
  if (!balayeSessions) {
    for (const t of ['task', 'local_task', 'question', 'agent_pass', 'piece_jointe']) {
      db.prepare(`INSERT INTO store_sale (tbl, rid) SELECT '${t}', rowid FROM ${t}`).run();
    }
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'sessions', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* LES BROUILLONS DE COMMENTAIRE SORTENT DU FICHIER DE LEUR MERGE REQUEST. Ils y étaient
     encore : une remarque inline pas encore envoyée, lisible par tout le monde. Le fichier se
     réécrit sans eux dès qu'on remet les merge requests dans la file — rien d'autre ne les
     aurait retirés, puisque le fichier de la MR existe toujours. */
  const brouillonsSortis = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'mrs' AND key = 'drafts_unshared'",
  ).get();
  if (!brouillonsSortis) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'mr', rowid FROM mr").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'mrs', 'drafts_unshared', '1', ?)`).run(new Date().toISOString());
  }

  /* ET LES TODOS. Elles partaient en bloc, y compris celles qu'aucune main n'a écrites — la
     veille Jira d'un collègue, la question posée par son agent. Devenues privées par défaut,
     leurs fichiers doivent sortir du dépôt. */
  const todosBalayees = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'todos' AND key = 'unshared_swept'",
  ).get();
  if (!todosBalayees) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'todo', rowid FROM todo").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'todos', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* HUIT RÉGLAGES ONT CHANGÉ DE CÔTÉ (brief du matin, cadences, fermeture des todos, cases
     d'office d'une session) : `settings.json` les porte encore. On remet la ligne de réglages
     dans la file pour que le fichier se réécrive sans eux — le drain les a déjà vidés de
     `config`, mais rien n'aurait réécrit le fichier. */
  const reglagesRelus = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'settings' AND key = 'locaux_2'",
  ).get();
  if (!reglagesRelus) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'config', rowid FROM config").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'settings', 'locaux_2', '1', ?)`).run(new Date().toISOString());
  }

  /* Les lignes FILLES marquent leur parent : elles n'ont pas de fichier à elles. Une suppression
     de ligne fille ne demande aucun balayage — le fichier du parent, réécrit, ne la mentionnera
     simplement plus. */
  for (const [fille, { parent, colonne }] of parents) {
    for (const evenement of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = evenement === 'DELETE' ? 'OLD' : 'NEW';
      const nom = `trg_${fille}_sale_${evenement.toLowerCase()}`;
      recreer(nom, `CREATE TRIGGER ${nom}
               AFTER ${evenement} ON ${fille}
               BEGIN INSERT INTO store_sale (tbl, rid)
                 SELECT '${parent}', rowid FROM ${parent} WHERE id = ${ref}.${colonne}; END`);
    }
  }
}

// Au démarrage : tout job resté "running" a été coupé -> interrupted.
// Ce que ces jobs PORTAIENT (sessions, vérifications) est remis debout par
// `reconcilierTravauxCoupes`, appelée par le serveur une fois la langue posée.
db.prepare(`UPDATE job SET status = 'interrupted', finished_at = ?
            WHERE status IN ('running', 'queued')`).run(new Date().toISOString());

/* REMETTRE DEBOUT CE QUE L'ARRÊT A COUPÉ EN PLEIN VOL.
 *
 * Un job resté « running » n'existe plus : le processus est mort avec le serveur, et on vient
 * de le marquer `interrupted`. Mais le job n'était que le porteur — la SESSION, la tâche hors
 * dépôt ou la vérification qu'il faisait tourner, elles, restaient « running » pour toujours.
 * Or l'écran n'offre « Relancer » que sur `new`, `error`, `committed` ou `pushed` : une session
 * figée à « en cours » n'avait plus aucun bouton, ni pour repartir, ni pour s'arrêter — le job
 * à arrêter n'existait plus. L'outil se bloquait tout seul en s'arrêtant au mauvais moment.
 *
 * On les repose en `error`, avec la RAISON écrite noir sur blanc : « error » est un état d'où
 * l'on peut repartir, et le message évite de croire que l'IA a échoué alors que c'est le
 * serveur qui s'est arrêté. Ce qui avait déjà abouti n'est pas touché — les statuts par projet
 * (`committed`, `pushed`) portent le travail réellement fait.
 *
 * Appelée par le serveur APRÈS `i18n.setLang`, sinon le message sortirait toujours en français.
 * Renvoie ce qui a été repris, pour que le démarrage puisse le dire. */
function reconcilierTravauxCoupes(raison) {
  const maintenant = new Date().toISOString();
  const compte = { sessions: 0, projets: 0, horsDepot: 0, verifications: 0 };
  const maj = (sql, ...args) => { try { return db.prepare(sql).run(...args).changes; } catch { return 0; } };
  compte.sessions = maj(`UPDATE task SET status = 'error', last_error = ?, updated_at = ?
                         WHERE status = 'running'`, raison, maintenant);
  compte.projets = maj(`UPDATE task_target SET status = 'error', last_error = ?, updated_at = ?
                        WHERE status = 'running'`, raison, maintenant);
  compte.horsDepot = maj(`UPDATE local_task SET status = 'error', last_error = ?, updated_at = ?
                          WHERE status = 'running'`, raison, maintenant);
  /* Une vérification coupée n'a pas de verdict : `verify_error` est ce que pose déjà `jobs.js`
     quand son exécution échoue, et c'est lui qui rend la relance possible. */
  compte.verifications = maj(`UPDATE verification SET status = 'error', verdict = 'verify_error',
                              finished_at = ? WHERE status = 'running'`, maintenant);
  return compte;
}

module.exports = db;
module.exports.reconcilierTravauxCoupes = reconcilierTravauxCoupes;
module.exports.DEFAULTS = {
  DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY,
};
