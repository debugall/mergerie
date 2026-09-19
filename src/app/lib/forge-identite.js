'use strict';
/* Qui je suis sur chaque forge — mémorisé, parce que l’écran le demande souvent.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const forge = require('../../forge');

/* Compte associé au jeton d'une forge. Sert à reconnaître MES commentaires, donc ceux que
   je peux modifier. Mis en cache : sans cela, chaque ouverture de rapport ajouterait un
   aller-retour réseau pour une réponse qui ne change jamais. Un échec n'est pas une erreur —
   il rend simplement les commentaires non modifiables, ce qui est le repli sûr. */
const meCache = new Map();               // forge -> { username, name, at }
const ME_TTL_MS = 30 * 60 * 1000;
/* Le compte du jeton, par forge. On garde le PSEUDO **et** le nom affiché : les merge requests
   stockent l'un ou l'autre selon la forge (GitLab pose `author.name`, GitHub le `login`), et
   savoir « est-ce la mienne ? » demande de pouvoir reconnaître les deux. */
async function forgeIdentite(nomForge) {
  const hit = meCache.get(nomForge);
  if (hit && Date.now() - hit.at < ME_TTL_MS) return hit;
  try {
    const u = await forge.clientFor(nomForge).currentUser(getConfig());
    const ident = { username: (u && u.username) || '', name: (u && u.name) || '', at: Date.now() };
    meCache.set(nomForge, ident);
    return ident;
  } catch { return { username: '', name: '', at: 0 }; }
}
async function forgeUsername(mr) {
  return (await forgeIdentite(forge.forgeOf(mr))).username;
}

module.exports = {
  meCache, ME_TTL_MS, forgeIdentite, forgeUsername,
};
