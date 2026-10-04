'use strict';
/* L’ordonnanceur : lancer, promouvoir, arrêter, rejouer — et les `start…Job` que le reste de l’application appelle.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const path = require('node:path');
const db = require('../db');
const proc = require('../core/proc');
const { t } = require('../core/i18n');
const { MAX_RUNNING, RUNNERS, active, activeJob, canRetry, conflictsWithRunning, jobKeys, keysClash, mrRowById, mrsToReview, parallelBusy, queue, rememberRetry, setJob } = require('./file');

/* File d'attente SÉQUENTIELLE : un job à la fois, les suivants attendent. L'état est
   persisté en table `job` pour survivre à la fermeture d'onglet.

   Une VOIE SUPPLÉMENTAIRE existe, sur demande explicite : `startNow(jobId)` sort un job de
   la file et le lance à côté de celui qui tourne. Elle n'est pas automatique — deux jobs
   qui se marchent dessus dans le même clone git corrompent le dépôt, et c'est à l'humain
   de dire que les deux travaux sont indépendants. Mergerie vérifie quand même : deux jobs
   qui touchent le même dépôt ou le même dossier local sont REFUSÉS, pas seulement
   déconseillés. Une seule voie supplémentaire à la fois, pour que le panneau de logs reste
   lisible et que la charge reste bornée. */
let mainRunning = false;                 // la voie séquentielle est-elle occupée ?
function retryJob(jobId) {
  const job = db.prepare('SELECT * FROM job WHERE id = ?').get(Number(jobId));
  if (!canRetry(job)) { const e = new Error(t('err.job-non-rejouable')); e.code = 'BUSY'; throw e; }
  const sp = JSON.parse(job.retry);
  if (sp.fn === 'task') return startTaskJob(sp.taskId, sp.action, sp.opts);
  if (sp.fn === 'local') return startLocalJob(sp.taskId, sp.opts);
  if (sp.fn === 'ask') return startAskJob(sp.taskId, sp.opts);
  if (sp.fn === 'converge') return startConvergeJob(sp.mrId, sp.opts);
  if (sp.fn === 'converge-session') return startConvergeSessionJob(sp.taskId, sp.opts);
  if (sp.fn === 'merge-ai') return startMergeAiJob(sp.mergeId);
  return startJob(sp.kind, sp.mrIds, sp.opts);
}
/* Aiguillage : quel exécutant pour quelle sorte de job. Chaque exécutant s'est INSCRIT dans
   le registre de la file en se chargeant (`enregistrer`) : l'ordonnanceur ne connaît aucun
   d'eux par son nom de module, et aucun cycle ne se referme. */
function runEntry(e) {
  if (e.kind === 'task') return RUNNERS['task'](e.jobId, e.taskId, e.action, e.opts);
  if (e.kind === 'gitops') return RUNNERS['gitops'](e.jobId, e.payload);
  if (e.kind.startsWith('plugin:')) return RUNNERS['plugin'](e.jobId, e.payload);
  if (e.kind === 'converge') return RUNNERS['converge'](e.jobId, e.mrId, e.opts);
  if (e.kind === 'converge-session') return RUNNERS['converge-session'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'local') return RUNNERS['local'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'ask') return RUNNERS['ask'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'reconcile') return RUNNERS['reconcile'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'verify') return RUNNERS['verify'](e.jobId, e.verificationId);
  if (e.kind === 'merge-ai') return RUNNERS['merge-ai'](e.jobId, e.mergeId);
  return RUNNERS.review(e.jobId, e.rows, e.kind, e.opts);
}
/* Exécute un job dans SON contexte d'annulation. `lane` distingue la voie séquentielle de
   la voie supplémentaire : seule la première enchaîne la file quand elle se libère. */
function launch(entry, lane) {
  const { ctx, done } = proc.run(() => runEntry(entry));
  active.set(entry.jobId, { ctx, entry, lane });
  return done.finally(() => {
    active.delete(entry.jobId);
    if (lane === 'main') mainRunning = false;
    /* On retente la file à la fin de N'IMPORTE quel job, pas seulement d'un job principal :
       la tête de file peut être bloquée par un CONFLIT avec un job parallèle, et c'est la
       fin de celui-ci qui la débloque. Sans ça, la voie séquentielle resterait à l'arrêt
       avec une file pleine. */
    if (queue.length) setImmediate(pump);
    // Plus rien en cours : on efface un éventuel drapeau d'annulation ambiant resté armé.
    // Sinon les opérations git HORS file (explorateur, tag-author, find-ref) échoueraient
    // à tort avec « Job arrêté par l'utilisateur ».
    if (!active.size) proc.reset();
  });
}
/* LE PARALLÉLISME EST AUTOMATIQUE POUR CE QUI NE SE TOUCHE PAS. Une review automatique sur le
   dépôt A n'a aucune raison de retarder une session sur le dépôt B : les clés de conflit
   (`jobKeys`) disent exactement ce que chaque job va toucher, et c'est elles qui décident —
   pas la position dans la file. Ce qui reste vrai :
   — deux jobs qui partagent une clé se SÉRIALISENT, dans l'ordre de la file : un job n'en
     double jamais un plus ancien qui touche le même dépôt ou le même dossier ;
   — un job au périmètre inconnu (`*`) attend que tout soit fini, et bloque tout derrière lui ;
   — les jobs lancés À LA MAIN passent avant les automatiques (`opts.auto` : reviews de la
     découverte, sessions programmées) — c'est l'humain qui attend, pas la machine ;
   — `MAX_RUNNING` borne le tout : au-delà de quelques agents, ils rament ensemble. */
const estAuto = (e) => !!(e && e.opts && e.opts.auto);
function prochainLancable() {
  const ordre = [...queue.keys()].sort((a, b) => (Number(estAuto(queue[a])) - Number(estAuto(queue[b]))) || (a - b));
  for (const i of ordre) {
    const e = queue[i];
    if (conflictsWithRunning(e).length) continue;
    const mienne = jobKeys(e);
    /* On ne double pas un job plus ancien qui touche la même chose — sauf un automatique,
       qu'un job à la main a le droit de devancer. */
    const devant = queue.slice(0, i).filter((q) => estAuto(e) || !estAuto(q));
    if (devant.some((q) => keysClash(mienne, jobKeys(q)))) continue;
    return i;
  }
  return -1;
}
async function pump() {
  while (queue.length && active.size < MAX_RUNNING) {
    const i = prochainLancable();
    if (i === -1) return;
    const [entry] = queue.splice(i, 1);
    // La voie « principale » n'est plus qu'un nom d'onglet : le premier lancé quand rien ne tourne.
    const lane = mainRunning ? 'extra' : 'main';
    if (lane === 'main') mainRunning = true;
    launch(entry, lane);
  }
}
/* ATTENDRE QU'UN JOB SOIT FINI — arrêté, en erreur ou terminé. `launch` retire le job des actifs
   dans son `finally` : c'est ce qu'on guette. Sert à « stopper et reprendre avec cette consigne »,
   qui ne peut relancer la session qu'une fois son job sorti du clone. */
function attendreFin(jobId, { timeoutMs = 120000, pasMs = 100 } = {}) {
  const id = Number(jobId);
  return new Promise((resolve) => {
    const debut = Date.now();
    const tick = () => {
      if (!active.has(id) && !queue.some((e) => e.jobId === id)) return resolve(true);
      if (Date.now() - debut > timeoutMs) return resolve(false);
      return setTimeout(tick, pasMs).unref();
    };
    tick();
  });
}
// Le job (actif ou en file) qui porte cette session de codage, s'il y en a un.
function jobEnCoursPour(taskId) {
  const id = Number(taskId);
  const porte = (e) => e && ['task', 'converge-session', 'reconcile'].includes(e.kind) && Number(e.taskId) === id;
  for (const [jobId, a] of active.entries()) if (porte(a.entry)) return { jobId, entry: a.entry, enFile: false };
  const q = queue.find(porte);
  return q ? { jobId: q.jobId, entry: q, enFile: true } : null;
}
/* Sort un job PRÉCIS de la file et le lance à côté de celui qui tourne. Refuse plutôt que
   d'avertir quand les deux touchent le même dépôt : un clone abîmé en cours de review ne
   se rattrape pas d'un clic, alors qu'attendre son tour, si. */
function startNow(jobId) {
  const i = queue.findIndex((e) => e.jobId === Number(jobId));
  if (i === -1) { const e = new Error(t('err.job-pas-en-attente')); e.code = 'BUSY'; throw e; }
  if (parallelBusy()) { const e = new Error(t('err.job-parallele-occupe', { max: MAX_RUNNING })); e.code = 'BUSY'; throw e; }
  const entry = queue[i];
  const clash = conflictsWithRunning(entry);
  if (clash.length) { const e = new Error(t('err.job-conflit', { ids: clash.join(', ') })); e.code = 'BUSY'; throw e; }
  queue.splice(i, 1);
  launch(entry, 'extra');
  return db.prepare('SELECT * FROM job WHERE id = ?').get(entry.jobId);
}
// Ajoute un job à la file (ne bloque jamais : s'exécute quand son tour vient).
function startJob(kind, mrIds = null, opts = {}) {
  let rows;
  if (mrIds) {
    // job ciblé sur une/des MR précises (bouton par ligne, re-review, modif)
    rows = mrIds.map(mrRowById).filter(Boolean);
    if (kind === 'rereview') rows = rows.filter((r) => r.status !== 'done');
  } else {
    // job global : toutes les MR à reviewer
    rows = mrsToReview();
  }
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES (?, 'queued', ?, 0, 'en file', ?)`).run(kind, rows.length, new Date().toISOString());
  const jobId = info.lastInsertRowid;
  // Un lot de review porte sur N MR : on ne désigne l'objet que s'il n'y en a qu'une.
  if (rows.length === 1) setJobTarget(jobId, 'mr', rows[0].id);
  rememberRetry(jobId, { fn: 'job', kind, mrIds, opts });
  queue.push({ jobId, rows, kind, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Ajoute une tâche à la file (action 'run' / 'followup' / 'push').
function startGitJob(payload) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('gitops', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'gitops', payload });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
function clearTaskError(taskId, targetIds) {
  const now = new Date().toISOString();
  db.prepare("UPDATE task SET last_error = NULL, updated_at = ? WHERE id = ? AND status = 'error'").run(now, taskId);
  // Une relance CIBLÉE ne solde que les projets qu'elle va refaire : effacer l'erreur des
  // autres laisserait croire qu'ils ont été retraités.
  if (Array.isArray(targetIds) && targetIds.length) {
    const q = targetIds.map(() => '?').join(',');
    db.prepare(`UPDATE task_target SET last_error = NULL WHERE task_id = ? AND status = 'error' AND id IN (${q})`)
      .run(taskId, ...targetIds.map(Number));
  } else {
    db.prepare("UPDATE task_target SET last_error = NULL WHERE task_id = ? AND status = 'error'").run(taskId);
  }
}
function startVerifyJob(verificationId) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('verify', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  // De quoi ce job s'occupe : sans ça, le journal d'activité affiche une ligne anonyme.
  setJobTarget(jobId, 'verification', verificationId);
  queue.push({ jobId, kind: 'verify', verificationId });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
function startReconcileJob(taskId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('reconcile', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'task', taskId);
  queue.push({ jobId, kind: 'reconcile', taskId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
/* Qui ce job concerne-t-il. Écrit à la création plutôt que déduit après coup : la file, les
   relances et les promotions manipulent des jobs, pas des objets, et sans cette trace le journal
   d'activité ne peut dire que « job #42 » — ce qui n'apprend rien. */
function setJobTarget(jobId, kind, id) {
  if (!id) return;
  db.prepare('UPDATE job SET target_kind = ?, target_id = ? WHERE id = ?').run(kind, Number(id), jobId);
}
function startTaskJob(taskId, action = 'run', opts = {}) {
  if (action !== 'push' && action !== 'push-all') clearTaskError(taskId, opts.targetIds);
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('task', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'task', taskId);
  rememberRetry(jobId, { fn: 'task', taskId, action, opts });
  queue.push({ jobId, kind: 'task', taskId, action, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Lance une session « Codage hors dépôt » (dossiers locaux, sans git).
function startLocalJob(taskId, opts = {}) {
  const maintenant = new Date().toISOString();
  db.prepare("UPDATE local_task SET last_error = NULL, updated_at = ? WHERE id = ? AND status = 'error'").run(maintenant, taskId);
  db.prepare("UPDATE local_task_dir SET last_error = NULL WHERE task_id = ? AND status = 'error'").run(taskId);
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('local', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'local', taskId);
  rememberRetry(jobId, { fn: 'local', taskId, opts });
  queue.push({ jobId, kind: 'local', taskId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
/* Lance une « Question libre » : ni dépôt, ni dossier, ni git. Elle passe quand même par la
   file — un appel d'agent coûte des minutes et des tokens, et le plafond de jobs simultanés
   vaut pour elle comme pour les autres. */
function startAskJob(questionId, opts = {}) {
  db.prepare("UPDATE question SET last_error = NULL, updated_at = ? WHERE id = ? AND status = 'error'")
    .run(new Date().toISOString(), questionId);
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('ask', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'ask', questionId);
  rememberRetry(jobId, { fn: 'ask', taskId: questionId, opts });
  queue.push({ jobId, kind: 'ask', taskId: questionId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
/* « Demander à l'IA » une proposition de résolution pour TOUS les fichiers encore en conflit
   du merge, EN UN SEUL JOB — jamais un par fichier : l'agent doit voir l'ensemble avant de
   proposer quoi que ce soit (voir `session/mergeai.js`). */
function startMergeAiJob(mergeId) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('merge-ai', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'git_merge', mergeId);
  rememberRetry(jobId, { fn: 'merge-ai', mergeId });
  queue.push({ jobId, kind: 'merge-ai', mergeId });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Lance une boucle de convergence pour une MR (« Converger »).
function startConvergeJob(mrId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('converge', 'queued', ?, 0, 'en file', ?)`).run(opts.maxPasses || 1, new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'mr', mrId);
  rememberRetry(jobId, { fn: 'converge', mrId, opts });
  queue.push({ jobId, kind: 'converge', mrId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Lance une convergence de SESSION de dev (« Converger » du prompt à la MR convergée).
function startConvergeSessionJob(taskId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('converge-session', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'task', taskId);
  rememberRetry(jobId, { fn: 'converge-session', taskId, opts });
  queue.push({ jobId, kind: 'converge-session', taskId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Stoppe TOUT : annule le job en cours (tue git/copilot) et vide la file d'attente.
/* Stop SANS argument : tout arrêter (comportement d'origine — c'est le bouton du panneau).
   Stop AVEC un id : n'arrêter que ce job, en laissant l'autre voie travailler. Il fallait
   les deux : avec deux jobs en cours, un Stop global qui tue le voisin serait une surprise
   désagréable, et un Stop qui n'arrête qu'un job laisserait la file repartir. */
function stopJob(jobId) {
  const now = new Date().toISOString();
  if (jobId != null) {
    const a = active.get(Number(jobId));
    if (!a) {
      const i = queue.findIndex((e) => e.jobId === Number(jobId));
      if (i === -1) { const err = new Error(t('err.job-introuvable')); err.code = 'BUSY'; throw err; }
      queue.splice(i, 1);
      setJob(Number(jobId), { status: 'stopped', finished_at: now, message: t('job.msg.cancelled-queued') });
      return { ok: true, cancelledQueue: 1 };
    }
    proc.cancel(a.ctx);
    return { ok: true, cancelledQueue: 0 };
  }
  const pending = queue.splice(0); // retire les jobs en attente
  for (const p of pending) {
    setJob(p.jobId, { status: 'stopped', finished_at: now, message: t('job.msg.cancelled-queued') });
  }
  const hadRunning = active.size > 0 || !!activeJob();
  for (const a of active.values()) proc.cancel(a.ctx);
  if (!hadRunning && pending.length === 0) {
    const err = new Error('Aucun job en cours ni en attente.');
    err.code = 'BUSY';
    throw err;
  }
  return { ok: true, cancelledQueue: pending.length };
}
function isRunning() {
  return active.size > 0 || !!activeJob();
}

module.exports = {
  mainRunning, retryJob, runEntry, launch, pump, prochainLancable, attendreFin, jobEnCoursPour, startNow, startJob, startGitJob, clearTaskError, startVerifyJob, startReconcileJob, setJobTarget, startTaskJob, startLocalJob, startAskJob, startConvergeJob, startConvergeSessionJob, startMergeAiJob, stopJob, isRunning,
};
