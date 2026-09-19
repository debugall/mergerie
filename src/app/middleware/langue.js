'use strict';
/* La langue de l’écran, pour la durée de la requête.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');

/* LA LANGUE DE L'ÉCRAN, POUR LA DURÉE DE LA REQUÊTE. Elle vit dans le navigateur, pas en base :
   ce qui se règle dans l'interface doit valoir tout de suite, y compris pour les libellés que
   le serveur fabrique (messages d'erreur, jeu de démo). Sans cet en-tête, passer l'écran en
   anglais laissait « Mes dépôts (démo) » en français au milieu d'un onglet traduit.
   Un état de module suffit : Mergerie est mono-utilisateur, une requête à la fois côté écran.
   L'absence d'en-tête (appel direct à l'API, script) retombe sur la langue enregistrée. */
app.use((req, res, next) => {
  const l = String(req.headers['x-mergerie-lang'] || '').trim();
  i18n.setLang(l === 'en' || l === 'fr' ? l : getConfig().language);
  next();
});
