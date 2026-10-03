# The plugin API and its versions

> Version française : [../MIGRATION.md](../MIGRATION.md)

## What `apiVersion` covers

The current `apiVersion` is **`1`** (`sdk/contract.js` → `API_VERSION`). It covers:

- every `ctx` primitive ([API.md](./API.md)): its existence, its signature, its permission;
- every core event ([EVENTS.md](./EVENTS.md)): its name and its payload, which carries `version`;
- the shape of the manifest (`plugin.json`);
- the `window.mergerie` kit ([UI.md](./UI.md)) and the action targets;
- the data rules (prefix, migrations, P/L/C) ([DATA.md](./DATA.md)).

All of it has **one source**: `sdk/contract.js`. The documentation and the types (`sdk/index.d.ts`)
are generated from it; `npm run check:plugins` refuses any divergence.

## What is a breaking change, and what is not

**Not breaking** (same `apiVersion`): a primitive added; a field added to an event payload; a
permission added; an action target added; a name added to the kit; a primitive marked "unproven"
becoming proven.

**Breaking** (`apiVersion` incremented): a primitive removed or whose signature changes; a payload
field removed or renamed, or whose meaning changes — the event's `version` is then incremented too; a
permission removed; a data rule tightened.

## How the core handles an `apiVersion` change

1. The core announces the new version and declares **both** (old and new) in `API_VERSIONS_SUPPORTEES`
   during a compatibility period: **two minor versions of Mergerie**, or six months, whichever is
   longer — written in CHANGELOG.md.
2. During that period, a plugin targeting the old version loads with a warning in Settings → Plugins;
   removed primitives are served to it by an **adapter** documented here.
3. After the period, the old version leaves `API_VERSIONS_SUPPORTEES`: the plugin is listed
   **"incompatible"** with the message `apiVersion « 1 » non supportée par ce Mergerie (supportées : 2)`,
   and **never loaded** — neither half-way nor in a degraded mode.

A plugin reads `payload.version` in its event handlers: that is what lets it recognise a payload of
another version during the transition.

## History

| apiVersion | Mergerie | Changes |
|---|---|---|
| `1` | 2.1 | first public version: the ctx, the events, the kit, the SDK |
| `1` (additions) | 2.1 | **additive, same version**: the `storage` permission and `ctx.dataDir`; the `url` and `startedBy` fields of `jenkins.job.started`, `url`, `duration` and `startedBy` of `jenkins.job.finished`; the `env` option of `ctx.exec` |
| `1` (additions) | 2.2 | **additive, same version** (Docker extracted as a third-party plugin): the `jobs` permission and `ctx.jobs` (`register`, `start`; the runner's `job`: `log`, `message`, `progress`, `exec` → `{ code, tail }`, `isCancelled`); `ctx.execStream` (a long-lived process, lines as they come); `ctx.repos.localRoots()`; `ctx.http.sse` from a worker; the `repo-row` and `verify-launch` targets; in the browser, the `job.finished` event and the kit names `toastUndo`, `chipBranche`, `navMasque`, `ANSI`, `jobs.refresh` |
| `1` (additions) | 2.3 | **additive, same version** (Links extracted as a third-party plugin): the `mr-detail` and `jira-ticket` targets; browser-side `ui.onKey(tab, fn)` (the keyboard of the open tab) and the `closeSplitMenus` kit name; the `group` field (`links`) of a palette entry; a tab position anchor that cannot be found puts the button at the end of the list instead of losing it |

Primitives present but **not yet proven** by a built-in plugin in `1` (their shape may still change
without a breaking change, until Git exercises them): `ui.registerSettingsTab({ schemaForm: true })` alone, `demo.seed` from a worker. `exec`, `execStream`, `jobs` and `http.sse` (including from a worker) are proven by the third-party Docker plugin; `ui.registerDecorator` on detail targets (`mr-detail`, `session-target-badge`, `jira-ticket`, `repo-sheet`), `services` between plugins and the palette provider are proven by the third-party Links plugin.
