'use strict';
/* Les dépendances ajoutées : les défauts livrés (pour « Remettre les défauts ») et l'aperçu d'un
   réglage — « sur les MR ouvertes de ce dépôt, ces motifs désignent 3 manifestes ». Lecture de la
   base, zéro réseau, zéro IA. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const dependances = require('../../review/dependances');
const { wrap } = require('../http');

app.get('/api/dependances/defauts', wrap((req, res) => {
  res.json({ manifest_patterns: dependances.DEFAUT_MANIFESTES.join('\n'), max: dependances.MAX_MOTIFS });
}));

app.post('/api/dependances/apercu', wrap((req, res) => {
  const b = req.body || {};
  const manifest_patterns = b.manifest_patterns != null ? dependances.normaliserMotifs(b.manifest_patterns) : null;
  res.json(dependances.apercu(getConfig(), { repoId: Number(b.repo_id) || null, groupId: Number(b.group_id) || null, manifest_patterns }));
}));
