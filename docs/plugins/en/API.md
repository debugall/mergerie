# The ctx API reference

> Generated from `sdk/contract.js` (API 1) by `sdk/scripts/generer-docs-api.js` — do not edit by hand. The examples cited are files under `docs/plugins/examples/`, run by the CI.

A plugin exports `activate(ctx)` and `deactivate()`. The `ctx` is **the closed list** of what it can do: it only carries the primitives covered by the permissions of its `plugin.json`, nothing else (it is frozen). A built-in plugin, a third-party plugin in its worker and a plugin under test (`createTestContext`) receive the same ctx, built by the same code (`sdk/lib/contexte.js`).

Always present, no permission needed: `ctx.name`, `ctx.version`, `ctx.apiVersion`, `ctx.log`, `ctx.i18n`.

## Permissions

Declared in `plugin.json` → `permissions`. Settings → Plugins shows them before activation; `exec` triggers an explicit warning for a third-party plugin.

| Permission | What it opens |
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
| `jobs` | des jobs dans la file du cœur : journal en direct, progression, arrêt, écran des jobs (ctx.jobs) |
| `storage` | un dossier privé où écrire des fichiers — un profil de navigateur, un cache — qui survit aux mises à jour du plugin (ctx.dataDir) |

## Primitives

| Primitive | Permission | Signature | Role |
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
| `ctx.exec` | `exec` | `(bin: string, args: string[], options: { cwd?: string, timeoutMs?: number, allowlist: string[], denyFlags?: string[], env?: Record<string, string> }) => Promise<{ stdout, stderr, code }>` | lance SANS shell, sous-commande en liste blanche ; `env` s’ajoute à un environnement minimal, sans PATH, HOME, LD_*, DYLD_*, NODE_OPTIONS, GIT_*, SHELL, BASH_ENV… |
| `ctx.execStream` | `exec` | `(bin: string, args: string[], options: { cwd?: string, allowlist: string[], denyFlags?: string[], env?: Record<string, string> }, onLine: (stream: "stdout" \| "stderr", line: string) => void, onClose?: (result: { code: number } \| { error: string }) => void) => { close(): void }` | un processus qui dure, SANS shell, mêmes gardes que `exec` : ses lignes arrivent au fil de l’eau, `close()` l’arrête (un `docker logs -f`) ; aucun délai, c’est à celui qui lance de fermer |
| `ctx.net.request` | `net` | `(url: string, options?: { method?, headers?, body? }) => Promise<{ status, statusText, headers, body }>` | HTTP(S) sortant, agent TLS du plugin (<NAME>_CA_CERT / <NAME>_INSECURE_TLS), délai 30 s |
| `ctx.repos.list` | `repos` | `() => Repo[]` | les dépôts suivis sur ce poste |
| `ctx.repos.byId` | `repos` | `(id: number) => Repo \| null` | un dépôt |
| `ctx.repos.localRoots` | `repos` | `() => { id: number, path: string, label: string }[]` | les répertoires locaux déclarés dans Réglages → Dépôts (là où l’on cherche des projets, des fichiers compose…) |
| `ctx.repos.onRemoved` | `repos` | `(handler: (repo: { id: number, project: string }) => void) => () => void` | appelé quand un dépôt est retiré (remplace une FK ON DELETE CASCADE) |
| `ctx.jobs.register` | `jobs` | `(kind: string, runner: (job: JobHandle, payload: unknown) => void \| Promise<void>) => void` | inscrit un genre de job ; `runner` reçoit un `job` (`log(line)`, `message(text)`, `progress(done, total)`, `exec(bin, args, options)` → `{ code, tail }`, dont la sortie va au journal et que « Stop » arrête, `isCancelled()`) ; une exception met le job en erreur |
| `ctx.jobs.start` | `jobs` | `(kind: string, payload?: unknown, options?: { label?: string, repoIds?: number[], dirs?: string[] }) => { id: number, status: string }` | met un job du plugin dans la file du cœur (voie séquentielle ; `repoIds` et `dirs` DÉCLARENT les dépôts et dossiers qu’il va toucher — il est alors sérialisé avec les reviews, sessions et vérifications du même clone ; sans déclaration il ne touche aucun clone et tourne avec tout) ; le journal, le « Stop » et l’écran des jobs sont ceux du cœur |
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

## Action and decoration targets

The `target` of an action or a decoration, and the object the browser passes to the render:

| Target | Where | Object received by `render(obj, ctx)` |
|---|---|---|
| `mr` | the "⋯" menu of a merge request card | the merge request (`id`, `iid`, `repo_id`, `source_branch`, `verification`… (`mr`, `mr-badge`, `session-target`, `session-target-badge`, `branch`, `branch-badge`, `verification`, `repo-sheet`, `repo-row`, `verify-launch`, `mr-detail`, `jira-ticket`)) |
| `mr-badge` | the badges of a merge request card | same |
| `session-target` | the follow-up form of a session's project | `{ task, target }` |
| `session-target-badge` | the badges of a session's project | `{ task, target }` |
| `branch` | a row of the Git explorer | `{ branch, repo_id }` |
| `branch-badge` | the badges of a Git explorer row | `{ branch, repo_id }` |
| `verification` | what follows a green verdict, in the verification report | the merge request, `ctx.verification` |
| `repo-sheet` | a repository's sheet in Settings → Repositories | the sheet (`id`, `project`, `verifiers`…) |

## Errors

Every primitive **throws** (or rejects) with a message naming the plugin and the rule it broke:

- `ctx.db.*`: `requête refusée : la table « x » n'appartient pas au plugin (préfixe attendu : plugin_<name>_)` — also for `sqlite_master`, `ATTACH`, any `PRAGMA` other than `table_info`/`index_*`/`foreign_key_list`;
- `ctx.http.router.*`: `un plugin ne monte rien hors de /api/plugins/<name>/` — a path must be relative and start with `/`;
- `ctx.settings.set`: `réglage inconnu : x`, `x : nombre attendu`, `x : adresse http(s) attendue`… (status 400 when called from the screen);
- `ctx.events.emit`: `non déclaré dans plugin.json (events.emits)`;
- `ctx.notify.push`: `genre non déclaré (notify.registerKind)`;
- `ctx.schedule`: `intervalle ≥ 1000 ms requis`;
- `ctx.exec`: `sous-commande « x » hors liste blanche`, `drapeau refusé : --exec`;
- `ctx.env.get`: `seules les variables <NAME>_* sont lisibles`;
- `ctx.ui.register*`: `id en kebab-case requis`, `target hors de …`, `déjà déclaré`;
- a `require` that leads into `src/` or into another plugin: `require('…') refusé — un plugin n'importe rien de src/, il passe par le ctx`.

An error in `activate(ctx)` puts the plugin **in error** (the message shows in Settings → Plugins) and does not stop Mergerie from starting. An `activate` that does not answer within 10 s is abandoned (and, for a third-party plugin, its worker is killed).

## Examples

- [examples/activate-minimal.js](./examples/activate-minimal.js) — the skeleton: settings, one route, a log line.
- [examples/db-migrations.js](./examples/db-migrations.js) — prefixed tables and forward-only migrations.
- [examples/events-and-schedule.js](./examples/events-and-schedule.js) — react to `session.finished`, set a periodic task, notify.
- [examples/ui-registrations.js](./examples/ui-registrations.js) — a tab, a settings sub-tab, an action on a merge request, a palette entry.

Every example is loaded by `test/unit-plugins-docs.test.js` on a `createTestContext()`: if it stops working, the CI says so.
