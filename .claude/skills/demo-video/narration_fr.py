# -*- coding: utf-8 -*-
"""Narration de la visite guidée — français.

Une entrée par étape, dans l'ordre du parcours de `parcours.mjs` : la Nième chaîne est lue
pendant la Nième étape. AJOUTER UNE ÉTAPE ICI SANS EN AJOUTER UNE DANS `parcours.mjs`
(ou l'inverse) décale tout ce qui suit — les deux fichiers se comptent, et le script
s'arrête net si le compte ne tombe pas juste.

Écrite pour QUELQU'UN QUI DÉCOUVRE L'OUTIL : chaque écran commence par le problème qu'il règle,
puis montre le geste. Le texte accompagne le curseur — il décrit ce qui est à l'écran au moment
où il y arrive. Il est ensuite réécrit pour la voix par `prononciation.py` — écrire
l'orthographe correcte ici, jamais une graphie phonétique.
"""

NARRATION = [
    (
        "Tu connais la journée : des merge requests qui s'empilent, des tickets à faire avancer, cinq dépôts, et une IA qui sait coder mais qu'on n'ose pas laisser seule. Mergerie, c'est un cockpit local qui règle ça. L'IA relit, code, teste et prépare. Toi, tu décides, et tu merges. Tout tourne sur ta machine, avec l'agent que tu as déjà. Huit onglets à gauche ; les pastilles ne montrent que ce qui attend un geste. "
    ),
    (
        "On commence par ce qui arrive tous les jours : une merge request à relire. Chaque carte donne l'essentiel en un regard : le numéro, le titre, le projet, l'auteur, les branches, et les liens vers le ticket et vers GitLab ou GitHub. "
    ),
    (
        "Une recherche filtre sur le titre, l'auteur, le projet ou le ticket. Tu la retrouveras partout dans l'outil : sur un dépôt actif, les listes deviennent vite longues. "
    ),
    (
        "La file se range comme tu veux : les petites d'abord, les plus anciennes, la note la plus basse, les bloquantes en tête. Et quand l'ordre n'est pas l'habituel, le contrôle le dit, pour que tu saches toujours selon quoi tu lis. "
    ),
    (
        "Reviewer, c'est le geste clé. L'IA lit le diff, le compare aux règles de ton équipe, et rend un rapport noté. La petite flèche propose deux variantes : la review seule, ou la review avec une explication pédagogique du changement. "
    ),
    (
        "Avant de dépenser un appel, tu peux lire le code toi-même. "
    ),
    (
        "Le diff s'ouvre dans l'outil, fichier par fichier. Tu juges seul si cette merge request mérite une review complète, ou si un coup d'œil suffit. "
    ),
    (
        "Contexte, c'est ce qui rend la review vraiment pertinente : donner à l'IA ce qu'elle ne peut pas deviner. "
    ),
    (
        "Le texte du ticket, une spécification, une règle métier, une capture d'écran, les projets et les branches liés. Tout ça entre dans la consigne de review. Une IA qui connaît l'intention relit mieux qu'une IA qui devine. "
    ),
    (
        "Et quand la file est longue, un seul bouton reviewe tout. Les jobs s'enchaînent, trois en parallèle au maximum, et deux jobs qui toucheraient le même dépôt sont refusés plutôt que de se marcher dessus. "
    ),
    (
        "Chercher les nouvelles MR interroge tes forges et ramène ce qui est apparu depuis la dernière fois. "
    ),
    (
        "Le menu de la carte porte le reste : classer sans review une merge request triviale, la merger directement, ou faire coder l'IA à partir d'elle. "
    ),
    (
        "Et là, un détail qui change tout : quand un agent a cartographié un sujet, les merge requests qui touchent ses fichiers portent sa carte. Tu sais sur quel terrain tu entres avant même d'ouvrir le diff. "
    ),
    (
        "Passons aux merge requests déjà reviewées. "
    ),
    (
        "Quand tu reviens dans l'outil, le panneau de droite résume ce qui a bougé depuis ta dernière visite, et te dit quels rapports regarder en priorité. "
    ),
    (
        "À gauche, chaque rapport porte sa note sur dix, et un marqueur si la branche a bougé depuis : un rapport périmé ne se lit pas comme un rapport à jour. On en ouvre un. "
    ),
    (
        "Le rapport suit toujours la même structure : un résumé, les points relevés avec le fichier, la ligne et la gravité, ce qui est bien, et une note globale. En trente secondes, tu sais si tu peux merger. "
    ),
    (
        "Chaque constat porte un fichier et une ligne. Mettre en brouillons les transforme d'un geste en remarques posées sur le diff, prêtes à relire. Rien n'est encore parti sur la forge. "
    ),
    (
        "Et ce qui ne peut pas se poser est dit : un constat sur une ligne que la branche n'a pas touchée n'a pas d'ancrage dans le diff. Ceux-là sont laissés de côté, et comptés. L'outil ne triche jamais sur ce qu'il a fait. "
    ),
    (
        "Le second onglet, c'est l'explication pédagogique : ce que fait la merge request et pourquoi. Idéal pour prendre en main un changement qu'on n'a pas écrit. Copier récupère tout le rapport en Markdown. "
    ),
    (
        "Ouvrir le code lance ton éditeur sur le dépôt local, déjà positionné sur la bonne branche. Contexte rouvre le dossier de cette merge request, pour le compléter avant une nouvelle passe. "
    ),
    (
        "Relancer la review refait tout. Mais si la branche a bougé, la relance devient une relance delta : l'IA ne relit que ce qui a changé. Moins de tokens, et pas de remarques en double. "
    ),
    (
        "Marquer traitée range la merge request sans la fusionner. Merger la fusionne, avec confirmation. "
    ),
    (
        "Le menu porte les gestes plus rares : publier le rapport sur la merge request, ranger un constat dans les todos, supprimer le rapport. "
    ),
    (
        "Plus bas, tu peux demander une modification du rapport en langage naturel : creuse ce point, reformule plus court. L'IA le régénère avec cette consigne. "
    ),
    (
        "Juste en dessous, tu peux simplement poser une question : pourquoi ce point est-il bloquant ? Que se passerait-il si on ne le corrigeait pas ? "
    ),
    (
        "La réponse s'ajoute sous le rapport, et le rapport ne bouge pas : ni son texte, ni sa note. Demander une explication ne doit jamais coûter le rapport qu'on est en train de lire. "
    ),
    (
        "Et si une page de notes parle de cette merge request, elle est citée ici. Le lien marche dans les deux sens : la note mène à la merge request, la merge request retrouve la note. "
    ),
    (
        "Encore en dessous, les commentaires de la merge request, repris depuis la forge. Tu lis les échanges, tu réponds, et la réponse part sur GitLab ou GitHub sans quitter l'outil. "
    ),
    (
        "Faire corriger le code ouvre une session de développement sur la branche, avec les points du rapport comme consigne. L'IA corrige ce qu'elle a elle-même relevé. "
    ),
    (
        "Et Converger, c'est la boucle complète. "
    ),
    (
        "L'IA corrige, commite, pousse, se relit, et recommence jusqu'à atteindre la note visée ou le plafond de passes. Une merge request qui passe de cinq à huit toute seule, avec tout l'historique conservé. L'avertissement est clair : chaque passe pousse un commit, mais jamais de fusion. Le merge, c'est toi. "
    ),
    (
        "Le troisième segment, Traitées, garde la trace de ce qui est terminé. "
    ),
    (
        "Une review, c'est un avis. Ce badge, c'est un fait : vérifié, ou tant de tests cassés. Il vient d'un vérificateur, c'est-à-dire de tes propres tests, lancés pour de vrai sur les commits de la branche. "
    ),
    (
        "Le rapport dit sur quels commits le verdict porte, quels tests ont cassé, et le déroulé des commandes. Et Mergerie a aussi rejoué la suite sur la branche cible avant tes changements : un test déjà rouge avant n'est jamais imputé à la branche. "
    ),
    (
        "Quand l'échec vient bien de la branche, un bouton ouvre une session de correction, avec les tests cassés et les commits testés déjà dans le prompt. "
    ),
    (
        "Vérifier se lance depuis la liste, et aussi sur une merge request déjà reviewée : l'avis de l'IA et le fait des tests se complètent. "
    ),
    (
        "Une confirmation annonce ce qui va tourner : quel vérificateur, quelles commandes, dans quel dépôt, avec quel délai. Lancer des commandes sur ta machine mérite un écran, pas un clic silencieux. "
    ),
    (
        "Et pour des changements qui ne valent qu'ensemble, tu coches plusieurs merge requests de dépôts différents et tu les vérifies en une fois : le verdict vaut pour toutes. "
    ),
    (
        "Un vérificateur peut aussi partir tout seul dès qu'une merge request apparaît. Ce bouton montre le résultat de chacun de ceux qui ont tourné : le verdict, les commits testés, les tests cassés nommés un par un. "
    ),
    (
        "Et le déroulé des commandes, avec leur code de sortie. Tu ne sais pas seulement que c'est vert : tu sais ce qui a tourné. "
    ),
    (
        "Sur un diff, une remarque peut attendre. Ces commentaires restent en local, relisables et modifiables. Rien n'est encore parti. "
    ),
    (
        "Quand la relecture est finie, un seul bouton les envoie tous. L'auteur reçoit une notification au lieu de dix, et une remarque qu'on aurait retirée trois fichiers plus loin ne part jamais. "
    ),
    (
        "Et si le lot ne va plus, Tout supprimer le vide d'un coup. La confirmation dit combien de remarques partent, et lesquelles. "
    ),
    (
        "Passons à l'onglet Dev IA. Ici, c'est l'IA qui écrit le code, et c'est là que Mergerie change vraiment la journée. "
    ),
    (
        "Quatre familles de sessions : le codage sur des dépôts git, le codage hors dépôt sur un simple dossier, l'exploration qui lit le code sans rien modifier, et la question libre, sans dépôt du tout. "
    ),
    (
        "On crée une session de codage. "
    ),
    (
        "Tu choisis un ou plusieurs dépôts, avec recherche, la branche à créer ou à réutiliser, et la branche de départ. Plusieurs dépôts, c'est le cas qui fait mal à la main : ici, c'est une seule session. "
    ),
    (
        "Puis tu décris la tâche en langage naturel, comme à un collègue. Tu peux joindre une capture d'écran, et fixer le message de commit. "
    ),
    (
        "Deux options changent le comportement : l'auto-push, qui pousse la branche dès que le travail est fini, et l'autorisation donnée à l'IA de poser des questions quand elle hésite, plutôt que de deviner. "
    ),
    (
        "Une session peut aussi emprunter le profil d'un agent : son rôle, son périmètre de dépôts, ses outils et ses skills, sans rien ressaisir. "
    ),
    (
        "Et voici le choix qui fait économiser : le binaire. Tu déclares plusieurs agents dans les réglages, par exemple ton Claude habituel et un modèle local qui tourne sur ta machine. Pour une tâche simple, tu choisis le modèle local : zéro token dépensé. "
    ),
    (
        "Planifier d'abord, c'est la sécurité avant de coder : la première passe ne touche à rien, l'IA lit le dépôt et propose un plan. Tu le relis, tu le fais corriger, et elle ne code qu'une fois que tu as approuvé. "
    ),
    (
        "En bas, le bouton principal crée la session et la lance. Une case enchaîne directement avec la convergence, et le bouton d'à côté crée la session sans l'exécuter, pour la lancer quand tu veux. "
    ),
    (
        "Une fenêtre en cours de saisie se met de côté : le tiret la range dans le menu, avec ce que tu avais écrit. "
    ),
    (
        "Un clic la reprend : les champs remplis, le curseur là où tu l'avais laissé. "
    ),
    (
        "Voici une session qui porte sur quatre dépôts à la fois. Chaque projet affiche son état, sa branche et sa progression. Un projet en échec n'interrompt jamais les autres : son erreur reste sur sa ligne. "
    ),
    (
        "Une session à plusieurs projets s'affiche repliée : au-delà de quelques dépôts, une seule session prendrait tout l'écran. Un clic la déplie, et le choix est mémorisé. "
    ),
    (
        "Chaque projet a ses propres actions : le relancer seul, sans rejouer les autres. "
    ),
    (
        "Lui envoyer un suivi, reviewer sa merge request, ou la merger. Et quand plusieurs projets sont prêts en même temps, des boutons groupés font le geste pour tous : pousser tout, créer toutes les merge requests. "
    ),
    (
        "À droite, les actions de la session entière : la relancer, l'enchaîner avec la convergence, et, si certains projets ont échoué, ne rejouer que ceux-là. "
    ),
    (
        "Une session se duplique : le formulaire s'ouvre pré-rempli, et enregistrer crée une nouvelle session au lieu d'écraser l'ancienne. "
    ),
    (
        "Une session garde toutes ses itérations : le lancement, puis chaque suivi, avec la demande qui l'a produit. Tu retrouves toujours pourquoi l'IA a fait ce qu'elle a fait. "
    ),
    (
        "Et chaque itération porte son propre diff. Au troisième suivi, les trois lignes que tu viens de demander se cherchaient au milieu de deux cents : ce bouton ne montre que ce que cette passe-là a changé. "
    ),
    (
        "Cette session-ci a tourné sur le modèle local : le badge le dit. Le choix tient pour toute la session, suivis compris. "
    ),
    (
        "Et voici une session en mode plan. L'IA a lu le dépôt et rendu son plan. Elle n'a encore rien codé, et la ligne attend ton accord. "
    ),
    (
        "Lire le plan l'ouvre. Et à la place d'un suivi, tu as un champ de retours : garde l'API telle quelle, pas de migration. Régénérer renvoie tes retours à la même session, qui réécrit le plan complet, toujours sans coder. Autant de tours que nécessaire. "
    ),
    (
        "Et quand tout est bon, Approuver et coder : la même session reprend, réalise le plan, et commite. Tu as validé le quoi avant de laisser faire le comment. "
    ),
    (
        "Voici l'autre cas : l'IA a préféré demander. Elle pose ses questions avec les options qu'elle voit dans le dépôt, et attend. "
    ),
    (
        "Tu réponds, et la session reprend exactement là où elle s'était arrêtée. "
    ),
    (
        "Reprendre au terminal rouvre la même session d'agent dans un vrai terminal, avec tout son historique. Quand c'est plus rapide à la main, tu continues à la main. "
    ),
    (
        "Le codage hors dépôt fait la même chose sur un simple dossier, sans git, sans branche et sans merge request. Un script isolé, un dossier de notes. "
    ),
    (
        "L'exploration ne modifie rien : tu poses une question sur le code, tu lis la réponse, tu enchaînes avec une question de suivi. C'est le mode pour comprendre avant de toucher. "
    ),
    (
        "La question libre, elle, ne touche à aucun dépôt : une question à l'IA, la réponse gardée, et ses itérations. "
    ),
    (
        "Ces regroupements se nomment et se conservent : un lot se re-vérifie ensuite d'un seul bouton. "
    ),
    (
        "L'onglet Agents. Un agent, c'est un profil de session réutilisable : un rôle, un périmètre de dépôts, des outils, des skills, une sortie, et parfois un horaire. "
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
        "Un agent de domaine, lui, garde une connaissance : la carte de son sujet, versionnée. Où vit ce code, par quel mécanisme, comment on le teste. "
    ),
    (
        "Et cette carte vieillit. L'outil compte les commits qui ont touché ses chemins depuis la dernière cartographie, et signale ceux qui n'existent plus. Une documentation qui sait qu'elle est périmée. "
    ),
    (
        "Mettre à jour relance la cartographie sur ce qui a bougé, plutôt que de tout refaire. "
    ),
    (
        "Une nouvelle version ne s'impose pas : elle attend d'être relue et validée. Une connaissance fausse coûte plus cher qu'une connaissance vide. "
    ),
    (
        "Le second sous-onglet liste ce que le disque offre : les skills et les sous-agents trouvés dans les dépôts clonés et dans ton home. En lecture seule, c'est le disque qui décide. "
    ),
    (
        "L'onglet Notes est celui sur lequel l'outil s'ouvre : le premier écran de la journée. "
    ),
    (
        "Le brief du matin rassemble ce qui appelle un geste : les merge requests dormantes, les vérifications rouges, les sessions qui attendent une réponse. Tu ne cherches plus, c'est rassemblé. Chaque ligne est cliquable, et se range d'une croix. "
    ),
    (
        "Il compte aussi les sessions de développement en attente : jamais lancées, non poussées, sans merge request. Le travail est fait, il ne manque qu'un clic. "
    ),
    (
        "Et ce que les agents ont fait tout seuls, avec ce qu'ils ont produit. "
    ),
    (
        "Copier pour le daily en fait un texte prêt à coller dans la réunion du matin. "
    ),
    (
        "Les todos se trient par priorité, puis dans l'ordre que tu leur donnes. Elles se cochent sur place. "
    ),
    (
        "Celle-ci a été posée par l'outil : une session s'est arrêtée pour poser une question. La notification est fermée depuis longtemps ; la todo, elle, reste sous les yeux. Répondre la referme. "
    ),
    (
        "Une todo se repousse d'une heure ou à demain matin, et garde le lien vers ce qui l'a fait naître : une merge request, un ticket. "
    ),
    (
        "Les pages sont des notes libres en Markdown, cherchables. "
    ),
    (
        "Une clé de ticket ou un numéro de merge request écrit dans le texte devient un lien vers l'écran correspondant, sans rien coller. "
    ),
    (
        "L'onglet Statistiques répond à une seule question : est-ce que la qualité monte ? "
    ),
    (
        "La distribution des notes et la moyenne par semaine montrent la tendance. En haut, l'activité récente de la forge, projet par projet. "
    ),
    (
        "Le tableau par projet classe les pires notes en premier, avec le taux de résolution : combien de constats ont réellement été corrigés. "
    ),
    (
        "Le coût en tokens est affiché comme un minorant assumé : le travail interne de l'agent n'est pas compté, et l'outil le dit plutôt que de faire semblant. "
    ),
    (
        "Les opérations git sont comptées aussi, avec leur taux d'échec, et les constats qui reviennent d'une review à l'autre sont regroupés : c'est là qu'on voit ce qui mérite une règle plutôt qu'une remarque de plus. "
    ),
    (
        "L'onglet Git applique la même opération à plusieurs dépôts en même temps. Ce qu'on faisait dépôt par dépôt, en terminal, on le fait ici en une fois. "
    ),
    (
        "Huit outils. Le premier crée ou supprime des branches et des tags sur une sélection de dépôts. "
    ),
    (
        "Les dépôts se filtrent par recherche, et les branches aussi : un dépôt actif en compte des centaines. "
    ),
    (
        "Rien ne s'exécute sans un aperçu ligne par ligne : tu vois exactement ce qui va être fait, dépôt par dépôt, avant de confirmer. "
    ),
    (
        "Le deuxième fusionne une branche dans une autre, et quand il y a conflit, il se résout ici, fichier par fichier, sans quitter l'outil. "
    ),
    (
        "La navigation positionne tous les dépôts locaux sur une branche donnée, en une fois. "
    ),
    (
        "Les commandes git lancent la même commande partout : une palette de commandes courantes est fournie, et tu peux écrire la tienne. "
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
        "Et l'historique garde la trace de chaque opération : chaque suppression de branche ou de tag reste restaurable. "
    ),
    (
        "L'onglet Jira récupère automatiquement les tickets qui te sont affectés. "
    ),
    (
        "On filtre par ticket ou par personne, et on lit la description, les commentaires et les pièces jointes sans quitter l'outil. "
    ),
    (
        "Sous le ticket, ce que Mergerie sait de lui : les merge requests qui le citent, leur état, et les sessions de développement qu'il a déclenchées. Du ticket au code, tout est relié. "
    ),
    (
        "Le statut se change depuis ici, et Faire coder l'IA ouvre une session déjà remplie avec le contenu du ticket. Un ticket, un clic, une branche qui avance. "
    ),
    (
        "Les tickets surveillés sont ceux dont tu veux voir le statut changer sans aller regarder : l'outil les relit régulièrement, et le brief du matin le dit. "
    ),
    (
        "Restent les réglages, en onze onglets. "
    ),
    (
        "Le général tient le thème, clair, sombre ou suivant le système, la langue, française ou anglaise, et la densité d'affichage. "
    ),
    (
        "Les dépôts s'ajoutent en masse depuis un groupe GitLab ou une organisation GitHub. Chaque dépôt garde son propre motif de branches, et se désactive sans se supprimer. "
    ),
    (
        "Les règles de review ciblées ajoutent des consignes sur un ticket, un chemin de fichiers, un projet. Une règle sur les migrations ne s'applique qu'aux migrations. "
    ),
    (
        "Un vérificateur se duplique : le formulaire s'ouvre pré-rempli et enregistrer crée une copie. "
    ),
    (
        "Coché, il part tout seul sur toute nouvelle merge request des dépôts qu'il couvre, avec un plafond par tour de découverte. "
    ),
    (
        "Un vérificateur se déclare ici : un nom, et la liste des commandes à jouer. Pas de script à écrire, pas de format à respecter. "
    ),
    (
        "Les commandes s'ordonnent : installer avant de tester. Mergerie retrouve le nom des tests cassés dans un rapport JUnit ou dans le TAP que beaucoup d'outils émettent déjà. "
    ),
    (
        "Reste à dire quels dépôts ce vérificateur sait tester, et où : dans une copie jetable, ou dans ton propre répertoire de travail, avec ton accord, et toujours remis sur la branche où il t'avait trouvé. "
    ),
    (
        "Les consignes permanentes s'ajoutent au prompt de toutes les sessions de codage : la langue des commentaires, une commande à lancer avant de committer. "
    ),
    (
        "Et voici les binaires de l'agent. Le premier est le défaut. En dessous, autant d'autres que tu veux, chacun complet : binaire, arguments, variables d'environnement, backend. Ici, un Claude Code branché sur un modèle Ollama local. "
    ),
    (
        "Chacun se teste d'un bouton, et Utiliser par défaut échange les rôles. Reviews, résolutions de conflits, agents : tout ce qui n'a pas choisi passe par le défaut. Le reste, tu le décides session par session. "
    ),
    (
        "Le même onglet tient les bornes du jour, le mode sécurisé ou libre, et le test du sandbox. "
    ),
    (
        "L'onglet Git porte l'adresse de la forge, le jeton d'accès et le répertoire de clonage, avec un bouton qui teste la connexion. "
    ),
    (
        "Et les notifications préviennent quand un job se termine, avec un seuil de note en dessous duquel tu veux être alerté. "
    ),
    (
        "En bas de l'écran, une barre suit les jobs en direct : ce qui tourne, les tokens consommés, et un journal qui se déplie. Sa vue Activité liste ce qui a été lancé et ce qui s'est terminé, avec un lien vers l'objet concerné. "
    ),
    (
        "Contrôle K ouvre la palette : elle cherche partout à la fois, merge requests, tickets, notes, todos, et remonte d'abord ce que tu ouvres souvent. "
    ),
    (
        "La touche point d'interrogation affiche tous les raccourcis. "
    ),
    (
        "Et tout ce que tu viens de voir existe aussi en thème clair. Mergerie est open source, tourne sur ta machine, avec ton agent. L'IA prépare, c'est toi qui merges. "
    ),
]
