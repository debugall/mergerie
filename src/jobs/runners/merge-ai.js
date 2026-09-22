'use strict';
/* L’exécutant de « Demander à l’IA » sur un conflit de merge (onglet Git → Merge). */
const proc = require('../../core/proc');
const mergeai = require('../../session/mergeai');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function runMergeAiJob(jobId, mergeId) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.merge-ai-start', { id: jobId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await mergeai.proposer(mergeId, onLog);
    if (proc.isCancelled()) {
      logLine(jobId, null, t('log.job.stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.merge-ai-end', { id: jobId }));
  } catch (e) {
    if (proc.isCancelled()) {
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    logLine(jobId, null, t('log.job.merge-ai-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
  }
}

enregistrer('merge-ai', runMergeAiJob);

module.exports = { runMergeAiJob };
