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

CREATE TABLE IF NOT EXISTS comment_log (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  body TEXT,
  gitlab_note_id INTEGER,
  sent_at TEXT
);
`);

// Migration : forge d'un dépôt ('gitlab' | 'github'). Les dépôts existants restent
// GitLab — la valeur par défaut suffit, aucune donnée à réécrire.
try { db.exec("ALTER TABLE repo ADD COLUMN forge TEXT DEFAULT 'gitlab'"); } catch { /* déjà présente */ }
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
// Migration : message de commit personnalisable des tâches.
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
// Migration : générer l'explication pédagogique lors d'une review ('1' par défaut =
// comportement historique). '0' = review seule (on saute le 2e appel IA), l'explication
// restant disponible à la demande via le bouton « Générer l'explication » du rapport.
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
try { db.exec('ALTER TABLE local_task ADD COLUMN hidden INTEGER DEFAULT 0'); } catch { /* déjà présente */ }

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

// Au démarrage : tout job resté "running" a été coupé -> interrupted.
db.prepare(`UPDATE job SET status = 'interrupted', finished_at = ?
            WHERE status IN ('running', 'queued')`).run(new Date().toISOString());

module.exports = db;
module.exports.DEFAULTS = {
  DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY,
};
