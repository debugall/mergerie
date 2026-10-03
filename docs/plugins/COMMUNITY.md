# Les plugins connus

> English version: [en/COMMUNITY.md](./en/COMMUNITY.md)

Pour y figurer : [PUBLISHING.md](./PUBLISHING.md). La liste n'est pas un registre — rien n'est
téléchargé automatiquement, et Mergerie ne vérifie pas le code des plugins qui y figurent : lisez
avant d'activer.

## Embarqués (livrés avec Mergerie)

| Plugin | Rôle | Permissions | apiVersion |
|---|---|---|---|
| `jenkins` (`plugins/jenkins/`) | voir et lancer des jobs Jenkins, lier un job à un dépôt, suivre la fin des builds lancés d'ici | events, settings, secrets, db, http, schedule, net, repos, ui.*, notify, demo, env, services | 1 |
| `hello` (`plugins/hello/`, désactivé d'office) | le plugin minimal produit par le générateur : journalise les événements, expose un réglage | events, settings, db, http, ui.tab | 1 |

## Tiers

| Plugin | Rôle | Licence | apiVersion | Permissions |
|---|---|---|---|---|
| [`docker`](https://gitlab.com/amady/docker-mergerie) | l'ancien onglet Docker : projets compose et dérive de configuration, conteneurs hors-compose, actions groupées, cibles Makefile, journaux en direct, alerte de chute | AGPL-3.0-only | 1 | events, db, http, sse, schedule, exec, repos, jobs, env, ui.*, notify, demo, services |
| [`jenkins-teams-notify`](https://gitlab.com/amady/jenkins-teams-notify) | publie un message dans un canal Teams quand un job Jenkins démarre ou se termine, par automatisation du navigateur (Playwright) | AGPL-3.0-only | 1 | events, settings, db, http, exec, storage, ui.tab, ui.actions, demo, services |

Les onglets Liens et Git du cœur pourraient suivre ([PLUGIN-CANDIDATES.md](./PLUGIN-CANDIDATES.md)) ; Docker l'a fait, en plugin tiers.
