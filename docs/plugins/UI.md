# L'écran d'un plugin

> English version: [en/UI.md](./en/UI.md)

## La stratégie : pas de bundle, pas de build — la page assemblée

Le front de Mergerie est **une seule portée globale**, sans build ni modules : `index.html` liste ses
`<script>` et `<link>` dans l'ordre, et `npm run check` garantit cette liste. Un plugin ne charge donc
pas « un bundle après coup » : il **déclare** ses fichiers dans `plugin.json` → `ui`, et le serveur les
pose dans la page qu'il sert, exactement comme ceux du cœur.

```json
"ui": {
  "styles":  ["ui/mon.css"],
  "i18n":    ["ui/i18n.js"],
  "scripts": ["ui/liste.js", "ui/fiche.js"],
  "html":    { "tabs": ["ui/html/onglet.html"], "modals": ["ui/html/modales.html"],
               "settings": ["ui/html/reglages.html"], "sprite": ["ui/html/sprite.html"] }
}
```

| Déclaré | Où il atterrit |
|---|---|
| `styles` | `<link>` dans le `<head>`, après ceux du cœur (`/plugins/<nom>/ui/…`) |
| `i18n` | `<script>` AVANT le moteur de traduction (format UMD : `I18N.etendre(d)` dans le navigateur, `module.exports` côté Node) |
| `scripts` | **un bundle par plugin** : `/plugins/<nom>/bundle.js`, les fichiers concaténés dans une fonction qui reçoit `window.mergerie` — après tous les écrans du cœur, avant `demarrage.js` |
| `html.tabs` | dans `<main>`, après les onglets du cœur (un `<section id="tab-<id>" class="tab">`) |
| `html.modals` | après les modales du cœur |
| `html.settings` | dans Réglages, un `<div id="sub-<id>" class="subtab">` par sous-onglet déclaré |
| `html.sprite` | des `<symbol id="i-…">` dans le sprite d'icônes |

Le bouton d'onglet et le bouton de sous-onglet sont **générés** par le serveur depuis
`ctx.ui.registerTab` / `registerSettingsTab` (position `before:git`, `after:docker`, `end` — une ancre qui n'est ni un onglet du cœur ni celui d'un plugin installé range le bouton en fin de liste, il ne disparaît jamais ; pastilles
`#nav-<id>-count`, `#nav-<id>-err`, `#nav-<id>-warn`). Les déclarations d'écran de tous les plugins
actifs sont dans la page, en JSON (`<script type="application/json" id="mergeriePlugins">`).

**Activer ou désactiver** se fait à chaud côté serveur ; la page se **recharge** pour refléter la barre,
les écrans et les scripts — Mergerie ne redémarre pas.

## Le kit `window.mergerie`

Le bundle d'un plugin est évalué dans une **portée privée** où chaque clé de premier niveau de
`window.mergerie` est en portée : `$`, `$$`, `api`, `tr`, `esc`, `safeUrl`, `toast`, `busy`, `skeleton`,
`svgIco`, `emptyState`, `comboHtml`/`wireCombo` (les combos avec recherche), `repoComboHtml`/`wireRepoCombos`,
`confirmDialog`, `navTab`, `fermerAuFond`, `errorBox`, `explainError`, `fmtDateTime`, `dateHtml`, `depuis`,
`mdToHtml`, `ANSI` (lire les couleurs d’un journal), `showNotif`, `toastUndo`, `chipBranche`, `closeSplitMenus` (referme les menus déroulants ouverts), `navMasque`, `i18n`, et des objets : `repos`, `reviews`, `notes`, `agents`, `sessions`,
`settings`, `ui`, `events`, `jobs` (`jobs.refresh()` : relire la file après avoir lancé un job). **Rien d'autre du cœur** n'est accessible : `npm run check:plugins` refuse,
dans le front d'un plugin embarqué, tout nom déclaré par le cœur hors du kit. La liste exacte est dans
`public/js/transverse/kit.js` (une clé par ligne) ; elle est couverte par l'`apiVersion`.

`PLUGIN` (le nom du plugin) est aussi en portée.

### `ui` — ce que le plugin enregistre côté navigateur

| Méthode | Rôle |
|---|---|
| `ui.onTabOpen(tabId, fn)` | appelé quand l'onglet s'ouvre |
| `ui.onSettingsTab(subId, fn)` | appelé quand le sous-onglet de réglages s'ouvre |
| `ui.onAction(id, { render(obj, ctx) } \| { run(obj, ctx, bouton) })` | le rendu d'une action déclarée par `ctx.ui.registerAction` (une chaîne HTML), ou un bouton par défaut et le geste au clic |
| `ui.onDecorator(id, render(obj, ctx))` | le rendu d'une décoration (`registerDecorator`) |
| `ui.onBriefSection(id, render(brief))` | le corps d'une section du brief « Aujourd'hui » (vide = pas de section) |
| `ui.onLinkKind(kind, { render(todo), open(ref) })` | un lien de todo d'un genre déclaré par `registerLinkKind` — la table `todo` ne contraint pas `link_kind` : le genre est accepté à l'écriture tant que le plugin est actif |
| `ui.onKey(tabId, (evenement) => boolean)` | le clavier de l'onglet OUVERT : il passe avant les touches globales (`j`/`k`, `Entrée`…) ; rendre `true` consomme la touche |
| `ui.onNotif(type, (evt, prefs) => ({ title, body, onClick }))` | une notification d'un genre déclaré par `notify.registerKind` |
| `ui.onPaletteResult(plugin, (nav, resultat) => …)` | l'ouverture d'un résultat rendu par le fournisseur de palette du plugin |
| `ui.registerPaletteAction({ label, tab, run })` | une action de palette (« Aller à … ») |
| `ui.setBadge(tabId, { count, failed, warn, countTip, failedTip, warnTip })` | les pastilles de l'onglet |
| `ui.settings.get(plugin)` / `.save(plugin, patch)` / `.onChange(plugin, fn)` | les réglages du plugin (secrets masqués `***`) |
| `ui.settings.renderForm(plugin, conteneur)` | le formulaire généré depuis `settingsSchema` (aussi posé sur tout `[data-plugin-settings-form="<plugin>"]` d'un sous-onglet) |
| `ui.tabButton(tabId)`, `ui.openTab(tabId)`, `ui.meta(plugin)`, `ui.reloadPage()` | utilitaires |

`events.on('settings.changed' \| 'tab.opened' \| 'job.finished', fn)` : un petit bus front (`job.finished` : `{ id, kind, status }`, `kind` vaut `plugin:<nom>` pour un job de plugin).

### Les cibles (`target`) des actions et décorations

| Cible | Où le cœur demande aux plugins | Objet reçu |
|---|---|---|
| `mr` | le menu « ⋯ » d'une carte de merge request | la merge request |
| `mr-badge` | la rangée de badges d'une carte (liste, rapports, détail) | la merge request |
| `session-target` | le formulaire de suivi d'un projet d'une session | `{ task, target }` |
| `session-target-badge` | les badges d'un projet d'une session | `{ task, target }` |
| `branch` | une ligne de l'explorateur Git | `{ branch, repo_id }` |
| `branch-badge` | les badges d'une ligne de l'explorateur | `{ branch, repo_id }` |
| `verification` | ce qui suit un verdict vert, dans le rapport | la merge request, `ctx.verification` |
| `repo-sheet` | la fiche d'un dépôt (Réglages → Dépôts) | la fiche (dont `id` et `project`) |
| `repo-row` | la ligne d'un dépôt dans Réglages → Dépôts (de petits liens à côté de son état) | le dépôt (dont `has_compose`) |
| `verify-launch` | la fenêtre de lancement d'une vérification, quand un répertoire « in place » est en jeu | `{ dirs }` — les dossiers de travail |
| `mr-detail` | sous le rapport d'une merge request, avant ses erreurs (des boutons, un bloc) | la merge request |
| `jira-ticket` | la section d'un ticket Jira, entre ce qui est déjà engagé et la description | le ticket (dont `key`) |

Le cœur ne connaît aucun plugin : il appelle « que rendez-vous pour cette cible ? » et insère ce qui
revient. Le plugin pose ses propres `data-*` et écoute ses propres clics (délégation sur `document`).

## Les contraintes

- **i18n** : toute chaîne visible passe par `tr('<nom>.…')` ; le dictionnaire du plugin a `fr` et `en`
  côte à côte, toutes ses clés préfixées par le nom du plugin. Les libellés d'onglet, de sous-onglet,
  d'action et de section se donnent par une clé (`i18n: { label, title }`, `i18n: '…'`) pour suivre la
  langue de l'écran.
- **Thème** : deux thèmes (sombre, clair) ; une feuille de style de plugin utilise les variables du
  cœur (`var(--panel)`, `var(--line)`, `var(--muted)`…) et des classes préfixées par le plugin.
- **Recherche** : partout où l'on choisit un dépôt ou une référence, un combo avec recherche
  (`comboHtml`/`wireCombo`, `repoComboHtml`) ; `registerTab({ searchField })` branche « / », et `list`
  les touches `j`/`k`.
- **Palette** : `ctx.ui.registerPaletteProvider` côté serveur, calculé sans réseau ; l'ouverture côté
  navigateur par `ui.onPaletteResult`. Une entrée peut nommer son `group` — `links` est le seul groupe qu'un plugin puisse nommer (il ouvre la liste, devant les résultats du cœur, comme les liens de travail l'ont toujours fait) ; tout autre tombe dans « actions ».
- **Raccourcis** : les onglets reçoivent un chiffre selon leur place dans la barre ; un plugin peut
  déclarer `shortcut` pour information.
- **Sécurité de l'écran** : pas de gestionnaire `on…=` en attribut ni de `<script>` en ligne (la CSP
  les refuse) ; toute URL interpolée passe par `safeUrl`/`safeImg` ; tout `target="_blank"` porte un
  `rel`. Ce qui vient d'ailleurs est échappé par `esc`.
