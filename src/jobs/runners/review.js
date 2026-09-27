'use strict';
/* L’exécutant des jobs de review : review, rereview, modify, ask-review, explain — une liste de merge requests, l’une après l’autre.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const { reviewMr, modifyReview, askReview, explainMr } = require('../../review/reviewer');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function processList(jobId, rows, kind, opts = {}) {
  const startedAt = new Date().toISOString();
  setJob(jobId, { status: 'running', total: rows.length, done_count: 0, started_at: startedAt, message: t('job.msg.starting') });
  try {
    let i = 0;
    logLine(jobId, null, t('log.job.review-start', { id: jobId, kind, n: rows.length, count: rows.length }));
    for (const row of rows) {
      if (proc.isCancelled()) break;
      const repo = { id: row.repo_id, project: row.project, url: row.url, branch_pattern: row.branch_pattern };
      const mr = row;
      setJob(jobId, { current_mr_id: mr.id, message: `MR !${mr.iid} — ${mr.title || ''}`.slice(0, 200) });
      logLine(jobId, mr.id, `\n──── MR !${mr.iid} — ${mr.title || ''} (${mr.source_branch} → ${mr.target_branch}) ────`);
      const onLog = (msg) => {
        // chaque ligne va dans le log persistant ET met à jour le message de progression
        logLine(jobId, mr.id, msg);
        setJob(jobId, { message: `!${mr.iid} : ${String(msg).slice(0, 180)}` });
      };
      try {
        if (kind === 'modify') {
          await modifyReview(repo, mr, opts.instruction || '', onLog);
          logLine(jobId, mr.id, t('log.job.report-updated', { iid: mr.iid }));
        } else if (kind === 'ask-review') {
          /* Une QUESTION : elle ne touche ni au rapport ni à sa note. Le job n'a donc rien à
             invalider ni à recharger — seul l'historique des échanges s'allonge. */
          await askReview(repo, mr, opts.question || '', onLog);
          logLine(jobId, mr.id, t('log.job.review-answered', { iid: mr.iid }));
        } else if (kind === 'explain') {
          await explainMr(repo, mr, onLog);
          logLine(jobId, mr.id, t('log.job.explained', { iid: mr.iid }));
        } else {
          // opts.explain (true/false) surcharge le réglage global ; undefined = suit le réglage.
          // opts.incremental (re-review) : ne reviewer que le delta depuis le dernier SHA reviewé.
          await reviewMr(repo, mr, onLog, { explain: opts.explain, incremental: opts.incremental });
          logLine(jobId, mr.id, t('log.job.reviewed', { iid: mr.iid, inc: opts.incremental ? t('log.job.inc') : '' }));
        }
      } catch (e) {
        if (proc.isCancelled()) {
          // arrêt demandé par l'utilisateur : pas une "erreur" de MR
          logLine(jobId, mr.id, t('log.job.mr-stopped', { iid: mr.iid }));
          break;
        }
        // message tronqué pour la barre de progression...
        setJob(jobId, { message: `!${mr.iid} ERREUR : ${e.message}`.slice(0, 300) });
        // ...mais on persiste l'erreur COMPLÈTE sur la MR pour l'afficher/copier.
        const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
        db.prepare('UPDATE mr SET last_error = ?, updated_at = ? WHERE id = ?')
          .run(full, new Date().toISOString(), mr.id);
        logLine(jobId, mr.id, `❌ MR !${mr.iid} ERREUR : ${e.message}`);
        notify.push('job_failed', { mr_id: mr.id, iid: mr.iid, message: String(e.message).slice(0, 200) });
        // on continue avec les autres MR
      }
      i += 1;
      setJob(jobId, { done_count: i });
    }
    const stopped = proc.isCancelled();
    const finalStatus = stopped ? 'stopped' : 'done';
    if (!stopped && (kind === 'review' || kind === 'rereview') && i > 0) {
      notify.push('queue_done', { count: i }); // le lot est terminé
    }
    logLine(jobId, null, t('log.job.review-end', { id: jobId, etat: t(stopped ? 'log.job.state-stopped' : 'log.job.state-done'), done: i, total: rows.length }));
    setJob(jobId, {
      status: finalStatus, current_mr_id: null, finished_at: new Date().toISOString(),
      message: stopped ? t('job.msg.count-partial', { done: i, total: rows.length }) : t('job.msg.count', { n: rows.length, total: rows.length }),
    });
  } catch (e) {
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { message: String(e.message).slice(0, 200) });
  }
}

enregistrer('review', processList);

module.exports = {
  processList,
};
