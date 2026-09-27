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
