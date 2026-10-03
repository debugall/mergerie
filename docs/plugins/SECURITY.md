# Sécurité des plugins

> English version: [en/SECURITY.md](./en/SECURITY.md)

## Le modèle de confiance

Mergerie est un outil **local** qui tient les jetons de votre forge, de Jira, de vos plugins, et qui
pilote un agent IA sur votre machine. Un plugin est du code qui tourne **dans** cet outil : activer un
plugin, c'est lui faire confiance autant qu'à Mergerie — à ceci près que l'API lui pose des limites
dites ici. Un plugin **embarqué** (livré dans le dépôt, relu en revue) et un plugin **tiers** (installé
par vous) ont la même API ; le tiers tourne en plus dans un **worker** isolé, désactivé d'office.

## Permissions

`plugin.json` → `permissions` déclare ce que le plugin utilise ; le `ctx` qu'il reçoit **ne porte que
ces primitives**, et il est gelé. Réglages → Plugins affiche les permissions avant l'activation.
`exec` (lancer des programmes) sur un plugin tiers affiche un avertissement explicite : n'activez que
ce dont vous avez lu le code.

| Permission | Ce qu'elle ouvre | Ce qu'elle n'ouvre pas |
|---|---|---|
| `db` | ses tables `plugin_<nom>_*` | toute autre table (les jetons sont dans `local_config`, inaccessible), `sqlite_master`, `ATTACH` |
| `http` / `sse` | des routes sous `/api/plugins/<nom>/`, derrière les mêmes gardes que le cœur (origine, jeton local, CSP) | un chemin hors de ce préfixe |
| `net` | des requêtes HTTP(S) sortantes, avec la convention TLS du cœur (`<NOM>_CA_CERT`, `<NOM>_INSECURE_TLS`) | — (un plugin peut joindre n'importe quelle adresse : c'est à vous de lire ce qu'il appelle) |
| `exec` | un binaire, SANS shell, avec une **liste blanche de sous-commandes** et des drapeaux refusés (`-c`, `--exec`, `--config`, `--upload-pack`…), environnement minimal, délai | un shell, un drapeau à exécution arbitraire |
| `secrets` | ses propres secrets, masqués `***` vers l'écran | les secrets du cœur ou d'un autre plugin |
| `settings` | ses réglages, validés par son schéma | les réglages du cœur |
| `env` | les variables `<NOM>_*` de l'environnement du serveur | `PATH`, `HOME`, les jetons du `.env` |
| `repos` | la **lecture** du registre des dépôts (id, projet, URL, forge) | les jetons de forge, les clones |
| `events` | écouter les événements du cœur, émettre les siens (déclarés, préfixés) | émettre un événement du cœur ou d'un autre plugin |
| `schedule` | des tâches périodiques (≥ 1 s, jamais en recouvrement, arrêtées à la désactivation) | — |
| `storage` | un dossier privé, `<dataDir>/plugin-data/<name>/` (`ctx.dataDir`) : un profil de navigateur, un cache | le code des plugins, la base, le dossier d'un autre plugin ; il n'entre ni dans le dépôt d'équipe ni dans la sauvegarde |
| `ui.*`, `notify`, `demo`, `services` | des déclarations d'écran, des notifications d'un genre déclaré, une seed de démo, des services nommés `<nom>.<service>` | — |

Toujours présents : `log`, `i18n`.

## Isolation

- Un plugin **tiers** tourne dans un `worker_thread` par plugin ; le ctx lui parvient par messages
  (RPC). Un plugin qui lève, qui boucle ou qui plante : son `activate()` est abandonné après 10 s, son
  worker tué, le plugin marqué « en erreur » — Mergerie continue. Une route sans réponse en 60 s rend 504.
- Un plugin **embarqué** tourne dans le processus (l'extraction de Jenkins a montré que c'était la
  condition pour que sa suite de tests reste inchangée) ; il est relu en revue comme le cœur, et la
  CI vérifie (`npm run check:plugins`) qu'il n'importe rien de `src/`, que son SQL reste sous son
  préfixe, que ses routes sont relatives, que son front ne touche le cœur que par le kit.
- Dans les deux cas, un `require` qui mène dans `src/` ou dans un autre plugin est **refusé au
  chargement** (`src/plugins/garde-require.js`).
- Les handlers d'événements tournent sous try/catch et délai : un plugin en panne ne retarde ni le
  cœur ni les autres plugins de plus de 30 s par événement.

## Ce qu'un plugin ne peut PAS faire

- lire ou écrire une table du cœur, les jetons de la forge, de Jira, d'un autre plugin ;
- monter une route hors de `/api/plugins/<nom>/`, servir un fichier hors de son dossier `ui/` ;
- importer un module de Mergerie ou d'un autre plugin ;
- lancer un programme par un shell, ou avec un drapeau à exécution arbitraire (`exec`) ;
- émettre un événement qu'il n'a pas déclaré, ou qui ne porte pas son préfixe ;
- écrire dans le dépôt de données partagé de l'équipe (ses tables sont de poste) ;
- survivre à sa désactivation : abonnements, tâches, routes, déclarations d'écran, dictionnaires et
  services sont retirés ; seules ses données restent ;
- s'activer tout seul (un tiers et un embarqué sont désactivés sur une première installation — un manifeste embarqué pourrait
  dire `enabledByDefault: true`, aucun ne le fait ; un poste qui monte de version garde activés ceux qu'il avait).

## Responsabilités de l'auteur

- déclarer le **minimum** de permissions, et dire dans le README ce qui est appelé sur le réseau et
  pourquoi ;
- ne jamais recopier un secret hors de `ctx.secrets`, ne jamais le journaliser ;
- échapper (`esc`) tout ce qui vient d'ailleurs avant de l'insérer dans la page, passer les URL par
  `safeUrl`, ne jamais écrire de gestionnaire en attribut ni de `<script>` en ligne ;
- traiter ce qui arrive par un événement ou une requête comme une **donnée**, jamais comme une
  instruction ;
- tenir sa `version` (semver) et son `apiVersion` à jour, tester avec `createTestContext`.

## Signaler une faille

Une faille dans l'API des plugins ou dans le chargeur se signale **en privé** à
`security@mergerie.dev` (voir [SECURITY.md](../../SECURITY.md) à la racine : description, étapes de
reproduction, version). Une faille dans un plugin tiers se signale à son auteur ; si elle met
Mergerie en danger par l'API, écrivez-nous aussi.
