'use strict';
// @ts-check
/* LE BUS D'ÉVÉNEMENTS DU CŒUR. Le cœur dit ce qui vient de se passer (`session.finished`,
   `verify.finished`…), et quiconque écoute — un plugin, un module du cœur — réagit, sans que
   l'émetteur sache qui. C'est le seul tissage admis entre le cœur et un plugin, et entre deux
   plugins : un `require` d'un module de l'autre côté est refusé, un événement ne l'est jamais.

   Trois règles, chacune née d'un besoin précis :
   — LES HANDLERS TOURNENT EN FILE, dans l'ordre d'abonnement, l'un après l'autre : un plugin qui
     réagit à `session.finished` en écrivant sa table ne court pas après un autre qui lit la même.
   — UN HANDLER QUI ÉCHOUE EST ISOLÉ : try/catch et délai (30 s par défaut). L'erreur est
     journalisée avec le nom de l'abonné ; ni l'émetteur ni les autres handlers ne la voient.
     Un plugin tiers qui lève ne doit jamais interrompre une session de codage.
   — LE PAYLOAD EST UN OBJET SIMPLE, sérialisable, qui porte `version` (celle de l'événement dans
     le contrat) : il traverse tel quel la frontière d'un worker, et un plugin écrit contre la
     version 1 saura reconnaître une version 2.

   Le code vit dans `sdk/lib/bus.js` — le même que le SDK de test instancie — ; ici, l'instance
   unique du serveur. Les noms et versions viennent de `sdk/contract.js`, la source unique
   partagée avec la documentation et les types. */
const path = require('path');

const { creerBus } = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'bus.js'));

module.exports = creerBus();
