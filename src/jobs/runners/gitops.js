'use strict';
/* L’exécutant des opérations git multi-dépôts (onglet Git).
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const proc = require('../../core/proc');
const gitops = require('../../git/gitops');
const notify = require('../../core/notify');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function runGitJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const r = payload.restoreOpId
      ? await gitops.restore(payload.restoreOpId, onLog)
      : await gitops.execute(payload, onLog);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    /* B14 — UNE OPÉRATION GIT NOTIFIE. Elle ne disait rien, ni en réussissant ni en échouant :
       on supprimait douze branches, on changeait d'onglet, et on ne savait plus si c'était
       passé. Ce sont pourtant les gestes les plus IRRÉVERSIBLES de l'outil — ceux dont on veut
       une confirmation, justement parce qu'on est déjà parti voir ailleurs. */
    notify.push('git_done', {
      action: payload.restoreOpId ? 'restore' : payload.action,
      n: (r && r.results ? r.results.filter((x) => x.ok).length : 1),
    });
    return r;
  } catch (e) {
    // Un arrêt DEMANDÉ n'est pas un échec. Sans ce test, le Stop de l'utilisateur
    // s'affichait en rouge avec « Job arrêté par l'utilisateur » en guise d'erreur —
    // inquiétant à lire, et faux. Les autres exécutants le distinguaient déjà.
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return null;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { message: String(e.message).slice(0, 200) });
  }
  return null;
}

enregistrer('gitops', runGitJob);

module.exports = {
  runGitJob,
};
