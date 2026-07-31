'use strict';
/* « Codage hors dépôt » : l'IA réalise le prompt DIRECTEMENT dans des dossiers locaux
   arbitraires, EN PLACE — aucun git (ni branche, ni commit, ni push, ni diff). Chaque
   dossier est traité l'un après l'autre ; un dossier en échec n'interrompt pas les autres.

   ⚠ Pas de filet : l'agent modifie les fichiers du dossier fourni par l'utilisateur.
   La confirmation et l'avertissement se font côté UI ; ici on exécute. */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const copilot = require('./copilot');
const agentsession = require('./agentsession');
const proc = require('./proc');
const agentpass = require('./agentpass');

const now = () => new Date().toISOString();

/* Retour de l'agent pour UN dossier : ce qu'il dit avoir fait. C'est la seule fenêtre
   sur le travail quand rien n'a changé dans le dossier — typiquement quand l'IA a
   RÉPONDU au lieu de coder (prompt incomplet). Chaque itération est conservée
   (prompt + retour) via `agentpass` ; `output_path` pointe la plus récente. */
function saveAgentOutput(taskId, dirId, text, meta = {}) {
  const { outPath } = agentpass.record('local', taskId, dirId, {
    kind: meta.kind || 'run', prompt: meta.prompt, text,
  });
  if (outPath) setDir(dirId, { output_path: outPath });
}

function setDir(id, patch) {
  const cols = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE local_task_dir SET ${cols}, updated_at = @u WHERE id = @id`).run({ ...patch, u: now(), id });
}

// Statut agrégé de la session à partir de ses dossiers.
function syncStatus(taskId) {
  const dirs = db.prepare('SELECT status FROM local_task_dir WHERE task_id = ?').all(taskId);
  let status = 'done';
  if (dirs.some((d) => d.status === 'running')) status = 'running';
  else if (dirs.length && dirs.every((d) => d.status === 'error')) status = 'error';
  db.prepare('UPDATE local_task SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), taskId);
}

/* Une passe de l'IA sur tous les dossiers de la session.
   `opts.instruction` = demande de suivi : le prompt change et la session d'agent de
   chaque dossier est REPRISE (l'IA garde le contexte de ce qu'elle vient de faire). */
async function runLocal(taskId, onLog = () => {}, opts = {}) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task) throw new Error('Session introuvable');
  const followup = String(opts.instruction || '').trim();
  const passKind = followup ? 'followup' : 'run';
  const dirs = db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId);
  if (!dirs.length) throw new Error('Aucun dossier');
  db.prepare("UPDATE local_task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);

  // Captures jointes : référencées par chemin ABSOLU (l'agent tourne en place dans le
  // dossier de l'utilisateur, sans clone — on ne copie donc rien dans ses dossiers).
  const imgs = db.prepare('SELECT path FROM local_task_image WHERE task_id = ? ORDER BY id').all(taskId)
    .filter((im) => { try { return fs.existsSync(im.path); } catch { return false; } });
  const imgBlock = imgs.length
    ? `\n\nDes captures d'écran sont fournies (ouvre-les) :${imgs.map((im) => `\n- \`${im.path}\``).join('')}`
    : '';

  // Suivi : même esprit que `taskrunner.runTaskFollowup`, sans la mention de git
  // (ici l'IA travaille EN PLACE, il n'y a ni branche ni commit précédent).
  const promptText = followup
    ? 'Tu as déjà travaillé dans ce dossier lors d’une passe précédente. Applique la demande '
      + `de suivi ci-dessous en modifiant directement les fichiers.\n\nDemande de suivi : ${followup}${imgBlock}`
    : 'Réalise la tâche de développement suivante dans ce dossier. '
      + `Modifie directement les fichiers nécessaires.\n\n${task.prompt}${imgBlock}`;

  let ok = 0;
  for (const d of dirs) {
    if (proc.isCancelled()) break;
    onLog(`──────── ${d.path} ────────`);
    setDir(d.id, { status: 'running', last_error: null });
    try {
      // Chemin fourni par l'utilisateur : on vérifie juste qu'il désigne un dossier.
      let st;
      try { st = fs.statSync(d.path); } catch { throw new Error('Dossier introuvable'); }
      if (!st.isDirectory()) throw new Error('Le chemin n’est pas un dossier');

      onLog(`codage (${copilot.isDryRun() ? 'dry-run' : 'IA'})`);
      if (copilot.isDryRun()) {
        // dry-run : trace visible, aucune vraie modification de code.
        fs.appendFileSync(path.join(d.path, 'PROJ_LOCAL_DRYRUN.md'), `\n## ${task.prompt.slice(0, 120)}\n`, 'utf8');
        saveAgentOutput(taskId, d.id, `(dry-run) ${followup ? 'Suivi appliqué' : 'Tâche réalisée'} dans \`${d.path}\`.`, { kind: passKind, prompt: promptText });
      } else if (agentsession.backendName() !== 'unknown') {
        // Session reprenable par dossier (clé local-<task>-dir-<id>) → commande de reprise copiable.
        const key = `local-${taskId}-dir-${d.id}`;
        // Une demande de suivi n'a de sens qu'en reprise : sans le contexte de la passe
        // précédente, l'IA relirait tout et « corrige ceci » ne voudrait rien dire.
        const doResume = !!d.session_key;
        let r; let created = !doResume;
        try {
          r = await agentsession.runInSession({ key, handle: doResume ? d.session_key : null, prompt: promptText, cwd: d.path, resume: doResume, onLog });
        } catch (e) {
          if (!doResume) throw e;
          onLog(`⚠ reprise impossible (${String(e.message).split('\n')[0]}) → session neuve`);
          r = await agentsession.runInSession({ key, prompt: promptText, cwd: d.path, resume: false, onLog });
          created = true;
        }
        copilot.recordUsage('task', promptText, r.text || '');
        saveAgentOutput(taskId, d.id, r.text, { kind: passKind, prompt: promptText });
        if (created) setDir(d.id, { session_key: r.handle, session_backend: r.backend, session_cwd: d.path });
      } else {
        // Backend non reprenable → appel one-shot (pas de commande de reprise possible).
        const out = await copilot.runPrompt(promptText, d.path, { kind: 'task' }, onLog); // renvoie le texte
        saveAgentOutput(taskId, d.id, out, { kind: passKind, prompt: promptText });
      }
      setDir(d.id, { status: 'done', last_error: null });
      onLog(`✅ ${d.path}`);
      ok += 1;
    } catch (e) {
      setDir(d.id, { status: 'error', last_error: String(e.message) });
      onLog(`⚠ ${d.path} : ${e.message}`);
    }
  }
  syncStatus(taskId);
  onLog(`${ok}/${dirs.length} dossier(s) traité(s)`);
  // Échec total (hors annulation) → on lève pour que le job soit marqué en erreur.
  if (!ok && !proc.isCancelled()) throw new Error('Aucun dossier n’a pu être traité');
}

/* Demande de correction : une nouvelle passe qui REPREND la session de chaque dossier.
   Les dossiers jamais traités (aucune session) sont sautés — il n'y a rien à corriger. */
async function runLocalFollowup(taskId, instruction, onLog = () => {}) {
  const instr = String(instruction || '').trim();
  if (!instr) throw new Error('Demande de suivi vide');
  return runLocal(taskId, onLog, { instruction: instr });
}

module.exports = { runLocal, runLocalFollowup, saveAgentOutput };
