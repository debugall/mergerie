'use strict';
/* L'application Express, et rien d'autre. Créée ici pour que les middlewares et les routes,
   chacun dans son fichier, s'y accrochent en s'important — server.js décide de l'ORDRE en les
   chargeant l'un après l'autre (refacto.md, étape 2). */
const express = require('express');

const app = express();

module.exports = { app };
