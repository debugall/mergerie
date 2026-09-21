'use strict';
/* LE SECRET DES NONCES DE PROTOCOLE (plan_secure.md, lot D — durci après revue de add-secure-layer-2).
 *
 * `protocol.nonceAgentRun` et `taskrunner.nonceQuestionsTache` doivent rendre le MÊME nonce d'un
 * bout à l'autre d'une tâche (une session reprise n'y revoit jamais la consigne, seulement son
 * souvenir) sans rien avoir à écrire nulle part : au départ, ils hachaient donc simplement
 * `agent-<id>` / `questions-<id>`. Mais l'id est un entier AUTO-INCRÉMENTÉ, connu et sans secret
 * — un fichier lu par l'agent (le dépôt qu'il explore, une page qu'on lui fait ouvrir) peut
 * précalculer le nonce de chaque id plausible et y glisser un `<<<AGENT …>>>` tout formé, qui
 * passerait alors pour la sortie du run courant.
 *
 * La parade : un HMAC, pas un simple hachage — la clé est un secret de 32 octets, propre à CE
 * POSTE, écrit UNE FOIS (pas régénéré au démarrage comme `jetonlocal.js` : un nonce doit rester
 * stable même si le serveur redémarre pendant qu'une session tourne) et FERMÉ à l'agent des deux
 * façons dont il pourrait le lire (`agentpolicy.interditsDonnees`/`sandboxDenyRead`) — sans lui,
 * même une commande shell ne peut pas se le procurer. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./paths');

const FICHIER = path.join(DATA_DIR, 'protocol-secret');

let cache = null;

/** Le secret de ce poste — lu sur disque, ou créé (32 octets, 0600) au premier appel. */
function lire() {
  if (cache) return cache;
  try {
    const sur_disque = fs.readFileSync(FICHIER, 'utf8').trim();
    if (sur_disque) { cache = sur_disque; return cache; }
  } catch { /* pas encore créé */ }
  cache = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(FICHIER, cache, { mode: 0o600 });
  try { fs.chmodSync(FICHIER, 0o600); } catch { /* umask restrictif : déjà le bon mode */ }
  return cache;
}

/** HMAC-SHA256 de `texte` avec le secret de ce poste, tronqué à `longueur` caractères hex. */
function hmac(texte, longueur = 12) {
  return crypto.createHmac('sha256', lire()).update(String(texte)).digest('hex').slice(0, longueur);
}

module.exports = { FICHIER, lire, hmac };
