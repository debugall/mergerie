'use strict';
/* Les tickets Jira surveillés, la consommation de jetons, la dernière exécution d’une cible Makefile.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

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

/* ---------- PRÉCISION TECHNIQUE D'UN TICKET JIRA (« spec ») ----------
   Un ticket écrit par un PO dit le quoi, jamais le où ni le comment. La spec est ce que l'IA
   propose après avoir lu le ticket, son epic, des pages Confluence et le code des dépôts
   choisis : UNE ligne par ticket (l'unicité est l'identité — deux postes qui précisent le même
   ticket précisent le même objet), des VERSIONS empilées comme celles d'une review (IA, suivi,
   édition à la main), et l'id du commentaire Jira posté — pour le METTRE À JOUR plutôt que
   d'en empiler un nouveau à chaque relance. Le markdown vit en fichier, jamais en colonne,
   comme les rapports. `nonce` est le repère du bloc <<<SPEC>>> demandé à l'agent ; il n'est
   pas un secret (il apparaît dans le prompt), il empêche seulement une donnée du ticket de
   fabriquer un bloc que le parseur prendrait pour la réponse. */
db.exec(`CREATE TABLE IF NOT EXISTS ticket_spec (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL,
  epic_key TEXT,
  batch_id INTEGER,
  task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  complement TEXT DEFAULT '',
  confluence_json TEXT DEFAULT '[]',
  detail TEXT DEFAULT 'synthese',
  include_epic INTEGER DEFAULT 1,
  ask_questions INTEGER DEFAULT 1,
  ticket_snapshot TEXT,
  status TEXT DEFAULT 'new',
  nonce TEXT,
  comment_id TEXT,
  posted_version INTEGER,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_spec_key ON ticket_spec(ticket_key)');
/* « À revoir » est un DRAPEAU, pas un état : le ticket a changé de sens depuis l'analyse, mais la
   spec reste proposée / modifiée / postée — remplacer `status` perdait « déjà postée ». */
try { db.exec('ALTER TABLE ticket_spec ADD COLUMN stale INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
// L'instruction d'un suivi en cours : écrite sur la version qu'il produira, puis effacée. De poste.
try { db.exec('ALTER TABLE ticket_spec ADD COLUMN pending_instruction TEXT'); } catch { /* déjà présente */ }
/* La branche à lire pour chaque dépôt choisi : { "<id du dépôt>": "release/2.4" }. Absente d'un dépôt, c'est sa branche par défaut. Partagée : c'est un choix
   d'analyse, comme les dépôts eux-mêmes. */
try { db.exec("ALTER TABLE ticket_spec ADD COLUMN branches_json TEXT DEFAULT '{}'"); } catch { /* déjà présente */ }
db.exec(`CREATE TABLE IF NOT EXISTS ticket_spec_version (
  id INTEGER PRIMARY KEY,
  spec_id INTEGER NOT NULL REFERENCES ticket_spec(id) ON DELETE CASCADE,
  ticket_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  origin TEXT NOT NULL,
  md_path TEXT,
  instruction TEXT,
  ready_score INTEGER,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_spec_version_spec ON ticket_spec_version(spec_id)');
/* Un lot = les tickets d'une epic précisés d'un coup. Commodité d'écran de CE poste : les specs,
   elles, voyagent une par une. */
db.exec(`CREATE TABLE IF NOT EXISTS ticket_spec_batch (
  id INTEGER PRIMARY KEY,
  epic_key TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  created_at TEXT,
  updated_at TEXT
)`);
