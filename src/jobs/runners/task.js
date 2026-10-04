'use strict';
/* L’exécutant d’une session de codage.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const taskrunner = require('../../session/taskrunner');
const { apresRun } = require('../../agent/profile/apres');
const spec = require('../../session/spec');
const { exigerApprobation } = require('../../agent/profile/modele');
const proc = require('../../core/proc');
const notify = require('../../core/notify');
const events = require('../../core/events');
const { t } = require('../../core/i18n');
const { suiviAutomatique, todoQuestion, verifierApresSession } = require('../apres-session');
const { enregistrer, logLine, marquerFinExecution, setJob } = require('../file');
const cli = require('../../agent/cli');

async function runTaskJob(jobId, taskId, action, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  const portee = (opts.targetIds && opts.targetIds.length) ? ` · ${opts.targetIds.length} projet(s) ciblé(s)` : '';
  logLine(jobId, null, `=== Session #${jobId} (${action})${portee} : ${task ? (task.kind === 'explore' ? 'exploration' : 'codage') : '?'} ===`);
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg, annexe) => { logLine(jobId, null, msg, annexe); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (action !== 'push') db.prepare("UPDATE task SET status='running', last_error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  /* Le bus : un plugin peut réagir au départ et à la fin d'une session, sans rien savoir des runners. */
  const estSession = action !== 'push' && action !== 'push-all';
  if (estSession) events.emit('session.started', { kind: 'task', id: task.id, action }).catch(() => {});
  let fin = 'done';
  try {
    /* RÉ-APPROBATION AU DÉMARRAGE DU JOB, PAS SEULEMENT AU LANCEMENT (plan_secure.md, lot C,
       point 3) : `lancer()` (`agent/profile/lancer.js`) vérifie l'approbation en créant la
       tâche, mais la file peut retarder l'exécution — la boucle de synchro tourne toutes les
       30 s. Un `pull` qui change les permissions ou l'horaire de l'agent entre les deux ferait
       tourner, sans surveillance, ce qui n'a jamais été vu ici. `push`/`push-all` ne lancent
       aucun agent — rien à réapprouver, ils déplacent du code déjà produit. */
    if (task.agent_id && action !== 'push' && action !== 'push-all') {
      const agent = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
      if (agent) exigerApprobation(agent);
    }
    if (action === 'push') await taskrunner.pushTarget(task.id, opts.targetId, onLog, { force: opts.force });
    else if (action === 'push-all') await taskrunner.pushTargets(task, opts.targetIds, onLog);
    /* LE BINAIRE CHOISI PAR LA SESSION (`task.cli_id`) est posé sur le contexte du job : toutes
       les passes — première, suivi, réponses, plan approuvé, rebase — partent avec lui. */
    else await cli.avecSession(task, onLog, async () => {
      if (action === 'followup') await taskrunner.runTaskFollowup(task, opts.instruction, onLog, { targetIds: opts.targetIds, imageIds: opts.imageIds });
      else if (action === 'answer') await taskrunner.runTaskAnswer(task, opts.targetId, onLog);
      else if (action === 'approve-plan') await taskrunner.runTaskApprovePlan(task, opts.targetIds, opts.instruction, onLog);
      else if (action === 'revise-plan') await taskrunner.runTaskRevisePlan(task, opts.targetIds, opts.instruction, onLog);
      else if (action === 'update-base') await taskrunner.mettreAJourDepuisBase(task.id, opts.targetId, onLog);
      else await taskrunner.runTask(task, onLog, { targetIds: opts.targetIds });
    });
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
    /* LA SPEC D'UN TICKET : la session a produit (ou non) son bloc <<<SPEC>>>, ou s'est arrêtée
       sur des questions. Même règle que la sortie d'un agent : une erreur ici ne fait pas
       échouer le job, le Markdown reste lisible dans Dev IA. */
    try { spec.apresRun(db.prepare('SELECT * FROM task WHERE id = ?').get(task.id), onLog); }
    catch (e) { onLog(t('agents.log.output-failed', { message: e.message })); }
    // La session peut s'être mise EN ATTENTE (l'agent a posé des questions) : notif dédiée,
    // pas « prête à push ». Sinon, codage terminé → prêt à push/MR.
    const after = db.prepare('SELECT status FROM task WHERE id = ?').get(task.id);
    if (after && (after.status === 'needs_input' || after.status === 'planned')) fin = 'needs_input';
    if (after && after.status === 'needs_input') {
      notify.push('needs_input', { task_id: task.id });
      todoQuestion(task.id);
    } else if (after && after.status === 'planned') {
      /* UN PLAN ATTEND SON APPROBATION : la même attente qu'une question — rien ne repartira
         seul. La notification le dit avec les mots du plan, la todo est celle d'une question. */
      notify.push('needs_input', { task_id: task.id, plan: 1 });
      todoQuestion(task.id);
    } else if (action === 'run' || action === 'answer' || action === 'approve-plan' || (action === 'followup' && opts.autoSuivi)) {
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
      fin = 'stopped';
      return;
    }
    fin = 'error';
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE task SET status='error', last_error=?, updated_at=? WHERE id=?").run(full, new Date().toISOString(), task.id);
    try { spec.marquerErreur(task.id, e.message); } catch { /* la spec ne doit pas masquer l'erreur de la session */ }
    logLine(jobId, null, `❌ Task ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: task.id, message: String(e.message).slice(0, 200) });
  } finally {
    // `push`/`push-all` déplacent du code déjà produit : la session n'a pas tourné.
    if (action !== 'push' && action !== 'push-all') marquerFinExecution('task', task.id);
    if (estSession) events.emit('session.finished', { kind: 'task', id: task.id, action, status: fin }).catch(() => {});
  }
}

enregistrer('task', runTaskJob);

module.exports = {
  runTaskJob,
};
