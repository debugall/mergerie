'use strict';
/* La file de jobs et son état : ce qui attend, ce qui tourne, le journal, les clés de conflit — et le registre des exécutants, où chaque sorte de job vient s’inscrire.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const path = require('node:path');
const db = require('../db');
const { stripAnsi } = require('../../public/runtime/ansi-runtime.js');

/* File d'attente SÉQUENTIELLE : un job à la fois, les suivants attendent. L'état est
   persisté en table `job` pour survivre à la fermeture d'onglet.

   Une VOIE SUPPLÉMENTAIRE existe, sur demande explicite : `startNow(jobId)` sort un job de
   la file et le lance à côté de celui qui tourne. Elle n'est pas automatique — deux jobs
   qui se marchent dessus dans le même clone git corrompent le dépôt, et c'est à l'humain
   de dire que les deux travaux sont indépendants. Mergerie vérifie quand même : deux jobs
   qui touchent le même dépôt ou le même dossier local sont REFUSÉS, pas seulement
   déconseillés. Une seule voie supplémentaire à la fois, pour que le panneau de logs reste
   lisible et que la charge reste bornée. */
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
      const ver = db.prepare('SELECT verifier_id, targets_json FROM verification WHERE id = ?').get(entry.verificationId);
      const cibles = JSON.parse((ver && ver.targets_json) || '[]');
      for (const c of cibles) repo(c.repo_id);
      /* EN MODE « IN PLACE », LE RUN NE TRAVAILLE PAS DANS LE CLONE mais dans le répertoire de
         l'utilisateur — celui-là même qu'une session hors dépôt réserve sous `dir:<chemin>`.
         Réserver le dépôt ne protégeait donc rien : l'agent d'une session locale pouvait écrire
         dans le dossier pendant que la vérification y faisait son `checkout --detach`. On pose
         la même clé qu'elle, pour que les deux se sérialisent au lieu de se marcher dessus. */
      if (ver && ver.verifier_id) {
        const ids = [...new Set(cibles.map((c) => Number(c.repo_id)).filter(Boolean))];
        if (ids.length) {
          const lignes = db.prepare(`SELECT workdir FROM verifier_repo
            WHERE verifier_id = ? AND mode = 'in_place' AND workdir IS NOT NULL AND workdir <> ''
              AND repo_id IN (${ids.map(() => '?').join(',')})`).all(ver.verifier_id, ...ids);
          for (const l of lignes) keys.add(`dir:${l.workdir}`);
        }
      }
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
    default:                                          // review / rereview / modify / ask-review / explain
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
/* Ce qu'il faut pour REJOUER un job. On mémorise l'intention (quelle fonction, sur quel
   objet), pas les lignes traitées : pour une review, la liste se re-déduit de l'état des MR,
   donc relancer reprend là où l'arrêt a eu lieu au lieu de refaire ce qui est fait.
   Les opérations git en sont EXCLUES : rejouer « supprimer ces douze branches » depuis un
   bouton de bandeau, sans repasser par l'aperçu, est précisément ce qu'il ne faut pas
   permettre. Leur écran est à un clic. */
const RETRYABLE = new Set(['review', 'rereview', 'modify', 'ask-review', 'explain', 'task', 'local', 'converge', 'converge-session']);
function rememberRetry(jobId, spec) {
  try { db.prepare('UPDATE job SET retry = ? WHERE id = ?').run(JSON.stringify(spec), jobId); }
  catch { /* colonne absente sur une base très ancienne : la relance sera juste indisponible */ }
}
/* Un job est rejouable s'il a fini sans aller au bout, et si son intention est connue.
   `interrupted` EN FAIT PARTIE : c'est le statut que la base pose au démarrage sur les jobs
   que l'arrêt précédent a coupés. Il était absent de cette liste, si bien que le seul job
   qu'on n'avait PAS choisi d'arrêter était aussi le seul qu'on ne pouvait pas rejouer. */
function canRetry(job) {
  return !!(job && job.retry && RETRYABLE.has(job.kind)
    && ['stopped', 'error', 'interrupted'].includes(job.status));
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

/* LE REGISTRE DES EXÉCUTANTS. Un exécutant (`runners/*.js`) s'inscrit ici en se chargeant ;
   l'ordonnanceur y lit qui lance quelle sorte de job. C'est ce qui permet aux exécutants
   d'appeler `start…Job` (une session finie enchaîne sa vérification) sans que le module qui
   les lance ait à les importer en retour. */
const RUNNERS = Object.create(null);
function enregistrer(kind, fn) { RUNNERS[kind] = fn; }

module.exports = {
  queue, active, MAX_RUNNING, activeJob, currentJob, runningJobs, queuedJobs, queueCount, parallelBusy, runningCount, setJob, insertLog, logLine, mrsToReview, mrRowById, jobKeys, jobTargets, runningTargets, keysClash, conflictsWithRunning, RETRYABLE, rememberRetry, canRetry, marquerFinExecution, reposDUnVerify, verifyBloquePar, RUNNERS, enregistrer,
};
