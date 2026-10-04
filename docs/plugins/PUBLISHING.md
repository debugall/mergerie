# Publier un plugin

> English version: [en/PUBLISHING.md](./en/PUBLISHING.md)

## Nommer

- Le `name` du manifeste est en **kebab-case** (`a-z`, `0-9`, tirets), unique, et c'est le nom du
  dossier : `<dataDir>/plugins/<name>/`.
- Le dépôt et le paquet s'appellent **`mergerie-plugin-<name>`** (`mergerie-plugin-sonar`,
  `mergerie-plugin-argocd`). Le générateur le fait.
- Les tables sont `plugin_<name>_*`, les routes sous `/api/plugins/<name>/`, les clés de traduction
  préfixées `<name>.`, les événements émis préfixés `<name>.`, les variables d'environnement
  `<NAME>_*`. Ce n'est pas une convention : le chargeur le fait respecter.

## Le README attendu

Un lecteur doit y trouver, dans cet ordre : ce que fait le plugin (trois lignes) ; **les permissions
demandées et pourquoi**, en nommant ce qui est appelé sur le réseau et ce qui est lancé sur la
machine ; les réglages (et lesquels sont des secrets) ; comment l'installer (dossier, adresse git) ;
comment le tester (`npm test`) ; la licence ; comment signaler un problème.

## Licence : AGPL, et ce que ça implique

Mergerie est sous **AGPL-3.0-only**. Un plugin s'exécute dans le même processus (embarqué) ou dans
un worker du même programme (tiers) en appelant son API : il forme avec Mergerie **une œuvre
combinée**. En clair :

- un plugin que vous **distribuez** (publié, vendu, remis à un client) doit être sous une licence
  compatible avec l'AGPL-3.0 — l'AGPL-3.0 elle-même, la GPL-3.0, ou une licence permissive
  (MIT, BSD, Apache-2.0) *qui permet* la combinaison. Le générateur met `AGPL-3.0-only` ;
- un plugin que vous gardez **pour vous ou votre entreprise**, sans le distribuer, n'est soumis à
  aucune obligation de publication ;
- si vous rendez Mergerie accessible **à des utilisateurs par le réseau** (un serveur partagé), l'AGPL
  demande que ces utilisateurs puissent obtenir les sources de ce qu'ils utilisent — Mergerie ET les
  plugins qui tournent dedans.

Ce n'est pas un avis juridique ; en cas de doute, demandez-en un. Ce qui compte pour nous : qu'un
plugin publié soit **lisible** — ses utilisateurs lui confient leurs jetons et leur machine.

## Être listé dans COMMUNITY.md

Ouvrez une merge request sur le dépôt de Mergerie qui ajoute une ligne à
[COMMUNITY.md](./COMMUNITY.md) : nom, une phrase, l'adresse du dépôt, la licence, l'`apiVersion`
ciblée, les permissions demandées. Conditions : un README conforme, une CI qui lance les tests du
plugin, une licence compatible, et un `plugin.json` que `validateManifest` accepte. La liste n'est
pas un registre : rien n'est téléchargé automatiquement, et Mergerie ne vérifie pas le code des
plugins qui y figurent.

## Versionner

`version` suit **semver**. Une mise à jour se fait par **Rescanner** (la nouvelle version est
signalée) puis désactiver/réactiver ; vos migrations de tables doivent donc être **additives et
rejouables en avant**. Changez l'`apiVersion` ciblée quand Mergerie en publie une nouvelle
([MIGRATION.md](./MIGRATION.md)).
