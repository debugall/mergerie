#!/usr/bin/env node
'use strict';
/* DÉPLACER UN FICHIER DU FRONT SANS RIEN CASSER — le pendant de `move-module.js` pour `public/`.

     node scripts/move-front.js public/js/ecrans/git/merge.js public/js/ecrans/git/fusion.js

   Sans build ni modules, il n'y a pas de `require` à réécrire dans `public/` : ce qui nomme un
   fichier du front, c'est LE MANIFESTE (les `<script src>` et `<link rel="stylesheet">`
   d'`index.html`), les marqueurs `<!--@include html/…-->` de la coquille, et — pour un module
   de `runtime/`, partagé avec Node — les `require` de `src/`, `test/` et `scripts/`. Ce script :
   1. `git mv` l'ancien chemin vers le nouveau — l'historique suit (`git log --follow`) ;
   2. réécrit la ligne du manifeste ou le marqueur qui le citait, à la même place : l'ordre des
      balises est l'ordre d'évaluation, un déplacement ne le change pas ;
   3. pour un fichier de `runtime/`, réécrit chaque `require` relatif qui l'atteignait, recalculé
      depuis le fichier qui importe ;
   4. pour un fichier de `i18n/`, réécrit son nom dans le tableau d'`i18n/index.js` ;
   5. refuse de tourner si l'arbre git n'est pas propre : un déplacement se relit seul.

   Ce qu'il ne fait PAS, à relire à la main :
   - `dictee-worklet.js` est chargé par une chaîne d'URL dans `dictee.js` (`audioWorklet.addModule`),
     le seul littéral de chemin du JavaScript — le script le signale ;
   - la documentation (`PLAN.md`, `CLAUDE.md`) et les commentaires qui citent un chemin en
     toutes lettres — `grep -rn 'ancien.js'` les trouve.
   `npm run check` (contrôle « le manifeste et le disque coïncident ») attrape ce qui aurait
   échappé. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = path.join(PUBLIC, 'index.html');

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('usage : node scripts/move-front.js <ancien> <nouveau>   (chemins depuis la racine, ou depuis public/)');
  process.exit(2);
}

const propre = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (propre) {
  console.error('L’arbre git n’est pas propre — un déplacement se fait seul, dans son propre commit :\n' + propre);
  process.exit(2);
}

/* Un chemin donné depuis la racine (`public/js/…`) ou depuis `public/` (`js/…`). */
const absolu = (p) => (p.startsWith('public/') || p.startsWith('public' + path.sep) ? path.resolve(ROOT, p) : path.resolve(PUBLIC, p));
const de = absolu(args[0]);
const vers = absolu(args[1]);
const relDe = path.relative(PUBLIC, de).split(path.sep).join('/');
const relVers = path.relative(PUBLIC, vers).split(path.sep).join('/');
if (!fs.existsSync(de)) { console.error(`${args[0]} : n’existe pas`); process.exit(2); }
if (fs.existsSync(vers)) { console.error(`${args[1]} : existe déjà`); process.exit(2); }
if (relDe.startsWith('..') || relVers.startsWith('..')) { console.error('un fichier du front reste sous public/'); process.exit(2); }
if (path.extname(de) !== path.extname(vers)) { console.error('un déplacement ne change pas l’extension'); process.exit(2); }

const reecrits = [];
const aRelire = [];

/* 1. git mv */
fs.mkdirSync(path.dirname(vers), { recursive: true });
execFileSync('git', ['mv', de, vers], { cwd: ROOT });
console.log(`déplacé   ${relDe}  →  ${relVers}`);

/* 2. Le manifeste et les marqueurs, à la même ligne. */
{
  const texte = fs.readFileSync(INDEX, 'utf8');
  const echap = relDe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const apres = texte
    .replace(new RegExp(`(src|href)="/${echap}"`, 'g'), `$1="/${relVers}"`)
    .replace(new RegExp(`<!--@include ${echap}-->`, 'g'), `<!--@include ${relVers}-->`);
  if (apres !== texte) { fs.writeFileSync(INDEX, apres); reecrits.push('public/index.html'); }
}

/* 3. Les `require` de Node, pour un module partagé (`runtime/`). */
function tousLesJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLesJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
if (relDe.startsWith('runtime/') || relVers.startsWith('runtime/')) {
  const RE = /(require(?:\.resolve)?)\((['"])(\.{1,2}\/[^'"]+)\2\)/g;
  for (const f of ['src', 'test', 'scripts', 'bin', 'public'].flatMap((d) => tousLesJs(path.join(ROOT, d)))) {
    const dir = path.dirname(f === de ? vers : f);
    const texte = fs.readFileSync(f, 'utf8');
    const apres = texte.replace(RE, (tout, fn, q, rel) => {
      const base = path.resolve(path.dirname(f), rel);
      const cible = [base, base + '.js'].find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || (base === de || base + '.js' === de ? de : null);
      if (cible !== de && cible !== vers) return tout;
      let neuf = path.relative(dir, vers).split(path.sep).join('/');
      if (!/\.js$/.test(rel)) neuf = neuf.replace(/\.js$/, '');
      if (!neuf.startsWith('.')) neuf = './' + neuf;
      return neuf === rel ? tout : `${fn}(${q}${neuf}${q})`;
    });
    if (apres !== texte) { fs.writeFileSync(f, apres); reecrits.push(path.relative(ROOT, f)); }
  }
}

/* 4. Le tableau des familles, pour un fichier du dictionnaire. */
if (relDe.startsWith('i18n/') && relVers.startsWith('i18n/')) {
  const idx = path.join(PUBLIC, 'i18n', 'index.js');
  const texte = fs.readFileSync(idx, 'utf8');
  const apres = texte.split(`'${path.basename(de)}'`).join(`'${path.basename(vers)}'`);
  if (apres !== texte) { fs.writeFileSync(idx, apres); reecrits.push('public/i18n/index.js'); }
}

/* Ce que le script ne sait pas suivre. */
if (path.basename(de) === 'dictee-worklet.js' || path.basename(de) === 'dictee.js') {
  aRelire.push('public/js/transverse/dictee.js  — l’URL du worklet (`audioWorklet.addModule`) est une chaîne');
}
for (const f of ['PLAN.md', 'CLAUDE.md', 'README.md'].filter((d) => fs.existsSync(path.join(ROOT, d)))) {
  if (fs.readFileSync(path.join(ROOT, f), 'utf8').includes(relDe)) aRelire.push(`${f}  — cite ${relDe} en toutes lettres`);
}

if (reecrits.length) console.log('réécrit :\n  ' + [...new Set(reecrits)].join('\n  '));
if (aRelire.length) console.log('à relire à la main :\n  ' + aRelire.join('\n  '));
console.log('puis : npm run check');
