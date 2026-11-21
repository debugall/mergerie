'use strict';
/* LE PLAN D'UN LOT DE TICKETS (Jira → Plans). De POSTE (choix de l'utilisateur) : rien ne part dans le
   dépôt partagé — le plan, ses versions, ses publications.

   `jira_plan` porte les ENTRÉES (tickets, epic d'origine, pages, dépôts et branches, complément, cases),
   le PROMPT composé — et `prompt_edited` s'il a été retouché à la main : relancer ne l'écrase alors
   pas sans le demander, et `inputs_at` plus récent que `prompt_at` dit qu'il ne reflète plus les entrées —, la photo des tickets lus (libellé, état : ce que le tableau de l'ordre
   affiche sans relire Jira), le nonce du run et la session d'exploration qui le produit.
   `jira_plan_version` : une version par passe de l'IA (lancement, suivi, relecture de Jira), le Markdown sur disque et
   le résultat structuré (`result_json` : ordre, compléments, tickets à créer, synthèse).
   `jira_plan_post` : par ticket, le commentaire publié — son id, la version et le TEXTE envoyés.
   Republier met à jour ce commentaire-là au lieu d'en empiler un autre. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS jira_plan (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  epic_key TEXT,
  ticket_keys_json TEXT NOT NULL DEFAULT '[]',
  confluence_json TEXT NOT NULL DEFAULT '[]',
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  branches_json TEXT NOT NULL DEFAULT '{}',
  complement TEXT NOT NULL DEFAULT '',
  include_comments INTEGER NOT NULL DEFAULT 0,
  ask_questions INTEGER NOT NULL DEFAULT 1,
  prompt TEXT,
  prompt_edited INTEGER NOT NULL DEFAULT 0,
  prompt_at TEXT,
  inputs_at TEXT,
  tickets_json TEXT,
  pages_json TEXT,
  missing_json TEXT,
  nonce TEXT,
  task_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  last_error TEXT,
  pending_instruction TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_jira_plan_task ON jira_plan(task_id)');
// L'origine de la version qu'une passe en cours rangera : `followup` (une demande), `jira` (une relecture de Jira).
try { db.exec('ALTER TABLE jira_plan ADD COLUMN pending_origin TEXT'); } catch { /* déjà présente */ }

db.exec(`CREATE TABLE IF NOT EXISTS jira_plan_version (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES jira_plan(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  origin TEXT NOT NULL,
  md_path TEXT NOT NULL,
  result_json TEXT NOT NULL,
  instruction TEXT,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_jira_plan_version_plan ON jira_plan_version(plan_id, version)');

db.exec(`CREATE TABLE IF NOT EXISTS jira_plan_post (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES jira_plan(id) ON DELETE CASCADE,
  ticket_key TEXT NOT NULL,
  comment_id TEXT,
  posted_version INTEGER,
  posted_text TEXT,
  posted_at TEXT,
  UNIQUE (plan_id, ticket_key)
)`);
