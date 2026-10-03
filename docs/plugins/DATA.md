# Les données d'un plugin

> English version: [en/DATA.md](./en/DATA.md)

## Tables : un préfixe, et rien d'autre

Un plugin lit et écrit **uniquement** des tables nommées `plugin_<nom>_*` (le nom avec ses tirets
remplacés par `_` : `plugin_mon_plugin_note`). `ctx.db.prepare`, `ctx.db.exec` relisent chaque requête
avant de la jouer : un nom hors préfixe — `repo`, `config`, `sqlite_master`, la table d'un autre
plugin — est refusé avec `requête refusée : la table « x » n'appartient pas au plugin`. `ATTACH`,
`DETACH`, `VACUUM` et tout `PRAGMA` autre que `table_info`/`index_list`/`index_info`/`foreign_key_list`
sont refusés aussi. `ctx.db.tables()` liste les siennes.

**Des préfixes qui se chevauchent.** `plugin_jenkins_` est le début de `plugin_jenkins_teams_notify_` : une table appartient au plugin dont le préfixe est le **plus long** parmi les plugins **connus** (installés, actifs ou non). `jenkins` ne peut donc ni lire, ni vider, ni supprimer la table de `jenkins-teams-notify` — et désinstaller l'un avec « supprimer aussi ses données » n'emporte jamais les tables de l'autre. Un plugin installé après l'activation d'un autre compte aussi (le garde relit la liste à chaque requête). Si le plus long n'est pas (encore) installé, la table est celle du plus court.

Une **clé étrangère vers une table du cœur** n'est pas possible (et ne traverserait pas un worker) :
on s'abonne à l'événement — `ctx.repos.onRemoved(fn)` remplace un `ON DELETE CASCADE` vers `repo`.

## Migrations : en avant seulement

```js
const MIGRATIONS = [
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_x_note (…)' },
  { version: 2, up: (db) => db.exec('CREATE INDEX IF NOT EXISTS … ON plugin_x_note (at)') },
];
ctx.db.migrate(MIGRATIONS); // rend le nombre de migrations jouées
```

Chaque version jouée est notée dans `plugin_migration` ; `migrate` ne rejoue jamais une version
notée et ne redescend jamais. Une version doit être un entier ≥ 1 ; les versions sont jouées dans
l'ordre, chacune dans une transaction. À une mise à jour du plugin (« Rescanner » puis réactiver), les
nouvelles versions passent ; les anciennes tables restent.

Exemple exécuté par la CI : [examples/db-migrations.js](./examples/db-migrations.js).

## Classement P/L/C et `shared_database`

Mergerie partage le **travail accumulé** d'une équipe par un dépôt git (voir le guide, « Données
partagées ») : chaque table du cœur est classée **P** (partagée), **L** (locale au poste) ou **C**
(cache). En V1, une table de plugin est **L ou C** — `ctx.db.classify(table, 'L' | 'C')` le déclare —
et **rien d'un plugin ne part dans le dépôt d'équipe** : ni ses tables, ni ses réglages, ni ses
secrets. Le partage P d'une table de plugin n'est pas ouvert (le format du dépôt d'équipe est un
contrat entre postes, et un plugin absent chez un collègue ne saurait pas le relire).

## Réglages et secrets

Les réglages vivent dans `plugin_setting` (une ligne par clé, JSON), validés par `settingsSchema`
(`type`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `format: "uri"`, `default`).
Un réglage marqué `"x-secret": true` vit dans `plugin_secret`, n'est **jamais** rendu au navigateur
(`***` quand il existe), et `"x-bound-to": "<clé d'adresse>"` l'efface quand l'origine de cette
adresse change sans qu'il soit refourni — un jeton saisi pour un hôte ne part pas vers un autre.
`"x-hidden": true` cache un réglage du formulaire généré (un état que le plugin tient lui-même).

Ces deux tables sont de poste. Un secret ne doit jamais être recopié dans une table du plugin ni
dans un fichier : `ctx.secrets` est le seul endroit prévu pour lui.

## Rétention et désinstallation

- **Désactiver** un plugin ne touche pas à ses données : tables, réglages, secrets, migrations
  jouées restent, et réactiver les retrouve.
- **Désinstaller** (plugin tiers) supprime le dossier ; la case « supprimer aussi ses données »
  retire alors ses tables `plugin_<nom>_*`, ses réglages, ses secrets et ses migrations. Sans elle,
  tout reste pour une réinstallation.
- Le cœur n'applique **aucune rétention** aux tables d'un plugin : c'est au plugin de purger ce qu'il
  accumule (une tâche `ctx.schedule` est l'endroit naturel).
- La **sauvegarde** de Mergerie (Réglages → Sauvegarde) emporte toute la base, tables de plugins
  comprises — secrets compris : à garder comme un mot de passe.
