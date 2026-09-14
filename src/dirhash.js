'use strict';
/* L'EMPREINTE D'UN CHEMIN LOCAL — pur, sans base, et c'est le point.
 *
 * `src/db.js` en a besoin PENDANT ses migrations, c'est-à-dire avant d'avoir fini de s'exporter :
 * un module qui toucherait à la base y verrait un objet vide et planterait au chargement. Le
 * même découpage existe déjà entre `src/conflits.js` et `src/gitmerge.js`, pour la même raison.
 * Ce qui parle à la base vit dans `src/localdirs.js`, qui s'appuie sur ces trois fonctions.
 */
const crypto = require('node:crypto');
const path = require('node:path');

/* On normalise avant de hacher : un chemin avec un slash final, un `.` au milieu ou des
   séparateurs Windows désigne le même dossier et doit donner la même empreinte — sinon deux
   saisies du même dossier produiraient deux sessions qui ne se reconnaîtraient pas. La casse
   n'est PAS normalisée : sous Linux, deux dossiers ne diffèrent que par elle. */
const normaliser = (p) => path.normalize(String(p || '').trim()).replace(/[\\/]+$/, '');

/** 40 caractères stables, qui ne révèlent ni l'arborescence ni le nom de l'utilisateur. */
const empreinte = (p) => crypto.createHash('sha1').update(normaliser(p)).digest('hex');

/** Le nom à afficher : le dernier segment du chemin. */
const libelle = (p) => path.basename(normaliser(p)) || normaliser(p);

module.exports = { normaliser, empreinte, libelle };
