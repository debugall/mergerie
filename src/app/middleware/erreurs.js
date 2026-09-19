'use strict';
/* Le dernier filet : une erreur qu’aucune route n’a attrapée devient une réponse JSON, jamais une trace.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const i18n = require('../../core/i18n');
const { t } = i18n;
const path = require('path');

/* LA DERNIÈRE ÉTAPE : TOUTE ERREUR QUI N'A PAS ÉTÉ RATTRAPÉE RÉPOND EN JSON. Sans elle, Express
   rendait sa page d'erreur — pile d'appels et chemins absolus de la machine compris — pour un
   JSON malformé ou une route hors `wrap`. Le détail va au journal du serveur, pas à la réponse. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) { try { res.end(); } catch { /* socket fermé */ } return; }
  const brut = Number(err && (err.status || err.statusCode));
  const status = brut >= 400 && brut < 600 ? brut : 500;
  if (status >= 500) console.log(`[http] ${req.method} ${req.path} : ${(err && err.message) || err}`);
  res.status(status).json({
    error: err && err.type === 'entity.parse.failed' ? t('err.http.json-illisible')
      : (status >= 500 ? t('err.http.interne') : t('err.http.requete-invalide')),
  });
});
