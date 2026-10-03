# Les plugins connus

> English version: [en/COMMUNITY.md](./en/COMMUNITY.md)

Pour y figurer : [PUBLISHING.md](./PUBLISHING.md). La liste n'est pas un registre — rien n'est
téléchargé automatiquement, et Mergerie ne vérifie pas le code des plugins qui y figurent : lisez
avant d'activer.

## Embarqués (livrés avec Mergerie)

| Plugin | Rôle | Permissions | apiVersion |
|---|---|---|---|
| `jenkins` (`plugins/jenkins/`) | voir et lancer des jobs Jenkins, lier un job à un dépôt, suivre la fin des builds lancés d'ici | events, settings, secrets, db, http, schedule, net, repos, ui.*, notify, demo, env, services | 1 |
| `jenkins-teams-notify` (`plugins/jenkins-teams-notify/`, désactivé d'office) | publie un message dans un canal Teams quand un job Jenkins démarre ou se termine, par automatisation du navigateur — [la page](./jenkins-teams-notify.md) | events, settings, db, http, exec, storage, ui.tab, ui.actions, demo, services | 1 |
| `hello` (`plugins/hello/`, désactivé d'office) | le plugin minimal produit par le générateur : journalise les événements, expose un réglage | events, settings, db, http, ui.tab | 1 |

## Tiers

_Aucun pour l'instant._ Les onglets Liens, Docker et Git du cœur deviendront des plugins embarqués
dans les prochaines versions ([PLUGIN-CANDIDATES.md](./PLUGIN-CANDIDATES.md)).
