'use strict';
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

module.exports = { globToRegex, splitPatterns, pathMatches, matchingPaths };
