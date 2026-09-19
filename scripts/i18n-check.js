#!/usr/bin/env node
'use strict';
/* Garde-fous i18n (i18n.md §7). Quatre contrôles, exécutés par `npm run i18n:check`.
   Ils sont posés AVANT le gros de la migration, pour la guider au lieu de la constater.

   1. Parité      — toute clé de `fr` existe en `en`, et réciproquement — FICHIER PAR FICHIER
                    dès que le dictionnaire est découpé par famille (`public/i18n/`).
   1 bis. Rangement — une clé vit dans le fichier de sa famille (`task.*` dans `sessions.js`),
                    et une famille inconnue ne passe pas.
   2. Clés mortes — toute clé appelée dans le code existe au dictionnaire.
   3. Oublis      — littérales accentuées restées en dur hors dictionnaire.

   Le contrôle 3 est celui qui compte sur la durée : c'est lui qui empêche le
   français en dur de revenir au fil des développements suivants. Il est donc
   volontairement bruyant, avec une liste d'exemptions explicite et commentée. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* Le dictionnaire : découpé par famille (`public/i18n/index.js` l'assemble pour Node), ou le
   fichier unique d'avant le découpage — le contrôle lit l'un comme l'autre. */
const DECOUPE = fs.existsSync(path.join(ROOT, 'public/i18n/index.js'));
const DICT = require(path.join(ROOT, DECOUPE ? 'public/i18n/index.js' : 'public/i18n.js'));
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
const langs = Object.keys(DICT).filter((l) => typeof DICT[l] === 'object');
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

/* ---------- 1 bis. Une clé vit dans le fichier de sa famille ----------
   Le dictionnaire est découpé par famille de préfixe (`task.*` dans `sessions.js`, `err.*` dans
   `erreurs.js`) : deux fonctionnalités qui ajoutent un libellé n'écrivent plus au même endroit,
   à condition que chacune écrive AU BON. Le tableau famille → fichier vit dans
   `public/i18n/index.js` ; une clé rangée ailleurs, ou d'une famille que le tableau ne connaît
   pas, est une erreur — avant le découpage, n'importe quel préfixe passait. La parité se
   vérifie aussi par fichier : le message nomme alors le fichier où la traduction manque. */
if (DECOUPE) {
  const { FAMILLES, FICHIERS } = require(path.join(ROOT, 'public/i18n/index.js'));
  const soucis = [];
  let total = 0;
  for (const fichier of FICHIERS) {
    const d = require(path.join(ROOT, 'public/i18n', fichier));
    for (const l of ['fr', 'en']) {
      for (const k of Object.keys(d[l] || {})) {
        const famille = k.split('.')[0];
        const attendu = FAMILLES[famille];
        if (!attendu) soucis.push(`public/i18n/${fichier}  ${k} — famille « ${famille} » inconnue du tableau d'i18n/index.js`);
        else if (attendu !== fichier) soucis.push(`public/i18n/${fichier}  ${k} — la famille « ${famille} » vit dans ${attendu}`);
      }
    }
    const fr = new Set(Object.keys(d.fr || {}));
    const en = new Set(Object.keys(d.en || {}));
    for (const k of fr) if (!en.has(k)) soucis.push(`public/i18n/${fichier}  ${k} — traduit en fr, pas en en`);
    for (const k of en) if (!fr.has(k)) soucis.push(`public/i18n/${fichier}  ${k} — en en sans son fr`);
    total += fr.size;
  }
  soucis.length
    ? fail('Rangement des clés par famille, et parité par fichier', soucis)
    : ok(`Chaque clé vit dans le fichier de sa famille, fr et en côte à côte (${FICHIERS.length} fichiers, ${total} clés × 2)`);
}

/* ---------- 2. Clés utilisées mais absentes ---------- */
/* Tout le front, pas seulement `app.js` : la dictée vit dans ses propres fichiers et appelle
   `t()` comme les autres. Restreint à `app.js`, ce contrôle ne voyait pas une clé manquante
   appelée depuis un de ces fichiers — c'est-à-dire un libellé qui s'afficherait sous forme de
   clé à l'écran. `public/` se parcourt RÉCURSIVEMENT (`js/ecrans/…`, `html/…`), hors `vendor/`
   et `images/` : un `tr('…')` dans un sous-dossier compterait sinon pour orphelin. */
/* `src/` se parcourt RÉCURSIVEMENT : un module déplacé dans un sous-dossier (réorganisation de src/ par couches)
   appelle `t()` comme avant, et une clé qu'il serait seul à utiliser ne doit pas passer
   pour orpheline — ni une clé qu'il appelle sans qu'elle existe passer inaperçue. */
function tousLes(dir, exts, out = [], exclure = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclure.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLes(p, exts, out, exclure);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const SOURCES = [
  ...tousLes(path.join(ROOT, 'public'), ['.js', '.html'], [], ['vendor', 'images']).map(rel),
  ...tousLes(path.join(ROOT, 'src'), ['.js']).map(rel),
];
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
  /^public\/i18n(-runtime)?\.js$/,   // le dictionnaire lui-même, évidemment…
  /^public\/i18n\/.*\.js$/,          // …découpé par famille, et son assemblage
  /^public\/runtime\/i18n-runtime\.js$/,
  /^src\/db\.js$/,                   // schéma SQL + commentaires de migration
  /^src\/cli\.js$/,                  // outil de dev en ligne de commande, jamais affiché dans l'UI
  /^src\/agentdefaults\.js$/,       // dictionnaire BILINGUE des textes d'agents livrés (DEFAULTS.fr /
  //                                    DEFAULTS.en) : c'est un i18n.js de plus, pas du français en dur.
  //                                    Ce sont des PROMPTS — ils ne s'affichent pas, ils partent à l'IA,
  //                                    et la langue choisie décide lequel des deux jeux est semé.
  /^public\/(runtime\/)?dictation-runtime\.js$/, // les FORMES PARLÉES des commandes vocales (« annule ça ») sont
  //                                    des données, pas des libellés : elles ne se traduisent pas,
  //                                    elles se reconnaissent, et chaque langue a les siennes.
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
