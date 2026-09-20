'use strict';
/* Le DOM : `$` rend un élément, `$$` une liste ; `onEl` câble si l'élément existe. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
/* Petit garde-fou : les éléments câblés ici vivent tous dans index.html, mais un id renommé
   ne doit pas casser tout le script au chargement.
   DÉCLARÉE `function` et non `const` : ce fichier est un seul script global, et les câblages
   de premier niveau s'exécutent dans l'ordre du texte. Un `const` n'est utilisable qu'APRÈS
   sa ligne — le premier appel écrit plus haut arrêtait l'évaluation du fichier entier, donc
   tout ce qui suit cessait d'exister (« Cannot access X before initialization » en cascade).
   Une déclaration de fonction, elle, est hissée. */
function onEl(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
