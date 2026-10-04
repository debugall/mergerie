'use strict';
/* Les tâches périodiques des plugins — l'instance unique du serveur (code dans `sdk/lib/horloge.js`). */
const path = require('path');

module.exports = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'horloge.js')).creer({ log: (m) => console.error(m) });
