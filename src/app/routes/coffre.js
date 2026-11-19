'use strict';
/* Le coffre des jetons, vu de Réglages → Sécurité : son état, l'activer, le désactiver, changer le mot de
   passe maître, verrouiller, la 2FA. Déverrouiller et réinitialiser ne sont pas ici : verrouillé, l'API
   est fermée, et la page de connexion poste ses formulaires à `app/middleware/coffre.js`. */
const { app } = require('../app');
const coffre = require('../../data/coffre');
const { wrap } = require('../http');

const corps = (req) => req.body || {};
app.get('/api/coffre', wrap((req, res) => res.json({ ...coffre.etat(), min: coffre.MDP_MIN })));
/* Lire l'état ne l'acquitte pas : l'onglet Sécurité, rouvert au démarrage, le lit aussi. */
app.post('/api/coffre/ressaisir-vu', wrap((req, res) => { coffre.acquitterRessaisir(); res.json(coffre.etat()); }));
app.post('/api/coffre/activer', wrap((req, res) => res.json(coffre.activer(corps(req).mdp, corps(req).confirmation))));
app.post('/api/coffre/desactiver', wrap((req, res) => res.json(coffre.desactiver(corps(req).mdp))));
app.post('/api/coffre/mot-de-passe', wrap((req, res) => res.json(coffre.changerMotDePasse(corps(req).ancien, corps(req).nouveau, corps(req).confirmation))));
app.post('/api/coffre/verrouiller', wrap((req, res) => res.json(coffre.verrouiller())));
app.post('/api/coffre/totp/preparer', wrap((req, res) => res.json(coffre.preparerTotp())));
app.post('/api/coffre/totp/activer', wrap((req, res) => res.json(coffre.activerTotp(corps(req).code))));
app.post('/api/coffre/totp/desactiver', wrap((req, res) => res.json(coffre.desactiverTotp(corps(req).mdp))));
