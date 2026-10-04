'use strict';
/* Le Makefile d'un dossier : ses cibles, avec leur description quand elle suit la convention `cible: ## description`. Lu SUR LE DISQUE, rien n'est
   exécuté — c'est ce qui nourrit les suggestions de commandes d'un vérificateur (`app/routes/verifications.js`). (Le plugin Docker en a sa propre copie
   pour les cibles qu'il lance : un plugin n'importe rien de `src/`.) */
const fs = require('node:fs');
const path = require('node:path');

const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile'];

function makefileIn(dir) {
  for (const n of MAKEFILE_NAMES) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* absent */ }
  }
  return null;
}

/* Extrait les CIBLES (commandes) d'un Makefile, avec leur description quand elle suit la
   convention répandue `cible: ## description` (ou une ligne `## description` juste avant).
   On ignore les affectations de variables (`VAR :=`), les règles-motif (`%.o:`), `.PHONY`… */
function parseMakefileTargets(content) {
  const targets = []; const seen = new Set();
  let pendingDesc = ''; let current = null;
  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    // Recette : lignes indentées par TABULATION sous la cible → son « contenu ».
    if (current && /^\t/.test(line)) { current.recipe.push(line.replace(/^\t/, '')); continue; }
    const dc = line.match(/^\s*##\s?(.*)$/); // ligne de description autonome
    if (dc) { pendingDesc = dc[1].trim(); current = null; continue; }
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s*:(?!=)/); // cible: (mais pas VAR:=)
    if (m) {
      const name = m[1];
      if (name !== '.PHONY') {
        if (!seen.has(name)) {
          const inline = line.match(/##\s?(.*)$/);
          const desc = inline ? inline[1].trim() : pendingDesc;
          const t = { name, desc, recipe: /** @type {any} */ ([]) };
          seen.add(name); targets.push(t); current = t;
        } else { current = targets.find((x) => x.name === name) || null; }
      } else { current = null; }
      pendingDesc = '';
      continue;
    }
    if (line.trim() && !/^\s*#/.test(line)) current = null; // ligne « normale » → fin de recette
    pendingDesc = '';
  }
  for (const t of targets) t.recipe = t.recipe.join('\n'); // recette en texte
  return targets;
}

function makefileFor(dir) {
  const p = makefileIn(dir);
  if (!p) return null;
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { return null; }
  return { path: p, file: path.basename(p), targets: parseMakefileTargets(content) };
}

module.exports = { makefileFor, parseMakefileTargets };
