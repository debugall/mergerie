'use strict';
/* Les en-têtes de toute réponse : politique de contenu, nosniff, no-referrer — posés en premier, pour que même un refus les porte.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');

/* LES EN-TÊTES DE TOUTE RÉPONSE — posés EN PREMIER, pour que même un refus et la page d'accès
   les portent.
 *
 * Une POLITIQUE DE CONTENU d'abord : seuls les scripts servis par l'application s'exécutent. Un
 * rendu qui laisserait passer une balise — un titre de merge request, un rapport venu du dépôt
 * partagé — ne pourrait plus rien lancer : il n'y a pas de script en ligne à autoriser, et il n'y
 * en a aucun dans la page (le thème est un fichier). Les styles en ligne restent admis : l'écran
 * en porte partout, et un style ne lance rien. `frame-ancestors 'none'` : personne ne met
 * Mergerie dans un cadre pour faire cliquer à travers.
 * `nosniff` : un fichier servi n'est lu que selon son type déclaré. `no-referrer` : l'adresse
 * d'un écran de Mergerie ne part pas vers les liens qu'on y suit. */
const POLITIQUE = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  /* `https:` pour les images SEULEMENT : l'icône d'un type de ticket vient du serveur Jira, et une
     image ne s'exécute pas. Les scripts, eux, ne viennent que d'ici. */
  "img-src 'self' data: blob: https:", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', POLITIQUE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
