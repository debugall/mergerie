# Known plugins

> Version française : [../COMMUNITY.md](../COMMUNITY.md)

To be listed: [PUBLISHING.md](./PUBLISHING.md). The list is not a registry — nothing is downloaded
automatically, and Mergerie does not check the code of the plugins listed here: read before enabling.

## Built-in (shipped with Mergerie)

| Plugin | Role | Permissions | apiVersion |
|---|---|---|---|
| `jenkins` (`plugins/jenkins/`) | see and run Jenkins jobs, link a job to a repository, follow the end of builds started from here | events, settings, secrets, db, http, schedule, net, repos, ui.*, notify, demo, env, services | 1 |
| `hello` (`plugins/hello/`, disabled by default) | the minimal plugin produced by the generator: logs events, exposes one setting | events, settings, db, http, ui.tab | 1 |

## Third-party

| Plugin | Role | Licence | apiVersion | Permissions |
|---|---|---|---|---|
| [`jenkins-teams-notify`](https://gitlab.com/amady/jenkins-teams-notify) | posts a message in a Teams channel when a Jenkins job starts or finishes, by browser automation (Playwright) | AGPL-3.0-only | 1 | events, settings, db, http, exec, storage, ui.tab, ui.actions, demo, services |

The core's Links, Docker and Git tabs will become built-in plugins in the next versions
([../PLUGIN-CANDIDATES.md](../PLUGIN-CANDIDATES.md), in French).
