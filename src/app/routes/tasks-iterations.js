'use strict';
/* Le diff d’UNE itération d’une session, sa sortie, ses passes, et les prompts que l’écran peut relire.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const i18n = require('../../core/i18n');
const { t } = i18n;
const demoDiff = require('../../demo/diff');
const agentpass = require('../../agent/pass');
const protocol = require('../../agent/protocol');
const path = require('path');
const { readFileSafe, wrap } = require('../http');
const { passesPayload } = require('../lib/partage');
const { demoMrDe, diffDePasse, targetById, taskById, taskTargets } = require('../lib/sessions');
const { dernieresVerificationsParMr, detailVerification, promptCorrectionVerif } = require('../lib/verifications');
const { targetCloneCtx, viewerFile, viewerFileDiff, viewerPayload } = require('../lib/visionneuse');

/* ---------- LE DIFF D'UNE SEULE ITÉRATION ----------
 *
 * Une session de codage s'itère : un run, puis des suivis. Le diff de la branche, lui, ne
 * distingue rien — au troisième suivi, la correction de trois lignes qu'on vient de demander
 * se cherche au milieu de deux cents. Chaque passe garde donc ses deux bornes (le HEAD avant,
 * celui d'après) et le patch entre les deux, et ces trois routes sont EXACTEMENT celles d'une
 * merge request ou d'un projet de session : le front ne change que la base d'URL, et retrouve
 * le même viewer (arbre, fichier entier, changements en place).
 *
 * Les bornes sont des COMMITS : d'où `shaRange`, qui dit aux routes de fichier de ne pas
 * préfixer la base par `origin/`.
 */
function passeCodageDe(taskId, tg, n) {
  const p = agentpass.get('task', taskId, tg.id, Number(n));
  if (!p) throw new Error(t('err.task.pass-not-found'));
  return p;
}
function ctxDePasse(tg, p) {
  return { ...targetCloneCtx(tg), ref: p.head_sha, target: p.base_sha, shaRange: true };
}
app.get('/api/tasks/:id/targets/:tid/passes/:n/diffview', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  const diff = await diffDePasse(p, targetCloneCtx(tg).cwd);
  const entete = { project: tg.project, branch: tg.branch, pass: { n: p.n, kind: p.kind, titre: p.titre || '', prompt: p.prompt || '' } };
  if (demoDiff.isDemo()) { res.json({ ...demoDiff.viewFor(demoMrDe(tg), diff), ...entete }); return; }
  res.json({ ...(await viewerPayload(ctxDePasse(tg, p), { diff, source: tg.branch })), ...entete });
}));
app.get('/api/tasks/:id/targets/:tid/passes/:n/file', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFile(ctxDePasse(tg, p), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/targets/:tid/passes/:n/filediff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  if (demoDiff.isDemo()) {
    res.json(demoDiff.fileDiffFor(demoMrDe(tg), String(req.query.path || ''), await diffDePasse(p)));
    return;
  }
  res.json(await viewerFileDiff(ctxDePasse(tg, p), String(req.query.path || '')));
}));
// Retour de l'agent pour un projet (ce qu'il dit avoir fait) — consultable en fin de session.
app.get('/api/tasks/:id/targets/:tid/output', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ output: tg.output_path ? readFileSafe(tg.output_path) : null, project: tg.project, branch: tg.branch });
}));
/* Historique des questions d'une exploration (niveau session, unité 0) : chaque
   question de suivi a écrasé la réponse précédente, mais la passe est archivée. */
app.get('/api/tasks/:id/passes', wrap((req, res) => {
  const tk = taskById(Number(req.params.id));
  if (!tk) throw new Error(t('err.session-introuvable'));
  res.json(passesPayload('task', 0, tk.id, req.query.n, tk.prompt || '', tk.md_path));
}));
/* LE PROMPT « TRAITE LE RAPPORT DE REVIEW », prêt à coller dans un suivi.
 *
 * Le même texte que le bouton « Faire corriger le code par l'IA » du rapport (`prompt.apply-review`),
 * mais rendu ICI, côté serveur : le rapport est un fichier sur le disque, et la liste des sessions
 * ne doit pas charrier le Markdown de chaque rapport à chaque rafraîchissement — elle se redessine
 * toutes les secondes et demie pendant un job.
 *
 * Une session multi-projets envoie son suivi à TOUS ses projets : le prompt reprend donc le rapport
 * de chacun, nommé, plutôt que d'en choisir un au hasard. `?target_id=` restreint à un projet —
 * c'est ce dont se sert le formulaire de suivi par projet.
 */
app.get('/api/tasks/:id/review-prompt', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const cibleId = req.query.target_id ? Number(req.query.target_id) : null;
  const projets = [];
  for (const tg of taskTargets(tache.id)) {
    if (cibleId && tg.id !== cibleId) continue;
    const iid = tg.mr_iid || tg.existing_mr_iid;
    if (!iid) continue;
    const rev = db.prepare(`SELECT review.md_path FROM review
      JOIN mr ON mr.id = review.mr_id
      WHERE mr.repo_id = ? AND mr.iid = ?`).get(tg.repo_id, iid);
    const md = rev && readFileSafe(rev.md_path);
    if (md && md.trim()) projets.push({ project: tg.project, iid, branch: tg.branch, md: md.trim() });
  }
  if (!projets.length) throw new Error(t('err.task.no-review-report'));
  /* Un seul projet : le prompt est exactement celui du bouton du rapport. Plusieurs : on empile
     les rapports sous un titre par projet, sinon l'agent ne sait pas quel constat va où. */
  const prompt = projets.length === 1
    ? t('prompt.apply-review', { branch: projets[0].branch, md: projets[0].md })
    : t('prompt.apply-review-multi', {
      blocs: projets.map((p) => t('prompt.apply-review-bloc', { project: p.project, iid: p.iid, md: p.md })).join('\n\n'),
    });
  res.json({ prompt, projets: projets.map((p) => ({ project: p.project, iid: p.iid })) });
}));
/* LE PROMPT « CORRIGE CE QUE LA VÉRIFICATION A CASSÉ », prêt à coller dans un suivi.
 *
 * Exactement celui de « Corriger (session IA) » — même fonction —, mais destiné au champ de
 * suivi : depuis la session qui a produit la branche, on veut que l'agent reprenne SON fil au
 * lieu d'ouvrir une session neuve qui redécouvre le code.
 *
 * On ne retient que les vérifications ÉCHOUÉES et IMPUTABLES à ces branches : une base déjà
 * rouge n'est pas de notre fait, et demander à l'agent de corriger ce qu'il n'a pas cassé lui
 * ferait toucher du code qui n'a rien à voir. */
app.get('/api/tasks/:id/verify-prompt', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const cibleId = req.query.target_id ? Number(req.query.target_id) : null;
  const parMr = dernieresVerificationsParMr();
  const vues = new Set();
  const blocs = [];
  for (const tg of taskTargets(tache.id)) {
    if (cibleId && tg.id !== cibleId) continue;
    const iid = tg.mr_iid || tg.existing_mr_iid;
    if (!iid) continue;
    const mr = db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, iid);
    const v = mr && parMr.get(mr.id);
    if (!v || vues.has(v.id)) continue;          // une vérification de lot couvre plusieurs projets
    const d = detailVerification(v);
    if (d.verdict !== 'verified_fail' || !(d.imputable || []).length) continue;
    vues.add(v.id);
    blocs.push({ prompt: promptCorrectionVerif(d, v), verifier: d.verifier_name });
  }
  if (!blocs.length) throw new Error(t('err.task.no-failed-verification'));
  res.json({
    prompt: blocs.map((b) => b.prompt).join('\n\n'),
    verificateurs: blocs.map((b) => b.verifier),
  });
}));
// Réponse .md d'une exploration.
app.get('/api/tasks/:id/md', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const brut = tache.md_path ? readFileSafe(tache.md_path) : null;
  /* Les blocs de protocole sont un canal de SERVICE : ils nomment le dépôt trouvé, décrivent
     l'agent à créer, signalent un écart. Ils n'ont rien à faire à l'écran — `?raw=1` les garde,
     pour qui veut relire ce que l'agent a réellement émis. */
  const md = (brut && !req.query.raw) ? protocol.nettoyer(brut) : brut;
  res.json({ md, prompt: tache.prompt, created_at: tache.created_at, agent_name: tache.agent_name });
}));
/* « Corriger sur <dépôt> » : le bloc `<<<REPO>>>` de l'enquêteur, lu à la demande. Rien n'est
   stocké — le rapport EST la source, et un dépôt recopié en base se périmerait tout seul. */
app.get('/api/tasks/:id/repo-hint', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const brut = tache.md_path ? readFileSafe(tache.md_path) : '';
  const { block } = protocol.extraire(brut || '', 'REPO');
  if (!block) return res.json(null);
  for (const champs of protocol.lignes(block)) {
    const projet = champs[0];
    if (!projet) continue;
    const repo = db.prepare('SELECT id, project FROM repo WHERE project = ?').get(projet);
    if (!repo) continue;                  // un dépôt inventé n'ouvre aucun bouton
    return res.json({ repo_id: repo.id, project: repo.project, path: champs[1] || '', line: champs[2] || '' });
  }
  res.json(null);
}));
