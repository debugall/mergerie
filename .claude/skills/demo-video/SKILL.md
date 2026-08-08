---
name: demo-video
description: "MANUEL UNIQUEMENT — ne jamais déclencher tout seul. Regénère les vidéos de démonstration narrées de Mergerie (demo-live-real-fr.mp4 / demo-live-real-en.mp4) : un vrai Chromium piloté par Playwright parcourt l'application, curseur visible, avec une narration synthétisée. À n'utiliser QUE si l'utilisateur invoque explicitement /demo-video ou demande en toutes lettres de regénérer la vidéo de démonstration."
---

# Regénérer les vidéos de démonstration

Deux vidéos, ~14 min chacune, 1920×1080 : `demo-live-real-fr.mp4` et `demo-live-real-en.mp4`,
à la racine du dépôt. Ce sont de **vraies captures** : Playwright pilote un Chromium sur
l'application, clique pour de bon, et enregistre la page. Rien n'est composé après coup.

Tout l'outillage est dans ce dossier. Les fichiers de travail vont dans `travail/`, ignoré par git.

## Quand ce skill sert

À chaque fois qu'une fonctionnalité arrive et doit entrer dans la démonstration. Le travail
consiste alors à **ajouter une étape**, pas à tout refaire — voir « Ajouter une étape ».

## Avant toute chose

- **Port 4319 = instance réelle de l'utilisateur.** Ne jamais la démarrer, l'arrêter ni la viser.
- La démo tourne sur **4321**, et doit être lancée exactement ainsi :
  ```bash
  MERGERIE_DEMO=1 MERGERIE_DATA_DIR=data-demo COPILOT_DRY_RUN=1 PORT=4321 node src/server.js
  ```
- **Ne jamais pousser.** Les `.mp4` ne sont pas versionnés.

## À ne pas confondre : il existe DEUX enregistreurs

| | ce skill | `scripts/record-demo.js` |
|---|---|---|
| durée | ~14 min | ~2 min 40 |
| voix | narration synthétisée | aucune, des légendes à l'écran |
| sortie | `demo-live-real-{fr,en}.mp4` | `demo-recordings/mergerie-demo-{fr,en}.webm` |
| sert à | la présentation longue | le GIF du README (`npm run demo:gif`) et YouTube |

Les deux sont **bilingues** et parcourent la même application, mais ne partagent aucun code. Une
fonctionnalité nouvelle doit entrer dans les deux — et les deux se lancent sur le port 4321.
Corriger un sélecteur ici ne corrige rien là-bas.

## L'APPLICATION A CHANGÉ — à intégrer au prochain enregistrement

Écrit après la fusion des onglets *Notes* et *Liens*. Tout ce qui suit a été **vérifié dans
l'application en marche**, pas déduit du code.

### Ce qui manque au parcours

Le parcours compte 87 étapes et **ne montre ni Notes ni Liens** : deux onglets entiers, soit la
part la plus visible de ce que l'outil sait faire aujourd'hui. C'est le premier travail à faire.

- **Notes** — `onglet('notes')` répond, `sous('notes', 0..2)` donne *Aujourd'hui · Todos · Pages*
  (la formule `#tab-notes > div > button` fonctionne, vérifié : 3 boutons). À montrer : le brief du
  matin (`#briefBox .brief-sec`), les todos (`#todoList .todo-row`, cochables sur place), une page
  et son autolink (`#pageList .note-item` puis `#pageEditor`).
- **Liens** — `onglet('links')` répond. À montrer : la grille (`.link-grid`), les liens libres, et la
  palette.

### La navigation est une colonne, plus un bandeau

- **`nav button` renvoie DIX éléments pour NEUF onglets.** Le dixième est `#sidebarToggle`, le
  bouton de repli, qui vit dans le `<nav>` sans porter de `data-tab`. Tout sélecteur `nav button`
  non filtré l'attrape. `onglet()` vise déjà `nav button[data-tab]` et survit ; un nouveau
  sélecteur écrit à la va-vite, non.
- `versEl('nav')` désigne maintenant une **colonne pleine hauteur** : le curseur atterrit au milieu
  à gauche, pas sur un bandeau. C'est utilisable, mais ne plus dire « en haut ».
- Le repli (`#sidebarToggle`) est en soi une **chose à montrer** : la colonne passe en icônes,
  se souvient du choix, et se replie seule sous 1100 px.

### L'application n'atterrit plus sur les reviews

Au chargement, l'onglet actif est **`tab-notes`** (le brief du matin), pas `tab-review`. Le parcours
clique `onglet('review')` juste après sa première étape, donc rien n'est cassé — mais la **première
image du film montre les Notes**, et la narration d'ouverture doit en tenir compte.

### La palette est devenue globale

`Contrôle K` **ou la touche `o`** ouvre `#paletteModal` ; on peut aussi cliquer `#paletteTrigger`,
le champ posé dans l'en-tête. `#paletteModal input` répond toujours. Elle ne cherche plus seulement
des onglets et des MR : cases de la grille, liens libres, merge requests, tickets surveillés, pages,
todos et actions de navigation — le tout **interrogé côté serveur et filtré en base**.

**La requête à taper pour la démontrer est `paiement`** : c'est le seul mot du jeu de démo qui
ressorte à la fois d'un lien libre, d'une merge request, d'un ticket surveillé et d'une todo. Taper
un mot qui ne rend que deux lignes de la même famille dément la phrase qu'on vient de prononcer.

### Deux phrases de narration ont été corrigées

`NARRATION[0]` annonçait « sept onglets en haut » et `NARRATION[84]` « une palette de commandes ».
Les deux sont réécrites, dans les deux langues. Les `.mp4` livrés, eux, disent encore l'ancienne
version : ils sont à refaire.

## Chaîne complète

```bash
cd .claude/skills/demo-video

# 1. narration → clips audio + table des durées  (~1 min)
python3 synthese.py                 # français
LANGUE=en python3 synthese.py       # anglais

# 2. vérifier que chaque sélecteur répond, sans tenir la pose  (~3,5 min)
RAPIDE=1 node parcours.mjs
LANGUE=en RAPIDE=1 node parcours.mjs

# 3. enregistrement réel  (~15 min chacun — lancer en tâche de fond)
node parcours.mjs
LANGUE=en node parcours.mjs

# 4. montage : la voix est recollée aux repères mesurés  (~2 min)
python3 montage.py
LANGUE=en python3 montage.py
```

**Ne jamais sauter l'étape 2.** Un sélecteur cassé se découvre en 3 minutes, ou au bout de
quinze si on lance directement l'enregistrement.

## Les quatre fichiers

| fichier | rôle |
|---|---|
| `narration_fr.py` / `narration_en.py` | le texte, une chaîne par étape |
| `prononciation.py` | réécriture du texte **prononcé** — voir plus bas, c'est le cœur |
| `parcours.mjs` | ce que fait le curseur, étape par étape (Playwright) |
| `montage.py` | assemble image + voix |
| `synthese.py` | fabrique les clips audio |

`narration_*.py` et `parcours.mjs` **se comptent** : la Nième chaîne est lue pendant la Nième
étape. `parcours.mjs` s'arrête net si le compte ne tombe pas juste.

## Prononciation — la partie qui demande le plus d'attention

Une synthèse vocale lit de **l'orthographe**, pas du sens. `prononciation.py` réécrit le texte
juste avant qu'il atteigne la voix ; le texte affiché, lui, n'est jamais touché.

**Deux règles de méthode :**

1. Quand un sigle a un équivalent parlé naturel, **dire le mot entier** (`MR` → « merge
   request ») plutôt que d'épeler : c'est ce qu'un humain dirait.
2. Sinon, **épeler en séparant les lettres** (`CLI` → « C L I »), ce que tout moteur lit bien.

**L'ordre des règles compte** : les entrées les plus longues d'abord, sinon `MR` mange `MRs`,
et `git` mange `GitLab`.

### Pièges vérifiés empiriquement (ne pas les redécouvrir)

| écrit | lu à tort | réécriture retenue | pourquoi |
|---|---|---|---|
| `MRs` | « misters » | `merge requests` | — |
| `IA` | « lida » dans « l'IA » | `intelligence artificielle` | **aucune** graphie ne se lit /i.a/ : `I A` insère une pause, `l'ia` donne « lya », `L'I A` fait épeler « L apostrophe ». Seul le mot entier marche. |
| `git` | « jite » | `guite` | le *g* doit être durci. À placer **après** `GitLab`/`GitHub`. |
| `idempotent` | « idempote » | `idempotant` | le « nt » final est muet ; `idempotente` est déjà correct |
| `lint` | « lainte » | `linnte` | nasalisation ; il faut **doubler le n** |
| `.env` | épelé | `point ènve` | — |
| `prompt` | « prom » | `prompte` | consonne finale muette |
| `?` seul | **silence total** | « la touche point d'interrogation » | la phrase perd son sujet sans qu'on l'entende |
| `/10` | silence | ` sur 10` | — |
| `plus` | « plu » | `plusse` | dans « Contrôle plus K » |

**Bascule en anglais** — le risque le plus sérieux : sur certains mots, espeak passe aux
phonèmes anglais, que le modèle français n'a jamais entendus. Concernés et déjà traités :
`token`, `web`, `shell`, `pull`, `release`, `Markdown`, `merge request`, `commit`, `push`,
`build`, `checkout`, `container`, `unhealthy`, `exited`, `reviewer`.

**À NE PAS réécrire** — vérifié, la lecture française par défaut est déjà celle des
développeurs, et certaines réécritures *dégradaient* le rendu (un *o* fermé au lieu d'ouvert) :
`Docker`, `tag`, `job`, `drift`, `log`, `compose`, `review`, `merge`, `pipelines`,
`changelog`, `pattern`, `diff`, `patch`, `fetch`, `ref`, `dev`, `app`, `repo`.

### Vocabulaire nouveau, à écouter avant de l'employer

Les onglets *Notes* et *Liens* apportent des mots que la table ci-dessus n'a jamais rencontrés. Ils
sont listés ici **sans réécriture proposée** : aucune n'a pu être écoutée (piper n'était pas
installé sur la machine où cette liste a été dressée), et le principe du fichier est qu'on ne
retient une réécriture qu'après l'avoir entendue.

- `todo` / `todos` — anglicisme court, candidat sérieux à la bascule en phonèmes anglais.
- `frécence` — mot inventé (fréquence + récence) : à peu près sûr d'être mal lu. Le contourner en
  disant « ce qu'on ouvre souvent et récemment » est sans doute plus simple que de le faire dire.
- `preprod`, `Kibana`, `Grafana`, `Confluence` — noms propres de la grille de liens.
- `brief`, `autolink`, `snooze`.
- **Une lettre seule est un piège connu** : `?` était lu comme un silence total. La palette s'ouvre
  aussi par la touche `o` — ne pas l'annoncer dans la narration sans avoir vérifié qu'un `o` isolé
  s'entend. La formule sûre existe déjà : « la touche point d'interrogation ».

### Comment vérifier une nouvelle réécriture

Écouter, ne pas supposer. Synthétiser la phrase seule et l'écouter avant de la garder :

```bash
python3 -c "import sys; sys.path.insert(0,'.'); from prononciation import dire; print(dire('ta phrase', 'fr'))"
```

Puis contrôler qu'espeak ne bascule pas en anglais sur les mots nouveaux.

## Ajouter une étape (le cas courant)

1. **Écrire la phrase** dans `narration_fr.py` ET `narration_en.py`, à la même position.
2. **Ajouter le geste** dans `parcours.mjs`, à la même position :
   ```js
   await versEl(page.locator('#tab-x button', { hasText: L.monLibelle })); await dit();
   ```
   `versEl` amène le curseur ; `clique` amène et clique ; `dit()` tient la pose le temps du clip.
3. **Le libellé passe par `L`**, jamais en dur : ajouter la clé dans `LABELS.fr` et `LABELS.en`
   en haut de `parcours.mjs`. Relever le libellé anglais **dans l'application**, ne pas le deviner.
4. Supprimer `travail/voix-*/` **des seuls clips renumérotés** (insérer au milieu décale tout :
   le plus simple est alors de supprimer les deux dossiers `voix-fr` / `voix-en`).
5. Rejouer la chaîne complète.

**Sélecteurs : préférer le structurel au texte.** `sous('git', 3)` (4ᵉ sous-onglet) survit à une
traduction, `hasText: 'Analyser'` non. Les ids (`#dcState`, `#notifThreshold`) sont les plus sûrs.

## Listes déroulantes natives

Une liste déroulante `<select>` est dessinée par le **système**, hors de la page. Playwright
n'enregistre que la page : ouverte, elle est **invisible dans le film**, et le clic semble
sans effet. `montreOptions(selecteur)` lui pose un `size` le temps de la montrer — ses vraies
options s'affichent alors *en page* — et `fermeOptions` la remet comme avant. Rien n'est
inventé : ce sont les options du vrai contrôle.

`scripts/record-demo.js` résout le même problème **autrement** : il dessine un double de la liste
dans la page (`__selOpen`), aux vraies dimensions et avec les vraies options lues sur l'élément.
Ce n'est pas un arbitrage technique, c'est un doublon : le second a été écrit sans savoir que le
premier existait. **L'astuce du `size` est la meilleure des deux** — elle montre le vrai contrôle,
pas une copie qui pourrait un jour mentir sur son contenu. Si l'un des deux doit être aligné sur
l'autre, c'est `record-demo.js` qui doit adopter le `size`.

## Voix

Modèles Piper, **hors dépôt** (~60 Mo pièce), à poser dans `travail/voix/` :

- `fr_FR-siwis-medium.onnx` (+ `.onnx.json`)
- `en_US-lessac-medium.onnx` (+ `.onnx.json`)

Ils viennent de [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). La voix
française a été choisie par l'utilisateur après écoute comparative de sept candidates — ne pas
en changer sans lui redemander. `pip install piper-tts` fournit le moteur.

`synthese.py` cherche tout seul l'interpréteur qui sait importer `piper` (souvent un
environnement virtuel, rarement celui qui lance le script). Pour le désigner :
`PIPER_PYTHON=/chemin/vers/python python3 synthese.py`.

## Ce qui casse le parcours quand l'application bouge

Trois pièges, tous rencontrés — le contrôle rapide (étape 2) n'en attrape qu'un :

- **Un sous-onglet inséré décale `sous(tab, n)`.** L'ancien index continue de fonctionner, il
  désigne simplement le mauvais panneau. Aucune erreur, un contresens à l'image.
- **Un libellé qui dépend de l'état.** `hasText: 'Replier les projets'` a cessé de répondre le
  jour où la liste s'est affichée repliée par défaut. Préférer une classe (`.targets-toggle`).
- **Un sélecteur trop large attrape un élément caché.** `#tab-admin select` a fini par viser le
  « Genre » d'un vérificateur, dans un panneau masqué placé plus tôt dans le DOM. Viser le
  sous-onglet par son id (`#sub-config select`).
- **Un bouton qui n'est pas un onglet dans le `<nav>`.** `#sidebarToggle` y vit désormais, sans
  `data-tab`. L'application elle-même s'y est fait prendre : son gestionnaire d'onglets écoutait
  `nav button`, si bien que replier la colonne désactivait tous les onglets et vidait l'écran.
  Corrigé côté application ; la leçon vaut pour tout sélecteur écrit ici.

Et un piège de l'application elle-même : **une modale qui rend une promesse** (choix du
vérificateur) laisse le bouton appelant en chargement si on la ferme par Échap sans passer par
son bouton d'annulation. Ça se voit dans le film — un compte à rebours figé pendant dix
minutes — et c'est un vrai bug côté application, pas un défaut du parcours.

## Limites connues du mode démo

À redire honnêtement plutôt qu'à masquer, et à revoir si la démo évolue :

- **Les boutons groupés « Pousser pour tous » / « Créer toutes les MR »** n'apparaissent qu'à
  partir de deux projets prêts ; aucune session semée n'est dans cet état. La narration les
  décrit en désignant la colonne d'actions, **sans prétendre qu'ils sont à l'écran**.
- **Le panneau Activité reste fermé** : il ne se déplie qu'à partir d'un job suivi, et aucun n'a
  tourné. Le forcer afficherait un panneau vide en prétendant montrer un historique.
- **Version anglaise : l'interface est en anglais, le contenu semé reste en français** (titres de
  MR, corps des rapports) — ce sont des données, pas de l'interface.
- **« Ouvrir le code » n'est jamais cliqué** : cela lancerait un éditeur sur la machine.

Règle générale : **ne jamais commenter un écran qu'on ne montre pas**. Si le mode démo ne sait
pas produire l'état, soit on corrige le mode démo (cf. `src/demo-diff.js`), soit on désigne le
bouton en décrivant ce qu'il fait — jamais on ne raconte une fenêtre absente.

## Toucher au jeu de démo (`scripts/demo-seed.js`)

Le seed **efface `data-demo/` et repart d'une base propre** à chaque exécution : inutile de nettoyer
avant, et rien de ce qu'on y ajoute ne survit à côté d'un ancien état.

Deux pièges payés comptant :

- **Un ticket surveillé doit exister dans `src/demo-jira.js`.** Une clé inventée est bien insérée,
  puis la surveillance la vérifie, ne la trouve pas dans le jeu Jira fictif, et lui recolle le
  résumé d'un autre ticket. On se retrouve avec une ligne qui dit autre chose que ce qu'on a semé —
  et on ne le voit qu'à l'écran, plusieurs minutes de tournage plus tard.
- **`INSERT OR IGNORE` ne signale rien** quand la ligne existe déjà. Après avoir semé, vérifier ce
  que la base contient VRAIMENT plutôt que ce qu'on croit y avoir mis.

Le fil rouge du jeu de démo est le **tunnel de paiement** : merge request `!216`, branche
`feat/PROJ-720-checkout`, ticket surveillé `PROJ-1408`, un lien libre Confluence et une todo. C'est
ce fil qu'il faut suivre quand on veut montrer qu'un même sujet traverse plusieurs écrans.

## Détails qui ont coûté cher

- **La voix est recollée aux repères mesurés**, pas à la somme des durées prévues. `parcours.mjs`
  note l'instant réel de chaque étape dans `travail/reperes-<langue>.json` ; `montage.py` pose
  chaque clip à cet instant. Un clic 200 ms plus lent ne décale donc pas la suite.
- **Le décalage de tête** (`vidéo − pilotage`, ~2,7 s) correspond au chargement de la page avant
  le premier repère. `montage.py` le calcule seul ; s'il devient négatif, c'est que
  l'enregistrement a été coupé trop tôt.
- **Le curseur suit les vrais événements souris** (`mousemove` / `mousedown`), il n'est pas
  dessiné à une position supposée — c'est ce qui le rend crédible.
- **Pas de capture d'écran système.** `ffmpeg -f avfoundation` exigerait l'autorisation macOS
  « Enregistrement de l'écran » et filmerait tout le bureau. Playwright n'enregistre que la page.

## Vérifier avant de livrer

Ne pas se fier au fait que la commande soit sortie sans erreur — **regarder le film** :

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 demo-live-real-fr.mp4
ffmpeg -hide_banner -i demo-live-real-fr.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume
# extraire une image au milieu d'une étape et vérifier que le curseur est sur le bon élément
ffmpeg -y -v error -ss 250 -i demo-live-real-fr.mp4 -frames:v 1 /tmp/verif.jpg
```

Contrôler au moins : le curseur tombe sur l'élément commenté, l'écran correspond à ce qui est
dit, le niveau sonore est autour de −17 dB, et **la dernière image est propre** (une erreur
laissée à l'écran s'y voit pendant toute la fin).
