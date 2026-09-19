'use strict';
/* LE PROFIL D'UN AGENT, vu de l'extérieur : `require('../agent/profile')` rend la même interface
   que l'ancien profile.js d'une seule pièce (refacto.md, étape 5). Dedans, quatre modules qui ne
   se referment pas en cycle :
   — `modele.js` : lire, valider, écrire un profil, et sa fiche — importable par tous ;
   — `prompt.js` : d'un profil aux options et à la demande d'un run (lit la connaissance) ;
   — `apres.js` : ce qu'on fait de la sortie d'un run (écrit la connaissance, les notes) ;
   — `lancer.js` : lancer un agent, mettre à jour sa connaissance — le seul à toucher `jobs/`.
   Un module qui vit lui-même sous `jobs/` (l'exécutant d'une session) ou en amont
   (`session/taskrunner.js`, `agent/knowledge.js`) importe `modele`, `prompt` ou `apres`
   directement, jamais ce fichier : passer par ici chargerait `lancer`, donc `jobs/`, et le cycle
   se refermerait. */
const { lister, lire, parCle, creer, modifier, supprimer, dupliquer, restaurer, seedBuiltins, valider, brouillonValide, repos, OUTILS_DEFAUT, jsonOu } = require('./modele');
const { optionsFor, systemPromptFor, composer, materialize, previewFor } = require('./prompt');
const { lancer, refreshKnowledge } = require('./lancer');
const { apresRun, ecrireEntrees, blocEntrees } = require('./apres');

module.exports = {
  lister, lire, parCle, creer, modifier, supprimer, dupliquer, restaurer, seedBuiltins, valider, brouillonValide, repos, OUTILS_DEFAUT, jsonOu, optionsFor, systemPromptFor, composer, materialize, previewFor, lancer, refreshKnowledge, apresRun, ecrireEntrees, blocEntrees,
};
