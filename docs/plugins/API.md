# Référence de l’API du ctx

> Généré depuis `sdk/contract.js` (API 1) par `sdk/scripts/generer-docs-api.js` — ne pas éditer à la main. Les exemples cités sont des fichiers de `docs/plugins/examples/`, exécutés par la CI.

Un plugin exporte `activate(ctx)` et `deactivate()`. Le `ctx` est **la liste fermée** de ce qu'il peut faire : il ne porte que les primitives couvertes par les permissions de son `plugin.json`, et rien d'autre (il est gelé). Un plugin embarqué, un plugin tiers dans son worker et un plugin sous test (`createTestContext`) reçoivent le même ctx, construit par le même code (`sdk/lib/contexte.js`).

Toujours présents, sans permission : `ctx.name`, `ctx.version`, `ctx.apiVersion`, `ctx.log`, `ctx.i18n`.

## Permissions

Déclarées dans `plugin.json` → `permissions`. Réglages → Plugins les affiche avant l’activation ; `exec` déclenche un avertissement explicite pour un plugin tiers.

| Permission | Ce qu’elle ouvre |
|---|---|
| `events` | écouter et émettre des événements (ctx.events) |
| `settings` | lire et écrire ses réglages, validés par settingsSchema (ctx.settings) |
| `secrets` | lire et écrire ses secrets, masqués comme ceux du cœur (ctx.secrets) |
| `db` | ses tables SQLite, préfixées plugin_<name>_ (ctx.db) |
| `http` | des routes HTTP sous /api/plugins/<name>/ (ctx.http.router) |
| `sse` | un flux Server-Sent Events sous /api/plugins/<name>/ (ctx.http.sse) |
| `schedule` | des tâches périodiques (ctx.schedule / ctx.unschedule) |
| `exec` | lancer un binaire SANS shell, avec liste blanche de sous-commandes (ctx.exec) |
| `net` | des requêtes HTTP(S) sortantes, avec la convention TLS du cœur (ctx.net) |
| `repos` | lire le registre des dépôts suivis (ctx.repos) |
| `ui.tab` | un onglet, un sous-onglet de réglages, des pastilles (ctx.ui.registerTab, registerSettingsTab, setBadge) |
| `ui.actions` | des actions et décorations sur les objets du cœur (ctx.ui.registerAction, registerDecorator, registerBriefSection, registerLinkKind) |
| `ui.palette` | des entrées dans la palette Ctrl+K (ctx.ui.registerPaletteProvider) |
| `notify` | des notifications bureau (ctx.notify) |
| `demo` | semer le mode démo (ctx.demo) |
| `env` | lire les variables d’environnement préfixées par son nom (ctx.env) |
| `services` | exposer et appeler des services nommés entre plugins et cœur (ctx.services) |
| `storage` | un dossier privé où écrire des fichiers — un profil de navigateur, un cache — qui survit aux mises à jour du plugin (ctx.dataDir) |

## Primitives

| Primitive | Permission | Signature | Rôle |
|---|---|---|---|
| `ctx.log` | — | `(message: string, ...args) => void` | écrit dans le journal du serveur, préfixé du nom du plugin |
| `ctx.i18n.register` | — | `(locale: "fr" \| "en", dict: Record<string, string>) => void` | ajoute des libellés au dictionnaire du serveur ET du navigateur |
| `ctx.i18n.t` | — | `(key: string, params?: Record<string, unknown>) => string` | traduit dans la langue courante de l’écran |
| `ctx.events.on` | `events` | `(name: string, handler: (payload) => void \| Promise<void>) => () => void` | s’abonne ; rend la fonction de désabonnement |
| `ctx.events.off` | `events` | `(name: string, handler) => void` | se désabonne |
| `ctx.events.emit` | `events` | `(name: string, payload: object) => Promise<EmitResult>` | émet un événement déclaré dans plugin.json (events.emits) |
| `ctx.settings.get` | `settings` | `(key?: string) => unknown` | un réglage, ou tous (défauts du schéma appliqués) |
| `ctx.settings.set` | `settings` | `(patch: Record<string, unknown>) => Record<string, unknown>` | écrit, après validation par settingsSchema |
| `ctx.settings.onChange` | `settings` | `(handler: (settings) => void) => () => void` | appelé après chaque écriture (écran ou plugin) |
| `ctx.secrets.get` | `secrets` | `(key: string) => string` | la valeur en clair (jamais rendue au navigateur) |
| `ctx.secrets.set` | `secrets` | `(key: string, value: string) => void` | "***" = inchangé, "" = effacé |
| `ctx.secrets.has` | `secrets` | `(key: string) => boolean` | y a-t-il une valeur ? |
| `ctx.db.prepare` | `db` | `(sql: string) => Statement` | une requête sur les tables plugin_<name>_* uniquement |
| `ctx.db.exec` | `db` | `(sql: string) => void` | DDL/DML sur les tables du plugin uniquement |
| `ctx.db.transaction` | `db` | `(fn: () => T) => T` | une transaction |
| `ctx.db.migrate` | `db` | `(migrations: { version: number, up: string \| ((db) => void) }[]) => number` | rejoue en avant les migrations non encore appliquées ; rend le nombre jouées |
| `ctx.db.classify` | `db` | `(table: string, family: "P" \| "L" \| "C") => void` | déclare le classement P/L/C d’une table (V1 : L et C seulement) |
| `ctx.http.router` | `http` | `Router` | get/post/put/delete/patch(path, handler(req, reply)) montés sous /api/plugins/<name>/ |
| `ctx.http.sse` | `sse` | `(path: string, producer: (req, send, close) => () => void) => void` | un flux SSE sous /api/plugins/<name>/ (non éprouvé en V1) |
| `ctx.schedule` | `schedule` | `(intervalMs: number, fn: () => void \| Promise<void>, options?: { immediate?: boolean, inDemo?: boolean }) => number` | une tâche périodique ; arrêtée à la désactivation, jamais en recouvrement, inactive en démo sauf inDemo |
| `ctx.unschedule` | `schedule` | `(id: number) => void` | arrête une tâche |
| `ctx.exec` | `exec` | `(bin: string, args: string[], options: { cwd?: string, timeoutMs?: number, allowlist: string[], denyFlags?: string[], env?: Record<string, string> }) => Promise<{ stdout, stderr, code }>` | lance SANS shell, sous-commande en liste blanche (non éprouvé en V1) |
| `ctx.net.request` | `net` | `(url: string, options?: { method?, headers?, body? }) => Promise<{ status, statusText, headers, body }>` | HTTP(S) sortant, agent TLS du plugin (<NAME>_CA_CERT / <NAME>_INSECURE_TLS), délai 30 s |
| `ctx.repos.list` | `repos` | `() => Repo[]` | les dépôts suivis sur ce poste |
| `ctx.repos.byId` | `repos` | `(id: number) => Repo \| null` | un dépôt |
| `ctx.repos.onRemoved` | `repos` | `(handler: (repo: { id: number, project: string }) => void) => () => void` | appelé quand un dépôt est retiré (remplace une FK ON DELETE CASCADE) |
| `ctx.ui.registerTab` | `ui.tab` | `(tab: TabSpec) => void` | un onglet dans la barre (icône, position, replié d’office, recherche, raccourci, onboarding) |
| `ctx.ui.registerSettingsTab` | `ui.tab` | `(tab: SettingsTabSpec) => void` | un sous-onglet de Réglages : formulaire généré du schéma + rendu libre |
| `ctx.ui.setBadge` | `ui.tab` | `(tabId: string, value: { count?: number, failed?: number, warn?: number } \| number \| null) => void` | les pastilles de l’onglet (côté serveur : poussé au navigateur au prochain état) |
| `ctx.ui.registerAction` | `ui.actions` | `(action: { id: string, target: Target, label: string }) => void` | une action sur un objet du cœur ; le rendu et le clic sont écrits côté navigateur (mergerie.ui.onAction) |
| `ctx.ui.registerDecorator` | `ui.actions` | `(decorator: { id: string, target: Target }) => void` | une décoration (badge, texte) sur un objet du cœur, rendue côté navigateur |
| `ctx.ui.registerBriefSection` | `ui.actions` | `(section: { id: string, label: string }) => void` | une section du brief « Aujourd’hui », rendue côté navigateur |
| `ctx.ui.registerLinkKind` | `ui.actions` | `(kind: { kind: string, label: string }) => void` | un genre de lien de todo (ouvert côté navigateur) |
| `ctx.ui.registerPaletteProvider` | `ui.palette` | `(provider: (query: string, limit: number) => PaletteEntry[]) => void` | des entrées de la palette Ctrl+K, calculées sans réseau |
| `ctx.notify.registerKind` | `notify` | `(kind: { type: string, label: string, default: boolean }) => void` | un genre de notification, avec sa case dans Réglages → Notifications |
| `ctx.notify.push` | `notify` | `(type: string, data: object) => void` | un fait, que le navigateur affiche selon les préférences |
| `ctx.demo.isDemo` | `demo` | `() => boolean` | MERGERIE_DEMO=1 ? |
| `ctx.demo.seed` | `demo` | `(fn: (ctx) => void) => void` | ce que le plugin sème dans une base de démo |
| `ctx.dataDir` | `storage` | `string` | le dossier privé du plugin (<dataDir>/plugin-data/<name>/), créé à l’activation ; ni son code, ni celui d’un autre plugin — supprimé avec ses données à la désinstallation si on le demande |
| `ctx.env.get` | `env` | `(name: string) => string \| undefined` | une variable <NAME>_* de l’environnement du serveur |
| `ctx.services.register` | `services` | `(name: string, fn: (payload) => unknown) => void` | expose un service nommé <plugin>.<nom> |
| `ctx.services.call` | `services` | `(name: string, payload?) => Promise<unknown>` | appelle un service du cœur ou d’un autre plugin |
| `ctx.services.has` | `services` | `(name: string) => boolean` | le service existe-t-il ? |

## Cibles d’action et de décoration

`target` d'une action ou d'une décoration, et l'objet que le navigateur passe au rendu :

| Cible | Où | Objet reçu par `render(obj, ctx)` |
|---|---|---|
| `mr` | le menu « ⋯ » d'une carte de merge request | la merge request (`id`, `iid`, `repo_id`, `source_branch`, `verification`… (`mr`, `mr-badge`, `session-target`, `session-target-badge`, `branch`, `branch-badge`, `verification`, `repo-sheet`)) |
| `mr-badge` | les badges d'une carte de merge request | idem |
| `session-target` | le formulaire de suivi d'un projet d'une session | `{ task, target }` |
| `session-target-badge` | les badges d'un projet d'une session | `{ task, target }` |
| `branch` | une ligne de l'explorateur Git | `{ branch, repo_id }` |
| `branch-badge` | les badges d'une ligne de l'explorateur Git | `{ branch, repo_id }` |
| `verification` | la suite d'un verdict vert, dans le rapport de vérification | la merge request, `ctx.verification` |
| `repo-sheet` | la fiche d'un dépôt dans Réglages → Dépôts | la fiche (`id`, `project`, `verifiers`…) |

## Erreurs

Chaque primitive **lève** (ou rejette) avec un message qui nomme le plugin et la règle enfreinte :

- `ctx.db.*` : `requête refusée : la table « x » n'appartient pas au plugin (préfixe attendu : plugin_<nom>_)` — aussi pour `sqlite_master`, `ATTACH`, `PRAGMA` hors `table_info`/`index_*`/`foreign_key_list` ;
- `ctx.http.router.*` : `un plugin ne monte rien hors de /api/plugins/<nom>/` — un chemin doit être relatif et commencer par `/` ;
- `ctx.settings.set` : `réglage inconnu : x`, `x : nombre attendu`, `x : adresse http(s) attendue`… (statut 400 quand l'écran l'appelle) ;
- `ctx.events.emit` : `non déclaré dans plugin.json (events.emits)` ;
- `ctx.notify.push` : `genre non déclaré (notify.registerKind)` ;
- `ctx.schedule` : `intervalle ≥ 1000 ms requis` ;
- `ctx.exec` : `sous-commande « x » hors liste blanche`, `drapeau refusé : --exec` ;
- `ctx.env.get` : `seules les variables <NOM>_* sont lisibles` ;
- `ctx.ui.register*` : `id en kebab-case requis`, `target hors de …`, `déjà déclaré` ;
- un `require` qui mène dans `src/` ou dans un autre plugin : `require('…') refusé — un plugin n'importe rien de src/, il passe par le ctx`.

Une erreur dans `activate(ctx)` met le plugin **en erreur** (le message est affiché dans Réglages → Plugins) et n'empêche pas Mergerie de démarrer. Un `activate` qui ne répond pas en 10 s est abandonné (et, pour un plugin tiers, son worker est tué).

## Exemples

- [examples/activate-minimal.js](./examples/activate-minimal.js) — le squelette : réglages, une route, un journal.
- [examples/db-migrations.js](./examples/db-migrations.js) — des tables préfixées et des migrations en avant seulement.
- [examples/events-and-schedule.js](./examples/events-and-schedule.js) — réagir à `session.finished`, poser une tâche périodique, notifier.
- [examples/ui-registrations.js](./examples/ui-registrations.js) — un onglet, un sous-onglet de réglages, une action sur une merge request, une entrée de palette.

Chaque exemple est chargé par `test/unit-plugins-docs.test.js` sur un `createTestContext()` : s'il cesse de fonctionner, la CI le dit.
