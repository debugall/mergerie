'use strict';
/* L’exécutant d’une question libre.
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const asker = require('../../session/asker');
const { t } = require('../../core/i18n');
const { suiviAutomatique } = require('../apres-session');
const { enregistrer, logLine, marquerFinExecution, setJob } = require('../file');

async function runAskJob(jobId, questionId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.ask-start', { id: jobId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await asker.runQuestion(questionId, onLog, opts);
    if (proc.isCancelled()) {
      db.prepare("UPDATE question SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), questionId);
      logLine(jobId, null, t('log.job.stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.ask-end', { id: jobId }));
    if (!suiviAutomatique('ask', questionId, onLog)) notify.push('session_done', { question_id: questionId });
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE question SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), questionId);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE question SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?")
      .run(full, new Date().toISOString(), questionId);
    logLine(jobId, null, t('log.job.ask-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { question_id: questionId, message: String(e.message).slice(0, 200) });
  } finally {
    marquerFinExecution('question', questionId);
  }
}

enregistrer('ask', runAskJob);

module.exports = {
  runAskJob,
};
