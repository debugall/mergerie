'use strict';
/* L’exécutant de la réconciliation d’une session avec l’état réel de ses branches.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const taskrunner = require('../../session/taskrunner');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

/* Réconciliation : on relit l'état réel des branches d'une session et on répare les cibles
   dont le travail existe déjà. Passe par la FILE, comme tout ce qui touche à un clone : le faire
   pendant qu'un agent écrit dans le même dépôt le corromprait. Pas de retry — l'opération est
   idempotente, on la relance à la main si besoin. */
async function runReconcileJob(jobId, taskId, opts = {}) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  logLine(jobId, null, t('log.job.reconcile-start', { id: jobId }));
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const r = await taskrunner.reconcileTargets(task, onLog, opts);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.reconcile-end', { done: r.repaired, total: r.checked }));
  } catch (e) {
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    logLine(jobId, null, t('log.job.reconcile-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    void full;
  }
}

enregistrer('reconcile', runReconcileJob);

module.exports = {
  runReconcileJob,
};
