'use strict';
/* Historique des passes d'agent — une itération = une passe.

   Une session de codage (sur dépôt ou hors dépôt) s'itère : run initial, « Demander une
   correction », réponses aux questions, passes de convergence. Chaque itération envoie un
   prompt et produit un retour. Avant, seul le DERNIER retour survivait et le prompt de
   suivi n'était nulle part : impossible de relire pourquoi l'IA avait fait ce qu'elle a
   fait deux itérations plus tôt.

   Même motif que les versions de review (`review-v<N>.md` + table `review_version`) :
   chaque passe écrit son fichier, la table garde la trace, et `output_path` de l'unité
   continue de pointer la plus récente — les vues existantes ne changent pas.

   `scope` distingue les deux familles ('task' = projet d'une session sur dépôt,
   'local' = dossier d'un codage hors dépôt) ; tout le reste est commun. */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { TASKS_DIR, ensureDir } = require('./paths');

// Dossier de travail d'une unité : <tasks>/<id>/<unit> ou <tasks>/local/<id>/<unit>.
function unitDir(scope, taskId, unitId) {
  const base = scope === 'local'
    ? path.join(TASKS_DIR, 'local', String(taskId), String(unitId))
    : path.join(TASKS_DIR, String(taskId), String(unitId));
  return ensureDir(base);
}

/* Enregistre une passe et renvoie son numéro. Best-effort sur l'écriture du fichier :
   l'absence de trace ne doit jamais faire échouer un codage qui, lui, a réussi. */
function record(scope, taskId, unitId, { kind, prompt, text }) {
  const md = String(text || '').trim();
  const row = db.prepare('SELECT MAX(n) v FROM agent_pass WHERE scope = ? AND task_id = ? AND unit_id = ?')
    .get(scope, taskId, unitId);
  const n = ((row && row.v) || 0) + 1;
  let outPath = null;
  try {
    if (md) {
      outPath = path.join(unitDir(scope, taskId, unitId), `output-v${n}.md`);
      fs.writeFileSync(outPath, md, 'utf8');
    }
    db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(scope, taskId, unitId, n, kind || 'run', String(prompt || ''), outPath, new Date().toISOString());
  } catch { /* trace best-effort */ }
  return { n, outPath };
}

// Les passes d'une unité, de la plus ancienne à la plus récente (contenu lu à la demande).
function list(scope, taskId, unitId) {
  return db.prepare(`SELECT n, kind, prompt, output_path, created_at FROM agent_pass
    WHERE scope = ? AND task_id = ? AND unit_id = ? ORDER BY n`).all(scope, taskId, unitId);
}

// Une passe précise, avec le retour de l'agent lu sur disque.
function get(scope, taskId, unitId, n) {
  const p = db.prepare(`SELECT n, kind, prompt, output_path, created_at FROM agent_pass
    WHERE scope = ? AND task_id = ? AND unit_id = ? AND n = ?`).get(scope, taskId, unitId, Number(n));
  if (!p) return null;
  let output = '';
  try { if (p.output_path && fs.existsSync(p.output_path)) output = fs.readFileSync(p.output_path, 'utf8'); }
  catch { /* fichier illisible : on renvoie le prompt seul */ }
  return { ...p, output };
}

/* Nettoyage à la suppression d'une session. Pas de clé étrangère possible (deux tables
   parentes selon le scope), donc c'est explicite — appelé par les endpoints DELETE. */
function removeTask(scope, taskId) {
  db.prepare('DELETE FROM agent_pass WHERE scope = ? AND task_id = ?').run(scope, taskId);
}

module.exports = { record, list, get, removeTask };
