'use strict';
/* Les merge requests empilées : le DIFF PROPRE d'une merge request contenante — les fichiers qu'elle
   touche et qu'aucune des merge requests qu'elle contient ne touche —, calculé sur `mr_files` à
   l'ouverture du panneau, pas dans la liste. Lecture de la base, zéro réseau, zéro IA. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const empilees = require('../../review/empilees');
const { wrap } = require('../http');

app.get('/api/empilees/:id/propre', wrap((req, res) => {
  res.json(empilees.diffPropre(getConfig(), Number(req.params.id)));
}));
