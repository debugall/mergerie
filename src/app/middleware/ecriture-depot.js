'use strict';
/* Écrire les fichiers du dépôt de données après chaque requête qui a écrit.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const store = require('../../data/store');

/* ÉCRIRE LES FICHIERS DU DÉPÔT APRÈS CHAQUE REQUÊTE QUI A ÉCRIT.
 *
 * Les déclencheurs de `db.js` notent toute ligne partagée touchée, d'où que vienne l'écriture.
 * On écoule cette file quand la réponse est PARTIE : l'utilisateur n'attend pas l'écriture de
 * ses fichiers, et une erreur de disque ne transforme pas une sauvegarde réussie en erreur 500.
 *
 * La file vivant dans la base, dans la même transaction que l'écriture, rien ne se perd si le
 * processus meurt entre les deux : le démarrage suivant écrit ce qui manque.
 *
 * `res.on('finish')` et non un `await` : une requête de lecture — et il y en a des dizaines par
 * seconde — trouve une file vide et ne coûte qu'un `SELECT COUNT(*)`. */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    try { if (store.enRetard()) store.ecouler(); } catch (e) { console.log(`[store] ${e.message}`); }
  });
  return next();
});
