'use strict';
/* La jauge d'occupation disque et le ménage à la demande — ce que Réglages → Général montre sous la rétention. */
const { app } = require('../app');
const { wrap } = require('../http');
const retention = require('../../session/retention');
const { getConfig } = require('../../data/config');

/* MESURÉE À LA DEMANDE, jamais par le polling : un parcours des clones prend des secondes sur un
   gros poste, et c'est un bouton qui le demande. Une minute de cache — deux clics ne mesurent pas
   deux fois. */
let cache = null;
app.get('/api/stats/disk', wrap((req, res) => {
  if (!cache || Date.now() - cache.at > 60000 || req.query.force === '1') cache = { at: Date.now(), valeur: retention.occupationDisque() };
  res.json(cache.valeur);
}));
/* « NETTOYER MAINTENANT » : la passe quotidienne, tout de suite, avec les réglages du moment. Le
   bilan dit ce qui est parti — un ménage silencieux est indiscernable d'un ménage qui ne marche pas. */
app.post('/api/retention/run', wrap(async (req, res) => {
  const cfg = getConfig();
  const lignes = [];
  const bilan = await retention.menage({ jours: cfg.retention_days, mrJours: cfg.mr_retention_days, onLog: (m) => lignes.push(m) });
  cache = null;   // la jauge change avec le ménage
  res.json({ ok: true, bilan, lignes });
}));
