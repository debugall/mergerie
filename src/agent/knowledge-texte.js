'use strict';
/* LE FICHIER D'UNE VERSION DE CONNAISSANCE, et ce qu'il coûte à lire. Séparé de `knowledge.js`
   parce que la fiche d'un agent (`profile/modele.js`) affiche ce coût, et que `knowledge.js`
   a besoin du profil : deux fonctions ici, et aucun cycle. */
const fs = require('node:fs');
const db = require('../db');
const copilot = require('./copilot');

function lireFichier(v) {
  if (!v || !v.md_path) return '';
  try { return fs.existsSync(v.md_path) ? fs.readFileSync(v.md_path, 'utf8') : ''; } catch { return ''; }
}

/* CE QUE CETTE VERSION COÛTE À LIRE. La carte d'un agent de domaine part dans le prompt de
   chacun de ses runs : sa taille est une dépense qui revient à chaque fois, et c'est le seul
   chiffre qui dise s'il faut l'élaguer. Compté à l'écriture ; les versions antérieures à la
   colonne sont comptées ICI, une fois, à leur première relecture — un `countTokens` par
   version et par affichage de liste ferait le travail vingt fois pour le même résultat. */
function tokensDe(ligne) {
  if (!ligne) return null;
  if (ligne.tokens != null) return ligne.tokens;
  const n = copilot.countTokens(lireFichier(ligne));
  try { db.prepare('UPDATE agent_knowledge SET tokens = ? WHERE id = ?').run(n, ligne.id); } catch { /* lecture seule : tant pis, on recomptera */ }
  return n;
}

module.exports = { lireFichier, tokensDe };
