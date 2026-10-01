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
sessions de développement** automatisées (l'IA code, commite, pousse, ouvre la MR) et **explorer
du code** en lecture seule pour répondre à une question, via un CLI d'agent (`claude` / `copilot` —
Codex CLI et Gemini CLI sont câblés d'après leur documentation, et tout autre CLI tourne tel quel,
avec son niveau de garantie dit en clair). Une instance chacun — et une **équipe partage le travail accumulé** par un dépôt git
qui lui appartient, sans serveur au milieu.

Dans toute la documentation, **« MR »** désigne indifféremment une *merge request* GitLab ou une
*pull request* GitHub : les écrans et les actions sont les mêmes.

Tout tourne **en local** : un serveur Node + SQLite + une interface web. Aucune donnée n'est envoyée
ailleurs que vers les services que **tu** configures. L'outil pilote ton **abonnement Claude ou Copilot existant**
par leur propre CLI — aucune clé d'API ni jeton supplémentaire à acheter. L'IA **prépare** (review, corrections, convergence),
c'est **toi** qui merges. Voir [PLAN.md](./PLAN.md) pour l'architecture détaillée, et le
**[Guide complet](./docs/guide.fr.md)** pour le détail de chaque onglet.

## Démarrage

Nécessite **Node 22.9+** et `git`.

```bash
npx mergerie demo    # le voir vivant en 30 secondes — rien à cloner, aucune config, aucun jeton
npx mergerie         # pour de vrai : http://localhost:4319, tes données dans ~/.mergerie/data
```

Depuis un clone, ce sont `npm install` puis `npm run demo` ou `npm start`, avec les données à côté
du code (`data-demo/`, `data/`).

Au **premier lancement**, `npx mergerie` cherche `claude` puis `copilot` sur la machine et écrit un
`.env` court dans `~/.mergerie/` qui pointe `AGENT_BIN` sur celui qu'il trouve. **L'agent se règle
ensuite à l'écran** — Réglages → Session IA : une liste de **binaires** (binaire, arguments, délai,
variables d'environnement, un bouton *Tester* chacun), l'un par défaut, autant d'autres qu'on veut (un
Claude Code sur un Ollama local à côté de son Claude Max), et une session choisit le sien — sans redémarrage.
Aucun agent trouvé ? Une bannière le dit, avec les commandes
d'installation ; les rapports sont **simulés** et dits tels jusqu'à ce que ce soit réglé.

`PORT`, `HOST`, `MERGERIE_DATA_DIR` et les réglages de [`.env.example`](./.env.example) sont honorés
dans les deux cas. Un `.env` **dans le dossier d'où la commande est lancée** passe devant
`~/.mergerie/.env`, et ce que le shell exporte passe devant les deux, comme partout avec Node.

Au premier lancement, l'onglet **Reviews** affiche un assistant en **cinq étapes**, chacune avec son
bouton — **[Première review réelle en 5 minutes](./docs/guide.fr.md#première-review-réelle-en-5-minutes)**
dans le guide les déroule :
1. **L'agent IA** — trouvé, ou à régler (Réglages → Session IA, *Tester l'agent*).
2. **La forge** — GitLab (URL + **access token**, scopes `api` + `read_repository`) **ou** GitHub (**token**, scope `repo`), dossier de clonage. Un bouton **Tester la connexion** par forge. *(Jira : onglet **Jira**, optionnel.)*
3. **Dépôts** — un par un, ou en masse **depuis GitLab** ou **depuis GitHub**. Laisse le **pattern vide** pour prendre **toutes** les MR, ou mets un fragment (`PROJ-`) pour ne garder que ces branches. La case **récupérer les MR**, cochée par défaut, se décoche pour les dépôts dont tu ne relis pas les merge requests.
4. **Ce que ton équipe utilise** — Jira, Jenkins, Docker, des environnements : ce qui est coché déplie son menu, le reste reste replié (Réglages → Général → Menus pour changer d'avis).
5. De retour sur **Reviews**, `Chercher les nouvelles MR` remplit la liste — puis elle se rafraîchit toutes les 5 minutes d'office.

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
Une session de codage y porte **trois itérations, la dernière avec son diff**, et le codage hors dépôt les siennes : de quoi voir la relecture du dernier suivi des deux côtés, sans agent.
Côté **Agents**, elle porte les trois agents livrés, deux **agents de domaine** avec leur connaissance
versionnée — dont une version en attente de validation, un chemin non vérifié et un écart signalé — et un
run déclenché par un **horaire** qui a réécrit une page de notes.

*(Enregistrer une vidéo de présentation : voir le [Guide complet → Mode démo](./docs/guide.fr.md#enregistrer-une-vidéo-de-présentation-prête-pour-youtube).)*

## Fait pour N dépôts

Ce qu'aucun assistant d'éditeur ne fait : **vingt dépôts à la fois**. Une action Git sur tous les
dépôts d'un groupe en un geste ; les logs de dix conteneurs sans ouvrir dix terminaux ; un lot de
merge requests de plusieurs micro-services **vérifié ensemble**, et une session de codage qui
corrige les trois dépôts d'un seul coup ; un agent qui **cartographie un sujet** à travers les
dépôts ; des **groupes de dépôts** qui portent une fois les règles, vérificateurs et gabarits que
vingt micro-services partagent. **La plupart des sessions de codage partent d'un ticket** : le
menu Jira liste les tiens, et « Faire coder l'IA » ouvre la session déjà remplie. Et `Ctrl`/`Cmd`
+ `K` retrouve **une adresse de déploiement en deux touches**, là où les favoris du navigateur
demandent de traverser des dossiers.

## Les onglets

**Onze onglets**, dans une barre latérale — détail de chacun dans le **[Guide complet](./docs/guide.fr.md#les-onglets-en-détail)**, et la **[vérification objective](./docs/guide.fr.md#vérification-objective-vérificateurs)** a sa propre section.
**Ce qui grossit sans limite est tenu.** Les journaux de jobs au-delà de la rétention réglée sont purgés ; une merge request mergée ou close depuis plus d'un second délai garde son dernier rapport et perd les versions précédentes, le diff stocké et son dossier de travail ; les clones que personne n'a fetchés depuis un mois passent au `git gc` ; un clone peut se faire **sans les blobs** (`--filter=blob:none`) pour les prochains dépôts ; et Réglages → Général montre **ce que les données pèsent, par catégorie**, avec un bouton « Nettoyer maintenant ».

**Git, Docker, Jenkins et Liens démarrent repliés** : ce sont des commodités, et la barre porte d'abord le travail de tous les jours — une case dans Réglages → Général → Menus les ramène pour de bon, et **une porte contextuelle aussi** : « Résoudre dans Git → Merge » sur une merge request en conflit, « Voir les logs » depuis le brief, « ce dépôt a un compose : afficher Docker » sur la ligne d'un dépôt — le menu ainsi ouvert reste dans la barre.

- **Reviews** — les trois stades d'une MR (à traiter · reviewées · traitées), review IA notée et versionnée,
  re-review incrémentale et **boucle de convergence autonome** (review → correction → re-review jusqu'au seuil).
  La convergence travaille sur la *review* ; la **vérification objective** vient après, sur la merge request
  elle-même — voir le guide.
  Les listes se filtrent par **couleur de note**. On peut **poser une question sur un rapport** —
  pourquoi ce constat bloque, vaut-il pour l'autre appelant — et la réponse arrive sous le rapport
  sans toucher ni à lui ni à sa note.
  Un rapport se **publie en commentaire sur la MR** d'un bouton — et un réglage le fait automatiquement à la
  fin de chaque review, décoché par défaut parce qu'écrire sur le travail des autres est une décision ; quand
  l'équipe partage un dépôt de données, un second bouton en publie le **lien** plutôt que ses six cents
  lignes — un seul exemplaire, relu par tous au même endroit, et ce commentaire peut compter les constats
  de la passe (`{blockers}`, `{majors}`, `{minors}`). Et le verdict que la forge lit elle-même : un bouton **Approuver** (approbation GitLab, review `APPROVE` GitHub — jamais une rafale de commentaires inline), **Résoudre / Rouvrir** sur chaque fil de discussion, et la **CI de la forge** (pipeline GitLab, checks GitHub) en badge sur chaque carte. Une merge request **en conflit**, ou simplement **en retard sur sa cible** (la carte dit de combien de commits), porte `Mettre à jour avec l'IA` : une session de codage pré-remplie rejoue ses changements par-dessus la cible, résout les conflits et commite sans pousser — tu relis, puis tu pousses. Le brief du matin compte ce qui est **prêt à merger** — note au-dessus du seuil, vérification verte, aucun ticket en travers. Rien n'est mergé : l'outil dit combien n'attendent qu'une décision.
- **Dev IA** — sessions de codage automatisées (l'IA code, commite, pousse, ouvre la MR), **codage hors dépôt**
  (avec retour de l'IA et demande de correction), **exploration** de code en lecture seule et **questions
  libres** posées hors de tout dépôt (gardées, libellées, reprenables) ;
  *du prompt à la MR convergée* en un bouton. Sur une session multi-dépôts, chaque projet se lance — et se
  fait corriger — **séparément**. La dernière itération garde **le diff de ce qu'elle a changé** — hors
  dépôt compris, où un dépôt de suivi tenu hors de ton dossier remplace la branche absente : relire
  ton dernier suivi n'oblige plus à tout relire. Une session — codage, exploration ou hors dépôt —
  se **programme aussi à une date et une heure** depuis la même modale (« Créer et programmer »),
  et un suivi en attente de même (« Ou l'envoyer le… ») : la carte porte la date avec une croix
  pour l'annuler, lancer à la main l'annule aussi, et la date est celle de *ton* poste — c'est
  lui qui lance, et il rattrape le lancement s'il était éteint à l'heure dite. Un suivi peut s'**écrire
  pendant que la session tourne** et attend sur la carte — ou part de lui-même à la fin si tu coches la
  case. Les sessions terminées se **rangent** sans être supprimées. **« Planifier d'abord »** : la première
  passe lit et rend un plan, on le lit, on envoie des retours qui le font réécrire par la même session
  (depuis la carte ou depuis la vue du plan elle-même), et **« Approuver et coder »** reprend cette session
  pour le réaliser. Pendant qu'une session tourne, le champ de suivi propose **« Stopper et reprendre avec
  cette consigne »** — la passe s'arrête, la consigne repart dans la même session. Des **projets liés en
  lecture seule** donnent à une session de codage le contexte d'autres dépôts — l'IA lit leur API, leur
  schéma, leurs contrats — sans jamais pouvoir les modifier. Le journal des jobs garde ses lignes courtes,
  et chaque message d'agent tronqué ou chaque `Edit` porte un **« … voir »** qui ouvre le texte entier ou
  le diff. Les jobs qui touchent des dépôts différents **tournent en parallèle d'eux-mêmes**, ceux lancés à
  la main d'abord.
- **Agents** — des **profils de session** : un rôle, un périmètre, des outils, des skills, une sortie, parfois un horaire. Deux exemples livrés — l'**enquêteur d'incident**, qui trouve dans quel dépôt et quel fichier vit le code désigné par une trace, et le **documentaliste**, qui tient la carte des services dans une page de notes — avec un schéma « qui appelle qui » et, pour chaque dépôt, son schéma de base lu dans les migrations. Et les **agents de domaine** : on donne un sujet, le cartographe écrit la carte du sujet à travers les dépôts — chemins vérifiés un par un, âge de la carte compté sans IA, mise à jour relue et validée. Un agent ne pousse jamais et ne publie jamais de lui-même.
- **Vérification objective** — une liste de commandes (`npm ci`, `npm test`) donne à
  une merge request un verdict qui n'est pas un avis : `✓ vérifié`, `✗ 2 tests cassés`, `⚠ base déjà rouge`. Les
  noms des tests cassés sont lus de la sortie **TAP** ou d'un rapport **JUnit** quand il y en a. Des merge requests
  de dépôts différents qui ne tiennent qu'ensemble se **vérifient ensemble**, et un clic ouvre une session de
  correction qui les couvre toutes. Un vérificateur peut aussi **partir tout seul sur chaque nouvelle merge
  request** des dépôts qu'il couvre : le verdict attend alors sur la carte, et « Voir le résultat des
  vérificateurs » ouvre ce qui a tourné, sur quels commits, et ce que les commandes ont répondu.
  Les commandes tournent **sur l'hôte** : qui veut un conteneur écrit `docker compose run --rm app npm test`
  dans la ligne elle-même, et le formulaire **propose des lignes exactes** d'après ce que le clone déclare —
  scripts npm, pnpm ou yarn, composer, cibles du Makefile, pytest et tox, `go test ./...`, `cargo test`,
  Maven, Gradle, `dotnet test` — avec leur variante `docker compose run` quand un fichier compose est là.
  Un run lancé à la main voit ton `HOME` **et le dit** au moment du clic, avec une case **HOME jetable**
  mémorisée par vérificateur. Pendant une boucle de convergence, le vérificateur tourne après chaque passe
  et son verdict s'affiche sur le panneau — une information à côté de la note, jamais une condition de sortie.
  Ce n'est pas un onglet : ça vit dans *Reviews* et *Réglages*.
- **Notes** — les post-it du quotidien, gardés dans l'outil : pages de notes en Markdown — avec des **sous-pages** (un
  niveau, pour qu'une page générale porte le détail de chacun de ses points) et des **diagrammes Mermaid**
  rendus sur place, la bibliothèque livrée dans le dépôt et chargée seulement quand une page en contient —,
  un **mode plein
  écran** qui retire la colonne des pages pour lire sans distraction, en gardant Rendu / Deux colonnes /
  Markdown à un clic, todos priorisées dont
  l'échéance sert de **rappel bureau**, et un **brief du matin** qui ouvre la journée — rappels, sessions en
  attente de réponse, vérifications en échec, MR fraîches et MR dormantes, le tout calculé en local et **sans
  aucun appel IA**. `!214` et `PROJ-720` écrits dans une note deviennent des liens, et une merge request ou un
  ticket s'ajoute aux todos d'un clic.
- **Jira** — tes tickets récupérés automatiquement, détail + pièces jointes, tickets liés (groupés par relation, ouverts sans quitter l'onglet), changement d'état et commentaires ; **tickets surveillés** (affectés ou non) avec notification à chaque changement d'état, et une pastille au menu = tes tickets en cours.
- **Git** — opérations multi-dépôts (branches, tags, commandes git) sur les deux forges, un **merge de
  branche à branche avec résolution des conflits à l'écran** (les deux versions l'une sous l'autre, datées à l'heure
  près, garder l'une, garder les deux, écrire soi-même — ou **demander à l'IA** une proposition pour chaque
  conflit de chaque fichier en un seul job, avec sa raison, que tu valides une par une ; une vue **plein
  écran** met les versions côte à côte et saute de conflit en conflit ; puis commit et push, chacun derrière
  sa confirmation),
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
  relevé sur trois merge requests d'un même dépôt — ou, dans une seconde carte, **d'un dépôt à l'autre** —
  se transforme en règle de review d'un clic.
  Chaque nombre est une porte : il ouvre Reviews filtré sur ce projet, au bon stade.
- **Réglages** — connexions GitLab / GitHub / Jira, dépôts (chacun peut cesser de fournir des MR tout en
  restant utilisable pour git et les sessions de codage), règles de review, **review automatique des merge
  requests à l'arrivée** et **re-review automatique quand un rapport se périme** (toutes deux plafonnées et
  décochées par défaut), **publication automatique du rapport sur la MR**, templates de prompt, thème et
  langue, règles de review pouvant être **limitées à un dépôt**, cases cochées d'office d'une nouvelle session, et jobs Jenkins liés aux dépôts. Chaque champ porte un badge **« équipe » / « ce poste »** : gabarits de prompt, seuils et politiques décrivent l'outil, tandis que les jetons d'API, le dossier de clonage et la langue n'appartiennent qu'à ta machine — et sont rangés à part. Désigne un dépôt git et une **équipe partage le travail accumulé** — règles de review, vérificateurs, agents et leur carte du code, et les pages de notes, sessions et todos que tu coches — chacun gardant son instance, ses jetons et son abonnement IA. L'écran **suit le travail de l'équipe** après une synchro — une MR reviewée par un collègue change de stade sous tes yeux — et chaque élément partagé dit **« partagé par Claire »**. Ce qu'on écrit sans destinataire (une session, une question, un brouillon) reste à soi tant qu'on n'a pas dit le contraire. **Groupes de dépôts** : vingt micro-services qui partagent les mêmes règles de review, vérificateurs, gabarits de prompt et consignes les portent une fois, sur un groupe qui voyage avec l'équipe — et une pastille par groupe remplit une session, une action Git ou la couverture d'un vérificateur avec tous ses membres.

Partout : `Ctrl`/`Cmd` + `K` ouvre une **palette de commandes** (sauter à un onglet, une MR, une session
en tapant son nom — `!217` ou `PROJ-1408` tapés seuls y vont directement), `j` / `k` parcourent la liste
courante, `v` / `c` / `m` / `x` agissent sur la carte au focus, `?` liste tous les raccourcis. **Toute
fenêtre où l'on saisit se réduit** dans le bas du menu par un `—` : on va vérifier un nom de branche ou
un ticket sans perdre ce qu'on écrivait, et on la reprend telle quelle — champs, curseur et onglet
compris. L'outil rouvre sur l'onglet et le stade que tu as quittés, et le panneau de rapport ouvre sur
**ce qui a changé depuis ta dernière visite**.

**Les onglets se parlent.** Une todo liée à une merge request se coche quand celle-ci est mergée ;
le dernier build Jenkins qui porte une branche s'écrit sur la carte de sa merge request ; un ticket
passé « en revue » fait remonter ses merge requests ; une exploration se transforme en session de
codage **dans la même session d'agent** ; les branches des merge requests mergées se ramassent en
un lot ; et une vérification qui tourne « in place » dit l'état des services Docker avant de partir.
Le rapport d'une review dit **quelles notes le citent** et **quelle carte de domaine il touche** — et
donne cette carte à l'IA comme contexte de review ; un verdict rouge laisse une todo et, si tu le
demandes, un commentaire sur le ticket Jira ; une console Jenkins en échec et une vérification rouge
ouvrent l'**enquêteur d'incident**, la trace déjà dans la demande ; et le brief du matin rattrape **le
merge laissé à moitié la veille**, les opérations Git qui ont échoué et les conteneurs tombés — ces
derniers surveillés par le serveur lui-même, comme la fin d'un build Jenkins lancé d'ici, pour que ça
t'atteigne l'onglet fermé.

Les badges signalent le **travail en attente** (MR à traiter, sessions non lancées), pas des totaux.

## Sécurité (résumé)

L'outil est **local** : par défaut le serveur **n'écoute que sur `localhost`** (`127.0.0.1`), et l'exposer
(`HOST=0.0.0.0`) **exige un jeton** (`MERGERIE_ACCESS_TOKEN`) ; sur `localhost`, un second jeton, purement
local, ferme la même API à tout processus du poste qui n'est pas ton navigateur. Une page ouverte dans un
autre onglet ne peut rien faire à ta place (garde `Host` contre le *DNS rebinding*, `Sec-Fetch-Site`, CSP).
Ce qui **exécute du code** et arrive par le dépôt de données — commandes d'un vérificateur, permissions
d'un agent, reviews automatiques — **attend ton approbation sur ce poste**, et la synchro elle-même tourne
avec le même git durci qu'un clone de code. Les droits de l'agent IA tiennent en **un interrupteur, par
poste** : en mode **sécurisé**, une review ou une exploration tourne **en lecture seule**, un codage
tourne sous un **sandbox du CLI vérifié par un vrai appel de test** — jamais une case cochée — ou à
défaut une liste blanche de commandes ; en mode **yolo**, le défaut d'une installation qui n'a rien
touché, l'agent tourne sans restriction du lanceur. Dans les deux cas son environnement est filtré et le
jeton de la forge n'est plus dans le clone. Le texte venu
d'ailleurs (description de MR, ticket) lui est présenté **comme une donnée**, et chaque bloc que l'agent
émet (constats, questions, dépôt trouvé, agent proposé) porte le nonce de son propre run. Les **secrets**
sont stockés en local et **jamais renvoyés en clair**. Exécution **sans shell**, git durci (ni hooks ni
fsmonitor), palette git en **liste blanche**, rendu **anti-XSS**, opérations destructrices **restaurables**
et **jamais de merge automatique**.

→ **[Modèle de sécurité détaillé](./docs/guide.fr.md#sécurité)** · Signaler une vulnérabilité : [SECURITY.md](./SECURITY.md)

## Changements

Ce qui change de version en version : **[CHANGELOG.md](./CHANGELOG.md)**.

## Contribuer

Le développement se fait sur **[GitLab](https://gitlab.com/amady/mergerie)** : les merge requests y sont
ouvertes et **reviewées par Mergerie lui-même**. Le dépôt **[GitHub](https://github.com/debugall/mergerie)**
est un miroir synchronisé — **les issues y sont les bienvenues** : bugs, idées, erreurs de traduction.

**Les contributions de code ne sont pas acceptées** : Mergerie est écrit par un seul mainteneur, qui en
reste l'unique ayant droit — c'est ce qui laisse le projet libre de faire évoluer sa licence. Les pull
requests GitHub sont fermées automatiquement ; les merge requests GitLab sont celles du mainteneur. Décris le bug ou la
correction en mots plutôt que de coller un patch. Voir [CONTRIBUTING.md](./CONTRIBUTING.md) (en anglais).

## Licence

**GNU AGPL-3.0-only** — voir [LICENSE](./LICENSE). En bref : tu peux utiliser, modifier et
redistribuer le code, mais toute version modifiée **mise à disposition via un réseau** (SaaS inclus)
doit rendre son code source disponible sous la même licence.
