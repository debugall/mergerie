'use strict';
/* Blocs de protocole d'un run d'agent (spec agents §9.5).
 *
 * Trois blocs, un par besoin, sur le modèle éprouvé de `<<<FINDINGS>>>` (`resolution.js`) et
 * de `<<<QUESTIONS>>>` (`questions.js`) : l'agent rend du Markdown pour l'humain ET quelques
 * lignes délimitées pour la machine.
 *
 *   <<<REPO>>>   l'enquêteur nomme le dépôt trouvé → bouton « Corriger sur <dépôt> »
 *   <<<AGENT>>>  le cartographe décrit l'agent à créer → une ligne `agent` + son périmètre
 *   <<<STALE>>>  un agent de domaine signale ce qu'il a vu de faux dans sa connaissance
 *
 * RÈGLE : un bloc mal formé n'est JAMAIS une erreur de run. L'agent a travaillé, son rapport
 * est lisible ; c'est le protocole qui a raté, et le run vaut mieux que son protocole. On
 * l'ignore et on le journalise.
 */

// Un seul bloc par balise est pris : le premier. Un agent qui en émet deux a hésité, et
// deviner lequel compte reviendrait à choisir à sa place.
function bornes(text, nom) {
  const start = `<<<${nom}`;
  const end = `${nom}>>>`;
  const s = String(text || '');
  const i = s.indexOf(start);
  if (i === -1) return null;
  const j = s.indexOf(end, i + start.length);
  if (j === -1) return null;    // balise ouverte jamais refermée : bloc inexploitable
  return { i, j, fin: j + end.length, contenu: s.slice(i + start.length, j) };
}

/* Extrait le bloc et rend le RESTE — c'est ce reste qui s'affiche. Le bloc ne doit jamais
   apparaître à l'écran : c'est un canal de service, pas du contenu. */
function extraire(text, nom) {
  const s = String(text || '');
  const b = bornes(s, nom);
  if (!b) return { block: null, rest: s.trim() };
  return { block: b.contenu.trim(), rest: (s.slice(0, b.i) + s.slice(b.fin)).trim() };
}

// Retire TOUS les blocs connus d'un coup : ce que l'API rend et ce que l'écran affiche.
const NOMS = ['REPO', 'AGENT', 'STALE'];
function nettoyer(text) {
  let s = String(text || '');
  for (const n of NOMS) s = extraire(s, n).rest;
  return s;
}

/* Les lignes utiles d'un bloc : champs séparés par ` | `, trimés, lignes vides écartées.
   Une ligne de séparation Markdown (`---|---`) est écartée aussi : un agent qui a compris
   « tableau » plutôt que « bloc » en produit une, et elle n'est jamais une donnée. */
function lignes(block) {
  const out = [];
  for (const brut of String(block || '').split('\n')) {
    const l = brut.trim();
    if (!l) continue;
    const champs = l.split('|').map((x) => x.trim());
    if (champs.every((x) => !x || /^-+$/.test(x))) continue;
    out.push(champs);
  }
  return out;
}

module.exports = { extraire, lignes, nettoyer, NOMS };
