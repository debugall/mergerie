# Publishing a plugin

> Version française : [../PUBLISHING.md](../PUBLISHING.md)

## Naming

- The manifest's `name` is **kebab-case** (`a-z`, `0-9`, dashes), unique, and it is the folder name:
  `<dataDir>/plugins/<name>/`.
- The repository and the package are called **`mergerie-plugin-<name>`** (`mergerie-plugin-sonar`,
  `mergerie-plugin-argocd`). The generator does it.
- Tables are `plugin_<name>_*`, routes under `/api/plugins/<name>/`, translation keys prefixed
  `<name>.`, emitted events prefixed `<name>.`, environment variables `<NAME>_*`. This is not a
  convention: the loader enforces it.

## The expected README

A reader must find, in this order: what the plugin does (three lines); **the permissions requested and
why**, naming what is called on the network and what is run on the machine; the settings (and which
ones are secrets); how to install it (folder, git address); how to test it (`npm test`); the licence;
how to report a problem.

## Licence: AGPL, and what it implies

Mergerie is under **AGPL-3.0-only**. A plugin runs in the same process (built-in) or in a worker of the
same program (third-party) by calling its API: together with Mergerie it forms **a combined work**.
In plain words:

- a plugin you **distribute** (published, sold, handed to a client) must be under a licence compatible
  with AGPL-3.0 — AGPL-3.0 itself, GPL-3.0, or a permissive licence (MIT, BSD, Apache-2.0) *that allows*
  the combination. The generator sets `AGPL-3.0-only`;
- a plugin you keep **for yourself or your company**, without distributing it, carries no publication
  obligation;
- if you make Mergerie available **to users over the network** (a shared server), the AGPL asks that
  those users can obtain the sources of what they use — Mergerie AND the plugins running inside it.

This is not legal advice; when in doubt, ask for some. What matters to us: that a published plugin is
**readable** — its users entrust it with their tokens and their machine.

## Getting listed in COMMUNITY.md

Open a merge request on the Mergerie repository adding a line to [COMMUNITY.md](./COMMUNITY.md):
name, one sentence, the repository address, the licence, the targeted `apiVersion`, the permissions
requested. Conditions: a conforming README, a CI that runs the plugin's tests, a compatible licence,
and a `plugin.json` that `validateManifest` accepts. The list is not a registry: nothing is downloaded
automatically, and Mergerie does not check the code of the plugins listed there.

## Versioning

`version` follows **semver**. An update happens through **Rescan** (the new version is flagged) then
disable/enable; your table migrations must therefore be **additive and replayable forward**. Change
the targeted `apiVersion` when Mergerie publishes a new one ([MIGRATION.md](./MIGRATION.md)).
