#!/usr/bin/env node
'use strict';
/* Contrôle statique de la documentation — le guide existe en DEUX langues.
 *
 * Un guide traduit dérive silencieusement : on ajoute une section au guide français
 * en écrivant la fonctionnalité, et la version anglaise reste en arrière sans que
 * rien ne le signale. Six mois plus tard on ne sait plus ce qui manque, et le seul
 * moyen de le savoir est de relire onze cents lignes dans les deux langues.
 *
 * On ne compare pas le TEXTE — c'est une traduction, pas une copie. On compare la
 * STRUCTURE : même nombre de titres, mêmes niveaux, dans le même ordre. Une section
 * ajoutée d'un seul côté déplace tout ce qui suit et se voit immédiatement.
 *
 * On vérifie aussi les ANCRES des liens internes vers les guides : un
 * `#vérification-objective` qui ne correspond à aucun titre mène à un haut de page
 * silencieux — le lecteur croit avoir cliqué à côté.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GUIDES = ['docs/guide.fr.md', 'docs/guide.en.md'];

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};
const ok = (msg) => console.log(`✅ ${msg}`);

const lire = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Les titres, avec leur niveau et leur ligne. Les blocs de code sont ignorés :
   un `# commentaire` dans un exemple shell n'est pas un titre. */
function titres(texte) {
  const out = [];
  let dansCode = false;
  texte.split('\n').forEach((ligne, i) => {
    if (/^\s*```/.test(ligne)) { dansCode = !dansCode; return; }
    if (dansCode) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(ligne);
    if (m) out.push({ niveau: m[1].length, texte: m[2].trim(), ligne: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------- structure
const structures = GUIDES.map((g) => ({ g, t: titres(lire(g)) }));
const [fr, en] = structures;

if (fr.t.length !== en.t.length) {
  fail('Les deux guides n’ont pas le même nombre de titres — une section manque d’un côté', [
    `${fr.g} : ${fr.t.length} titres`,
    `${en.g} : ${en.t.length} titres`,
    ...ecarts(fr, en),
  ]);
} else {
  const divergences = [];
  fr.t.forEach((a, i) => {
    const b = en.t[i];
    if (a.niveau !== b.niveau) {
      divergences.push(`titre n°${i + 1} : niveau ${a.niveau} « ${a.texte} » (${fr.g}:${a.ligne}) `
        + `vs niveau ${b.niveau} « ${b.texte} » (${en.g}:${b.ligne})`);
    }
  });
  if (divergences.length) fail('Les niveaux de titres divergent entre les deux guides', divergences);
  else ok(`Guides FR/EN alignés : ${fr.t.length} titres, mêmes niveaux, même ordre`);
}

/* Quand les comptes diffèrent, dire OÙ ça décroche : la première paire de titres dont
   le niveau ne correspond plus. Annoncer « 36 contre 34 » sans le point de rupture
   oblige à comparer les deux listes à la main. */
function ecarts(a, b) {
  const n = Math.min(a.t.length, b.t.length);
  for (let i = 0; i < n; i += 1) {
    if (a.t[i].niveau !== b.t[i].niveau) {
      return [`divergence à partir du titre n°${i + 1} : « ${a.t[i].texte} » (${a.g}:${a.t[i].ligne})`
        + ` / « ${b.t[i].texte} » (${b.g}:${b.t[i].ligne})`];
    }
  }
  const trop = a.t.length > b.t.length ? a : b;
  return [`en trop dans ${trop.g} : « ${trop.t[n] ? trop.t[n].texte : '?'} »`];
}

// ------------------------------------------------------------------ ancres
/* GitHub fabrique l'ancre d'un titre en minusculant, en retirant la ponctuation et en
   remplaçant les espaces par des tirets. Les accents et les emojis sont conservés. */
const ancre = (titre) => titre
  .toLowerCase()
  .replace(/[`*_]/g, '')
  .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
  .trim()
  .replace(/\s+/g, '-');

const ancresDe = (rel) => new Set(titres(lire(rel)).map((t) => ancre(t.texte)));
const cache = new Map(GUIDES.map((g) => [g, ancresDe(g)]));

const SOURCES = ['README.md', 'README.fr.md', ...GUIDES];
const cassees = [];
for (const src of SOURCES) {
  const texte = lire(src);
  const depuis = path.dirname(src);
  for (const m of texte.matchAll(/\]\(([^)\s]*guide\.(?:fr|en)\.md)#([^)\s]+)\)/g)) {
    const cible = path.relative(ROOT, path.resolve(ROOT, depuis, m[1])).split(path.sep).join('/');
    const connues = cache.get(cible);
    if (!connues) { cassees.push(`${src} → ${m[1]} : fichier inconnu`); continue; }
    const a = decodeURIComponent(m[2]);
    if (!connues.has(a)) cassees.push(`${src} → ${cible}#${a} : aucun titre ne donne cette ancre`);
  }
}
if (cassees.length) fail('Ancres de liens vers un guide qui ne mènent nulle part', cassees);
else ok('Liens ancrés vers les guides : toutes les ancres existent');

if (failures) {
  console.log(`\n${failures} contrôle(s) en échec.`);
  process.exit(1);
}
console.log('\nDocumentation : rien à signaler.');
