'use strict';
/* L'ÉTAPE TESTS DE LA CHAÎNE DE VALIDATION : ce que la fenêtre de session annonce (les dépôts de tests
   retenus, et si leur forge est configurée) et la vue de diff de ce que l'agent a écrit, dépôt par dépôt —
   les trois routes du viewer des sessions, plus le retour de l'agent d'un dépôt de tests. */
const fs = require('node:fs');
const { app } = require('../app');
const git = require('../../git/git');
const chaineVerif = require('../../jobs/chaine-verif');
const chaineScen = require('../../jobs/chaine-scenario');
const { t } = require('../../core/i18n');
const { viewerFile, viewerFileDiff, viewerPayload } = require('../lib/visionneuse');
const { wrap } = require('../http');

const ids = (q) => String(q || '').split(',').map(Number).filter(Boolean);

app.get('/api/chaine/depots-tests', wrap((req, res) => {
  res.json(chaineScen.apercuDepots(ids(req.query.verifiers), ids(req.query.repos)));
}));

function contexte(req) {
  const ctx = chaineVerif.contexteDiffTests(Number(req.params.id), Number(req.params.repoId));
  if (!ctx) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  return ctx;
}
app.get('/api/tasks/:id/chaine/tests/:repoId/diffview', wrap(async (req, res) => {
  const ctx = contexte(req);
  const diff = await git.diffRange(ctx.cwd, ctx.target, ctx.ref).catch(() => '');
  res.json({ ...(await viewerPayload(ctx, { diff: diff || '', source: ctx.branch })), project: ctx.project, branch: ctx.branch });
}));
app.get('/api/tasks/:id/chaine/tests/:repoId/file', wrap(async (req, res) => {
  res.json(await viewerFile(contexte(req), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/chaine/tests/:repoId/filediff', wrap(async (req, res) => {
  res.json(await viewerFileDiff(contexte(req), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/chaine/tests/:repoId/output', wrap((req, res) => {
  const ctx = contexte(req);
  let output = '';
  try { output = ctx.sortie ? String(JSON.parse(fs.readFileSync(ctx.sortie, 'utf8')).texte || '') : ''; } catch { output = ''; }
  res.json({ output });
}));
