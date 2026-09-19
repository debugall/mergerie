'use strict';
/* Mémo d'UNE requête : la table des dernières vérifications par merge request, qui balaie
   trois cents lignes. Un état de module, remis à zéro ICI, en entrée de chaque requête — un
   état doit se lire là où on le vide. Les mémos qui ne valent que le temps d'une requête ne
   se gardent pas plus longtemps : on servirait un instantané périmé (une vérification qui vient
   de finir resterait invisible) ; les recalculer à chaque appel referait N fois le même
   balayage sur une liste de sessions. `lib/verifications.js` le remplit (`verifsParMrDuTour`). */
const { app } = require('../app');

const memo = { verifs: null };

app.use((req, res, next) => { memo.verifs = null; next(); });

module.exports = memo;
