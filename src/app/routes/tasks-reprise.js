'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE SUR CE POSTE : l'aperçu de ce que l'agent recevra, et le
   lancement. HTTP seulement — l'assemblage et la création sont dans `session/reprise.js`. */
const { app } = require('../app');
const db = require('../../db');
const { t, deNom } = require('../../core/i18n');
const identite = require('../../core/identite');
const { getConfig } = require('../../data/config');
const jobs = require('../../jobs');
const reprise = require('../../session/reprise');
const { gardeConfigAgent, wrap } = require('../http');
const { auteurDeLigne } = require('../lib/partage');
const { lireCliSession, lireLibelle, targetById, taskById, taskContextRepos, taskTargets } = require('../lib/sessions');

/* Ce que la reprise d'UNE cible exige : une session de codage reçue d'un collègue, une cible poussée, non
   mergée. Rend `{ tache, tg, repo, auteur }` ou jette avec le motif. */
function cadre(req) {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const tg = taskTargets(tache.id).find((x) => x.id === Number(req.params.tid)) || targetById(tache.id, Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const auteur = auteurDeLigne('task', tache);
  const e = reprise.eligibilite(tache, tg, { auteur, moi: identite.nom() || null });
  if (!e.ok) { const err = new Error(t(`task.reprise.err.${e.reason}`, { iid: e.iid || '', who: auteur || '' })); err.status = 409; throw err; }
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  return { tache, tg, repo, auteur, eligibilite: e };
}
/* La nouvelle branche proposée : `<branche>-reprise-<moi>`, modifiable dans la modale. Une seconde
   reprise de la même branche ne propose pas un nom qu'une session de ce poste occupe déjà : `-2`, `-3`… */
function brancheProposee(tg) {
  const base = `${tg.branch}-reprise-${((identite.nom() || 'moi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'moi')}`;
  const prise = db.prepare('SELECT 1 FROM task_target WHERE repo_id = ? AND branch = ? LIMIT 1');
  let nom = base;
  for (let i = 2; prise.get(tg.repo_id, nom) && i < 100; i += 1) nom = `${base}-${i}`;
  return nom;
}
const options = (b) => ({
  consigne: String((b && b.consigne) || ''), reponse: b && b.reponse ? String(b.reponse) : null,
  passesIncluses: b && b.passes_incluses != null && b.passes_incluses !== '' ? Math.max(0, parseInt(b.passes_incluses, 10) || 0) : null,
  diff: !!(b && (b.diff === true || b.diff === '1' || b.diff === 1)),
});
/* MES réglages de session, jamais ceux du collègue : ils ne voyagent pas. */
function defauts(cfg) {
  const vrai = (v) => String(v) === '1';
  return { autoPush: vrai(cfg.task_default_auto_push), askQuestions: vrai(cfg.task_default_ask_questions), notifyJira: vrai(cfg.task_default_notify_jira) };
}

/* L'APERÇU : le premier message complet, les tokens estimés, l'état de la forge — zéro token d'IA. */
app.post('/api/tasks/:id/reprise/:tid/apercu', wrap(async (req, res) => {
  const { tache, tg, repo, auteur, eligibilite } = cadre(req);
  const cfg = getConfig();
  const a = await reprise.apercu(cfg, tache, tg, repo, { auteur, derniereSynchro: tache.updated_at }, options(req.body));
  res.json({
    task: { id: tache.id, uid: tache.uid, label: tache.label, status: tache.status, author: auteur },
    target: { id: tg.id, uid: tg.uid, repo_id: tg.repo_id, project: tg.project, branch: tg.branch, base_branch: tg.base_branch, commit_sha: tg.commit_sha, status: tg.status, questions: reprise.questionsDe(tg) },
    eligibilite, branch_proposee: brancheProposee(tg),
    ...a,
  });
}));

/* LE LANCEMENT : une session neuve, à moi, posée sur la tête de la branche du collègue, lancée tout de
   suite. La session d'origine n'est pas touchée. */
app.post('/api/tasks/:id/reprise/:tid', wrap(async (req, res) => {
  const { tache, tg, repo, auteur } = cadre(req);
  const cfg = getConfig();
  const b = req.body || {};
  const o = options(b);
  if (!o.consigne.trim()) throw new Error(t('task.reprise.err.consigne'));
  const branch = String(b.branch || '').trim() || brancheProposee(tg);
  await gardeConfigAgent(repo, tg.branch, tg.base_branch, b);
  const id = await reprise.creer(cfg, tache, tg, repo, {
    auteur, consigne: o.consigne, reponse: o.reponse, passesIncluses: o.passesIncluses, diff: o.diff, branch,
    label: lireLibelle(b.label) || t('task.reprise.label', { de_who: deNom(auteur), id: tache.id }), cli: lireCliSession(b), defauts: defauts(cfg),
  });
  const job = jobs.startTaskJob(id, 'run');
  res.json({ ...taskById(id), targets: taskTargets(id), context_repos: taskContextRepos(id), job });
}));
