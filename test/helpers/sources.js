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
  const rels = tous(SRC).map((p) => path.relative(SRC, p).split(path.sep).join('/'));
  // Un chemin sous src/ (`review/converge`) désigne le fichier sans chercher.
  if (base.includes('/')) {
    const exact = rels.find((rel) => rel === `${base}.js`) || rels.find((rel) => rel === `${base}/index.js`);
    if (exact) return path.join(SRC, exact);
  }
  /* À la racine d'abord (`jobs.js`, puis `jobs/index.js`) : un module qui porte le nom d'un
     dossier prime sur un homonyme rangé ailleurs (`app/routes/jobs.js` est la ROUTE de jobs). */
  const racine = rels.find((rel) => rel === `${base}.js`) || rels.find((rel) => rel === `${base}/index.js`);
  const candidats = (racine ? [racine] : rels.filter((rel) => rel.endsWith(`/${base}.js`))).map((rel) => path.join(SRC, rel));
  if (candidats.length !== 1) {
    throw new Error(`module « ${nom} » : ${candidats.length ? 'plusieurs fichiers' : 'aucun fichier'} sous src/ — ${candidats.join(', ')}`);
  }
  return candidats[0];
}

const lireSource = (nom) => fs.readFileSync(cheminSource(nom), 'utf8');

/* Tout un dossier de `src/` comme un seul texte, fichier après fichier, chacun précédé d'un
   repère `//// <chemin>` : un garde qui portait sur `jobs.js` porte désormais sur `jobs/`. */
function lireDossier(dossier) {
  const dir = path.join(SRC, dossier);
  return tous(dir).sort().map((p) => `//// ${path.relative(SRC, p)}\n${fs.readFileSync(p, 'utf8')}`).join('\n');
}

module.exports = { cheminSource, lireSource, lireDossier };
