// Généré depuis sdk/contract.js (API 1) par sdk/scripts/generer-types.js — ne pas éditer à la main.
// Types du ctx d'un plugin Mergerie, de son manifeste et des payloads d'événements.

export type ApiVersion = '1';
export type Permission = 'events' | 'settings' | 'secrets' | 'db' | 'http' | 'sse' | 'schedule' | 'exec' | 'net' | 'repos' | 'ui.tab' | 'ui.actions' | 'ui.palette' | 'notify' | 'demo' | 'env' | 'services' | 'storage';
export type Target = 'mr' | 'mr-badge' | 'session-target' | 'session-target-badge' | 'branch' | 'branch-badge' | 'verification' | 'repo-sheet';
export type EventName = 'app.ready' | 'app.shutdown' | 'repo.deleted' | 'session.started' | 'session.finished' | 'mr.created' | 'review.completed' | 'converge.finished' | 'verify.finished' | 'jenkins.job.started' | 'jenkins.job.finished' | (string & {});

/** le serveur écoute et les plugins sont activés (cœur) */
export interface AppReadyPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  port: number;
  host: string;
  demo: boolean;
}

/** le serveur s’arrête (avant la désactivation des plugins) (cœur) */
export interface AppShutdownPayload {
  /** la version de l'événement dans le contrat */
  version: number;

}

/** un dépôt suivi est retiré de Réglages → Dépôts (cœur) */
export interface RepoDeletedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  id: number;
  project: string;
}

/** une session (codage, exploration, hors dépôt, question) commence à tourner (cœur) */
export interface SessionStartedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  kind: task" | "local" | "ask";
  id: number;
  action: string;
}

/** une session a fini de tourner (succès, erreur, arrêt, question posée) (cœur) */
export interface SessionFinishedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  kind: task" | "local" | "ask";
  id: number;
  action: string;
  status: done" | "error" | "stopped" | "needs_input";
}

/** une merge request devient connue de Mergerie (découverte sur la forge) (cœur) */
export interface MrCreatedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  mr_id: number;
  iid: number;
  project: string;
  title: string;
}

/** un rapport de review est enregistré (cœur) */
export interface ReviewCompletedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  mr_id: number;
  iid: number;
  note10: number | null;
}

/** une boucle de convergence s’arrête (cœur) */
export interface ConvergeFinishedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  mr_id: number;
  iid: number;
  status: string;
  note10: number | null;
  passes: number;
}

/** une vérification objective a rendu son verdict (ou échoué) (cœur) */
export interface VerifyFinishedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  verification_id: number;
  verdict: string;
}

/** un build est lancé depuis Mergerie (plugin jenkins) */
export interface JenkinsJobStartedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  path: string;
  since: number;
  parameters: Record<string, string>;
  url: string;
  startedBy: string;
}

/** un build lancé depuis Mergerie s’est terminé (plugin jenkins) */
export interface JenkinsJobFinishedPayload {
  /** la version de l'événement dans le contrat */
  version: number;
  path: string;
  number: number;
  result: string;
  ok: boolean;
  url: string;
  duration: number;
  startedBy: string;
}

export interface EventPayloads {
  'app.ready': AppReadyPayload;
  'app.shutdown': AppShutdownPayload;
  'repo.deleted': RepoDeletedPayload;
  'session.started': SessionStartedPayload;
  'session.finished': SessionFinishedPayload;
  'mr.created': MrCreatedPayload;
  'review.completed': ReviewCompletedPayload;
  'converge.finished': ConvergeFinishedPayload;
  'verify.finished': VerifyFinishedPayload;
  'jenkins.job.started': JenkinsJobStartedPayload;
  'jenkins.job.finished': JenkinsJobFinishedPayload;
}

export interface EmitResult { name: string; delivered: number; errors: { owner: string; error: string }[]; payload: Record<string, unknown> & { version: number }; }
export interface Repo { id: number; project: string; url: string; forge: 'gitlab' | 'github'; enabled: boolean; fetch_mrs: boolean; }
export interface PluginRequest { method: string; path: string; url: string; query: Record<string, string>; params: Record<string, string>; body: any; headers: Record<string, string | string[] | undefined>; lang: 'fr' | 'en'; }
export interface PluginReply { status(n: number): PluginReply; header(name: string, value: string): PluginReply; json(body: unknown, status?: number): PluginReply; text(body: string, status?: number): PluginReply; }
export type RouteHandler = (req: PluginRequest, reply: PluginReply) => unknown | Promise<unknown>;
export interface Router { get(path: string, handler: RouteHandler): void; post(path: string, handler: RouteHandler): void; put(path: string, handler: RouteHandler): void; delete(path: string, handler: RouteHandler): void; patch(path: string, handler: RouteHandler): void; }
export interface Statement { get(...params: unknown[]): any; all(...params: unknown[]): any[]; run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }; pluck(): Statement; raw(): Statement; }
export interface Migration { version: number; up: string | ((db: PluginDb) => void); }
export interface PluginDb { prefix: string; prepare(sql: string): Statement; exec(sql: string): void; transaction<T>(fn: () => T): T; migrate(migrations: Migration[]): number; classify(table: string, family: 'L' | 'C'): void; tables(): string[]; appliedVersions(): number[]; markApplied(version: number): void; }
export interface TabSpec { id: string; label: string; title?: string; icon?: string; position?: 'end' | `before:${string}` | `after:${string}`; foldedByDefault?: boolean; shortcut?: string | null; searchField?: string | null; list?: string | null; onboarding?: { label: string; i18n?: string } | null; badgeLegend?: { text?: string; i18n?: string } | null; i18n?: { label?: string; title?: string } | null; }
export interface SettingsTabSpec { id: string; label: string; title?: string; followsTab?: string | null; schemaForm?: boolean; i18n?: { label?: string; title?: string } | null; }
export interface PaletteEntry { label: string; ref?: string; detail?: string; text?: string; nav?: Record<string, unknown>; }
export interface SettingsSchemaProperty { type: 'string' | 'number' | 'integer' | 'boolean'; title?: string; description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: 'uri'; 'x-secret'?: boolean; 'x-bound-to'?: string; 'x-hidden'?: boolean; 'x-required'?: boolean; 'x-i18n'?: string; }
export interface SettingsSchema { type: 'object'; properties: Record<string, SettingsSchemaProperty>; }

export interface PluginManifest {
  name: string; version: string; apiVersion: ApiVersion; displayName: string; description: string; main: string;
  author?: string; homepage?: string; license?: string; builtin?: boolean; enabledByDefault?: boolean;
  permissions?: Permission[]; requires?: string[]; events?: { listens?: string[]; emits?: string[] };
  settingsSchema?: SettingsSchema;
  ui?: { styles?: string[]; i18n?: string[]; scripts?: string[]; html?: { tabs?: string[]; modals?: string[]; settings?: string[]; sprite?: string[] } };
}

/** Le ctx remis à activate(). Chaque membre n'existe que si sa permission est déclarée. */
export interface PluginContext {
  readonly name: string; readonly version: string; readonly apiVersion: ApiVersion;
  /** écrit dans le journal du serveur, préfixé du nom du plugin */
  log: (message: string, ...args) => void;
  i18n: {
    /** ajoute des libellés au dictionnaire du serveur ET du navigateur */
    register: (locale: "fr" | "en", dict: Record<string, string>) => void;
    /** traduit dans la langue courante de l’écran */
    t: (key: string, params?: Record<string, unknown>) => string;
  };
  events: {
    /** s’abonne ; rend la fonction de désabonnement — permission `events` */
    on: (name: string, handler: (payload) => void | Promise<void>) => () => void;
    /** se désabonne — permission `events` */
    off: (name: string, handler) => void;
    /** émet un événement déclaré dans plugin.json (events.emits) — permission `events` */
    emit: (name: string, payload: object) => Promise<EmitResult>;
  };
  settings: {
    /** un réglage, ou tous (défauts du schéma appliqués) — permission `settings` */
    get: (key?: string) => unknown;
    /** écrit, après validation par settingsSchema — permission `settings` */
    set: (patch: Record<string, unknown>) => Record<string, unknown>;
    /** appelé après chaque écriture (écran ou plugin) — permission `settings` */
    onChange: (handler: (settings) => void) => () => void;
  };
  secrets: {
    /** la valeur en clair (jamais rendue au navigateur) — permission `secrets` */
    get: (key: string) => string;
    /** "***" = inchangé, "" = effacé — permission `secrets` */
    set: (key: string, value: string) => void;
    /** y a-t-il une valeur ? — permission `secrets` */
    has: (key: string) => boolean;
  };
  db: {
    /** une requête sur les tables plugin_<name>_* uniquement — permission `db` */
    prepare: (sql: string) => Statement;
    /** DDL/DML sur les tables du plugin uniquement — permission `db` */
    exec: (sql: string) => void;
    /** une transaction — permission `db` */
    transaction: (fn: () => T) => T;
    /** rejoue en avant les migrations non encore appliquées ; rend le nombre jouées — permission `db` */
    migrate: (migrations: { version: number, up: string | ((db) => void) }[]) => number;
    /** déclare le classement P/L/C d’une table (V1 : L et C seulement) — permission `db` */
    classify: (table: string, family: "P" | "L" | "C") => void;
  };
  http: {
    /** get/post/put/delete/patch(path, handler(req, reply)) montés sous /api/plugins/<name>/ — permission `http` */
    router: Router;
    /** un flux SSE sous /api/plugins/<name>/ (non éprouvé en V1) — permission `sse` */
    sse: (path: string, producer: (req, send, close) => () => void) => void;
  };
  /** une tâche périodique ; arrêtée à la désactivation, jamais en recouvrement, inactive en démo sauf inDemo — permission `schedule` */
  schedule: (intervalMs: number, fn: () => void | Promise<void>, options?: { immediate?: boolean, inDemo?: boolean }) => number;
  /** arrête une tâche — permission `schedule` */
  unschedule: (id: number) => void;
  /** lance SANS shell, sous-commande en liste blanche ; `env` s’ajoute à un environnement minimal, sans PATH, HOME, LD_*, DYLD_*, NODE_OPTIONS, GIT_*, SHELL, BASH_ENV… — permission `exec` */
  exec: (bin: string, args: string[], options: { cwd?: string, timeoutMs?: number, allowlist: string[], denyFlags?: string[], env?: Record<string, string> }) => Promise<{ stdout, stderr, code }>;
  net: {
    /** HTTP(S) sortant, agent TLS du plugin (<NAME>_CA_CERT / <NAME>_INSECURE_TLS), délai 30 s — permission `net` */
    request: (url: string, options?: { method?, headers?, body? }) => Promise<{ status, statusText, headers, body }>;
  };
  repos: {
    /** les dépôts suivis sur ce poste — permission `repos` */
    list: () => Repo[];
    /** un dépôt — permission `repos` */
    byId: (id: number) => Repo | null;
    /** appelé quand un dépôt est retiré (remplace une FK ON DELETE CASCADE) — permission `repos` */
    onRemoved: (handler: (repo: { id: number, project: string }) => void) => () => void;
  };
  ui: {
    /** un onglet dans la barre (icône, position, replié d’office, recherche, raccourci, onboarding) — permission `ui.tab` */
    registerTab: (tab: TabSpec) => void;
    /** un sous-onglet de Réglages : formulaire généré du schéma + rendu libre — permission `ui.tab` */
    registerSettingsTab: (tab: SettingsTabSpec) => void;
    /** les pastilles de l’onglet (côté serveur : poussé au navigateur au prochain état) — permission `ui.tab` */
    setBadge: (tabId: string, value: { count?: number, failed?: number, warn?: number } | number | null) => void;
    /** une action sur un objet du cœur ; le rendu et le clic sont écrits côté navigateur (mergerie.ui.onAction) — permission `ui.actions` */
    registerAction: (action: { id: string, target: Target, label: string }) => void;
    /** une décoration (badge, texte) sur un objet du cœur, rendue côté navigateur — permission `ui.actions` */
    registerDecorator: (decorator: { id: string, target: Target }) => void;
    /** une section du brief « Aujourd’hui », rendue côté navigateur — permission `ui.actions` */
    registerBriefSection: (section: { id: string, label: string }) => void;
    /** un genre de lien de todo (ouvert côté navigateur) — permission `ui.actions` */
    registerLinkKind: (kind: { kind: string, label: string }) => void;
    /** des entrées de la palette Ctrl+K, calculées sans réseau — permission `ui.palette` */
    registerPaletteProvider: (provider: (query: string, limit: number) => PaletteEntry[]) => void;
  };
  notify: {
    /** un genre de notification, avec sa case dans Réglages → Notifications — permission `notify` */
    registerKind: (kind: { type: string, label: string, default: boolean }) => void;
    /** un fait, que le navigateur affiche selon les préférences — permission `notify` */
    push: (type: string, data: object) => void;
  };
  demo: {
    /** MERGERIE_DEMO=1 ? — permission `demo` */
    isDemo: () => boolean;
    /** ce que le plugin sème dans une base de démo — permission `demo` */
    seed: (fn: (ctx) => void) => void;
  };
  /** le dossier privé du plugin (<dataDir>/plugin-data/<name>/), créé à l’activation ; ni son code, ni celui d’un autre plugin — supprimé avec ses données à la désinstallation si on le demande — permission `storage` */
  dataDir: string;
  env: {
    /** une variable <NAME>_* de l’environnement du serveur — permission `env` */
    get: (name: string) => string | undefined;
  };
  services: {
    /** expose un service nommé <plugin>.<nom> — permission `services` */
    register: (name: string, fn: (payload) => unknown) => void;
    /** appelle un service du cœur ou d’un autre plugin — permission `services` */
    call: (name: string, payload?) => Promise<unknown>;
    /** le service existe-t-il ? — permission `services` */
    has: (name: string) => boolean;
  };
}

export interface PluginModule { activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void | Promise<void>; }

/** Un ctx en mémoire pour tester un plugin sans lancer Mergerie. */
export interface TestContext { ctx: PluginContext; db: any; bus: any; i18n: any; registre: any; horloge: any; log: string[]; notifications: { type: string; data: any; at: string }[]; sortie: any; http: { routes(): string[]; call(method: string, path: string, options?: { query?: Record<string, string>; body?: any; headers?: Record<string, string>; lang?: string }): Promise<{ status: number; body: any; headers?: Record<string, string> }>; express(): any }; tick(): Promise<number>; ui(): any; seed(): Promise<number>; emit(name: string, payload?: object): Promise<EmitResult>; close(): void; instance?: PluginModule; deactivate?: () => Promise<void>; }
export function createTestContext(options?: { manifest?: PluginManifest; dir?: string; permissions?: Permission[]; repos?: Partial<Repo>[]; env?: Record<string, string>; demo?: boolean; lang?: string; log?: (m: string) => void }): TestContext;
export function activatePlugin(dir: string, options?: Parameters<typeof createTestContext>[0]): Promise<TestContext>;
export function primitivesDe(ctx: PluginContext): string[];
export function validateManifest(manifest: unknown): string[];
export function readManifest(dir: string): { ok: boolean; dir: string; manifeste: PluginManifest | null; erreurs: string[] };
export const API_VERSION: '1';
export const contract: { API_VERSION: string; API_VERSIONS_SUPPORTEES: string[]; PERMISSIONS: Record<Permission, string>; CIBLES_UI: Target[]; CTX: Record<string, { permission: Permission | null; signature: string; description: string }>; EVENTS: Record<string, { version: number; source: string; when: string; payload: Record<string, string> }> };
