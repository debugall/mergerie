# @mergerie/plugin-sdk

Écrire et tester un plugin [Mergerie](https://mergerie.dev) sans lancer Mergerie.

- `contract.js` — **la source unique** de l'API : version, permissions, chaque primitive du `ctx`, chaque événement et son payload. Le serveur, la documentation (`docs/plugins/API.md`, `EVENTS.md`) et les types en sont dérivés.
- `index.d.ts` — les types TypeScript du ctx, du manifeste et des payloads (générés par `scripts/generer-types.js`).
- `createTestContext()` / `activatePlugin(dir)` — un ctx **en mémoire** (SQLite, bus, dictionnaire, registre d'écran, horloge, routeur appelable, jobs, répertoires locaux via `localRoots`) construit par le même code que le serveur.
- `scripts/creer-plugin.js` — `npm create mergerie-plugin <nom>` : un plugin squelette qui marche (manifeste, index.js, test, README, CI).
- `lib/` — les briques partagées avec le cœur de Mergerie (bus, schéma de réglages, garde SQL, registre, horloge, constructeur du ctx).

```js
const { activatePlugin } = require('@mergerie/plugin-sdk');
const t = await activatePlugin(__dirname);          // activate(ctx) sur un ctx en mémoire
await t.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
const r = await t.http.call('GET', '/ping');       // une route du plugin, sans serveur
await t.tick();                                     // ses tâches périodiques, une fois
const j = t.ctx.jobs.start('copie', { n: 1 });      // un job de plugin : lancé tout de suite…
const fini = await t.jobs.wait(j.id);               // …`{ status, logs, progress, error }` (t.jobs.cancel(id) pour un Stop)
await t.deactivate();
```

Documentation complète : `docs/plugins/` du dépôt Mergerie (fr et en). Licence AGPL-3.0-only.
