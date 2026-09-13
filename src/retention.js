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

const db = require('./db');
const localsnapshot = require('./localsnapshot');
const agentpass = require('./agentpass');
const { t } = require('../public/i18n-runtime.js');

const JOUR_MS = 24 * 60 * 60 * 1000;

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

/* Branche la purge : une fois au démarrage, puis une fois par jour. `unref()` pour que le
   minuteur n'empêche pas le processus de se terminer — un serveur qui refuse de s'arrêter
   à cause de son ménage serait un beau comble. */
function demarrer(lireJours, onLog = () => {}) {
  const passe = () => {
    try {
      const r = purger(lireJours());
      if (r && (r.job_log || r.job || r.feed || r.git_op)) {
        onLog(t('log.retention.done', { jours: r.jours, logs: r.job_log, jobs: r.job, feed: r.feed, gitops: r.git_op }));
      }
    } catch (e) { onLog(t('log.retention.error', { message: e.message })); }   // jamais bloquant au démarrage
    /* Un seul diff d'itération par unité — le DERNIER. La règle s'applique d'elle-même à
       chaque nouvelle mesure ; ce passage-ci rattrape les sessions mesurées avant qu'elle
       n'existe, sans code de migration à part. */
    try {
      const oublies = agentpass.purgerDiffsAnciens();
      if (oublies) onLog(t('log.retention.diffs', { n: oublies, count: oublies }));
    } catch (e) { onLog(t('log.retention.error', { message: e.message })); }

    /* LE MÉNAGE DES FICHIERS suit celui des tables, au même rythme : les dépôts de suivi des
       itérations hors dépôt (`localsnapshot`) dont plus aucun dossier de session ne répond.
       Pas attendu — il n'a aucune urgence, et le démarrage n'a pas à l'attendre pour servir. */
    localsnapshot.menage(onLog).catch((e) => onLog(t('log.retention.error', { message: e.message })));
  };
  passe();
  const minuteur = setInterval(passe, JOUR_MS);
  if (minuteur.unref) minuteur.unref();
  return minuteur;
}

module.exports = { purger, demarrer, JOUR_MS };
