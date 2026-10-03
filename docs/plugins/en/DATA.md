# A plugin's data

> Version française : [../DATA.md](../DATA.md)

## Tables: a prefix, and nothing else

A plugin reads and writes **only** tables named `plugin_<name>_*` (the name with its dashes turned
into `_`: `plugin_my_plugin_note`). `ctx.db.prepare` and `ctx.db.exec` re-read every query before
running it: a name outside the prefix — `repo`, `config`, `sqlite_master`, another plugin's table — is
refused with `requête refusée : la table « x » n'appartient pas au plugin`. `ATTACH`, `DETACH`,
`VACUUM` and any `PRAGMA` other than `table_info`/`index_list`/`index_info`/`foreign_key_list` are
refused too. `ctx.db.tables()` lists its own.

A **foreign key to a core table** is not possible (and would not cross a worker): subscribe to the
event instead — `ctx.repos.onRemoved(fn)` replaces an `ON DELETE CASCADE` to `repo`.

## Migrations: forward only

```js
const MIGRATIONS = [
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_x_note (…)' },
  { version: 2, up: (db) => db.exec('CREATE INDEX IF NOT EXISTS … ON plugin_x_note (at)') },
];
ctx.db.migrate(MIGRATIONS); // returns the number of migrations applied
```

Every applied version is recorded in `plugin_migration`; `migrate` never replays a recorded version
and never goes back. A version must be an integer ≥ 1; versions run in order, each in a transaction.
On a plugin update ("Rescan" then re-enable), the new versions run; old tables stay.

Example run by the CI: [../examples/db-migrations.js](../examples/db-migrations.js).

## P/L/C classification and `shared_database`

Mergerie shares a team's **accumulated work** through a git repository (see the guide, "Shared data"):
every core table is classified **P** (shared), **L** (local to the machine) or **C** (cache). In V1 a
plugin table is **L or C** — `ctx.db.classify(table, 'L' | 'C')` declares it — and **nothing from a
plugin goes into the team repository**: neither its tables, nor its settings, nor its secrets. Sharing
(P) a plugin table is not open (the team repository format is a contract between machines, and a plugin
missing on a colleague's machine could not read it back).

## Settings and secrets

Settings live in `plugin_setting` (one row per key, JSON), validated by `settingsSchema` (`type`,
`enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `format: "uri"`, `default`). A
setting marked `"x-secret": true` lives in `plugin_secret`, is **never** sent to the browser (`***`
when present), and `"x-bound-to": "<address key>"` clears it when that address's origin changes without
the secret being provided again — a token typed for one host does not leave for another.
`"x-hidden": true` hides a setting from the generated form (state the plugin keeps itself).

Both tables are local to the machine. A secret must never be copied into a plugin table or a file:
`ctx.secrets` is the only place meant for it.

## Retention and uninstall

- **Disabling** a plugin does not touch its data: tables, settings, secrets, applied migrations stay,
  and re-enabling finds them.
- **Uninstalling** (third-party plugin) deletes the folder; the "also delete its data" box then
  removes its `plugin_<name>_*` tables, its settings, its secrets and its migrations. Without it,
  everything stays for a reinstall.
- The core applies **no retention** to a plugin's tables: purging what it accumulates is the plugin's
  job (a `ctx.schedule` task is the natural place).
- Mergerie's **backup** (Settings → Backup) carries the whole database, plugin tables included —
  secrets included: keep it like a password.
