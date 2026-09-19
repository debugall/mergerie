'use strict';
/* Flux d'événements « notifiables » (notifications bureau).

   Le serveur émet des FAITS bruts dans un buffer en mémoire ; le CLIENT décide
   quoi afficher selon ses préférences locales (types activés, seuil de note, mode
   silencieux). Séparer ainsi garde le serveur simple et met les préférences
   là où elles ont du sens : le navigateur qui reçoit la notif.

   Critère de ce qui entre ici : une notif doit appeler une action ou clore une
   attente. Le reste (ambiance) appartient au footer. */

const events = [];
let seq = 0;
const MAX = 300; // buffer borné : on ne garde que le récent

// Émet un événement. `data` porte le contexte de navigation (mr_id, task_id…).
function push(type, data = {}) {
  seq += 1;
  events.push({ id: seq, type, at: new Date().toISOString(), ...data });
  if (events.length > MAX) events.shift();
  return seq;
}

// Événements postérieurs à `afterId` (le client passe le dernier id vu).
function since(afterId) {
  const a = Number(afterId) || 0;
  return events.filter((e) => e.id > a);
}

function latestId() { return seq; }

module.exports = { push, since, latestId };
