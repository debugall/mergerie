#!/usr/bin/env node
'use strict';
/* `npm create mergerie-plugin <nom>` — ou `node sdk/scripts/creer-plugin.js <nom> [dossier]` : un
   plugin squelette qui FONCTIONNE — manifeste, index.js, un test sur createTestContext, un README
   et une CI minimale. `plugins/hello/` est produit par ce script et commité tel quel : la preuve
   que ce qu'il génère marche. */
const fs = require('fs');
const path = require('path');
const { API_VERSION, MANIFESTE } = require('../contract');

function generer(nom, { dossier, builtin = false, displayName, description } = {}) {
  if (!MANIFESTE.nom.test(String(nom || ''))) throw new Error(`nom « ${nom} » : kebab-case attendu (a-z, 0-9, tirets)`);
  const dir = path.resolve(dossier || `mergerie-plugin-${nom}`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} existe et n'est pas vide`);
  const titre = displayName || nom.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
  const PREFIXE = `plugin_${nom.replace(/-/g, '_')}_`;
  const fichiers = {
    'plugin.json': JSON.stringify({
      name: nom, version: '0.1.0', apiVersion: API_VERSION, displayName: titre,
      description: description || `${titre} — un plugin Mergerie.`,
      author: '', homepage: '', license: 'AGPL-3.0-only', main: 'index.js',
      ...(builtin ? { builtin: true, enabledByDefault: false } : {}),
      permissions: ['events', 'settings', 'db', 'http', 'ui.tab'],
      events: { listens: ['app.ready', 'session.finished', 'review.completed', 'verify.finished', 'mr.created', 'converge.finished', 'repo.deleted', 'app.shutdown'], emits: [] },
      settingsSchema: { type: 'object', properties: { greeting: { type: 'string', title: 'Salutation', description: 'Ce que /ping répond.', default: 'hello', maxLength: 80 } } },
      ui: { scripts: ['ui/main.js'], i18n: ['ui/i18n.js'], html: { tabs: ['ui/html/onglet.html'] } },
    }, null, 2) + '\n',
    'index.js': `'use strict';
/* ${titre} — activate(ctx) reçoit le ctx (docs/plugins/API.md) ; deactivate() rend ce qui a été pris.
   Tout ce que ce plugin fait passe par le ctx : rien n'importe src/ de Mergerie. */

const MIGRATIONS = [
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS ${PREFIXE}event (id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload TEXT, at TEXT NOT NULL)' },
];

async function activate(ctx) {
  ctx.i18n.register('fr', require('./ui/i18n').fr);
  ctx.i18n.register('en', require('./ui/i18n').en);
  ctx.db.migrate(MIGRATIONS);
  ctx.db.classify('${PREFIXE}event', 'L');

  // Un onglet, replié d'office (comme Git, Docker et Liens) : on le déplie dans Réglages → Général → Menus.
  ctx.ui.registerTab({ id: '${nom}', label: '${titre}', icon: 'i-plug', i18n: { label: '${nom}.nav', title: '${nom}.tab.title' } });

  // Chaque événement écouté est journalisé et noté en base : l'onglet les affiche.
  const noter = (nom) => (payload) => {
    ctx.log(\`événement \${nom} (v\${payload.version})\`);
    ctx.db.prepare('INSERT INTO ${PREFIXE}event (name, payload, at) VALUES (?, ?, ?)').run(nom, JSON.stringify(payload), new Date().toISOString());
  };
  for (const nom of ['app.ready', 'session.finished', 'review.completed', 'verify.finished', 'mr.created', 'converge.finished', 'repo.deleted', 'app.shutdown']) ctx.events.on(nom, noter(nom));

  // /api/plugins/${nom}/ping et /events : ce que l'onglet lit.
  ctx.http.router.get('/ping', () => ({ ok: true, greeting: ctx.settings.get('greeting') }));
  ctx.http.router.get('/events', () => ({ events: ctx.db.prepare('SELECT name, payload, at FROM ${PREFIXE}event ORDER BY id DESC LIMIT 50').all().map((e) => ({ ...e, payload: JSON.parse(e.payload) })) }));
  ctx.log('activé');
}

async function deactivate() {
  // Le chargeur retire lui-même abonnements, routes, tâches et déclarations d'écran ; les tables restent.
}

module.exports = { activate, deactivate, MIGRATIONS };
`,
    'ui/i18n.js': `'use strict';
/* Le dictionnaire du plugin, fr et en côte à côte. Clés préfixées par « ${nom}. ». Chargé par le
   serveur (activate) et par la page (UMD : require() côté Node, I18N.etendre() côté navigateur). */
(function (root, factory) {
  const d = factory();
  if (typeof module === 'object' && module.exports) module.exports = d;
  else root.I18N.etendre(d);
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    fr: {
      '${nom}.nav': '${titre}',
      '${nom}.tab.title': '${titre} : les événements reçus et la salutation réglée',
      '${nom}.title': 'Ce que ${titre} a vu',
      '${nom}.empty': 'Aucun événement reçu pour l’instant.',
      '${nom}.greeting': 'Salutation réglée : {greeting}',
    },
    en: {
      '${nom}.nav': '${titre}',
      '${nom}.tab.title': '${titre}: the events received and the configured greeting',
      '${nom}.title': 'What ${titre} saw',
      '${nom}.empty': 'No event received yet.',
      '${nom}.greeting': 'Configured greeting: {greeting}',
    },
  };
}));
`,
    'ui/main.js': `'use strict';
/* Le front du plugin : évalué dans une portée privée avec le kit \`window.mergerie\` (docs/plugins/UI.md).
   Les noms du kit (\$, api, tr, esc, ui…) sont en portée ; rien d'autre du cœur. */
ui.onTabOpen('${nom}', async () => {
  const box = \$('#${nom}Box');
  if (!box) return;
  box.innerHTML = skeleton(2);
  try {
    const [ping, d] = await Promise.all([api('/plugins/${nom}/ping'), api('/plugins/${nom}/events')]);
    box.innerHTML = \`<p class="muted">\${esc(tr('${nom}.greeting', { greeting: ping.greeting }))}</p>\`
      + ((d.events || []).length
        ? d.events.map((e) => \`<div class="card"><strong>\${esc(e.name)}</strong> <span class="muted">v\${esc(String(e.payload.version))} · \${esc(fmtDateTime(e.at))}</span><pre>\${esc(JSON.stringify(e.payload, null, 1))}</pre></div>\`).join('')
        : \`<p class="muted">\${esc(tr('${nom}.empty'))}</p>\`);
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
});
`,
    'ui/html/onglet.html': `<section id="tab-${nom}" class="tab">
    <div class="toolbar"><h2 data-i18n="${nom}.title">Ce que ${titre} a vu</h2></div>
    <div id="${nom}Box" class="list"></div>
</section>
`,
    'test/plugin.test.js': `'use strict';
/* Le plugin, SANS Mergerie : un ctx en mémoire (createTestContext), activate(), puis ce qu'il fait.
   \`node --test\` suffit. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { activatePlugin } = require('${builtin ? '../../../sdk' : '@mergerie/plugin-sdk'}');

describe('${titre}', () => {
  test('activate() pose sa table, son onglet, ses routes, et note les événements reçus', async () => {
    const t = await activatePlugin(path.join(__dirname, '..'));
    assert.deepEqual(t.ctx.db.tables(), ['${PREFIXE}event']);
    assert.deepEqual(t.ui().tabs.map((x) => x.id), ['${nom}']);
    assert.deepEqual((await t.http.call('GET', '/ping')).body, { ok: true, greeting: 'hello' });
    t.ctx.settings.set({ greeting: 'bonjour' });
    assert.equal((await t.http.call('GET', '/ping')).body.greeting, 'bonjour', 'un réglage se relit');
    await t.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
    const evts = (await t.http.call('GET', '/events')).body.events;
    assert.equal(evts.length, 1);
    assert.deepEqual([evts[0].name, evts[0].payload.id, evts[0].payload.version], ['session.finished', 1, 1]);
    assert.match(t.log.join('\\n'), /événement session.finished/);
    await t.deactivate();
  });
});
`,
    'README.md': `# ${titre}

Un plugin [Mergerie](https://mergerie.dev) — généré par \`npm create mergerie-plugin\`.

## Ce qu'il fait

Il écoute les événements du cœur (fin de session, review, vérification, merge request découverte…),
les journalise et les montre dans son onglet ; il expose un réglage (\`greeting\`) et deux routes
sous \`/api/plugins/${nom}/\`.

## Développer

\`\`\`bash
npm install
npm test            # le plugin sous createTestContext, sans Mergerie
\`\`\`

## Installer dans Mergerie

Réglages → Plugins → « Installer un plugin » (dossier local ou adresse git), puis « Activer ».
Ou copie ce dossier dans \`<dataDir>/plugins/${nom}/\` et clique « Rescanner ».

Référence de l'API : docs/plugins/API.md du dépôt Mergerie. Licence : AGPL-3.0-only (voir PUBLISHING.md).
`,
    ...(builtin ? {} : {
      'package.json': JSON.stringify({ name: `mergerie-plugin-${nom}`, version: '0.1.0', description: description || `${titre} — un plugin Mergerie.`, license: 'AGPL-3.0-only', scripts: { test: 'node --test test/' }, devDependencies: { '@mergerie/plugin-sdk': `^${API_VERSION}.0.0`, 'better-sqlite3': '^11.8.1' } }, null, 2) + '\n',
      '.github/workflows/ci.yml': `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: npm ci\n      - run: npm test\n`,
      '.gitignore': 'node_modules/\n',
    }),
  };
  for (const [rel, contenu] of Object.entries(fichiers)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, contenu);
  }
  return { dir, fichiers: Object.keys(fichiers) };
}

module.exports = { generer };
if (require.main === module) {
  const [nom, dossier] = process.argv.slice(2);
  if (!nom) { console.error('usage : creer-plugin <nom-en-kebab-case> [dossier] [--builtin]'); process.exit(1); }
  try {
    const r = generer(nom, { dossier, builtin: process.argv.includes('--builtin') });
    console.log(`plugin « ${nom} » créé dans ${r.dir} :\n  ${r.fichiers.join('\n  ')}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
