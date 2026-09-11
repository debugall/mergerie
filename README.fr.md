> 🇬🇧 **English:** [README.md](./README.md) · 📖 [Guide complet](./docs/guide.fr.md) · 🗺️ [Roadmap](./ROADMAP.md)

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/images/wordmark-dark.svg" />
    <img src="public/images/wordmark.svg" alt="Mergerie" width="320" />
  </picture>
</h1>

[![CI](https://github.com/debugall/mergerie/actions/workflows/ci.yml/badge.svg)](https://github.com/debugall/mergerie/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

**From prompt to merge — un cockpit de dev local, assisté par IA, pour GitLab et GitHub.**

Outil local (mono-utilisateur) pour **reviewer les merge requests GitLab et les pull requests GitHub** assisté par IA, **piloter des
sessions de développement** automatisées (l'IA code, commite, pousse, ouvre et merge les MR) et **explorer
du code** en lecture seule pour répondre à une question, via un CLI d'agent (`copilot` / `claude`) et le
skill `git-review`.

Dans toute la documentation, **« MR »** désigne indifféremment une *merge request* GitLab ou une
*pull request* GitHub : les écrans et les actions sont les mêmes.

Tout tourne **en local** : un serveur Node + SQLite + une interface web. Aucune donnée n'est envoyée
ailleurs que vers les services que **tu** configures. L'IA **prépare** (review, corrections, convergence),
c'est **toi** qui merges. Voir [PLAN.md](./PLAN.md) pour l'architecture détaillée, et le
**[Guide complet](./docs/guide.fr.md)** pour le détail de chaque onglet.

## Démarrage

Nécessite **Node 22.9+**.

```bash
npm install
npm start          # http://localhost:4319
```

Optionnel, pour la **dictée vocale** : `sh scripts/install-whisper.sh` (macOS/Linux) ou le bouton
**Installer** de Réglages → Dictée vocale. Rien d'autre n'est nécessaire pour faire tourner l'outil.

Au premier lancement, l'onglet **Reviews** affiche les trois étapes de démarrage, chacune avec son
bouton. Elles correspondent à l'onglet **Réglages** :
1. **Git** — URL GitLab + **access token** (PAT scopes `api` + `read_repository`) et/ou **token GitHub** (scope `repo`), dossier de clonage. Un bouton **Tester la connexion** par forge valide le tout. *(URL Jira et connexion Jira optionnelles : onglet **Jira**.)*
2. **Dépôts** — ajoute-les un par un, ou en masse **depuis GitLab** ou **depuis GitHub** (coche tes projets). Laisse le **pattern vide** pour prendre **toutes** les MR, ou mets un fragment (`PROJ-`) pour ne garder que ces branches. La case **récupérer les MR**, cochée par défaut, se décoche pour les dépôts dont tu ne relis pas les merge requests : ils restent utilisables pour le reste (git, sessions de codage), et les MR déjà récupérées restent dans la file.
3. De retour sur **Reviews**, `Chercher les nouvelles MR` remplit la liste.

## Mode démo (voir l'outil en 30 s, sans rien configurer)

```bash
npm run demo          # http://localhost:4319
```

Sème une base **fictive mais réaliste** (MR à traiter, rapports notés, suivi de résolution, statistiques,
coût en tokens, sessions Dev IA, codage hors dépôt) dans `data-demo/` — **isolée** de ta vraie base
`data/` — puis lance l'outil dessus, en dry-run et **sans aucune connexion à une forge ni token**. Idéal pour
découvrir l'outil : **zéro configuration**. La démo inclut une **MR convergée** (5,8 → 7,1 → 8,4) pour voir
la feature *Converger* en action, et une **session reliée à sa MR** — le chemin *du prompt à la MR convergée*.
Elle porte aussi des **vérifications objectives** déjà rendues (dont une rouge, détaillée commande par commande)
et un **lot** de merge requests vérifiées ensemble.
Une session de codage y porte **trois itérations avec chacune son diff**, de quoi voir la relecture d'un seul suivi sans agent.
Côté **Agents**, elle porte les trois agents livrés, deux **agents de domaine** avec leur connaissance
versionnée — dont une version en attente de validation, un chemin non vérifié et un écart signalé — et un
run déclenché par un **horaire** qui a réécrit une page de notes.

*(Enregistrer une vidéo de présentation : voir le [Guide complet → Mode démo](./docs/guide.fr.md#enregistrer-une-vidéo-de-présentation-prête-pour-youtube).)*

## Les onglets

**Dix onglets**, dans une barre latérale — détail de chacun dans le **[Guide complet](./docs/guide.fr.md#les-onglets-en-détail)**, et la **[vérification objective](./docs/guide.fr.md#vérification-objective-vérificateurs)** a sa propre section :

- **Reviews** — les trois stades d'une MR (à traiter · reviewées · traitées), review IA notée et versionnée,
  re-review incrémentale et **boucle de convergence autonome** (review → correction → re-review jusqu'au seuil).
  Les listes se filtrent par **couleur de note**.
- **Dev IA** — sessions de codage automatisées (l'IA code, commite, pousse, ouvre la MR), **codage hors dépôt**
- **Agents** — des **profils de session** : un rôle, un périmètre, des outils, des skills, une sortie, parfois un horaire. Deux exemples livrés — l'**enquêteur d'incident**, qui trouve dans quel dépôt et quel fichier vit le code désigné par une trace, et le **documentaliste**, qui tient la carte des services dans une page de notes. Et les **agents de domaine** : on donne un sujet, le cartographe écrit la carte du sujet à travers les dépôts — chemins vérifiés un par un, âge de la carte compté sans IA, mise à jour relue et validée. Un agent ne pousse jamais et ne publie jamais de lui-même.
  (avec retour de l'IA et demande de correction), **exploration** de code en lecture seule et **questions
  libres** posées hors de tout dépôt (gardées, libellées, reprenables) ;
  *du prompt à la MR convergée* en un bouton. Sur une session multi-dépôts, chaque projet se lance — et se
  fait corriger — **séparément**. Chaque itération garde **le diff de ce qu'elle a changé** : relire
  un suivi n'oblige plus à relire tout le diff de la branche. Les sessions terminées se **rangent**
  sans être supprimées.
- **Vérification objective** — une liste de commandes (`npm ci`, `npm test`) donne à
  une merge request un verdict qui n'est pas un avis : `✓ vérifié`, `✗ 2 tests cassés`, `⚠ base déjà rouge`. Les
  noms des tests cassés sont lus de la sortie **TAP** ou d'un rapport **JUnit** quand il y en a. Des merge requests
  de dépôts différents qui ne tiennent qu'ensemble se **vérifient ensemble**, et un clic ouvre une session de
  correction qui les couvre toutes. Un vérificateur peut aussi **partir tout seul sur chaque nouvelle merge
  request** des dépôts qu'il couvre : le verdict attend alors sur la carte, et « Voir le résultat des
  vérificateurs » ouvre ce qui a tourné, sur quels commits, et ce que les commandes ont répondu.
  Ce n'est pas un onglet : ça vit dans *Reviews* et *Réglages*.
- **Notes** — les post-it du quotidien, gardés dans l'outil : pages de notes en Markdown, todos priorisées dont
  l'échéance sert de **rappel bureau**, et un **brief du matin** qui ouvre la journée — rappels, sessions en
  attente de réponse, vérifications en échec, MR fraîches et MR dormantes, le tout calculé en local et **sans
  aucun appel IA**. `!214` et `PROJ-720` écrits dans une note deviennent des liens, et une merge request ou un
  ticket s'ajoute aux todos d'un clic.
- **Jira** — tes tickets récupérés automatiquement, détail + pièces jointes, tickets liés (groupés par relation, ouverts sans quitter l'onglet), changement d'état et commentaires ; **tickets surveillés** (affectés ou non) avec notification à chaque changement d'état, et une pastille au menu = tes tickets en cours.
- **Git** — opérations multi-dépôts (branches, tags, commandes git) sur les deux forges, un **merge de
  branche à branche avec résolution des conflits à l'écran** (les deux versions l'une sous l'autre, garder
  l'une, garder les deux, ou écrire soi-même ; puis commit et push, chacun derrière sa confirmation),
  explorateur de branches, recherche de refs et **comparaison de deux dépôts** (sans histoire commune
  nécessaire), suppressions **restaurables**, tout **avec aperçu**.
- **Docker** — état des projets compose (drift `.env`, santé), actions par lot, **logs live** multi-containers,
  badges d'erreur dans le menu.
- **Jenkins** — l'état de tes jobs CI et leur lancement, sans quitter l'outil : tous les jobs que ton compte
  voit, groupés par dossier, avec une recherche (une installation d'entreprise en porte des centaines) et un
  filtre sur ce qui ne va pas. L'historique d'un job se lit run par run, **avec les paramètres de chacun**.
  Lancer demande toujours confirmation et nomme le job ; un job paramétré ouvre sa page, pour voir ce qu'on
  s'apprête à envoyer. Rien n'est interrogé en boucle : l'écran demande quand on ouvre l'onglet.
- **Liens** — les liens de travail que les marque-pages ne savent pas structurer : une **grille services ×
  environnements** (des adresses écrites — aucune devinée depuis une autre), où une case montre ses trois
  plus ouvertes et ouvre le reste dans un panneau ancré sur elle : la hauteur d'une ligne ne dépend plus de
  son contenu. On ajoute en **collant** — une URL par ligne, et l'outil propose le nom, le service et
  l'environnement, jamais en silence et jamais dans une colonne « probable ». Les liens libres forment une
  liste compacte retrouvée par tag, et une **palette globale** (`Ctrl`/`Cmd`+`K`) cherche d'un coup dans les
  liens, les MR, les tickets, les notes et les todos, classés par frécence. Un service associé à un dépôt pose
  ses boutons directement sur ses merge requests, y compris des liens **templatés** (`{env}`, `{branch}`,
  `{mr_iid}`) résolus au clic. Les favoris Chrome s'importent avec aperçu.
- **Stats** — funnel des MR, évolution des notes, taux de résolution par projet, coût en tokens,
  **les cinq sessions les plus coûteuses** et **les constats qui reviennent** — le même constat
  relevé sur trois merge requests d'un même dépôt se transforme en règle de review d'un clic.
  Chaque nombre est une porte : il ouvre Reviews filtré sur ce projet, au bon stade.
- **Réglages** — connexions GitLab / GitHub / Jira, dépôts (chacun peut cesser de fournir des MR tout en
  restant utilisable pour git et les sessions de codage), règles de review, **review automatique des merge
  requests à l'arrivée** et **re-review automatique quand un rapport se périme** (toutes deux plafonnées et
  décochées par défaut), **publication automatique du rapport sur la MR**, templates de prompt, thème et
  langue, règles de review pouvant être **limitées à un dépôt**, cases cochées d'office d'une nouvelle session, et jobs Jenkins liés aux dépôts.

Partout : `Ctrl`/`Cmd` + `K` ouvre une **palette de commandes** (sauter à un onglet, une MR, une session
en tapant son nom — `!217` ou `PROJ-1408` tapés seuls y vont directement), `j` / `k` parcourent la liste
courante, `v` / `c` / `m` / `x` agissent sur la carte au focus, `?` liste tous les raccourcis. Un
**micro sur chaque champ de texte** (`Ctrl`/`Cmd` + `Maj` + `Espace`) écrit ce que tu dis au curseur :
la transcription est **locale**, par whisper.cpp, et le moteur reçoit **ton** vocabulaire — dépôts,
services, environnements, préfixes Jira, branches ouvertes —, ce qui lui fait écrire `webapp-front` et
`!214` plutôt que « web app front » et « 214 ». Éteinte par défaut ; elle s'installe depuis l'écran de
réglages, qui déroule toute la chaîne et nomme la première marche qui casse. **Toute fenêtre où l'on
saisit se réduit** dans le bas du menu par un `—` : on va vérifier un nom de branche ou un ticket sans
perdre ce qu'on écrivait, et on la reprend telle quelle — champs, curseur et onglet compris. L'outil
rouvre sur l'onglet et le stade que tu as quittés, et le panneau de rapport ouvre sur **ce qui a changé
depuis ta dernière visite**.

**Les onglets se parlent.** Une todo liée à une merge request se coche quand celle-ci est mergée ;
le dernier build Jenkins qui porte une branche s'écrit sur la carte de sa merge request ; un ticket
passé « en revue » fait remonter ses merge requests ; une exploration se transforme en session de
codage **dans la même session d'agent** ; les branches des merge requests mergées se ramassent en
un lot ; et une vérification qui tourne « in place » dit l'état des services Docker avant de partir.

Les badges signalent le **travail en attente** (MR à traiter, sessions non lancées), pas des totaux.

## Sécurité (résumé)

L'outil est **local et mono-utilisateur** : pas d'authentification, et par défaut le serveur **n'écoute que
sur `localhost`** (`127.0.0.1`). L'exposer (`HOST=0.0.0.0`) est un **opt-in explicite** à réserver à un réseau
de confiance. L'agent IA tourne en mode « yolo » (permissions désactivées) pour pouvoir coder — son rayon
d'action nominal est le clone de travail, mais pendant une session de codage il a **les droits de l'utilisateur**
sur la machine : à connaître avant usage. Les **secrets** (PAT GitLab, token GitHub, jeton Jira) sont stockés en local et
**jamais renvoyés en clair**. Exécution **sans shell**, garde-fous **anti-injection** (git / Docker / Jira /
chemins), rendu **anti-XSS**, opérations destructrices **restaurables** et **jamais de merge automatique**.

→ **[Modèle de sécurité détaillé](./docs/guide.fr.md#sécurité)** · Signaler une vulnérabilité : [SECURITY.md](./SECURITY.md)

## Changements

Ce qui change de version en version : **[CHANGELOG.md](./CHANGELOG.md)**.

## Contribuer

Le développement se fait sur **[GitLab](https://gitlab.com/amady/mergerie)** : les merge requests y sont
ouvertes et **reviewées par Mergerie lui-même**. Le dépôt **[GitHub](https://github.com/debugall/mergerie)**
est un miroir synchronisé — les issues y sont les bienvenues. Voir [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

**GNU AGPL-3.0-only** — voir [LICENSE](./LICENSE). En bref : tu peux utiliser, modifier et
redistribuer le code, mais toute version modifiée **mise à disposition via un réseau** (SaaS inclus)
doit rendre son code source disponible sous la même licence.
