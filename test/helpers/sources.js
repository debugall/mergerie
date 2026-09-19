'use strict';
/* LIRE LE TEXTE D'UN MODULE DE `src/` PAR SON NOM, où qu'il soit rangé. Quelques tests sont des
   gardes de SOURCE : ils relisent `taskrunner.js` ou `jobs.js` comme du texte pour prouver qu'une
   colonne n'y est pas lue. Écrire `src/taskrunner.js` en dur les casserait à chaque déplacement
   (refacto.md) ; ici, `lireSource('taskrunner')` trouve `src/session/taskrunner.js`, et
   `lireSource('jobs')` trouve `src/jobs.js` comme `src/jobs/index.js`. Deux fichiers du même nom
   dans deux dossiers seraient une ambiguïté : elle se signale, elle ne se devine pas. */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function tous(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tous(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function cheminSource(nom) {
  const base = nom.replace(/\.js$/, '');
  const candidats = tous(SRC).filter((p) => {
    const rel = path.relative(SRC, p);
    return rel === `${base}.js` || rel.endsWith(`/${base}.js`) || rel === `${base}/index.js`;
  });
  if (candidats.length !== 1) {
    throw new Error(`module « ${nom} » : ${candidats.length ? 'plusieurs fichiers' : 'aucun fichier'} sous src/ — ${candidats.join(', ')}`);
  }
  return candidats[0];
}

const lireSource = (nom) => fs.readFileSync(cheminSource(nom), 'utf8');

module.exports = { cheminSource, lireSource };
