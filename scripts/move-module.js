#!/usr/bin/env node
'use strict';
/* DÉPLACER UN MODULE SANS RIEN CASSER — le seul outil autorisé pour bouger un fichier de `src/`.

     node scripts/move-module.js src/gitlab.js src/forge/gitlab.js [src/a.js src/x/a.js …]

   Ce qu'il fait, et rien de plus :
   1. `git mv` de chaque ancien chemin vers le nouveau — l'historique suit (`git log --follow`).
   2. Dans TOUS les `.js` de `src/`, `test/`, `scripts/` et `bin/`, réécrit chaque `require('…')`
      relatif qui atteignait un fichier déplacé, recalculé depuis le fichier qui importe.
   3. Dans chaque fichier déplacé, recalcule ses propres `require` relatifs : un fichier qui
      descend d'un niveau voit `./db` devenir `../db`, `../public/x.js` devenir `../../public/x.js`.
   4. Refuse de tourner si l'arbre git n'est pas propre : un déplacement se relit seul, dans son
      propre commit, sans autre changement mêlé.

   Ce qu'il ne fait PAS, à relire à la main après chaque déplacement :
   - un chemin construit avec `__dirname` (`src/paths.js` calcule la racine du projet ainsi) ;
   - la documentation (`PLAN.md`, `CLAUDE.md`, les guides) et les commentaires qui citent un
     chemin en toutes lettres — `grep -rn 'src/ancien.js'` les trouve.

   Plusieurs déplacements dans un même appel se calculent ENSEMBLE : un fichier déplacé qui en
   importe un autre déplacé reçoit le bon chemin. Un `require` qui visait un dossier par son
   `index.js` (ou qui le vise après déplacement : `db.js` → `db/index.js`) reste écrit comme un
   dossier — `require('../src/db')` ne change pas quand `db.js` devient `db/index.js`. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DOSSIERS = ['src', 'test', 'scripts', 'bin'];

const args = process.argv.slice(2);
if (!args.length || args.length % 2) {
  console.error('usage : node scripts/move-module.js <ancien> <nouveau> [<ancien> <nouveau> …]');
  process.exit(2);
}

const propre = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (propre) {
  console.error('L’arbre git n’est pas propre — un déplacement se fait seul, dans son propre commit :\n' + propre);
  process.exit(2);
}

/* La table des déplacements, en chemins absolus. */
const deplacements = new Map();
for (let i = 0; i < args.length; i += 2) {
  const de = path.resolve(ROOT, args[i]);
  const vers = path.resolve(ROOT, args[i + 1]);
  if (!fs.existsSync(de)) { console.error(`${args[i]} : n’existe pas`); process.exit(2); }
  if (fs.existsSync(vers)) { console.error(`${args[i + 1]} : existe déjà`); process.exit(2); }
  if (!de.endsWith('.js') || !vers.endsWith('.js')) { console.error('seuls des fichiers .js se déplacent'); process.exit(2); }
  deplacements.set(de, vers);
}

function tousLesJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLesJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* Résout un `require` relatif comme Node : le chemin tel quel, puis `.js`, puis `/index.js`.
   Rend { fichier, dossier } — `dossier` vrai quand le require visait un dossier par son index. */
function resoudre(depuisDir, rel) {
  const base = path.resolve(depuisDir, rel);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return { fichier: base, dossier: false };
  if (fs.existsSync(base + '.js')) return { fichier: base + '.js', dossier: false };
  const idx = path.join(base, 'index.js');
  if (fs.existsSync(idx)) return { fichier: idx, dossier: true };
  return null;
}

/* Écrit un chemin relatif comme on l'écrit dans un `require` : préfixé `./`, séparateurs `/`,
   sans `.js` sauf si l'original en avait un, et un `index.js` visé comme son dossier. */
function ecrire(depuisDir, cible, avecExtension) {
  let vers = cible;
  if (path.basename(cible) === 'index.js') vers = path.dirname(cible);
  else if (!avecExtension) vers = cible.replace(/\.js$/, '');
  let rel = path.relative(depuisDir, vers).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/* `require('…')` et `require.resolve('…')` — un test qui vide le cache d'un module le nomme ainsi. */
const RE = /(require(?:\.resolve)?)\((['"])(\.{1,2}\/[^'"]+)\2\)/g;
const fichiers = DOSSIERS.flatMap((d) => tousLesJs(path.join(ROOT, d)));
const reecrits = [];
const ambigus = [];

for (const f of fichiers) {
  const ancienDir = path.dirname(f);
  const nouveauDir = path.dirname(deplacements.get(f) || f);
  const texte = fs.readFileSync(f, 'utf8');
  let n = 0;
  const apres = texte.replace(RE, (tout, fn, q, rel) => {
    const r = resoudre(ancienDir, rel);
    if (!r) return tout;                              // pas un module du dépôt (ou déjà cassé) : on ne touche pas
    const cible = deplacements.get(r.fichier) || r.fichier;
    if (cible === r.fichier && ancienDir === nouveauDir) return tout;
    const neuf = ecrire(nouveauDir, cible, /\.js$/.test(rel) && path.basename(cible) !== 'index.js');
    if (neuf === rel) return tout;
    n++;
    return `${fn}(${q}${neuf}${q})`;
  });
  /* Un `require` non littéral (`require(variable)`, gabarit) échapperait au calcul : on le
     signale plutôt que de laisser un chemin périmé se découvrir à l'exécution. */
  for (const m of texte.matchAll(/require\((?!['"])[^)]*\)/g)) {
    if (/^require\(\s*['"]/.test(m[0])) continue;
    ambigus.push(`${path.relative(ROOT, f)}  ${m[0].slice(0, 60)}`);
  }
  if (n) { fs.writeFileSync(f, apres); reecrits.push(`${path.relative(ROOT, f)}  (${n})`); }
}

for (const [de, vers] of deplacements) {
  fs.mkdirSync(path.dirname(vers), { recursive: true });
  execFileSync('git', ['mv', de, vers], { cwd: ROOT });
  console.log(`déplacé   ${path.relative(ROOT, de)}  →  ${path.relative(ROOT, vers)}`);
}
if (reecrits.length) {
  console.log(`\nrequire réécrits dans ${reecrits.length} fichier(s) :`);
  reecrits.forEach((r) => console.log(`  ${r}`));
}
if (ambigus.length) {
  console.log('\n⚠ require non littéraux, à vérifier à la main :');
  ambigus.forEach((a) => console.log(`  ${a}`));
}
const dirname = [...deplacements.keys()].filter((de) => /__dirname/.test(fs.readFileSync(deplacements.get(de), 'utf8')));
if (dirname.length) {
  console.log('\n⚠ ces fichiers déplacés utilisent __dirname — leurs chemins se relisent à la main :');
  dirname.forEach((de) => console.log(`  ${path.relative(ROOT, deplacements.get(de))}`));
}
