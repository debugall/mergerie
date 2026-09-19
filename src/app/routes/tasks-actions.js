'use strict';
/* Ce qu’on fait d’une session finie : un suivi, une réponse, pousser, ouvrir la MR, la merger.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const localsession = require('../../data/localsession');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const notify = require('../../core/notify');
const notes = require('../../notes/notes');
const jobs = require('../../jobs');
const forge = require('../../forge');
const { wrap } = require('../http');
const { prevenirJira } = require('../lib/jira');
const { mergeOptsFor, rememberMergeOpts } = require('../lib/merge');
const { savePiecesEtImages } = require('../lib/pieces');
const { effectiveMr, envoyerSuivi, normalizeTargetIds, poserSuivi, targetById, taskById, taskTargets } = require('../lib/sessions');

/* Itération : nouvelle passe de l'IA (codage) ou question de suivi (exploration).

   `targets` restreint la correction à certains projets, comme pour « Lancer ». Sur une
   session multi-dépôts, la remarque à faire est presque toujours propre à UN projet : la
   passer à tous coûtait un appel IA par dépôt et faisait repasser l'agent sur du code qu'on
   ne voulait plus voir toucher. Une exploration produit UNE synthèse commune : la restreindre
   n'aurait pas de sens, on refuse plutôt que d'ignorer en silence. */
app.post('/api/tasks/:id/followup', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim() || tache.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  const targetIds = normalizeTargetIds(tache.id, req.body && req.body.targets);
  if (targetIds && tache.kind !== 'code') throw new Error(t('err.followup-cible-code-only'));
  /* Une capture collée dans le suivi. Elle est enregistrée AVANT le lancement : si le job est
     refusé (un autre tourne déjà), elle reste jointe à la session plutôt que d'être perdue —
     le texte du suivi, lui, est déjà remis en brouillon par `envoyerSuivi`. */
  const imageIds = savePiecesEtImages('task', tache.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('task', tache, () => jobs.startTaskJob(tache.id, 'followup',
    { instruction, ...(targetIds ? { targetIds } : {}), ...(imageIds.length ? { imageIds } : {}) })));
}));
/* LE SUIVI EN ATTENTE. Écrit pendant que la session tourne, relisible et modifiable tant
   qu'il n'est pas parti, envoyé quand on le décide — jamais par la machine. Une seule route
   pour poser, corriger et effacer : un texte vide EST la suppression. */
app.put('/api/tasks/:id/followup-draft', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  poserSuivi('task', tache.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = taskById(tache.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));
// Réponses aux questions de l'agent (ask → stop → resume) : on enregistre les réponses sur
// la cible, puis on relance l'agent DANS LA MÊME session pour qu'il poursuive.
app.post('/api/tasks/:id/targets/:tid/answer', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'needs_input') throw new Error(t('err.session-pas-en-attente'));
  const tache = taskById(Number(req.params.id));

  /* UNE EXPLORATION N'A QU'UNE SESSION POUR TOUS SES DÉPÔTS. La question est donc posée sur
     CHAQUE cible — c'est ce qui la fait apparaître où qu'on regarde — mais y répondre répond
     pour la session ENTIÈRE : la reprise débloque d'elle-même les autres cibles avant de
     relancer l'agent. Le décompte plus bas les voyait encore en attente et laissait la todo
     posée par l'outil ouverte pour toujours dès qu'il y avait deux dépôts — c'est-à-dire pour
     les trois agents livrés, tous en périmètre « tous les dépôts ». On solde donc l'attente
     ici, APRÈS validation (une demande refusée ne doit rien changer) et avant de compter.
     En CODAGE la condition reste entière : chaque dépôt y a sa propre session et ses propres
     questions, et répondre au premier ne solde pas les quatre autres. */
  const solderExploration = () => {
    if (!tache || tache.kind !== 'explore') return;
    db.prepare(`UPDATE task_target SET status = 'running', last_error = NULL, updated_at = ?
      WHERE task_id = ? AND status = 'needs_input'`).run(new Date().toISOString(), Number(req.params.id));
  };

  /* RÉPONDU AILLEURS. « Reprendre au terminal » copie la session d'agent : on peut donc
     répondre aux questions dans son propre terminal, et l'agent y poursuit le travail — dans le
     clone de Mergerie, qui n'en sait rien. Le projet restait alors « en attente » pour toujours,
     et le formulaire proposait de répondre une seconde fois, ce qui aurait relancé l'agent sur
     un travail déjà fait.
     On ne DEVINE pas ce qui s'est passé dehors : on regarde la branche, avec la mécanique qui
     sert déjà à « Vérifier l'état des branches ». Elle rend des commits, ou rien — et dans les
     deux cas, c'est la vérité du dépôt, pas une supposition. */
  if (req.body && req.body.elsewhere) {
    db.prepare("UPDATE task_target SET questions_json = NULL, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), tg.id);
    solderExploration();
    const attendent = db.prepare("SELECT COUNT(*) c FROM task_target WHERE task_id = ? AND status = 'needs_input'")
      .get(Number(req.params.id)).c;
    if (!attendent) notes.fermerTodoAuto('session_question', Number(req.params.id));
    return res.json(jobs.startReconcileJob(Number(req.params.id), {
      statuts: ['running'], targetIds: [tg.id], siRien: 'new',
    }));
  }

  let qs = [];
  try { qs = tg.questions_json ? JSON.parse(tg.questions_json) : []; } catch { qs = []; }
  const answers = (req.body && req.body.answers) || {};
  let filled = 0;
  qs = qs.map((q) => {
    const a = answers[q.id];
    if (a != null && String(a).trim()) { filled += 1; return { ...q, answer: String(a).trim(), answeredAt: new Date().toISOString() }; }
    return q;
  });
  if (!filled) throw new Error(t('err.reponses-manquantes'));
  // On quitte `needs_input` DÈS l'envoi des réponses : sinon, tant que la reprise tourne,
  // le moindre rechargement ré-affiche le formulaire (déjà répondu). Passage direct en running.
  db.prepare("UPDATE task_target SET questions_json = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(qs), new Date().toISOString(), tg.id);
  /* La todo posée par l'outil se referme ici — mais SEULEMENT si plus aucun projet de la
     session n'attend : sur une session multi-dépôts, répondre au premier ne solde pas le
     travail, et une todo cochée trop tôt fait oublier les quatre autres. */
  solderExploration();
  const encore = db.prepare("SELECT COUNT(*) c FROM task_target WHERE task_id = ? AND status = 'needs_input'")
    .get(Number(req.params.id)).c;
  if (!encore) notes.fermerTodoAuto('session_question', Number(req.params.id));
  res.json(jobs.startTaskJob(Number(req.params.id), 'answer', { targetId: tg.id }));
}));
// Push d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/push', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'committed') throw new Error(t('err.ce-projet-doit-etre-execute'));
  /* `force` vient de la CASE de la confirmation : c'est celui qui pousse qui décide, pas un
     drapeau posé plus tôt. Absent = push normal, y compris sur une branche rattrapée — le
     refus de la forge est alors la bonne réponse, et il se lit sur la ligne du projet. */
  const force = !!(req.body && (req.body.force === true || req.body.force === '1'));
  res.json(jobs.startTaskJob(Number(req.params.id), 'push', { targetId: tg.id, force }));
}));
/* Rattraper la branche de départ sur UN projet de la session.
 *
 * Ouvert dès que le travail est commité ou poussé — c'est-à-dire dès qu'il y a une branche à
 * rattraper. On ne restreint pas aux MR « en conflit » : les conflits se découvrent sur la
 * forge, souvent avant que l'application les connaisse, et un bouton qui n'apparaît qu'après
 * coup arrive toujours trop tard. Si la branche est déjà à jour, le job le dit et s'arrête. */
/* A21 — REPARTIR D'UNE SESSION D'AGENT NEUVE. Une session `claude` appartient au répertoire
   où elle a été créée : un identifiant venu d'ailleurs (le dépôt de l'utilisateur, une session
   ouverte à la main) n'existe pas dans le clone de Mergerie, et chaque passe échouait sur la
   même reprise impossible. Le repli automatique existe déjà côté runner ; ce bouton est pour
   le cas où l'on veut TRANCHER — on oublie le handle, la prochaine passe en crée un. */
app.post('/api/tasks/:id/targets/:tid/forget-session', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  localsession.oublier('task_target', db.prepare('SELECT uid FROM task_target WHERE id = ?').get(tg.id).uid);
  db.prepare('UPDATE task_target SET session_note = NULL WHERE id = ?')
    .run(tg.id);
  res.json({ ok: true });
}));
app.post('/api/tasks/:id/targets/:tid/update-base', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (!['committed', 'pushed', 'error'].includes(tg.status)) {
    throw new Error(t('err.ce-projet-doit-etre-execute'));
  }
  res.json(jobs.startTaskJob(Number(req.params.id), 'update-base', { targetId: tg.id }));
}));
// Crée la MR d'UN projet de la session.
/* Pousser toutes les branches d'une session qui ne le sont pas encore, en UN job. Sur une
   session de dix dépôts, pousser à la main dix fois est un travail de scribe — et on en oublie. */
app.post('/api/tasks/:id/push-all', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const cibles = db.prepare("SELECT id FROM task_target WHERE task_id = ? AND status = 'committed' ORDER BY id").all(t2.id);
  if (!cibles.length) throw new Error(t('err.rien-a-pousser'));
  res.json(jobs.startTaskJob(t2.id, 'push-all', { targetIds: cibles.map((c) => c.id) }));
}));
/* Créer la MR de tous les projets poussés qui n'en ont pas encore. Le titre n'est pas demandé
   projet par projet : chacun reprend la règle du cas unitaire (message de commit, sinon nom de
   branche). Un échec sur un projet n'empêche pas les autres — le bilan dit lesquels. */
app.post('/api/tasks/:id/mrs', wrap(async (req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const cfg = getConfig();
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const cibles = taskTargets(t2.id).filter((tg) => tg.status === 'pushed' && !effectiveMr(tg));
  if (!cibles.length) throw new Error(t('err.aucune-mr-a-creer'));
  const created = []; const failed = [];
  for (const tg of cibles) {
    try {
      const title = t2.commit_message || tg.branch;
      let target = tg.base_branch;
      if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = b.default || 'main'; }
      const mr = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, {
        source_branch: tg.branch, target_branch: target, title, squash, removeSourceBranch,
      });
      db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
        .run(mr.iid, mr.web_url, target, new Date().toISOString(), tg.id);
      rememberMergeOpts(tg.repo_id, mr.iid, squash, removeSourceBranch);
      created.push({ project: tg.project, iid: mr.iid, url: mr.web_url });
    } catch (e) {
      failed.push({ project: tg.project, error: e.message });
    }
  }
  res.json({ created, failed });
}));
app.post('/api/tasks/:id/targets/:tid/mr', wrap(async (req, res) => {
  const tache = taskById(Number(req.params.id));
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tache || !tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'pushed') throw new Error(t('err.la-branche-doit-etre-poussee'));
  const already = effectiveMr(tg);
  if (already) throw new Error(t('err.mr-already-open', { iid: already.iid }));
  const cfg = getConfig();
  const title = (req.body && req.body.title || '').trim() || tache.commit_message || tg.branch;
  let target = tg.base_branch;
  if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = b.default || 'main'; }
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, {
    source_branch: tg.branch, target_branch: target, title, squash, removeSourceBranch,
  });
  db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
    .run(mr.iid, mr.web_url, target, new Date().toISOString(), tg.id);
  rememberMergeOpts(tg.repo_id, mr.iid, squash, removeSourceBranch);
  /* B5 — PRÉVENIR JIRA, si la session le demande. Best-effort et jamais bloquant : la merge
     request EST créée, et un Jira injoignable ne doit pas faire croire le contraire. Le
     résultat est rendu avec la réponse, pour que l'écran puisse le dire. */
  let jiraNotifie = null;
  if (tache.notify_jira) jiraNotifie = await prevenirJira(tg).catch(() => null);
  /* B9 — REVIEWER DÈS LA CRÉATION, si la session l'a demandé. La merge request vient d'être
     ouverte sur la forge : la table locale ne la connaît pas encore (c'est la découverte qui
     l'y range). On fait donc l'upsert CIBLÉ — le même que la convergence — puis on enfile la
     review. Best-effort : la merge request EST créée, et une review qui ne part pas ne doit
     pas faire croire le contraire. */
  let reviewLancee = null;
  if (tache.review_after) {
    try {
      const apiMr = await forge.clientFor(tg).getMergeRequest(cfg, tg.project, mr.iid);
      const mrId = discover.upsertMrFromApi(tg.repo_id, apiMr);
      if (mrId) reviewLancee = jobs.startJob('review', [mrId], {});
    } catch { reviewLancee = null; }
  }
  res.json({ iid: mr.iid, url: mr.web_url, jira: jiraNotifie, review: reviewLancee });
}));
// Merge la MR d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/merge', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const eff = effectiveMr(tg);
  if (!eff) throw new Error(t('err.aucune-mr-a-merger-pour'));
  const known = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
  const merged = await forge.clientFor(tg).mergeMergeRequest(getConfig(), tg.project, eff.iid, mergeOptsFor(known, req.body));
  // GitLab peut répondre 200 sans merge immédiat : on ne marque que si l'état est 'merged'.
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    db.prepare('UPDATE task_target SET mr_iid = COALESCE(mr_iid, ?), mr_merged = 1, updated_at = ? WHERE id = ?')
      .run(eff.iid, now, tg.id);
    const linked = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
    if (linked) {
      db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(linked.id);
      db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
        .run('mr_merged', linked.iid, tg.project, linked.author || '', linked.title || '', now);
      notify.push('mr_merged', { mr_id: linked.id, iid: linked.iid, project: tg.project, title: linked.title || '', mine: true });
    }
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));
// B6 : symétrique de /mrs/:id/clear-error — sinon l'erreur d'une tâche revient à chaque refresh.
app.post('/api/tasks/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE task SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
