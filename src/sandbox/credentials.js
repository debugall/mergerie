'use strict';
/* LE BROKER DE CREDENTIALS — un HOME synthétique par session/job, jamais un lien vivant vers le
 * home réel de l'utilisateur (§5.3 du plan). Un symlink reste un chemin VERS la source : un outil
 * qui le suit voit tout ce qu'il y a derrière, y compris ce qui y a été ajouté depuis. Une COPIE,
 * une fois faite, en est coupée — la seule façon de garantir qu'un home isolé ne grandisse pas en
 * secret pendant que le job tourne.
 *
 * Aucun nom de fichier d'auth n'est connu avec certitude ici (chaque version du CLI Copilot peut
 * en ajouter un) : plutôt qu'une liste blanche fragile qui casserait l'authentification au
 * premier fichier renommé, on copie tout SAUF une liste noire de ce qui est sûrement du contexte,
 * jamais de l'auth (historique, sessions, logs, cache, instructions, skills) — et on REFUSE si
 * rien n'a pu être copié, plutôt que de lancer un home vide en silence.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { erreurSandbox } = require('./errors');

const EXCLUS = /^(history|history-session-state|sessions?|session-state|logs?|tmp|cache|skills|copilot-instructions\.md)$/i;

/** La source la plus probable du home Copilot réel — jamais devinée plus loin que ça. */
function sourceCopilotHome(env = process.env) {
  const cands = [env.COPILOT_HOME, path.join(os.homedir(), '.copilot'),
    env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'copilot')];
  return cands.find((c) => c && fs.existsSync(c)) || null;
}

/** Copie (jamais un lien) ce qui n'est pas sur liste noire depuis `source` vers `dest`, déjà créé
 *  à 0700. Lève `SANDBOX_CREDENTIALS_UNSUPPORTED` si rien n'a pu être copié — jamais un home vide
 *  lancé en silence (§5.3 : « refuser plutôt que monter le home réel »). */
function copierHomeCopilot(source, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (!source || !fs.existsSync(source)) throw erreurSandbox('SANDBOX_CREDENTIALS_UNSUPPORTED', { backend: 'copilot' });
  const copies = [];
  for (const nom of fs.readdirSync(source)) {
    if (EXCLUS.test(nom)) continue;
    const src = path.join(source, nom);
    try {
      if (fs.lstatSync(src).isSymbolicLink()) continue; // jamais suivre un lien du home source
      fs.cpSync(src, path.join(dest, nom), { recursive: true, dereference: false });
      copies.push(nom);
    } catch { /* un fichier illisible ne doit pas empêcher les autres */ }
  }
  if (!copies.length) throw erreurSandbox('SANDBOX_CREDENTIALS_UNSUPPORTED', { backend: 'copilot' });
  // `dest` reste EN ÉCRITURE (0700 posé à sa création) : le CLI y crée sa propre session au
  // premier lancement (`sessions/`, `history` — justement ce qu'on a exclu de la copie). Un
  // home en lecture seule empêcherait --continue de fonctionner, pas seulement l'exfiltration.
  return { source, linked: copies };
}

module.exports = { sourceCopilotHome, copierHomeCopilot, EXCLUS };
