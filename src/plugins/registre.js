'use strict';
/* Le registre des déclarations d'écran des plugins — l'instance unique du serveur (code dans `sdk/lib/registre.js`). */
const path = require('path');

module.exports = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'registre.js')).creer();
