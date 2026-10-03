# Known plugins

> Version française : [../COMMUNITY.md](../COMMUNITY.md)

To be listed: [PUBLISHING.md](./PUBLISHING.md). The list is not a registry — nothing is downloaded
automatically, and Mergerie does not check the code of the plugins listed here: read before enabling.

## Built-in (shipped with Mergerie)

| Plugin | Role | Permissions | apiVersion |
|---|---|---|---|
| `jenkins` (`plugins/jenkins/`) | see and run Jenkins jobs, link a job to a repository, follow the end of builds started from here | events, settings, secrets, db, http, schedule, net, repos, ui.*, notify, demo, env, services | 1 |
| `jenkins-teams-notify` (`plugins/jenkins-teams-notify/`, disabled by default) | posts a message in a Teams channel when a Jenkins job starts or finishes, by browser automation — [the page](./jenkins-teams-notify.md) | events, settings, db, http, exec, storage, ui.tab, ui.actions, demo, services | 1 |
| `hello` (`plugins/hello/`, disabled by default) | the minimal plugin produced by the generator: logs events, exposes one setting | events, settings, db, http, ui.tab | 1 |

## Third-party

_None yet._ The core's Links, Docker and Git tabs will become built-in plugins in the next versions
([../PLUGIN-CANDIDATES.md](../PLUGIN-CANDIDATES.md), in French).
