'use strict';
// @ts-check
/* Matching glob minimal pour les regles de review par chemin de fichier.
   Zero dependance (coherent avec le projet). Semantique proche de gitignore :

   - etoile simple : n'importe quoi SAUF slash        (ex. *.sql)
   - etoile double : n'importe quoi, slash compris    (ex. dossiers/migrations)
   - un motif SANS slash matche a N'IMPORTE quel niveau (le nom de fichier),
     pour que *.sql attrape db/migrate/001.sql et pas seulement 001.sql.

   Un meme champ peut porter PLUSIEURS motifs separes par virgule/espace/retour :
   la regle matche si l'UN d'eux matche. */

function globToRegex(glob) {
  const g = String(glob).trim();
  // Scanner caractere par caractere : pas de sentinelle, on distingue *, ** et **/.
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // **/ : dossiers optionnels
        else { re += '.*'; i += 1; }                        // **  : tout, slash compris
      } else { re += '[^/]*'; }                             // *   : tout sauf slash
    } else if (ch === '?') { re += '[^/]'; }                // ?   : un caractere sauf slash
    else if ('.+^${}()|[]\\'.includes(ch)) { re += `\\${ch}`; } // metacaractere regex
    else { re += ch; }
  }
  // Motif sans separateur -> il matche a n'importe quel niveau (le basename).
  if (!g.includes('/')) re = `(?:.*/)?${re}`;
  return new RegExp(`^${re}$`);
}

function splitPatterns(field) {
  return String(field || '').split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
}

// Vrai si `path` matche au moins un des motifs de `field`.
function pathMatches(field, path) {
  const p = String(path || '').replace(/^\.?\//, '');
  return splitPatterns(field).some((pat) => {
    try { return globToRegex(pat).test(p); } catch { return false; }
  });
}

// Sous-ensemble des chemins qui matchent le champ.
function matchingPaths(field, paths) {
  const res = splitPatterns(field)
    .map((pat) => { try { return globToRegex(pat); } catch { return null; } })
    .filter(Boolean);
  return (paths || []).filter((path) => {
    const p = String(path || '').replace(/^\.?\//, '');
    return res.some((re) => re.test(p));
  });
}

/* UNE LISTE DE MOTIFS, UN PAR LIGNE, validée À L'ENREGISTREMENT avec sa ligne — pas découverte à
   l'affichage (les tests touchés : `config.test_patterns`, `repo_group.*`, `repo.*`). Refusé : une
   ligne qui contient un espace (deux motifs collés), une accolade ou un crochet (lus ici comme des
   caractères, pas comme des alternatives), une négation, et plus de `max` lignes — au-delà, c'est
   une configuration à ranger dans un groupe. Rend le texte normalisé (une ligne par motif). */
const MAX_MOTIFS = 100;
function normaliserMotifs(texte, { max = MAX_MOTIFS } = {}) {
  const { t } = require('./i18n');
  const brutes = String(texte || '').split('\n');
  const out = [];
  for (let i = 0; i < brutes.length; i += 1) {
    const l = brutes[i].trim();
    if (!l) continue;
    if (/\s/.test(l) || /[{}[\]]/.test(l) || l.startsWith('!')) throw new Error(t('err.patterns.invalid', { line: i + 1, pattern: l.slice(0, 60) }));
    try { globToRegex(l); } catch { throw new Error(t('err.patterns.invalid', { line: i + 1, pattern: l.slice(0, 60) })); }
    out.push(l);
  }
  if (out.length > max) throw new Error(t('err.patterns.too-many', { max, n: out.length }));
  return out.join('\n');
}

module.exports = { globToRegex, splitPatterns, pathMatches, matchingPaths, normaliserMotifs, MAX_MOTIFS };
