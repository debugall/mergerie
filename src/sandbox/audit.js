'use strict';
/* AUDIT — un événement JSON par ligne, un fichier par job (`logs/audit.jsonl`). Jamais de prompt
 * ni de secret dedans : le DoD (§11 du plan) exige qu'aucun refus d'outil ou d'egress ne soit
 * journalisé AVEC une valeur sensible — plus sûr d'exclure tout champ dont le NOM y ressemble que
 * d'essayer de deviner quelles valeurs le sont.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHAMPS_SENSIBLES = /prompt|token|secret|password|cookie|authorization|credential/i;
const MAX_CHAMP = 500;

function assainir(details) {
  const out = {};
  for (const [k, v] of Object.entries(details || {})) {
    if (CHAMPS_SENSIBLES.test(k)) continue;
    out[k] = typeof v === 'string' && v.length > MAX_CHAMP ? `${v.slice(0, MAX_CHAMP)}…` : v;
  }
  return out;
}

/** Un journal pour CE job — chaque appel ajoute une ligne, jamais ne lève : un audit qui échoue
 *  ne doit jamais faire échouer le job qu'il observe. */
function pour(jobId, logsDir) {
  const fichier = path.join(logsDir, 'audit.jsonl');
  return (type, details) => {
    const ligne = JSON.stringify({ ts: new Date().toISOString(), jobId, type, ...assainir(details) });
    try { fs.appendFileSync(fichier, `${ligne}\n`, { mode: 0o600 }); } catch { /* voir ci-dessus */ }
  };
}

module.exports = { pour, assainir };
