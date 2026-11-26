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
// Préparer : un appel Jira par ticket, rien n'est créé.
app.post('/api/cockpit/journee/preparer', wrap(async (req, res) => {
  res.json(await journee.preparerJournee({ keys: (req.body || {}).keys }));
}));
// Créer les sessions préparées (dépôts saisis dans la fenêtre), lancées ou non. Aucun appel Jira.
app.post('/api/cockpit/journee/creer', wrap((req, res) => {
  const b = req.body || {};
  res.json(journee.creerSessions({ sessions: b.sessions, modeleId: b.modele_id, lancer: b.lancer !== false }));
}));
// Supprimer un élément : la session et celles du même ticket.
app.post('/api/cockpit/supprimer', wrap((req, res) => {
  res.json(journee.supprimerElement(Number((req.body || {}).task_id)));
}));
