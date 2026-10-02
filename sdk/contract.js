'use strict';
/* LE CONTRAT DE L'API DE PLUGIN — LA SOURCE UNIQUE.
 *
 * Tout ce qu'un plugin peut toucher est décrit ICI, une fois : la version de l'API, les
 * permissions, chaque primitive du ctx (sa permission, sa signature), chaque événement (sa
 * version, son payload). Le cœur (`src/core/events.js`, `src/plugins/`) lit ce fichier pour
 * refuser ce qui n'y est pas ; `sdk/scripts/generer-types.js` en dérive `index.d.ts` ; les
 * tests de documentation (`test/unit-plugins-docs.test.js`) vérifient que `docs/plugins/EVENTS.md`
 * et `API.md` nomment exactement ce qui est ici. La doc et le code ne peuvent donc pas diverger :
 * ils ont la même source.
 *
 * AUCUNE DÉPENDANCE : ce fichier est lu par le serveur, par le SDK publié sur npm et par un
 * worker de plugin tiers. Du JSON avec des commentaires, rien de plus. */

/* La version de l'API ciblée par un `plugin.json` (`apiVersion`). Rupture = incrément, avec
   la période de compatibilité documentée dans docs/plugins/MIGRATION.md. */
const API_VERSION = '1';
const API_VERSIONS_SUPPORTEES = ['1'];

/* Les permissions déclarables dans `plugin.json` (`permissions`). Le ctx remis au plugin ne
   contient QUE les primitives couvertes par ses permissions. `exec` déclenche un avertissement
   explicite dans Réglages → Plugins pour un plugin tiers. */
const PERMISSIONS = {
  events: 'écouter et émettre des événements (ctx.events)',
  settings: 'lire et écrire ses réglages, validés par settingsSchema (ctx.settings)',
  secrets: 'lire et écrire ses secrets, masqués comme ceux du cœur (ctx.secrets)',
  db: 'ses tables SQLite, préfixées plugin_<name>_ (ctx.db)',
  http: 'des routes HTTP sous /api/plugins/<name>/ (ctx.http.router)',
  sse: 'un flux Server-Sent Events sous /api/plugins/<name>/ (ctx.http.sse)',
  schedule: 'des tâches périodiques (ctx.schedule / ctx.unschedule)',
  exec: 'lancer un binaire SANS shell, avec liste blanche de sous-commandes (ctx.exec)',
  net: 'des requêtes HTTP(S) sortantes, avec la convention TLS du cœur (ctx.net)',
  repos: 'lire le registre des dépôts suivis (ctx.repos)',
  'ui.tab': 'un onglet, un sous-onglet de réglages, des pastilles (ctx.ui.registerTab, registerSettingsTab, setBadge)',
  'ui.actions': 'des actions et décorations sur les objets du cœur (ctx.ui.registerAction, registerDecorator, registerBriefSection, registerLinkKind)',
  'ui.palette': 'des entrées dans la palette Ctrl+K (ctx.ui.registerPaletteProvider)',
  notify: 'des notifications bureau (ctx.notify)',
  demo: 'semer le mode démo (ctx.demo)',
  env: 'lire les variables d’environnement préfixées par son nom (ctx.env)',
  services: 'exposer et appeler des services nommés entre plugins et cœur (ctx.services)',
};

/* Les cibles d'une action ou d'une décoration (`target`). */
const CIBLES_UI = ['mr', 'mr-badge', 'session-target', 'branch', 'verification', 'repo-sheet'];

/* LES PRIMITIVES DU CTX — la liste fermée. Une primitive absente d'ici n'existe pas, et le
   chargeur refuse d'en exposer une autre. `permission: null` = toujours présente. */
const CTX = {
  'log': { permission: null, signature: '(message: string, ...args) => void', description: 'écrit dans le journal du serveur, préfixé du nom du plugin' },
  'i18n.register': { permission: null, signature: '(locale: "fr" | "en", dict: Record<string, string>) => void', description: 'ajoute des libellés au dictionnaire du serveur ET du navigateur' },
  'i18n.t': { permission: null, signature: '(key: string, params?: Record<string, unknown>) => string', description: 'traduit dans la langue courante de l’écran' },
  'events.on': { permission: 'events', signature: '(name: string, handler: (payload) => void | Promise<void>) => () => void', description: 's’abonne ; rend la fonction de désabonnement' },
  'events.off': { permission: 'events', signature: '(name: string, handler) => void', description: 'se désabonne' },
  'events.emit': { permission: 'events', signature: '(name: string, payload: object) => Promise<EmitResult>', description: 'émet un événement déclaré dans plugin.json (events.emits)' },
  'settings.get': { permission: 'settings', signature: '(key?: string) => unknown', description: 'un réglage, ou tous (défauts du schéma appliqués)' },
  'settings.set': { permission: 'settings', signature: '(patch: Record<string, unknown>) => Record<string, unknown>', description: 'écrit, après validation par settingsSchema' },
  'settings.onChange': { permission: 'settings', signature: '(handler: (settings) => void) => () => void', description: 'appelé après chaque écriture (écran ou plugin)' },
  'secrets.get': { permission: 'secrets', signature: '(key: string) => string', description: 'la valeur en clair (jamais rendue au navigateur)' },
  'secrets.set': { permission: 'secrets', signature: '(key: string, value: string) => void', description: '"***" = inchangé, "" = effacé' },
  'secrets.has': { permission: 'secrets', signature: '(key: string) => boolean', description: 'y a-t-il une valeur ?' },
  'db.prepare': { permission: 'db', signature: '(sql: string) => Statement', description: 'une requête sur les tables plugin_<name>_* uniquement' },
  'db.exec': { permission: 'db', signature: '(sql: string) => void', description: 'DDL/DML sur les tables du plugin uniquement' },
  'db.transaction': { permission: 'db', signature: '(fn: () => T) => T', description: 'une transaction' },
  'db.migrate': { permission: 'db', signature: '(migrations: { version: number, up: string | ((db) => void) }[]) => number', description: 'rejoue en avant les migrations non encore appliquées ; rend le nombre jouées' },
  'db.classify': { permission: 'db', signature: '(table: string, family: "P" | "L" | "C") => void', description: 'déclare le classement P/L/C d’une table (V1 : L et C seulement)' },
  'http.router': { permission: 'http', signature: 'Router', description: 'get/post/put/delete/patch(path, handler(req, reply)) montés sous /api/plugins/<name>/' },
  'http.sse': { permission: 'sse', signature: '(path: string, producer: (req, send, close) => () => void) => void', description: 'un flux SSE sous /api/plugins/<name>/ (non éprouvé en V1)' },
  'schedule': { permission: 'schedule', signature: '(intervalMs: number, fn: () => void | Promise<void>, options?: { immediate?: boolean, inDemo?: boolean }) => number', description: 'une tâche périodique ; arrêtée à la désactivation, jamais en recouvrement, inactive en démo sauf inDemo' },
  'unschedule': { permission: 'schedule', signature: '(id: number) => void', description: 'arrête une tâche' },
  'exec': { permission: 'exec', signature: '(bin: string, args: string[], options: { cwd?: string, timeoutMs?: number, allowlist: string[], denyFlags?: string[] }) => Promise<{ stdout, stderr, code }>', description: 'lance SANS shell, sous-commande en liste blanche (non éprouvé en V1)' },
  'net.request': { permission: 'net', signature: '(url: string, options?: { method?, headers?, body? }) => Promise<{ status, statusText, headers, body }>', description: 'HTTP(S) sortant, agent TLS du plugin (<NAME>_CA_CERT / <NAME>_INSECURE_TLS), délai 30 s' },
  'repos.list': { permission: 'repos', signature: '() => Repo[]', description: 'les dépôts suivis sur ce poste' },
  'repos.byId': { permission: 'repos', signature: '(id: number) => Repo | null', description: 'un dépôt' },
  'repos.onRemoved': { permission: 'repos', signature: '(handler: (repo: { id: number, project: string }) => void) => () => void', description: 'appelé quand un dépôt est retiré (remplace une FK ON DELETE CASCADE)' },
  'ui.registerTab': { permission: 'ui.tab', signature: '(tab: TabSpec) => void', description: 'un onglet dans la barre (icône, position, replié d’office, recherche, raccourci, onboarding)' },
  'ui.registerSettingsTab': { permission: 'ui.tab', signature: '(tab: SettingsTabSpec) => void', description: 'un sous-onglet de Réglages : formulaire généré du schéma + rendu libre' },
  'ui.setBadge': { permission: 'ui.tab', signature: '(tabId: string, value: { count?: number, failed?: number, warn?: number } | number | null) => void', description: 'les pastilles de l’onglet (côté serveur : poussé au navigateur au prochain état)' },
  'ui.registerAction': { permission: 'ui.actions', signature: '(action: { id: string, target: Target, label: string }) => void', description: 'une action sur un objet du cœur ; le rendu et le clic sont écrits côté navigateur (mergerie.ui.onAction)' },
  'ui.registerDecorator': { permission: 'ui.actions', signature: '(decorator: { id: string, target: Target }) => void', description: 'une décoration (badge, texte) sur un objet du cœur, rendue côté navigateur' },
  'ui.registerBriefSection': { permission: 'ui.actions', signature: '(section: { id: string, label: string }) => void', description: 'une section du brief « Aujourd’hui », rendue côté navigateur' },
  'ui.registerLinkKind': { permission: 'ui.actions', signature: '(kind: { kind: string, label: string }) => void', description: 'un genre de lien de todo (ouvert côté navigateur)' },
  'ui.registerPaletteProvider': { permission: 'ui.palette', signature: '(provider: (query: string, limit: number) => PaletteEntry[]) => void', description: 'des entrées de la palette Ctrl+K, calculées sans réseau' },
  'notify.registerKind': { permission: 'notify', signature: '(kind: { type: string, label: string, default: boolean }) => void', description: 'un genre de notification, avec sa case dans Réglages → Notifications' },
  'notify.push': { permission: 'notify', signature: '(type: string, data: object) => void', description: 'un fait, que le navigateur affiche selon les préférences' },
  'demo.isDemo': { permission: 'demo', signature: '() => boolean', description: 'MERGERIE_DEMO=1 ?' },
  'demo.seed': { permission: 'demo', signature: '(fn: (ctx) => void) => void', description: 'ce que le plugin sème dans une base de démo' },
  'env.get': { permission: 'env', signature: '(name: string) => string | undefined', description: 'une variable <NAME>_* de l’environnement du serveur' },
  'services.register': { permission: 'services', signature: '(name: string, fn: (payload) => unknown) => void', description: 'expose un service nommé <plugin>.<nom>' },
  'services.call': { permission: 'services', signature: '(name: string, payload?) => Promise<unknown>', description: 'appelle un service du cœur ou d’un autre plugin' },
  'services.has': { permission: 'services', signature: '(name: string) => boolean', description: 'le service existe-t-il ?' },
};

/* LES ÉVÉNEMENTS. `version` entre dans chaque payload ; `payload` décrit les champs. Les
   événements d'un plugin (`<plugin>.*`) se déclarent dans son plugin.json et s'ajoutent ici
   quand le plugin est embarqué, pour que la documentation les porte aussi. */
const EVENTS = {
  'app.ready': { version: 1, source: 'cœur', when: 'le serveur écoute et les plugins sont activés', payload: { port: 'number', host: 'string', demo: 'boolean' } },
  'app.shutdown': { version: 1, source: 'cœur', when: 'le serveur s’arrête (avant la désactivation des plugins)', payload: {} },
  'repo.deleted': { version: 1, source: 'cœur', when: 'un dépôt suivi est retiré de Réglages → Dépôts', payload: { id: 'number', project: 'string' } },
  'session.started': { version: 1, source: 'cœur', when: 'une session (codage, exploration, hors dépôt, question) commence à tourner', payload: { kind: '"task" | "local" | "ask"', id: 'number', action: 'string' } },
  'session.finished': { version: 1, source: 'cœur', when: 'une session a fini de tourner (succès, erreur, arrêt, question posée)', payload: { kind: '"task" | "local" | "ask"', id: 'number', action: 'string', status: '"done" | "error" | "stopped" | "needs_input"' } },
  'mr.created': { version: 1, source: 'cœur', when: 'une merge request devient connue de Mergerie (découverte sur la forge)', payload: { mr_id: 'number', iid: 'number', project: 'string', title: 'string' } },
  'review.completed': { version: 1, source: 'cœur', when: 'un rapport de review est enregistré', payload: { mr_id: 'number', iid: 'number', note10: 'number | null' } },
  'converge.finished': { version: 1, source: 'cœur', when: 'une boucle de convergence s’arrête', payload: { mr_id: 'number', iid: 'number', status: 'string', note10: 'number | null', passes: 'number' } },
  'verify.finished': { version: 1, source: 'cœur', when: 'une vérification objective a rendu son verdict (ou échoué)', payload: { verification_id: 'number', verdict: 'string' } },
  'jenkins.job.started': { version: 1, source: 'plugin jenkins', when: 'un build est lancé depuis Mergerie', payload: { path: 'string', since: 'number', parameters: 'Record<string, string>' } },
  'jenkins.job.finished': { version: 1, source: 'plugin jenkins', when: 'un build lancé depuis Mergerie s’est terminé', payload: { path: 'string', number: 'number', result: 'string', ok: 'boolean' } },
};

/* Les champs obligatoires et la forme de `plugin.json`. */
const MANIFESTE = {
  requis: ['name', 'version', 'apiVersion', 'displayName', 'description', 'main'],
  optionnels: ['author', 'homepage', 'license', 'ui', 'events', 'requires', 'permissions', 'settingsSchema', 'i18n', 'builtin'],
  nom: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  semver: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
};

module.exports = { API_VERSION, API_VERSIONS_SUPPORTEES, PERMISSIONS, CIBLES_UI, CTX, EVENTS, MANIFESTE };
