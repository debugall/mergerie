'use strict';
/* L’ordonnanceur : lancer, promouvoir, arrêter, rejouer — et les `start…Job` que le reste de l’application appelle.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const path = require('node:path');
const db = require('../db');
const proc = require('../core/proc');
const docker = require('../integrations/docker');
const { t } = require('../core/i18n');
const { MAX_RUNNING, RUNNERS, active, activeJob, canRetry, conflictsWithRunning, mrRowById, mrsToReview, parallelBusy, queue, rememberRetry, setJob } = require('./file');

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
  return startJob(sp.kind, sp.mrIds, sp.opts);
}
/* Aiguillage : quel exécutant pour quelle sorte de job. Chaque exécutant s'est INSCRIT dans
   le registre de la file en se chargeant (`enregistrer`) : l'ordonnanceur ne connaît aucun
   d'eux par son nom de module, et aucun cycle ne se referme. */
function runEntry(e) {
  if (e.kind === 'task') return RUNNERS['task'](e.jobId, e.taskId, e.action, e.opts);
  if (e.kind === 'gitops') return RUNNERS['gitops'](e.jobId, e.payload);
  if (e.kind === 'docker') return RUNNERS['docker'](e.jobId, e.payload);
  if (e.kind === 'install') return RUNNERS['install'](e.jobId, e.payload);
  if (e.kind === 'converge') return RUNNERS['converge'](e.jobId, e.mrId, e.opts);
  if (e.kind === 'converge-session') return RUNNERS['converge-session'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'local') return RUNNERS['local'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'ask') return RUNNERS['ask'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'reconcile') return RUNNERS['reconcile'](e.jobId, e.taskId, e.opts);
  if (e.kind === 'verify') return RUNNERS['verify'](e.jobId, e.verificationId);
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
// Worker de la voie séquentielle : les jobs de la file, un par un.
async function pump() {
  if (mainRunning || active.size >= MAX_RUNNING) return;
  const next = queue[0];
  if (!next) return;
  /* La voie séquentielle est soumise à la MÊME règle que la promotion manuelle : elle ne
     démarre pas un job qui toucherait un dépôt déjà occupé par un job parallèle. Sans ce
     test, promouvoir un job puis laisser la file avancer suffisait à mettre deux process
     dans le même clone — précisément ce que la règle existe pour empêcher.
     On ATTEND plutôt que de sauter au suivant : l'ordre de la file est ce que l'utilisateur
     a sous les yeux, le réordonner en silence serait pire qu'un léger retard. La fin de
     n'importe quel job relance cette tentative. */
  if (conflictsWithRunning(next).length) return;
  queue.shift();
  mainRunning = true;
  await launch(next, 'main');
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
/* ---------- Installation du moteur de dictée (whisper.md §6.5) ----------
   Un job comme les autres, et c'est tout l'intérêt : le journal s'affiche en direct sous le
   bouton, « Stop » tue le script proprement (SIGTERM puis SIGKILL à +2 s, par `proc`), et un
   téléchargement interrompu REPREND au lancement suivant — c'est le script qui le garantit.

   À la fin, le script parle au serveur : sa dernière ligne est un `MERGERIE_RESULT {…}` que
   l'on relit pour REMPLIR les réglages. Pas de ligne = erreur : un script qui ne rend pas de
   résultat n'a pas fini son travail, et deviner les chemins à sa place les inventerait. */
function startInstallJob(payload) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('install', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'install', payload });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}
// Actions Docker (compose up/restart/pull/recreate/down, suppression d'orphelin) → log streamé.
/* UNE SEULE GARDE POUR TOUTES LES ROUTES DOCKER. Le `dir` venait du client tel quel :
   `docker compose up --build` ou `make` dans n'importe quel dossier de la machine. Il doit être
   celui d'un fichier compose trouvé sous les racines déclarées (Réglages → Répertoires locaux),
   comme `composeOne` l'exigeait déjà pour l'inspection. */
function exigerDossierCompose(dir) {
  const racines = db.prepare('SELECT * FROM local_root').all();
  const d = path.resolve(String(dir || ''));
  const connu = racines.some((r) => docker.composeFilesUnder(r.path).some((h) => path.resolve(h.dir) === d));
  if (!dir || !connu) {
    const e = new Error(t('err.docker.dir-unknown', { dir: String(dir || '') }));
    e.status = 400;
    throw e;
  }
}
function startDockerJob(payload) {
  if (payload && (payload.op === 'compose' || payload.op === 'make')) exigerDossierCompose(payload.dir);
  if (payload && payload.op === 'compose-bulk') for (const g of payload.groups || []) exigerDossierCompose(g && g.dir);
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('docker', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'docker', payload });
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
  mainRunning, retryJob, runEntry, launch, pump, startNow, startJob, startGitJob, startInstallJob, exigerDossierCompose, startDockerJob, clearTaskError, startVerifyJob, startReconcileJob, setJobTarget, startTaskJob, startLocalJob, startAskJob, startConvergeJob, startConvergeSessionJob, stopJob, isRunning,
};
