'use strict';
/* Le MODE DÉMO (`MERGERIE_DEMO=1`) : une seule question, posée par les routes qui répondent d'un décor au lieu d'un service réel. Les jeux de données
   de démo vivent à côté (`demo/agents.js`, `demo/jira.js`, `demo/diff.js`…) ; celui de Docker est dans le plugin Docker, qui sème et répond lui-même. */
const isDemo = () => process.env.MERGERIE_DEMO === '1';

module.exports = { isDemo };
