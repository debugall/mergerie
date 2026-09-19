'use strict';
/* L’exécutant d’une session de codage.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const taskrunner = require('../../session/taskrunner');
const { apresRun } = require('../../agent/profile/apres');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const { t } = require('../../core/i18n');
const { suiviAutomatique, todoQuestion, verifierApresSession } = require('../apres-session');
const { enregistrer, logLine, marquerFinExecution, setJob } = require('../file');

async function runTaskJob(jobId, taskId, action, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  const portee = (opts.targetIds && opts.targetIds.length) ? ` · ${opts.targetIds.length} projet(s) ciblé(s)` : '';
  logLine(jobId, null, `=== Session #${jobId} (${action})${portee} : ${task ? (task.kind === 'explore' ? 'exploration' : 'codage') : '?'} ===`);
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (action !== 'push') db.prepare("UPDATE task SET status='running', last_error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  try {
    if (action === 'push') await taskrunner.pushTarget(task.id, opts.targetId, onLog, { force: opts.force });
    else if (action === 'push-all') await taskrunner.pushTargets(task, opts.targetIds, onLog);
    else if (action === 'followup') await taskrunner.runTaskFollowup(task, opts.instruction, onLog, { targetIds: opts.targetIds, imageIds: opts.imageIds });
    else if (action === 'answer') await taskrunner.runTaskAnswer(task, opts.targetId, onLog);
    else if (action === 'update-base') await taskrunner.mettreAJourDepuisBase(task.id, opts.targetId, onLog);
    else await taskrunner.runTask(task, onLog, { targetIds: opts.targetIds });
    setJob(jobId, { status: 'done', done_count: 1, current_mr_id: null, finished_at: new Date().toISOString(), message: '' });
    /* CE QU'ON FAIT DE LA SORTIE D'UN AGENT : page de notes, création d'un agent de domaine,
       écarts constatés. AVANT le suivi automatique — un suivi enchaîne un second run, et la
       sortie du premier serait rangée après celle du second, ou pas du tout.
       Une erreur ici ne fait PAS échouer le job : le run a réussi, son Markdown est lisible ;
       c'est la sortie qui a un problème, et perdre le run avec serait le pire des deux. */
    if (task.agent_id) {
      try { await apresRun(db.prepare('SELECT * FROM task WHERE id = ?').get(task.id), onLog); }
      catch (e) { onLog(t('agents.log.output-failed', { message: e.message })); }
    }
    // La session peut s'être mise EN ATTENTE (l'agent a posé des questions) : notif dédiée,
    // pas « prête à push ». Sinon, codage terminé → prêt à push/MR.
    const after = db.prepare('SELECT status FROM task WHERE id = ?').get(task.id);
    if (after && after.status === 'needs_input') {
      notify.push('needs_input', { task_id: task.id });
      todoQuestion(task.id);
    } else if (action === 'run' || action === 'answer' || (action === 'followup' && opts.autoSuivi)) {
      /* Un suivi armé part MAINTENANT, et repasse ici en finissant : la notification de fin et
         la vérification attendent donc ce second tour. Annoncer « terminée » puis relancer
         l'agent dans la seconde serait mentir, et un verdict rendu sur du code qui va encore
         changer ne vaudrait rien. */
      if (!suiviAutomatique('task', task.id, onLog) && task.kind !== 'explore') {
        notify.push('session_done', { task_id: task.id });
        /* Le vérificateur choisi part maintenant, une fois. Pas sur un `followup` demandé à la
           main ni sur `push` — on vérifie ce qu'une session a produit, pas chaque geste qu'on
           pose ensuite. */
        await verifierApresSession(db.prepare('SELECT * FROM task WHERE id = ?').get(task.id), onLog);
      }
    }
    logLine(jobId, null, t('log.job.task-end', { id: jobId }));
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE task SET status='new', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
      logLine(jobId, null, t('log.job.task-stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE task SET status='error', last_error=?, updated_at=? WHERE id=?").run(full, new Date().toISOString(), task.id);
    logLine(jobId, null, `❌ Task ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: task.id, message: String(e.message).slice(0, 200) });
  } finally {
    // `push`/`push-all` déplacent du code déjà produit : la session n'a pas tourné.
    if (action !== 'push' && action !== 'push-all') marquerFinExecution('task', task.id);
  }
}

enregistrer('task', runTaskJob);

module.exports = {
  runTaskJob,
};
