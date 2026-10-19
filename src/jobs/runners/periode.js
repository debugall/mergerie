'use strict';
/* L'exécutant du rattrapage d'une période : plusieurs dépôts × un fetch git × des appels de forge
   paginés — ça ne tient pas dans une requête HTTP. Le front suit la progression comme pour une
   découverte, et l'écran se redessine à la fin. Le job réserve ses dépôts (`jobKeys`) : il
   FETCH dans le clone, et deux jobs dans le même clone le corrompent.
   Et son résumé IA (`periode-resume`) : un appel, sur demande, qui ne touche aucun clone. */
const db = require('../../db');
const periode = require('../../notes/periode');
const resume = require('../../notes/periode-resume');
const proc = require('../../core/proc');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

const fini = (jobId, patch) => setJob(jobId, { finished_at: new Date().toISOString(), ...patch });

async function runPeriodeJob(jobId, periodeId) {
  const p = db.prepare('SELECT * FROM periode WHERE id = ?').get(Number(periodeId));
  logLine(jobId, null, t('log.job.periode-start', { id: jobId }));
  if (!p) { fini(jobId, { status: 'error', message: t('err.periode.introuvable') }); return; }
  setJob(jobId, { status: 'running', started_at: new Date().toISOString(), message: t('job.msg.starting') });
  db.prepare('UPDATE periode SET job_id = ? WHERE id = ?').run(jobId, p.id);
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    let repoIds = null;
    try { repoIds = p.repo_ids ? JSON.parse(p.repo_ids) : null; } catch { repoIds = null; }
    const r = await periode.construire({ depuis: p.depuis, jusqua: p.jusqua, repoIds, onLog });
    if (proc.isCancelled()) { fini(jobId, { status: 'stopped', message: t('job.msg.cancelled-queued') }); return; }
    if (r.demo) { fini(jobId, { status: 'done', done_count: 1, total: 1, message: '' }); return; }
    periode.enregistrer(p.id, r);
    const n = r.repos.reduce((s, x) => s + x.items.length, 0) + r.team.length + r.jira.length + r.mergerie.length;
    const partiels = r.repos.filter((x) => x.partiel.length).length;
    logLine(jobId, null, t('log.job.periode-end', { n, count: n, partiels }));
    fini(jobId, { status: 'done', done_count: 1, total: 1, message: '' });
  } catch (e) {
    if (proc.isCancelled()) { fini(jobId, { status: 'stopped', message: t('job.msg.cancelled-queued') }); return; }
    logLine(jobId, null, t('log.job.periode-error', { message: e.message }));
    fini(jobId, { status: 'error', message: e.message });
  }
}

async function runPeriodeResumeJob(jobId, periodeId) {
  logLine(jobId, null, t('log.job.periode-resume-start', { id: jobId }));
  setJob(jobId, { status: 'running', started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const texte = await resume.resumer(periodeId, onLog);
    if (proc.isCancelled()) { fini(jobId, { status: 'stopped', message: t('job.msg.cancelled-queued') }); return; }
    logLine(jobId, null, t('log.job.periode-resume-end', { n: texte.length }));
    fini(jobId, { status: 'done', done_count: 1, total: 1, message: '' });
  } catch (e) {
    if (proc.isCancelled()) { fini(jobId, { status: 'stopped', message: t('job.msg.cancelled-queued') }); return; }
    logLine(jobId, null, t('log.job.periode-error', { message: e.message }));
    fini(jobId, { status: 'error', message: e.message });
  }
}

enregistrer('periode', runPeriodeJob);
enregistrer('periode-resume', runPeriodeResumeJob);

module.exports = { runPeriodeJob, runPeriodeResumeJob };
