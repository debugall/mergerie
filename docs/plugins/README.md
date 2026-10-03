# Les plugins de Mergerie — en 5 minutes

> English version: [en/README.md](./en/README.md)

Un **plugin** est un dossier avec un `plugin.json` et un `index.js` qui exporte `activate(ctx)` et
`deactivate()`. Il ajoute à Mergerie ce que le cœur ne fait pas — un onglet, des actions sur les
merge requests, une tâche de fond, une intégration — **sans toucher au code du cœur** : tout ce qu'il
peut faire passe par le `ctx`, une liste fermée de primitives (réglages, secrets, tables, routes,
tâches, événements, écran…). Un plugin embarqué dans le dépôt (`plugins/jenkins`, `plugins/hello`)
et un plugin que vous installez chez vous ont **exactement les mêmes droits**.

## Installer `hello`, l'activer, modifier un réglage

`hello` est livré avec Mergerie, désactivé d'office. Il journalise chaque événement du cœur
qu'il reçoit et expose un réglage.

1. Ouvrez **Réglages → Plugins**. La liste montre chaque plugin : version, état, permissions,
   dépendances, événements écoutés et émis.
2. Sur **Hello**, cliquez **Activer**. La page se recharge — Mergerie ne redémarre pas — et un onglet
   **Hello** apparaît dans la barre (replié d'office : Réglages → Général → Menus pour l'afficher).
3. Toujours dans Réglages → Plugins, le formulaire de Hello (généré depuis son `settingsSchema`)
   porte un champ **Salutation**. Changez-le, **Enregistrer** : `GET /api/plugins/hello/ping` répond
   avec la nouvelle valeur, et l'onglet l'affiche.
4. Lancez une session, une review, une vérification : l'onglet Hello liste les événements reçus
   (`session.finished`, `review.completed`…), avec leur payload et sa version.
5. **Désactiver** retire l'onglet, les routes, les abonnements et la tâche de fond ; les données du
   plugin (sa table, son réglage) restent. **Activer** les retrouve.

## Installer un plugin tiers

Trois voies, aucune ne redémarre Mergerie :

- **Un dossier déposé** dans `<dataDir>/plugins/<nom>/` (par défaut `~/.mergerie/data/plugins/`),
  puis **Rescanner** dans Réglages → Plugins.
- **« Installer un plugin » → dossier local** : le manifeste est vérifié, le dossier copié.
- **« Installer un plugin » → adresse git** : clone sans shell (branche ou tag optionnels), manifeste
  vérifié avant la copie.

Un plugin tiers est **désactivé** après installation, tourne dans **son propre worker** (un plugin qui
plante ne tue jamais le serveur), et ses permissions s'affichent avant qu'on l'active — `exec`
(lancer des programmes) déclenche un avertissement explicite. **Désinstaller** supprime le dossier et
propose de garder ou de supprimer ses données. Il n'y a ni registre central ni téléchargement
automatique.

## Lire ensuite

| Page | Pour |
|---|---|
| [GETTING-STARTED.md](./GETTING-STARTED.md) | créer son premier plugin avec le générateur, le tester sans Mergerie, l'installer |
| [API.md](./API.md) | la référence du `ctx`, primitive par primitive, avec permission, signature, erreurs |
| [EVENTS.md](./EVENTS.md) | chaque événement, quand il est émis, son payload et sa version |
| [UI.md](./UI.md) | ce qu'un plugin ajoute à l'écran et le kit `window.mergerie` |
| [DATA.md](./DATA.md) | tables, préfixe, migrations, classement P/L/C, rétention |
| [SECURITY.md](./SECURITY.md) | le modèle de confiance, ce qu'un plugin ne peut pas faire |
| [PUBLISHING.md](./PUBLISHING.md) | nommer, documenter, publier (licence AGPL), être listé |
| [MIGRATION.md](./MIGRATION.md) | comment l'`apiVersion` évolue, et ce que le cœur garantit |
| [COMMUNITY.md](./COMMUNITY.md) | les plugins connus |

Pour l'histoire du chantier : [JENKINS-INVENTORY.md](./JENKINS-INVENTORY.md) (l'inventaire qui a
dimensionné l'API) et [PLUGIN-CANDIDATES.md](./PLUGIN-CANDIDATES.md) (Liens, Docker et Git, les
prochains).
