# Mergerie plugins — in 5 minutes

> Version française : [../README.md](../README.md)

A **plugin** is a folder with a `plugin.json` and an `index.js` exporting `activate(ctx)` and
`deactivate()`. It adds to Mergerie what the core does not do — a tab, actions on merge requests, a
background task, an integration — **without touching the core's code**: everything it can do goes
through the `ctx`, a closed list of primitives (settings, secrets, tables, routes, tasks, events,
screen…). A plugin shipped in the repository (`plugins/jenkins`, `plugins/hello`) and a plugin you
install yourself have **exactly the same rights**.

> **A subscriber must not wait.** The bus calls an event's subscribers one after the other and waits for each (30 s at most): long work — a process, a browser, a slow network call — goes into a queue and **returns at once** (see [`jenkins-teams-notify`](https://gitlab.com/amady/jenkins-teams-notify)); its outcome goes to the plugin's own log.

## Install `hello`, enable it, change a setting

`hello` ships with Mergerie, disabled by default. It logs every core event it receives and exposes
one setting.

1. Open **Settings → Plugins**. The list shows every plugin: version, state, permissions,
   dependencies, events listened to and emitted.
2. On **Hello**, click **Enable**. The page reloads — Mergerie does not restart — and a **Hello** tab
   appears in the bar (folded by default: Settings → General → Menus to show it).
3. Still in Settings → Plugins, Hello's form (generated from its `settingsSchema`) has a **Greeting**
   field. Change it, **Save**: `GET /api/plugins/hello/ping` answers with the new value, and the tab
   shows it.
4. Start a session, a review, a verification: the Hello tab lists the events received
   (`session.finished`, `review.completed`…), with their payload and its version.
5. **Disable** removes the tab, the routes, the subscriptions and the background task; the plugin's
   data (its table, its setting) stays. **Enable** brings everything back.

## Install a third-party plugin

Three ways, none of which restarts Mergerie:

- **A folder dropped** into `<dataDir>/plugins/<name>/` (by default `~/.mergerie/data/plugins/`),
  then **Rescan** in Settings → Plugins.
- **"Install a plugin" → local folder**: the manifest is checked, the folder copied.
- **"Install a plugin" → git address**: clone without a shell (optional branch or tag), manifest
  checked before copying.

A third-party plugin is **disabled** after installation, runs in **its own worker** (a crashing
plugin never kills the server), and its permissions are shown before you enable it — `exec` (running
programs) triggers an explicit warning. **Uninstall** deletes the folder and offers to keep or delete
its data. There is no central registry and no automatic download.

## Read next

| Page | For |
|---|---|
| [GETTING-STARTED.md](./GETTING-STARTED.md) | create your first plugin with the generator, test it without Mergerie, install it |
| [API.md](./API.md) | the `ctx` reference, primitive by primitive, with permission, signature, errors |
| [EVENTS.md](./EVENTS.md) | every event, when it is emitted, its payload and version |
| [UI.md](./UI.md) | what a plugin adds to the screen and the `window.mergerie` kit |
| [DATA.md](./DATA.md) | tables, prefix, migrations, P/L/C classification, retention |
| [SECURITY.md](./SECURITY.md) | the trust model, what a plugin cannot do |
| [PUBLISHING.md](./PUBLISHING.md) | naming, documenting, publishing (AGPL licence), getting listed |
| [MIGRATION.md](./MIGRATION.md) | how `apiVersion` evolves, and what the core guarantees |
| [COMMUNITY.md](./COMMUNITY.md) | known plugins |

For the history of the work: [../JENKINS-INVENTORY.md](../JENKINS-INVENTORY.md) (the inventory that
sized the API) and [../PLUGIN-CANDIDATES.md](../PLUGIN-CANDIDATES.md) (Links, Docker and Git, next in
line) — in French.
