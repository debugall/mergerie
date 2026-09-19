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
for (let i = 1; i <= lignes.length; i++) if (!prises[i] && lignes[i - 1].trim() !== '') oubliees.push(i);
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
for (const c of cibles) {
  for (const [de, a] of c.tranches) {
    if (profondeurAvant[de - 1] !== 0) echec(`${c.vers} : la tranche commence ligne ${de} au milieu d'un bloc (profondeur ${profondeurAvant[de - 1]})`);
    if (profondeurAvant[a] !== 0) echec(`${c.vers} : la tranche finit ligne ${a} au milieu d'un bloc (profondeur ${profondeurAvant[a]})`);
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
  const instructions = (texte, dep) => {
    const out = [];
    const ls = texte.split('\n');
    const prof = [0];
    for (let i = 0; i < dep.length; i++) {
      let d = prof[i];
      for (const ch of dep[i]) { if (ch === '{' || ch === '(' || ch === '[') d++; else if (ch === '}' || ch === ')' || ch === ']') d--; }
      prof.push(d);
    }
    ls.forEach((l, i) => {
      if (prof[i] !== 0 || !/^[A-Za-z_$(]/.test(l) || DECL.test(l)) return;
      out.push(l.replace(/\s+/g, ' ').trim());
    });
    return out;
  };
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
  const iAvant = instructions(source, depouille);
  const depConcat = cibles.map((c) => c.tranches.map(([de, a]) => depouille.slice(de - 1, a).join('\n')).join('\n')).join('\n').split('\n');
  const iApres = instructions(concat, depConcat);
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
