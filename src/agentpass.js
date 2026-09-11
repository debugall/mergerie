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
/* CHAQUE SCOPE A SON DOSSIER. Les identifiants sont propres à chaque table : la question n°3
   et la session de codage n°3 existent en même temps, et sans ce préfixe elles écriraient
   leurs passes au même endroit — la seconde écrasant la première sans rien dire. */
const RACINE_SCOPE = { local: 'local', ask: 'ask' };

function unitDir(scope, taskId, unitId) {
  const racine = RACINE_SCOPE[scope];
  const base = racine
    ? path.join(TASKS_DIR, racine, String(taskId), String(unitId))
    : path.join(TASKS_DIR, String(taskId), String(unitId));
  return ensureDir(base);
}

/* Enregistre une passe et renvoie son numéro. Best-effort sur l'écriture du fichier :
   l'absence de trace ne doit jamais faire échouer un codage qui, lui, a réussi. */
function record(scope, taskId, unitId, { kind, prompt, text, costUsd }) {
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
    db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(scope, taskId, unitId, n, kind || 'run', String(prompt || ''), outPath, new Date().toISOString(),
        typeof costUsd === 'number' ? costUsd : null);
  } catch { /* trace best-effort */ }
  return { n, outPath };
}

// Les passes d'une unité, de la plus ancienne à la plus récente (contenu lu à la demande).
function list(scope, taskId, unitId) {
  return db.prepare(`SELECT id, n, kind, prompt, output_path, created_at, favori, titre, cost_usd,
      base_sha, head_sha, diff_path FROM agent_pass
    WHERE scope = ? AND task_id = ? AND unit_id = ? ORDER BY n`).all(scope, taskId, unitId);
}

/* CE QUE CETTE ITÉRATION-LÀ A CHANGÉ. La passe est enregistrée avant le commit — c'est le
   retour de l'agent qui la crée —, donc ses bornes ne sont connues qu'après. On revient donc
   l'annoter : le HEAD d'avant, celui d'après, et le patch entre les deux.

   Le patch n'est écrit QUE s'il y a quelque chose dedans. Une itération peut légitimement ne
   rien changer (l'agent constate que tout est déjà fait, le commit est un simple renommage) :
   les deux SHA suffisent alors à le dire, et c'est plus honnête qu'un fichier vide qui
   ouvrirait une vue sans contenu.

   Best-effort, comme `record` : un codage qui a réussi ne doit pas échouer parce que sa trace
   n'a pas pu s'écrire. */
function attacherDiff(scope, taskId, unitId, n, { baseSha, headSha, diff } = {}) {
  const patch = String(diff || '');
  let diffPath = null;
  try {
    if (patch.trim()) {
      diffPath = path.join(unitDir(scope, taskId, unitId), `diff-v${n}.patch`);
      fs.writeFileSync(diffPath, patch, 'utf8');
    }
    db.prepare(`UPDATE agent_pass SET base_sha = ?, head_sha = ?, diff_path = ?
      WHERE scope = ? AND task_id = ? AND unit_id = ? AND n = ?`)
      .run(baseSha || null, headSha || null, diffPath, scope, taskId, unitId, Number(n));
  } catch { /* trace best-effort */ }
  return { diffPath };
}

// Le patch d'une passe, lu sur disque. `null` = cette itération n'en a pas (ou plus).
function diffDe(pass) {
  try {
    if (pass && pass.diff_path && fs.existsSync(pass.diff_path)) return fs.readFileSync(pass.diff_path, 'utf8');
  } catch { /* fichier illisible */ }
  return null;
}

/* Marquer une passe et la nommer. Deux champs de RANGEMENT : ni le favori ni le titre ne
   partent à l'agent — les glisser dans un prompt changerait ce qu'il produit, et deux passes
   au même prompt mais au titre différent ne rendraient plus la même chose.
   Une passe se désigne par son identifiant de ligne : c'est le même geste pour les quatre
   saveurs, donc une seule route et un seul câblage plutôt que quatre qui divergeraient. */
function marquer(id, { favori, titre } = {}) {
  const p = db.prepare('SELECT * FROM agent_pass WHERE id = ?').get(Number(id) || 0);
  if (!p) return null;
  const t = titre === undefined ? p.titre : String(titre || '').trim().slice(0, 120) || null;
  const f = favori === undefined ? p.favori : (favori ? 1 : 0);
  db.prepare('UPDATE agent_pass SET favori = ?, titre = ? WHERE id = ?').run(f, t, p.id);
  return { id: p.id, n: p.n, favori: f, titre: t };
}

// Une passe précise, avec le retour de l'agent lu sur disque.
function get(scope, taskId, unitId, n) {
  const p = db.prepare(`SELECT id, n, kind, prompt, output_path, created_at, favori, titre, cost_usd,
      base_sha, head_sha, diff_path FROM agent_pass
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

module.exports = { record, list, get, marquer, removeTask, attacherDiff, diffDe };
