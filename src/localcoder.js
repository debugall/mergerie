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
const { getConfig } = require('./config');
const { avecConsignes } = require('./prompts');
const questions = require('./questions');
const pieces = require('./pieces');
const { t } = require('../public/i18n-runtime.js');

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
const lireQuestions = (d) => {
  try { return d && d.questions_json ? JSON.parse(d.questions_json) : []; } catch { return []; }
};

function syncStatus(taskId) {
  const dirs = db.prepare('SELECT status FROM local_task_dir WHERE task_id = ?').all(taskId);
  let status = 'done';
  if (dirs.some((d) => d.status === 'running')) status = 'running';
  /* UN DOSSIER QUI ATTEND UNE RÉPONSE tient toute la session en attente : afficher « terminée »
     alors qu'une question est posée ferait passer à autre chose sans y répondre — et le travail
     de ce dossier-là ne repartirait jamais. */
  else if (dirs.some((d) => d.status === 'needs_input')) status = 'needs_input';
  else if (dirs.length && dirs.every((d) => d.status === 'error')) status = 'error';
  db.prepare('UPDATE local_task SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), taskId);
}

/* Une passe de l'IA sur tous les dossiers de la session.
   `opts.instruction` = demande de suivi : le prompt change et la session d'agent de
   chaque dossier est REPRISE (l'IA garde le contexte de ce qu'elle vient de faire).
   `opts.answersDirId` = reprise après questions : SEUL ce dossier repart, avec les réponses
   pour prompt — les autres n'ont rien demandé et n'ont pas à retravailler.
   `opts.dirIds` = relance ciblée : on ne refait QUE ces dossiers. Sur une session à cinq
   dossiers dont un a échoué, tout relancer coûte quatre passes d'agent pour rien. */
async function runLocal(taskId, onLog = () => {}, opts = {}) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task) throw new Error(t('err.session-introuvable'));
  const reponses = opts.answersDirId ? Number(opts.answersDirId) : null;
  const followup = String(opts.instruction || '').trim();
  const passKind = reponses ? 'answer' : (followup ? 'followup' : 'run');
  const voulus = Array.isArray(opts.dirIds) && opts.dirIds.length
    ? new Set(opts.dirIds.map(Number)) : null;
  const dirs = db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId)
    .filter((d) => (reponses ? d.id === reponses : (!voulus || voulus.has(d.id))));
  if (!dirs.length) throw new Error(t('err.local.no-dir'));
  db.prepare("UPDATE local_task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);

  // Captures jointes : référencées par chemin ABSOLU (l'agent tourne en place dans le
  // dossier de l'utilisateur, sans clone — on ne copie donc rien dans ses dossiers).
  /* Pièces jointes : chemins ABSOLUS, jamais copiées. L'agent travaille EN PLACE dans le
     dossier de l'utilisateur — y déposer des fichiers de travail y laisserait des traces que
     personne n'a demandées. La règle « consigne initiale + suivi en cours » vit dans
     `pieces.js`, partagée avec les autres saveurs. */
  const imgBlock = pieces.blocPrompt('local', taskId, { ids: opts.imageIds, onLog });

  // Suivi : même esprit que `taskrunner.runTaskFollowup`, sans la mention de git
  // (ici l'IA travaille EN PLACE, il n'y a ni branche ni commit précédent).
  /* Les consignes permanentes des réglages valent ICI AUSSI : « hors dépôt » change l'endroit
     où l'IA travaille, pas la façon dont on veut qu'elle travaille. */
  /* Reprise après réponses : le prompt EST la réponse aux questions. L'agent garde le reste
     dans sa session — réexpliquer la tâche lui ferait recommencer au lieu de continuer. */
  const repondu = reponses
    ? questions.buildAnswerInstruction(lireQuestions(dirs[0]))
    : null;
  const promptText = avecConsignes(repondu || (followup
    ? 'Tu as déjà travaillé dans ce dossier lors d’une passe précédente. Applique la demande '
      + `de suivi ci-dessous en modifiant directement les fichiers.\n\nDemande de suivi : ${followup}${imgBlock}`
    : 'Réalise la tâche de développement suivante dans ce dossier. '
      + `Modifie directement les fichiers nécessaires.\n\n${task.prompt}${imgBlock}`),
  getConfig().ai_extra_instructions)
    /* Option « l'IA peut poser des questions » : hors dépôt aussi. C'est même là qu'elle
       compte le plus — l'agent travaille EN PLACE, sans branche ni commit à relire : mieux
       vaut une question qu'un fichier réécrit selon une hypothèse qu'on n'a pas validée. */
    + (task.ask_questions ? questions.QUESTIONS_INSTRUCTION : '');

  /* L'AGENT S'EST ARRÊTÉ POUR DEMANDER. Le dossier passe EN ATTENTE — ni succès ni échec —
     et garde ses questions ; la file se libère. Rendre `true` fait sauter la fin du tour :
     marquer « fait » un dossier où rien n'a été décidé serait le pire des deux. */
  function attendQuestions(tache, id, dossier, texte, log) {
    if (!tache.ask_questions) return false;
    const qs = questions.parseQuestions(texte);
    if (!qs || !qs.length) return false;
    setDir(dossier.id, { questions_json: JSON.stringify(qs), status: 'needs_input', last_error: null });
    log(t('log.task.questions', { n: qs.length, count: qs.length }));
    return true;
  }

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
      if (copilot.isDryRun() && task.ask_questions && !followup && !reponses) {
        // Dry-run, première passe : l'agent simule ses questions plutôt que de coder.
        onLog('$ (DRY-RUN — l’agent pose des questions)');
        saveAgentOutput(taskId, d.id, questions.DRYRUN_QUESTIONS, { kind: passKind, prompt: promptText });
        attendQuestions(task, taskId, d, questions.DRYRUN_QUESTIONS, onLog);
        continue;
      } else if (copilot.isDryRun()) {
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
        // À chaque passe : une reprise peut rendre un identifiant nouveau (cf. agentsession).
        setDir(d.id, { session_key: r.handle, session_backend: r.backend, session_cwd: d.path });
        if (attendQuestions(task, taskId, d, r.text, onLog)) continue;
      } else {
        // Backend non reprenable → appel one-shot (pas de commande de reprise possible).
        const out = await copilot.runPrompt(promptText, d.path, { kind: 'task' }, onLog); // renvoie le texte
        saveAgentOutput(taskId, d.id, out, { kind: passKind, prompt: promptText });
        if (attendQuestions(task, taskId, d, out, onLog)) continue;
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
  onLog(t('log.local.done', { ok, total: dirs.length }));
  // Échec total (hors annulation) → on lève pour que le job soit marqué en erreur.
  /* « Aucun dossier traité » n'est une ERREUR que si personne n'a rien demandé. Un dossier
     qui ATTEND une réponse n'a pas échoué : il s'est arrêté exprès, et faire échouer la
     session effacerait la question au lieu de la poser. */
  const attente = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'").get(taskId).c;
  if (!ok && !attente && !proc.isCancelled()) throw new Error(t('err.local.none-handled'));
}

/* Demande de correction : une nouvelle passe qui REPREND la session de chaque dossier.
   Les dossiers jamais traités (aucune session) sont sautés — il n'y a rien à corriger. */
async function runLocalFollowup(taskId, instruction, onLog = () => {}) {
  const instr = String(instruction || '').trim();
  if (!instr) throw new Error('Demande de suivi vide');
  return runLocal(taskId, onLog, { instruction: instr });
}

module.exports = { runLocal, runLocalFollowup, saveAgentOutput };
