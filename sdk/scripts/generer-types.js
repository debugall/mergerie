#!/usr/bin/env node
'use strict';
/* `sdk/index.d.ts` EST GÉNÉRÉ depuis `sdk/contract.js` : les types du ctx, du manifeste et de
   chaque payload d'événement ont la même source que la documentation et que le chargeur. Un
   type ajouté à la main divergerait au premier changement ; ici, `npm run check:plugins`
   vérifie que le fichier commité est bien celui que ce script rend. */
const fs = require('fs');
const path = require('path');
const { CTX, EVENTS, PERMISSIONS, CIBLES_UI, API_VERSION } = require('../contract');

const ROOT = path.join(__dirname, '..', '..');

const tsType = (t) => String(t).replace(/^"/, '').replace(/^Record<string, string>$/, 'Record<string, string>');
const iface = (nom, champs) => `export interface ${nom} {\n  /** la version de l'événement dans le contrat */\n  version: number;\n${Object.entries(champs).map(([k, v]) => `  ${k}: ${tsType(v)};`).join('\n')}\n}`;
const nomType = (ev) => ev.split(/[.-]/).map((s) => s[0].toUpperCase() + s.slice(1)).join('') + 'Payload';

function rendre() {
  const out = [];
  out.push(`// Généré depuis sdk/contract.js (API ${API_VERSION}) par sdk/scripts/generer-types.js — ne pas éditer à la main.`);
  out.push('// Types du ctx d\'un plugin Mergerie, de son manifeste et des payloads d\'événements.');
  out.push('');
  out.push(`export type ApiVersion = '${API_VERSION}';`);
  out.push(`export type Permission = ${Object.keys(PERMISSIONS).map((p) => `'${p}'`).join(' | ')};`);
  out.push(`export type Target = ${CIBLES_UI.map((c) => `'${c}'`).join(' | ')};`);
  out.push(`export type EventName = ${Object.keys(EVENTS).map((e) => `'${e}'`).join(' | ')} | (string & {});`);
  out.push('');
  for (const [ev, e] of Object.entries(EVENTS)) out.push(`/** ${e.when} (${e.source}) */`, iface(nomType(ev), e.payload), '');
  out.push('export interface EventPayloads {');
  for (const ev of Object.keys(EVENTS)) out.push(`  '${ev}': ${nomType(ev)};`);
  out.push('}', '');
  out.push(`export interface EmitResult { name: string; delivered: number; errors: { owner: string; error: string }[]; payload: Record<string, unknown> & { version: number }; }`);
  out.push(`export interface Repo { id: number; project: string; url: string; forge: 'gitlab' | 'github'; enabled: boolean; fetch_mrs: boolean; }`);
  out.push(`export interface PluginRequest { method: string; path: string; url: string; query: Record<string, string>; params: Record<string, string>; body: any; headers: Record<string, string | string[] | undefined>; lang: 'fr' | 'en'; }`);
  out.push(`export interface PluginReply { status(n: number): PluginReply; header(name: string, value: string): PluginReply; json(body: unknown, status?: number): PluginReply; text(body: string, status?: number): PluginReply; }`);
  out.push(`export type RouteHandler = (req: PluginRequest, reply: PluginReply) => unknown | Promise<unknown>;`);
  out.push(`export interface Router { get(path: string, handler: RouteHandler): void; post(path: string, handler: RouteHandler): void; put(path: string, handler: RouteHandler): void; delete(path: string, handler: RouteHandler): void; patch(path: string, handler: RouteHandler): void; }`);
  out.push(`export interface Statement { get(...params: unknown[]): any; all(...params: unknown[]): any[]; run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }; pluck(): Statement; raw(): Statement; }`);
  out.push(`export interface Migration { version: number; up: string | ((db: PluginDb) => void); }`);
  out.push(`export interface PluginDb { prefix: string; prepare(sql: string): Statement; exec(sql: string): void; transaction<T>(fn: () => T): T; migrate(migrations: Migration[]): number; classify(table: string, family: 'L' | 'C'): void; tables(): string[]; appliedVersions(): number[]; markApplied(version: number): void; }`);
  out.push(`export interface TabSpec { id: string; label: string; title?: string; icon?: string; position?: 'end' | \`before:\${string}\` | \`after:\${string}\`; foldedByDefault?: boolean; shortcut?: string | null; searchField?: string | null; list?: string | null; onboarding?: { label: string; i18n?: string } | null; badgeLegend?: { text?: string; i18n?: string } | null; i18n?: { label?: string; title?: string } | null; }`);
  out.push(`export interface SettingsTabSpec { id: string; label: string; title?: string; followsTab?: string | null; schemaForm?: boolean; i18n?: { label?: string; title?: string } | null; }`);
  out.push(`export interface JobHandle { id: number; log(line: string): void; message(text: string): void; progress(done: number, total: number): void; exec(bin: string, args: string[], options: { cwd?: string, allowlist: string[], denyFlags?: string[], env?: Record<string, string> }): Promise<{ code: number; tail: string }>; isCancelled(): boolean; }`);
  out.push(`export interface PaletteEntry { label: string; ref?: string; detail?: string; text?: string; nav?: Record<string, unknown>; group?: string; }`);
  out.push(`export interface SettingsSchemaProperty { type: 'string' | 'number' | 'integer' | 'boolean'; title?: string; description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: 'uri'; 'x-secret'?: boolean; 'x-bound-to'?: string; 'x-hidden'?: boolean; 'x-required'?: boolean; 'x-i18n'?: string; }`);
  out.push(`export interface SettingsSchema { type: 'object'; properties: Record<string, SettingsSchemaProperty>; }`);
  out.push('');
  out.push('export interface PluginManifest {');
  out.push("  name: string; version: string; apiVersion: ApiVersion; displayName: string; description: string; main: string;");
  out.push("  author?: string; homepage?: string; license?: string; builtin?: boolean; enabledByDefault?: boolean;");
  out.push("  permissions?: Permission[]; requires?: string[]; events?: { listens?: string[]; emits?: string[] };");
  out.push("  settingsSchema?: SettingsSchema;");
  out.push("  ui?: { styles?: string[]; i18n?: string[]; scripts?: string[]; html?: { tabs?: string[]; modals?: string[]; settings?: string[]; sprite?: string[] } };");
  out.push('}', '');
  // Le ctx : regroupé par préfixe.
  const groupes = {};
  for (const [k, v] of Object.entries(CTX)) {
    const [a, b] = k.split('.');
    if (!b) { groupes[a] = groupes[a] || { direct: null, membres: {} }; groupes[a].direct = v; continue; }
    groupes[a] = groupes[a] || { direct: null, membres: {} };
    groupes[a].membres[b] = v;
  }
  out.push('/** Le ctx remis à activate(). Chaque membre n\'existe que si sa permission est déclarée. */');
  out.push('export interface PluginContext {');
  out.push('  readonly name: string; readonly version: string; readonly apiVersion: ApiVersion;');
  for (const [a, g] of Object.entries(groupes)) {
    if (g.direct && !Object.keys(g.membres).length) { out.push(`  /** ${g.direct.description}${g.direct.permission ? ` — permission \`${g.direct.permission}\`` : ''} */`, `  ${a}: ${g.direct.signature};`); continue; }
    out.push(`  ${a}: {`);
    for (const [b, v] of Object.entries(g.membres)) out.push(`    /** ${v.description}${v.permission ? ` — permission \`${v.permission}\`` : ''} */`, `    ${b}: ${v.signature === 'Router' ? 'Router' : v.signature};`);
    out.push('  };');
  }
  out.push('}', '');
  out.push('export interface PluginModule { activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void | Promise<void>; }');
  out.push('');
  out.push('/** Un ctx en mémoire pour tester un plugin sans lancer Mergerie. */');
  out.push('export interface TestContext { ctx: PluginContext; db: any; bus: any; i18n: any; registre: any; horloge: any; log: string[]; notifications: { type: string; data: any; at: string }[]; sortie: any; http: { routes(): string[]; call(method: string, path: string, options?: { query?: Record<string, string>; body?: any; headers?: Record<string, string>; lang?: string }): Promise<{ status: number; body: any; headers?: Record<string, string> }>; express(): any }; tick(): Promise<number>; ui(): any; seed(): Promise<number>; emit(name: string, payload?: object): Promise<EmitResult>; close(): void; instance?: PluginModule; deactivate?: () => Promise<void>; }');
  out.push('export function createTestContext(options?: { manifest?: PluginManifest; dir?: string; permissions?: Permission[]; repos?: Partial<Repo>[]; env?: Record<string, string>; demo?: boolean; lang?: string; log?: (m: string) => void }): TestContext;');
  out.push('export function activatePlugin(dir: string, options?: Parameters<typeof createTestContext>[0]): Promise<TestContext>;');
  out.push('export function primitivesDe(ctx: PluginContext): string[];');
  out.push('export function validateManifest(manifest: unknown): string[];');
  out.push('export function readManifest(dir: string): { ok: boolean; dir: string; manifeste: PluginManifest | null; erreurs: string[] };');
  out.push(`export const API_VERSION: '${API_VERSION}';`);
  out.push('export const contract: { API_VERSION: string; API_VERSIONS_SUPPORTEES: string[]; PERMISSIONS: Record<Permission, string>; CIBLES_UI: Target[]; CTX: Record<string, { permission: Permission | null; signature: string; description: string }>; EVENTS: Record<string, { version: number; source: string; when: string; payload: Record<string, string> }> };');
  out.push('');
  return out.join('\n');
}

module.exports = { rendre };
if (require.main === module) {
  fs.writeFileSync(path.join(ROOT, 'sdk', 'index.d.ts'), rendre());
  console.log('sdk/index.d.ts écrit');
}
