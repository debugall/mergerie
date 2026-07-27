'use strict';
const db = require('./db');
const { reviewMr, modifyReview, explainMr } = require('./reviewer');
const taskrunner = require('./taskrunner');
const proc = require('./proc');
const gitops = require('./gitops');
const notify = require('./notify');
const converge = require('./converge');
const localcoder = require('./localcoder');
const docker = require('./docker');
const { t } = require('../public/i18n-runtime.js');

// File d'attente séquentielle : un job à la fois, les suivants attendent.
// L'état est persisté en table `job` pour survivre à la fermeture d'onglet.
let running = false;
const queue = []; // { jobId, rows, kind, opts } en attente

function activeJob() {
  return db.prepare(`SELECT * FROM job WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() || null;
}

// Job "courant" pour l'affichage : celui en cours s'il y en a un, sinon le dernier.
function currentJob() {
  return activeJob() || db.prepare(`SELECT * FROM job ORDER BY id DESC LIMIT 1`).get() || null;
}

function queueCount() { return queue.length; }

function setJob(id, patch) {
  const cols = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE job SET ${cols} WHERE id = @id`).run({ ...patch, id });
}

// Ajoute une ligne au log du job (persistée, pollée par l'UI en temps réel).
const insertLog = db.prepare('INSERT INTO job_log (job_id, mr_id, ts, text) VALUES (?,?,?,?)');
function logLine(jobId, mrId, text) {
  insertLog.run(jobId, mrId, new Date().toISOString(), String(text).slice(0, 4000));
}

// Sélectionne les MR à traiter pour un job 'review' : toutes celles en to_review.
function mrsToReview() {
  return db.prepare(`
    SELECT mr.*, repo.project AS project, repo.url AS url, repo.branch_pattern AS branch_pattern, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE mr.status = 'to_review' AND repo.enabled = 1
    ORDER BY mr.repo_id, mr.iid`).all();
}

function mrRowById(id) {
  return db.prepare(`
    SELECT mr.*, repo.project AS project, repo.url AS url, repo.branch_pattern AS branch_pattern, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE mr.id = ?`).get(id);
}

async function processList(jobId, rows, kind, opts = {}) {
  const startedAt = new Date().toISOString();
  setJob(jobId, { status: 'running', total: rows.length, done_count: 0, started_at: startedAt, message: t('job.msg.starting') });
  try {
    let i = 0;
    logLine(jobId, null, `=== Job #${jobId} (${kind}) : ${rows.length} MR à traiter ===`);
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
          logLine(jobId, mr.id, `✅ MR !${mr.iid} : rapport modifié`);
        } else if (kind === 'explain') {
          await explainMr(repo, mr, onLog);
          logLine(jobId, mr.id, `✅ MR !${mr.iid} : explication générée`);
        } else {
          // opts.explain (true/false) surcharge le réglage global ; undefined = suit le réglage.
          // opts.incremental (re-review) : ne reviewer que le delta depuis le dernier SHA reviewé.
          await reviewMr(repo, mr, onLog, { explain: opts.explain, incremental: opts.incremental });
          logLine(jobId, mr.id, `✅ MR !${mr.iid} : review ${opts.incremental ? 'incrémentale ' : ''}terminée`);
        }
      } catch (e) {
        if (proc.isCancelled()) {
          // arrêt demandé par l'utilisateur : pas une "erreur" de MR
          logLine(jobId, mr.id, `⏹ MR !${mr.iid} : arrêtée par l'utilisateur`);
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
    logLine(jobId, null, `=== Job #${jobId} ${stopped ? 'ARRÊTÉ' : 'terminé'} (${i}/${rows.length} MR) ===`);
    setJob(jobId, {
      status: finalStatus, current_mr_id: null, finished_at: new Date().toISOString(),
      message: stopped ? t('job.msg.count-partial', { done: i, total: rows.length }) : t('job.msg.count', { n: rows.length, total: rows.length }),
    });
  } catch (e) {
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { message: String(e.message).slice(0, 200) });
  }
}

// Exécute un job de type "task" (run / followup / push) avec log en direct.
async function runTaskJob(jobId, taskId, action, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  logLine(jobId, null, `=== Session #${jobId} (${action}) : ${task ? (task.kind === 'explore' ? 'exploration' : 'codage') : '?'} ===`);
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (action !== 'push') db.prepare("UPDATE task SET status='running', last_error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  try {
    if (action === 'push') await taskrunner.pushTarget(task.id, opts.targetId, onLog);
    else if (action === 'followup') await taskrunner.runTaskFollowup(task, opts.instruction, onLog);
    else if (action === 'answer') await taskrunner.runTaskAnswer(task, opts.targetId, onLog);
    else await taskrunner.runTask(task, onLog);
    setJob(jobId, { status: 'done', done_count: 1, current_mr_id: null, finished_at: new Date().toISOString(), message: '' });
    // La session peut s'être mise EN ATTENTE (l'agent a posé des questions) : notif dédiée,
    // pas « prête à push ». Sinon, codage terminé → prêt à push/MR.
    const after = db.prepare('SELECT status FROM task WHERE id = ?').get(task.id);
    if (after && after.status === 'needs_input') {
      notify.push('needs_input', { task_id: task.id });
    } else if ((action === 'run' || action === 'answer') && task.kind !== 'explore') {
      notify.push('session_done', { task_id: task.id });
    }
    logLine(jobId, null, `=== Task #${jobId} terminée ===`);
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE task SET status='new', updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
      logLine(jobId, null, `⏹ Task arrêtée par l'utilisateur`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE task SET status='error', last_error=?, updated_at=? WHERE id=?").run(full, new Date().toISOString(), task.id);
    logLine(jobId, null, `❌ Task ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: task.id, message: String(e.message).slice(0, 200) });
  }
}

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
    logLine(jobId, mrId, `=== Convergence #${jobId} terminée (${r.status}) ===`);
  } catch (e) {
    if (proc.isCancelled()) {
      logLine(jobId, mrId, `⏹ Convergence arrêtée par l'utilisateur`);
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

// Converge une SESSION de dev IA : dev → push → crée la MR → boucle de convergence,
// pour chaque projet de la session en série. Un seul job de fond.
async function runConvergeSessionJob(jobId, taskId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  logLine(jobId, null, `=== Convergence session #${jobId}${task ? ` : ${task.kind}` : ''} ===`);
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (task) db.prepare("UPDATE task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  try {
    const results = await converge.convergeSession(taskId, opts, onLog);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    // Pas de notification ici : convergeRun en pousse DÉJÀ une par MR convergée. En
    // rajouter une pour le premier projet doublonnerait le projet 1 sans rien dire des
    // autres. Le détail par projet reste dans le log du job.
    const converged = results.filter((r) => r.status === 'converged').length;
    // Une passe a pu mettre un projet EN ATTENTE (l'IA a posé une question) : la boucle s'est
    // arrêtée là, on avertit pour que l'utilisateur réponde puis relance Converger.
    const after = db.prepare('SELECT status FROM task WHERE id = ?').get(taskId);
    if (after && after.status === 'needs_input') notify.push('needs_input', { task_id: taskId });
    logLine(jobId, null, `=== Convergence session #${jobId} terminée (${converged}/${results.length} au seuil) ===`);
  } catch (e) {
    if (proc.isCancelled()) {
      if (task) db.prepare("UPDATE task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, `⏹ Convergence session arrêtée par l'utilisateur`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    if (task) db.prepare("UPDATE task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, `❌ Convergence session ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: taskId, message: String(e.message).slice(0, 200) });
  }
}

// Exécute une session « Codage hors dépôt » : l'IA code dans chaque dossier local, en
// place, sans git. Un seul job de fond ; les dossiers sont traités en série.
async function runLocalJob(jobId, taskId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, `=== Codage hors dépôt #${jobId} ===`);
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await localcoder.runLocal(taskId, onLog, opts);
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, `⏹ Arrêté par l'utilisateur`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, `=== Codage hors dépôt #${jobId} terminé ===`);
    notify.push('session_done', { local_task_id: taskId });
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE local_task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, `❌ Codage hors dépôt ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { local_task_id: taskId, message: String(e.message).slice(0, 200) });
  }
}

// Worker : exécute les jobs de la file un par un, séquentiellement.
async function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  proc.reset(); // chaque job démarre avec un état d'annulation propre
  try {
    if (next.kind === 'task') await runTaskJob(next.jobId, next.taskId, next.action, next.opts);
    else if (next.kind === 'gitops') await runGitJob(next.jobId, next.payload);
    else if (next.kind === 'docker') await runDockerJob(next.jobId, next.payload);
    else if (next.kind === 'converge') await runConvergeJob(next.jobId, next.mrId, next.opts);
    else if (next.kind === 'converge-session') await runConvergeSessionJob(next.jobId, next.taskId, next.opts);
    else if (next.kind === 'local') await runLocalJob(next.jobId, next.taskId, next.opts);
    else await processList(next.jobId, next.rows, next.kind, next.opts);
  } finally {
    running = false;
    if (queue.length) setImmediate(pump); // enchaîne le suivant
    // File vide : on efface un éventuel drapeau d'annulation resté armé par un Stop.
    // Sinon, les opérations git HORS file (explorateur, tag-author, find-ref) le verraient
    // encore et échoueraient à tort avec « Job arrêté par l'utilisateur ».
    else proc.reset();
  }
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

async function runGitJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const r = payload.restoreOpId
      ? await gitops.restore(payload.restoreOpId, onLog)
      : await gitops.execute(payload, onLog);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    return r;
  } catch (e) {
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
  }
}

// Actions Docker (compose up/restart/pull/recreate/down, suppression d'orphelin) → log streamé.
function startDockerJob(payload) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('docker', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'docker', payload });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}

async function runDockerJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    if (payload.op === 'compose') {
      if (payload.action === 'down') await docker.runDown(payload.dir, onLog);
      else await docker.runCompose(payload.dir, payload.action, payload.services, onLog);
    } else if (payload.op === 'compose-bulk') {
      // Action groupée : un projet après l'autre ; un échec n'interrompt pas les suivants.
      const groups = payload.groups || [];
      setJob(jobId, { total: groups.length });
      const fails = [];
      let done = 0;
      for (const g of groups) {
        onLog(`──────── ${g.dir} · ${g.services.join(', ')} ────────`);
        try { await docker.runCompose(g.dir, payload.action, g.services, onLog); }
        catch (e) { fails.push(g.dir); onLog(`⚠ ${docker.explainDockerError(e.message)}`); }
        done += 1; setJob(jobId, { done_count: done });
      }
      if (fails.length) throw new Error(`Échec sur ${fails.length}/${groups.length} projet(s) : ${fails.join(', ')}`);
    } else if (payload.op === 'orphan-remove') {
      await docker.removeContainer(payload.id, onLog);
    } else if (payload.op === 'orphan-stop') {
      await docker.stopContainer(payload.id, onLog);
    } else if (payload.op === 'make') {
      await docker.runMake(payload.dir, payload.target, onLog);
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
  } catch (e) {
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: docker.explainDockerError(e.message) });
  }
}

function startTaskJob(taskId, action = 'run', opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('task', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'task', taskId, action, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}

// Lance une session « Codage hors dépôt » (dossiers locaux, sans git).
function startLocalJob(taskId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('local', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'local', taskId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}

// Lance une boucle de convergence pour une MR (« Converger »).
function startConvergeJob(mrId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('converge', 'queued', ?, 0, 'en file', ?)`).run(opts.maxPasses || 1, new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'converge', mrId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}

// Lance une convergence de SESSION de dev (« Converger » du prompt à la MR convergée).
function startConvergeSessionJob(taskId, opts = {}) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('converge-session', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  queue.push({ jobId, kind: 'converge-session', taskId, opts });
  setImmediate(pump);
  return db.prepare('SELECT * FROM job WHERE id = ?').get(jobId);
}

// Stoppe TOUT : annule le job en cours (tue git/copilot) et vide la file d'attente.
function stopJob() {
  const now = new Date().toISOString();
  const pending = queue.splice(0); // retire les jobs en attente
  for (const p of pending) {
    setJob(p.jobId, { status: 'stopped', finished_at: now, message: 'Annulé (jamais démarré)' });
  }
  const hadRunning = running || !!activeJob();
  if (hadRunning) proc.requestCancel();
  if (!hadRunning && pending.length === 0) {
    const err = new Error('Aucun job en cours ni en attente.');
    err.code = 'BUSY';
    throw err;
  }
  return { ok: true, cancelledQueue: pending.length };
}

function isRunning() {
  return running || !!activeJob();
}

module.exports = { startJob, startTaskJob, startGitJob, startDockerJob, startConvergeJob, startConvergeSessionJob, startLocalJob, stopJob, currentJob, activeJob, isRunning, queueCount };
