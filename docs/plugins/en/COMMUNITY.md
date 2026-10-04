# Known plugins

> Version française : [../COMMUNITY.md](../COMMUNITY.md)

To be listed: [PUBLISHING.md](./PUBLISHING.md). The list is not a registry — nothing is downloaded
automatically, and Mergerie does not check the code of the plugins listed here: read before enabling.

## Built-in (shipped with Mergerie)

| Plugin | Role | Permissions | apiVersion |
|---|---|---|---|
| `hello` (`plugins/hello/`, disabled by default) | the minimal plugin produced by the generator: logs events, exposes one setting | events, settings, db, http, ui.tab | 1 |

## Third-party

| Plugin | Role | Licence | apiVersion | Permissions |
|---|---|---|---|---|
| [`docker`](https://gitlab.com/amady/docker-mergerie) | the former Docker tab: compose projects and configuration drift, containers outside compose, group actions, Makefile targets, live logs, a heads-up when a container goes down | AGPL-3.0-only | 1 | events, db, http, sse, schedule, exec, repos, jobs, env, ui.*, notify, demo, services |
| [`jenkins`](https://gitlab.com/amady/jenkins-mergerie) | the former Jenkins tab: see and run jobs, link a job to a repository, follow the end of builds started from here, the buttons on merge requests, branches and sessions, the "CI red" brief section | AGPL-3.0-only | 1 | events, settings, secrets, db, http, net, schedule, repos, ui.*, notify, demo, services |
| [`links`](https://gitlab.com/amady/link-mergerie) | the former Links tab: the services × environments grid, free links, bookmark import, address pasting, the environment buttons on a merge request, a session and a Jira ticket, the palette entries | AGPL-3.0-only | 1 | db, http, repos, services, ui.*, demo |
| [`jenkins-teams-notify`](https://gitlab.com/amady/jenkins-teams-notify) | posts a message in a Teams channel when a Jenkins job starts or finishes, by browser automation (Playwright) | AGPL-3.0-only | 1 | events, settings, db, http, exec, storage, ui.tab, ui.actions, demo, services |

The core's Git tab could follow ([../PLUGIN-CANDIDATES.md](../PLUGIN-CANDIDATES.md), in French); Docker and Links already did, as third-party plugins.
