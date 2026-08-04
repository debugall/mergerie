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
        'Voici Mergerie, un cockpit de développement local assisté par IA. Sept onglets en haut : les reviews de merge requests, les sessions de développement, les statistiques, git, Docker, Jira et les réglages. Les pastilles signalent le travail en attente, jamais des totaux décoratifs. '
    ),
    (
        "On commence par les merge requests à traiter. Chaque carte donne l'essentiel : le numéro, le titre, le projet, l'auteur et la date, puis les branches concernées et les liens vers le ticket et vers la forge. "
    ),
    (
        "Une barre de recherche filtre sur le titre, l'auteur, le projet ou le ticket. On la retrouve partout dans l'outil : sur un dépôt actif, les listes deviennent vite longues. "
    ),
    (
        "Le bouton Reviewer lance l'analyse par l'IA sur cette merge request. La petite flèche à côté ouvre deux variantes : review seule, ou review accompagnée d'une explication pédagogique du changement. "
    ),
    (
        'Avant de dépenser un appel, Voir le diff permet de lire le code. '
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
        'Chercher les nouvelles MR interroge GitLab et GitHub et ramène ce qui est apparu depuis la dernière fois. '
    ),
    (
        "Sur chaque carte, Classer sans review sort une merge request triviale de la file, Merger la fusionne directement, et Faire coder l'IA ouvre une session de développement à partir de cette merge request. "
    ),
    (
        'Passons aux merge requests déjà reviewées. '
    ),
    (
        "Quand on revient dans l'outil, le panneau de droite résume ce qui a bougé depuis la dernière visite, et propose les rapports à regarder en priorité. "
    ),
    (
        'La liste de gauche montre la note attribuée à chacune, de zéro à dix, et signale les rapports devenus périmés parce que la branche a bougé depuis. On en ouvre un. '
    ),
    (
        'Le rapport suit toujours la même structure : un résumé, les points relevés avec leur emplacement précis dans le code et leur gravité, ce qui est bien, et une note globale. '
    ),
    (
        "Le second onglet contient l'explication pédagogique : ce que fait la merge request et pourquoi, pour prendre en main un changement qu'on n'a pas écrit. Le bouton Copier récupère tout le rapport en Markdown. "
    ),
    (
        "Au-dessus, Ouvrir le code lance l'éditeur sur le dépôt local, positionné sur la bonne branche. Contexte rouvre le dossier de contexte de cette merge request, pour le compléter avant une nouvelle passe. "
    ),
    (
        "Relancer la review refait tout. Relancer delta ne fait relire que ce qui a changé depuis la dernière passe : c'est beaucoup moins cher, et c'est ce qu'on veut la plupart du temps. "
    ),
    (
        'Marquer traitée range la merge request sans la fusionner, Merger la fusionne, et Supprimer le rapport repart de zéro. '
    ),
    (
        "Plus bas, on peut demander une modification du rapport en langage naturel : creuse ce point, reformule plus court. L'IA régénère le rapport avec cette consigne. "
    ),
    (
        "Encore en dessous, les commentaires de la merge request sont repris depuis la forge. On lit les échanges, on répond, et la réponse est postée sur GitLab ou GitHub sans quitter l'outil. "
    ),
    (
        "Faire corriger le code par l'IA ouvre une session de développement sur la branche de la merge request, avec les points du rapport comme consigne. "
    ),
    (
        'Et Converger lance la boucle autonome. '
    ),
    (
        "L'IA corrige, commite, pousse, se relit, et recommence jusqu'au seuil de note ou au plafond de passes. L'avertissement est explicite : chaque passe pousse un commit sur la branche partagée, mais jamais de fusion. C'est toi qui relis et qui merges à la fin. "
    ),
    (
        'Le troisième segment, Traitées, garde la trace de ce qui est terminé. '
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
        'Une confirmation annonce ce qui va tourner : quel vérificateur, quelles commandes, dans quel dépôt et avec quel délai. Lancer des commandes sur sa machine mérite un écran, pas un clic silencieux. '
    ),
    (
        "Et pour les changements qui ne valent qu'ensemble, on coche plusieurs merge requests de dépôts différents et on les vérifie en une fois : le verdict vaut alors pour toutes. "
    ),
    (
        "Passons à l'onglet Dev IA, celui où c'est l'IA qui écrit le code. "
    ),
    (
        "Trois familles de sessions : le codage sur des dépôts git, le codage hors dépôt sur un simple dossier de la machine, et l'exploration, qui répond à une question sur le code sans rien modifier. "
    ),
    (
        'On crée une session de codage. '
    ),
    (
        'On choisit un ou plusieurs dépôts — avec recherche, forcément — la branche à créer ou à réutiliser, et la branche de départ. '
    ),
    (
        "Puis on décrit la tâche en langage naturel. On peut joindre une capture d'écran, et fixer le message de commit. "
    ),
    (
        "Deux options changent le comportement : l'auto-push, qui pousse la branche dès que le travail est fini, et l'autorisation donnée à l'IA de poser des questions quand elle hésite. En dessous, un champ permet de reprendre une session d'agent existante plutôt que d'en ouvrir une neuve. "
    ),
    (
        "Enregistrer prépare la session, Converger l'enchaîne directement avec la boucle de review. "
    ),
    (
        "Voici une session qui porte sur quatre dépôts à la fois. Chaque projet affiche son état, sa branche et sa progression. Un projet en échec n'interrompt jamais les autres — son erreur reste sur sa ligne. "
    ),
    (
        "Une session à plusieurs projets affiche sa liste repliée : au-delà de quelques dépôts, une seule session prendrait tout l'écran et masquerait les autres. Un clic la déplie, et le choix est mémorisé. "
    ),
    (
        'Chaque projet a ses propres actions : le relancer seul, sans rejouer les neuf autres, et pousser sa branche. '
    ),
    (
        'Et créer sa merge request. Dès que plusieurs projets sont prêts, deux boutons groupés apparaissent : pousser pour tous, et créer toutes les merge requests. '
    ),
    (
        "À droite, les actions de la session entière. Relancer les projets en échec ne rejoue que ce qui n'est pas passé. "
    ),
    (
        "Vérifier l'état des branches sert quand une session s'est arrêtée en erreur alors que le travail était déjà commité : l'outil relit les dépôts, reconnaît ce qui est fait, et rend les boutons de push et de merge request. Sans dépenser un seul appel IA. "
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
        'Le codage hors dépôt fait la même chose sur un simple dossier, sans git, sans branche et sans merge request. Pratique pour un script isolé ou un dossier de notes. '
    ),
    (
        "L'exploration, elle, ne modifie rien : on pose une question sur le code, on lit la réponse, on enchaîne avec une question de suivi. C'est le mode à utiliser pour comprendre avant de toucher. "
    ),
    (
        "Ces regroupements se nomment et se conservent : un lot se re-vérifie ensuite d'un seul bouton. "
    ),
    (
        "L'onglet Statistiques répond à une question simple : est-ce que la qualité monte ? "
    ),
    (
        "La distribution des notes et la moyenne par semaine montrent la tendance. En haut, l'activité récente de la forge, projet par projet. "
    ),
    (
        'Le tableau par projet classe les pires notes en premier, avec le taux de résolution : combien de constats ont réellement été corrigés. '
    ),
    (
        "Et le coût en tokens est affiché comme un minorant assumé : le travail interne de l'agent n'est pas comptabilisé, l'outil le dit plutôt que de faire semblant. "
    ),
    (
        "L'onglet Git applique la même opération à plusieurs dépôts en même temps. "
    ),
    (
        'Six outils. Le premier crée ou supprime des branches et des tags sur une sélection de dépôts. '
    ),
    (
        'Les dépôts se filtrent par recherche, et les branches aussi — un dépôt actif en compte des centaines, une liste brute serait inutilisable. '
    ),
    (
        "Rien ne s'exécute sans un aperçu ligne par ligne : on voit exactement ce qui va être fait, dépôt par dépôt, avant de confirmer. "
    ),
    (
        "La navigation positionne les dépôts locaux sur une branche donnée, en une fois, à partir d'un répertoire qui contient tous les clones. "
    ),
    (
        'Les commandes git lancent la même commande partout — une palette de commandes courantes est fournie, et on peut écrire la sienne. '
    ),
    (
        "L'explorateur de branches compare l'état des branches entre les dépôts : ce qui est en avance, en retard, ou absent. "
    ),
    (
        'Trouver une ref cherche un tag ou une branche dans tous les dépôts actifs et dit lesquels le possèdent. '
    ),
    (
        "Enfin, l'historique garde la trace de chaque opération, et chaque suppression de branche ou de tag reste restaurable. "
    ),
    (
        "L'onglet Docker montre l'état réel des projets compose. "
    ),
    (
        'Chaque service affiche son état, et surtout le drift de configuration : ce que le compose demande, comparé à ce qui tourne vraiment, variable par variable. Ici, la taille du pool est passée de dix à vingt-cinq. Les valeurs sensibles, elles, sont masquées. '
    ),
    (
        "La recherche et le filtre d'état séparent nettement les containers en cours, ceux qui se sont arrêtés proprement, et ceux qui ont vraiment échoué. La pastille rouge de l'onglet ne compte que les seconds. "
    ),
    (
        "Chaque projet compose se monte et se démonte depuis l'outil. "
    ),
    (
        'Les containers lancés hors compose ont leur propre onglet. Reconstituer la commande retrouve le docker run qui a servi à les créer — précieux pour un container démarré à la main il y a six mois. '
    ),
    (
        'Les logs se lisent container par container, avec une recherche par mot-clé. '
    ),
    (
        "Et l'onglet Actions applique recréation, build, redémarrage ou arrêt à une sélection de services, avec le même aperçu préalable qu'ailleurs. "
    ),
    (
        "L'onglet Jira récupère automatiquement les tickets qui te sont affectés. "
    ),
    (
        "On filtre par ticket ou par personne, et on lit la description, les commentaires et les pièces jointes sans quitter l'outil. "
    ),
    (
        "Le statut se change depuis ici, et Faire coder l'IA ouvre une session de développement déjà remplie avec le contenu du ticket. "
    ),
    (
        'Restent les réglages, répartis en huit onglets. '
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
        "Un vérificateur se déclare ici, en deux familles. Une liste de commandes, rejouée dans chaque dépôt visé, sans rien écrire. Ou votre propre script, qui reçoit tous les dépôts d'un coup et rend un verdict au format attendu. "
    ),
    (
        "Les commandes s'ordonnent : installer avant de tester. Elles tournent sans shell, dans le dépôt préparé. Mergerie retrouve le nom des tests cassés dans un rapport JUnit si vous en déclarez un, sinon dans le TAP que beaucoup d'outils émettent déjà, et sinon il nomme la commande plutôt que d'inventer un nombre de tests. "
    ),
    (
        "Reste à dire quels dépôts ce vérificateur sait tester, et où. Dans une copie jetable créée pour l'occasion, ou dans votre propre répertoire de travail — auquel cas Mergerie demande votre accord, refuse net si vous avez des modifications en cours, et vous remet toujours sur la branche où il vous avait trouvé. "
    ),
    (
        "Un onglet dédié aux sessions d'IA règle l'agent utilisé, son binaire, ses délais et ses limites. "
    ),
    (
        "L'onglet Git porte l'URL de la forge, le jeton d'accès et le répertoire de clonage, avec un bouton qui teste la connexion avant d'aller plus loin. "
    ),
    (
        'Et les notifications préviennent quand un job se termine, avec un seuil de note en dessous duquel on veut être alerté. '
    ),
    (
        "En bas de l'écran, une barre suit les jobs en direct : ce qui tourne, les tokens consommés, et un journal qui se déplie. Ce journal contient une vue Activité, qui liste ce qui a été lancé et ce qui s'est terminé, avec un lien qui ramène directement sur l'objet concerné. "
    ),
    (
        'Contrôle K ouvre une palette de commandes : on tape un fragment et on saute à un onglet, une merge request ou une session. '
    ),
    (
        "La touche point d'interrogation affiche tous les raccourcis clavier. "
    ),
    (
        "Et tout ce qu'on vient de voir existe aussi en thème sombre. L'IA prépare, c'est toi qui merges. "
    ),
]
