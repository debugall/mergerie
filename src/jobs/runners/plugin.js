'use strict';
/* L'exécutant des jobs qu'un PLUGIN a inscrit (`ctx.jobs`). Le runner du plugin reçoit un `job` : le journal de la file, la progression,
   `exec` (dont le « Stop » tue le groupe de processus) et `isCancelled`. Il peut tourner dans un worker : le runner n'est alors qu'un
   relais, et `job` traverse la frontière op par op (`hote-worker.js`). */
const db = require('../../db');
const proc = require('../../core/proc');
const { t } = require('../../core/i18n');
const jobsPlugins = require('../../plugins/jobs-plugins');
const { creerJob } = require('../../../sdk/lib/jobs');
const { enregistrer, logLine, setJob, queue } = require('../file');

/* Le démarreur injecté dans `plugins/jobs-plugins` : une ligne `job` dont le genre est `plugin:<nom>`, une entrée dans la file. */
function demarrerJobPlugin(plugin, kind, payload, options) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES (?, 'queued', 1, 0, ?, ?)`).run(`plugin:${plugin}`, String(options.label || 'en file').slice(0, 180), new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: `plugin:${plugin}`, payload: { plugin, kind, data: payload } });
  setImmediate(() => require('../ordonnanceur').pump());
  return db.prepare('SELECT id, kind, status, message FROM job WHERE id = ?').get(jobId);
}
jobsPlugins.brancher(demarrerJobPlugin);

async function runPluginJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const fiche = jobsPlugins.trouver(payload.plugin, payload.kind);
  try {
    if (!fiche) throw new Error(t('err.plugins.inactif', { name: payload.plugin }));
    const job = creerJob(payload.plugin, {
      id: jobId,
      log: (texte) => { logLine(jobId, null, texte); },
      message: (texte) => setJob(jobId, { message: String(texte).slice(0, 180) }),
      progress: (done, total) => setJob(jobId, { done_count: done, total: Math.max(total, 1) }),
      estAnnule: () => proc.isCancelled(),
      exec: fiche.exec,
    });
    /* Les opérations d'un runner tiers arrivent par message, hors du contexte asynchrone du job : `exec` y RENTRE, pour que « Stop » tue ce qu'il lance. */
    const c = proc.courant();
    const lie = Object.freeze({ ...job, exec: (...a) => proc.dans(c, () => job.exec(...a)) });
    jobsPlugins.lier(jobId, lie);
    await fiche.runner(lie, payload.data);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
  } catch (e) {
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: String((e && e.message) || e).slice(0, 300) });
  } finally { jobsPlugins.delier(jobId); }
}

enregistrer('plugin', runPluginJob);

module.exports = { runPluginJob };
