'use strict';
/* Le dictionnaire du plugin, fr et en côte à côte. Clés préfixées par « hello. ». Chargé par le
   serveur (activate) et par la page (UMD : require() côté Node, I18N.etendre() côté navigateur). */
(function (root, factory) {
  const d = factory();
  if (typeof module === 'object' && module.exports) module.exports = d;
  else root.I18N.etendre(d);
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    fr: {
      'hello.nav': 'Hello',
      'hello.tab.title': 'Hello : les événements reçus et la salutation réglée',
      'hello.title': 'Ce que Hello a vu',
      'hello.empty': 'Aucun événement reçu pour l’instant.',
      'hello.greeting': 'Salutation réglée : {greeting}',
    },
    en: {
      'hello.nav': 'Hello',
      'hello.tab.title': 'Hello: the events received and the configured greeting',
      'hello.title': 'What Hello saw',
      'hello.empty': 'No event received yet.',
      'hello.greeting': 'Configured greeting: {greeting}',
    },
  };
}));
