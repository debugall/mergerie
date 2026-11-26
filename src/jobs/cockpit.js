'use strict';
/* LE COCKPIT : ce qui tourne, ce qui attend l'utilisateur, ce qui vient d'aboutir — les sessions de codage
   et leur chaîne de validation, sur un écran qu'on laisse ouvert le matin. Une lecture, aucun appel sortant :
   l'état des sessions, de leur chaîne et du job qui les porte.

   « À toi » : une session qui pose une question ou attend l'approbation de son plan, une chaîne arrêtée
   (base ou branche cassée, diagnostic qui n'accuse pas la branche, scénario en échec), une session en
   erreur. « Prêt à lancer » : une session enregistrée sans être lancée (« Lancer ma journée », bouton
   « Enregistrer sans lancer »), lancée d'ici une à une. « En cours » : une session qui tourne ou attend son tour, une chaîne qui avance. « Terminé » :
   ce qui a abouti depuis vingt-quatre heures — chaîne validée ou toute verte, ou session poussée sans
   chaîne. Les sessions plus vieilles que FENETRE_JOURS sans mouvement n'y sont pas. */
const db = require('../db');
const chaineVerif = require('./chaine-verif');
const { jobEnCoursPour } = require('./ordonnanceur');

const FENETRE_JOURS = 3;
const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };

/* Ce qui, dans une chaîne arrêtée, attend l'utilisateur — dit en une ligne de faits (l'écran traduit). */
function raisonsChaine(c) {
  const out = [];
  for (const s of c.steps || []) {
    if (s.erreur) out.push({ quoi: 'erreur', nom: s.verifier_name, detail: s.erreur });
    else if (s.base.etat === 'broken') out.push({ quoi: 'base', nom: s.verifier_name });
    else if (s.head.etat === 'broken') out.push({ quoi: 'branche', nom: s.verifier_name, cause: s.diag ? s.diag.cause : null, detail: s.diag ? s.diag.preuve : '' });
  }
  if (c.scenario && c.scenario.erreur) out.push({ quoi: 'scenario', detail: c.scenario.erreur });
  else if (c.scenario && c.scenario.run && c.scenario.run.etat === 'broken') out.push({ quoi: 'scenario', detail: (c.scenario.fichiers || []).join(' ') });
  return out;
}

function construire({ maintenant = new Date() } = {}) {
  const depuis = new Date(maintenant.getTime() - FENETRE_JOURS * 86400000).toISOString();
  const hier = new Date(maintenant.getTime() - 86400000).toISOString();
  const taches = db.prepare(`SELECT t.* FROM task t WHERE t.kind = 'code' AND t.updated_at >= ?
    ORDER BY t.updated_at DESC LIMIT 200`).all(depuis);
  const aToi = []; const pret = []; const enCours = []; const termine = [];
  for (const t of taches) {
    const projets = db.prepare(`SELECT r.project, tt.branch, tt.status FROM task_target tt JOIN repo r ON r.id = tt.repo_id
      WHERE tt.task_id = ? ORDER BY tt.id`).all(t.id);
    const chaine = t.verify_chain ? chaineVerif.resume(t.id) : null;
    const job = jobEnCoursPour(t.id);
    const ligne = {
      task_id: t.id, label: t.label || String(t.prompt || '').split('\n')[0].slice(0, 120), status: t.status, jira_key: t.jira_key || null,
      // « Supprimer » emporte les sessions du même ticket : la confirmation dit combien.
      n_ticket: t.jira_key ? db.prepare("SELECT COUNT(*) c FROM task WHERE jira_key = ? AND kind = 'code'").get(t.jira_key).c : 1,
      projets: projets.map((p) => ({ project: p.project, branch: p.branch })), chaine, updated_at: t.updated_at,
      job: job ? { en_file: job.enFile, message: (db.prepare('SELECT message FROM job WHERE id = ?').get(job.jobId) || {}).message || '' } : null,
    };
    if (t.status === 'needs_input' || t.status === 'planned') aToi.push({ ...ligne, quoi: t.status === 'planned' ? 'plan' : 'question' });
    else if (t.status === 'error' && !job) aToi.push({ ...ligne, quoi: 'erreur', detail: String(t.last_error || '').split('\n')[0].slice(0, 300) });
    else if (chaine && chaine.status === 'attention' && !job) aToi.push({ ...ligne, quoi: 'chaine', raisons: raisonsChaine(chaine) });
    else if (t.status === 'new' && !job) pret.push(ligne);
    else if (job || t.status === 'running' || (chaine && chaine.status === 'running')) enCours.push(ligne);
    else if (t.updated_at >= hier && (chaine ? ['validated', 'passed'].includes(chaine.status) : ['pushed', 'committed'].includes(t.status))) termine.push(ligne);
  }
  return { a_toi: aToi, pret, en_cours: enCours, termine, fenetre_jours: FENETRE_JOURS };
}

/* Les sessions dont la chaîne peut servir de modèle à « Lancer ma journée » : celles qui en ont une. */
function modeles() {
  return db.prepare(`SELECT id, label, prompt, verify_chain FROM task WHERE kind = 'code' AND verify_chain IS NOT NULL
    ORDER BY updated_at DESC LIMIT 30`).all().map((t) => ({
    id: t.id, label: t.label || String(t.prompt || '').split('\n')[0].slice(0, 80), n: lire(t.verify_chain, []).length,
  }));
}

/* Le nombre de lignes « à toi », sans construire le cockpit : la pastille orange de Dev IA, relue avec
   l'état de l'application. Même règle que `construire`, en une requête. */
function compterAToi({ maintenant = new Date() } = {}) {
  const depuis = new Date(maintenant.getTime() - FENETRE_JOURS * 86400000).toISOString();
  return db.prepare(`SELECT t.id, t.status, v.status chaine FROM task t
    LEFT JOIN verif_chaine v ON v.task_id = t.id AND t.verify_chain IS NOT NULL
    WHERE t.kind = 'code' AND t.updated_at >= ? AND (t.status IN ('needs_input', 'planned', 'error') OR v.status = 'attention')`)
    .all(depuis)
    .filter((l) => l.status === 'needs_input' || l.status === 'planned' || !jobEnCoursPour(l.id)).length;
}

module.exports = { construire, compterAToi, modeles, raisonsChaine, FENETRE_JOURS };
