'use strict';
/* Une passe d’agent se renomme et se met en favori — la seule chose qu’on écrit sur une itération après coup.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const i18n = require('../../core/i18n');
const { t } = i18n;
const agentpass = require('../../agent/pass');
const { wrap } = require('../http');

/* NOMMER ET ÉPINGLER UNE ITÉRATION. Une seule route pour les quatre saveurs : une passe se
   désigne par l'identifiant de sa ligne, qui est déjà unique. Quatre routes parallèles auraient
   dérivé, et c'est exactement le genre d'endroit où une saveur se fait oublier. */
app.put('/api/agent-passes/:id', wrap((req, res) => {
  const body = req.body || {};
  const maj = agentpass.marquer(req.params.id, {
    favori: body.favori === undefined ? undefined : !!body.favori,
    titre: body.titre === undefined ? undefined : body.titre,
  });
  if (!maj) throw Object.assign(new Error(t('err.pass-introuvable')), { status: 404 });
  res.json(maj);
}));
