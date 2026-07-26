#!/usr/bin/env node
'use strict';
/* Garde-fous i18n (i18n.md §7). Trois contrôles, exécutés par `npm run i18n:check`.
   Ils sont posés AVANT le gros de la migration, pour la guider au lieu de la constater.

   1. Parité      — toute clé de `fr` existe en `en`, et réciproquement.
   2. Clés mortes — toute clé appelée dans le code existe au dictionnaire.
   3. Oublis      — littérales accentuées restées en dur hors dictionnaire.

   Le contrôle 3 est celui qui compte sur la durée : c'est lui qui empêche le
   français en dur de revenir au fil des développements suivants. Il est donc
   volontairement bruyant, avec une liste d'exemptions explicite et commentée. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DICT = require(path.join(ROOT, 'public/i18n.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.slice(0, 40).forEach((i) => console.log(`   ${i}`));
  if (items.length > 40) console.log(`   … et ${items.length - 40} autres`);
};
const ok = (title) => console.log(`✅ ${title}`);

/* ---------- 1. Parité des dictionnaires ---------- */
const langs = Object.keys(DICT);
const keysOf = (l) => Object.keys(DICT[l]);
const base = new Set(keysOf('fr'));
const parity = [];
for (const l of langs.filter((x) => x !== 'fr')) {
  for (const k of base) if (!(k in DICT[l])) parity.push(`manque en ${l} : ${k}`);
  for (const k of keysOf(l)) if (!base.has(k)) parity.push(`en trop en ${l} (absent de fr) : ${k}`);
}
// Un pluriel doit avoir la même forme dans toutes les langues.
for (const k of base) {
  for (const l of langs) {
    const a = DICT.fr[k]; const b = DICT[l] && DICT[l][k];
    if (b == null) continue;
    if ((typeof a === 'object') !== (typeof b === 'object')) parity.push(`forme pluriel incohérente entre fr et ${l} : ${k}`);
  }
}
parity.length ? fail('Parité des dictionnaires', parity) : ok(`Parité des dictionnaires (${base.size} clés × ${langs.length} langues)`);

/* ---------- 2. Clés utilisées mais absentes ---------- */
const SOURCES = ['public/app.js', 'public/index.html', ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => `src/${f}`)]
  .filter((p) => /\.(js|html)$/.test(p));
const used = new Set();
// Les commentaires sont retirés AVANT extraction : un exemple de code cité dans un
// commentaire n'est pas un appel réel, et le compter produit un faux positif
// (rencontré pour de vrai avec `tr('git.state.' + state)` donné en contre-exemple).
const stripForKeys = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');
for (const p of SOURCES) {
  const c = stripForKeys(read(p));
  // tr('clé') / t('clé') côté code, data-i18n[-title|-placeholder|-tip|-aria|-html]="clé" côté HTML
  for (const m of c.matchAll(/\b(?:tr|t)\(\s*['"]([\w.-]+)['"]/g)) used.add(m[1]);
  for (const m of c.matchAll(/data-i18n(?:-\w+)?=["']([\w.-]+)["']/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !base.has(k)).sort();
missing.length ? fail('Clés utilisées mais absentes du dictionnaire', missing) : ok(`Clés utilisées toutes définies (${used.size} appels distincts)`);

// Informatif : clés définies jamais appelées. N'échoue pas — une clé peut être
// construite dynamiquement (err.${code}) — mais signale les oublis de nettoyage.
const unusedKeys = [...base].filter((k) => !used.has(k)).sort();
if (unusedKeys.length) console.log(`\nℹ️  ${unusedKeys.length} clés définies mais jamais appelées littéralement (peut être normal si construites dynamiquement)`);

/* ---------- 2 bis. Entités HTML dans des valeurs rendues en textContent ----------
   applyStaticI18n écrit du `textContent` pour data-i18n : une entité HTML y serait
   affichée LITTÉRALEMENT (« AI&nbsp;DEV » au lieu de « AI DEV »). Seul data-i18n-html,
   qui passe par innerHTML, peut en contenir. Ce contrôle est né d'un vrai bug. */
const htmlKeys = new Set();
for (const p of SOURCES) {
  for (const m of read(p).matchAll(/data-i18n-html=["']([\w.-]+)["']/g)) htmlKeys.add(m[1]);
}
const entities = [];
for (const l of langs) {
  for (const [k, v] of Object.entries(DICT[l])) {
    if (htmlKeys.has(k)) continue;                       // légitime en innerHTML
    const s = typeof v === 'object' ? `${v.one} ${v.other}` : String(v);
    if (/&[a-zA-Z]+;|&#\d+;/.test(s)) entities.push(`${l} :: ${k} → ${s.slice(0, 60)}`);
  }
}
entities.length
  ? fail('Entités HTML dans des valeurs rendues en texte (seraient affichées littéralement)', entities)
  : ok('Aucune entité HTML piégée dans une valeur texte');

/* ---------- 3. Chaînes françaises restées en dur ---------- */
// Heuristique : une littérale contenant une lettre accentuée hors commentaire.
// Les exemptions sont NOMMÉES : chacune doit se justifier, sinon on masque des bugs.
const EXEMPT = [
  /^public\/i18n(-runtime)?\.js$/,   // le dictionnaire lui-même, évidemment
  /^src\/db\.js$/,                   // schéma SQL + commentaires de migration
  /^src\/cli\.js$/,                  // outil de dev en ligne de commande, jamais affiché dans l'UI
];
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');
const ACCENT = /[àâäçéèêëîïôöùûüÀÂÄÇÉÈÊËÎÏÔÖÙÛÜœ]/;
const hard = [];
for (const p of SOURCES) {
  if (EXEMPT.some((re) => re.test(p))) continue;
  const c = stripComments(read(p));
  const lines = c.split('\n');
  lines.forEach((line, i) => {
    if (!ACCENT.test(line)) return;
    // Une ligne PORTEUSE d'un data-i18n garde légitimement son texte français :
    // c'est le contenu affiché avant que le JS ne traduise (pas de flash de clés).
    if (/data-i18n/.test(line)) return;
    // Idem pour un appel tr()/t() : le français restant hors de l'appel est du code.
    if (/\b(?:tr|t)\(/.test(line) && !ACCENT.test(line.replace(/\b(?:tr|t)\('[^']*'[^)]*\)/g, ''))) return;
    hard.push(`${p}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}
if (process.env.I18N_STRICT === '1') {
  hard.length ? fail('Chaînes françaises en dur (hors dictionnaire)', hard) : ok('Aucune chaîne française en dur');
} else {
  // Tant que la migration est en cours, ce contrôle informe sans faire échouer :
  // il deviendra bloquant (I18N_STRICT=1) une fois les lots 2 à 4 terminés.
  console.log(`\nℹ️  ${hard.length} lignes contiennent encore du français en dur — migration en cours.`);
  console.log('   Contrôle bloquant : I18N_STRICT=1 npm run i18n:check');
}

console.log('');
if (failures) { console.log(`${failures} contrôle(s) en échec.`); process.exit(1); }
console.log('Contrôles i18n : OK');
