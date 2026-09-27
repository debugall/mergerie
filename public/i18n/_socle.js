'use strict';
/* Le dictionnaire du navigateur, VIDE au départ : chaque famille (i18n/*.js, dans l'ordre du
   manifeste) s'y ajoute par `I18N.etendre({ fr, en })`. Côté Node, c'est `i18n/index.js` qui
   assemble. `etendre` est non énumérable : `Object.keys(I18N)` reste la liste des langues. */
(function (root) {
  const I18N = { fr: {}, en: {} };
  Object.defineProperty(I18N, 'etendre', {
    value(d) { for (const l of Object.keys(d)) Object.assign(I18N[l] || (I18N[l] = {}), d[l]); },
  });
  root.I18N = I18N;
}(typeof self !== 'undefined' ? self : this));
