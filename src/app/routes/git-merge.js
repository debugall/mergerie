'use strict';
/* Le merge de branche à branche (onglet Git → Merge), avec sa résolution de conflits à l’écran.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const gitmerge = require('../../git/gitmerge');
const path = require('path');
const { wrap } = require('../http');

/* ---------- Git · Merge de branche à branche (onglet Git → Merge) ----------
   Toutes ces routes travaillent dans le worktree du merge, jamais dans le clone partagé —
   voir l'en-tête de `src/gitmerge.js` pour le pourquoi. */

app.get('/api/git/merges', wrap((req, res) => res.json(gitmerge.enCours())));
app.post('/api/git/merges', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await gitmerge.demarrer(getConfig(), {
    repo_id: b.repo_id,
    source: b.source,
    target: b.target,
    // Fusionner deux histoires sans ancêtre commun se DEMANDE : voir `gitmerge.demarrer`.
    allow_unrelated: b.allow_unrelated === true || b.allow_unrelated === '1',
  }));
}));
app.get('/api/git/merges/:id', wrap(async (req, res) => {
  res.json(await gitmerge.etat(Number(req.params.id)));
}));
/* A31 — le diff du merge COMMITÉ. Après trente conflits résolus un par un, « qu'est-ce que ça
   donne, au total ? » demandait un terminal. */
app.get('/api/git/merges/:id/diff', wrap(async (req, res) => {
  res.json(await gitmerge.diffCommit(Number(req.params.id)));
}));
/* Le contenu d'un fichier en conflit, DÉCOUPÉ. L'écran reçoit les morceaux (stables et
   conflits) plutôt que du texte brut : c'est ce qui lui permet d'offrir « garder celle-ci /
   celle-là / les deux » par conflit, sans reparser les marqueurs de son côté. */
app.get('/api/git/merges/:id/file', wrap(async (req, res) => {
  const fichier = String((req.query && req.query.path) || '');
  const texte = gitmerge.contenu(Number(req.params.id), fichier);
  // Quelle version est la plus récente : la date du dernier commit touchant ce fichier, de
  // chaque côté (`null` s'il n'a pas d'historique sur ce côté — un fichier apparu de l'autre).
  const dates = await gitmerge.datesFichier(Number(req.params.id), fichier);
  res.json({ path: fichier, texte, morceaux: gitmerge.decouper(texte), dates });
}));
app.post('/api/git/merges/:id/resolve', wrap(async (req, res) => {
  const { path: fichier, content, choices } = req.body || {};
  res.json(await gitmerge.resoudre(Number(req.params.id), String(fichier || ''), {
    contenu: content == null ? null : content,
    choix: Array.isArray(choices) ? choices : null,
  }));
}));
app.post('/api/git/merges/:id/commit', wrap(async (req, res) => {
  res.json(await gitmerge.commiter(Number(req.params.id), (req.body && req.body.message) || ''));
}));
app.post('/api/git/merges/:id/push', wrap(async (req, res) => {
  res.json(await gitmerge.pousser(getConfig(), Number(req.params.id)));
}));
app.delete('/api/git/merges/:id', wrap(async (req, res) => {
  res.json(await gitmerge.abandonner(getConfig(), Number(req.params.id)));
}));
