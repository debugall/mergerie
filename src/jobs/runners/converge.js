'use strict';
/* L’exécutant de la convergence d’une merge request.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const converge = require('../../review/converge');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

// Exécute une boucle de convergence (« Converger ») : review → correction IA → re-review
// incrémentale, jusqu'au seuil / à la régression / au plafond. Un seul job de fond qui
// tient la file : les sous-étapes sont séquentielles à l'intérieur.
async function runConvergeJob(jobId, mrId, opts = {}) {
  setJob(jobId, { status: 'running', total: opts.maxPasses || 1, done_count: 0, current_mr_id: mrId, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);
  logLine(jobId, mrId, `=== Convergence #${jobId}${mr ? ` : MR !${mr.iid}` : ''} ===`);
  const onLog = (msg) => {
    logLine(jobId, mrId, msg);
    setJob(jobId, { message: String(msg).slice(0, 180) });
    // progression = nombre de passes déjà appliquées (best-effort d'après le log).
    const m = /passe (\d+)\//.exec(String(msg));
    if (m) setJob(jobId, { done_count: Number(m[1]) - 1 });
  };
  try {
    const r = await converge.convergeRun(mrId, opts, onLog);
    setJob(jobId, { status: 'done', done_count: r.passes, current_mr_id: null, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, mrId, t('log.job.converge-end', { id: jobId, status: r.status }));
  } catch (e) {
    if (proc.isCancelled()) {
      logLine(jobId, mrId, t('log.job.converge-stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare('UPDATE mr SET last_error = ?, updated_at = ? WHERE id = ?').run(full, new Date().toISOString(), mrId);
    logLine(jobId, mrId, `❌ Convergence ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { mr_id: mrId, iid: mr && mr.iid, message: String(e.message).slice(0, 200) });
  }
}

enregistrer('converge', runConvergeJob);

module.exports = {
  runConvergeJob,
};
