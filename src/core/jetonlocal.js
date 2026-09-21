'use strict';
/* LE JETON DE SESSION LOCAL (plan_secure.md, lot B, constat S1).
 *
 * `garde.js` ferme l'API à un NAVIGATEUR étranger (Host, Sec-Fetch-Site, origine) et, quand le
 * poste est exposé, à un client sans `MERGERIE_ACCESS_TOKEN`. Rien ne fermait l'API à un
 * PROCESSUS du poste lui-même : sans en-tête `Origin` (un navigateur en pose un sur une requête
 * cross-site, `fetch()` depuis Node n'en pose aucun), `PUT /api/config` avec une nouvelle
 * `gitlab_url` conserve le jeton de forge stocké, et le prochain rafraîchissement l'envoie où ce
 * processus l'a redirigé.
 *
 * La parade : un jeton de 32 octets, écrit dans `<DATA_DIR>/local-token` (0600), RÉGÉNÉRÉ À
 * CHAQUE DÉMARRAGE, que `GET /` et `GET /acces` posent en cookie `HttpOnly; SameSite=Strict`
 * (aucun script ne le lit, aucun autre site ne le fait voyager) et que TOUTE route `/api/`
 * exige — par ce cookie ou par `Authorization: Bearer`. Un script qui n'est ni le navigateur de
 * l'utilisateur ni un lecteur du fichier (le CLI, un test) n'a ni l'un ni l'autre.
 *
 * Ce fichier ne connaît QUE ce jeton-là : `MERGERIE_ACCESS_TOKEN` (garde.js) reste le jeton
 * CHOISI pour l'exposition réseau, et les deux s'additionnent quand le poste est exposé. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./paths');
const garde = require('./garde');

const COOKIE = 'mergerie_local';
const FICHIER = path.join(DATA_DIR, 'local-token');

let actuel = '';

/** Nouveau jeton, écrit sur disque (0600). À appeler une fois par démarrage du serveur. */
function regenerer() {
  actuel = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(FICHIER, actuel, { mode: 0o600 });
  try { fs.chmodSync(FICHIER, 0o600); } catch { /* umask restrictif : déjà le bon mode */ }
  return actuel;
}

/** Le jeton du démarrage courant (mémoire, jamais relu sur disque : un seul processus l'écrit). */
const jeton = () => actuel;

/** La requête porte-t-elle le jeton courant, par cookie ou par `Authorization: Bearer` ? */
function valide(req) {
  return !!actuel && garde.memeJeton(garde.jetonPresente(req, COOKIE), actuel);
}

/** Pose le cookie du jeton local sur la réponse — `GET /`, `/index.html`, `/acces`. */
function poserCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(actuel)}; HttpOnly; SameSite=Strict; Path=/`);
}

module.exports = { COOKIE, FICHIER, regenerer, jeton, valide, poserCookie };
