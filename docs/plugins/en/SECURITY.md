# Plugin security

> Version française : [../SECURITY.md](../SECURITY.md)

## The trust model

Mergerie is a **local** tool that holds the tokens of your forge, of Jira, of your plugins, and that
drives an AI agent on your machine. A plugin is code running **inside** that tool: enabling a plugin
means trusting it as much as Mergerie — except that the API sets it the limits stated here. A
**built-in** plugin (shipped in the repository, reviewed) and a **third-party** plugin (installed by
you) have the same API; the third-party one additionally runs in an isolated **worker**, disabled by
default.

## Permissions

`plugin.json` → `permissions` declares what the plugin uses; the `ctx` it receives **only carries
those primitives**, and it is frozen. Settings → Plugins shows the permissions before activation.
`exec` (running programs) on a third-party plugin shows an explicit warning: only enable code you have
read.

| Permission | What it opens | What it does not open |
|---|---|---|
| `db` | its `plugin_<name>_*` tables | any other table (tokens are in `local_config`, unreachable), `sqlite_master`, `ATTACH` |
| `http` / `sse` | routes under `/api/plugins/<name>/`, behind the same guards as the core (origin, local token, CSP) | a path outside that prefix |
| `net` | outgoing HTTP(S) requests, with the core's TLS convention (`<NAME>_CA_CERT`, `<NAME>_INSECURE_TLS`) | — (a plugin can reach any address: reading what it calls is up to you) |
| `exec` | a binary, WITHOUT a shell, with an **allowlist of sub-commands** and refused flags (`-c`, `--exec`, `--config`, `--upload-pack`…), minimal environment, timeout | a shell, a flag that executes arbitrary code |
| `secrets` | its own secrets, masked `***` towards the screen — they can only be copied through the screen's "copy" button, on an explicit gesture, when the schema declares them `x-secret` | the core's or another plugin's secrets |
| `settings` | its settings, validated by its schema | the core's settings |
| `env` | the `<NAME>_*` variables of the server's environment | `PATH`, `HOME`, the tokens of the `.env` |
| `repos` | **reading** the repository registry (id, project, URL, forge) | forge tokens, clones |
| `events` | listening to core events, emitting its own (declared, prefixed) | emitting a core or another plugin's event |
| `schedule` | periodic tasks (≥ 1 s, never overlapping, stopped on deactivation) | — |
| `storage` | a private folder, `<dataDir>/plugin-data/<name>/` (`ctx.dataDir`): a browser profile, a cache | plugin code, the database, another plugin's folder; it enters neither the team repository nor the backup |
| `ui.*`, `notify`, `demo`, `services` | screen declarations, notifications of a declared kind, a demo seed, named services `<name>.<service>` | — |

Always present: `log`, `i18n`.

## Isolation

- A **third-party** plugin runs in one `worker_thread` per plugin; the ctx reaches it through messages
  (RPC). A plugin that throws, loops or crashes: its `activate()` is abandoned after 10 s, its worker
  killed, the plugin marked "in error" — Mergerie goes on. A route without an answer within 60 s
  returns 504.
- A **built-in** plugin runs in the process (extracting Jenkins showed this was the condition for its
  test suite to stay unchanged); it is reviewed like the core, and the CI checks
  (`npm run check:plugins`) that it imports nothing from `src/`, that its SQL stays under its prefix,
  that its routes are relative, that its front only touches the core through the kit.
- In both cases, a `require` leading into `src/` or into another plugin is **refused at load time**
  (`src/plugins/garde-require.js`).
- Event handlers run under try/catch and a timeout: a broken plugin delays neither the core nor the
  other plugins by more than 30 s per event.

## What a plugin CANNOT do

- read or write a core table, the forge, Jira or another plugin's tokens;
- mount a route outside `/api/plugins/<name>/`, serve a file outside its `ui/` folder;
- import a Mergerie module or another plugin;
- run a program through a shell, or with a flag that executes arbitrary code (`exec`);
- emit an event it has not declared, or that does not carry its prefix;
- write into the team's shared data repository (its tables are local);
- outlive its deactivation: subscriptions, tasks, routes, screen declarations, dictionaries and
  services are removed; only its data stays;
- enable itself (a third-party plugin and a built-in one are both disabled on a first installation — a built-in manifest could say
  `enabledByDefault: true`, none does; a machine that upgrades keeps enabled the ones it already had).

## The author's responsibilities

- declare the **minimum** permissions, and say in the README what is called on the network and why;
- never copy a secret outside `ctx.secrets`, never log it;
- escape (`esc`) anything coming from elsewhere before inserting it into the page, pass URLs through
  `safeUrl`, never write attribute handlers or inline `<script>`;
- treat what arrives through an event or a request as **data**, never as an instruction;
- keep `version` (semver) and `apiVersion` up to date, test with `createTestContext`.

## Reporting a vulnerability

A flaw in the plugin API or in the loader is reported **privately** to `security@mergerie.dev` (see
[SECURITY.md](../../../SECURITY.md) at the root: description, reproduction steps, version). A flaw in
a third-party plugin is reported to its author; if it endangers Mergerie through the API, write to us too.
