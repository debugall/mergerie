#!/usr/bin/env node
'use strict';
/* Contrôles statiques des PLUGINS EMBARQUÉS (`plugins/*`) et du contrat de l'API — nés des
   règles de docs/plugins/, pas de suppositions.

   1. Chaque plugin embarqué a un manifeste valide, et ses fichiers `ui` existent.
   2. Aucun fichier d'un plugin n'importe `src/` ni un autre plugin (le garde dynamique le
      refuserait au chargement ; ici on le voit avant).
   3. Son SQL ne touche que ses tables `plugin_<nom>_*` (le même garde que `ctx.db`, relu sur
      chaque chaîne SQL du code).
   4. Ses routes sont relatives (le routeur refuse `/api/…`).
   5. Ses scripts front n'utilisent, du cœur, QUE le kit (`window.mergerie`) : un nom déclaré
      par le cœur et absent du kit est une dépendance cachée.
   6. Son dictionnaire est en parité fr/en, et toutes ses clés portent son préfixe.
   7. `docs/plugins/EVENTS.md` est bien ce que le contrat génère ; `docs/plugins/API.md` nomme
      chaque primitive du contrat ; les types du SDK sont à jour.
   8. Les exemples de la documentation (`docs/plugins/examples/*.js`) parsent. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifeste = require('../sdk/lib/manifeste');
const dbplugin = require('../sdk/lib/dbplugin');
const contrat = require('../sdk/contract');
const pageplugins = require('../src/plugins/pageplugins');
const { lirePublic, manifeste: manifesteFront, lireHtml } = require('../test/helpers/front');

let failures = 0;
const fail = (title, items) => { failures++; console.log(`\n❌ ${title} (${items.length})`); items.forEach((i) => console.log(`   ${i}`)); };
const ok = (t) => console.log(`✅ ${t}`);
const tous = (dir, ext, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tous(p, ext, out); else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};
const depouiller = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const plugins = pageplugins.embarques();

/* 1. Manifestes. */
{
  const soucis = plugins.filter((p) => !p.ok).flatMap((p) => p.erreurs.map((e) => `plugins/${path.basename(p.dir)}/plugin.json  ${e}`));
  for (const p of plugins) if (p.ok && p.manifeste.name !== path.basename(p.dir)) soucis.push(`plugins/${path.basename(p.dir)}  le dossier et « name » (${p.manifeste.name}) diffèrent`);
  for (const p of plugins) if (p.ok && p.manifeste.builtin !== true) soucis.push(`plugins/${path.basename(p.dir)}/plugin.json  un plugin embarqué déclare "builtin": true`);
  soucis.length ? fail('Manifestes des plugins embarqués', soucis) : ok(`Manifestes valides (${plugins.length} plugin${plugins.length > 1 ? 's' : ''} embarqué${plugins.length > 1 ? 's' : ''})`);
}

/* 2. Aucun import de src/ ni d'un autre plugin. */
{
  const soucis = [];
  for (const p of plugins) {
    /* Un script `bin/` tourne dans SON PROCESSUS (lancé par ctx.exec), hors de Mergerie : il peut avoir ses propres
       dépendances npm, À CONDITION que le plugin les déclare dans son `package.json` (`peerDependencies`). */
    let pairs = [];
    try { pairs = Object.keys(JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8')).peerDependencies || {}); } catch { /* pas de package.json */ }
    // Les tests d'un plugin (`test/`) importent le SDK et node:test : ce ne sont pas le plugin.
    for (const f of tous(p.dir, '.js').filter((x) => !x.includes(`${path.sep}test${path.sep}`))) {
      const rel = path.relative(ROOT, f);
      depouiller(fs.readFileSync(f, 'utf8')).split('\n').forEach((l, i) => {
        for (const m of l.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
          const cible = m[2];
          if (!cible.startsWith('.')) { if (f.startsWith(path.join(p.dir, 'bin') + path.sep) && pairs.includes(cible.split('/')[0])) continue; if (!['fs', 'path', 'node:fs', 'node:path', 'url', 'node:url', 'crypto', 'node:crypto', 'util', 'node:util', 'os', 'node:os', 'events', 'node:events', 'stream', 'node:stream'].includes(cible) && !cible.startsWith('@mergerie/')) soucis.push(`${rel}:${i + 1}  require('${cible}') — un plugin n'a pas de dépendance hors de Node, du SDK et de ses fichiers`); continue; }
          const abs = path.resolve(path.dirname(f), cible);
          if (abs.startsWith(path.join(ROOT, 'src') + path.sep)) soucis.push(`${rel}:${i + 1}  require('${cible}') mène dans src/ — un plugin passe par le ctx`);
          else if (!abs.startsWith(p.dir + path.sep) && !abs.startsWith(path.join(ROOT, 'sdk') + path.sep)) soucis.push(`${rel}:${i + 1}  require('${cible}') sort du plugin`);
        }
      });
    }
  }
  soucis.length ? fail('Imports des plugins (src/ et autres plugins interdits)', soucis) : ok('Aucun plugin n’importe src/ ni un autre plugin');
}

/* 3. Le SQL ne touche que les tables du plugin. */
{
  const soucis = [];
  for (const p of plugins) {
    if (!p.ok) continue;
    const prefixe = `plugin_${p.manifeste.name.replace(/-/g, '_')}_`;
    for (const f of tous(path.join(p.dir), '.js').filter((x) => !x.includes(`${path.sep}ui${path.sep}`) && !x.includes(`${path.sep}test${path.sep}`))) {   // `test/` : la base du test est celle du SDK, un test peut y simuler une base abîmée
      const texte = depouiller(fs.readFileSync(f, 'utf8'));
      for (const m of texte.matchAll(/(['"`])((?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|REPLACE|PRAGMA)\b[\s\S]*?)\1/gi)) {
        try { dbplugin.verifier(prefixe, m[2], dbplugin.prefixesPlusLongs(prefixe, plugins.map((q) => q.manifeste && q.manifeste.name).filter(Boolean))); } catch (e) { soucis.push(`${path.relative(ROOT, f)}  ${e.message} — « ${m[2].slice(0, 60).replace(/\s+/g, ' ')}… »`); }
      }
    }
  }
  soucis.length ? fail('SQL des plugins hors de leur préfixe', soucis) : ok('Chaque requête SQL d’un plugin reste sur ses tables');
}

/* 4. Routes relatives. */
{
  const soucis = [];
  for (const p of plugins) {
    for (const f of tous(p.dir, '.js')) {
      depouiller(fs.readFileSync(f, 'utf8')).split('\n').forEach((l, i) => {
        const m = l.match(/router\.(get|post|put|delete|patch)\(\s*(['"])([^'"]*)\2/);
        if (m && (!m[3].startsWith('/') || m[3].startsWith('/api/'))) soucis.push(`${path.relative(ROOT, f)}:${i + 1}  route « ${m[3]} » — relative, sous /api/plugins/${p.manifeste && p.manifeste.name}/`);
      });
    }
  }
  soucis.length ? fail('Routes de plugin hors préfixe', soucis) : ok('Les routes des plugins sont relatives à leur préfixe');
}

/* 5. Le front d'un plugin n'utilise que le kit. */
{
  const html = lireHtml();
  const man = manifesteFront(html);
  const DECL = /^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/;
  const declCoeur = new Map();
  for (const f of man.scripts.filter((s) => s.startsWith('js/'))) {
    for (const l of lirePublic(f).split('\n')) { const m = l.match(DECL); if (m && !declCoeur.has(m[1] || m[2])) declCoeur.set(m[1] || m[2], f); }
  }
  const kit = new Set(pageplugins.clesDuKit());
  const dep = (s) => depouiller(s).replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const soucis = [];
  for (const p of plugins) {
    if (!p.ok) continue;
    const scripts = (p.manifeste.ui && p.manifeste.ui.scripts) || [];
    const declPlugin = new Set(['PLUGIN', 'mergerie']);
    for (const s of scripts) for (const l of fs.readFileSync(path.join(p.dir, s), 'utf8').split('\n')) { const m = l.match(DECL); if (m) declPlugin.add(m[1] || m[2]); }
    for (const s of scripts) {
      const texte = fs.readFileSync(path.join(p.dir, s), 'utf8');
      if (!/^'use strict';/m.test(texte)) soucis.push(`plugins/${p.manifeste.name}/${s}  ne commence pas par 'use strict'`);
      try { new (require('vm').Script)(texte, { filename: s }); } catch (e) { soucis.push(`plugins/${p.manifeste.name}/${s}  ne parse pas : ${e.message}`); continue; }
      const vus = new Set();
      for (const m of dep(texte).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) vus.add(m[1]);
      for (const nom of vus) {
        if (declPlugin.has(nom) || kit.has(nom)) continue;
        if (declCoeur.has(nom)) soucis.push(`plugins/${p.manifeste.name}/${s}  utilise ${nom} (${declCoeur.get(nom)}) — hors du kit window.mergerie : une dépendance cachée au cœur`);
      }
    }
  }
  soucis.length ? fail('Front des plugins : seuls les noms du kit sont permis', soucis) : ok(`Le front de chaque plugin ne touche le cœur que par le kit (${kit.size} noms)`);
}

/* 6. Dictionnaires : parité, préfixe. */
{
  const soucis = [];
  for (const p of plugins) {
    if (!p.ok) continue;
    for (const f of (p.manifeste.ui && p.manifeste.ui.i18n) || []) {
      let d;
      try { d = require(path.join(p.dir, f)); } catch (e) { soucis.push(`plugins/${p.manifeste.name}/${f}  illisible : ${e.message}`); continue; }
      const fr = new Set(Object.keys(d.fr || {})); const en = new Set(Object.keys(d.en || {}));
      for (const k of fr) if (!en.has(k)) soucis.push(`plugins/${p.manifeste.name}/${f}  ${k} — traduit en fr, pas en en`);
      for (const k of en) if (!fr.has(k)) soucis.push(`plugins/${p.manifeste.name}/${f}  ${k} — en en sans son fr`);
      for (const k of fr) if (!k.startsWith(`${p.manifeste.name}.`)) soucis.push(`plugins/${p.manifeste.name}/${f}  ${k} — une clé de plugin commence par « ${p.manifeste.name}. »`);
    }
  }
  soucis.length ? fail('Dictionnaires des plugins', soucis) : ok('Dictionnaires des plugins : fr et en côte à côte, clés préfixées');
}

/* 7. Documentation et types générés depuis le contrat. */
{
  const soucis = [];
  const gen = require('../sdk/scripts/generer-docs-events');
  for (const [lang, f] of [['fr', 'docs/plugins/EVENTS.md'], ['en', 'docs/plugins/en/EVENTS.md']]) {
    const attendu = gen.rendre(lang);
    const reel = fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '';
    if (attendu !== reel) soucis.push(`${f}  n'est pas ce que le contrat génère — node sdk/scripts/generer-docs-events.js`);
  }
  const genApi = require('../sdk/scripts/generer-docs-api');
  for (const [lang, f] of [['fr', 'docs/plugins/API.md'], ['en', 'docs/plugins/en/API.md']]) {
    if (!fs.existsSync(path.join(ROOT, f))) { soucis.push(`${f}  absent`); continue; }
    const texte = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (genApi.rendre(lang) !== texte) soucis.push(`${f}  n'est pas ce que le contrat génère — node sdk/scripts/generer-docs-api.js`);
    for (const prim of Object.keys(contrat.CTX)) if (!texte.includes(`\`ctx.${prim}\``)) soucis.push(`${f}  ne documente pas \`ctx.${prim}\``);
    for (const perm of Object.keys(contrat.PERMISSIONS)) if (!texte.includes(`\`${perm}\``)) soucis.push(`${f}  ne nomme pas la permission \`${perm}\``);
  }
  const types = path.join(ROOT, 'sdk', 'index.d.ts');
  if (fs.existsSync(path.join(ROOT, 'sdk', 'scripts', 'generer-types.js'))) {
    const attendu = require('../sdk/scripts/generer-types').rendre();
    const reel = fs.existsSync(types) ? fs.readFileSync(types, 'utf8') : '';
    if (attendu !== reel) soucis.push('sdk/index.d.ts  n’est pas ce que le contrat génère — node sdk/scripts/generer-types.js');
  }
  soucis.length ? fail('Documentation et types dérivés du contrat', soucis) : ok('EVENTS.md, API.md et index.d.ts suivent le contrat');
}

/* 8. Les exemples de la documentation parsent et sont référencés. */
{
  const dir = path.join(ROOT, 'docs', 'plugins', 'examples');
  const soucis = [];
  const exemples = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : [];
  const docs = tous(path.join(ROOT, 'docs', 'plugins'), '.md').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const f of exemples) {
    try { new (require('vm').Script)(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }); } catch (e) { soucis.push(`docs/plugins/examples/${f}  ne parse pas : ${e.message}`); }
    if (!docs.includes(`examples/${f}`)) soucis.push(`docs/plugins/examples/${f}  n'est cité par aucune page de docs/plugins/`);
  }
  soucis.length ? fail('Exemples de la documentation', soucis) : ok(`Exemples de la documentation : ${exemples.length} fichier(s), tous cités et exécutés par test/unit-plugins-docs.test.js`);
}

console.log('');
if (failures) { console.log(`${failures} contrôle(s) en échec.`); process.exit(1); }
console.log('Contrôles plugins : OK');
