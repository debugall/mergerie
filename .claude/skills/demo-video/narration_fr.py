# -*- coding: utf-8 -*-
"""Narration de la visite guidée — français.

Une entrée par étape, dans l'ordre du parcours de `parcours.mjs` : la Nième chaîne est lue
pendant la Nième étape. AJOUTER UNE ÉTAPE ICI SANS EN AJOUTER UNE DANS `parcours.mjs`
(ou l'inverse) décale tout ce qui suit — les deux fichiers se comptent, et le script
s'arrête net si le compte ne tombe pas juste.

Le texte est écrit pour ACCOMPAGNER le geste : il décrit ce qui est à l'écran au moment où
le curseur y arrive. Il est ensuite réécrit pour la voix par `prononciation.py` — écrire
l'orthographe correcte ici, jamais une graphie phonétique.
"""

NARRATION = [
    (
        "Voici Mergerie, un cockpit de développement local assisté par IA. Onze onglets dans une colonne à gauche : les reviews de merge requests, les sessions de développement, les agents, les notes, Jira, git, Docker, Jenkins, les liens de travail, les statistiques et les réglages. Les pastilles signalent le travail en attente, jamais des totaux décoratifs. "
    ),
    (
        "On commence par les merge requests à traiter. Chaque carte donne l'essentiel : le numéro, le titre, le projet, l'auteur et la date, puis les branches concernées et les liens vers le ticket et vers la forge. "
    ),
    (
        "Une barre de recherche filtre sur le titre, l'auteur, le projet ou le ticket. On la retrouve partout dans l'outil : sur un dépôt actif, les listes deviennent vite longues. "
    ),
    (
        "La file se range comme on veut : les petites d'abord, les plus anciennes, la note la plus basse, les bloquants d'abord. Quand l'ordre n'est pas l'ordre habituel, le contrôle le marque — une liste réordonnée sans qu'on sache selon quoi ne se lit pas. "
    ),
    (
        "Le bouton Reviewer lance l'analyse par l'IA sur cette merge request. La petite flèche à côté ouvre deux variantes : review seule, ou review accompagnée d'une explication pédagogique du changement. "
    ),
    (
        "Avant de dépenser un appel, Voir le diff permet de lire le code. "
    ),
    (
        "Le diff s'ouvre dans l'outil : fichier par fichier, avec les ajouts et les suppressions. On juge soi-même si la merge request mérite une review complète. "
    ),
    (
        "Le bouton Contexte, lui, sert à donner à l'IA ce qu'elle ne peut pas deviner. "
    ),
    (
        "On y colle le texte du ticket, une spécification ou une règle métier, on peut joindre une capture d'écran, et déclarer les projets et les branches liés. Tout cela est ajouté à la consigne de review. "
    ),
    (
        "En haut, Reviewer les 6 MR traite toute la file d'un coup. Les jobs s'enchaînent, trois au maximum en parallèle, et deux jobs qui toucheraient le même dépôt sont refusés plutôt que de se marcher dessus. "
    ),
    (
        "Chercher les nouvelles MR interroge GitLab et GitHub et ramène ce qui est apparu depuis la dernière fois. "
    ),
    (
        "Sur chaque carte, Classer sans review sort une merge request triviale de la file, Merger la fusionne directement, et Faire coder l'IA ouvre une session de développement à partir de cette merge request. "
    ),
    (
        "Et quand un agent a cartographié un sujet, les merge requests qui touchent ses fichiers portent sa carte : on sait sur quel terrain on entre avant même d'ouvrir le diff. "
    ),
    (
        "Passons aux merge requests déjà reviewées. "
    ),
    (
        "Quand on revient dans l'outil, le panneau de droite résume ce qui a bougé depuis la dernière visite, et propose les rapports à regarder en priorité. "
    ),
    (
        "La liste de gauche montre la note attribuée à chacune, de zéro à dix, et signale les rapports devenus périmés parce que la branche a bougé depuis. On en ouvre un. "
    ),
    (
        "Le rapport suit toujours la même structure : un résumé, les points relevés avec leur emplacement précis dans le code et leur gravité, ce qui est bien, et une note globale. "
    ),
    (
        "Chaque constat porte un fichier et une ligne. Mettre en brouillons les transforme d'un geste en remarques posées sur le diff, prêtes à relire. Rien ne part chez la forge. "
    ),
    (
        "Et ce qui ne peut pas être posé est dit : un constat qui parle d'une ligne que la branche n'a pas touchée n'a pas d'ancrage dans le diff, la forge refuserait la position. Ceux-là sont laissés de côté, et comptés. "
    ),
    (
        "Le second onglet contient l'explication pédagogique : ce que fait la merge request et pourquoi, pour prendre en main un changement qu'on n'a pas écrit. Le bouton Copier récupère tout le rapport en Markdown. "
    ),
    (
        "Au-dessus, Ouvrir le code lance l'éditeur sur le dépôt local, positionné sur la bonne branche. Contexte rouvre le dossier de contexte de cette merge request, pour le compléter avant une nouvelle passe. "
    ),
    (
        "Relancer la review refait tout. Quand la branche a bougé depuis, le rapport est marqué périmé, et la relance devient une relance delta : elle ne fait relire que ce qui a changé. "
    ),
    (
        "Marquer traitée range la merge request sans la fusionner, Merger la fusionne, et Supprimer le rapport repart de zéro. "
    ),
    (
        "Le menu porte les gestes plus rares : publier le rapport sur la merge request, ranger un constat dans les todos, supprimer le rapport. "
    ),
    (
        "Plus bas, on peut demander une modification du rapport en langage naturel : creuse ce point, reformule plus court. L'IA régénère le rapport avec cette consigne. "
    ),
    (
        "Juste en dessous, on peut simplement poser une question : pourquoi ce point est-il bloquant, qu'est-ce qui se passerait si on ne le corrigeait pas. "
    ),
    (
        "La réponse s'ajoute sous le rapport, et le rapport ne bouge pas : ni son texte, ni sa note, ni ses versions. Demander une explication ne doit pas coûter le rapport qu'on est en train de lire. "
    ),
    (
        "Et si une page de notes parle de cette merge request, elle est citée ici. L'autolien marche dans les deux sens : la note mène à la merge request, la merge request retrouve la note. "
    ),
    (
        "Encore en dessous, les commentaires de la merge request sont repris depuis la forge. On lit les échanges, on répond, et la réponse est postée sur GitLab ou GitHub sans quitter l'outil. "
    ),
    (
        "Faire corriger le code par l'IA ouvre une session de développement sur la branche de la merge request, avec les points du rapport comme consigne. "
    ),
    (
        "Et Converger lance la boucle autonome. "
    ),
    (
        "L'IA corrige, commite, pousse, se relit, et recommence jusqu'au seuil de note ou au plafond de passes. L'avertissement est explicite : chaque passe pousse un commit sur la branche partagée, mais jamais de fusion. C'est toi qui relis et qui merges à la fin. "
    ),
    (
        "Le troisième segment, Traitées, garde la trace de ce qui est terminé. "
    ),
    (
        "Une review donne un avis. À côté, un badge donne un fait : vérifié, ou tant de tests cassés. Il vient d'un vérificateur, c'est-à-dire de vos propres tests, lancés sur les commits de la branche. "
    ),
    (
        "Le rapport dit sur quels commits le verdict porte, quels tests ont cassé, avec leur message, et le déroulé des commandes lancées. Mergerie a aussi rejoué la suite sur la branche cible avant vos changements : un test déjà rouge avant n'est donc jamais imputé à la branche. "
    ),
    (
        "Quand l'échec est imputable à la branche, un bouton ouvre une session de correction, avec les tests cassés et les commits testés déjà dans le prompt. "
    ),
    (
        "Vérifier se lance depuis la liste, et aussi depuis une merge request déjà reviewée : l'avis et le fait ne s'excluent pas. "
    ),
    (
        "Une confirmation annonce ce qui va tourner : quel vérificateur, quelles commandes, dans quel dépôt et avec quel délai. Lancer des commandes sur sa machine mérite un écran, pas un clic silencieux. "
    ),
    (
        "Et pour les changements qui ne valent qu'ensemble, on coche plusieurs merge requests de dépôts différents et on les vérifie en une fois : le verdict vaut alors pour toutes. "
    ),
    (
        "Un vérificateur peut partir tout seul dès qu'une merge request apparaît. Ce bouton ouvre le résultat de chacun de ceux qui ont tourné sur elle : le verdict, les commits testés, et les tests cassés nommés un par un. "
    ),
    (
        "Et le déroulé des commandes, avec leur code de sortie et leur sortie. C'est ce qui manquait quand on n'a pas vu passer le lancement : savoir non pas que c'est vert, mais ce qui a tourné. "
    ),
    (
        "Sur un diff, une remarque peut attendre. Ces commentaires sont enregistrés en local, relisables et modifiables, et rien n'est encore parti sur la forge. "
    ),
    (
        "Quand la relecture est finie, un seul bouton les envoie tous. L'auteur reçoit une notification au lieu de dix, et une remarque qu'on n'aurait pas gardée trois fichiers plus loin ne part jamais. "
    ),
    (
        "Et si le lot ne va plus, Tout supprimer le vide d'un coup. La confirmation dit combien de remarques partent, et lesquelles : on ne jette pas dix remarques écrites hier sur un « êtes-vous sûr » anonyme. "
    ),
    (
        "Passons à l'onglet Dev IA, celui où c'est l'IA qui écrit le code. "
    ),
    (
        "Quatre familles de sessions : le codage sur des dépôts git, le codage hors dépôt sur un simple dossier, l'exploration qui lit le code sans rien modifier, et la question libre, sans dépôt du tout. "
    ),
    (
        "On crée une session de codage. "
    ),
    (
        "On choisit un ou plusieurs dépôts — avec recherche, forcément — la branche à créer ou à réutiliser, et la branche de départ. "
    ),
    (
        "Puis on décrit la tâche en langage naturel. On peut joindre une capture d'écran, et fixer le message de commit. "
    ),
    (
        "Deux options changent le comportement : l'auto-push, qui pousse la branche dès que le travail est fini, et l'autorisation donnée à l'IA de poser des questions quand elle hésite. En dessous, un champ permet de reprendre une session d'agent existante plutôt que d'en ouvrir une neuve. "
    ),
    (
        "Une session peut aussi emprunter le profil d'un agent : son rôle, son périmètre de dépôts, ses outils et ses skills, sans les ressaisir. "
    ),
    (
        "En bas, le bouton principal crée la session et la lance. Une case à cocher enchaîne directement avec la boucle de convergence, et le bouton d'à côté crée la session sans l'exécuter — on la lancera quand on voudra. "
    ),
    (
        "Une fenêtre qui contient de la saisie se met de côté. Le tiret la range dans le menu, avec ce qu'on avait écrit. "
    ),
    (
        "Un clic la reprend : les champs remplis, le curseur là où on l'avait laissé, et l'onglet d'où elle venait. "
    ),
    (
        "Voici une session qui porte sur quatre dépôts à la fois. Chaque projet affiche son état, sa branche et sa progression. Un projet en échec n'interrompt jamais les autres — son erreur reste sur sa ligne. "
    ),
    (
        "Une session à plusieurs projets affiche sa liste repliée : au-delà de quelques dépôts, une seule session prendrait tout l'écran et masquerait les autres. Un clic la déplie, et le choix est mémorisé. "
    ),
    (
        "Chaque projet a ses propres actions : le relancer lui seul, sans rejouer les autres. "
    ),
    (
        "Lui envoyer un suivi qui ne concerne que lui, reviewer sa merge request, ou la merger. Et quand plusieurs projets sont prêts en même temps, des boutons groupés font le geste pour tous. "
    ),
    (
        "À droite, les actions de la session entière : la relancer, l'enchaîner avec la convergence, et — quand certains projets ont échoué — ne rejouer que ceux-là. Une session qui s'est arrêtée en erreur alors que le travail était fait propose en plus de vérifier l'état des branches. "
    ),
    (
        "Une session se duplique : le formulaire s'ouvre pré-rempli, et enregistrer crée une nouvelle session au lieu d'écraser l'ancienne. "
    ),
    (
        "Une session garde toutes ses itérations : le lancement, puis chaque suivi, avec la demande qui l'a produit. La liste se cherche. "
    ),
    (
        "Et chaque itération porte son propre diff. Au troisième suivi, les trois lignes qu'on vient de demander se cherchaient au milieu de deux cents : ce bouton ne montre que ce que cette passe-là a changé. Seule la dernière mesure est gardée. "
    ),
    (
        "Voici l'autre cas : l'IA a préféré demander. Elle pose ses questions avec les options qu'elle voit dans le dépôt, et attend. "
    ),
    (
        "On répond, et la session reprend exactement là où elle s'était arrêtée. "
    ),
    (
        "Reprendre au terminal rouvre la même session d'agent dans un vrai terminal, avec tout son historique : on continue à la main quand c'est plus rapide. "
    ),
    (
        "Le codage hors dépôt fait la même chose sur un simple dossier, sans git, sans branche et sans merge request. Pratique pour un script isolé ou un dossier de notes. "
    ),
    (
        "L'exploration, elle, ne modifie rien : on pose une question sur le code, on lit la réponse, on enchaîne avec une question de suivi. C'est le mode à utiliser pour comprendre avant de toucher. "
    ),
    (
        "La question libre, elle, ne touche à aucun dépôt : on pose une question à l'IA, on garde la réponse, et on la retrouve avec ses itérations. "
    ),
    (
        "Ces regroupements se nomment et se conservent : un lot se re-vérifie ensuite d'un seul bouton. "
    ),
    (
        "L'onglet Agents. Un agent est un profil de session : un rôle, un périmètre de dépôts, des outils, des skills, une sortie — et parfois un horaire. "
    ),
    (
        "Chaque carte dit à quoi l'agent sert et sur quoi il travaille : tous les dépôts actifs, ou seulement ceux qu'on lui a donnés. "
    ),
    (
        "Demander le lance sur un sujet. Sa sortie peut être un rapport, une page de notes réécrite à chaque passage, ou même un autre agent. "
    ),
    (
        "Celui-ci part tout seul, chaque lundi à sept heures. Un agent qui part sans personne doit avoir une borne de tours : sans elle, l'horaire est refusé. "
    ),
    (
        "Un agent de domaine, lui, garde une connaissance : la carte de son sujet, versionnée — où vit ce code, par quel mécanisme, et comment on le teste. "
    ),
    (
        "Et cette carte vieillit. L'outil compte les commits qui ont touché ses chemins depuis la dernière cartographie, et signale ceux qui n'existent plus. "
    ),
    (
        "Mettre à jour relance la cartographie sur ce qui a bougé, plutôt que de tout refaire. "
    ),
    (
        "Une nouvelle version ne s'impose pas : elle attend d'être relue et validée. Une connaissance fausse coûte plus cher qu'une connaissance vide. "
    ),
    (
        "Le second sous-onglet liste ce que le disque offre : les skills et les sous-agents trouvés dans les dépôts clonés et dans ton home. En lecture seule — c'est le disque qui décide, pas l'outil. "
    ),
    (
        "L'onglet Notes est celui sur lequel l'outil s'ouvre : c'est le premier écran de la journée. "
    ),
    (
        "Le brief du matin rassemble ce qui appelle un geste : les merge requests dormantes, les vérifications rouges, les sessions qui attendent une réponse. Chaque ligne est cliquable, et se range définitivement d'une croix si elle ne t'intéresse pas. "
    ),
    (
        "Il compte aussi les sessions de développement en attente : jamais lancées, non poussées, sans merge request. Le travail est fait, il ne manque qu'un clic. "
    ),
    (
        "Le brief dit aussi ce que la surveillance a vu pendant qu'on n'était pas là : un conteneur tombé, un build Jenkins terminé, un plafond automatique qui a laissé du travail de côté. "
    ),
    (
        "Et ce que les agents ont fait tout seuls, avec ce qu'ils ont produit. "
    ),
    (
        "Copier pour le daily en fait un texte à coller dans la réunion du matin. "
    ),
    (
        "Les todos se trient par priorité d'abord, puis dans l'ordre que tu leur donnes à la main. Elles se cochent sur place. "
    ),
    (
        "Celle-ci a été posée par l'outil : une session s'est arrêtée pour poser une question. La file est libre, plus rien ne repartira, et la notification est fermée depuis longtemps — la todo, elle, reste sous les yeux. Répondre la referme. "
    ),
    (
        "Une todo se repousse d'une heure ou à demain matin, et garde le lien vers ce qui l'a fait naître : une merge request, un ticket, un conteneur, une vérification. "
    ),
    (
        "Les pages sont des notes libres en Markdown, cherchables. "
    ),
    (
        "Une clé de ticket ou un numéro de merge request écrit dans le texte devient un lien vers l'écran correspondant, sans qu'on ait rien à coller. "
    ),
    (
        "L'onglet Liens répond à une question banale et pénible : où est l'adresse de ce service, dans cet environnement ? "
    ),
    (
        "Une grille : les services en lignes, les environnements en colonnes. Une case peut porter plusieurs adresses nommées. "
    ),
    (
        "On filtre par environnement, par service, par étiquette — et la grille reste lisible sans jamais défiler de côté. "
    ),
    (
        "Coller une adresse suffit : l'outil lit l'URL, reconnaît le service et l'environnement, et propose le libellé. "
    ),
    (
        "La recherche traverse tout, et la palette de commandes cherche dans la même base : un lien, une merge request, un ticket, une todo. "
    ),
    (
        "L'onglet Statistiques répond à une question simple : est-ce que la qualité monte ? "
    ),
    (
        "La distribution des notes et la moyenne par semaine montrent la tendance. En haut, l'activité récente de la forge, projet par projet. "
    ),
    (
        "Le tableau par projet classe les pires notes en premier, avec le taux de résolution : combien de constats ont réellement été corrigés. "
    ),
    (
        "Et le coût en tokens est affiché comme un minorant assumé : le travail interne de l'agent n'est pas comptabilisé, l'outil le dit plutôt que de faire semblant. "
    ),
    (
        "Les opérations git sont comptées aussi, avec leur taux d'échec, et les constats qui reviennent d'une review à l'autre sont regroupés : c'est là qu'on voit ce qui mérite une règle plutôt qu'une remarque de plus. "
    ),
    (
        "L'onglet Git applique la même opération à plusieurs dépôts en même temps. "
    ),
    (
        "Huit outils. Le premier crée ou supprime des branches et des tags sur une sélection de dépôts. "
    ),
    (
        "Les dépôts se filtrent par recherche, et les branches aussi — un dépôt actif en compte des centaines, une liste brute serait inutilisable. "
    ),
    (
        "Rien ne s'exécute sans un aperçu ligne par ligne : on voit exactement ce qui va être fait, dépôt par dépôt, avant de confirmer. "
    ),
    (
        "Le deuxième fusionne une branche dans une autre, et quand il y a conflit, il se résout ici, fichier par fichier, sans quitter l'outil. "
    ),
    (
        "La navigation positionne les dépôts locaux sur une branche donnée, en une fois, à partir d'un répertoire qui contient tous les clones. "
    ),
    (
        "Les commandes git lancent la même commande partout — une palette de commandes courantes est fournie, et on peut écrire la sienne. "
    ),
    (
        "L'explorateur de branches compare l'état des branches entre les dépôts : ce qui est en avance, en retard, ou absent. "
    ),
    (
        "Comparer met deux dépôts côte à côte, branche par branche ou tag par tag, même sans histoire commune. "
    ),
    (
        "Trouver une ref cherche un tag ou une branche dans tous les dépôts actifs et dit lesquels le possèdent. "
    ),
    (
        "Enfin, l'historique garde la trace de chaque opération, et chaque suppression de branche ou de tag reste restaurable. "
    ),
    (
        "L'onglet Docker montre l'état réel des projets compose. "
    ),
    (
        "Chaque service affiche son état, et surtout le drift de configuration : ce que le compose demande, comparé à ce qui tourne vraiment, variable par variable. Ici, la taille du pool est passée de dix à vingt-cinq. Les valeurs sensibles, elles, sont masquées. "
    ),
    (
        "La recherche et le filtre d'état séparent nettement les containers en cours, ceux qui se sont arrêtés proprement, et ceux qui ont vraiment échoué. La pastille rouge de l'onglet ne compte que les seconds. "
    ),
    (
        "Chaque projet compose se monte et se démonte depuis l'outil. "
    ),
    (
        "Les containers lancés hors compose ont leur propre onglet. Reconstituer la commande retrouve le docker run qui a servi à les créer — précieux pour un container démarré à la main il y a six mois. "
    ),
    (
        "Les logs se lisent container par container, avec une recherche par mot-clé. "
    ),
    (
        "Et l'onglet Actions applique recréation, build, redémarrage ou arrêt à une sélection de services, avec le même aperçu préalable qu'ailleurs. "
    ),
    (
        "L'onglet Jenkins montre les jobs et sait les lancer, sans quitter l'outil. Rien n'est sondé en continu : l'écran demande, on demande à Jenkins. "
    ),
    (
        "Chaque ligne répond à quatre questions : quel job, dans quel état, quand pour la dernière fois, et lancé par qui, sur quelle branche. Le tri se fait par dernier lancement. "
    ),
    (
        "Avec quels paramètres, aussi. Un paramètre qui revient d'un job à l'autre porte une couleur tirée de son nom : l'œil descend la colonne sans lire. "
    ),
    (
        "Les dossiers se cochent en tête de liste, et ceux qu'on n'utilise jamais se rangent hors de la barre. "
    ),
    (
        "On filtre sur la valeur d'un paramètre : qu'est-ce qui est parti en prod ? Le champ suggère les valeurs qu'il a vues, sans y enfermer — une valeur plus ancienne se tape à la main. "
    ),
    (
        "La fiche d'un job tient en trois blocs. D'abord les paramètres de lancement : les valeurs proposées sont celles du job, ce sont elles qui partiront si tu n'y touches pas. "
    ),
    (
        "Ensuite l'historique, avec sous chaque ligne les paramètres de ce lancement-là — deux exécutions vertes du même après-midi ne se distinguent que par là. "
    ),
    (
        "Et à droite le détail de celle qu'on choisit : quand, combien de temps, par qui, sur quelle branche. Il suit la descente pendant qu'on parcourt l'historique. "
    ),
    (
        "Reprendre remplit le formulaire avec les valeurs de cette exécution, sans rien lancer : on repart de ce qui a marché en changeant une valeur. Relancer, juste à côté, part tout de suite — avec confirmation, et la confirmation montre les valeurs. "
    ),
    (
        "Le menu porte le nombre de jobs qui ont tourné aujourd'hui, et les échecs du jour en rouge. Un lancement suivi depuis l'outil est surveillé jusqu'à sa fin : la notification arrive quand le build se termine, sans avoir à revenir regarder. "
    ),
    (
        "L'onglet Jira récupère automatiquement les tickets qui te sont affectés. "
    ),
    (
        "On filtre par ticket ou par personne, et on lit la description, les commentaires et les pièces jointes sans quitter l'outil. "
    ),
    (
        "Sous le ticket, ce que Mergerie sait de lui : les merge requests qui le citent, leur état, et les sessions de développement qu'il a déclenchées. "
    ),
    (
        "Le statut se change depuis ici, et Faire coder l'IA ouvre une session de développement déjà remplie avec le contenu du ticket. "
    ),
    (
        "Les tickets surveillés sont ceux dont on veut voir le statut changer sans aller le regarder : l'outil les relit régulièrement, et le brief du matin le dit. "
    ),
    (
        "Restent les réglages, répartis en onze onglets. "
    ),
    (
        "Le général tient le thème — clair, sombre, ou suivant le système —, la langue, française ou anglaise, et la densité d'affichage. "
    ),
    (
        "Les dépôts s'ajoutent en masse depuis un groupe GitLab ou une organisation GitHub. Chaque dépôt garde son propre pattern de branches, et se désactive sans se supprimer. "
    ),
    (
        "Les règles de review spécifiques ajoutent des consignes ciblées : sur un ticket, sur un chemin de fichiers, sur un projet. Une règle sur les migrations ne s'applique qu'aux migrations. "
    ),
    (
        "Un vérificateur se duplique : le formulaire s'ouvre pré-rempli et enregistrer crée une copie, au lieu d'écraser l'original. "
    ),
    (
        "Coché, il part tout seul sur toute nouvelle merge request des dépôts qu'il couvre. Cinq vérifications au maximum par tour de découverte : au-delà, les merge requests gardent leur bouton, et le journal dit ce qui n'est pas parti. "
    ),
    (
        "Un vérificateur se déclare ici : on le nomme, et on lui donne la liste des commandes à jouer. Il n'y a rien d'autre à savoir — pas de script à écrire, pas de format à respecter. "
    ),
    (
        "Les commandes s'ordonnent : installer avant de tester. Elles tournent sans shell, dans le dépôt préparé. Mergerie retrouve le nom des tests cassés dans un rapport JUnit si vous en déclarez un, sinon dans le TAP que beaucoup d'outils émettent déjà, et sinon il nomme la commande plutôt que d'inventer un nombre de tests. "
    ),
    (
        "Reste à dire quels dépôts ce vérificateur sait tester, et où. Dans une copie jetable créée pour l'occasion, ou dans votre propre répertoire de travail — auquel cas Mergerie demande votre accord, refuse net si vous avez des modifications en cours, et vous remet toujours sur la branche où il vous avait trouvé. "
    ),
    (
        "Les consignes permanentes s'ajoutent au prompt de toutes les sessions de codage, dans un dépôt comme hors dépôt, au premier lancement comme à chaque suivi. C'est ce qu'on redit à chaque fois : la langue des commentaires, une commande à lancer avant de committer. "
    ),
    (
        "Un onglet dédié aux sessions d'IA règle l'agent utilisé, son binaire, ses délais et ses limites. "
    ),
    (
        "L'onglet Git porte l'URL de la forge, le jeton d'accès et le répertoire de clonage, avec un bouton qui teste la connexion avant d'aller plus loin. "
    ),
    (
        "Et les notifications préviennent quand un job se termine, avec un seuil de note en dessous duquel on veut être averti. La surveillance de fond en ajoute : un build Jenkins terminé, un conteneur qui tombe, une restauration en échec, un plafond automatique atteint. "
    ),
    (
        "En bas de l'écran, une barre suit les jobs en direct : ce qui tourne, les tokens consommés, et un journal qui se déplie. Ce journal contient une vue Activité, qui liste ce qui a été lancé et ce qui s'est terminé, avec un lien qui ramène directement sur l'objet concerné. "
    ),
    (
        "Contrôle K ouvre la palette globale : elle cherche partout à la fois, les liens de travail, les merge requests, les tickets, les pages de notes et les todos, et remonte d'abord ce qu'on ouvre souvent et récemment. "
    ),
    (
        "La touche point d'interrogation affiche tous les raccourcis clavier. "
    ),
    (
        "Et tout ce qu'on vient de voir existe aussi en thème clair. L'IA prépare, c'est toi qui merges. "
    ),
]
