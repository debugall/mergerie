'use strict';
/* Le rattrapage d'une période (Notes → Période) : construire une fenêtre, la relire, marquer vu — et la présence, qui nourrit la bannière du brief.
   HTTP et rien d'autre : la logique vit dans `notes/periode.js`, la construction tourne en job. */
const { app } = require('../app');
const db = require('../../db');
const { getConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const jobs = require('../../jobs');
const periode = require('../../notes/periode');
const git = require('../../git/git');
const { repoById, wrap } = require('../http');

/* La PRÉSENCE : le front n'appelle cette route qu'après un geste réel (clavier, pointeur), au
   plus une fois par minute — jamais depuis le poll de statut, qu'un poste resté allumé envoie
   pendant tout un congé. C'est ce qui rend la bannière « tu n'as pas ouvert Mergerie depuis
   12 jours » fiable. */
app.post('/api/presence', wrap((req, res) => {
  res.json({ last_seen: periode.presence() });
}));
app.get('/api/periode/absence', wrap((req, res) => {
  const a = periode.absence();
  // La dernière période construite sur cette fenêtre, pour l'ouvrir plutôt que la refaire.
  const derniere = db.prepare('SELECT id, depuis, jusqua, built_at FROM periode ORDER BY id DESC LIMIT 1').get() || null;
  res.json({ ...a, last_periode: derniere });
}));

/* La bannière a servi, ou on l'écarte : l'absence figée s'oublie. */
app.post('/api/periode/absence/dismiss', wrap((req, res) => {
  periode.ecarterAbsence();
  res.json({ ok: true });
}));
/* « Je pars » : l'absence commence maintenant, à la minute. */
app.post('/api/periode/depart', wrap((req, res) => {
  res.json(periode.partir());
}));

app.get('/api/periode', wrap((req, res) => {
  res.json({ periodes: periode.lister(Number(req.query.limit) || 10), hide_bots: getConfig().periode_hide_bots !== '0' });
}));

/* Construire : la ligne est créée tout de suite (l'écran a un identifiant à suivre), le
   contenu arrive avec le job. Une fenêtre de plus de 90 jours est acceptée mais signalée. */
app.post('/api/periode', wrap((req, res) => {
  const b = req.body || {};
  let p;
  try { p = periode.creer({ depuis: b.depuis, jusqua: b.jusqua, repoIds: Array.isArray(b.repo_ids) ? b.repo_ids : null }); }
  catch (e) {
    if (e.message === 'periode.dates') throw new Error(t('err.periode.dates'));
    if (e.message === 'periode.ordre') throw new Error(t('err.periode.ordre'));
    throw e;
  }
  const job = jobs.startPeriodeJob(p.id);
  res.json({ periode: p, job, long: p.days > 90 });
}));
app.post('/api/periode/:id/rebuild', wrap((req, res) => {
  const p = periode.lire(Number(req.params.id));
  if (!p) throw new Error(t('err.periode.introuvable'));
  res.json({ periode: p, job: jobs.startPeriodeJob(p.id) });
}));
app.get('/api/periode/:id', wrap((req, res) => {
  const p = periode.lire(Number(req.params.id));
  if (!p) throw new Error(t('err.periode.introuvable'));
  const job = p.job_id ? db.prepare('SELECT id, status, message, finished_at FROM job WHERE id = ?').get(p.job_id) : null;
  const resumeJob = db.prepare("SELECT id, status, message, finished_at FROM job WHERE kind = 'periode-resume' AND target_kind = 'periode' AND target_id = ? ORDER BY id DESC LIMIT 1").get(p.id) || null;
  res.json({ ...p, job, resume_job: resumeJob, hide_bots: getConfig().periode_hide_bots !== '0' });
}));
/* Le résumé IA : UN appel, sur demande — jamais par défaut. */
app.post('/api/periode/:id/resume', wrap((req, res) => {
  const p = periode.lire(Number(req.params.id));
  if (!p) throw new Error(t('err.periode.introuvable'));
  if (!p.built_at) throw new Error(t('err.periode.pas-construite'));
  res.json({ job: jobs.startPeriodeResumeJob(p.id) });
}));
app.delete('/api/periode/:id', wrap((req, res) => {
  res.json({ ok: !!periode.supprimer(Number(req.params.id)) });
}));
/* « Vu » : une ligne, plusieurs, ou toutes ; et l'inverse (`seen: false`). */
app.post('/api/periode/:id/seen', wrap((req, res) => {
  const p = periode.lire(Number(req.params.id));
  if (!p) throw new Error(t('err.periode.introuvable'));
  const b = req.body || {};
  const n = periode.marquerVu(p.id, { itemIds: b.item_ids, tout: !!b.all, seen: b.seen !== false });
  res.json({ ok: true, changed: n, unseen: periode.lire(p.id).unseen });
}));

/* LE DIFF D'UN PUSH DIRECT — deux SHA résolus dans le clone, `base..head`. Lecture du clone
   local (pas de fetch : le job vient de le faire), comme `/api/mrs/:id/diff`. */
app.get('/api/periode/:id/items/:item/diff', wrap(async (req, res) => {
  const it = db.prepare('SELECT * FROM periode_item WHERE id = ? AND periode_id = ?').get(Number(req.params.item), Number(req.params.id));
  if (!it || it.kind !== 'push') throw new Error(t('err.periode.introuvable'));
  let extra = {};
  try { extra = JSON.parse(it.extra || '{}'); } catch { /* illisible */ }
  const repo = repoById(it.repo_id);
  if (!repo || !extra.base_sha || !extra.head_sha) throw new Error(t('err.periode.diff-indisponible'));
  const cwd = git.cloneDirFor(getConfig(), repo);
  if (!await git.refExists(cwd, extra.head_sha)) throw new Error(t('err.periode.diff-indisponible'));
  res.json({ diff: await git.diffRange(cwd, extra.base_sha, extra.head_sha), base: extra.base_sha, head: extra.head_sha, branch: extra.branche });
}));
