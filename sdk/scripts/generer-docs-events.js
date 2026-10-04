#!/usr/bin/env node
'use strict';
/* `docs/plugins/EVENTS.md` (et sa version anglaise) SONT GÉNÉRÉS depuis `sdk/contract.js` :
   la documentation des événements ne peut pas mentir, elle n'est pas écrite à la main.
   `npm run check:plugins` vérifie que le fichier commité est bien celui que ce script rend. */
const fs = require('fs');
const path = require('path');
const { EVENTS, API_VERSION } = require('../contract');

const ROOT = path.join(__dirname, '..', '..');

function tableau(payload) {
  const lignes = Object.entries(payload);
  if (!lignes.length) return '_(aucun champ en dehors de `version`)_';
  return ['| Champ | Type |', '|---|---|', ...lignes.map(([k, v]) => `| \`${k}\` | \`${v}\` |`)].join('\n');
}

function exemple(nom, e) {
  const ex = { version: e.version };
  for (const [k, v] of Object.entries(e.payload)) {
    if (/number/.test(v)) ex[k] = 42;
    else if (/boolean/.test(v)) ex[k] = true;
    else if (/Record/.test(v)) ex[k] = { BRANCH: 'main' };
    else if (/"/.test(v)) ex[k] = v.match(/"([^"]+)"/)[1];
    else ex[k] = nom.includes('.') ? `${k}-example` : '';
  }
  return JSON.stringify(ex, null, 2);
}

function rendre(lang) {
  const fr = lang === 'fr';
  const out = [];
  out.push(fr ? '# Les événements' : '# Events');
  out.push('');
  out.push(fr
    ? `> Généré depuis \`sdk/contract.js\` (API ${API_VERSION}) par \`sdk/scripts/generer-docs-events.js\` — ne pas éditer à la main.`
    : `> Generated from \`sdk/contract.js\` (API ${API_VERSION}) by \`sdk/scripts/generer-docs-events.js\` — do not edit by hand.`);
  out.push('');
  out.push(fr
    ? 'Un événement est un nom (`domaine.action`) et un payload **sérialisable** qui porte toujours `version`. Les handlers tournent en file, chacun sous try/catch et délai (30 s) : un abonné qui échoue est journalisé, jamais propagé. Un plugin s’abonne avec `ctx.events.on(name, handler)` et émet les siens (déclarés dans `plugin.json` → `events.emits`) avec `ctx.events.emit(name, payload)`.'
    : 'An event is a name (`domain.action`) and a **serialisable** payload that always carries `version`. Handlers run one after the other, each under try/catch and a timeout (30 s): a failing subscriber is logged, never propagated. A plugin subscribes with `ctx.events.on(name, handler)` and emits its own (declared in `plugin.json` → `events.emits`) with `ctx.events.emit(name, payload)`.');
  out.push('');
  out.push(fr ? '| Événement | Version | Source | Quand |' : '| Event | Version | Source | When |');
  out.push('|---|---|---|---|');
  for (const [nom, e] of Object.entries(EVENTS)) out.push(`| [\`${nom}\`](#${nom.replace(/\./g, '')}) | ${e.version} | ${e.source} | ${e.when} |`);
  out.push('');
  for (const [nom, e] of Object.entries(EVENTS)) {
    out.push(`## \`${nom}\``);
    out.push('');
    out.push(`${fr ? '**Quand**' : '**When**'} : ${e.when}. ${fr ? '**Source**' : '**Source**'} : ${e.source}. ${fr ? '**Version**' : '**Version**'} : ${e.version}.`);
    out.push('');
    out.push(tableau(e.payload));
    out.push('');
    out.push('```json');
    out.push(exemple(nom, e));
    out.push('```');
    out.push('');
  }
  out.push(fr
    ? '## Compatibilité\n\nUn champ **ajouté** au payload ne change pas la version. Un champ retiré ou renommé, ou un sens qui change, incrémente `version` : le plugin lit `payload.version` et sait à quoi s’attendre. Voir [MIGRATION.md](./MIGRATION.md).'
    : '## Compatibility\n\nA field **added** to a payload does not change the version. A field removed or renamed, or a meaning that changes, increments `version`: the plugin reads `payload.version` and knows what to expect. See [MIGRATION.md](./MIGRATION.md).');
  out.push('');
  return out.join('\n');
}

function ecrire() {
  const cibles = { fr: path.join(ROOT, 'docs', 'plugins', 'EVENTS.md'), en: path.join(ROOT, 'docs', 'plugins', 'en', 'EVENTS.md') };
  for (const [lang, f] of Object.entries(cibles)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rendre(lang));
  }
  return cibles;
}

/** Ce que le script rendrait, pour comparer au fichier commité. */
module.exports = { rendre, ecrire };
if (require.main === module) {
  const c = ecrire();
  console.log(`EVENTS.md écrit : ${Object.values(c).join(', ')}`);
}
