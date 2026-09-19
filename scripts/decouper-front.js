#!/usr/bin/env node
'use strict';
/* DÉCOUPER UN FICHIER DU FRONT EN PLUSIEURS, SANS EN CHANGER UNE LIGNE — outil à usage unique de
   la réorganisation de `public/` par écran et par couche. `move-module.js` déplace un fichier et
   réécrit les `require` ; ici il n'y a pas de `require`, et on ne déplace pas un fichier, on en
   découpe un. L'outil prend une CARTE DE DÉCOUPAGE (un JSON) et :

     node scripts/decouper-front.js carte.json

     {
       "mode": "css" | "js",
       "source": "public/style.css",
       "balise": "<link rel=\"stylesheet\" href=\"/style.css\" />",   // la ligne du manifeste à remplacer
       "cibles": [ { "de": 1, "a": 127, "vers": "css/socle.css", "titre": "…", "expose": "a, b" }, … ]
     }

   1. écrit chaque fichier cible : les tranches [de, a] (lignes, 1-based, inclusives) de la source,
      OCTET POUR OCTET — en `js`, précédées de `'use strict';`, d'un commentaire d'une ligne (le
      rôle) et de `// @expose …` si le fichier offre quelque chose à d'autres dossiers ;
   2. remplace la balise de la source dans `index.html` par les balises des cibles, dans l'ordre
      de la carte (le manifeste — voir `scripts/check-front.js`) ;
   3. PROUVE que rien n'a été perdu ni dupliqué :
      — `css` : la concaténation des fichiers, dans l'ordre du manifeste, est la source, octet
        pour octet — la cascade ne peut pas avoir changé ;
      — `js` : chaque tranche est prise une fois et une seule et les tranches couvrent la source
        entière ; chaque définition de premier niveau de la source apparaît exactement une fois
        dans l'ensemble des cibles, avec le même corps ; et LA SUITE DES INSTRUCTIONS DE PREMIER
        NIVEAU QUI NE SONT PAS DES DÉCLARATIONS (écouteurs, `setInterval`, appels de câblage) est
        rendue telle quelle dans la concaténation — l'outil imprime celles dont l'ordre relatif a
        changé, pour relecture : une `function` peut changer de place (elle est hissée), un
        écouteur `keydown` de moins volontiers.
   L'outil refuse une carte dont une borne tombe au milieu d'un bloc (accolades non fermées), une
   tranche qui en recouvre une autre, ou une ligne de la source oubliée. Il ne supprime pas la
   source : c'est un `git rm` à part, relu dans son propre commit. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const carte = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const source = fs.readFileSync(path.join(ROOT, carte.source), 'utf8');
const lignes = source.split('\n');
const mode = carte.mode;
const echec = (m) => { console.error(`✗ ${m}`); process.exit(1); };

/* ---------- Mode i18n : le dictionnaire, une famille de préfixes par fichier ----------
   La carte donne `familles` (préfixe → fichier) et `ordre` (les fichiers, dans l'ordre du manifeste).
   Chaque ligne de clé du dictionnaire (`"task.x": …,`, fr puis en) part dans le fichier de sa
   famille, dans l'ordre du fichier d'origine, fr et en côte à côte ; un commentaire de section
   suit la clé qui le suit. `_socle.js` pose `I18N` vide dans le navigateur, `index.js` assemble
   pour Node. Preuve : le dictionnaire assemblé est identique à l'original, clé par clé. */
if (mode === 'i18n') {
  const { familles, ordre } = carte;
  const dictAvant = require(path.join(ROOT, carte.source));
  const fichiers = new Map(ordre.map((f) => [f, { fr: [], en: [] }]));
  const decoupe = (debut, fin, langue) => {
    let commentaire = [];
    for (let i = debut; i <= fin; i++) {
      const l = lignes[i - 1];
      const m = l.match(/^\s*"([^"]+)":/);
      if (!m) { if (l.trim()) commentaire.push(l); continue; }
      const fam = m[1].split('.')[0];
      const f = familles[fam];
      if (!f) echec(`famille inconnue « ${fam} » (clé ${m[1]}, ligne ${i})`);
      fichiers.get(f)[langue].push(...commentaire, l);
      commentaire = [];
    }
    if (commentaire.length) echec(`commentaire sans clé après lui, ligne ${fin}`);
  };
  const debutFr = lignes.findIndex((l) => /^\s*fr: \{$/.test(l)) + 1;
  const debutEn = lignes.findIndex((l) => /^\s*en: \{$/.test(l)) + 1;
  const finFr = lignes.findIndex((l, i) => i >= debutFr && /^\s*\},$/.test(l)) + 1;
  const finEn = lignes.findIndex((l, i) => i >= debutEn && /^\s*\},$/.test(l)) + 1;
  decoupe(debutFr + 1, finFr - 1, 'fr');
  decoupe(debutEn + 1, finEn - 1, 'en');
  const dir = path.join(PUBLIC, 'i18n');
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, d] of fichiers) {
    const fams = Object.entries(familles).filter(([, x]) => x === f).map(([k]) => k).join(' · ');
    const texte = [
      "'use strict';",
      `/* Dictionnaire de traduction — famille${fams.includes('·') ? 's' : ''} ${fams}. Le français est la langue de référence,`,
      "   l'anglais sa traduction, côte à côte dans ce fichier : une clé ajoutée se relit avec sa traduction",
      '   dans le même diff. Chargement UMD : require() côté Node (assemblé par i18n/index.js),',
      '   I18N.etendre() côté navigateur. Contrôle de cohérence : npm run i18n:check */',
      '(function (root, factory) {',
      '  const d = factory();',
      "  if (typeof module === 'object' && module.exports) module.exports = d;",
      '  else root.I18N.etendre(d);',
      "}(typeof self !== 'undefined' ? self : this, function () {",
      '  return {',
      '    fr: {',
      ...d.fr,
      '    },',
      '    en: {',
      ...d.en,
      '    },',
      '  };',
      '}));',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, f), texte);
  }
  fs.writeFileSync(path.join(dir, '_socle.js'), [
    "'use strict';",
    "/* Le dictionnaire du navigateur, VIDE au départ : chaque famille (i18n/*.js, dans l'ordre du",
    "   manifeste) s'y ajoute par `I18N.etendre({ fr, en })`. Côté Node, c'est `i18n/index.js` qui",
    '   assemble. `etendre` est non énumérable : `Object.keys(I18N)` reste la liste des langues. */',
    '(function (root) {',
    '  const I18N = { fr: {}, en: {} };',
    "  Object.defineProperty(I18N, 'etendre', {",
    '    value(d) { for (const l of Object.keys(d)) Object.assign(I18N[l] || (I18N[l] = {}), d[l]); },',
    '  });',
    '  root.I18N = I18N;',
    "}(typeof self !== 'undefined' ? self : this));",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "'use strict';",
    '/* Le dictionnaire assemblé pour Node — le pendant, côté serveur, de `_socle.js` suivi des balises',
    '   du manifeste. `FAMILLES` dit dans quel fichier vit chaque préfixe de clé (`task.*` → sessions.js) :',
    "   c'est le tableau que `npm run i18n:check` fait respecter ; `FICHIERS` est l'ordre de chargement.",
    '   Les deux sont non énumérables : `Object.keys(I18N)` reste la liste des langues. */',
    'const FAMILLES = {',
    ...Object.entries(familles).map(([k, v]) => `  ${k}: '${v}',`),
    '};',
    `const FICHIERS = [${ordre.map((f) => `'${f}'`).join(', ')}];`,
    'const I18N = { fr: {}, en: {} };',
    'for (const f of FICHIERS) {',
    '  const d = require(`./${f}`);',
    '  for (const l of Object.keys(d)) Object.assign(I18N[l] || (I18N[l] = {}), d[l]);',
    '}',
    "Object.defineProperty(I18N, 'FAMILLES', { value: FAMILLES });",
    "Object.defineProperty(I18N, 'FICHIERS', { value: FICHIERS });",
    'module.exports = I18N;',
    '',
  ].join('\n'));
  // Le manifeste
  const index = path.join(PUBLIC, 'index.html');
  let html = fs.readFileSync(index, 'utf8');
  if (!html.includes(carte.balise)) echec(`index.html ne contient pas « ${carte.balise} »`);
  html = html.replace(carte.balise, ['_socle.js', ...ordre].map((f) => `<script src="/i18n/${f}"></script>`).join('\n'));
  fs.writeFileSync(index, html);
  // La preuve
  const dictApres = require(path.join(dir, 'index.js'));
  const soucis = [];
  for (const l of ['fr', 'en']) {
    const a = Object.keys(dictAvant[l]); const b = Object.keys(dictApres[l]);
    if (a.length !== b.length) soucis.push(`${l} : ${a.length} clés avant, ${b.length} après`);
    for (const k of a) if (JSON.stringify(dictAvant[l][k]) !== JSON.stringify(dictApres[l][k])) soucis.push(`${l} : ${k} diffère`);
  }
  if (soucis.length) { soucis.forEach((s) => console.error(`✗ ${s}`)); process.exit(1); }
  console.log(`✓ ${ordre.length} familles + _socle.js + index.js écrits, ${Object.keys(dictApres.fr).length} clés × 2 identiques à l'original, manifeste mis à jour`);
  process.exit(0);
}

/* ---------- La carte : des tranches ordonnées, jointives, qui couvrent tout ---------- */
const cibles = carte.cibles.map((c) => ({ ...c, tranches: (c.tranches || [[c.de, c.a]]) }));
const prises = new Array(lignes.length + 1).fill(null);
for (const c of cibles) {
  for (const [de, a] of c.tranches) {
    if (!(de >= 1 && a >= de && a <= lignes.length)) echec(`${c.vers} : tranche ${de}-${a} hors de la source (${lignes.length} lignes)`);
    for (let i = de; i <= a; i++) {
      if (prises[i]) echec(`ligne ${i} prise deux fois : ${prises[i]} et ${c.vers}`);
      prises[i] = c.vers;
    }
  }
}
const oubliees = [];
// Le `'use strict';` de la source n'est pris par personne : chaque cible reçoit le sien.
for (let i = 1; i <= lignes.length; i++) if (!prises[i] && lignes[i - 1].trim() !== '' && lignes[i - 1].trim() !== "'use strict';") oubliees.push(i);
if (oubliees.length) echec(`${oubliees.length} ligne(s) non vides de la source ne sont dans aucune tranche : ${oubliees.slice(0, 10).join(', ')}…`);

/* Une borne tombe entre deux blocs : la profondeur d'accolades y est nulle. Les commentaires et
   les chaînes sont retirés avant de compter — un commentaire cite volontiers `.x { … }`. */
const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const depouille = (mode === 'css' ? sansCommentaires(source) : sansCommentaires(source)
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
  .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')).split('\n');
const profondeurAvant = [0];
for (let i = 0; i < depouille.length; i++) {
  let d = profondeurAvant[i];
  for (const ch of depouille[i]) { if (ch === '{' || ch === '(' || ch === '[') d++; else if (ch === '}' || ch === ')' || ch === ']') d--; }
  profondeurAvant.push(d);
}
/* En CSS le compte d'accolades suffit ; en JavaScript, une expression régulière ou un gabarit
   imbriqué le trompent — là, c'est l'ANALYSE SYNTAXIQUE de chaque fichier écrit qui fait foi
   (plus bas) : une tranche coupée au milieu d'un bloc ne parse pas. */
if (mode === 'css') {
  for (const c of cibles) {
    for (const [de, a] of c.tranches) {
      if (profondeurAvant[de - 1] !== 0) echec(`${c.vers} : la tranche commence ligne ${de} au milieu d'un bloc (profondeur ${profondeurAvant[de - 1]})`);
      if (profondeurAvant[a] !== 0) echec(`${c.vers} : la tranche finit ligne ${a} au milieu d'un bloc (profondeur ${profondeurAvant[a]})`);
    }
  }
}

/* ---------- Écrire les cibles ---------- */
const texteDe = (c) => c.tranches.map(([de, a]) => lignes.slice(de - 1, a).join('\n')).join('\n');
const entete = (c) => {
  if (mode !== 'js') return '';
  const l = ["'use strict';", `/* ${c.titre} */`];
  if (c.expose) l.push(`// @expose ${c.expose}`);
  return l.join('\n') + '\n';
};
for (const c of cibles) {
  const chemin = path.join(PUBLIC, c.vers);
  if (fs.existsSync(chemin) && !carte.ecraser) echec(`${c.vers} existe déjà`);
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  /* `join('\n')` ne rend pas le saut de ligne qui suit la dernière ligne d'une tranche : on le
     remet — sauf pour la fin de la source, qui a le sien (ou n'en a pas). */
  const corps = c.tranches.map(([de, a]) => lignes.slice(de - 1, a).join('\n') + (a === lignes.length ? '' : '\n')).join('');
  fs.writeFileSync(chemin, entete(c) + corps);
  if (mode === 'js') {
    try { new (require('vm').Script)(entete(c) + corps, { filename: c.vers }); } catch (e) { echec(`${c.vers} ne parse pas — une tranche coupe un bloc : ${e.message}`); }
  }
}

/* ---------- Le manifeste ---------- */
const index = path.join(PUBLIC, 'index.html');
let html = fs.readFileSync(index, 'utf8');
if (!html.includes(carte.balise)) echec(`index.html ne contient pas la balise « ${carte.balise} »`);
const indent = (html.match(new RegExp(`^([ \\t]*)${carte.balise.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`, 'm')) || ['', ''])[1];
const balise = (c) => (c.vers.endsWith('.css') ? `<link rel="stylesheet" href="/${c.vers}" />` : `<script src="/${c.vers}"></script>`);
html = html.replace(carte.balise, cibles.map((c, i) => (i ? indent : '') + balise(c)).join('\n'));
fs.writeFileSync(index, html);

/* ---------- La preuve ---------- */
if (mode === 'css') {
  const concat = cibles.map((c) => fs.readFileSync(path.join(PUBLIC, c.vers), 'utf8')).join('');
  if (concat !== source) echec('la concaténation des feuilles n\'est pas la source octet pour octet');
  console.log(`✓ ${cibles.length} feuilles écrites, concaténation identique à ${carte.source} (${source.length} octets), manifeste mis à jour`);
} else {
  const DECL = /^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/;
  /* Les instructions de premier niveau : une ligne qui commence en colonne 0 par autre chose
     qu'une déclaration, un commentaire ou une accolade fermante — à profondeur nulle. */
  /* Une instruction de premier niveau commence en colonne 0 — le code est indenté partout
     ailleurs — par autre chose qu'une déclaration, un commentaire ou une accolade fermante. */
  const instructions = (texte) => texte.split('\n')
    .filter((l) => /^[A-Za-z_$(]/.test(l) && !DECL.test(l))
    .map((l) => l.replace(/\s+/g, ' ').trim());
  const declsDe = (texte) => {
    const m = new Map();
    texte.split('\n').forEach((l, i) => { const d = l.match(DECL); if (d) m.set(d[1] || d[2], (m.get(d[1] || d[2]) || 0) + 1); });
    return m;
  };
  const avant = declsDe(source);
  const concat = cibles.map((c) => texteDe(c)).join('\n');
  const apres = declsDe(concat);
  const soucis = [];
  for (const [n, k] of avant) if (apres.get(n) !== k) soucis.push(`déclaration ${n} : ${k} fois dans la source, ${apres.get(n) || 0} après`);
  for (const [n, k] of apres) if (!avant.has(n)) soucis.push(`déclaration ${n} apparue (${k})`);
  if (soucis.length) { soucis.forEach((s) => console.error(`✗ ${s}`)); process.exit(1); }
  const iAvant = instructions(source);
  const iApres = instructions(concat);
  if (iAvant.length !== iApres.length || [...iAvant].sort().join('\n') !== [...iApres].sort().join('\n')) {
    echec(`les instructions de premier niveau ne sont pas les mêmes (${iAvant.length} avant, ${iApres.length} après)`);
  }
  /* L'ordre relatif : chaque instruction est numérotée dans la source ; on liste les couples qui
     se sont inversés, groupés par événement pour que la relecture porte sur ce qui compte. */
  const rang = new Map();
  iAvant.forEach((s, i) => { if (!rang.has(s)) rang.set(s, []); rang.get(s).push(i); });
  const ordreApres = iApres.map((s) => rang.get(s).shift());
  let inversions = 0;
  const parEvenement = new Map();
  for (let i = 0; i < ordreApres.length; i++) {
    for (let j = i + 1; j < ordreApres.length; j++) {
      if (ordreApres[i] > ordreApres[j]) {
        inversions++;
        const a = iAvant[ordreApres[j]]; const b = iAvant[ordreApres[i]];
        const ev = (a.match(/addEventListener\('(\w+)'/) || [])[1];
        const ev2 = (b.match(/addEventListener\('(\w+)'/) || [])[1];
        if (ev && ev === ev2 && /^(document|window)\./.test(a) && /^(document|window)\./.test(b)) {
          if (!parEvenement.has(ev)) parEvenement.set(ev, 0);
          parEvenement.set(ev, parEvenement.get(ev) + 1);
        }
      }
    }
  }
  console.log(`✓ ${cibles.length} fichiers écrits, ${avant.size} déclarations conservées, ${iAvant.length} instructions de premier niveau conservées`);
  if (inversions) {
    console.log(`  ${inversions} couple(s) d'instructions ont changé d'ordre relatif ; sur le même événement de document/window :`);
    for (const [ev, n] of parEvenement) console.log(`    ${ev} : ${n} couple(s)`);
    if (!parEvenement.size) console.log('    aucun');
  } else console.log('  ordre des instructions de premier niveau inchangé');
}
