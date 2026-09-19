'use strict';
/* L’exécutant de la convergence d’une session de codage.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const converge = require('../../review/converge');
const { t } = require('../../core/i18n');
const { suiviAutomatique, todoQuestion, verifierApresSession } = require('../apres-session');
const { enregistrer, logLine, marquerFinExecution, setJob } = require('../file');

// Converge une SESSION de dev IA : dev → push → crée la MR → boucle de convergence,
// pour chaque projet de la session en série. Un seul job de fond.
async function runConvergeSessionJob(jobId, taskId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  logLine(jobId, null, `=== Convergence session #${jobId}${task ? ` : ${task.kind}` : ''} ===`);
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (task) db.prepare("UPDATE task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  try {
    const results = await converge.convergeSession(taskId, opts, onLog);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    // Pas de notification ici : convergeRun en pousse DÉJÀ une par MR convergée. En
    // rajouter une pour le premier projet doublonnerait le projet 1 sans rien dire des
    // autres. Le détail par projet reste dans le log du job.
    const converged = results.filter((r) => r.status === 'converged').length;
    // Une passe a pu mettre un projet EN ATTENTE (l'IA a posé une question) : la boucle s'est
    // arrêtée là, on avertit pour que l'utilisateur réponde puis relance Converger.
    const after = db.prepare('SELECT status FROM task WHERE id = ?').get(taskId);
    if (after && after.status === 'needs_input') { notify.push('needs_input', { task_id: taskId }); todoQuestion(taskId); }
    /* APRÈS la boucle, pas à chaque passe : vérifier trois fois de suite le même dépôt coûterait
       trois montages d'environnement pour un seul verdict qui compte, le dernier. On ne lance
       pas non plus si un projet attend une réponse — le code n'est pas fini. */
    if (!after || after.status !== 'needs_input') {
      // Même ordre qu'après une session simple : le suivi armé d'abord, le verdict ensuite.
      if (!suiviAutomatique('task', taskId, onLog)) {
        await verifierApresSession(db.prepare('SELECT * FROM task WHERE id = ?').get(taskId), onLog);
      }
    }
    logLine(jobId, null, t('log.job.converge-session-end', { id: jobId, ok: converged, total: results.length }));
  } catch (e) {
    if (proc.isCancelled()) {
      if (task) db.prepare("UPDATE task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, t('log.job.converge-session-stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    if (task) db.prepare("UPDATE task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, `❌ Convergence session ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: taskId, message: String(e.message).slice(0, 200) });
  } finally {
    // Converger fait tourner l'agent, plusieurs fois : c'est bien une exécution de la session.
    marquerFinExecution('task', taskId);
  }
}

enregistrer('converge-session', runConvergeSessionJob);

module.exports = {
  runConvergeSessionJob,
};
