'use strict';
const db = require('./db');
const { stripAnsi } = require('../public/ansi-runtime.js');
const { reviewMr, modifyReview, explainMr } = require('./reviewer');
const taskrunner = require('./taskrunner');
const proc = require('./proc');
const gitops = require('./gitops');
const notify = require('./notify');
const notes = require('./notes');
const converge = require('./converge');
const localcoder = require('./localcoder');
const asker = require('./asker');
const docker = require('./docker');
const verifyrun = require('./verifyrun');
const { getConfig } = require('./config');
const { t } = require('../public/i18n-runtime.js');

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
const queue = [];                        // { jobId, rows, kind, opts } en attente
const active = new Map();                // jobId -> { ctx, entry, lane }
/* Plafond de jobs SIMULTANÉS, voie séquentielle comprise. Ce n'est pas le code qui limite —
   contextes d'annulation, détection de conflit et onglets de journal passent tous à l'échelle
   sans rien changer — c'est la machine : chaque job de codage ou de review lance un agent,
   et au-delà de quelques-uns on ne gagne plus de temps, on les fait ramer ensemble. */
const MAX_RUNNING = 3;

function activeJob() {
  return db.prepare(`SELECT * FROM job WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() || null;
}

// Job "courant" pour l'affichage : celui en cours s'il y en a un, sinon le dernier.
function currentJob() {
  return activeJob() || db.prepare(`SELECT * FROM job ORDER BY id DESC LIMIT 1`).get() || null;
}

// Les jobs qui tournent VRAIMENT, dans l'ordre de lancement (voie principale d'abord).
function runningJobs() {
  const ids = [...active.keys()];
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM job WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
}

// Les jobs en attente, dans l'ordre de la file — avec ce qu'ils toucheront.
function queuedJobs() {
  return queue.map((e) => {
    const row = db.prepare('SELECT * FROM job WHERE id = ?').get(e.jobId);
    return { ...row, keys: [...jobKeys(e)], conflicts: conflictsWithRunning(e) };
  });
}

function queueCount() { return queue.length; }
// Plus de place pour un job de plus ? (nom conservé : le front l'affiche déjà)
function parallelBusy() { return active.size >= MAX_RUNNING; }
function runningCount() { return active.size; }

function setJob(id, patch) {
  const cols = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE job SET ${cols} WHERE id = @id`).run({ ...patch, id });
}

// Ajoute une ligne au log du job (persistée, pollée par l'UI en temps réel).
const insertLog = db.prepare('INSERT INTO job_log (job_id, mr_id, ts, text) VALUES (?,?,?,?)');
function logLine(jobId, mrId, text) {
  // Même raison que pour les logs Docker : la sortie d'un agent ou d'un git peut contenir
  // des séquences de couleur, et le panneau de journal n'est pas un terminal.
  insertLog.run(jobId, mrId, new Date().toISOString(), stripAnsi(text).slice(0, 4000));
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

/* Ce qu'un job va TOUCHER, sous forme de clés comparables : un dépôt (donc un clone, donc
   un checkout) ou un dossier local. Deux jobs qui partagent une clé ne peuvent pas tourner
   ensemble — l'un ferait un checkout pendant que l'autre lit, et le dépôt en sortirait
   incohérent. Un job Docker ne touche aucun dépôt : il est parallélisable avec tout.
   Prudence par défaut : un job dont on ne sait pas déduire les clés renvoie `*`, qui
   entre en conflit avec tout le monde. Mieux vaut refuser à tort que corrompre un clone. */
function jobKeys(entry) {
  const keys = new Set();
  const repo = (id) => { if (id) keys.add(`repo:${id}`); };
  const targetsOf = (taskId) => db.prepare('SELECT repo_id FROM task_target WHERE task_id = ?').all(taskId);
  switch (entry.kind) {
    case 'docker': return keys;                       // aucun dépôt : jamais en conflit
    /* Une question libre ne touche NI dépôt NI dossier : rien à réserver, donc elle ne
       bloque personne et personne ne la bloque. C'est la seule saveur de session dans ce
       cas — les trois autres travaillent toujours dans des fichiers. */
    case 'ask': return keys;
    case 'verify': {
      // Le run crée des worktrees dans le clone : aucun autre job ne doit y toucher pendant.
      const ver = db.prepare('SELECT targets_json FROM verification WHERE id = ?').get(entry.verificationId);
      for (const c of JSON.parse((ver && ver.targets_json) || '[]')) repo(c.repo_id);
      return keys;
    }
    case 'gitops':
      for (const t2 of (entry.payload && entry.payload.targets) || []) repo(t2.repo_id);
      if (entry.payload && entry.payload.restoreOpId) keys.add('*'); // cible relue en base au moment du run
      return keys;
    case 'local':
      for (const d of db.prepare('SELECT path FROM local_task_dir WHERE task_id = ?').all(entry.taskId)) keys.add(`dir:${d.path}`);
      return keys;
    case 'task':
    case 'reconcile':
    case 'converge-session': {
      /* Une passe ciblée ne réserve que SES dépôts : deux projets d'une même session, sur des
         dépôts distincts, peuvent alors tourner en parallèle. */
      const o = entry.opts || {};
      const ids = o.targetIds || (o.targetId ? [o.targetId] : null);
      const cibles = (Array.isArray(ids) && ids.length)
        ? db.prepare(`SELECT repo_id FROM task_target WHERE task_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
          .all(entry.taskId, ...ids.map(Number))
        : targetsOf(entry.taskId);
      for (const t2 of cibles) repo(t2.repo_id);
      return keys;
    }
    case 'converge': {
      const mr = db.prepare('SELECT repo_id FROM mr WHERE id = ?').get(entry.mrId);
      repo(mr && mr.repo_id);
      return keys;
    }
    default:                                          // review / rereview / modify / explain
      if (Array.isArray(entry.rows)) { for (const r of entry.rows) repo(r.repo_id); return keys; }
      keys.add('*');
      return keys;
  }
}

/* Les OBJETS que ce job est en train de traiter, par famille. Sert au front à marquer
   la carte concernée plutôt qu'un bandeau global : « ce qui tourne » devient une propriété
   de la MR ou de la session, pas une information à aller chercher ailleurs.
   Volontairement séparé de jobKeys() : celui-ci raisonne en dépôts (collisions), celui-là
   en objets affichés (repérage visuel). */
function jobTargets(entry, jobRow) {
  const cibles = { mrs: [], tasks: [], locals: [], questions: [], verifying: [] };
  if (!entry) return cibles;
  /* UNE VÉRIFICATION MARQUE LES MR QU'ELLE PORTE. Sans ça, cliquer « Vérifier » ne changeait
     rien à l'écran : le toast passait, le travail durait des minutes, et plus rien ne disait
     qu'il avait commencé — ni au retour sur l'onglet, ni après un rechargement. `verifying`
     double `mrs` pour que le bouton sache que c'est SA commande qui tourne, et pas une review
     sur la même MR : un spinner sur « Vérifier » pendant une review désignerait la mauvaise. */
  if (entry.kind === 'verify') {
    let cs = [];
    try {
      const v = db.prepare('SELECT targets_json FROM verification WHERE id = ?').get(entry.verificationId);
      cs = JSON.parse((v && v.targets_json) || '[]');
    } catch { cs = []; }   // ligne illisible : on n'en marque aucune plutôt que de tomber
    for (const c of cs) if (c && c.mr_id) { cibles.mrs.push(c.mr_id); cibles.verifying.push(c.mr_id); }
    return cibles;
  }
  if (entry.kind === 'local') { if (entry.taskId) cibles.locals.push(entry.taskId); return cibles; }
  if (entry.kind === 'ask') { if (entry.taskId) cibles.questions.push(entry.taskId); return cibles; }
  if (entry.kind === 'task' || entry.kind === 'converge-session') { if (entry.taskId) cibles.tasks.push(entry.taskId); return cibles; }
  if (entry.kind === 'converge') { if (entry.mrId) cibles.mrs.push(entry.mrId); return cibles; }
  /* Un job de review porte sur un LOT de MR, mais n'en traite qu'une à la fois : on
     renvoie celle-là, pas les dix du lot. Marquer tout le lot ferait clignoter la moitié
     de la liste, ce qui est précisément le contraire de l'effet recherché. */
  if (Array.isArray(entry.rows)) { const cur = jobRow && jobRow.current_mr_id; if (cur) cibles.mrs.push(cur); }
  return cibles;
}

// Union des cibles de TOUS les jobs en cours, pour un seul appel de statut.
function runningTargets() {
  const cibles = { mrs: [], tasks: [], locals: [], questions: [], verifying: [] };
  for (const [jobId, { entry }] of active.entries()) {
    const row = db.prepare('SELECT current_mr_id FROM job WHERE id = ?').get(jobId);
    const one = jobTargets(entry, row);
    for (const k of Object.keys(cibles)) for (const id of one[k]) if (!cibles[k].includes(id)) cibles[k].push(id);
  }
  return cibles;
}

/* Deux jeux de clés se marchent-ils dessus ? Règle isolée du reste pour être testable :
   c'est elle qui autorise ou refuse le parallèle, et s'y tromper corrompt un dépôt. */
function keysClash(a, b) {
  const A = new Set(a); const B = new Set(b);
  if (A.has('*') || B.has('*')) return true;      // périmètre inconnu : on refuse
  for (const k of A) if (B.has(k)) return true;
  return false;
}

// Les jobs en cours avec lesquels `entry` entrerait en conflit (ids). Vide = parallélisable.
function conflictsWithRunning(entry) {
  const mine = jobKeys(entry);
  return [...active].filter(([, a]) => keysClash(mine, jobKeys(a.entry))).map(([id]) => id);
}

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

// Exécute un job de type "task" (run / followup / push) avec log en direct.
/* UNE VÉRIFICATION, UNE FOIS, À LA FIN. Le vérificateur d'une session se déclenche tout seul —
   c'est tout l'intérêt : on lance la session le matin et on trouve un verdict, pas une case à
   cocher de plus.

   Trois refus délibérés, tous silencieux pour la session mais DITS dans son journal :

   — SANS COMMIT POUSSÉ, rien à vérifier. Un vérificateur travaille sur du code accessible depuis
     la forge ; c'est la raison pour laquelle choisir un vérificateur coche l'auto-push.
   — SI LE VÉRIFICATEUR NE COUVRE PAS TOUS LES DÉPÔTS de la session, on ne lance pas. Un vert
     partiel ne dit rien de la moitié du lot — pire qu'une absence de verdict.
   — UN ÉCHEC ICI NE FAIT PAS ÉCHOUER LA SESSION. Le code est écrit et poussé ; annoncer la
     session en erreur parce que la vérification n'a pas pu démarrer serait mentir sur ce qui
     s'est passé. */
/* La DÉCISION est séparée du lancement : elle se raconte (« pourquoi ça n'est pas parti ») et
   s'éprouve sans monter d'environnement ni lancer le moindre process. */
function preparerVerificationApres(task) {
  if (!task || !task.verifier_id) return { raison: null };
  const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(task.verifier_id);
  if (!verifier) return { raison: 'le vérificateur choisi n’existe plus' };

  const cibles = [];
  for (const tg of db.prepare('SELECT * FROM task_target WHERE task_id = ? ORDER BY id').all(task.id)) {
    if (!tg.commit_sha) continue;                       // rien n'a été produit pour ce projet
    if (cibles.some((c) => c.repo_id === tg.repo_id)) continue;   // un dépôt, une cible
    const mr = tg.mr_iid
      ? db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, tg.mr_iid)
      : null;
    cibles.push({
      repo_id: tg.repo_id, mr_id: mr ? mr.id : null, head_sha: tg.commit_sha,
      base_sha: `origin/${tg.base_branch || 'main'}`, branch: tg.branch, mode: 'worktree',
    });
  }
  if (!cibles.length) return { raison: 'rien de poussé' };

  const par = new Map(db.prepare('SELECT * FROM verifier_repo WHERE verifier_id = ?')
    .all(verifier.id).map((r) => [r.repo_id, r]));
  if (!cibles.every((c) => par.has(c.repo_id))) {
    return { raison: `« ${verifier.name} » ne couvre pas tous les dépôts de la session` };
  }
  if (verifyBloquePar(cibles.map((c) => c.repo_id))) {
    return { raison: 'une autre vérification tourne déjà sur ces dépôts' };
  }
  // Le mode de chaque cible est déclaré par le vérificateur, dépôt par dépôt.
  return {
    verifier,
    cibles: cibles.map((c) => {
      const l = par.get(c.repo_id);
      return { ...c, mode: (l && l.mode) || 'worktree', workdir: (l && l.workdir) || null };
    }),
  };
}

/* UNE SESSION QUI ATTEND UNE RÉPONSE POSE SA TODO. L'agent s'arrête, la file se libère, et
   plus rien ne repartira tant que personne n'aura répondu — sauf qu'on est passé à autre chose
   et que la notification est fermée depuis longtemps. La todo, elle, reste sous les yeux dans
   l'onglet Notes et dans le brief du matin.

   Une todo par SESSION, pas par projet : cinq questions sur cinq dépôts d'une même session sont
   un seul geste à poser dans sa journée, et cinq lignes identiques ne diraient rien de plus. */
/* La même todo, pour une session hors dépôt. Le `kind` DIFFÈRE de celui des sessions sur
   dépôt : les deux tables ont leurs propres identifiants, et `session_question:3` désignerait
   sinon deux sessions différentes — celle qu'on referme ne serait pas celle qui attend. */
function todoQuestionLocal(taskId) {
  const tache = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!tache) return;
  const dossiers = db.prepare("SELECT path FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
    .all(taskId).map((d) => d.path);
  if (!dossiers.length) return;
  const quoi = (tache.label || tache.prompt || '').split('\n')[0].slice(0, 80);
  try {
    notes.todoAuto('local_question', taskId,
      `Répondre à l'IA — session hors dépôt #${taskId}${quoi ? ` : ${quoi}` : ''}`,
      `L'agent attend une réponse sur : ${dossiers.join(', ')}.`);
  } catch { /* une todo qu'on n'a pas pu poser ne doit pas faire échouer la session */ }
}

function todoQuestion(taskId) {
  const tache = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  if (!tache) return;
  const cibles = db.prepare(`SELECT r.project FROM task_target tt JOIN repo r ON r.id = tt.repo_id
    WHERE tt.task_id = ? AND tt.status = 'needs_input'`).all(taskId).map((x) => x.project);
  if (!cibles.length) return;
  const quoi = (tache.label || tache.prompt || '').split('\n')[0].slice(0, 80);
  try {
    notes.todoAuto('session_question', taskId,
      `Répondre à l'IA — session #${taskId}${quoi ? ` : ${quoi}` : ''}`,
      `L'agent attend une réponse sur : ${cibles.join(', ')}.`);
  } catch { /* une todo qu'on n'a pas pu poser ne doit pas faire échouer la session */ }
}

/* LE SUIVI AUTOMATIQUE — le seul endroit du code qui envoie un suivi sans qu'on ait cliqué.
   Par défaut un suivi attend un geste ; coché à l'écran, il part de lui-même dès que la session
   a fini de travailler.

   On le RETIRE avant de lancer, et on décoche. Sans ça, la passe de suivi se termine à son tour,
   retrouve le même texte armé, et la session repart en boucle jusqu'à épuisement du budget IA —
   c'est arrivé en test, en quelques secondes. Il part donc UNE fois ; en réécrire un est un
   geste conscient. Rien non plus après un échec : l'appelant ne passe ici que sur une fin
   normale, on n'enchaîne pas une consigne sur une session qui vient de casser. */
const TABLE_SCOPE = { local: 'local_task', ask: 'question', task: 'task' };

function suiviAutomatique(scope, id, onLog) {
  const table = TABLE_SCOPE[scope] || 'task';
  const s = db.prepare(`SELECT followup_draft d, followup_auto a FROM ${table} WHERE id = ?`).get(id);
  if (!s || !s.a || !s.d) return null;
  db.prepare(`UPDATE ${table} SET followup_draft = NULL, followup_auto = 0, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
  onLog(t('log.job.followup-sent', { texte: String(s.d).split('\n')[0].slice(0, 120) }));
  if (scope === 'local') return startLocalJob(id, { instruction: s.d });
  if (scope === 'ask') return startAskJob(id, { instruction: s.d });
  return startTaskJob(id, 'followup', { instruction: s.d, autoSuivi: true });
}

async function verifierApresSession(task, onLog) {
  if (!task || !task.verifier_id) return null;
  try {
    const d = preparerVerificationApres(task);
    if (!d.verifier) { onLog(t('log.job.verify-skipped', { raison: d.raison })); return null; }
    const info = db.prepare(`INSERT INTO verification
      (verifier_id, verifier_name, lot_id, lot_name, status, targets_json, created_at)
      VALUES (?, ?, NULL, NULL, 'queued', ?, ?)`)
      .run(d.verifier.id, d.verifier.name, JSON.stringify(d.cibles), new Date().toISOString());
    startVerifyJob(info.lastInsertRowid);
    onLog(t('log.job.verify-started', { name: d.verifier.name, n: d.cibles.length, count: d.cibles.length }));
    return info.lastInsertRowid;
  } catch (e) {
    onLog(t('log.job.verify-skipped', { raison: e.message }));
    return null;
  }
}

async function runTaskJob(jobId, taskId, action, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  const portee = (opts.targetIds && opts.targetIds.length) ? ` · ${opts.targetIds.length} projet(s) ciblé(s)` : '';
  logLine(jobId, null, `=== Session #${jobId} (${action})${portee} : ${task ? (task.kind === 'explore' ? 'exploration' : 'codage') : '?'} ===`);
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  if (action !== 'push') db.prepare("UPDATE task SET status='running', last_error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  try {
    if (action === 'push') await taskrunner.pushTarget(task.id, opts.targetId, onLog);
    else if (action === 'push-all') await taskrunner.pushTargets(task, opts.targetIds, onLog);
    else if (action === 'followup') await taskrunner.runTaskFollowup(task, opts.instruction, onLog, { targetIds: opts.targetIds });
    else if (action === 'answer') await taskrunner.runTaskAnswer(task, opts.targetId, onLog);
    else await taskrunner.runTask(task, onLog, { targetIds: opts.targetIds });
    setJob(jobId, { status: 'done', done_count: 1, current_mr_id: null, finished_at: new Date().toISOString(), message: '' });
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
    if (after && after.status === 'needs_input') { notify.push('needs_input', { task_id: taskId }); todoQuestion(taskId); }
    /* APRÈS la boucle, pas à chaque passe : vérifier trois fois de suite le même dépôt coûterait
       trois montages d'environnement pour un seul verdict qui compte, le dernier. On ne lance
       pas non plus si un projet attend une réponse — le code n'est pas fini. */
    if (!after || after.status !== 'needs_input') {
      // Même ordre qu'après une session simple : le suivi armé d'abord, le verdict ensuite.
      if (!suiviAutomatique('task', taskId, onLog)) {
        await verifierApresSession(db.prepare('SELECT * FROM task WHERE id = ?').get(taskId), onLog);
      }
    }
    logLine(jobId, null, t('log.job.converge-session-end', { id: jobId, ok: converged, total: results.length }));
  } catch (e) {
    if (proc.isCancelled()) {
      if (task) db.prepare("UPDATE task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, t('log.job.converge-session-stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    if (task) db.prepare("UPDATE task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, `❌ Convergence session ERREUR : ${e.message}`);
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { task_id: taskId, message: String(e.message).slice(0, 200) });
  } finally {
    // Converger fait tourner l'agent, plusieurs fois : c'est bien une exécution de la session.
    marquerFinExecution('task', taskId);
  }
}

// Exécute une session « Codage hors dépôt » : l'IA code dans chaque dossier local, en
// place, sans git. Un seul job de fond ; les dossiers sont traités en série.
async function runLocalJob(jobId, taskId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.local-start', { id: jobId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await localcoder.runLocal(taskId, onLog, opts);
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      logLine(jobId, null, t('log.job.stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.local-end', { id: jobId }));
    /* UN DOSSIER ATTEND UNE RÉPONSE : ce n'est ni une fin ni un échec. On prévient, on pose la
       todo, et surtout on n'arme PAS le suivi automatique — il repartirait sur une question
       restée sans réponse. */
    const attente = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'").get(taskId).c;
    if (attente) {
      notify.push('needs_input', { local_task_id: taskId });
      todoQuestionLocal(taskId);
    } else if (!suiviAutomatique('local', taskId, onLog)) {
      notify.push('session_done', { local_task_id: taskId });
    }
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE local_task SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE local_task SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(full, new Date().toISOString(), taskId);
    logLine(jobId, null, t('log.job.local-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { local_task_id: taskId, message: String(e.message).slice(0, 200) });
  } finally {
    marquerFinExecution('local_task', taskId);
  }
}

async function runAskJob(jobId, questionId, opts = {}) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.ask-start', { id: jobId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    await asker.runQuestion(questionId, onLog, opts);
    if (proc.isCancelled()) {
      db.prepare("UPDATE question SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), questionId);
      logLine(jobId, null, t('log.job.stopped'));
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.ask-end', { id: jobId }));
    if (!suiviAutomatique('ask', questionId, onLog)) notify.push('session_done', { question_id: questionId });
  } catch (e) {
    if (proc.isCancelled()) {
      db.prepare("UPDATE question SET status = 'new', updated_at = ? WHERE id = ?").run(new Date().toISOString(), questionId);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    db.prepare("UPDATE question SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?")
      .run(full, new Date().toISOString(), questionId);
    logLine(jobId, null, t('log.job.ask-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    notify.push('job_failed', { question_id: questionId, message: String(e.message).slice(0, 200) });
  } finally {
    marquerFinExecution('question', questionId);
  }
}

/* Ce qu'il faut pour REJOUER un job. On mémorise l'intention (quelle fonction, sur quel
   objet), pas les lignes traitées : pour une review, la liste se re-déduit de l'état des MR,
   donc relancer reprend là où l'arrêt a eu lieu au lieu de refaire ce qui est fait.
   Les opérations git en sont EXCLUES : rejouer « supprimer ces douze branches » depuis un
   bouton de bandeau, sans repasser par l'aperçu, est précisément ce qu'il ne faut pas
   permettre. Leur écran est à un clic. */
const RETRYABLE = new Set(['review', 'rereview', 'modify', 'explain', 'task', 'local', 'converge', 'converge-session']);
function rememberRetry(jobId, spec) {
  try { db.prepare('UPDATE job SET retry = ? WHERE id = ?').run(JSON.stringify(spec), jobId); }
  catch { /* colonne absente sur une base très ancienne : la relance sera juste indisponible */ }
}
// Un job est rejouable s'il a fini sans aller au bout, et si son intention est connue.
function canRetry(job) {
  return !!(job && job.retry && RETRYABLE.has(job.kind) && ['stopped', 'error'].includes(job.status));
}
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

// Aiguillage : quel exécutant pour quelle sorte de job.
function runEntry(e) {
  if (e.kind === 'task') return runTaskJob(e.jobId, e.taskId, e.action, e.opts);
  if (e.kind === 'gitops') return runGitJob(e.jobId, e.payload);
  if (e.kind === 'docker') return runDockerJob(e.jobId, e.payload);
  if (e.kind === 'converge') return runConvergeJob(e.jobId, e.mrId, e.opts);
  if (e.kind === 'converge-session') return runConvergeSessionJob(e.jobId, e.taskId, e.opts);
  if (e.kind === 'local') return runLocalJob(e.jobId, e.taskId, e.opts);
  if (e.kind === 'ask') return runAskJob(e.jobId, e.taskId, e.opts);
  if (e.kind === 'reconcile') return runReconcileJob(e.jobId, e.taskId);
  if (e.kind === 'verify') return runVerifyJob(e.jobId, e.verificationId);
  return processList(e.jobId, e.rows, e.kind, e.opts);
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
    // Un arrêt DEMANDÉ n'est pas un échec. Sans ce test, le Stop de l'utilisateur
    // s'affichait en rouge avec « Job arrêté par l'utilisateur » en guise d'erreur —
    // inquiétant à lire, et faux. Les autres exécutants le distinguaient déjà.
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return null;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
  }
  return null;
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
      if (fails.length) throw new Error(t('err.job.group-failed', { n: fails.length, total: groups.length, liste: fails.join(', ') }));
    } else if (payload.op === 'orphan-remove') {
      await docker.removeContainer(payload.id, onLog);
    } else if (payload.op === 'orphan-stop') {
      await docker.stopContainer(payload.id, onLog);
    } else if (payload.op === 'make') {
      await docker.runMake(payload.dir, payload.target, onLog);
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
  } catch (e) {
    // Comme pour les opérations git : un Stop demandé n'est pas une erreur.
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: docker.explainDockerError(e.message) });
  }
}

/* Une relance solde l'échec précédent TOUT DE SUITE, à la mise en file — pas au démarrage
   effectif du job. Sinon la carte continue d'afficher « erreur » entre le clic et le départ :
   on ne sait pas si le clic a été pris, et derrière une file chargée cet entre-deux dure des
   minutes. L'erreur affichée n'est plus l'état courant dès l'instant où l'on redemande le travail. */
/* Fin d'une EXÉCUTION de session. Sert au tri des listes Dev IA : on veut voir en tête ce
   qui vient de finir de tourner. Posé quelle que soit l'issue — terminé, en erreur, arrêté —
   parce que dans les trois cas l'exécution est finie et qu'on vient d'y assister.
   Pas sur un push ni sur une réconciliation : ce ne sont pas des exécutions de la tâche. */
function marquerFinExecution(table, id) {
  try { db.prepare(`UPDATE ${table} SET finished_at = ? WHERE id = ?`).run(new Date().toISOString(), id); }
  catch { /* le tri est un confort : il ne doit jamais faire échouer un job */ }
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

/* Réconciliation : on relit l'état réel des branches d'une session et on répare les cibles
   dont le travail existe déjà. Passe par la FILE, comme tout ce qui touche à un clone : le faire
   pendant qu'un agent écrit dans le même dépôt le corromprait. Pas de retry — l'opération est
   idempotente, on la relance à la main si besoin. */
async function runReconcileJob(jobId, taskId) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  logLine(jobId, null, t('log.job.reconcile-start', { id: jobId }));
  if (!task) { setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: t('err.tache-introuvable') }); return; }
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const r = await taskrunner.reconcileTargets(task, onLog);
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.reconcile-end', { done: r.repaired, total: r.checked }));
  } catch (e) {
    const full = (e && e.stack) ? `${e.message}\n\n${e.stack}` : String(e && e.message || e);
    logLine(jobId, null, t('log.job.reconcile-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    void full;
  }
}

/* ---------- Vérification objective (plan_add_verify.md §5, §10) ----------
 *
 * Ce qu'on refuse dépend de ce qui tourne, et la distinction est celle de la RÉALITÉ des runs :
 *
 *   — Une vérification MULTI-DÉPÔTS est un run d'intégration : elle monte un environnement
 *     complet, souvent des containers sur des ports et des bases fixes. Deux en parallèle se
 *     marcheraient dessus et rendraient des rouges qui n'apprennent rien. Une telle
 *     vérification bloque donc tout le monde, et se fait bloquer par tout le monde.
 *   — Une vérification MONO-DÉPÔT est contenue dans son répertoire. Il suffit alors de
 *     vérifier qu'il ne s'agit pas du même dépôt : deux suites de tests sur des projets sans
 *     rapport n'ont aucune raison de s'attendre.
 *
 * Refuser globalement renverrait l'utilisateur à son écran alors que tous les autres jobs de
 * Mergerie attendent simplement leur tour.
 *
 * Rend la RAISON du refus (`meme-depot` | `integration`) ou `null`. L'appelant en tire le
 * message : « c'est déjà lancé » et « attends la fin de l'intégration » ne se corrigent pas
 * de la même façon.
 */
function reposDUnVerify(entry) {
  return [...jobKeys(entry)].map((k) => (k === '*' ? '*' : Number(String(k).replace('repo:', ''))));
}

function verifyBloquePar(repoIds) {
  const vises = (repoIds || []).map(Number);
  const enCours = [...queue, ...[...active.values()].map((a) => a.entry)]
    .filter((e) => e && e.kind === 'verify');
  if (!enCours.length) return null;

  for (const e of enCours) {
    const siens = reposDUnVerify(e);
    // Périmètre inconnu : on ne prend pas le risque de le croire inoffensif.
    if (siens.includes('*')) return 'integration';
    if (siens.length > 1 || vises.length > 1) return 'integration';
    if (siens.some((r) => vises.includes(r))) return 'meme-depot';
  }
  return null;
}

async function runVerifyJob(jobId, verificationId) {
  /* Comme tout job qui démarre : sans ce passage en `running`, la ligne reste « en file »
     pendant toute l'exécution — le panneau de log, le compteur de la file et l'état du
     favicon annoncent alors une attente là où une suite de tests est en train de tourner. */
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.verify-start', { id: verificationId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const verdict = await verifyrun.executerVerification(verificationId, getConfig(), onLog);
    /* Commentaire sur la forge : opt-in par vérificateur (§5.6). Il ne peut pas remettre le
       verdict en cause — une forge injoignable ne transforme pas un résultat acquis en échec,
       d'où le `catch` qui se contente de le dire dans le journal. Mais il a lieu AVANT que le
       job ne se déclare fini : « terminé » doit vouloir dire que tout est fait. */
    try { await verifyrun.commenterSurForge(verificationId, getConfig(), onLog); }
    catch (e) { logLine(jobId, null, `commentaire sur la forge impossible : ${e.message}`); }
    // Un verdict rouge n'est PAS une erreur de job : le job a parfaitement fait son travail.
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.verify-end', { verdict }));
    notify.push('verify_done', { verification_id: verificationId, verdict });
  } catch (e) {
    logLine(jobId, null, t('log.job.verify-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    db.prepare("UPDATE verification SET status = 'error', verdict = 'verify_error', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), verificationId);
    notify.push('verify_done', { verification_id: verificationId, verdict: 'verify_error' });
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

function startReconcileJob(taskId) {
  const info = db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at)
    VALUES ('reconcile', 'queued', 1, 0, 'en file', ?)`).run(new Date().toISOString());
  const jobId = info.lastInsertRowid;
  setJobTarget(jobId, 'task', taskId);
  queue.push({ jobId, kind: 'reconcile', taskId });
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
  startVerifyJob, verifyBloquePar, preparerVerificationApres,
  startJob, startTaskJob, startGitJob, startDockerJob, startConvergeJob, startConvergeSessionJob,
  startLocalJob, startAskJob, startReconcileJob, startNow, stopJob, currentJob, activeJob, runningJobs, queuedJobs, isRunning,
  queueCount, parallelBusy, runningCount, MAX_RUNNING, jobKeys, keysClash, retryJob, canRetry,
  jobTargets, runningTargets,
};
