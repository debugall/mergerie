'use strict';
/* LES CODES D'ERREUR DE LA SANDBOX, STABLES : l'API et l'UI les comparent par leur `code`, jamais
 * par le texte du message — un message se traduit et se reformule, un code ne bouge plus une fois
 * publié (§8.1 du plan). Chaque code porte une clé i18n dans `err.sandbox.*` (public/i18n/erreurs.js) ;
 * une clé absente du dictionnaire revient telle quelle (voir i18n-runtime.js), donc jamais une
 * exception qui masquerait le vrai refus.
 */
const { t } = require('../core/i18n');

const CODES = new Set([
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_UNSUPPORTED_PLATFORM',
  'SANDBOX_POLICY_INVALID',
  'SANDBOX_PATH_OUTSIDE_ROOT',
  'SANDBOX_SYMLINK_ESCAPE',
  'SANDBOX_CREDENTIALS_UNSUPPORTED',
  'SANDBOX_NETWORK_DENIED',
  'SANDBOX_COMMAND_DENIED',
  'SANDBOX_LIMIT_EXCEEDED',
  'SANDBOX_SOURCE_CHANGED',
  'SANDBOX_CLEANUP_FAILED',
  'LOCAL_IN_PLACE_UNSUPPORTED_IN_SANDBOX',
]);

const CLE = (code) => `err.sandbox.${code.toLowerCase().replace(/_/g, '-')}`;

/** Une erreur codée, traduite, avec ses paramètres attachés pour l'API (`wrap()` les republie). */
function erreurSandbox(code, params) {
  if (!CODES.has(code)) throw new Error(`code sandbox inconnu : ${code}`);
  const e = new Error(t(CLE(code), params || {}));
  e.code = code;
  if (params) e.extra = params;
  return e;
}

module.exports = { CODES, erreurSandbox };
