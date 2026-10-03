# Create your first plugin

> Version française : [../GETTING-STARTED.md](../GETTING-STARTED.md)

Prerequisites: Node 22, and a clone of Mergerie (for the SDK, until it is published on npm:
`sdk/` of the repository is `@mergerie/plugin-sdk`).

## 1. Generate the skeleton

```bash
node sdk/scripts/creer-plugin.js my-plugin            # → ./mergerie-plugin-my-plugin/
# or, once the SDK is published: npm create mergerie-plugin my-plugin
```

The folder produced contains:

```
mergerie-plugin-my-plugin/
  plugin.json          the manifest: name, version, apiVersion, permissions, settingsSchema, ui
  index.js             activate(ctx) / deactivate()
  ui/i18n.js           the fr/en dictionary (keys prefixed "my-plugin.")
  ui/main.js           the front: evaluated with the window.mergerie kit in scope
  ui/html/onglet.html  the tab panel
  test/plugin.test.js  the plugin under createTestContext, without Mergerie
  README.md, package.json, .github/workflows/ci.yml
```

This is **exactly** what `plugins/hello/` contains: the generator produces a working plugin.

## 2. Read `index.js`

```js
async function activate(ctx) {
  ctx.i18n.register('fr', require('./ui/i18n').fr);        // labels, server and browser
  ctx.db.migrate(MIGRATIONS);                               // its tables, plugin_my_plugin_*
  ctx.ui.registerTab({ id: 'my-plugin', label: 'My plugin', icon: 'i-plug' });
  ctx.events.on('session.finished', (p) => ctx.log(`session ${p.id}: ${p.status}`));
  ctx.http.router.get('/ping', () => ({ ok: true, greeting: ctx.settings.get('greeting') }));
}
```

The `ctx` only carries the primitives of the **declared permissions** in `plugin.json`; a missing
primitive is `undefined`. The full reference: [API.md](./API.md).

## 3. Test without starting Mergerie

```bash
cd mergerie-plugin-my-plugin && npm install && npm test
```

`createTestContext()` (or `activatePlugin(dir)`) returns an **in-memory** ctx: a SQLite database with
the plugin base tables, an event bus, a dictionary, a screen registry, a clock the test advances by
hand (`tick()`), a router you call directly (`http.call('GET', '/ping')`) or mount on Express
(`http.express()` for supertest). The same code builds the server's ctx: what your test proves holds
for Mergerie.

```js
const { activatePlugin } = require('@mergerie/plugin-sdk');
const t = await activatePlugin(path.join(__dirname, '..'));
await t.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
assert.equal((await t.http.call('GET', '/events')).body.events.length, 1);
await t.deactivate();
```

See [../examples/](../examples/) — four examples that Mergerie's CI runs.

## 4. Install into your Mergerie

- Settings → Plugins → **Install a plugin** → the folder path (or its git address), then **Enable**;
- or copy the folder into `<dataDir>/plugins/my-plugin/` and **Rescan**.

A third-party plugin runs in a worker, disabled until you enable it. After changing the code:
**Rescan** flags the new version; disable then enable loads it (table migrations replay forward only).

## 5. The rules that make loading fail

- unknown `apiVersion` → "incompatible", never loaded;
- a `require` leading into Mergerie's `src/` or into another plugin → refused;
- a table outside `plugin_<name>_`, a route outside `/api/plugins/<name>/`, a setting outside the
  schema, an undeclared emitted event → refused with a message naming the rule;
- `activate()` that throws or does not answer within 10 s → the plugin is "in error", Mergerie starts anyway.

Next: [UI.md](./UI.md) for the screen, [DATA.md](./DATA.md) for tables, [PUBLISHING.md](./PUBLISHING.md) to share.
