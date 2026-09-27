'use strict';
/* Rétention de l'historique — ce qui grossit sans fin finit par peser.
 *
 * Trois tables accumulent sans jamais se vider : `job_log` (une ligne par ligne de sortie de
 * chaque job, bornée à 4 ko chacune mais illimitée en nombre), `job` (une ligne par
 * traitement) et `feed` (une ligne par événement de forge). Sur une instance utilisée
 * quotidiennement, ce sont elles qui finissent par dominer la base.
 *
 * DEUX TABLES SONT VOLONTAIREMENT ÉPARGNÉES :
 *
 *   — `usage` : une ligne par appel IA, quelques milliers par an. Elle porte le coût CUMULÉ
 *     en tokens, affiché dans les statistiques. La purger ferait baisser un total censé ne
 *     jamais baisser, ce qui est pire qu'un peu de place perdue.
 *   — `agent_pass` : l'historique des itérations d'une session, avec le prompt et la réponse.
 *     Il disparaît déjà avec sa session ; le purger séparément retirerait des passes d'une
 *     session encore vivante, dont la carte propose justement de les relire.
 *
 * Le réglage vaut en JOURS, 0 = illimité. Il est appliqué au démarrage puis une fois par
 * jour : purger à chaque écriture coûterait une requête de suppression par ligne de log.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const localsnapshot = require('./localsnapshot');
const agentpass = require('../agent/pass');
const git = require('../git/git');
const { getConfig } = require('../data/config');
const { DATA_DIR, DB_PATH, DEFAULT_CLONE_DIR, REVIEWS_DIR, TASKS_DIR, TICKETS_DIR, TMP_DIR, NOTES_DIR, SHARED_DIR } = require('../core/paths');
const { t } = require('../core/i18n');

const JOUR_MS = 24 * 60 * 60 * 1000;

/* LES MERGE REQUESTS FERMÉES DEPUIS LONGTEMPS. Mergée, close, ou rangée « traitée » il y a plus de N
   jours : le rapport est ARCHIVÉ — sa dernière version reste lisible, c'est ce qu'on relit pour
   comprendre ce qui est parti en production — et le reste est purgé : les versions précédentes du
   rapport, le diff stocké, les questions posées sur le rapport, le dossier de travail de la MR. La
   ligne `mr` reste : le brief et les statistiques comptent toujours ce qui a été traité.
   Idempotent : une MR déjà purgée n'a plus rien à donner, et repasse sans rien coûter. */
function purgerMrs(jours, { maintenant = Date.now() } = {}) {
  const n = Number(jours) || 0;
  if (n <= 0) return null;
  const limite = new Date(maintenant - n * JOUR_MS).toISOString();
  const fermees = db.prepare(`SELECT mr.id FROM mr
    WHERE (mr.status = 'done' OR mr.closed_seen = 1 OR mr.merged_at IS NOT NULL)
      AND COALESCE(mr.merged_at, mr.updated_at) IS NOT NULL AND COALESCE(mr.merged_at, mr.updated_at) < ?`).all(limite);
  const rm = (p) => { try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } };
  let mrs = 0; let versions = 0;
  for (const { id } of fermees) {
    const versionsMr = db.prepare('SELECT * FROM review_version WHERE mr_id = ? ORDER BY version').all(id);
    const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(id);
    const passes = db.prepare("SELECT COUNT(*) c FROM agent_pass WHERE scope = 'review' AND task_id = ?").get(id).c;
    const aFaire = versionsMr.length > 1 || (rev && rev.diff_path && fs.existsSync(rev.diff_path)) || passes;
    if (!aFaire) continue;
    // Toutes les versions sauf la dernière : fichiers puis lignes.
    for (const v of versionsMr.slice(0, -1)) {
      const derniere = versionsMr[versionsMr.length - 1];
      for (const p of [v.md_path, v.explanation_path]) if (p && p !== derniere.md_path && p !== derniere.explanation_path && p !== (rev && rev.md_path) && p !== (rev && rev.explanation_path)) rm(p);
      db.prepare('DELETE FROM review_version WHERE id = ?').run(v.id);
      versions += 1;
    }
    if (rev && rev.diff_path) { rm(rev.diff_path); db.prepare('UPDATE review SET diff_path = NULL WHERE mr_id = ?').run(id); }
    // Les questions posées sur ce rapport, et leur dossier de travail.
    agentpass.removeTask('review', id);
    rm(path.join(TASKS_DIR, 'review', String(id)));
    mrs += 1;
  }
  return { jours: n, mrs, versions };
}

/* LE `git gc` DES CLONES INACTIFS. Un clone jamais compacté grossit à chaque fetch ; celui d'un
   dépôt qu'on ne regarde plus depuis un mois est le premier à peser pour rien. Inactif = pas de
   fetch depuis trente jours (`.git/FETCH_HEAD`), et pas de gc depuis trente jours non plus (un
   marqueur que ce module pose). Best-effort, en série, jamais deux fois par jour. */
const INACTIF_MS = 30 * JOUR_MS;
async function gcClones({ maintenant = Date.now(), onLog = () => {} } = {}) {
  const cfg = getConfig();
  let n = 0;
  for (const repo of db.prepare('SELECT * FROM repo').all()) {
    let dir;
    try { dir = git.cloneDirFor(cfg, repo); } catch { continue; }
    const fetchHead = path.join(dir, '.git', 'FETCH_HEAD');
    const marqueur = path.join(dir, '.git', 'mergerie-gc');
    const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    // Un clone tout neuf n'a pas de FETCH_HEAD : sa date de clone (HEAD) fait foi.
    const dernierFetch = mtime(fetchHead) ?? mtime(path.join(dir, '.git', 'HEAD'));
    if (dernierFetch != null && maintenant - dernierFetch < INACTIF_MS) continue;   // encore actif
    const dernierGc = mtime(marqueur);
    if (dernierGc != null && maintenant - dernierGc < INACTIF_MS) continue;         // déjà compacté
    try {
      await git.run('git', ['gc', '--quiet', '--prune=now'], { cwd: dir });
      fs.writeFileSync(marqueur, new Date(maintenant).toISOString());
      n += 1;
    } catch (e) { onLog(t('log.retention.gc-error', { project: repo.project, message: String(e.message).split('\n')[0] })); }
  }
  return n;
}

/* CE QUE LES DONNÉES PÈSENT, PAR CATÉGORIE. Une jauge dans les Réglages, mesurée à la demande — un
   parcours de dossiers n'a rien à faire dans un polling. Le nombre de fichiers accompagne la taille :
   dix mille petits fichiers pèsent autant qu'un gros dans le temps de sauvegarde. */
function tailleDe(racine) {
  let octets = 0; let fichiers = 0;
  const pile = [racine];
  while (pile.length) {
    const d = pile.pop();
    let entrees = [];
    try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entrees) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { pile.push(p); continue; }
      try { const st = fs.statSync(p); octets += st.size; fichiers += 1; } catch { /* parti entre-temps */ }
    }
  }
  return { octets, fichiers };
}
function occupationDisque() {
  const cfg = getConfig();
  const clones = String(cfg.clone_path || DEFAULT_CLONE_DIR).trim();
  const base = (() => { let o = 0; for (const suf of ['', '-wal', '-shm']) { try { o += fs.statSync(`${DB_PATH}${suf}`).size; } catch { /* absent */ } } return { octets: o, fichiers: 1 }; })();
  const categories = [
    { key: 'base', ...base },
    { key: 'clones', ...tailleDe(clones), path: clones },
    { key: 'reviews', ...tailleDe(REVIEWS_DIR) },
    { key: 'sessions', ...tailleDe(TASKS_DIR) },
    { key: 'worktrees', ...tailleDe(path.join(DATA_DIR, 'worktrees')) },
    { key: 'tickets', ...tailleDe(TICKETS_DIR) },
    { key: 'notes', ...tailleDe(NOTES_DIR) },
    { key: 'shared', ...tailleDe(SHARED_DIR) },
    { key: 'tmp', ...tailleDe(TMP_DIR) },
  ];
  const total = categories.reduce((n, c) => n + c.octets, 0);
  return { data_dir: DATA_DIR, total, categories, measured_at: new Date().toISOString() };
}

// Les jobs encore en cours ne se purgent JAMAIS, quelle que soit leur date : un job lancé
// avant une longue coupure garderait sinon son statut sans une ligne de journal pour l'expliquer.
const EN_COURS = "('queued','running')";

/* Purge et rend le détail de ce qui a été supprimé, par table. Le détail sert au journal de
   démarrage : une purge silencieuse est indiscernable d'une purge qui ne marche pas. */
function purger(jours, { maintenant = Date.now() } = {}) {
  const n = Number(jours) || 0;
  if (n <= 0) return null;                       // 0 = illimité, c'est un choix légitime
  const limite = new Date(maintenant - n * JOUR_MS).toISOString();

  /* Les logs d'abord, les jobs ensuite : supprimer un job avant ses lignes laisserait des
     journaux orphelins que plus rien ne référence (la clé étrangère n'est pas en cascade). */
  const logs = db.prepare(`DELETE FROM job_log WHERE job_id IN (
      SELECT id FROM job WHERE status NOT IN ${EN_COURS}
        AND COALESCE(finished_at, started_at) IS NOT NULL
        AND COALESCE(finished_at, started_at) < ?)`).run(limite).changes;

  const jobs = db.prepare(`DELETE FROM job WHERE status NOT IN ${EN_COURS}
      AND COALESCE(finished_at, started_at) IS NOT NULL
      AND COALESCE(finished_at, started_at) < ?`).run(limite).changes;

  let feed = 0;
  try { feed = db.prepare('DELETE FROM feed WHERE at IS NOT NULL AND at < ?').run(limite).changes; }
  catch { /* table absente sur une base très ancienne */ }

  /* L'HISTORIQUE DES OPÉRATIONS GIT vieillit comme les journaux : une branche supprimée il y a
     huit mois ne se restaure plus (le SHA a été ramassé par le `gc` du clone bien avant), et la
     ligne ne sert plus qu'à faire défiler. Elle échappait pourtant à la rétention, seule table
     de trace à croître sans fin. */
  let gitOps = 0;
  try { gitOps = db.prepare('DELETE FROM git_op WHERE created_at IS NOT NULL AND created_at < ?').run(limite).changes; }
  catch { /* table absente sur une base très ancienne */ }

  /* A26 — les traces de tests instables vieillissent aussi : un test qui a clignoté il y a six
     mois n'apprend plus rien, et la table grossit d'une ligne par test rouge et par run. */
  let runTests = 0;
  try { runTests = db.prepare('DELETE FROM verify_run_test WHERE created_at IS NOT NULL AND created_at < ?').run(limite).changes; }
  catch { /* table absente sur une base très ancienne */ }

  return { jours: n, job_log: logs, job: jobs, feed, git_op: gitOps, verify_run_test: runTests };
}

/* LE MÉNAGE COMPLET, en un appel : la rétention des journaux, celle des merge requests fermées, les
   diffs d'itération, les dépôts de suivi orphelins, le gc des clones. C'est ce que fait la passe
   quotidienne, et ce que « Nettoyer maintenant » lance depuis les Réglages. */
async function menage({ jours, mrJours, onLog = () => {}, maintenant = Date.now() } = {}) {
  const bilan = { retention: null, mrs: null, diffs: 0, gc: 0 };
  try {
    bilan.retention = purger(jours, { maintenant });
    const r = bilan.retention;
    if (r && (r.job_log || r.job || r.feed || r.git_op)) {
      onLog(t('log.retention.done', { jours: r.jours, logs: r.job_log, jobs: r.job, feed: r.feed, gitops: r.git_op }));
    }
  } catch (e) { onLog(t('log.retention.error', { message: e.message })); }
  try {
    bilan.mrs = purgerMrs(mrJours, { maintenant });
    if (bilan.mrs && bilan.mrs.mrs) onLog(t('log.retention.mrs', { jours: bilan.mrs.jours, n: bilan.mrs.mrs, count: bilan.mrs.mrs, versions: bilan.mrs.versions }));
  } catch (e) { onLog(t('log.retention.error', { message: e.message })); }
  try {
    bilan.diffs = agentpass.purgerDiffsAnciens();
    if (bilan.diffs) onLog(t('log.retention.diffs', { n: bilan.diffs, count: bilan.diffs }));
  } catch (e) { onLog(t('log.retention.error', { message: e.message })); }
  try { await localsnapshot.menage(onLog); } catch (e) { onLog(t('log.retention.error', { message: e.message })); }
  try {
    bilan.gc = await gcClones({ maintenant, onLog });
    if (bilan.gc) onLog(t('log.retention.gc', { n: bilan.gc, count: bilan.gc }));
  } catch (e) { onLog(t('log.retention.error', { message: e.message })); }
  return bilan;
}

/* Branche la purge : une fois au démarrage, puis une fois par jour. `unref()` pour que le
   minuteur n'empêche pas le processus de se terminer — un serveur qui refuse de s'arrêter
   à cause de son ménage serait un beau comble. */
function demarrer(lireJours, onLog = () => {}, lireMrJours = () => 0) {
  /* Tout le ménage, jamais attendu : il n'a aucune urgence, et le démarrage n'a pas à l'attendre
     pour servir. Une erreur se dit dans le journal et n'arrête rien. */
  const passe = () => { menage({ jours: lireJours(), mrJours: lireMrJours(), onLog }).catch((e) => onLog(t('log.retention.error', { message: e.message }))); };
  passe();
  const minuteur = setInterval(passe, JOUR_MS);
  if (minuteur.unref) minuteur.unref();
  return minuteur;
}

module.exports = { purger, purgerMrs, gcClones, menage, occupationDisque, demarrer, JOUR_MS };
