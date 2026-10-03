# A plugin's screen

> Version française : [../UI.md](../UI.md)

## The strategy: no bundle, no build — the assembled page

Mergerie's front is **one global scope**, with no build and no modules: `index.html` lists its
`<script>` and `<link>` tags in order, and `npm run check` guarantees that list. A plugin therefore
does not "load a bundle afterwards": it **declares** its files in `plugin.json` → `ui`, and the server
places them in the page it serves, exactly like the core's own.

```json
"ui": {
  "styles":  ["ui/mine.css"],
  "i18n":    ["ui/i18n.js"],
  "scripts": ["ui/list.js", "ui/sheet.js"],
  "html":    { "tabs": ["ui/html/tab.html"], "modals": ["ui/html/modals.html"],
               "settings": ["ui/html/settings.html"], "sprite": ["ui/html/sprite.html"] }
}
```

| Declared | Where it lands |
|---|---|
| `styles` | `<link>` in the `<head>`, after the core's (`/plugins/<name>/ui/…`) |
| `i18n` | `<script>` BEFORE the translation engine (UMD format: `I18N.etendre(d)` in the browser, `module.exports` under Node) |
| `scripts` | **one bundle per plugin**: `/plugins/<name>/bundle.js`, the files concatenated inside a function receiving `window.mergerie` — after every core screen, before `demarrage.js` |
| `html.tabs` | in `<main>`, after the core tabs (a `<section id="tab-<id>" class="tab">`) |
| `html.modals` | after the core modals |
| `html.settings` | in Settings, one `<div id="sub-<id>" class="subtab">` per declared sub-tab |
| `html.sprite` | `<symbol id="i-…">` elements in the icon sprite |

The tab button and the settings sub-tab button are **generated** by the server from
`ctx.ui.registerTab` / `registerSettingsTab` (position `before:links`, `after:docker`, `end`; badges
`#nav-<id>-count`, `#nav-<id>-err`, `#nav-<id>-warn`). The screen declarations of every active plugin
are in the page, as JSON (`<script type="application/json" id="mergeriePlugins">`).

**Enabling or disabling** happens live on the server; the page **reloads** to reflect the bar, the
screens and the scripts — Mergerie does not restart.

## The `window.mergerie` kit

A plugin's bundle is evaluated in a **private scope** where every top-level key of `window.mergerie`
is in scope: `$`, `$$`, `api`, `tr`, `esc`, `safeUrl`, `toast`, `busy`, `skeleton`, `svgIco`,
`emptyState`, `comboHtml`/`wireCombo` (searchable combos), `repoComboHtml`/`wireRepoCombos`,
`confirmDialog`, `navTab`, `fermerAuFond`, `errorBox`, `explainError`, `fmtDateTime`, `dateHtml`,
`depuis`, `mdToHtml`, `showNotif`, `i18n`, and objects: `repos`, `reviews`, `notes`, `agents`,
`sessions`, `settings`, `ui`, `events`. **Nothing else of the core** is reachable:
`npm run check:plugins` refuses, in a built-in plugin's front, any core name outside the kit. The exact
list is in `public/js/transverse/kit.js` (one key per line); it is covered by the `apiVersion`.

`PLUGIN` (the plugin's name) is in scope too.

### `ui` — what the plugin registers browser-side

| Method | Role |
|---|---|
| `ui.onTabOpen(tabId, fn)` | called when the tab opens |
| `ui.onSettingsTab(subId, fn)` | called when the settings sub-tab opens |
| `ui.onAction(id, { render(obj, ctx) } \| { run(obj, ctx, button) })` | the rendering of an action declared by `ctx.ui.registerAction` (an HTML string), or a default button and the click handler |
| `ui.onDecorator(id, render(obj, ctx))` | the rendering of a decoration (`registerDecorator`) |
| `ui.onBriefSection(id, render(brief))` | the body of a section of the "Today" brief (empty = no section) |
| `ui.onLinkKind(kind, { render(todo), open(ref) })` | a todo link of a kind declared by `registerLinkKind` |
| `ui.onNotif(type, (evt, prefs) => ({ title, body, onClick }))` | a notification of a kind declared by `notify.registerKind` |
| `ui.onPaletteResult(plugin, (nav, result) => …)` | opening a result returned by the plugin's palette provider |
| `ui.registerPaletteAction({ label, tab, run })` | a palette action ("Go to …") |
| `ui.setBadge(tabId, { count, failed, warn, countTip, failedTip, warnTip })` | the tab's badges |
| `ui.settings.get(plugin)` / `.save(plugin, patch)` / `.onChange(plugin, fn)` | the plugin's settings (secrets masked `***`) |
| `ui.settings.renderForm(plugin, container)` | the form generated from `settingsSchema` (also placed on any `[data-plugin-settings-form="<plugin>"]` of a sub-tab) |
| `ui.tabButton(tabId)`, `ui.openTab(tabId)`, `ui.meta(plugin)`, `ui.reloadPage()` | utilities |

`events.on('settings.changed' \| 'tab.opened', fn)`: a small front-side bus.

### Action and decoration targets

| Target | Where the core asks plugins | Object received |
|---|---|---|
| `mr` | the "⋯" menu of a merge request card | the merge request |
| `mr-badge` | the badge row of a card (list, reports, detail) | the merge request |
| `session-target` | the follow-up form of a session's project | `{ task, target }` |
| `session-target-badge` | the badges of a session's project | `{ task, target }` |
| `branch` | a row of the Git explorer | `{ branch, repo_id }` |
| `branch-badge` | the badges of a Git explorer row | `{ branch, repo_id }` |
| `verification` | what follows a green verdict, in the report | the merge request, `ctx.verification` |
| `repo-sheet` | a repository's sheet (Settings → Repositories) | the sheet |

The core knows no plugin: it asks "what do you render for this target?" and inserts what comes back.
The plugin sets its own `data-*` attributes and listens to its own clicks (delegation on `document`).

## The constraints

- **i18n**: every visible string goes through `tr('<name>.…')`; the plugin's dictionary has `fr` and
  `en` side by side, all its keys prefixed by the plugin name. Tab, sub-tab, action and section labels
  are given as keys (`i18n: { label, title }`, `i18n: '…'`) so they follow the screen language.
- **Theme**: two themes (dark, light); a plugin stylesheet uses the core variables (`var(--panel)`,
  `var(--line)`, `var(--muted)`…) and plugin-prefixed classes.
- **Search**: wherever a repository or a ref is picked, a searchable combo (`comboHtml`/`wireCombo`,
  `repoComboHtml`); `registerTab({ searchField })` wires "/", and `list` the `j`/`k` keys.
- **Palette**: `ctx.ui.registerPaletteProvider` server-side, computed without network; opening
  browser-side through `ui.onPaletteResult`.
- **Shortcuts**: tabs get a digit from their position in the bar; a plugin may declare `shortcut`
  for information.
- **Screen security**: no `on…=` attribute handlers nor inline `<script>` (the CSP refuses them);
  every interpolated URL goes through `safeUrl`/`safeImg`; every `target="_blank"` carries a `rel`.
  Anything coming from elsewhere is escaped with `esc`.
