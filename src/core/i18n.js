'use strict';
/* LE DICTIONNAIRE DU SERVEUR, à une profondeur près. Le serveur traduit avec le même
   `public/i18n-runtime.js` que le navigateur ; un module de `src/app/routes/` l'atteindrait par
   `../../../public/…`, un module de `src/` par `../public/…`, et chaque déplacement changerait
   le chemin. Ici, tout le monde écrit `require('<…>/core/i18n')`, et `npm run check` reconnaît
   à cet import qu'un fichier traduit — donc que le nom `t` y est réservé. */
module.exports = require('../../public/i18n-runtime.js');
