'use strict';
/* L’exécutant d’une session hors dépôt.
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const localcoder = require('../../session/localcoder');
const { t } = require('../../core/i18n');
const { suiviAutomatique, todoQuestionLocal } = require('../apres-session');
const { enregistrer, logLine, marquerFinExecution, setJob } = require('../file');

// Exécute une session « Codage hors dépôt » : l'IA code dans chaque dossier local, en
// place, sans git. Un seul job de fond ; les dossiers sont traités en série.
async function runLocalJob(jobId, taskId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.local-start', { id: jobId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await localcoder.runLocal(taskId, onLog, opts);
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, t('log.job.stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.local-end', { id: jobId }));
    /* UN DOSSIER ATTEND UNE RÉPONSE : ce n'est ni une fin ni un échec. On prévient, on pose la
       todo, et surtout on n'arme PAS le suivi automatique — il repartirait sur une question
       restée sans réponse. */
    const attente = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'").get(taskId).c;
    if (attente) {
      notify.push('needs_input', { local_task_id: taskId });
      todoQuestionLocal(taskId);
    } else if (!suiviAutomatique('local', taskId, onLog)) {
      notify.push('session_done', { local_task_id: taskId });
    }
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE local_task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, t('log.job.local-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { local_task_id: taskId, message: String(e.message).slice(0, 200) });
  } finally {
    marquerFinExecution('local_task', taskId);
  }
}

enregistrer('local', runLocalJob);

module.exports = {
  runLocalJob,
};
