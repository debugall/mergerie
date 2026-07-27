# Mergerie — Guide complet

> ↩ Retour au [README.fr.md](../README.fr.md) · 🇬🇧 [README (English)](../README.md)

Ce guide détaille chaque onglet, la configuration avancée, le TLS entreprise, les clones locaux, les
données & sauvegarde et le modèle de sécurité. Pour une prise en main rapide, reste sur le
[README.fr.md](../README.fr.md).

> **Convention.** Mergerie gère **GitLab et GitHub**. Dans ce document, **« MR »** désigne
> indifféremment une *merge request* GitLab ou une *pull request* GitHub : les écrans, les actions et
> les garanties décrites sont les mêmes. Les rares différences propres à une forge sont signalées
> explicitement.

## Les onglets en détail

Sept onglets : **Reviews** · **Dev IA** · **Statistiques** · **Git** · **Docker** · **Jira** · **Réglages**.
Les badges signalent le **travail en attente** (MR à traiter, sessions non lancées), pas des totaux.

### Reviews
Les trois stades d'une même merge request, réunis derrière un filtre segmenté —
**À traiter · Reviewées · Traitées** — avec une recherche commune (titre, auteur, projet, ticket).

- `Chercher les nouvelles MR` interroge la forge et remplit la liste (filtrée par pattern).
  Un **rafraîchissement automatique** optionnel le fait pour toi (voir Réglages).
- `Reviewer les N MR` lance la review IA sur toute la file ; au-delà de 5, une confirmation
  rappelle que chaque MR consomme un appel IA. `Reviewer` traite une MR isolée.
- **Review avec ou sans explication.** Par défaut, une review produit **deux choses** : le rapport
  (constats + note) et une **explication pédagogique** (2e appel IA, onglet Explication). Tu peux t'en
  passer pour aller plus vite et **dépenser moins de tokens** : le réglage **Réglages → Général →
  « Générer l'explication pédagogique »** définit le défaut, et le **petit menu ▾ à côté de `Reviewer`**
  permet de **surcharger ponctuellement** une MR (`Review + explication` / `Review sans explication`).
  Si l'explication manque, un bouton **`Générer l'explication`** sur le rapport la produit à la demande
  (un seul appel IA, sans relancer la review ni créer de nouvelle version).
- `Voir le diff` ouvre le diff de la MR **avant toute review**, dans le viewer plein écran (arbre,
  diff inline, navigation) — le dépôt est cloné à la demande si besoin. Le panneau de gauche devient un
  **panneau de décision** : si la MR est triviale, `Classer sans review` ; sinon `Reviewer`. Objectif :
  **ne pas dépenser un appel IA** pour une MR évidente.
- `Faire coder l'IA` ouvre une session de codage **pré-remplie** sur la branche de la MR
  (branche de travail = branche source, branche de départ = branche cible).
- `Projets liés` (dans `Contexte`) : d'autres dépôts + une branche que l'IA consulte **en lecture seule**
  pendant la review pour signaler si les changements de la MR **risquent de les impacter** (signatures d'API,
  contrats, schémas…). Montés sous `ai-dev-tools-internal/linked/`, remis à zéro après. Chaque projet lié
  ajoute durée et coût en tokens — à choisir.
- `Contexte` attache à une MR tout ce qui aide à la juger — contenu du ticket, spécification,
  règle métier, extrait d’échange — en texte et/ou en **capture d’écran** (collable au Ctrl+V).
  Si **Jira** est configuré (URL + email + jeton d’API, Réglages → Jira), le **summary + description**
  du ticket sont **récupérés automatiquement au discover** et pré-remplissent le contexte — cas nominal
  **zéro clic**. Ta saisie manuelle reste un **complément distinct** (jamais écrasé), et un bouton
  **Rafraîchir** re-récupère le ticket à la demande. Le tout est injecté dans le prompt de review, en
  plus du diff, et le bouton porte un ✓ quand un contexte est déjà enregistré.
- `Merger` merge la MR **directement, sans review** — pour une MR triviale : on confirme, et si le
  merge a réellement lieu la MR sort de la file (marquée traitée). Disponible aussi dans le panneau de
  décision de `Voir le diff`, là où l'on juge justement de la trivialité.
- `Classer sans review` sort une MR de la file, avec **annulation** possible pendant quelques secondes.
- Les reviews s'empilent dans une **file séquentielle** ; un **panneau de log en direct** montre les
  commandes, la sortie et la progression, avec un bouton **Stop** (qui vide aussi la file — la
  confirmation le précise).
- **Re-review complète ou incrémentale.** `Relancer la review` refait une review **complète** (tout le
  diff). Quand la branche a **bougé depuis la dernière review** (MR *stale*), un bouton `Relancer (delta)`
  apparaît : la **re-review incrémentale** ne relit que **ce qui a changé** depuis le dernier SHA reviewé
  (`reviewed_sha..current_sha`) et fournit le **rapport précédent en contexte** — l'IA produit un **rapport
  complet à jour** (note incluse) en lisant beaucoup **moins de diff** (donc moins de tokens). Repli
  automatique sur une review complète s'il n'y a pas de delta exploitable (ex. force-push). Relancer une
  review **reprend la même session d'agent** que la review précédente : l'IA se souvient de son analyse et
  se concentre sur ce qui a changé.
- **⚡ Converger — la boucle de qualité autonome.** Le bouton `Converger` d'un rapport lance une **boucle
  autonome** : review → **correction IA** appliquée au code (commit + **push** sur la branche) → **re-review
  incrémentale** du delta → et ça recommence **jusqu'au seuil de note** (défaut 8/10) **ou au plafond de
  passes** (défaut 3). Tu pousses une MR moyenne, tu reviens plus tard : elle est passée de 5,8 à 8,4 en
  quelques itérations, avec **tout l'historique versionné** (v1 → v2 → v3, notes, findings résolus/apparus,
  chaque commit de correction lisible). **Garde-fous** : arrêt si la note **baisse ou stagne**, plafond de
  passes strict, et **jamais de fusion automatique** — la boucle *prépare*, c'est **toi qui valides et
  merges** (review et correction viennent du même modèle : une note obtenue en autonomie n'est pas une note
  validée par un humain). Seuil et plafond sont réglables globalement (Réglages → Général) et **surchargeables
  au lancement**. Une **notification** t'avertit à la fin (« Convergence terminée : 8,4/10 en 3 passes »).
  Si l'option « l'IA peut poser des questions » est active et que l'IA hésite pendant une passe, la boucle
  **se met en attente** (notification) au lieu de deviner : tu réponds, puis tu relances Converger — qui
  **reprend la même session**.
- Sur un rapport : **régénérer** le rapport, **commenter** la MR, **merger**, **relancer la review**,
  **marquer traitée**, **supprimer le rapport** (la MR retourne « à traiter »), et surtout
  **Faire corriger le code par l'IA** — qui ouvre une session de codage pré-remplie avec le rapport
  injecté dans le prompt, pour ajuster avant de lancer. Les sessions ouvertes depuis une MR proposent
  **Créer sans lancer** en plus de **Créer et lancer**, pour préparer maintenant et exécuter plus tard.
- **Chaque passe de review est conservée.** Relancer une review ou régénérer un rapport n'écrase plus
  le précédent : un **sélecteur de version** apparaît dans le rapport dès la deuxième passe
  (`v2 — actuelle · 20/07 14:30 · 7,8/10`) et permet de **relire une review antérieure**, avec un
  bandeau rappelant qu'elle est en lecture seule.
- **Suivi de résolution** entre deux passes : dès la 2e review, un bandeau indique les constats
  **résolus · persistants · nouveaux** et l'évolution de la note (`note 6,4 → 7,8`). Un constat n'est
  dit « résolu » que si la ligne concernée a **réellement changé** entre les deux versions du code
  (vérifié via git) ; sinon il est marqué « disparu » — l'IA a pu simplement ne pas le re-signaler.
  Les constats viennent d'un bloc structuré que l'IA émet en plus du rapport (invisible à la lecture) ;
  **ton template de prompt de review n'est pas modifié**, l'instruction est ajoutée à la volée.
  L'onglet Statistiques en tire un **taux de résolution par projet**.
- Une MR qui n'est plus ouverte sur la forge porte le badge **mergée** ; le bouton Merger disparaît.

### ⛶ Ouvrir le code (explorateur plein écran)
Arbre du projet + fichier affiché **entier avec le diff en place**, coloration syntaxique,
**mini-carte** des changements, navigation entre modifications, panneaux repliables.
**Commentaire inline** par ligne et **réponses** aux fils, synchronisés avec la forge.

### Dev IA
Deux sous-onglets. Dans les deux cas, une session porte sur **un ou plusieurs projets**, chacun avec
sa propre branche, et sa date de création est affichée. Le **choix du dépôt se fait au clavier**
(sélecteur avec recherche), comme celui des branches — utile quand la liste des dépôts est longue.

**Enrichir depuis un ticket Jira (optionnel).** Si Jira est configuré (Réglages → Jira), la modale
propose un champ **N° de ticket** avec un bouton **Récupérer** : le **titre + la description** du ticket
sont récupérés via l'API Jira et **ajoutés en tête du prompt** comme bloc de contexte — visible et
**éditable** avant de lancer. Le numéro est **pré-rempli** si la branche de travail contient déjà une
clé (ex. `feature/PROJ-1234-…`). Disponible pour le codage **et** l'exploration.

- **Codage** — l'IA modifie le code. Pour chaque projet : branche de travail, et **branche de départ**
  facultative (liste déroulante avec recherche ; vide = branche par défaut du dépôt). Le prompt est
  appliqué à chaque projet, séquentiellement — **un projet en échec n'interrompt pas les autres**.
  Chaque projet a ensuite ses propres actions : **Diff · Pousser · Créer la MR · Merger**. Un
  **fil d'étape** compact (pastilles **créée → commit → push → MR**) sur chaque ligne situe d'un
  coup d'œil où en est le projet — utile sur une session multi-projets.
  `Demander une correction` relance l'IA sur les branches existantes, **en reprenant la même session** :
  l'IA garde tout le contexte du travail déjà produit (idem pour une relance de la session).
  À la fin du codage, **`Retour de l'IA`** affiche ce que l'agent dit avoir fait (comme la réponse d'une
  exploration) — utile pour comprendre son travail, ou **quand rien n'a changé** : si le prompt était
  incomplet et que l'IA a **répondu au lieu de coder** (ex. « donne-moi le nom du fichier »), sa réponse
  est **remontée directement** dans l'erreur du projet plutôt qu'un « aucun changement » opaque.
- **⌨️ Reprendre la session au terminal.** Chaque projet d'une session de codage (dépôt **ou** hors dépôt),
  ainsi que les reviews, expose un bouton **« Reprendre au terminal »** qui copie la **commande prête à
  coller** : `cd` vers le bon dossier + lancement de l'agent avec l'**identifiant de session** (claude
  `--resume <id>`, copilot `COPILOT_HOME=… --continue`). Tu reprends toi-même la conversation de l'IA,
  avec tout son contexte, là où l'app l'a laissée.
- **🙋 L'IA peut te poser une question.** Option **par session** (case à cocher, désactivée par défaut) :
  si l'IA rencontre une décision structurante qu'elle ne peut pas trancher (choix d'archi, ambiguïté,
  conflit de conventions), elle **s'arrête et te demande** au lieu de deviner. La session passe **en
  attente** (la file se libère, une notification t'avertit) ; tu réponds depuis la carte — **choix
  proposés ou texte libre** — et l'IA **reprend la même session** là où elle s'était arrêtée. Dès que tu
  valides, le formulaire laisse place à un **« reprise en cours… »** (plus d'attente sans retour visuel).
  L'option se **mémorise** quand tu modifies une session existante. La reprise a d'abord été validée par
  un banc d'essai dans *Réglages → AI sessions*.
- **⚡ Converger depuis une session — *du prompt à la MR convergée*.** Le bouton `Converger` (sur la
  **modale de nouvelle session** et sur une **session existante**) enchaîne **tout le chemin** sans
  intervention : l'IA **code** la tâche → **commit** → **push** → **crée la MR** (cible = la branche de
  départ) → puis lance la **boucle de convergence** (review → correction → re-review) jusqu'au seuil.
  Tu écris une intention, tu reviens : une **MR ouverte, testée, notée et convergée** t'attend — il ne
  reste qu'à relire et merger. **Multi-projet** : chaque projet donne sa MR, convergée à son tour, en
  série (un échec n'arrête pas les autres). **Idempotent** : une session déjà codée n'est pas recodée,
  une MR déjà ouverte est convergée directement. Mêmes garde-fous que « Converger » sur une MR — et
  **jamais de merge automatique**.
- **Codage hors dépôt** — l'IA réalise le prompt **directement dans des dossiers locaux**, **en place**
  et **sans git** : ni branche, ni commit, ni push. Pratique pour des dossiers qui ne sont pas des
  dépôts d'une forge (scripts, expériences, mono-repo local…). Le dossier de travail ne se **saisit** plus :
  on choisit un **répertoire local** (déclaré dans *Réglages → Dépôts*) puis **le ou les projets** qu'il
  contient — le chemin en découle, et un chemin tapé à la main est une faute de frappe qu'on ne découvre
  qu'au milieu du traitement. Le formulaire (projets + prompt) vit dans **la même modale que le codage** — tu peux donc
  aussi **joindre des captures d'écran** (bouton ou Ctrl+V) pour enrichir le prompt. Le même prompt est
  appliqué à **chaque dossier**, l'un après l'autre — un dossier en échec n'interrompt pas les autres, et
  son statut est indiqué par dossier. Comme pour le codage sur dépôt, chaque dossier expose
  **`Retour de l'IA`** — ce que l'agent dit avoir fait, utile quand le dossier n'a pas bougé (prompt
  incomplet, l'IA a répondu au lieu de coder) —, et la session propose **`Demander une correction`** :
  une nouvelle passe sur les mêmes dossiers qui **reprend la session de chacun**, donc l'IA garde tout
  le contexte de ce qu'elle vient de produire. ⚠ **Aucun filet** : l'agent modifie les fichiers en place, sans
  sauvegarde ; sur un dépôt git tu peux relire/annuler toi-même (`git diff` / `git checkout`), sur un
  dossier non-git il n'y a **pas d'annulation** — un avertissement le rappelle. (Sous-onglet dédié, entre
  *Codage* et *Exploration*.)
- **Exploration** — **lecture seule** : tu poses une question sur un ou plusieurs projets, l'IA explore
  le code et rédige **une seule réponse de synthèse** enregistrée en `.md`, consultable à tout moment
  via `Voir la réponse`. Ni diff ni merge. Les **questions de suivi** reprennent la réponse précédente
  en contexte. Les dépôts sont remis à zéro après coup : **aucune modification ne subsiste**.

### Git
Opérations sur **plusieurs dépôts à la fois** et exploration des branches.

- **Actions** — `Créer une branche` · `Créer un tag` · `Supprimer des branches` · `Supprimer des tags`.
  On ne **saisit** un nom que pour créer ; pour supprimer, on **choisit dans la liste** des refs
  existantes — la branche par défaut et les refs protégées n'y figurent même pas. Le choix du dépôt
  se fait par un **champ avec recherche** (comme partout où l'on choisit un projet), utile quand la
  liste est longue.
- **Rien ne s'exécute sans aperçu.** L'aperçu liste chaque ligne (projet × ref) et son résultat
  attendu : *sera exécutée · existe déjà — ignorée · ref protégée · branche par défaut · introuvable*.
  « Existe déjà » n'est pas une erreur : l'opération est **idempotente**, on peut relancer.
  Chaque ligne exploitable affiche aussi **la commande correspondante** : celle qui est
  **réellement exécutée** (le `git fetch` de sécurité), l'**équivalent git** de l'écriture — donné
  pour comprendre, car l'écriture passe par l'API et non par le CLI — et l'**appel API** sous-jacent.
- **Les suppressions sont restaurables.** Avant chaque suppression, l'outil **rapatrie les objets
  dans son clone local**, puis enregistre le SHA. L'onglet **Historique** propose alors
  `Restaurer` — et ça fonctionne **même après le passage du ramasse-miettes de la forge**, puisque
  c'est le clone local qui sert de filet, pas le serveur.
- **Navigation** — positionne **plusieurs projets de ta machine** (pas les clones de l'outil : tes
  propres dépôts) sur la branche de ton choix, en un geste. On choisit un **répertoire local** — un
  dossier contenant un sous-dossier par projet git, déclaré dans *Réglages → Dépôts* —, puis ligne par
  ligne un **projet** et sa **branche distante**, les deux avec recherche à la frappe. La **branche
  courante** est affichée à côté du sélecteur : sans elle on choisit à l'aveugle, sans savoir si
  l'opération change quoi que ce soit. Un `git fetch` précède la liste des branches et le checkout, la
  branche locale est ensuite alignée en **fast-forward seulement** (un historique divergent est signalé,
  jamais écrasé). **Rien n'est jeté** : si un dépôt a des modifications en cours, le checkout est fait
  quand même et le bilan **liste les fichiers concernés** — un compte ne permettrait pas de vérifier ce
  qu'on emporte d'une branche à l'autre. Un échec (branche absente, checkout refusé) est **isolé** :
  il n'interrompt pas les autres projets et sa raison est affichée.
- **Commandes Git** — exécute **la même commande git à la racine de plusieurs projets locaux** d'un coup.
  On choisit un **répertoire local**, on **coche les projets** (recherche + « tout cocher »), puis on
  saisit une commande git **ou** on la prend dans une **palette** (gérée dans *Réglages → Git*). Flux en
  trois temps : **Prévisualiser** (la commande exacte + la liste des projets visés) → **Exécuter** → la
  **sortie de chaque projet** s'affiche, avec son code de sortie. **Git uniquement**, **sans shell** (les
  métacaractères `; | > &` ne sont jamais interprétés) **et** avec un **refus des options git dangereuses** :
  les flags qui permettent d'exécuter une commande arbitraire ou de sortir du dossier (`-c`, `--upload-pack`,
  `--receive-pack`, `--exec`, `-C`, `--git-dir`, transport `ext::`…) sont bloqués, et la commande doit
  commencer par une sous-commande. Un projet en échec est **isolé** ; les autres s'exécutent quand même.
- **Explorateur de branches** — par projet, une ligne par branche avec ses colonnes : `↑avance ↓retard`
  vs la branche par défaut, sa **branche d'origine**, la **branche dans laquelle elle a été mergée** et son
  **dernier commit**. Trié **par date du dernier commit, du plus récent au plus ancien**. Depuis une branche,
  **`Créer la MR`** ouvre une MR entre elle et sa source (l'origine déduite, sinon la branche par défaut) —
  même popup de titre que dans Dev IA, proposé seulement quand la branche a des commits d'avance. Cocher des
  branches puis `Supprimer la sélection` ouvre l'aperçu pré-rempli. On peut aussi **explorer plusieurs dépôts
  à la fois** (chaque résultat dans un bloc replié). La **liste des tags** affiche la date, la (les)
  **branche(s) qui portent le tag**, l'auteur du commit pointé — avec un bouton `Auteur du tag`
  qui va lire le **vrai *tagger*** d'un tag annoté dans le clone local (aucune des deux API de forge ne l'expose).
- **Trouver une ref** — on saisit un nom de tag **ou** de branche (saisie libre) et l'outil dit,
  **à travers tous les dépôts actifs** (GitLab et GitHub confondus), lesquels le possèdent : type, commit +
  lien vers la forge, date,
  branche(s) portant le tag, auteur — avec le même bouton `Auteur du tag`. Un dépôt injoignable est
  signalé à part, jamais confondu avec « absente ».

> ⚠️ **L'origine d'une branche est une inférence, pas une donnée.** Git n'enregistre nulle part de
> quelle branche une branche a été créée. L'outil la déduit (`merge-base`), sauf quand une merge
> request l'atteste — le seul cas certain. Une origine déduite s'affiche **en italique avec sa
> confiance** (*probable* / *ambigu*), jamais comme un fait.

### Docker
Deux sous-vues, comme Codage/Exploration en Dev IA.

- **Compose** — les **répertoires locaux** (Réglages → Dépôts) sont scannés pour les fichiers
  `compose.yaml` / `docker-compose.yml` ; chaque fichier devient un **projet compose** avec ses services.
  La liste est **triée par activité récente** (le projet dont un container a été recréé le plus récemment
  d'abord) et un **filtre en tête** permet de **cocher/décocher les projets à afficher** — choix **persisté**.
- **Retrouver un container : recherche + filtre d'état.** Au-dessus de la liste, un champ de **recherche**
  (nom de service, nom de container ou nom de projet) et un sélecteur **« N'afficher que »** — *En cours ·
  Arrêtés / non créés · Unhealthy · En restarting · En drift* — réduisent l'affichage **service par
  service**. Un projet dont plus aucun service ne correspond **disparaît entièrement** (une carte vide
  laisserait croire à un projet sans service) ; sur un projet partiellement filtré, une mention rappelle
  combien de services sont masqués. Les deux réglages sont **persistés** et s'appliquent **à chaud**, sans
  rappeler Docker — ce sont les mêmes intitulés d'état que le sous-onglet *Actions*.
  **Affichage progressif** pour rester rapide même avec beaucoup de containers : la **liste des projets
  apparaît tout de suite** (scan + un seul `docker ps -a`), puis le détail de chaque projet (drift, états)
  **se remplit carte par carte** au fil de l'eau ; côté serveur, les `docker inspect`/`compose config`
  tournent **en parallèle** au lieu d'un par un.
- **L'état de chaque container ressort clairement** : pastille colorée (**● Running** vert, **exited/dead**
  rouge, **paused/restarting** ambre, **non démarré** pointillé), en tête de chaque service.
- **Le drift `.env`, comparé sur l'effectif vs l'attendu — jamais des hashes.** L'attendu vient de
  `docker compose config` (Compose résout lui-même `${VAR}`, les `env_file` et les overrides — on ne
  parse **jamais** les `.env` à la main), l'effectif du `docker inspect` du container. Le diff donne un
  **badge par service** : *synchro* · *drift config* · *drift image* · *compose modifié* · *non créé*.
  Le badge est **nominatif** : « `DB_POOL_SIZE` modifiée (10 → 25), `FEATURE_X` ajoutée » te dit si le
  restart est urgent ou cosmétique. Les **valeurs des variables au nom sensible** (`*TOKEN*`, `*SECRET*`,
  `*PASSWORD*`…) sont **masquées** — « modifiée » sans montrer l'ancienne ni la nouvelle.
- **Actions** — **Stop** / Restart / Pull / **Build** (`up -d --build` : reconstruit l'image puis recrée le
  container — pour appliquer un changement de Dockerfile) / **Recréer** (le `--force-recreate` ciblé sur les
  services en drift — l'action qui découle du badge), par service et par projet, **log streamé** dans le
  panneau du bas et **état rafraîchi automatiquement** à la fin. Un `down` **liste d'abord ce qui sera
  arrêté** et **ne touche jamais aux volumes** (pas de `-v`). Ces actions sont aussi disponibles **en lot**
  via le sous-onglet *Actions* (choisir l'action → cocher les containers concernés → valider).
- **Makefile** — si un `Makefile` est à côté du compose, ses **commandes** (cibles) sont listées avec leur
  description (`cible: ## desc`). Une **recherche instantanée** filtre la liste ; un bouton **Exécuter** lance
  `make <cible>` dans le dossier (log streamé). On n'exécute qu'une cible **réellement présente** dans le fichier.
- **Hors-compose** — les containers sans projet compose. **Stop** pour ceux qui tournent ; avant tout `rm`,
  leur **`docker inspect` complet est sauvegardé** (filet de restauration) et un bouton **`Reconstituer la
  commande`** traduit l'inspect en `docker run` lisible — l'esprit des suppressions de branches restaurables.
- **Logs** — **tail live de plusieurs containers à la fois** (choix par cases, avec recherche), sur les **X
  dernières lignes**. Chaque container a sa **couleur** ; le flux **défile automatiquement**, avec un bouton
  **Pause / Reprendre** (remonter dans les logs met en pause, revenir en bas réactive — comme un terminal).
  - **Filtres, persistés** : on peut **exclure** des mots qui polluent (chaque mot est un « chip » qu'on
    **désactive sans le supprimer** ou qu'on **réintègre** d'un clic), et **n'afficher que** les lignes
    contenant certains mots. Les filtres sont **mémorisés** (pas besoin de les re-saisir à chaque fois) et
    s'appliquent **à chaud**, sans relancer le flux.
  - **Optimisé navigateur** : flux **SSE** (un `docker logs -f` par container, tué à la fermeture), **buffer
    borné** en mémoire, insertions DOM **groupées par frame** (pas de reflow ligne à ligne) et **nombre de
    lignes affichées plafonné** — reste fluide même sur des logs en rafale. Bouton **Vider** et **retour à la
    ligne** optionnel.
- **Actions** — flux **action d'abord** : on choisit **une action** (Recréer / Redémarrer / Démarrer / Stop /
  Pull), la liste des **containers concernés** s'affiche (filtrée selon l'action : *up* → arrêtés, *restart/stop*
  → en cours, *recreate/pull* → tous), on **coche** ceux voulus et on **valide**. Un **filtre d'état** réduit
  encore la liste — *En drift*, *Unhealthy*, *En restarting*, *En cours*, *Arrêtés / non créés* — et une
  **recherche** par nom. La validation regroupe les services **par projet** et lance un `docker compose`
  par projet (un échec n'interrompt pas les autres).
- **Badges de santé sur l'onglet Docker** : le **nombre de containers en erreur** (restarting / dead) en
  **rouge** et le **nombre d'unhealthy** en **orange**, directement dans le menu — visibles au démarrage et
  rafraîchis **automatiquement toutes les 30 s** (et à chaque ouverture de l'onglet) — donc un container qui
  bascule en *restarting* apparaît dans le titre du menu **même sans être sur l'onglet Docker**. Le poll est
  léger (un seul `docker ps -a`) et se met en pause quand l'onglet du navigateur est masqué.
- Si le **démon Docker n'est pas joignable** (Docker Desktop éteint, socket absent) ou si le **CLI n'est pas
  dans le PATH du serveur**, un message **actionnable** l'explique (indique `DOCKER_BIN` dans le `.env` au
  besoin) — comme les erreurs certificat / token.

### Jira
**Les tickets Jira**, récupérés automatiquement à l'ouverture du menu. Par **défaut seuls les tiens** sont
affichés, mais un **filtre par personne** permet de **cocher d'autres assignés** pour voir aussi leurs
tickets (la liste des personnes = les assignés récents ; **toi coché par défaut**, choix **persisté**). En
**liste → détail** :
- La **liste** (à gauche, avec recherche) montre chaque ticket en carte compacte : clé, résumé, **statut**
  (pastille colorée selon la catégorie : à faire / en cours / terminé), type, priorité, date de mise à jour.
  Par défaut on écarte les tickets **terminés** — une case **« Inclure les terminés »** les réintègre. Un
  **filtre par statut** (repliable, cases à cocher, **choix persisté**) permet en plus de n'afficher que les
  statuts voulus.
- Le **détail** (à droite) affiche le **contenu** (description Jira convertie d'ADF en Markdown lisible),
  toutes les **métadonnées** (statut, type, priorité, assigné, rapporteur, projet, dates, échéance,
  étiquettes, composants, versions correctives), **tous les commentaires** (auteur, date, corps en
  Markdown) et les **pièces jointes** — **téléchargées à la demande** via un **proxy serveur** qui récupère
  le fichier avec le token (un lien direct échouerait, l'API Jira exigeant l'auth). Plus un lien **Ouvrir
  dans Jira**.
- **Changer l'état du ticket** : un sélecteur dans l'en-tête liste les **transitions autorisées** (ce que Jira
  permet pour toi sur ce ticket) ; en choisir une **applique la transition** et rafraîchit le statut (détail
  + liste). Rien n'est proposé si tu n'as pas les droits.
- **Poster un commentaire** : un champ en bas de la section commentaires — le texte est converti en **ADF**
  (le format des commentaires Jira Cloud) côté serveur, et le nouveau commentaire s'ajoute au fil sans
  tout recharger.
- **Les images s'affichent directement** : les pièces jointes image ont un **aperçu à largeur fixe**, et les
  images **embarquées dans la description ou un commentaire** sont rendues **inline** là où elles
  apparaissent (résolues vers le proxy). Un **clic ouvre l'image en grand** (lightbox ; Échap ou clic dehors
  ferme). Les autres fichiers restent en « chip » téléchargeable.
- Si Jira n'est pas configuré, un message renvoie vers **Réglages → Jira** (URL + email + jeton d'API).

### Statistiques
Funnel des MR, distribution des notes, **évolution de la note moyenne par semaine** (« la qualité
progresse-t-elle ? »), activité hebdomadaire, tableau par projet (avec **taux de résolution**,
**tendance** ▲/▼ et le **dernier commit** — date, auteur, lien vers le commit sur sa forge), un **Top 5 des
dépôts à l'activité la plus récente** (dernier commit, auteur, lien), **coût en tokens** (camembert par
type d'appel + **coût moyen par MR reviewée**), résumé des sessions. L'activité de commits est récupérée
**en direct depuis la forge de chaque dépôt** (chargée à part, best-effort : rien ne casse si une forge est injoignable).
Chaque graphe affiche **la question à laquelle il répond**. Le total de tokens est un **minorant** (le
travail interne de l'agent n'est pas compté).

### Réglages
Sous-onglets : **Règles de review spécifiques** (critères ajoutés au prompt quand le nom de
branche contient un fragment donné **ou quand le diff touche un chemin** — glob type `**/migrations/**`,
`*.sql` —, plus précis ; une règle par chemin peut porter un **badge « risque »** affiché sur les MR
concernées, calculé **sans IA** juste sur les chemins du diff, pour voir d'un coup d'œil laquelle reviewer en premier) · **Dépôts** (ajout un par un ou en masse **depuis GitLab** ou **depuis GitHub** — chaque dépôt porte un badge
de forge, et un même chemin peut exister sur les deux —, plus les **répertoires locaux** — un dossier de ta machine contenant un sous-dossier par projet git, qui alimente l'onglet *Git → Navigation* et le *Codage hors dépôt* ; le décompte affiché « n projets git sur m dossiers » confirme d'un coup d'œil qu'on a désigné le bon niveau d'arborescence) ·
**Notifications** (sous-onglet dédié, voir ci-dessous) ·
**Général** (thème clair/sombre/auto, langue, et une **zone dangereuse** pour la remise à zéro) ·
**Git** (**connexion GitLab** — URL + access token, avec *Tester la connexion* —, **connexion GitHub** — URL
(vide = github.com, sinon GitHub Enterprise) + token, avec *Tester GitHub* —, **dossier de clonage**,
et la **palette de commandes git** de l'onglet *Git → Commandes Git* : ajout/édition/suppression de
commandes *nom + commande figée*) ·
**Jira** (**connexion Jira** — URL + email + jeton d'API, avec un bouton *Tester Jira* — ; alimente l'onglet
*Jira* et l'enrichissement d'une session depuis un ticket) ·
**Merge Request** (skill de review, rafraîchissement auto, convergence, templates de prompt) ·
**AI sessions** (un test technique : deux passes dans la même session d'agent — mémorise un marqueur
puis le rappelle en reprise — pour vérifier que la **reprise de session** fonctionne avec ton CLI ;
c'est le socle de la continuité de contexte entre review, corrections et convergence).

### Notifications bureau
Des notifications système pour les moments qui **appellent une action ou closent une attente** —
pas pour l'ambiance. Activées par défaut : **fin de la file de reviews** (le lot, pas chaque MR),
**review sous un seuil de note** (« MR !142 : 4,2/10 », seuil réglable), **échec d'un job**
(timeout, CLI, réseau), **session de codage terminée** et **l'IA a posé une question** (une session
attend tes réponses pour reprendre). Désactivées par défaut car informatives :
**nouvelle MR découverte** et **MR mergée**. Les notifications sont **persistantes** : elles restent
affichées jusqu'à ce que tu cliques ou les fermes, pour ne pas les manquer. Un **clic sur la notif**
ramène au bon endroit (focus de l'onglet + ouverture de la MR ou de la session concernée). Un **toggle
« mode silencieux »** dans le bandeau du bas coupe tout en un clic. Réglages fins dans le sous-onglet **Réglages → Notifications**,
avec le **statut de la permission** navigateur (accordée / refusée / à demander) et un bouton
*Tester* — parce qu'une permission refusée en silence est le piège classique de cette API.

### Langue
Interface en **français ou anglais**, au choix dans **Réglages → Général**. La préférence est
enregistrée en base — et pas seulement dans le navigateur — parce que le serveur en a besoin :
ses messages d'erreur sont affichés tels quels dans l'interface.

Les **rapports produits par l'IA suivent la langue choisie**, via les gabarits de prompt par
défaut. Un prompt que tu as **personnalisé n'est jamais écrasé** par un changement de langue :
seuls les gabarits restés au défaut sont réalignés.

> Migration en cours : la coquille de l'interface, les notifications et les messages d'erreur
> sont traduits ; le contenu des cartes et des listes est encore en français.
> Contrôle de cohérence du dictionnaire : `npm run i18n:check`.

### Confort d'usage
Onglet et sous-onglet **mémorisés** d'une session à l'autre · **raccourcis clavier** (`1`-`7` onglets,
`/` recherche, `r` chercher les MR, `l` logs, `?` aide, `Échap` ferme) · **favicon dynamique** pendant
un job · messages d'erreur **traduits en actions** (certificat, token, CLI introuvable, timeout,
réseau) · **onboarding en 3 étapes** tant que la connexion et les dépôts ne sont pas configurés ·
chaque champ de formulaire porte une **icône i** dont le survol (ou le focus clavier) explique à quoi il sert.

## Configuration (.env)

Un fichier `.env` à la racine est chargé automatiquement au démarrage.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 4319 | port du serveur |
| `HOST` | `127.0.0.1` | interface d'écoute ; `0.0.0.0` pour exposer sur le réseau — voir section **Sécurité** |
| `COPILOT_BIN` | `copilot` | binaire de l'agent IA (ex. `claude`) |
| `COPILOT_ARGS` | — | args passés AVANT `-p` (ex. `--yolo`, `--dangerously-skip-permissions`) |
| `COPILOT_DRY_RUN` | 0 | `1` = force le mode mock (sans IA) |
| `COPILOT_TIMEOUT_MS` | 900000 | timeout d'un appel IA (15 min) |
| `GITLAB_CA_CERT` | — | chemin d'un CA à épingler (GitLab self-hosted) — **recommandé** |
| `GITLAB_INSECURE_TLS` | 0 | `1` = ignore la vérif TLS **pour GitLab uniquement** (dépannage) |
| `GITHUB_CA_CERT` | — | idem pour une instance **GitHub Enterprise** à CA interne |
| `GITHUB_INSECURE_TLS` | 0 | `1` = ignore la vérif TLS **pour GitHub uniquement** (dépannage) |
| `GIT_CLONE_SSH` | 0 | `1` = clone via SSH (ta clé) au lieu de HTTPS+token |
| `MERGERIE_DATA_DIR` | `data/` | dossier de données isolé (utile pour les tests) |

L'agent IA doit pouvoir **modifier des fichiers** (mode « yolo ») pour les sessions de codage. Les explorations, elles, sont en lecture seule : les dépôts sont remis à zéro après chaque passe.

## GitLab self-hosted / GitHub Enterprise / certificat d'entreprise

Si l'API échoue avec `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (CA interne inconnue de Node) :
- **propre** : exporte le CA (chaîne complète jusqu'à la racine) et pointe `GITLAB_CA_CERT=/chemin/ca.pem`
  (ou `GITHUB_CA_CERT` pour une instance GitHub Enterprise) ;
- **dépannage** : `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1`.

Les deux réglages sont **indépendants** : épingler le CA de ton GitLab interne ne change rien aux appels
vers github.com. Pour le **clone**, `git` a son propre store : soit `GIT_CLONE_SSH=1` (clé SSH), soit les
réglages ci-dessus sont aussi appliqués à git.

## Enregistrer une vidéo de présentation (prête pour YouTube)

```bash
npm i -D playwright && npx playwright install chromium   # une seule fois
npm run record:demo                                       # → demo-recordings/mergerie-demo.webm
```

`scripts/record-demo.js` est autonome : il lance lui-même l'app en mode démo, attend le port 4319,
pilote un Chromium qui enregistre en **1920×1080** une **visite guidée** avec **faux curseur visible**,
**cartons** d'intro/fin et **légendes explicatives** synchronisées sur chaque écran — puis arrête tout
proprement (la fermeture du contexte flushe la vidéo). Le parcours : *Reviews* → un rapport noté →
sélecteur de versions **v1 → v2 → v3** (progression **5,8 → 8,4**) → suivi de résolution → *Dev IA*
(session reliée à sa MR, question posée par l'IA) → *Jira* → *Git* (explorateur de branches) →
*Docker* (drift `.env` + logs live) → *Statistiques*. Le `.webm` produit s'uploade directement sur
YouTube.

## Mode dry-run (sans IA)

`copilot`/`claude` absent ou `COPILOT_DRY_RUN=1` → rapports mock générés depuis le diff ; tout le pipeline reste testable.

```bash
COPILOT_DRY_RUN=1 npm start
npm run pipe        # smoke test du pipeline sur un dépôt synthétique
```

## Clones locaux

Chaque dépôt est cloné **une seule fois**, dans `<dossier de clonage>/<projet>`, et **réutilisé**
par toutes les opérations (review, codage, exploration, onglet Git). À chaque passage l'outil fait
un `git fetch --prune` — il ne reclone jamais. Un même clone est donc partagé, d'où le dossier
d'échange interne `ai-dev-tools-internal/` ajouté à `.git/info/exclude` pour ne jamais être commité.

Avant une **session de codage**, le worktree est **remis à zéro s'il est sale** : une session
précédente interrompue peut laisser des fichiers non commités qui feraient échouer le `checkout`.
Le nettoyage ne touche qu'au non-commité — **les commits déjà faits sont préservés**. Les reviews,
elles, ne lisent qu'un `git diff` et ne dépendent jamais de l'état du worktree.

## Données & sauvegarde

Tout l'état vit dans **`data/`** (gitignored) : `reviewer.db` (SQLite), `clones/`, `reviews/` (un dossier par MR, avec **une version de rapport par passe** : `review-v1.md`, `review-v2.md`…), `tickets/`, `tasks/` (diffs par projet et réponses d'exploration). Pense à une sauvegarde ponctuelle :

```bash
cp data/reviewer.db data/reviewer.db.bak
```

Pour lancer des tests sans toucher ta base : `MERGERIE_DATA_DIR=/tmp/mon-test npm start`.

## Sécurité

**Modèle de confiance.** L'outil est **local et mono-utilisateur** : il tourne sur *ta* machine, avec *tes*
accès, et exécute des opérations puissantes (git, Docker, agent IA, lecture/écriture de fichiers). Il n'y a
donc **pas d'authentification** — l'utilisateur du poste **est** l'utilisateur de l'app.
Par défaut, **le serveur n'écoute QUE sur `localhost`** (`127.0.0.1`) : il n'est donc **pas** joignable depuis
le réseau. L'exposer est un **opt-in explicite** via `HOST=0.0.0.0` — à **réserver à un réseau de confiance**
(ou derrière un **reverse-proxy avec authentification**), jamais sur un réseau ouvert : l'app n'a pas d'auth
et exécute des opérations puissantes sur ta machine. Aucune donnée n'est envoyée ailleurs que vers les
services que **tu** configures (ton GitLab, ton GitHub, ton Jira, ton CLI d'agent).

**Permissions de l'agent IA (« mode yolo »).** L'agent tourne avec ses garde-fous de permissions
**désactivés** (« yolo ») car les sessions de codage l'exigent : il doit pouvoir créer, modifier et
supprimer des fichiers sans confirmation à chaque étape. Son **rayon d'action nominal est le clone de
travail** (`data/clones/…`), et les garanties sont **structurelles** quand c'est possible : une exploration
est en lecture seule car le worktree est **remis à zéro dans un `finally`** après coup, une review ne fait
que **lire un diff**. Mais pendant une **session de codage**, l'agent dispose des **droits de l'utilisateur
sur la machine** — rien ne l'empêche techniquement d'agir hors du clone. C'est le **compromis assumé** d'un
outil **local mono-utilisateur** : à connaître avant usage, et une raison de plus de ne pas exposer le serveur.

**Secrets.** Le **PAT GitLab**, le **token GitHub** et le **jeton d'API Jira** sont stockés **en local** (SQLite, `data/` est
gitignored). L'API et l'UI ne les renvoient **jamais en clair** : ils sont masqués (`***`) en lecture, et
envoyer `***` en écriture **ne les écrase pas**. Le `.env` (qui peut porter des jetons d'environnement)
est lui aussi gitignored.

**Exécution sans shell.** git, Docker et l'agent sont lancés via `spawn` avec un **tableau d'arguments**,
**jamais un shell** : les métacaractères (`; | > & $()`) ne sont donc pas interprétés — pas d'injection
shell possible depuis une saisie.

**Garde-fous anti-injection ciblés** (« sans shell » ne suffit pas partout) :
- **Commandes Git** — git **uniquement**, et les options git qui permettent d'exécuter une commande
  arbitraire ou de sortir du dossier sont **refusées** (`-c`, `--upload-pack`/`--receive-pack`/`--exec`,
  `-C`, `--git-dir`, transport `ext::`…) ; la commande doit commencer par une **sous-commande**.
- **Docker** — les noms de service/container sont validés (`validRef`) et séparés par `--` (anti
  *flag-smuggling*) ; `down` **prévisualise** et **ne touche jamais aux volumes** (pas de `-v`).
- **Jira** — les `accountId` et `transitionId` sont **validés** puis quotés dans le JQL (pas d'injection JQL).
- **Répertoires locaux** — un nom de projet est validé (pas de `..`, chemin résolu **confiné sous la racine
  déclarée**) : une saisie ne peut pas faire agir l'outil hors des dossiers autorisés.

**XSS.** Le rendu échappe tout ce qui vient d'ailleurs : `esc()` sur chaque valeur interpolée, et le
convertisseur Markdown (`mdToHtml`) **échappe le HTML** avant d'appliquer une liste blanche (gras, code,
tableaux…). Les images Jira embarquées ne sont rendues **inline** que si leur URL pointe vers **notre
proxy** (pas d'image externe injectée). C'est important car les descriptions et **commentaires Jira peuvent
être écrits par d'autres personnes**.

**Pièces jointes Jira (proxy de téléchargement).** Le fichier est récupéré côté serveur avec le token :
l'`id` est **numérique** et l'URL est **construite sur la base Jira configurée** (jamais fournie par le
client) → pas de SSRF ; sur la redirection Jira→média, **l'auth est retirée hors hôte** (le token ne fuite
pas) ; la taille est **bornée** (25 Mo). Un `image/svg+xml` (qui peut contenir du script) — et tout type
non matriciel — est servi en **`attachment`** (jamais `inline`), avec **`X-Content-Type-Options: nosniff`**
et **`Content-Security-Policy: sandbox`** : ouvrir une pièce jointe ne peut pas exécuter de script sur
l'origine de l'app.

**Opérations destructrices.** Les actions à effet fort **préviennent avant d'agir** : aperçu obligatoire des
opérations git multi-dépôts, **suppressions de branches/tags restaurables** (objets rapatriés dans le clone
local avant suppression), Docker `down` en aperçu et volumes préservés, et **jamais de merge automatique**
d'une MR.

**TLS entreprise.** Pour un GitLab self-hosted ou un GitHub Enterprise à CA interne, fournis `GITLAB_CA_CERT`
/ `GITHUB_CA_CERT`. `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1`
**désactive** la vérification du certificat : à **réserver à un réseau interne de confiance**.
