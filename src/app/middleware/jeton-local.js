'use strict';
/* L'API N'APPARTIENT QU'AU NAVIGATEUR DE L'UTILISATEUR (plan_secure.md, lot B, constat S1).
 * Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près.
 *
 * `origine.js` refuse un `Host` ou une `Origin` étrangers — ce qu'un NAVIGATEUR annonce. Un
 * processus du poste (un agent en écriture via Bash, une commande de vérificateur, un script
 * `postinstall` d'une MR sous vérification) n'en annonce aucun, et passait. Ici, toute route
 * `/api/` exige en plus le jeton de session local (`core/jetonlocal.js`) — écrit sur disque au
 * démarrage, jamais transmis à un enfant (agent, git, vérificateur) — par cookie ou par
 * `Authorization: Bearer`. Monté APRÈS `origine.js` (ses gardes s'appliquent d'abord) et AVANT
 * les routes.
 *
 * SEULEMENT SUR LOOPBACK (`!EXPOSE`) : exposé au réseau, `origine.js` exige déjà
 * `MERGERIE_ACCESS_TOKEN` sur CHAQUE route `/api/`, ce qui ferme identiquement le processus sans
 * navigateur — un `Authorization: Bearer` ne porte qu'UNE valeur, en exiger une seconde n'aurait
 * fermé qu'un script qui connaît déjà le jeton d'accès (lui-même hors de portée d'un agent, dans
 * `interditsDonnees()`) pour un vrai coût : un appel exposé légitime à deux jetons. */
const { app } = require('../app');
const i18n = require('../../core/i18n');
const garde = require('../../core/garde');
const jetonlocal = require('../../core/jetonlocal');
const { EXPOSE } = require('./origine');

jetonlocal.regenerer();

/* Ces trois chemins sont ce que `GET` sert sans le jeton (la page elle-même, et la page
   d'accès de l'exposition réseau) : c'est ce qui le distribue au navigateur, il doit donc
   rester joignable sans lui. */
const PAGES = new Set(['/', '/index.html', '/acces']);
app.use((req, res, next) => {
  if (req.method === 'GET' && PAGES.has(req.path)) jetonlocal.poserCookie(res);
  next();
});

/* SEULEMENT SUR LOOPBACK (`!EXPOSE`) : voir la note en tête de fichier. `garde.estApi` compare en
   minuscules : Express route sans tenir compte de la casse, un `req.path.startsWith('/api/')`
   sensible à la casse laissait passer `GET /API/config` — même processus sans navigateur, même
   route atteinte, jeton jamais demandé (revue de add-secure-layer-2). */
app.use((req, res, next) => {
  if (EXPOSE || !garde.estApi(req) || jetonlocal.valide(req)) return next();
  /* `code: 'JETON_LOCAL'` (revue de add-secure-layer-2) : le jeton est RÉGÉNÉRÉ à chaque
     démarrage du serveur (voir jetonlocal.js) — un onglet déjà chargé avant un redémarrage
     porte l'ANCIEN cookie et resterait bloqué en 401 jusqu'à un rechargement manuel. Le code
     laisse le front distinguer ce cas précis (recharger la page) d'un vrai refus. */
  res.status(401).json({ error: i18n.t('err.jeton-local-requis'), code: 'JETON_LOCAL' });
});

module.exports = { jetonlocal };
