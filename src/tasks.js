'use strict';
/* Créer une session de dev, en un seul endroit.
 *
 * L'insertion vivait dans `POST /api/tasks`. Les agents lancent la MÊME chose : un run d'agent
 * EST une `task` (spec agents, décision 11) — mêmes suivis, mêmes questions, mêmes passes
 * archivées, même file de jobs, même coût. Deux insertions parallèles auraient divergé au
 * premier champ ajouté, et la session d'agent aurait doucement cessé d'être une session.
 *
 * La route publique et `agentprofile.lancer()` appellent donc tous deux `creerTask`. Les trois
 * champs de plus (`agent_id`, `agent_name`, `triggered_by`) sont facultatifs : sans eux, le
 * comportement de la route est inchangé.
 */

const db = require('./db');
const agentsession = require('./agentsession');
const { t } = require('../public/i18n-runtime.js');

const repoById = (id) => db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(id) || 0);

// Nom de branche sûr : pas de flag (pas de `-` en tête), pas de `..`, caractères limités.
function assertValidBranch(branch) {
  const b = String(branch || '').trim();
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(b)) {
    throw new Error(t('err.nom-de-branche-invalide-lettres'));
  }
  return b;
}

function normalizeTargets(targets, kind) {
  if (!Array.isArray(targets) || !targets.length) throw new Error(t('err.selectionne-au-moins-un-projet'));
  const seen = new Set();
  /* Le paramètre ne s'appelle SURTOUT pas `t` : il masquerait la fonction de traduction du
     module, et chaque `t('err.…')` de ce bloc appellerait l'objet au lieu de traduire —
     « t is not a function » à la place du message d'erreur attendu. */
  return targets.map((cible) => {
    const repoId = Number(cible.repo_id);
    if (!repoId || !repoById(repoId)) throw new Error(t('err.projet-inconnu'));
    if (seen.has(repoId)) throw new Error(t('err.un-meme-projet-est-selectionne'));
    seen.add(repoId);
    const raw = (cible.branch || '').trim();
    if (kind === 'code' && !raw) throw new Error(t('err.nom-de-branche-requis-pour'));
    // branche de départ facultative : vide = branche par défaut du dépôt
    const base = (cible.base_branch || '').trim();
    return {
      repo_id: repoId,
      branch: raw ? assertValidBranch(raw) : null,
      base_branch: base ? assertValidBranch(base) : null,
    };
  });
}

function insertTargets(taskId, list, sessionId) {
  /* `sessionId` : session d'agent EXISTANTE fournie à la création. On la range comme si la
     première passe l'avait créée — les exécutants reprennent déjà une session dès qu'un
     handle est présent, il n'y a donc rien à changer chez eux. `session_cwd` reste NULL à
     dessein : on ignore d'où vient cette session, et le garde-fou « même cwd » ne doit pas
     refuser ce que l'utilisateur a explicitement demandé. Si la reprise échoue, le repli
     existant repart sur une session neuve avec le contexte réinjecté. */
  const ins = db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, session_key, session_backend, updated_at)
    VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`);
  const now = new Date().toISOString();
  const backend = sessionId ? agentsession.backendName() : null;
  for (const cible of list) ins.run(taskId, cible.repo_id, cible.branch, cible.base_branch || null, sessionId || null, backend, now);
}

/* Insère la session et ses projets. `champs` porte ce que la route a déjà validé (prompt,
   libellé, cases) ; `agent_*` et `triggered_by` restent nuls pour une session ordinaire. */
function creerTask(champs) {
  const {
    kind, prompt, branch, commitMessage, autoPush, askQuestions, verifierId, label,
    notifyJira, reviewAfter, targets, sessionId, agentId, agentName, triggeredBy, agentQuestion,
  } = champs;
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message, auto_push,
      ask_questions, verifier_id, label, notify_jira, review_after, agent_id, agent_name, triggered_by,
      agent_question, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`).run(
    targets[0].repo_id, kind, prompt, branch || '',
    commitMessage || null, autoPush ? 1 : 0, askQuestions ? 1 : 0, verifierId || null, label || null,
    notifyJira ? 1 : 0, reviewAfter ? 1 : 0,
    agentId || null, agentName || null, triggeredBy || 'manual', agentQuestion || null,
    now, now);
  const taskId = info.lastInsertRowid;
  insertTargets(taskId, targets, sessionId);
  return taskId;
}

module.exports = { creerTask, normalizeTargets, insertTargets, assertValidBranch, repoById };
