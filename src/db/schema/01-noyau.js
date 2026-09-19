'use strict';
/* Les tables du noyau — config, dépôts, merge requests, reviews, jobs, sessions, règles, brouillons de commentaires — telles que la première version les a créées.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

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
