'use strict';
/* Le cockpit et « Lancer ma journée » : HTTP seulement — l'état dans `jobs/cockpit.js`, le lancement dans
   `lib/journee.js`. */
const { app } = require('../app');
const cockpit = require('../../jobs/cockpit');
const journee = require('../lib/journee');
const { wrap } = require('../http');

app.get('/api/cockpit', wrap((req, res) => {
  res.json({ ...cockpit.construire(), modeles: cockpit.modeles() });
}));
// Un appel Jira (une page de recherche), plus l'identité la première fois.
app.get('/api/cockpit/mes-tickets', wrap(async (req, res) => {
  res.json({ tickets: await journee.mesTickets() });
}));
// Un appel Jira par ticket coché.
app.post('/api/cockpit/journee', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await journee.lancerJournee({ keys: b.keys, modeleId: b.modele_id }));
}));
