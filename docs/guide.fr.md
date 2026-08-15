# Mergerie — Guide complet

> ↩ Retour au [README.fr.md](../README.fr.md) · 🇬🇧 [Guide (English)](./guide.en.md)

Ce guide détaille chaque onglet, la configuration avancée, le TLS entreprise, les clones locaux, les
données & sauvegarde et le modèle de sécurité. Pour une prise en main rapide, reste sur le
[README.fr.md](../README.fr.md).

> **Convention.** Mergerie gère **GitLab et GitHub**. Dans ce document, **« MR »** désigne
> indifféremment une *merge request* GitLab ou une *pull request* GitHub : les écrans, les actions et
> les garanties décrites sont les mêmes. Les rares différences propres à une forge sont signalées
> explicitement.

## Les onglets en détail

Neuf onglets, dans une **barre latérale** à gauche, rangés par familles — le cœur, ce que j'ai à
faire, ma machine et ses liens, le méta :
**Reviews** · **Dev IA** — **Notes** · **Jira** — **Git** · **Docker** · **Liens** — **Stats** · **Réglages**.
La barre se **réduit en icônes** d'un bouton en pied de colonne (choix mémorisé), et se réduit d'elle-même
sous 1100 px de large.
Les badges signalent le **travail en attente** (MR à traiter, sessions non lancées), pas des totaux.
L'onglet **Reviews** en porte deux : le bleu compte les merge requests **à traiter**, l'orange les
**rapports notés sous 7/10 qui attendent encore une décision**. Le second dit lesquelles lire en premier ;
il ne compte que le stade *Reviewées*, donc classer une merge request le fait redescendre — un compteur qui
ne redescend jamais cesse vite d'être regardé.
L'onglet **Notes** en porte deux aussi : le **rouge** compte ce qui presse — todos **en retard** ou en
**priorité haute** —, le **bleu** le reste des todos à faire. Leur somme est le nombre de todos ouvertes ;
au survol, le rouge dit de quoi il est fait, car il ne se lit pas seulement sur les pastilles « Haute » :
une todo normale dont l'échéance est dépassée réclame autant, et c'est justement le retard qu'on oublie.

### Reviews
Les trois stades d'une même merge request, réunis derrière un filtre segmenté —
**À traiter · Reviewées · Traitées** — avec une recherche commune (titre, auteur, projet, ticket).

- `Chercher les nouvelles MR` interroge la forge et remplit la liste (filtrée par pattern).
  Un **rafraîchissement automatique** optionnel le fait pour toi (voir Réglages).
  Les dépôts dont la case **récupérer les MR** est décochée (Réglages → Dépôts) sont ignorés
  par cette recherche : leurs merge requests déjà récupérées restent dans la file, on cesse
  seulement d'en ramener de nouvelles. À distinguer de **actif**, qui retire le dépôt de partout.
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
- **Merger ouvre une confirmation avec ses options.** Avant de fusionner, une modale rappelle la MR et
  sa branche cible, et propose **Squash** (réunir les commits en un seul) et **Supprimer la branche source
  après le merge**. Les deux cases sont pré-cochées d'après ce qui avait été choisi à la création de la MR.
- **Créer une MR** ouvre la même famille de modale : titre pré-rempli, et les deux mêmes options. GitLab
  les retient dès la création ; **GitHub ne sait pas les exprimer à la création** — Mergerie les mémorise
  alors et les applique au merge, ce que la modale indique.
- `Merger` merge la MR **directement, sans review** — pour une MR triviale : on confirme, et si le
  merge a réellement lieu la MR sort de la file (marquée traitée). Disponible aussi dans le panneau de
  décision de `Voir le diff`, là où l'on juge justement de la trivialité.
- `Classer sans review` sort une MR de la file, avec **annulation** possible pendant quelques secondes.
- Les reviews s'empilent dans une **file séquentielle** ; un **panneau de log en direct** montre les
  commandes, la sortie et la progression, avec un bouton **Stop** (qui vide aussi la file — la
  confirmation le précise), un **chronomètre** depuis le démarrage et, une fois le rythme établi, une
  **estimation du temps restant** (elle se tait plutôt que de mentir quand la cadence dévie).
- **Voir la file d'attente et lancer en parallèle.** Le panneau de log liste ce qui attend, et propose
  de **promouvoir un job en parallèle** (jusqu'à **3 à la fois**) quand il ne touche **aucun dépôt ni
  dossier** en commun avec ce qui tourne déjà — la collision est refusée, pas arbitrée : deux agents sur
  le même clone le corrompraient. Chaque job promu a **son onglet** dans le panneau, avec **son propre
  bouton Stop** ; l'onglet reste après la fin, pour relire la sortie. Un job **interrompu** peut être
  **relancé** depuis la file.
- **Modifier son propre commentaire.** Un commentaire posté depuis Mergerie — **en ligne** dans
  l'explorateur ou **en général** sur la MR — peut être **réécrit** sans passer par la forge. Seuls les
  siens : ceux des collègues sont en lecture seule.
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
- **Les demandes de modification sont conservées.** La section `Demander une modification à l'IA` liste
  les demandes déjà faites sur ce rapport, **avec leur date**, et un bouton ouvre **le rapport que chacune
  a produit** (la version correspondante). On retrouve ainsi ce qui avait été demandé pour arriver à un
  rapport donné, au lieu de le reconstituer de mémoire.
- Sur un rapport : **régénérer** le rapport, **commenter** la MR, **merger**, **relancer la review**,
  **marquer traitée**, **supprimer le rapport** (la MR retourne « à traiter »), et surtout
  **Faire corriger le code par l'IA** — qui ouvre une session de codage pré-remplie avec le rapport
  injecté dans le prompt, pour ajuster avant de lancer. Si la branche vient d'une **session de codage**,
  son **identifiant de session est pré-rempli** : l'IA reprend le fil de son propre travail au lieu de
  redécouvrir un code qu'elle vient d'écrire. C'est une proposition, pas une règle — le lien est déduit
  du dépôt et de la branche, ce qui n'est pas une preuve : vider le champ repart d'une session neuve. Les sessions ouvertes depuis une MR proposent
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
  L'onglet Stats en tire un **taux de résolution par projet**.
- Une MR qui n'est plus ouverte sur la forge porte le badge **mergée** ; le bouton Merger disparaît.
- **Filtrer par couleur de note.** Sous *Reviewées* et *Traitées*, trois cases au-dessus de la liste —
  vert (≥ 7/10), orange (4 à 6,9), rouge (< 4) — **se cumulent** : « montre-moi les rouges et les
  oranges » tient en deux clics, et chacune porte le nombre de merge requests qu'elle fera apparaître.
  Le choix est retenu d'une visite à l'autre ; décocher la dernière case ramène tout, plutôt que de
  laisser une liste vide sans issue. Le résumé de droite suit le filtre. Le stade *À traiter* n'a pas
  ces cases : une MR n'y revient qu'après suppression de son rapport, donc sans note à filtrer.
- **Liste et rapport défilent chacun pour soi.** Descendre la liste pour changer de merge request
  n'emporte plus le rapport hors de l'écran — on regarde les deux ensemble.

### ⛶ Ouvrir le code (explorateur plein écran)
Arbre du projet + fichier affiché **entier avec le diff en place**, coloration syntaxique,
**mini-carte** des changements, navigation entre modifications, panneaux repliables.
**Commentaire inline** par ligne et **réponses** aux fils, synchronisés avec la forge — et
**modifiables** tant qu'ils sont de toi.

**Deux façons de commenter, au choix.** `Commenter sur GitLab` publie tout de suite, comme
avant. **`Enregistrer`** garde la remarque **en attente**, en local : on relit une MR fichier par
fichier, et envoyer une par une bombarde l'auteur de notifications tout en figeant des remarques
qu'on aurait retirées trois fichiers plus loin. Un commentaire en attente se **corrige** et se
**supprime** tant qu'il n'est pas parti ; il s'affiche sous sa ligne avec un liseré ambre et la
mention **« En attente d'envoi »** — le même rendu qu'un commentaire publié ferait croire le
travail fait. Le bouton **`Envoyer les commentaires (n)`**, dans l'en-tête, les publie tous d'un
coup ; c'est aussi lui qui rappelle qu'un travail attend, sans quoi on referme la MR en laissant
ses remarques en local.

⚠ **L'envoi confirme et dit combien partent** — publier notifie l'auteur — et **ce qui échoue
reste en attente**, avec sa raison : une erreur réseau sur le troisième commentaire ne doit pas
emporter les deux premiers ni la demi-heure de relecture. La **position** (fichier, ligne, SHAs)
est résolue **à l'envoi**, comme pour un commentaire direct : une MR qui a bougé entre-temps ne
reçoit pas des remarques accrochées à un état du code qui n'existe plus.

Dans l'arbre, les dossiers **porteurs d'un changement sont dépliés d'office**, les autres repliés — mais
**ce que tu ouvres ou refermes à la main est retenu** le temps de la visite : cliquer un fichier ne
referme plus le dossier qui le contient. L'arbre repart de la règle par défaut au diff suivant.

### Dev IA
Une **recherche** en tête de liste (prompt, projet, branche, dossier) filtre les sessions du sous-onglet
courant — utile dès qu'elles s'accumulent. Elle se remet à zéro quand on change de sous-onglet, pour ne pas
contredire les compteurs qui affichent des totaux.

Les listes montrent **en tête ce qui vient de finir de s'exécuter** — et au-dessus de tout, ce qui tourne
en ce moment. C'est la date de fin d'**exécution** qui décide, pas la dernière modification : corriger un
prompt, pousser une branche ou ranger une session ne la fait pas remonter devant celle qui vient de
tourner. Une session jamais lancée se range à sa date de création.

Deux sous-onglets. Dans les deux cas, une session porte sur **un ou plusieurs projets**, chacun avec
sa propre branche, et sa date de création est affichée. Le **choix du dépôt se fait au clavier**
(sélecteur avec recherche), comme celui des branches — utile quand la liste des dépôts est longue.

**Ranger les sessions terminées.** Une session finie se **masque** sans être supprimée ; une case
**« afficher les sessions masquées »** (dont l'état est mémorisé) les fait revenir, et un compteur
rappelle combien sont filtrées. Vaut pour le codage, le codage hors dépôt et l'exploration. Dans la
liste, un prompt long est **replié sur trois lignes** avec un **« Voir plus »** qui le déroule entier.

**Une session arrêtée sur une question pose sa todo.** Quand l'IA s'interrompt pour demander
quelque chose, une **todo de priorité haute** est créée automatiquement — « Répondre à l'IA —
session #12 », avec les projets concernés en note. La file est libre, plus rien ne repartira, et
la notification est fermée depuis longtemps : la todo, elle, reste sous les yeux dans *Notes* et
dans le brief du matin. **Répondre la referme** (cochée, pas supprimée : ce qu'on a fait de sa
journée se relit dans « Faites »).

⚠ Sur une session **multi-dépôts**, elle ne se referme que lorsque **plus aucun** projet n'attend :
répondre au premier ne solde pas le travail, et une todo cochée trop tôt fait oublier les quatre
autres. Elle reste une todo **ordinaire** — on peut la cocher, l'éditer, la supprimer : l'outil la
pose et la referme, il ne reprend pas la main sur ce qu'on en a fait.

**Un libellé, facultatif.** Un titre court à la création d'une session — codage, hors dépôt ou
exploration. Une liste se lit sinon par son prompt, trois lignes repliées dont les premiers mots se
ressemblent d'une session à l'autre ; le libellé dit **de quoi il s'agit** quand le prompt dit **ce
qu'il faut faire**. Il s'affiche en tête de carte, entre dans la recherche, et se modifie après coup.
Laissé vide, la carte est exactement ce qu'elle était.

⚠ **Le libellé ne part PAS à l'IA**, et ne sert pas de message de commit. C'est un titre de
rangement, écrit pour l'humain qui parcourt la liste — pas une consigne. Le glisser dans le prompt
changerait ce que l'agent produit sans que personne ne l'ait demandé, et deux sessions au même
prompt mais au libellé différent ne rendraient plus la même chose. Un test le garde fermé, y compris
contre un module qui se mettrait à le lire.

**Le message de commit choisi vaut pour TOUS les commits de la session.** Renseigné, le champ
*Message de commit* est la règle : le premier run, chaque **suivi**, la reprise après questions et
les passes de convergence commitent sous ce message. C'est ce qu'attend celui qui préfixe ses
commits — une clé de ticket, une convention d'équipe : un suivi qui repartirait sur sa propre
première ligne casserait la règle au moment précis où on ne relit pas, et le commit fautif est déjà
poussé. Laissé vide, rien ne change : chaque geste garde son défaut, qui **dit ce qu'il vient de
faire** (la première ligne du prompt pour le run, celle du suivi pour un suivi).

Et s'il est renseigné **après coup** — on lance, on voit passer un commit mal nommé, on remplit le
champ, on relance —, le **dernier commit est renommé** : l'IA constate que tout est déjà fait et ne
commite rien, donc sans ça le champ qu'on vient de remplir n'aurait rien à nommer. Seul le message
change, le contenu du commit est intact et il n'y a pas de commit de plus. ⚠ **Sauf si la branche est
déjà sur `origin`** : renommer un commit publié réécrirait une histoire que la forge — et peut-être
une merge request, et peut-être un collègue — a déjà. Le journal du job le dit alors, plutôt que de
se taire ou de le faire dans le dos.

**Un suivi écrit pendant que ça tourne, envoyé quand tu le décides.** La remarque vient en lisant
ce que l'agent fait — pas vingt minutes plus tard, une fois la session finie et l'esprit ailleurs. Sur
une session en cours, **`Préparer un suivi`** ouvre le même formulaire que **`Envoyer un suivi`**,
avec **`Enregistrer le suivi`** au lieu d'`Envoyer` : le texte reste **sur la carte**, sous les yeux,
tant qu'il n'est pas parti. On le **corrige**, on le **supprime** (l'effacer suffit), et **`Envoyer le
suivi`** le lance en un geste une fois la session terminée. Vaut pour le codage, le codage hors dépôt
et l'exploration.

**Ou il part tout seul, si tu le demandes.** Une case **`L'envoyer automatiquement à la fin de la
session`**, sous le texte, arme le suivi : il partira dès que la session aura fini de travailler, sans
que tu aies à revenir. La carte le dit — **`Suivi armé`** au lieu de **`Suivi en attente`** — et il ne
part **qu'une fois** : le texte est retiré et la case désarmée avant le lancement, sinon la passe de
suivi retrouverait la même consigne en finissant et la session tournerait en boucle. Rien ne part non
plus après un **échec**, ni sur une session qui **attend une réponse**.

⚠ **Décochée, la case ne fait rien — et c'est le défaut.** Le bouton d'envoi reste **désactivé** tant
que la session tourne, et un suivi non armé attend indéfiniment ton geste. Un envoi automatique est un
choix qu'on pose en écrivant la remarque, jamais un effet de bord : la colonne n'est lue que par la
fonction qui décide d'envoyer, et aucun module parlant à l'agent ne la connaît — deux tests le gardent
fermé. Si tu as choisi un **vérificateur**, il attend la fin du suivi automatique : un verdict rendu
sur du code qui va encore changer ne vaudrait rien.

**Relancer demande confirmation.** Sur une session qui a déjà tourné, `Relancer` ouvre une
confirmation qui dit **ce qui va se passer** : l'IA repart du **prompt initial**, sur le travail déjà
produit, et ce qui a été demandé depuis — suivis, réponses aux questions — n'est pas rejoué. Le bouton
voisine avec ceux dont on se sert tout le temps, et le clic de trop coûte une session entière. La
**toute première** mise en route, elle, reste un seul clic : il n'y a rien à protéger. Vaut aussi pour
le `Relancer` d'un projet en particulier.

**Créer maintenant, lancer plus tard.** Les trois types de session proposent **`Créer sans lancer`** à
côté de **`Créer et lancer`** : on prépare le prompt et les cibles, on lance quand on veut.

**Vérifier après, sans y penser.** Un champ facultatif **`Vérifier après`** à la création d'une
session de codage : le vérificateur choisi part **tout seul, une fois, à la fin** — après la
convergence si tu converges, après le codage sinon. On lance la session le matin, on trouve un
verdict, pas une case à cocher de plus.

Seuls les vérificateurs qui **couvrent tous les dépôts** de la session sont proposés : un vert
partiel ne dirait rien de la moitié du lot, ce qui est pire qu'une absence de verdict. La liste se
refait quand tu changes de projets.

Un vérificateur lit ce que la **forge expose** : il lui faut donc du code poussé. Choisir un
vérificateur **coche l'auto-push** et le dit ; décocher l'auto-push **retire le vérificateur**. Le
serveur applique la même règle de son côté — un écran n'est pas un garde-fou, et l'API est appelable
sans lui.

Trois refus, silencieux pour la session mais **écrits dans son journal** : rien n'a été poussé, le
vérificateur ne couvre plus tous les dépôts, ou une autre vérification tourne déjà sur ces dépôts.
Et un échec au lancement de la vérification **ne fait pas échouer la session** : le code est écrit et
poussé, annoncer une erreur mentirait sur ce qui s'est passé.

**Reprendre une session d'agent existante.** Un champ **facultatif « identifiant de session »** à la
création (codage, hors dépôt, exploration) fait travailler l'IA **dans cette session-là** au lieu d'en
ouvrir une nouvelle — elle garde donc tout le contexte déjà acquis. Renseigné, il rend aussi disponible
le bouton **« Reprendre au terminal »**. Le champ est également modifiable après coup.

**Enrichir depuis un ticket Jira (optionnel).** Si Jira est configuré (Réglages → Jira), la modale
propose un champ **N° de ticket** avec un bouton **Récupérer** : le **titre + la description** du ticket
sont récupérés via l'API Jira et **ajoutés en tête du prompt** comme bloc de contexte — visible et
**éditable** avant de lancer. Le numéro est **pré-rempli** si la branche de travail contient déjà une
clé (ex. `feature/PROJ-1234-…`). Disponible pour le codage **et** l'exploration.

- **Codage** — l'IA modifie le code. Pour chaque projet : branche de travail, et **branche de départ**
  facultative (liste déroulante avec recherche ; vide = branche par défaut du dépôt). Le prompt est
  appliqué à chaque projet, séquentiellement — **un projet en échec n'interrompt pas les autres**.
  Chaque projet a ensuite ses propres actions : **Voir le diff · Pousser · Créer la MR · Merger**.
  **`Voir le diff`** ouvre le **même explorateur plein écran que celui des merge requests** —
  arborescence complète du projet au milieu, fichier entier avec les changements en place à droite
  (navigation d'un changement à l'autre, mini-carte) — avec, à gauche, le **retour de l'IA** au lieu
  du rapport de revue. On lit donc ce que l'IA dit avoir fait *et* ce qu'elle a réellement écrit, côte
  à côte, dans le contexte du fichier entier plutôt que dans un patch brut. Un
  **fil d'étape** compact (pastilles **créée → commit → push → MR**) sur chaque ligne situe d'un
  coup d'œil où en est le projet — utile sur une session multi-projets.
  **`Envoyer un suivi`** poursuit la session sur les branches existantes, **sans repartir de zéro** — une
  correction, une précision, une question sur ce qui vient d'être fait :
  l'IA garde tout le contexte du travail déjà produit (idem pour une relance de la session). Sur une
  session multi-dépôts, **chaque projet porte son propre bouton** : une remarque ne vaut presque jamais
  pour les cinq dépôts (« utilise plutôt AbortController ici » ne veut rien dire ailleurs), et l'envoyer
  à toute la session coûte un appel IA par dépôt pour refaire du travail déjà bon. Le bouton de la carte,
  lui, s'adresse toujours à tous. Une **exploration** répond d'un seul tenant : elle ne se restreint pas
  à un dépôt.
  À la fin du codage, **`Retour de l'IA`** affiche ce que l'agent dit avoir fait (comme la réponse d'une
  exploration) — utile pour comprendre son travail, ou **quand rien n'a changé** : si le prompt était
  incomplet et que l'IA a **répondu au lieu de coder** (ex. « donne-moi le nom du fichier »), sa réponse
  est **remontée directement** dans l'erreur du projet plutôt qu'un « aucun changement » opaque.
  En revanche, si la branche **porte déjà le travail** — cas d'une relance après un échec survenu
  *après* le commit, un push refusé par exemple —, l'absence de nouveau changement n'est **pas** une
  erreur : la session reprend son état « commit prêt », avec le diff et le bouton de création de MR.
- **Activité — ce que tu as lancé, et ce qui s'est terminé.** Le panneau de log expose une vue
  **Activité** : ce qui a tourné, sur quoi, combien de temps, et comment ça s'est fini. Chaque ligne
  **nomme son objet** et y mène en un clic ; un bouton rouvre le **journal d'un job passé**. Ce qui
  s'est terminé depuis ta dernière visite est marqué, et le compte s'affiche sur le bouton. Les
  notifications bureau ne répondaient pas à cette question : elles ne vivent qu'en mémoire du
  serveur et ne sont volontairement pas rejouées au chargement — donc tout ce qui finissait onglet
  fermé n'existait nulle part.
- **La liste des projets s'ouvre repliée.** Au-delà de quelques dépôts, une session occupait tout
  l'écran et masquait les autres — qui sont pourtant ce qu'on est venu regarder. Un « Voir les N
  projets » la déplie, et l'état est **mémorisé par session** : sinon le rafraîchissement automatique
  la refermerait toutes les secondes et demie pendant un job. Vaut pour les trois familles (codage,
  codage hors dépôt, exploration).
- **Pousser tous · Créer toutes les MR.** Deux actions groupées, qui n'apparaissent que lorsqu'elles
  ont quelque chose à faire (le nombre concerné est dans le libellé). **Pousser tous** pousse en un
  seul job toutes les branches commitées mais pas encore poussées. **Créer toutes les MR** ouvre une
  merge request pour chaque projet poussé qui n'en a pas : la modale demande les options **une fois**
  — squash, suppression de la branche source — et chaque MR reprend le **message de commit de la
  session** comme titre, plutôt que de réclamer dix titres à la suite. Dans les deux cas, un projet
  en échec n'interrompt pas les autres et le bilan nomme ceux qui ont échoué.
- **Lancer un projet à la fois.** Sur une session multi-dépôts, chaque projet porte son propre
  bouton **Lancer**, et une session comptant plusieurs échecs propose **Relancer les projets en
  échec**. Auparavant une session ne se relançait qu'en bloc : sur dix dépôts dont six avaient
  réussi, cela coûtait six appels IA pour refaire un travail bon, et faisait repasser l'agent sur du
  code qu'on ne voulait plus voir modifier. Une passe ciblée ne **réserve que ses dépôts**, donc deux
  projets d'une même session sur des dépôts distincts peuvent tourner en parallèle. Relancer la
  session entière reste à un clic — rien n'est devenu implicite.
- **Vérifier l'état des branches — réparer sans dépenser d'appel IA.** Quand des projets sont restés
  en erreur alors que leur travail est déjà commité, un bouton sur la session **relit l'état réel de
  chaque branche** : si elle porte des commits, le diff est régénéré et le projet repasse « commit
  prêt » (ou « poussée »), bouton de création de MR compris. Rien n'est maquillé — une branche
  réellement vide reste en erreur, avec son message. Relancer la session réparerait la même chose,
  mais au prix d'**un appel IA par dépôt** pour refaire un travail déjà fait. Le bouton n'apparaît
  que s'il y a au moins un projet en erreur, et l'opération passe par la file de jobs : toucher un
  clone pendant qu'un agent y écrit le corromprait.
- **Exporter une réponse.** La vue plein écran d'un retour d'agent (comme d'une réponse
  d'exploration) porte un bouton **Exporter** : **HTML**, **Word (.docx)** ou **PDF**. Le HTML est un
  document **autonome** — styles embarqués, aucune ressource extérieure : il se lit hors ligne et
  s'envoie tel quel. Le `.docx` est un vrai document Word (titres, listes, tableaux, blocs de code),
  fabriqué sans rien installer. Le **PDF** passe par la fenêtre d'impression du navigateur, où l'on
  choisit « Enregistrer au format PDF » : le rendu est celui qu'on a sous les yeux, et Mergerie
  n'embarque pas un moteur de rendu de 300 Mo pour un bouton. Dans les trois cas, le document porte
  son titre et sa date : un fichier transféré perd son nom bien avant son contenu.
- **Toutes les itérations sont conservées.** Une session s'itère (lancement, `Envoyer un suivi`,
  réponses aux questions, passes de convergence) : chaque passe garde **le prompt réellement envoyé** et
  **le retour de l'IA correspondant**. Un **sélecteur d'itération** apparaît en haut de `Retour de l'IA`
  dès la deuxième passe (« Itération 2 · correction demandée · 29/07 00:42 ») et permet de relire
  n'importe laquelle. Relire une réponse sans savoir à quelle demande elle répondait n'apprend rien : les
  deux sont donc affichés ensemble. Vaut aussi pour le **codage hors dépôt**, dossier par dossier.
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
  incomplet, l'IA a répondu au lieu de coder) —, et la session propose **`Envoyer un suivi`** :
  une nouvelle passe sur les mêmes dossiers qui **reprend la session de chacun**, donc l'IA garde tout
  le contexte de ce qu'elle vient de produire. Une session hors dépôt est **modifiable** après coup
  (prompt, dossiers, identifiant de session), comme une session sur dépôt. ⚠ **Aucun filet** : l'agent modifie les fichiers en place, sans
  sauvegarde ; sur un dépôt git tu peux relire/annuler toi-même (`git diff` / `git checkout`), sur un
  dossier non-git il n'y a **pas d'annulation** — un avertissement le rappelle. (Sous-onglet dédié, entre
  *Codage* et *Exploration*.)
- **Exploration** — **lecture seule** : tu poses une question sur un ou plusieurs projets, l'IA explore
  le code et rédige **une seule réponse de synthèse** enregistrée en `.md`, consultable à tout moment
  via `Voir la réponse`. Ni diff ni merge. Une **question de suivi reprend la même session d'agent** —
  comme pour le codage — au lieu de lui réinjecter sa réponse précédente : l'IA se souvient de son
  exploration au lieu d'en relire un résumé. Les dépôts sont remis à zéro après coup :
  **aucune modification ne subsiste**. Chaque exploration expose elle aussi
  **« Reprendre au terminal »** pour continuer la conversation toi-même.
  **Chaque question est conservée** : une question de suivi écrase le fichier de réponse, mais la passe
  est archivée — `Voir la réponse` propose un **sélecteur d'itération** qui rejoue chaque question avec
  la réponse qu'elle a obtenue.

### Notes
Les post-it et l'onglet bloc-notes du quotidien, **dans l'outil** — donc **ancrés** à ce qu'on y suit
(merge requests, tickets) et **dans la sauvegarde**. Trois sous-onglets : **Aujourd'hui** (le brief),
**Todos**, **Pages**. Rien ne part vers l'IA ni vers une forge : tout vit dans la base locale, et
**aucun token n'est consommé** par cet onglet.

#### Aujourd'hui — le brief du matin
Sept sections, **ordonnées « action d'abord »** : ce qui réclame un geste avant ce qui informe. Chacune
est **masquée quand elle est vide** — un écran qui affiche sept titres dont six sous-titrés « rien »
apprend qu'il ne s'est rien passé, ce qui n'était pas la question. Chaque ligne mène à son objet en un clic.

1. **Rappels** — les échéances échues et celles du jour, avec la case « fait » et les boutons de report
   **sur place** : c'est tout l'intérêt d'un brief, agir sans changer d'écran.
2. **Todos du jour** — les priorités **hautes sans date** et les échéances d'aujourd'hui. Les hautes sans
   date sont là parce que « important mais sans échéance » est exactement ce qui se perd : rien ne le
   remonte jamais tout seul. Une todo déjà listée en *Rappels* n'y réapparaît pas.
3. **Sessions en attente de réponse** — les sessions où l'IA a posé une question. Ce sont les plus
   coûteuses à oublier : la session est bloquée, la file est libre, et rien ne repartira sans toi.
4 bis. **Sessions de dev en attente** — trois nombres, un seul oubli : le travail est fait, il ne
   manque qu'un geste. Une session **jamais lancée** ne produira rien ; un projet **commité mais
   pas poussé** n'existe pour personne ; une branche **poussée sans merge request** ne sera jamais
   relue. Des nombres et non des listes — le détail vit dans *Dev IA*, et à trois lignes de plus
   le brief cesserait d'être un brief. Une branche qui a **déjà** une MR ouverte (même créée
   ailleurs) ne compte pas : proposer d'en ouvrir une seconde serait pire que de se taire.
4. **Vérifications en échec** — le dernier verdict rouge par lot ou par MR. Les verdicts **périmés** en
   sont écartés : la branche a bougé, le verdict porte sur du code qui n'est plus là, et l'afficher
   enverrait corriger un problème peut-être déjà corrigé.
5. **MR à traiter** — celles **arrivées depuis hier**, pas la file entière (elle a son onglet et son badge).
6. **MR dormantes** — reviewées il y a plus de **N jours** (réglable, 5 par défaut) et toujours ouvertes :
   le travail est fait, la décision manque.
7. **Activité depuis hier** — une ligne, trois nombres. Volontairement pauvre : c'est du contexte, pas une
   tâche ; le détail vit dans *Stats*.

**Écarter une ligne qui revient tous les matins.** Le brief recalcule tout à chaque ouverture : un fait
qui reste vrai reparaît indéfiniment, même traité ailleurs — une vérification rouge dont on a déjà fait le
tour finit par apprendre à ne plus lire la section. Une **croix** au survol de la ligne l'écarte : elle
disparaît du brief et n'y revient plus. Vaut pour les vérifications, les sessions en attente et les MR.

⚠ **On écarte un constat, pas un sujet.** La croix retient l'objet vu — *ce verdict-ci*, *cette MR-là* :
une **nouvelle** vérification du même lot porte un autre identifiant et reparaîtra. C'est voulu — sinon une
vraie régression resterait invisible pour toujours. Rien n'est supprimé (le verdict garde sa page dans
*Reviews*), le brief affiche en pied **combien** de lignes il cache, et **`Tout réafficher`** les ramène
d'un bouton. Une ligne écartée fait **remonter la suivante** : les sections plafonnent à huit, et une
section qui rétrécit à chaque geste finirait par mentir sur ce qu'il reste à faire.

Tout est calculé **en SQL, sans IA et sans réseau** : le brief s'affiche instantanément, avant le premier
café, et ne coûte rien. Un résumé rédigé par un agent était tentant ; il aurait fait payer un appel chaque
matin pour reformuler des faits qui se lisent déjà.

**Atterrissage.** À la **première ouverture de la journée**, l'application s'ouvre ici plutôt que sur le
dernier onglet consulté. Une fois par jour calendaire, jamais deux — sinon chaque rechargement ramènerait
sur le brief celui qui lisait un rapport. Débrayable dans *Réglages → Général*.

#### Todos
Une liste plate, triée **par priorité d'abord, puis dans l'ordre que tu lui donnes**. Deux questions
différentes, chacune garde sa réponse : la priorité dit **ce qui presse**, ton ordre dit **dans quel ordre
tu t'y prends** à l'intérieur de ce qui presse. « À faire » se réordonne à la souris (poignée à gauche,
glisser-déposer) ou au clavier (deux flèches par ligne — glisser n'est ni annonçable ni fiable au clavier
et au doigt), et l'ordre est **enregistré** : un ordre qui ne survit pas au rechargement n'est pas un
ordre.

⚠ **On ne réordonne qu'à l'intérieur d'une priorité.** Emmener une todo dans un autre groupe la ferait
revenir aussitôt, et un geste qui n'aboutit pas est pire que pas de geste : les flèches s'éteignent aux
frontières de groupe, et le glisser ne les traverse pas. Pour changer de groupe, on change la **priorité**
— c'est un autre geste, et il est explicite. L'**échéance**, elle, ne trie plus rien ici : elle reste
affichée et continue d'alimenter le **brief du matin** et les **rappels**. Le jour de la mise à jour, ta
liste garde exactement l'ordre qu'elle avait. Les vues **Faites** et **Archivées** gardent leur ordre
chronologique : on n'arrange pas son tiroir.

- **Ajout inline** en tête de liste : on tape, Entrée, c'est créé — priorité normale, sans date. Une todo
  neuve se range **en tête**, là où on vient de la taper ; la chercher en bas d'une liste de trente serait
  absurde.
- **Statut binaire** : à faire / fait. Pas de « en cours » : une todo de poste de travail se coche, elle
  ne se pilote pas.
- **Priorité** haute / normale / basse. La normale n'affiche aucune pastille — la baliser serait du bruit.
- **Échéance = rappel** : une seule date, qui sert des deux côtés. Elle s'affiche **en relatif**
  (« demain 9 h », « dans 3 j »), et **en rouge seulement si elle est dépassée** : une échéance à venir
  n'est pas une alarme.
- **Report** en un clic : **+1 h** ou **demain 9 h**. « Demain 9 h » veut dire 9 h **au cadran**, pas
  « dans 24 heures » — un changement d'heure ne doit pas décaler le rendez-vous.
- **Lien optionnel** vers une merge request, un ticket ou un dépôt : la ligne devient cliquable.
- **Rien n'est supprimé.** Une todo faite reste **barrée sept jours** — on veut voir ce qu'on a fait cette
  semaine — puis passe dans **Archivées**, où elle reste consultable. La rouvrir la sort du tiroir.
  Le bouton *Supprimer* existe, mais cocher « fait » est le geste normal.
- Trois filtres : **À faire · Faites · Archivées**.
- Le **menu** porte le compte : rouge ce qui presse (en retard ou priorité haute), bleu le reste à faire.

#### Capture rapide — la touche `n`
Depuis **n'importe quel onglet**, `n` ouvre une mini-modale : un champ, **Entrée** crée la todo, **Échap**
annule. Un lien *« + détails »* déplie priorité, échéance et note quand c'est utile. Après création, un
toast discret — **et aucune navigation** : on était en train de faire autre chose. Si la capture coûtait
plus de deux secondes, on retournerait au post-it. La touche est ignorée quand le curseur est dans un
champ de saisie.

#### Pages
Des pages de notes **plates** : ni dossiers ni hiérarchie. À gauche la liste (**épinglées en tête**, puis
les plus récemment modifiées) avec une **recherche qui porte sur le titre ET le contenu** — c'est souvent
dans le corps que se trouve le mot cherché. À droite le titre éditable, puis **la saisie et l'aperçu
Markdown côte à côte** (le même rendu que les rapports de review, donc le même échappement).

- **Autosauvegarde** à la frappe, avec un délai d'une seconde et un indicateur discret « Enregistré ».
  Enregistrer à chaque caractère ferait une requête par lettre ; n'enregistrer qu'à la fermeture perdrait
  le travail d'une page restée ouverte.
- **Épingler** garde une page en tête de liste.
- **Exporter** télécharge la page en `.md`, au nom **slugifié** depuis le titre.
- **Supprimer** demande confirmation — c'est la seule action irréversible de l'onglet.

#### Autolink — `!214` et `PROJ-720` deviennent des liens
Ce qu'on écrit dans une note, ce sont les identifiants du quotidien. Ils deviennent cliquables **au rendu**
(pages, notes de todos) ; le **stockage reste du texte brut** — on relit ses notes ailleurs, et un `.md`
exporté ne doit pas charrier du HTML.

- `!214` → la merge request. **Un seul dépôt** porte ce numéro : lien direct. **Plusieurs** : lien vers
  *Reviews* avec la recherche pré-remplie, qui montre les candidats — on ne devine pas, un lien faux est
  pire qu'un lien qui demande de choisir. **Aucun** : le texte reste du texte, pas de lien mort.
  Sont résolues les merge requests encore **ouvertes**, plus celles qui ont bougé dans les **six
  derniers mois** : au-delà, une MR fermée n'est plus une référence qu'on écrit dans une note, et
  relire toute la table à chaque ouverture de l'onglet coûterait cher pour trois références.
- `PROJ-720` → le ticket, **si Jira est configuré**.
- Une **URL collée** devient cliquable (nouvel onglet). **`http`/`https` seulement** : une note est du
  texte qu'on colle sans le relire, et un lien fabriqué n'a pas à pouvoir exécuter quoi que ce soit —
  `javascript:` et consorts restent du texte. La ponctuation qui ferme la phrase reste dehors, et une
  référence **contenue dans une URL** n'est pas re-transformée (coller un lien Jira ne fabrique pas un
  second lien à l'intérieur du premier).
- Rien n'est transformé **dans un bloc de code** : `!42` dans un extrait de shell est du code.
- Le contenu est **échappé d'abord**, l'autolink s'applique **après** et n'injecte que des balises qu'il
  fabrique lui-même. Aucun fragment d'une note ne peut devenir du balisage.

#### « Ajouter aux todos », depuis une MR ou un ticket
Un bouton sur le **détail d'une merge request** et sur celui d'un **ticket Jira** ouvre la capture rapide
**pré-remplie** : titre proposé (`Suivre !214 — <titre>`), lien posé, priorité normale, sans date — tout
reste éditable. Si une todo ouverte suit **déjà** cet objet, le bouton devient **« Voir la todo »** :
créer un doublon silencieux serait la façon la plus sûre de rendre la liste inutilisable en une semaine.

#### Rappels
Le canal est celui des **notifications bureau** existantes, avec sa propre catégorie **« Rappels »**
(activée par défaut, *Réglages → Notifications*).

- Une échéance atteinte donne **une** notification, **une seule fois** — et **repousser la fait
  re-sonner** : sans cela, snoozer un rappel déjà notifié le rendrait définitivement muet.
- La notification est marquée comme envoyée **après affichage**, pas à la lecture de la liste : une
  notification qui échoue (permission refusée, onglet fermé entre-temps) ne doit pas consommer l'unique
  occasion de prévenir.
- **Rattrapage au démarrage** : si plusieurs rappels sont en retard au chargement, ils donnent **une seule
  notification groupée** (« 3 rappels en attente ») — dix pop-ups au démarrage se ferment sans être lues.
- ⚠ **Limite à connaître** : les rappels partent du navigateur. Il faut donc que **l'onglet Mergerie soit
  ouvert quelque part**. Un rappel dû pendant que tout est fermé n'est pas perdu — il part au prochain
  chargement, dans le rattrapage.
- Les boutons de report sont **dans l'interface**, pas dans la notification : des actions de notification
  exigeraient un service worker, hors périmètre.

Les notes, les todos et leur historique vivent dans la **base du dossier de données** : ils sont donc
couverts par la **sauvegarde** (*Réglages → Général*), au même titre que les rapports de review.

### Jira
Deux sous-onglets : **Mes tickets** et **Surveillés**. Le menu porte une **pastille** = le nombre de
tickets **en cours qui te sont affectés** (catégorie de statut *In Progress*, la seule définition qui
traverse les workflows, les noms d'états étant libres d'un projet à l'autre). Elle est alimentée par un
compteur **mis en cache côté serveur** et rafraîchi par la surveillance : l'afficher ne coûte pas un appel
Jira à chaque passage.

#### Mes tickets
**Les tickets Jira**, récupérés automatiquement à l'ouverture du menu. Par **défaut seuls les tiens** sont
affichés, mais un **filtre par personne** permet de **cocher d'autres assignés** pour voir aussi leurs
tickets (la liste des personnes = les assignés récents ; **toi coché par défaut**, choix **persisté**). En
**liste → détail** :
- La **liste** (à gauche, avec recherche) montre chaque ticket en carte compacte : clé, **epic** de
  rattachement quand il y en a un, résumé, **statut** (pastille colorée selon la catégorie : à faire /
  en cours / terminé), type, priorité, date de mise à jour. **La recherche couvre aussi l'epic** —
  « montre-moi les tickets de tel epic » est une demande courante. Dans la liste l'epic reste une
  **information** — toute la carte sélectionne le ticket ; c'est **dans le détail** qu'il devient un
  **lien** vers Jira, ouvert dans un nouvel onglet. L'epic est lu dans le champ `parent` de Jira, en ne retenant que les parents qui en sont réellement un :
  celui d'une sous-tâche est une story, l'annoncer comme epic serait un contresens.
  Par défaut on écarte les tickets **terminés** — une case **« Inclure les terminés »** les réintègre. Un
  **filtre par statut** (repliable, cases à cocher, **choix persisté**) permet en plus de n'afficher que les
  statuts voulus. Il s'adapte aux **statuts personnalisés** de tes workflows, et la
  couleur suit la *catégorie* du statut (à faire / en cours / terminé) et non son nom. La liste ne se
  limite pas aux tickets affichés : les statuts du **workflow des projets concernés** sont chargés en
  plus, sinon un statut réel mais absent de la page ne serait pas filtrable. On interroge les projets
  sélectionnés, à défaut ceux des tickets affichés — demander tous les statuts de l'instance donnerait
  des dizaines d'entrées sans rapport, et l'endpoint qui le permettrait exige d'administrer Jira. Les statuts décochés sont exclus **par Jira**, pas après coup — sinon on trierait un extrait
  plafonné. Un statut déjà vu reste proposé même une fois exclu, sans quoi on ne pourrait plus le recocher. Un filtre **Sprints** apparaît dès que
  tes tickets en portent un. Le sprint est un champ **personnalisé**, dont l'identifiant change d'une
  instance à l'autre : l'outil le repère par son **marqueur de schéma** Jira, indépendant de la langue —
  un champ nommé « Itération » est reconnu comme tel. La sélection est appliquée **par Jira**
  (`sprint IN (…)`), comme les projets, pour ne pas trier un extrait plafonné. Les sprints déjà vus
  restent proposés même une fois un sprint choisi, sinon on ne pourrait pas en cocher un second.
  Le **sprint en cours est en tête de liste** et signalé comme tel — c'est celui qu'on cherche neuf fois
  sur dix, et la date seule ne le distingue pas d'un sprint futur. Viennent ensuite les autres par **date
  décroissante** ; un sprint sans date connue (Jira n'en donne pas toujours pour un sprint futur) passe
  après ceux qui en ont une.
  Les filtres **Assignés** et **Statuts** ont chacun leur **recherche** — qui **masque** les lignes
  sans rien décocher — et **Tout cocher / Tout décocher** —
  pratique pour vider puis ne garder qu'une ou deux lignes. Sur les assignés, **ne cocher personne ne
  filtre pas** : la liste prend alors **tous** les tickets visibles par le compte, y compris ceux
  affectés à quelqu'un d'autre ou à personne. Par défaut, tant qu'on n'a rien touché, seuls **tes**
  tickets sont chargés.
- **Filtres par champ, génériques.** Les trois filtres — Assignés, Statuts et **Filtres** — sont des
  puces alignées **au-dessus du panneau de détail** ; celui qu'on ouvre flotte au-dessus de la page, si
  bien que ni la ligne ni la liste ne bougent, et un clic à l'extérieur referme. Le panneau **Filtres**
  permet de choisir d'abord
  **le champ** (epic, type, priorité, projet, assigné, rapporteur, étiquettes, composants, versions
  correctives) puis **une ou plusieurs valeurs**. Le critère **Projet** fait exception : il est appliqué
  **par Jira**, pas après coup. Jira plafonne une recherche à cent tickets triés par date de mise à jour ;
  filtrer côté navigateur ne filtrerait donc qu'un extrait, et les tickets du projet voulu pouvaient se
  trouver hors de cet extrait — ils disparaissaient au lieu d'apparaître. Quand la liste est plafonnée,
  le compteur le dit (« 100 affichés sur 340 »). Les valeurs proposées sont celles **réellement
  présentes** dans les tickets chargés, avec le nombre de tickets pour chacune — proposer une valeur qui
  ne ramène rien n'aide personne. Le choix du champ et chaque liste de valeurs ont leur **recherche** ;
  celle des valeurs **masque les lignes sans rien décocher**, pour ne jamais perdre une sélection en
  cachant. Plusieurs critères se combinent en **ET** entre les champs et en **OU** à l'intérieur d'un
  champ (« les bugs *et* les tâches, de cet epic-ci »). Un critère dont aucune valeur n'est cochée ne
  filtre rien : ajouter un champ ne vide donc jamais la liste. Les critères sont **persistés**.
- Le **détail** (à droite) affiche le **contenu** (description Jira convertie d'ADF en Markdown lisible),
  toutes les **métadonnées** (statut, type, priorité, assigné, rapporteur, projet, dates, échéance,
  étiquettes, composants, versions correctives), **tous les commentaires** (auteur, date, corps en
  Markdown) et les **pièces jointes** — **téléchargées à la demande** via un **proxy serveur** qui récupère
  le fichier avec le token (un lien direct échouerait, l'API Jira exigeant l'auth). Plus un lien **Ouvrir
  dans Jira**.
- **Les blocs de code restent des blocs de code.** Un ticket technique met souvent un gabarit dans un
  **tableau** Jira — une étiquette à gauche, du JSON à droite. Un tableau Markdown, lui, tient sur une
  ligne par cellule : le code s'y retrouvait aplati, indentations écrasées et incopiable. Ces tableaux
  sont donc **dépliés** — chaque ligne devient l'étiquette puis son bloc, les lignes séparées par un
  trait. On perd la grille, qui n'était qu'une mise en page ; on garde le contenu, qui est ce qu'on
  venait copier. Les tableaux de données ordinaires, eux, restent des tableaux — et rien n'y est
  promu en titre à tort : seule une ligne dont **toutes** les cellules sont des en-têtes en devient
  un. Un tableau sans en-tête garde donc sa première ligne, et un tableau clé/valeur (en-tête en
  première **colonne**) garde sa première paire, la clé en gras faute d'équivalent en Markdown.
- **`Faire coder l'IA` depuis le ticket.** Le bouton en tête du détail ouvre la **modale de session de
  codage déjà remplie** : le contenu du ticket (titre + description) est mis en tête du prompt, le message
  de commit et le **nom de branche** (`feature/PROJ-1421-…`) sont proposés d'après la clé et le résumé, et
  le numéro de ticket est renseigné. Il ne reste qu'à choisir le dépôt et à préciser ta demande sous le
  contexte — le curseur y est déjà placé. La session n'est **pas lancée automatiquement** : tu relis avant.
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

#### Surveillés
**Suivre un ticket sans qu'il te soit affecté** — le cas courant : un ticket tenu par quelqu'un d'autre
bloque le tien, et tu veux savoir **quand il bouge**, pas y penser trois fois par jour.

- On ajoute un ticket par sa **clé** (`PROJ-1421`) depuis ce sous-onglet, ou par le bouton **Surveiller**
  en tête du détail d'un ticket. La clé est validée avant tout appel : elle n'atteint jamais le JQL brute.
- **L'état courant est mémorisé à l'ajout.** Sans ça, la première vérification comparerait à du vide et
  annoncerait un changement qui n'a pas eu lieu.
- **Dire pourquoi tu le surveilles.** Un champ facultatif à côté de la clé — « bloque la migration de la
  facturation », « prévenir Sofia dès que c'est en revue ». Trois mois plus tard, une clé et un résumé ne
  rappellent plus la raison. Elle s'affiche sous le titre du ticket et se **corrige à tout moment** par le
  crayon de sa ligne : passer par retirer/ré-ajouter perdrait la date d'ajout et le dernier état connu, et
  provoquerait une fausse notification au passage suivant. La vider est un choix valable — on ne garde pas
  un rappel périmé. Le champ tient **plusieurs lignes** (une raison en fait rarement une) : Entrée y passe
  à la ligne, **Ctrl/Cmd + Entrée** enregistre, Échap referme sans rien changer.
- Un **timer serveur** revérifie tous les tickets surveillés à la cadence réglée dans
  **Réglages → Jira** (*Vérifier les tickets surveillés toutes les* N minutes ; **0 = désactivé**). À chaque
  **changement d'état**, une **notification bureau** donne l'ancien et le nouvel état — `À faire → En cours` —
  et un clic ramène ici. Le type se coupe dans **Réglages → Notifications**.
- **Le ticket se lit ici.** Cliquer une ligne de la liste ouvre le ticket **à droite**, comme sous
  *Mes tickets* : description, métadonnées, commentaires, pièces jointes — et les mêmes actions
  (changer l'état, commenter, *Faire coder l'IA*). C'est le même panneau, pas une copie : surveiller un
  ticket sans pouvoir le lire obligeait à ouvrir Jira pour trois lignes de description. Les contrôles de
  la carte (retirer, corriger la raison) gardent leur effet propre, et chaque sous-onglet garde **sa**
  sélection.
- **`Vérifier maintenant`** déclenche le même code que le timer, tout de suite : ce que montre le bouton est
  donc exactement ce que fait la surveillance.
- Un ticket **supprimé ou devenu invisible** (droits perdus) est signalé **sur sa ligne**, sans interrompre
  la vérification des autres, et **sans effacer** le dernier état connu.

### Git
Opérations sur **plusieurs dépôts à la fois** et exploration des branches.

- **Actions** — `Créer une branche` · `Créer un tag` · `Supprimer des branches` · `Supprimer des tags`.
  On ne **saisit** un nom que pour créer ; pour supprimer, on **choisit dans la liste** des refs
  existantes — la branche par défaut et les refs protégées n'y figurent même pas. Le choix du dépôt
  se fait par un **champ avec recherche** (comme partout où l'on choisit un projet), utile quand la
  liste est longue — **et le choix de la ref aussi** : un dépôt actif compte des centaines de branches
  et de tags. Un choix unique passe par un sélecteur avec recherche ; un choix multiple (cases à cocher,
  tableau de l'explorateur) reçoit un filtre qui **masque des lignes sans décocher quoi que ce soit** —
  on coche, on filtre autre chose, on coche encore, puis on supprime d'un coup.
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
  à la fois** : chaque résultat va dans son bloc, **replié** et marqué d'un chevron qui pivote — les
  dépôts sont analysés **l'un après l'autre**, et chaque bloc dit où il en est (*en attente*, puis
  *analyse en cours* avec son indicateur, puis son nombre de branches). Un clone peut durer une
  minute : le bouton tourne pendant ce temps, et un dépôt en échec **ouvre son bloc** pour montrer
  la raison au lieu de la laisser enfermée. La **liste des tags** affiche la date, la (les)
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
  Arrêtés / non créés · **Arrêtés (exited)** · **Créés, jamais démarrés** · **Sans container** ·
  **Sortis en erreur** · Unhealthy · En restarting · En drift* — réduisent l'affichage **service par
  service**. « Ne tourne
  pas » recouvrait trois situations que Docker distingue et qui appellent des gestes différents : un
  container qui **a tourné puis s'est arrêté** veut un redémarrage, un container **créé mais jamais
  démarré** signale souvent un échec au lancement, et **aucun container** appelle un `up`. Le chapeau
  *Arrêtés / non créés* reste, pour ne pas casser les filtres déjà enregistrés. Un projet dont plus aucun service ne correspond **disparaît entièrement** (une carte vide
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
  - **Texte lisible, couleurs à la demande.** Une application en container colore sa sortie, `docker logs`
    relaie ces octets d'échappement tels quels, et un navigateur n'est pas un terminal : chaque ligne
    arrivait enfouie sous des `[34mdebug[39m`. Les lignes s'affichent **en texte brut par défaut** —
    c'est aussi le rendu le plus léger quand le flux part en rafale — et une case **« Afficher les
    couleurs »**, à côté de *Retour à la ligne*, restitue ce que l'application voulait dire. Le choix est
    mémorisé, cocher **rejoue ce qui est déjà à l'écran** sans relancer le flux, et les filtres
    continuent de porter sur le texte nu dans les deux cas. Les couleurs de **fond** sont volontairement
    ignorées : elles supposent un terminal dont on maîtrise le contraste, pas un thème clair et un thème
    sombre. Un caractère accentué tombant sur une frontière de paquet réseau n'est plus coupé en deux.
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
- **Badges de santé sur l'onglet Docker** : le **nombre de containers en erreur** — *restarting*,
  *dead*, et ceux **sortis en erreur** (code de sortie non nul) — en **rouge**. Un container arrêté
  **proprement** (code 0 : on l'a arrêté soi-même, ou un job a fini son travail) n'y entre pas : le
  compter en rouge faisait sonner l'alarme tous les jours, et une alarme qui sonne toujours n'est
  plus lue. Il reste nommé dans la bulle. Un code de sortie illisible reste hors alarme — on ne crie
  pas au loup sur une supposition et le **nombre d'unhealthy** en **orange**, directement dans le menu — visibles au démarrage et
  rafraîchis **automatiquement toutes les 30 s** (et à chaque ouverture de l'onglet) — donc un container qui
  bascule en *restarting* apparaît dans le titre du menu **même sans être sur l'onglet Docker**. Le poll est
  léger (un seul `docker ps -a`) et se met en pause quand l'onglet du navigateur est masqué.
- Si le **démon Docker n'est pas joignable** (Docker Desktop éteint, socket absent) ou si le **CLI n'est pas
  dans le PATH du serveur**, un message **actionnable** l'explique (indique `DOCKER_BIN` dans le `.env` au
  besoin) — comme les erreurs certificat / token.

### Jenkins
Voir **où en sont les jobs** et **les lancer**, sans quitter l'outil ni ouvrir une nouvelle
page. Ce n'est pas une console d'administration : il n'y a ni configuration de job, ni gestion
d'agents — ce que Jenkins fait très bien, et qu'on n'a pas à refaire.

- **Ce qui s'affiche.** Tous les jobs visibles par ton compte, à plat, **du dernier lancement
  au plus ancien** : dans une liste de trois cents jobs, ce qui vient de tourner est ce qu'on
  vient chercher — pas ce qui commence par « a ». Les **jamais lancés** ferment la marche.
- **Chaque ligne répond à quatre questions** : *quoi* (le **chemin** `boutique/api-deploy-prod`,
  car plusieurs projets ont un job « build », et le **numéro** du dernier build), *dans quel
  état* (**pastille de couleur** *et* le mot qui va avec — *Succès*, *Échec*, *Instable*,
  *Jamais lancé*, *Désactivé* —, une couleur seule ne se lisant pas de la même façon par tout
  le monde ; un job **en cours** a sa pastille qui bat), *quand* (la **date** du dernier
  lancement, l'ancienneté relative en infobulle), *par qui et sur quoi* (**l'auteur** du
  lancement — ou sa nature : *par le planificateur*, *sur un push*, *par un job amont* —, la
  **branche ou le tag** construits, et **tous les paramètres du dernier
  lancement** avec leurs valeurs, en **pastilles nom/valeur sur leur propre ligne** : mêlés au
  statut, à la date et à l'auteur — tous gris, tous séparés par des points médians — on lisait
  une phrase au lieu de couples. La question qu'on se pose en lisant la liste est justement
  « avec quoi est-il parti ? », et y répondre à moitié obligerait à ouvrir la fiche. Tout cela arrive dans **la même requête** que la liste :
  l'afficher ne coûte pas un appel de plus.

- **Les paramètres qui reviennent d'un job à l'autre portent une COULEUR.** À partir de **trois
  jobs**, un paramètre est considéré comme fréquent et reçoit une teinte : on retrouve `ENV`
  d'une ligne à l'autre du coin de l'œil, sans que la liste se raidisse en colonnes pleines de
  trous. La teinte vient du **nom**, pas de son rang : elle ne bouge donc pas quand un job
  apparaît ou disparaît. Elle **aide, elle ne remplace rien** — le nom reste écrit dans la
  pastille. Trois plutôt que deux : à deux, une coïncidence entre deux jobs colorerait pour tout
  le monde ; ce qui n'appartient qu'à un job reste neutre.
- **Et on filtre sur leurs valeurs.** Une liste déroulante par paramètre fréquent, au-dessus des
  jobs : « qu'est-ce qui est parti en prod ? », « qu'est-ce qui tourne sur la 2.4 ? ». Un job qui
  **n'a pas** le paramètre est écarté dès qu'on filtre dessus — il ne répond pas à la question
  posée. Les filtres sont calculés sur **tous** les jobs, pas sur ceux qui restent après
  filtrage : sinon un filtre disparaîtrait au moment où l'on s'en sert.
- **Un filtre qui ne sert pas se range.** Une croix au survol le sort de la barre — tous les
  paramètres fréquents ne servent pas à chercher —, et sa **valeur est effacée en même temps** :
  un filtre invisible qui continue de filtrer est le meilleur moyen de chercher dix minutes
  pourquoi la liste est vide. Les rangés se comptent à côté et se retrouvent dans la **même
  fenêtre que les dossiers masqués**, d'où un clic les remet.

  ⚠ Un paramètre de type **mot de passe** n'est jamais affiché — Jenkins en rend une forme
  chiffrée, illisible, et un secret n'a rien à faire dans une liste — pas plus qu'une valeur
  vide, qui n'apprend rien et pousse les autres hors de l'écran.
- **Les dossiers, en tête, servent de filtre.** Une case par dossier, avec son nombre de jobs,
  **`Tout cocher` / `Tout décocher`**, et une **recherche** pour retrouver un dossier parmi
  cinquante (elle masque des cases sans jamais en décocher : filtrer ce qu'on regarde ne doit
  pas changer ce qu'on a choisi de voir — et les deux boutons ne portent alors que sur ce qui
  est visible). Le choix est **mémorisé**. ⚠ Ce sont les dossiers **décochés** qui sont retenus :
  un dossier créé demain par l'équipe apparaît donc de lui-même. L'inverse l'aurait rendu
  invisible jusqu'à ce qu'on pense à aller le cocher.
- **Ranger un dossier qui ne te concerne pas.** Décocher dit « pas maintenant » ; la **croix**
  au survol d'une case dit « ce dossier n'est pas mon sujet » et le **sort de la liste des
  filtres**, qui redevient lisible — sur une installation à quarante dossiers, une rangée de
  cases qu'on ne coche jamais est du bruit qu'on relit chaque matin. Ses jobs partent avec lui
  (le masquer en les laissant donnerait des jobs qu'on ne peut plus filtrer). Les masqués
  restent **listés en petit sous les cases**, et un clic sur `+ nom` remet celui qu'on veut :
  un filtre dont on ne voit pas ce qu'il retire devient un mystère au bout de trois semaines.
  L'état coché du dossier est **conservé** pendant qu'il est masqué.
- **Retrouver un job.** Une **recherche** — obligatoire ici : une installation d'entreprise
  aligne des centaines de jobs. Elle porte sur le **chemin entier**, donc « boutique » retrouve
  tout un projet. Une case **`Seulement ce qui ne va pas`** ne garde que l'échec, l'instable et
  ce qui tourne.
- **Rafraîchi à la cadence que tu choisis, et seulement quand tu regardes.** *Réglages →
  Jenkins* porte le réglage — **toutes les N minutes, 0 = jamais**, une minute par défaut,
  plafonné à une heure. Il est en **base**, comme celui des MR et celui de Jira : c'est un
  réglage de l'outil, pas du navigateur, et il vaut d'où que tu regardes. Le sondage ne tourne
  que si l'onglet Jenkins est **ouvert** *et* la fenêtre **visible** : derrière un onglet masqué,
  il coûterait à un serveur partagé sans rien apprendre à personne. La case **`Ne pas rafraîchir
  tout seul`**, elle, est une **pause locale et immédiate** — elle l'emporte sans toucher au
  réglage de fond — et **`Rafraîchir`** redemande à la main. Un rafraîchissement
  de fond ne fait pas clignoter la liste, et un réseau qui hoquette n'efface pas l'écran : on
  garde le précédent. Le menu **ne porte pas de pastille** — elle supposerait d'interroger
  Jenkins à chaque ouverture de l'application, même sans être sur l'onglet.
- **Le menu porte un badge : combien de jobs ont tourné aujourd'hui.** La question qu'on se
  pose en passant devant l'onglet est « est-ce que ça a bougé ce matin ? ». Il est rempli une
  fois au démarrage, puis entretenu par le rafraîchissement de l'onglet — Jenkins n'est pas
  interrogé depuis les autres onglets. Rien aujourd'hui : pas de badge du tout, un zéro dans un
  menu n'apprend rien. Un job lancé cinq fois compte pour un — la liste ne porte que le dernier
  build de chacun, et la bulle dit donc « jobs », pas « lancements ».
- **Prévenu à la fin de ce que TU as lancé.** Une notification bureau quand un job que tu as
  lancé depuis Mergerie se termine, avec son verdict ; un clic ouvre sa fiche. Uniquement les
  tiens : être prévenu du build nocturne de l'équipe serait du bruit, et on couperait tout au
  bout de deux jours. Débrayable dans *Réglages → Notifications*. L'attente survit à la
  fermeture de l'onglet — c'est justement le cas d'usage.
- **La fiche d'un job** (`Ouvrir`), en **trois blocs séparés** — le formulaire de lancement,
  l'historique, le détail de l'exécution choisie. Chacun est une carte sur un fond en retrait :
  la frontière se **voit** au lieu de se deviner. L'historique est une vraie liste (des filets
  entre les lignes, la date sur son propre étage pour que les verdicts s'alignent), la ligne
  choisie porte un **liseré** et son numéro en gras — pas seulement un gris un peu différent —,
  et les filtres restent **en tête** pendant qu'on descend. Seul le corps défile : **`Lancer`**
  ne s'enfonce plus sous dix exécutions, et le détail de droite **suit la descente** — comparer
  « ce que je vais lancer » à « ce qui est parti la dernière fois » est la raison d'être de
  cette fenêtre. En deux colonnes : à **gauche** l'historique des dix
  dernières exécutions (verdict, date, durée) — chacune avec son bouton **`Console`**, le geste
  le plus fréquent, et **les paramètres avec lesquels elle est partie**, en pastilles sous la
  ligne. Deux lignes vertes du même après-midi ne se distinguent que par là. La **teinte vient
  du nom** du paramètre, la même que dans la liste des jobs : `ENV` garde sa couleur d'un écran
  à l'autre, et l'œil descend la colonne sans lire. Dans un historique, tous les paramètres
  reviennent à chaque ligne : ils sont donc tous teintés —, à **droite** le détail de celle qu'on sélectionne : quand, combien de
  temps, **par qui**, sur **quelle branche**, et surtout **avec quels paramètres et quelles
  valeurs** elle est partie. La plus récente est sélectionnée d'office. La **console** s'ouvre
  d'un bouton — bornée aux derniers caractères, **déroulée en bas** là où est l'erreur, et
  **repliée à la ligne** : défiler de côté pour lire une erreur qu'on cherchait reviendrait à ne
  pas l'afficher.
- **Retrouver l'exécution qu'on a en tête, et repartir de ses valeurs.** « Quand est-ce parti
  en prod pour la dernière fois, et avec quelle version ? » — au-dessus de l'historique, un
  filtre par paramètre rencontré, et sur chaque exécution retenue un bouton **`Reprendre`** qui
  **remplit le formulaire de lancement** avec ses valeurs, **sans rien envoyer** : si l'on
  repart d'un ancien lancement, c'est presque toujours pour en changer une.
  - Les filtres **suggèrent** les valeurs qu'ils ont vues, ils n'y **enferment pas** : ce qui est
    à l'écran n'est que ce qui a été chargé, et une valeur absente de la liste reste parfaitement
    valable — elle se **tape à la main**. Idem pour les filtres au-dessus de la liste des jobs.
  - Et le filtrage **ne s'arrête pas aux dix dernières** : au premier filtre posé, l'historique
    du job est **rechargé plus profond, une seule fois**, pour retrouver un lancement d'il y a six
    semaines plutôt que de répondre « aucune exécution » à propos de quelque chose qui a bien eu
    lieu. Le compte affiché (`— 2 sur 200`) dit sur quoi la recherche a porté.
  - Une valeur **qui n'existe plus** dans les choix du job est **rajoutée et signalée** plutôt
    qu'ignorée : un champ resté sur autre chose sans le dire ferait lancer avec une valeur que
    personne n'a choisie.
- **Un lien vers Jenkins** sur chaque ligne (et sur chaque exécution de la fiche) ouvre le job
  dans un **nouvel onglet** : ce que Mergerie ne montre pas — la configuration, les artefacts,
  les tests — reste à un clic.
- **Lancer.** ⚠ Toujours **avec confirmation**, et la question **nomme le job** : c'est ce qui
  permet de s'apercevoir qu'on s'est trompé de ligne. Un job Jenkins n'est pas une page qu'on
  ouvre — il déploie, il publie, il tourne sur une machine partagée, et on ne peut pas
  l'annuler depuis ici.
- **Les listes que Jenkins CALCULE sont récupérées là où elles existent.** *Git Parameter*
  (la liste des branches et tags du dépôt), *Extended Choice*, *Active Choices* : ces plugins ne
  déclarent pas leurs valeurs, ils les calculent au moment de rendre leur page — l'API n'en
  porte donc aucune trace. Mergerie lit alors le **formulaire de lancement** de Jenkins, celui
  qu'on voit en cliquant *Build with Parameters*, et **uniquement pour les paramètres dont
  l'API n'a rien dit** (ce qu'elle déclare fait foi). Un **choix multiple** reste multiple, et
  les valeurs partent séparées par des virgules — la forme qu'attendent ces plugins.
- ⚠ **Si la page ne répond pas non plus**, le champ est laissé **vide** et le dit, avec le lien
  pour aller lancer depuis Jenkins. C'est le cas quand le plugin échoue jusque dans sa page et
  rend sa phrase d'erreur (« Could not get Environment from ENV Param ») : pré-remplir le champ
  de cette phrase l'aurait fait partir telle quelle comme valeur.

- **Un job paramétré ne se lance jamais depuis la liste.** Son bouton s'écrit **`Lancer…`** —
  les points de suspension annoncent un formulaire, et l'infobulle dit combien de paramètres il
  attend. Il ouvre la **fiche** du job : la section **`Paramètres`** s'y remplit (un booléen se
  coche, un choix se choisit, le reste se tape), puis c'est le **`Lancer`** du bas de la fiche
  qui envoie, avec la confirmation habituelle. **Les valeurs proposées sont celles du job** :
  ce sont elles qui partiront si tu n'y touches pas. Partir sur des valeurs par défaut qu'on
  n'a pas vues, c'est déployer la mauvaise version dans le mauvais environnement.
- **`Relancer` : le même job, les mêmes valeurs.** Le geste le plus fréquent après un échec.
  Dans la **liste**, il repart avec les paramètres du **dernier lancement** ; dans la **fiche**,
  chaque exécution de l'historique a le sien et repart avec **ses** valeurs à elle — c'est ce
  qu'on veut après avoir lu la console d'un build raté. La confirmation **montre les valeurs**
  qui vont partir : « relancer » ne dit rien si on ne voit pas avec quoi. Un job sans paramètre
  n'a pas ce bouton : ce serait `Lancer`.
- ⚠ **Un paramètre secret ne peut pas être renvoyé.** Jenkins ne rend jamais sa valeur (et
  Mergerie ne l'affiche pas) : à la relance, Jenkins reprendra sa valeur par défaut. La
  confirmation le dit et les compte, plutôt que de laisser repartir un job amputé de son mot de
  passe sans que personne ne s'en aperçoive.
- **Un job désactivé n'a pas de bouton `Lancer`** : proposer ce que Jenkins refusera est une
  promesse qu'on ne tient pas.

**Connexion** — *Réglages → Jenkins* : l'URL racine, ton **utilisateur** et un **jeton d'API**
(ton profil Jenkins → *Configure* → *API Token*). Jenkins authentifie le **couple** : le jeton
seul ne suffit pas. **`Tester Jenkins`** rend le **nom du compte** vu par le serveur — une URL
qui répond ne prouve pas que le jeton est bon. Le jeton est stocké en local et **masqué** ;
réenregistrer les réglages sans y toucher ne l'efface pas.

### Liens
Les liens de travail ont une **structure** que les marque-pages d'un navigateur ne savent pas
représenter : le même service existe en local, en dev, en preprod, en prod. Un arbre de dossiers
l'éclate en quatre endroits ; une **grille** le montre d'un coup — services en lignes,
environnements en colonnes.

Deux formes, parce qu'il y a deux réalités. Ce qui n'a pas de dimension environnement (Confluence,
une doc, un outil) reste un **lien libre**, à plat, retrouvé par ses tags.

#### La barre du haut
**Un champ de recherche**, et il couvre **les deux moitiés de l'écran** — la grille et les liens
libres. Il porte sur le nom du service, ses tags, son dépôt, **le nom de chaque adresse** et les URLs
elles-mêmes : chercher `erreurs paiement` trouve la case qui la contient. Sous une recherche, une case **ne montre que
ce qui correspond** — afficher ses huit adresses pour une seule trouvée obligerait à relire la case
au lieu de lire la réponse. Une requête peut mélanger les deux niveaux : `logs apache` prend `logs`
sur la ligne et `apache` sur l'adresse, et seules les adresses apache s'affichent ; `logs` seul, à
l'inverse, laisse passer toute la ligne — c'est elle qu'on a demandée. Chercher `kibana` ou un morceau d'URL suffit ; on n'a pas à décider dans quelle moitié
regarder avant de savoir où est la réponse. Quand la grille ne rend rien mais que les liens libres
si, le message le dit et renvoie plus bas, au lieu d'annoncer « rien ne correspond » au-dessus de
résultats bien présents.

Sous la barre, **les filtres, étiquetés et toujours à l'écran** — ils servent tous les jours :

- **Environnements**, en pastilles colorées : elles masquent des **colonnes**. Depuis « tout
  affiché », un clic veut dire *celle-là* — on part travailler sur un environnement ; ensuite les
  clics ajoutent et retirent. Retirer la dernière ramène à tout, une grille sans colonne ne
  montrant rien. Un service sans aucune adresse dans les colonnes retenues **sort de la liste** :
  filtrer sur la prod pour voir dix lignes vides ne montre pas la prod, ça montre ce qu'elle n'a pas.
- **Services**, en pastilles eux aussi : ouvrir un menu pour voir sur quoi on filtre est un clic de
  trop sur un geste quotidien. Au-delà d'une douzaine, un champ apparaît pour les **tamiser** — il
  masque des pastilles sans jamais en décocher, et le compte des sélectionnés hors de vue le
  rappelle.
- **Tags**, chacun avec **son compte** : une rangée sans chiffres ne dit pas où est la matière.

Les trois **survivent au rechargement**, et `Tout afficher` les relâche d'un clic.

À côté : **`+ Ajouter`** (un lien simple, un service, un environnement) et un menu **`⋯`** pour
l'import de marque-pages. Ces gestes se font une fois dans la vie de l'outil ; retrouver un lien se
fait tous les jours, et c'est ce qui occupe la place.

#### La grille
- **Lignes = services**, épinglés en tête puis par ordre alphabétique. Chaque ligne porte le nom,
  ses **tags**, et le **dépôt Mergerie associé** quand il y en a un. `Épingler en tête de grille`
  est une case de la fiche du service : c'est ainsi qu'on remonte ce qu'on ouvre tous les jours.
- **Colonnes = environnements**, dans l'ordre que tu leur donnes, chacun avec sa **couleur**
  d'en-tête (la prod en rouge invite à réfléchir avant de cliquer). **Le nom de la colonne ouvre
  son réglage** — renommer, changer la couleur, supprimer ; et au survol, deux flèches la
  **déplacent** d'un cran. La suppression annonce **combien d'adresses partent avec elle**.
- **Une case = une ou plusieurs adresses, écrites.** On aurait pu deviner l'adresse de preprod
  depuis celle de dev en remplaçant un morceau de domaine ; c'est exactement la magie qui envoie un
  jour sur le mauvais environnement sans prévenir. Une case vide affiche un `+`, une case remplie un
  **crayon** au survol : on saisit **dans la case**, Entrée enregistre, Échap annule, et **tout
  vider efface la case** — pas de modale pour coller une adresse.
- **Plusieurs adresses au même endroit**, parce que c'est le cas réel : un Kibana de production,
  ce sont autant d'adresses que de filtres enregistrés. Chacune porte un **nom** (« erreurs
  paiement », « latence API »), sans quoi la seconde serait indiscernable de la première. **Combien la case en
  montre se juge sur la LIGNE** : tant que sa case la plus fournie reste sous cinq adresses, tout
  s'affiche — la hauteur reste raisonnable et rien n'est caché. Au-delà, la case en montre deux et
  un `+N` déplie sur place ; **son info-bulle nomme ce qu'il cache**, pour ne pas avoir à déplier
  juste pour savoir si ça valait la peine. Et `Tout déplier`, dans la barre de filtres, ouvre toutes
  les cases d'un coup — le choix est **retenu**. Le crayon ouvre **une ligne par adresse**, et la case s'étire le
  temps de la saisie. La **palette** trouve chacune par son nom, et la frécence se compte par
  adresse : on ouvre toujours les deux mêmes sur les dix.
- **Filtre par tag** au-dessus de la grille : un service appartient souvent à deux familles à la
  fois (*backend* et *paiement*), ce qu'un arbre de dossiers l'obligerait à trancher.
- Seules les adresses **`http` ou `https`** sont acceptées, ici comme partout dans cet onglet : ces
  liens s'ouvrent d'un clic depuis l'application.

**Créer un service, c'est aussi poser ses adresses.** La fiche liste **une ligne par
environnement**, toutes facultatives. Enregistrer rendait auparavant une ligne vide qu'il fallait
retrouver dans la grille pour la remplir case par case ; le service naît maintenant utilisable, et
l'écran **descend jusqu'à sa ligne** en la soulignant une seconde — une grille alphabétique le fait
atterrir n'importe où.

#### Liens libres
Une liste sous la grille : libellé, URL, tags, **dossier**. Ajout et édition au clic, et la recherche
du haut les filtre avec le reste. C'est là qu'atterrit l'import de marque-pages.

Le champ **Dossier** propose les dossiers existants **et accepte les nouveaux** — choisir dans une
liste interdirait d'en créer un, un champ nu obligerait à retaper un chemin qu'on a déjà. Une barre
oblique crée le sous-dossier au passage (`doc/astreinte/2026`), et les niveaux intermédiaires sont
proposés même si aucun lien n'y est posé directement. Laisser vide range le lien à la racine.

Au-delà d'une douzaine, elle se **groupe par dossier**, en reprenant **l'arbre tel qu'il était dans
le navigateur** — chemin complet, profondeur comprise — avec le compte de chacun. Regrouper sur le
seul dernier segment faisait fusionner `seres/prod` et `logs/prod` dans un même « prod » : l'outil
détruisait une structure que le navigateur, lui, préserve. **Le premier niveau est ouvert, les suivants non** : tout
déplier à cinq niveaux redonne la liste plate qu'on cherchait à quitter, tout replier oblige à
ouvrir dix dossiers pour retrouver un lien. `Tout déplier` et `Tout replier` disent explicitement
l'un ou l'autre ; recliquer sur celui qui est actif revient au premier niveau, et le choix est
retenu. Chaque dossier qui en contient d'autres porte **son propre bouton** de pliage, pour ouvrir
ou fermer sa branche sans toucher au reste — un coup d'œil, pas une préférence : celui-là ne se
retient pas. Sous une recherche ou un tag, on
revient à plat : le filtre EST le rangement, et deux niveaux de tri à la fois cachent ce qu'on vient
de demander.

**Tout effacer.** Le menu `⋯` porte `Supprimer tous les liens libres` — la sortie de secours d'un
import raté : on en déverse deux cents, on constate que ce n'était pas ce qu'on voulait, et les
reprendre un par un serait deux cents confirmations. La demande de confirmation **annonce le
nombre** (« supprimer tous les liens ? » ne dit pas s'il y en a trois ou deux cents) et rappelle que
**la grille n'est pas touchée**. Le bouton n'apparaît pas quand il n'y a rien à supprimer.

**Les ranger dans un service.** C'est le geste d'après l'import : deux cents adresses arrivent à
plat, et il faut les classer. Chaque ligne porte un bouton `Ranger` ; pour en traiter plusieurs d'un
coup, `Sélectionner` fait apparaître les cases à cocher — elles ne sont pas là en permanence,
l'opération est rare et le bruit quotidien se paie cher. `Tout sélectionner` coche alors **ce que
le filtre a laissé** : on tamise (« confluence »), on coche tout, on range, et on recommence. Un lien
coché puis filtré hors de vue **sort de la sélection** — sinon il partirait avec les autres sans que
rien ne l'ait annoncé.

Dans les deux cas, la même fenêtre :

- **Un service existant ou un nouveau**, au choix, dans un sélecteur à recherche. Ne savoir que
  créer obligeait à tout ranger du premier coup ; on range aujourd'hui trois liens, demain deux
  autres, dans le même service.
- **Un environnement**, avec un `Tout ranger dans` qui pose le même pour toutes les lignes — le
  refaire ligne à ligne sur douze liens est exactement ce qui fait renoncer. Le mapping reste
  **explicite** : deviner « dev » depuis une URL contenant `-dev` marcherait neuf fois sur dix, et
  la dixième poserait une adresse de production dans la colonne de développement.
- **Le libellé du lien devient le nom de l'adresse.** « erreurs paiement » rangé dans Kibana × prod
  garde son nom — c'est exactement ce qui distingue une adresse d'une autre au même endroit, et
  c'était déjà écrit.

Les adresses **s'ajoutent** à la case, elles ne la remplacent pas ; deux liens rangés au même
endroit y tiennent tous les deux. Le lien libre disparaît alors : le garder ferait deux entrées pour
la même adresse.

#### La palette — `Ctrl`/`Cmd` + `K`, ou la touche `o`
Le champ de recherche de l'en-tête ouvre la **palette globale**, qui cherche **partout à la fois** :
les cases de la grille (« kibana preprod »), les liens libres, les merge requests (par numéro ou par
mots du titre), les tickets surveillés, les pages de notes, les todos ouvertes, et les actions de
navigation. Entrée ouvre — un lien externe dans un nouvel onglet, un objet interne à sa place.

- **Recherche floue**, insensible aux accents et à la casse — `generation` trouve « Génération du
  rapport », et inversement. On abrège **par mots** : `kib pre` trouve « Kibana · preprod », chaque
  mot tapé devant se retrouver *entier* quelque part dans la cible. Sauter une lettre au milieu
  d'un mot (`kbana`) ne trouve rien, et c'est voulu : accepter les mots à trous jusque dans la base
  ferait passer plus de la moitié des lignes devant le classement, qui n'aurait alors plus les
  moyens de trier. Le classement, lui, favorise ce qui **commence** un mot — `api` remonte
  « api-core » avant « rapidité », qui contient pourtant les mêmes lettres.
- **Classement par frécence** : ce qu'on ouvre *souvent* **et** *récemment* remonte. Un simple
  compteur ferait remonter à vie ce qu'on a beaucoup ouvert le mois dernier ; une simple date
  perdrait ce qu'on ouvre chaque jour depuis un an.
- La palette interroge le **serveur** : elle voit donc tout, y compris ce que l'onglet courant n'a
  pas chargé — chercher une merge request depuis Docker fonctionne. Le tri se fait **en base**, pas
  sur un extrait : une merge request vieille de trois cents autres se trouve aussi bien qu'une
  fraîche. Seule la *réponse* est bornée — à douze lignes, ce qu'un menu déroulant peut montrer.

#### Liens contextuels sur les merge requests
Quand un service est associé à un dépôt, le **détail des merge requests de ce dépôt** porte une
rangée de boutons : les URLs de grille du service (« Ouvrir · dev »), puis ses **liens contextuels**.

Un lien contextuel est un **gabarit** à variables, résolu au moment du clic :

| variable | vaut |
|---|---|
| `{env}` | l'environnement (un bouton par environnement ayant une URL) |
| `{branch}` | la branche source de la merge request |
| `{mr_iid}` | le numéro de la merge request |
| `{service}` | le nom du service |

Exemple : `https://kibana-{env}.corp/app/logs?q={service}%20{branch}` ouvre les logs de *cette*
branche, sur l'environnement voulu, sans rien retaper.

- **Une variable inconnue est refusée à la saisie**, et le message dit lesquelles existent : une
  faute de frappe doit se voir en l'écrivant, pas produire une URL cassée trois semaines plus tard.
- **Chaque valeur substituée est URL-encodée** : une branche `feat/x?y=1` ne fabrique pas une URL
  surprise avec un paramètre en plus.
- Une variable **sans valeur dans ce contexte** laisse le bouton visible mais **grisé**, avec sa
  raison au survol. Le faire disparaître laisserait croire qu'il n'existe pas ; une URL à trous
  mènerait sur une page d'erreur.
- Un gabarit **sans `{env}`** donne **un seul** bouton : il ne dépend pas de l'environnement, en
  proposer un par colonne rendrait N fois la même adresse.

#### Importer les marque-pages de Chrome
*Chrome → Favoris → Gestionnaire de favoris → ⋮ → Exporter les favoris*, puis
`Importer depuis Chrome`.

**L'import lit ton arbre.** Un dossier dont plusieurs enfants portent des noms d'environnement
(`dev`, `recette`, `tmc`, `pprod`, `prod`…) ne décrit pas un rangement : il décrit une **grille**.
L'aperçu la construit et te la montre **avant de créer quoi que ce soit** — un tableau avec le
nombre d'adresses par case. Tu la refuses d'une case à décocher, et tout revient en liens libres.

Deux gestes y sont possibles, parce que la détection lit des noms de dossiers et ne peut pas tout
savoir : **renommer une ligne** sur place (le nom d'un dossier n'est pas toujours celui qu'on
donnerait au service), et **réunir plusieurs lignes en un seul service** — on coche, on clique
`Réunir en un service`, et leurs cases se rejoignent environnement par environnement, chaque adresse
gardant son nom.

Deux formes, distinguées par une mesure : *les libellés se répètent-ils d'un environnement à
l'autre ?*

- **Ils se répètent** — `bo`, `bp`, `po`, `api` dans chacun de tes cinq environnements : c'est la
  même chose vue à cinq endroits, donc **une ligne par libellé**.
- **Ils ne se répètent pas** — un Kibana et ses requêtes enregistrées, propres à chaque
  environnement : **une ligne pour le dossier**, et les libellés deviennent les noms des adresses.

Trois détails qui évitent des grilles absurdes : deux orthographes d'un même environnement
(`pprod` et `preprod`) donnent **une seule colonne** ; un environnement numéroté (`recette2`) reste
distinct ; et un sous-dossier **sous** l'environnement devient sa propre ligne (`logs/prod/keycloak`
→ un service `logs · keycloak`), sans quoi une case porterait vingt-quatre adresses. Les colonnes
sont rangées dans l'ordre de la chaîne de déploiement, pas dans celui du fichier.

Rien n'est deviné du métier : le seul indice cherché est un **nom d'environnement**, sur une liste
large en français et en anglais. Un dossier voisin qui n'en est pas un (`seres/keycloak`) est laissé
de côté et ses liens restent libres.

**Le reste de l'aperçu est replié par dossier, et rien n'est coché.** Un dossier par ligne, avec son compte et
sa case ; on déplie celui qu'on veut, on coche, on importe douze liens au lieu de deux cents.
Choisir ce qui entre coûte dix secondes, trier ce qui est entré coûte une demi-heure. Les **dossiers racines des navigateurs**
(« Barre de favoris », « Autres favoris », « Bookmarks bar »…) **ne deviennent pas des tags** :
présents sur la totalité des liens, ils ne filtraient rien et occupaient la première place devant
ceux qui disent quelque chose. C'est une liste de noms connus, et non « le premier dossier venu » —
un export peut très bien commencer par un vrai dossier, et le perdre effacerait la seule information
de rangement qu'on avait.

- **Aperçu d'abord** : l'arbre des dossiers tel qu'il était dans le navigateur, chaque lien
  cochable. Rien n'est créé tant qu'on n'a pas validé — même esprit que l'aperçu obligatoire des
  opérations git.
- Tout ce qui est coché arrive en **liens libres**, **tagué par son chemin de dossier**
  (`Travail/Kibana` → `travail`, `kibana`).
- **Rejouable** : réimporter le même fichier après y avoir ajouté trois favoris ne double pas les
  cent autres — une URL déjà connue est ignorée, et le compte des ignorés est annoncé (un silence
  passerait pour un échec).
- Le fichier n'est **jamais exécuté ni rendu** : il est analysé, et seules les adresses `http(s)` en
  sortent — un favori `javascript:` est ignoré. Taille bornée à 5 Mo.
- La conversion en services vient **après**, à la main (voir plus haut).

### Stats
Funnel des MR, distribution des notes, **évolution de la note moyenne par semaine** (« la qualité
progresse-t-elle ? »), activité hebdomadaire, tableau par projet (avec **taux de résolution**,
**tendance** ▲/▼ et le **dernier commit** — date, auteur, lien vers le commit sur sa forge), un **Top 5 des
dépôts à l'activité la plus récente** (dernier commit avec **date ET heure** — plusieurs dépôts poussent
le même jour, et sans l'heure le classement paraît arbitraire —, auteur, lien ; les dépôts dont la
récupération des MR est décochée en sont exclus, comme les dépôts inactifs : on ne les suit plus), **coût en tokens** (camembert par
type d'appel + **coût moyen par MR reviewée**), résumé des sessions. L'activité de commits est récupérée
**en direct depuis la forge de chaque dépôt, toutes branches confondues** (chargée à part, best-effort : rien ne casse si une forge est injoignable).
**Activité des projets — 6 derniers mois.** Répond à « quels dépôts vivent, lesquels dorment ». **Une barre
horizontale par dépôt suivi** (actif ET récupération des MR cochée), rangées de la plus longue à la plus
courte, **nom en clair à gauche** et total à droite. Le graphe a une **hauteur fixe et défile** : vingt
dépôts s'y lisent sans repousser le reste de la page, et sans qu'aucun nom soit tronqué — en colonnes,
chacun n'avait que 65 px et tous finissaient coupés.

La longueur, ce sont les **jours d'activité** — les journées où au moins un commit est arrivé — et non le
nombre de commits. Une journée travaillée veut dire la même chose partout, alors qu'un nombre de commits
mesure surtout le *style* : squasher ou non change le compte du simple au quarantuple pour le même travail,
et un dépôt gonflé écraserait tous les autres. La mesure est aussi **bornée** (une vingtaine de jours ouvrés
par mois), donc franchement comparable d'un dépôt à l'autre. Les commits restent au survol.

- La barre est **empilée par mois**, **une couleur par mois**, du plus ancien à gauche au plus récent à
  droite — le temps se lit dans le sens de lecture, et la légende sous le graphe donne la correspondance.
  Les teintes suivent une séquence froid → chaud plutôt qu'un arc-en-ciel : les mois se suivent, l'ordre
  doit rester lisible même sans regarder la légende. La longueur donne le volume, la répartition dit si
  l'activité est **récente ou ancienne** — deux cents commits
  concentrés il y a cinq mois ne décrivent pas le même projet que deux cents commits réguliers.
- Le **mois en cours** n'est pas fini : il est marqué d'un astérisque dans la légende, pour qu'on ne lise
  pas une baisse là où il n'y a qu'un mois entamé.
- Un dépôt sans aucun commit sur les **deux derniers mois** voit sa barre **désaturée** et son nom passer
  en italique gris — désaturée plutôt qu'écrasée en gris uni, pour qu'on puisse encore lire *quand* il
  s'est arrêté, ce qui est souvent la question qu'on se pose devant lui. Il
  reste dans la liste — c'est justement ce qu'on vient voir —, mais ne se confond pas avec un projet
  simplement peu actif. Un seul mois creux arrive à tout le monde, deux dessinent une pente.
- Le **survol d'une barre** donne le détail : jours d'activité et commits mois par mois, contributeurs
  distincts du mois le plus fourni, et la raison quand le dépôt est injoignable.
- **Cliquer une barre** — toute la colonne, libellé compris — ouvre le projet sur **12 mois** : six mois disent *qui* bouge, douze
  disent *dans quel sens*. Un dépôt calme depuis deux mois après dix mois soutenus ne raconte pas la même
  histoire qu'un dépôt éteint depuis un an, et la vue d'ensemble ne peut pas les distinguer. La fenêtre
  donne le total de jours, de commits et de contributeurs, le **mois le plus actif** et la **dernière
  activité** — deux repères qu'on cherche sinon à l'œil sur le graphe.

Ce qui est **écarté du compte** : les commits de robots (Dependabot, Renovate, GitHub Actions, Mergify).
Sans ce filtre, un dépôt abandonné mais mis à jour chaque semaine par un robot garderait quelques jours
d'activité par mois et ne serait jamais signalé endormi — le faux positif exact que ce graphe doit éviter.
Un humain qui commite depuis l'interface web d'une forge, lui, compte normalement.

Les dépôts sont interrogés **quatre à la fois** : en série, vingt dépôts additionnent leurs allers-retours
réseau et le premier chargement se compte en dizaines de secondes ; tous d'un coup, la forge répond par un
refus. Deux vues qui demandent le même dépôt au même moment (la vue d'ensemble et la fenêtre de détail)
partagent le même travail au lieu de le payer deux fois.

Les comptes sont **mis en cache par mois** : un mois clos ne change plus, seul le mois courant est
rafraîchi (au plus une fois par demi-heure). Sans ça, six mois d'historique se repagineraient depuis la
forge à chaque ouverture de l'onglet. Côté GitLab le compte porte sur **toutes les branches** ; côté GitHub
sur la **branche par défaut** seulement — les lister toutes y coûterait des dizaines d'appels par dépôt, et
l'écran le dit plutôt que de laisser croire à un compte complet. Un dépôt injoignable garde sa barre, avec
la raison au survol.

Chaque graphe affiche **la question à laquelle il répond**. Le total de tokens est un **minorant** (le
travail interne de l'agent n'est pas compté).

### Réglages
Sous-onglets, **dans l'ordre du parcours** — connecter, choisir le code, régler la review, régler
l'outil, les intégrations optionnelles, le banc d'essai :

**Git** (**connexion GitLab** — URL + access token, avec *Tester la connexion* —, **connexion GitHub** — URL
(vide = github.com, sinon GitHub Enterprise) + token, avec *Tester GitHub* —, **dossier de clonage**,
et la **palette de commandes git** de l'onglet *Git → Commandes Git* : ajout/édition/suppression de
commandes *nom + commande figée*). C'est le **premier** onglet, et celui qui s'ouvre d'office la
première fois : sans jeton, aucun autre réglage ne sert à rien ·
**Dépôts** (ajout un par un ou en masse **depuis GitLab** ou **depuis GitHub** — chaque dépôt porte un badge
de forge, et un même chemin peut exister sur les deux —, plus les **répertoires locaux** — un dossier de ta machine contenant un sous-dossier par projet git, qui alimente l'onglet *Git → Navigation* et le *Codage hors dépôt* ; le décompte affiché « n projets git sur m dossiers » confirme d'un coup d'œil qu'on a désigné le bon niveau d'arborescence) ·
**Merge Request** (rafraîchissement auto, convergence, templates de prompt — le **skill** de review s'écrit dans le gabarit) ·
**Règles de review spécifiques** (critères ajoutés au prompt quand le nom de
branche contient un fragment donné **ou quand le diff touche un chemin** — glob type `**/migrations/**`,
`*.sql` —, plus précis ; une règle par chemin peut porter un **badge « risque »** affiché sur les MR
concernées, calculé **sans IA** juste sur les chemins du diff, pour voir d'un coup d'œil laquelle reviewer en premier) ·
**Vérificateurs** (tes scripts de tests, et les dépôts que chacun sait tester — voir *Vérification
objective* plus bas ; la page montre d'abord **la liste**, et le formulaire s'ouvre sur *Ajouter un
vérificateur*, *Modifier* ou **`Dupliquer`** — celui-ci le rouvre **pré-rempli** sans identifiant,
donc enregistrer **crée** au lieu d'écraser l'original, avec un nom libre proposé (« X (copie) »,
les noms étant uniques) et le champ sélectionné : renommer est le premier geste) ·
**Notifications** (sous-onglet dédié, voir ci-dessous) ·
**Général** (thème clair/sombre/auto, langue, densité, brief du matin, conservation des données, sauvegarde, et une **zone dangereuse** pour la remise à zéro) ·
**Jira** (**connexion Jira** — URL + email + jeton d'API, avec un bouton *Tester Jira* — ; alimente l'onglet
*Jira* et l'enrichissement d'une session depuis un ticket) ·
**Jenkins** (URL, utilisateur et jeton d'API, avec un bouton de test, et la **fréquence de
rafraîchissement** des jobs) ·
**AI sessions** (les **consignes permanentes**, voir ci-dessous, et un test technique : deux passes
dans la même session d'agent — mémorise un marqueur
puis le rappelle en reprise — pour vérifier que la **reprise de session** fonctionne avec ton CLI ;
c'est le socle de la continuité de contexte entre review, corrections et convergence).

Les trois premiers sont ce qu'on remplit pour démarrer ; **Règles** et **Vérificateurs** complètent
la review ; le reste se règle quand le besoin s'en fait sentir. Le **dernier sous-onglet consulté est
mémorisé** — on revient dans Réglages pour finir ce qu'on y faisait.

#### Consignes permanentes
*Réglages → AI sessions.* Un texte libre **ajouté à la fin du prompt de toutes les sessions de codage**
— dépôt **et** hors dépôt, au premier lancement **comme à chaque suivi**. C'est ce qu'on redit à
chaque fois : la langue des commentaires, une commande à lancer avant de committer, une
interdiction. Les recopier dans chaque prompt marche jusqu'au jour où on oublie — et c'est toujours
celui-là qu'on relit trois heures plus tard.

Elles arrivent **après la tâche** (ce qu'on demande d'abord, comment le faire ensuite) et **avant**
le bloc de questions, qui reste le dernier mot. Elles sont **relues à chaque prompt** : une consigne
ajoutée maintenant vaut pour la session lancée juste après, sans redémarrer l'outil. Le champ
**vide n'ajoute rien** — pas même un titre de section orphelin. ⚠ Elles ne s'appliquent **pas** à
l'exploration, qui ne produit pas de code.

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
Onglet, sous-onglet **et stade de Reviews mémorisés** d'une session à l'autre — et **rien d'autre** :
ni recherche, ni modale, ni rapport ouvert, car un état périmé est pire qu'un démarrage propre ·
**raccourcis clavier** (`1`-`9` puis `0` pour les dix onglets, `/` recherche, `n` nouvelle todo, `r` chercher les MR, `l` logs, `?` aide,
`Échap` ferme) · **favicon dynamique** pendant un job · messages d'erreur **traduits en actions**
(certificat, token, CLI introuvable, timeout, réseau) · **onboarding en 3 étapes** tant que la
connexion et les dépôts ne sont pas configurés · chaque champ de formulaire porte une **icône i** dont
le survol (ou le focus clavier) explique à quoi il sert.

- **Palette de commandes — `Ctrl`/`Cmd` + `K`.** On tape un fragment et on saute où l'on veut : un
  onglet, un stade, une merge request, une session — la recherche porte sur ce qui est déjà chargé,
  donc elle répond sans appeler le serveur. `?` affiche la liste complète des raccourcis.
- **Parcourir la liste au clavier** : `j` / `k` descendent et remontent dans la liste visible, `Entrée`
  ouvre, `Échap` relâche. Aucun cadre de focus n'apparaît tant qu'on n'a pas appuyé sur une touche.
- **L'interface se tient tranquille.** Un rafraîchissement qui ne change rien ne reconstruit plus la
  liste : la page ne cligne pas pendant qu'on la lit. Quand une liste se charge vraiment, ses cartes
  arrivent en cascade — une fois, au chargement, pas à chaque caractère tapé dans un filtre.
- **Ce qui tourne est marqué sur l'objet qui tourne** : la merge request ou la session concernée porte
  un liseré animé, **un seul objet à la fois**. Il se fige quand l'onglet passe en arrière-plan et reste
  immobile si le système demande moins d'animations.
- **Le journal ne mange plus le navigateur** : au-delà de quelques milliers de lignes, les plus
  anciennes sont élaguées et un bandeau le dit.
- **Le panneau de rapport ouvre sur ce qui a changé depuis la dernière visite** — arrivées, sorties, et
  celle qui attend depuis le plus longtemps. Trois lignes au maximum, et **rien du tout** quand rien
  n'a bougé.
- Le champ **« reprendre une session d'agent existante »** ne se comporte pas pareil selon le backend.
  Avec **claude**, les sessions sont rangées **par répertoire de projet** (`~/.claude/projects/…`) : comme
  Mergerie travaille dans son propre clone, un identifiant pris ailleurs — ton dépôt à toi, une session
  ouverte à la main dans un terminal — n'y sera pas trouvé. Le travail repart alors d'une session neuve
  avec le contexte réinjecté, et la carte le signale. Avec **copilot**, l'identifiant est un chemin de home
  isolé : il se reprend depuis n'importe où. Les identifiants proposés par Mergerie (« Reprendre au
  terminal », session d'origine d'une branche) sont toujours dans le bon répertoire.

- Un **codage hors dépôt** porte le bouton **« Retour de l'IA » au niveau de la session**, pas seulement
  sur chaque dossier : c'est « qu'a fait l'IA ? » qu'on se demande en regardant la carte. Quand la session
  couvre plusieurs dossiers, la vue offre un sélecteur pour passer de l'un à l'autre sans se refermer.
- Une session portant sur **plusieurs projets** (codage, exploration, ou codage hors dépôt) affiche sa
  liste **repliée**, avec un « Voir les N projets » pour la déplier. Au-delà de quelques dépôts, une seule
  session occupait sinon tout l'écran et masquait les autres — qui sont pourtant ce qu'on est venu
  regarder. Le repli est mémorisé par session : il survit aux rafraîchissements automatiques.
- **Lire un rapport survit à un rafraîchissement** : position de défilement, onglet et version consultée
  sont conservés tant que le rapport lui-même n'a pas changé.
- Une **ligne d'identité trop longue** (chemin de projet, auteur, date) est tronquée à la largeur de la
  carte : le survol en montre alors le texte complet — l'info-bulle n'apparaît que si le texte est
  réellement coupé, et disparaît quand la fenêtre s'élargit. Les liens vers le **ticket** et vers la
  **forge** ont leur propre ligne, où ils passent à la ligne au lieu d'être coupés.

## Vérification objective (vérificateurs)

Une review dit *ce qu'elle pense* du code. Un **vérificateur** dit **ce qui se passe quand on le lance** :
c'est **ton** script de tests, Mergerie lui prépare les dépôts et lit son verdict. Les deux se complètent —
une note de 9/10 sur une MR dont les tests d'intégration cassent ne veut plus rien dire une fois qu'on le sait.

**Ce que ça change concrètement** : un badge sur chaque merge request (`✓ vérifié`, `✗ 2 tests cassés`,
`⚠ base rouge`, `⟳ périmé`), et surtout la possibilité de **vérifier ensemble** des MR de dépôts
différents qui ne valent qu'ensemble — la MR du front et celle de l'API qui ne passent que réunies.

### Deux familles de vérificateurs

**Commandes** — tu donnes une liste (`npm ci`, puis `npm test`), Mergerie la lance dans le dépôt préparé
et **le verdict vient des codes de sortie**. Rien à écrire, rien à installer. C'est le cas courant, et le
bon point de départ.

L'**ordre compte** — `npm ci` avant `npm test` — et se corrige d'un clic : chaque ligne porte son rang et
deux flèches pour la déplacer.

Un tel vérificateur peut **couvrir plusieurs dépôts**. Attention à ce que « couvrir » veut dire : déclarer
un dépôt annonce seulement que ce vérificateur **sait le tester**. À l'exécution, la liste ne tourne que
dans les dépôts **réellement visés par la vérification** — lancée sur une seule merge request, elle ne
touche que son dépôt, même si le vérificateur en couvre cinq. Sur un lot, elle est **rejouée dans chacun**,
l'un après l'autre, et le verdict est le **ET** — tout doit passer. C'est ce qu'on veut quand plusieurs
projets se testent de la même façon : un seul vérificateur au lieu d'un identique par dépôt. Dans un dépôt,
la première commande en échec arrête les suivantes (elles en dépendent) ; d'un dépôt à l'autre on continue,
parce qu'ils sont indépendants et que savoir que deux cassent vaut mieux que de s'arrêter au premier.

Quand plusieurs dépôts sont testés, les échecs sont **préfixés du dépôt** (`grp/lib › panier › remise`) :
sans ça, deux projets ayant chacun un test du même nom seraient indiscernables — et la comparaison
base/tête les confondrait.

**Script** — un exécutable à toi qui s'engage sur le contrat JSON décrit plus bas. Plus de travail, mais il
reçoit **tous les dépôts visés d'un coup** et décide lui-même quoi en faire : c'est la forme d'un vrai test
d'**intégration**, là où « commandes » rejoue simplement la même liste dans chacun. Il rend aussi des tests
nommés quelle que soit la façon dont ta suite s'exprime.

Les deux partagent tout le reste : préparation git, double run base/tête, badges, rapport, « Corriger ».

#### Ce que « commandes » sait dire, et ce qu'il ne sait pas dire

La liste s'arrête **à la première commande qui échoue** : après un `npm ci` raté, la sortie de `npm test`
n'est que du bruit. Le rapport montre alors le déroulé — quelle commande, quel code, combien de temps,
et sa sortie.

Reste la question des **noms de tests**, qui est ce qui rend le verdict causal. Mergerie les cherche dans
cet ordre, sans jamais deviner :

1. **Le fichier de rapport JUnit**, si tu en déclares un (champ *Rapport JUnit*, chemin relatif au dépôt —
   donc lu dans chacun quand plusieurs sont testés). C'est le format pivot : `pytest --junitxml`,
   `jest-junit`, `phpunit --log-junit`, Surefire, `go-junit-report`… Le plus fiable, et il ne subit pas la
   troncature du journal.
2. **Le TAP dans la sortie**, reconnu tout seul — voir plus bas.
3. **Rien.** Alors c'est la **commande** qui est imputée : le badge affiche `✗ échec : npm test` au lieu
   d'annoncer un nombre de tests qu'on ne connaît pas. Et comme la clé du delta devient la commande, une
   commande déjà rouge sur la base donne toujours `⚠ base rouge` — la dégradation reste juste.

Dans ce dernier cas, le rapport affiche en plus **ce qui est nouveau par rapport à la base** : les lignes
présentes à la tête et absentes du run base. Ça ne coûte rien — les deux sorties existent déjà — et ça
pointe souvent directement la régression, y compris derrière un `make test` opaque.

Enfin, si le code de sortie et le rapport de tests se **contredisent** (sortie 0 avec des tests rouges, ou
l'inverse), le verdict suit le code de sortie et le rapport signale la contradiction. C'est presque
toujours un vrai défaut de la commande de test, et le masquer rendrait un mauvais service.

#### TAP : rien à déclarer

Beaucoup de runners écrivent du **TAP** dès que leur sortie n'est pas un terminal — ce qui est toujours le
cas ici, Mergerie lançant les commandes à travers des tubes. Il est alors reconnu et analysé sans aucun
réglage : `node --test`, mocha (`--reporter tap`), vitest (`--reporter=tap`), `pytest-tap`, prove…

Les pièges sont traités : les **sous-tests** ne sont pas comptés deux fois (seules les feuilles en échec
sont retenues, avec leur nom complet `suite › test`), un `# TODO` est un échec **attendu** et ne compte
pas, un `# SKIP` n'est ni l'un ni l'autre, un `Bail out!` donne une erreur et non « zéro échec », et le
**plan** (`1..43`) sert de contrôle : si la sortie a été tronquée, le rapport le dit au lieu de présenter
une liste partielle comme exhaustive.

L'interrupteur *Interpréter le TAP* existe pour le jour où une sortie exotique déclencherait la détection
à tort.

#### `npm: command not found`

L'environnement des commandes est **minimal** (`PATH`, `HOME`, `LANG`, `MERGERIE_VERIFY=1`, sans aucun
jeton), et le `PATH` est celui du **processus serveur**. Lancé depuis un terminal où nvm est chargé, tout
marche. Lancé par un service ou un lanceur de bureau, `npm` sera introuvable — c'est à ça que sert le champ
**Variables d'environnement** : une ligne `CLE=valeur`, par exemple un `PATH` complet.

### Le partage des rôles

**Mergerie fait tout le git.** Ton script ne fait aucun checkout, ne connaît aucune branche : il reçoit des
répertoires déjà positionnés sur les bons commits et répond « les tests passent-ils ». C'est ce qui permet
au même script de servir en worktree jetable comme dans ton propre répertoire de travail.

**Couverture déclarative ≠ checkout effectif.** Dans *Réglages → Vérificateurs*, déclarer un dépôt dit
seulement « ce script sait tester ce dépôt-là ». Seuls les dépôts **effectivement visés** par une
vérification sont préparés et transmis au script. Les autres dépôts couverts et configurés *in place* sont
lus **en lecture seule** et apparaissent comme **contexte** dans le rapport (avec un ⚠ s'ils sont hors de
leur branche par défaut ou modifiés) : un vert obtenu grâce à un voisin resté sur une vieille branche ne
doit pas passer inaperçu.

### Deux modes, dépôt par dépôt

- **worktree** (par défaut) — Mergerie crée un `git worktree` détaché sous `data/worktrees/`, le supprime
  après le run, et ramasse les orphelins au démarrage. Rien de ce que tu as sur ta machine n'est touché.
- **in place** — le run a lieu dans **ton** répertoire de travail. Utile quand l'environnement de test ne
  se recrée pas (base de données locale, containers déjà chauds, `node_modules` installés). Trois
  garde-fous, dans cet ordre : **consentement explicite** à cocher, **identité du dépôt** vérifiée
  (le `origin` du répertoire doit être celui du dépôt), et **refus net si des fichiers SUIVIS ont été
  modifiés** — jamais de `stash` automatique. Des fichiers **non suivis** ne bloquent pas : ils ne sont
  dans aucun commit, le checkout détaché ne les touche pas et la restauration les laisse où ils sont —
  exiger le contraire interdisait le mode *in place* à tout répertoire portant un `.env.local` ou un
  dossier d'artefacts, c'est-à-dire à presque tous. Ils sont comptés et **notés au journal du run** :
  ils restent là pendant les tests et peuvent peser sur le résultat. (Si l'un d'eux porte le nom d'un
  fichier de la branche à tester, git refuse le checkout de lui-même : la vérification échoue au lieu
  d'écraser ton fichier.) Pendant le run, ton répertoire est sur un **commit détaché** : ne
  développe pas dessus. Il est **remis sur sa ref d'origine dans tous les cas**, y compris sur timeout
  ou plantage du job ; si la restauration échoue, le rapport porte un bandeau **« Restauration manuelle
  requise »** — ça ne se noie jamais dans un journal.

Le répertoire se **choisit** plutôt qu'il ne se tape : si tu as déclaré des *répertoires locaux*
(Réglages → Dépôts), un sélecteur liste tous leurs projets git — avec recherche à la frappe, parce qu'une
racine en contient couramment des dizaines — et remplit le chemin absolu. Un chemin tapé à la main reste
possible pour un répertoire hors de toute racine déclarée, mais c'est une faute de frappe qui ne se
découvre qu'au premier run, et qui coûte le run.

Le bouton **« Tester le répertoire »** répond pendant que le formulaire est encore sous tes yeux :
répertoire reconnu, branche courante, et les deux réserves possibles — des modifications suivies (qui
feraient refuser le run) et des fichiers non suivis (qui ne bloquent pas, mais seront là pendant les tests).

### Contrat du script (v1) — famille « script » uniquement

**Quel fichier ?** N'importe quel **exécutable** — l'extension n'a aucune importance (`.sh`, `.py`, `.js`,
un binaire). Deux conditions techniques : le **bit d'exécution** (`chmod +x`), et un **shebang**
(`#!/bin/sh`, `#!/usr/bin/env python3`…) s'il s'agit d'un script, puisqu'il est lancé directement et que
rien ne devine avec quoi l'interpréter. Le champ *Commande* attend un **chemin absolu**, pas une ligne de
commande : **aucun argument n'est transmis**, et tubes, redirections et variables ne seraient pas
interprétés — les options se mettent dans le script.

Le script est lancé **sans shell**, une fois par run (`base` puis `head`), avec un **environnement minimal**
(`PATH`, `HOME`, `LANG`, `MERGERIE_VERIFY=1`) : **aucun jeton**, aucune variable de Mergerie. Son `cwd` est
le premier répertoire de la liste. Son `stderr` est streamé dans le panneau de log du job.

**Entrée** (JSON sur stdin) :

```json
{
  "version": 1,
  "verifier": "integ",
  "role": "head",
  "repos": [
    { "name": "groupe/webapp-front", "dir": "/abs/path", "sha": "a1b2c3…",
      "branch": "feat/PROJ-720", "mode": "worktree", "changed": true }
  ]
}
```

**Sortie** : la **dernière ligne JSON valide** de stdout.

```json
{
  "version": 1,
  "status": "pass",
  "total": 218,
  "failed": [
    { "test": "checkout › total serveur", "message": "attendu 42, reçu 41", "log_excerpt": "…" }
  ],
  "duration_ms": 42000
}
```

Le **code de sortie est indicatif** : c'est stdout qui fait foi (un script qui sort en 1 parce que des
tests échouent a parfaitement rendu son verdict). En revanche une réponse illisible, tronquée ou hors
schéma ne devient **jamais un vert** : elle donne `⚠ vérification en erreur`. Bornes : `failed` ≤ 50
entrées, `log_excerpt` ≤ 4 ko chacun, réponse totale ≤ 256 ko.

### Exemple A — worktree + docker compose éphémère

```sh
#!/bin/sh
# Vérificateur d'intégration : une stack jetable par run, détruite quoi qu'il arrive.
set -eu
ENTREE=$(cat)
FRONT=$(printf '%s' "$ENTREE" | jq -r '.repos[] | select(.name|endswith("webapp-front")) | .dir')
API=$(printf '%s' "$ENTREE" | jq -r '.repos[] | select(.name|endswith("api-core")) | .dir')

PROJET="mergerie-verify-$$"
trap 'docker compose -p "$PROJET" down --remove-orphans >&2 || true' EXIT

docker compose -p "$PROJET" --env-file ./integ.env \
  -f "$API/docker-compose.yml" -f "$FRONT/docker-compose.yml" up -d --build >&2

# Le rapport JUnit est converti en réponse du contrat. `total`/`failed` viennent de lui.
if docker compose -p "$PROJET" run --rm tests >/tmp/out-$$ 2>&1; then
  printf '{"version":1,"status":"pass","total":%s}\n' "$(grep -c '^ok ' /tmp/out-$$)"
else
  printf '{"version":1,"status":"fail","failed":%s}\n' "$(./junit2json.sh /tmp/out-$$)"
fi
```

Deux points qui comptent : `-p` **isole le projet compose** (deux runs ne se marchent pas dessus), et le
`trap EXIT` garantit la destruction de la stack **même si le script est tué** au timeout.

### Exemple B — in place + adaptateur HTTP

Quand la suite tourne déjà dans un orchestrateur local, le script n'a plus qu'à la déclencher et à
**traduire sa réponse** dans le contrat :

```sh
#!/bin/sh
set -eu
cat >/dev/null            # l'entrée ne sert pas : l'orchestrateur connaît déjà les dossiers
curl -sf --max-time 900 -X POST http://127.0.0.1:9099/run \
  | jq -c '{version:1,
            status: (if .failures == 0 then "pass" else "fail" end),
            total: .tests,
            failed: [.results[] | select(.ok|not)
                     | {test: .name, message: .message, log_excerpt: .output}][:50]}'
```

### `node_modules`, et pourquoi la base est parfois rouge

**Stratégie `node_modules`.** Un worktree neuf n'a pas de dépendances installées. Deux réponses :
un **symlink** depuis un cache partagé (rapide, mais suppose que le `lock` n'a pas changé), ou une
**installation** dans le worktree (lente, mais fidèle). Le choix t'appartient — il vit dans ton script.
Un `ln -s "$CACHE/node_modules" "$dir/node_modules"` fait l'affaire tant que tu invalides le cache sur
changement de `package-lock.json`.

**FAQ.**

- *Pourquoi ma base est rouge ?* Le run **base** rejoue la même suite sur les branches cibles, **avant** tes
  changements. S'il échoue déjà, le verdict est `⚠ base rouge` et **rien n'est imputé à ta branche** —
  c'est le but. Décocher « Lancer aussi la base » supprime ce second run : le verdict tombe quand même,
  mais il n'est plus **causal**, et le rapport le dit.
- *La base est-elle rejouée à chaque fois ?* **Oui**, même quand aucun commit n'a bougé. Un cache par jeu
  de SHAs a existé et faisait gagner du temps ; il supposait que l'**environnement** n'avait pas bougé non
  plus, ce que rien ne permet de vérifier — et il se trompait dans les deux sens : un rouge de base corrigé
  hors git (un service redémarré, une migration appliquée) restait collé et bloquait la MR sur un
  « base rouge » périmé ; à l'inverse, un vert de base devenu faux faisait imputer à ta branche un échec
  qui ne venait pas d'elle. Une vérification coûte donc deux runs — c'est le prix d'un verdict qui ne
  ment pas. Pour n'en payer qu'un, décoche « Lancer aussi la base » : le verdict est alors marqué non causal.
- *git ne marche pas dans mon container de test.* Dans un worktree, `.git` est un **fichier pointeur** vers
  le dépôt principal, pas un dossier. Monte aussi le clone (`data/clones/…`) dans le container, ou
  n'appelle pas git depuis les tests.
- *« Restauration manuelle requise ».* Le mode *in place* n'a pas pu remettre ton répertoire sur sa
  branche : il est resté sur un commit détaché. Le message dit **quel répertoire** et **quelle ref**
  attendre — un `git checkout <ref>` suffit une fois ce qui bloquait levé.
- *Le verdict est `⟳ périmé`.* Il porte sur des commits qui ne sont plus ceux de la branche. Il est
  **conservé, pas effacé** (il est daté) : relance la vérification.

### Vérifier ensemble, et corriger

Le bouton **Vérifier** est présent sur les merge requests à traiter **comme sur celles déjà reviewées**
(dans la liste et dans le panneau de rapport) : une review est un avis, un verdict est un fait, et le
second garde tout son intérêt une fois le premier rendu. Un clic ouvre une **confirmation** qui annonce ce
qui va tourner — les commandes ou le script, le dépôt, le mode, le délai — avant de lancer quoi que ce
soit. Elle apparaît même quand un seul vérificateur couvre le dépôt : exécuter des commandes sur sa
machine mérite un écran, pas un clic silencieux.

**Pendant qu'elle tourne, ça se voit.** Une vérification dure des minutes : le bouton devient
**`Vérification…`** avec son spinner, désactivé — un second clic ne peut donc pas relancer la même —,
et la carte porte le **repère « en cours »** (le liseré qui bat), le même que pendant une review. L'état
vient du **serveur**, pas de la page : il survit à un changement d'onglet, au re-tri de la liste et à un
rechargement, et il retombe tout seul à la fin, la liste se rafraîchissant pour afficher le verdict.
⚠ Une review sur la même MR marque bien la carte, mais **ne fait pas tourner** le bouton *Vérifier* :
un spinner désignant la mauvaise commande vaudrait moins que pas de spinner du tout.

Dans *Reviews*, coche plusieurs merge requests : la barre d'actions propose **Vérifier ensemble** et
**Créer un lot** (un lot est nommé, persisté, et re-vérifiable d'un bouton depuis *Dev IA*). Deux MR du
**même dépôt** sont refusées — on ne saurait pas quel code a été testé.

Sur un verdict `✗`, le rapport propose **« Corriger (session IA) »** : une **seule** session de codage
couvrant **tous** les dépôts du lot — pas seulement celui où le test a cassé, parce que la cause d'un
échec d'intégration est souvent ailleurs. Le prompt porte les faits (tests cassés, messages, extraits,
commits testés) et les branches de travail sont **celles des MR** : le push les met à jour en place.
Après le push, tu relances la vérification à la main — aucune chaîne automatique.

### Deux vérifications en même temps ?

Ça dépend de ce qui tourne. Une vérification **mono-dépôt** est contenue dans son répertoire : une autre
peut partir en parallèle, tant qu'elle ne vise pas le **même dépôt** — relancer la même chose ne donnerait
pas un second avis, seulement un run qui attend le premier pour dire la même chose.

Une vérification **multi-dépôts**, elle, est un run d'intégration : elle monte un environnement complet,
souvent des containers sur des ports et des bases fixes. Celle-là bloque tout le monde, et se fait bloquer
par tout le monde — deux en parallèle rendraient des rouges qui n'apprennent rien.

Dans les deux cas le refus est immédiat et dit laquelle des deux raisons s'applique.

**Mode dry-run** : il ne concerne que l'agent IA. Une vérification, elle, **reste réelle** si elle est
configurée. En **mode démo**, en revanche, aucun script n'est lancé : le verdict est simulé.

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
| `JENKINS_CA_CERT` | — | idem pour un **Jenkins interne** derrière un certificat d'entreprise |
| `JENKINS_INSECURE_TLS` | 0 | `1` = ignore la vérif TLS **pour Jenkins uniquement** (dépannage) |
| `GIT_CLONE_SSH` | 0 | `1` = clone via SSH (ta clé) au lieu de HTTPS+token |
| `MERGERIE_DATA_DIR` | `data/` | dossier de données isolé (utile pour les tests) |

L'agent IA doit pouvoir **modifier des fichiers** (mode « yolo ») pour les sessions de codage. Les explorations, elles, sont en lecture seule : les dépôts sont remis à zéro après chaque passe.

## GitLab self-hosted / GitHub Enterprise / Jenkins interne / certificat d'entreprise

Si l'API échoue avec `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` ou `unable to get local issuer certificate`
(CA interne inconnue de Node) :
- **propre** : exporte le CA (chaîne complète jusqu'à la racine) et pointe `GITLAB_CA_CERT=/chemin/ca.pem`
  (ou `GITHUB_CA_CERT` pour une instance GitHub Enterprise, `JENKINS_CA_CERT` pour un Jenkins interne) ;
- **dépannage** : `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1` / `JENKINS_INSECURE_TLS=1`.

C'est le cas le plus courant avec **Jenkins** : un serveur interne est presque toujours servi par un
certificat qu'un Node fraîchement installé ne connaît pas. Le message de l'onglet Jenkins nomme
directement les deux variables — le CA épinglé d'abord, la désactivation ensuite.

Les trois réglages sont **indépendants** : épingler le CA de ton GitLab interne ne change rien aux appels
vers github.com ni vers ton Jenkins. Pour le **clone**, `git` a son propre store : soit `GIT_CLONE_SSH=1` (clé SSH), soit les
réglages ci-dessus sont aussi appliqués à git.

## Enregistrer une vidéo de présentation (prête pour YouTube)

```bash
npm i -D playwright && npx playwright install chromium   # une seule fois
npm run record:demo                                       # les deux langues, l'une après l'autre
npm run record:demo -- --lang=en                          # → demo-recordings/mergerie-demo-en.webm
npm run demo:gif                                          # → docs/demo.gif (celui du README)
```

`scripts/record-demo.js` est autonome : il lance lui-même l'app en mode démo, attend le port 4319,
pilote un Chromium qui enregistre en **1920×1080** une **visite guidée** avec **faux curseur visible**,
**cartons** d'intro/fin et **légendes explicatives** synchronisées sur chaque écran — puis arrête tout
proprement (la fermeture du contexte flushe la vidéo). Le parcours : *Reviews* → un rapport noté →
sélecteur de versions **v1 → v2 → v3** (progression **5,8 → 8,4**) → suivi de résolution → *Dev IA*
(session reliée à sa MR, question posée par l'IA) → *Notes* (brief du matin, todos, pages) →
*Jira* → *Git* (explorateur de branches) → *Liens* (grille, santé, palette globale) → *Docker*
(drift `.env` + logs live) → *Stats* → la colonne de navigation qui se replie. Le `.webm` produit
s'uploade directement sur YouTube.

**Les deux langues** sont enregistrées l'une après l'autre, sur le même serveur de démo, et la
langue est posée aux **deux** endroits où l'app la lit — `localStorage` pour l'interface, et
`config.language` en base pour les messages venus du serveur. N'en poser qu'un donne une vidéo
anglaise ponctuée de phrases françaises.

**Les listes déroulantes sont redessinées dans la page** le temps de l'enregistrement. La liste
d'un `<select>` natif est dessinée par le système, hors de la page : la caméra filme la page, donc
elle n'apparaissait jamais. On voyait le curseur cliquer, puis la valeur changer toute seule — le
geste le plus incompréhensible de la vidéo. Le double est construit à partir des vraies options de
l'élément ; c'est un artifice d'enregistrement, il vit dans `scripts/record-demo.js` et nulle part
ailleurs.

**Le GIF du README** se fabrique du même enregistrement : `npm run demo:gif`. Les réglages (6 im/s,
640 px, 64 couleurs, palette calculée sur la vidéo) sont calés pour tenir sous ~3,5 Mo — un fichier
que GitHub recharge à chaque visite de la page d'accueil — sans rendre l'interface illisible. Ils
vivent dans `scripts/demo-gif.sh` plutôt que dans une commande à retrouver : les redécouvrir coûte
une demi-heure et donne un fichier deux fois trop lourd.

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

Tout l'état vit dans **`data/`** (gitignored) : `reviewer.db` (SQLite), `clones/`, `reviews/` (un dossier par MR, avec **une version de rapport par passe** : `review-v1.md`, `review-v2.md`…), `tickets/`, `tasks/` (diffs par projet et réponses d'exploration).

### Sauvegarder

**Réglages → Général → « Sauvegarder les données »** produit une archive `.zip` datée contenant :

- **`reviewer.db`**, copiée par l'API de sauvegarde de SQLite et non par un `cp` — une copie de fichier
  faite pendant une écriture donne une base corrompue, ce qui ne se découvre que le jour où l'on essaie de
  la restaurer ;
- **`reviews/`**, **`tasks/`** et **`tickets/`** : les rapports, les retours d'agent et les captures que la
  base référence par leur chemin. Sauvegarder la base seule laisserait des références mortes ;
- un **`LISEZ-MOI.txt`** avec la marche à suivre pour restaurer — une sauvegarde qu'on ne sait plus
  restaurer ne vaut rien, et c'est six mois plus tard qu'on l'ouvre.

Les **clones et les worktrees en sont exclus** : ils se retrouvent avec un `git clone`, et les inclure
multiplierait la taille de l'archive pour ne rien sauver d'irremplaçable. L'archive est assemblée en
mémoire ; au-delà de 256 Mo elle est refusée avec le nom du fichier qui a fait déborder, plutôt que de
faire tomber le serveur.

**Restaurer** — Mergerie arrêtée (la base ne doit pas être écrite pendant la copie) : mettre l'ancien
`data/` de côté, décompresser l'archive à sa place, relancer. Les clones manquants sont refaits à la
demande.

### Conserver l'historique

**Réglages → Général → « Conserver l'historique »** (défaut **90 jours**, `0` = sans limite) supprime au-delà
du délai : les **journaux de jobs**, les **jobs terminés** et le **fil d'activité**. Le ménage a lieu au
démarrage puis une fois par jour. Minimum 7 jours — un délai plus court effacerait le journal du job qu'on
est en train de lire ; et un job **en cours** n'est jamais purgé, si ancien soit-il.

Deux choses ne sont **jamais** purgées, à dessein : le **coût en tokens** (`usage`), parce qu'il porte un
total cumulé qui ne doit pas baisser tout seul, et les **itérations d'agent** (`agent_pass`), qui
disparaissent déjà avec leur session et dont les cartes proposent la relecture.

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

**Une page ouverte dans un autre onglet ne peut pas agir à ta place.** Écouter sur `localhost` ne protège
de rien contre ça : c'est **ton** navigateur qui émet, et n'importe quel site peut lui faire poster chez
Mergerie — un simple formulaire part **sans préflight**, et les routes qui ne lisent pas leur corps
s'exécuteraient telles quelles (effacer tous les rapports, publier tes commentaires en attente sur une vraie
merge request avec ton jeton, lancer un agent sur tes dossiers). Le code étant public, la liste des routes
n'est un secret pour personne. **Toute requête qui écrit et qui annonce une origine étrangère est donc
refusée** (403), avec un message qui nomme le coupable probable. Ce qui **n'est pas** refusé : les lectures
(elles ne changent rien, et la réponse reste illisible pour la page tierce) et les requêtes **sans** origine
— `curl`, un script à toi, l'onglet *Commandes* : un navigateur, lui, en envoie toujours une.

**Permissions de l'agent IA (« mode yolo »).** L'agent tourne avec ses garde-fous de permissions
**désactivés** (« yolo ») car les sessions de codage l'exigent : il doit pouvoir créer, modifier et
supprimer des fichiers sans confirmation à chaque étape. Son **rayon d'action nominal est le clone de
travail** (`data/clones/…`), et les garanties sont **structurelles** quand c'est possible : une exploration
est en lecture seule car le worktree est **remis à zéro dans un `finally`** après coup, une review ne fait
que **lire un diff**. Mais pendant une **session de codage**, l'agent dispose des **droits de l'utilisateur
sur la machine** — rien ne l'empêche techniquement d'agir hors du clone. C'est le **compromis assumé** d'un
outil **local mono-utilisateur** : à connaître avant usage, et une raison de plus de ne pas exposer le serveur.

**Vérificateurs.** Lancer les tests d'un dépôt, **c'est exécuter le code de ce dépôt** : même niveau de
confiance que la session d'agent, et le script s'exécute avec **tes** droits sur la machine. La commande
est un **chemin absolu venant de la configuration** — jamais un fichier du dépôt cloné —, elle est lancée
**sans shell**, avec un **environnement minimal sans aucun jeton**. La réponse du script est traitée comme
une **donnée non fiable** : schéma validé, tailles bornées, échappement systématique à l'affichage. Les
worktrees sont créés **sous `data/` uniquement**, et le mode *in place* n'écrit dans un répertoire à toi
qu'après **consentement explicite** (voir *Vérification objective*).

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

**TLS entreprise.** Pour un GitLab self-hosted, un GitHub Enterprise ou un Jenkins interne à CA interne,
fournis `GITLAB_CA_CERT` / `GITHUB_CA_CERT` / `JENKINS_CA_CERT`. Le `*_INSECURE_TLS=1` correspondant
**désactive** la vérification du certificat pour ce service uniquement : à **réserver à un réseau interne
de confiance**.
