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

## État au 13/09/2026 : les films longs sont refaits, en THÈME SOMBRE

**151 étapes** (115 auparavant), ~28 min, dans les deux langues. Le film se tourne désormais en
**sombre** — demandé par l'utilisateur : `colorScheme: 'dark'` sur le contexte ET
`aidevtools_theme = dark` posé avant le premier rendu, les deux, pour que rien ne dépende de
l'ordre. La dernière étape montre donc le thème **clair** (le vrai contrôle, ses vraies options),
puis **revient au sombre** : la dernière image doit être celle qu'on a choisie, pas le détour.

Ce qui est entré dans le parcours à cette passe : l'onglet **Agents** (neuf étapes : profil,
périmètre, « Demander », horaire, connaissance versionnée d'un agent de domaine, âge de la carte,
mise à jour, version en attente de validation, skills et sous-agents du disque), la **quatrième
famille** de sessions (question libre), le **diff par itération**, la **fenêtre mise de côté** et
reprise, le **profil d'agent dans le formulaire** de session, les **constats mis en brouillons**
(et ce qui ne peut pas s'ancrer dans le diff), la **question posée sur une review** sans la
refaire, la **publication du rapport** sur la forge, les **notes qui citent une merge request**,
le **vidage des remarques en attente**, le **tri de la file**, la **carte de domaine** portée par
une merge request, ce que la **veille** a vu (conteneurs tombés, builds terminés), **Copier pour
le daily**, le **report d'une todo**, **Coller une adresse**, les **opérations git** dans les
stats, **Merge** et **Comparer** dans l'onglet Git, ce que **Mergerie sait d'un ticket Jira**,
et les **tickets surveillés**.

## Ce qui avait cassé le parcours, et qui recassera pareil

Tout ce qui suit a été rencontré **à cette passe**, sur un parcours qui marchait deux semaines
plus tôt. Aucun de ces cas ne se voit à la lecture du code : le contrôle rapide (étape 2) est le
seul moyen de les trouver avant quinze minutes de tournage.

- **Une action rangée dans un menu « ⋯ » reste dans le DOM, mais cachée.** Six étapes sont
  tombées là-dessus d'un coup : « Classer sans review », « Vérifier », « Voir le résultat des
  vérificateurs » (menu de la carte), « Relancer la review », « Marquer traitée », « Converger »
  (menu du rapport). Le symptôme est toujours le même — `locator resolved to hidden`, quinze
  secondes, puis l'arrêt. **Ouvrir le menu d'abord** (`[data-more]`, `#aMore`), et en profiter :
  un menu ouvert montre trois actions pour une seule étape.
- **Un sous-onglet inséré décale tous les suivants.** `Merge` (2ᵉ) et `Comparer` (6ᵉ) sont arrivés
  dans l'onglet Git : `sous('git', 1..5)` désignait depuis six panneaux de décalage. Celui-là ne
  lève rien du tout — il commente simplement le mauvais écran.
- **Un `<details>` replié cache des éléments présents.** L'historique de la fiche Jenkins vit dans
  `details.jk-fiche-repli` : replié, ses lignes existent et sont invisibles. On l'ouvre
  explicitement (`d.open = true`) — c'est le vrai contrôle, pas un écran fabriqué.
- **`input[type=checkbox] >> nth=0` ne désigne rien de stable.** La première case du formulaire de
  session est aujourd'hui `notify_jira`, dans une rangée masquée tant qu'aucun ticket n'est saisi.
  **Nommer le champ** (`[name=auto_push]`) : un rang ne dit pas ce qu'il désigne.
- **Une fonctionnalité peut DISPARAÎTRE.** Les vérificateurs « script » n'existent plus — un
  vérificateur est une liste de commandes — et la liste déroulante `kind` avec eux. La narration
  parlait encore de « deux familles ». Une étape qui pointe un contrôle supprimé s'arrête ; une
  phrase qui décrit une fonctionnalité supprimée, elle, passe inaperçue à la relecture.
- **Un bouton d'état n'est là que dans cet état.** « Pousser », « Créer la MR », « Relancer les
  projets en échec », « Vérifier l'état des branches », « Relancer (delta) » n'apparaissent que
  quand la situation les appelle : la session semée a déjà ses merge requests, le rapport semé
  n'est pas périmé. On montre ce que l'écran porte VRAIMENT, et on décrit le reste sans prétendre
  qu'il est là.
- **Le compte des onglets se dit dans la narration.** « Dix onglets », « trois familles »,
  « six outils », « huit onglets de réglages » : quatre phrases fausses le jour où un onglet
  arrive. À recompter à chaque passe — c'est l'inventaire de l'application en marche qui tranche,
  jamais le souvenir.
- **Un jeu de démo ne porte pas toujours ce qu'on veut montrer, au même endroit.** Aucun rapport
  n'a À LA FOIS plusieurs constats (donc la rangée de pastilles) et une note qui le cite : le
  parcours ouvre l'un, puis passe sur l'autre pour l'encart des citations. Vérifier AVANT de
  narrer : `#reportList .card` rang par rang, et on lit ce que chacun porte.

## Vocabulaire de cette passe, à ÉCOUTER avant de le retenir

Une seule réécriture a été ajoutée à `prononciation.py` après coup — `case`, signalée à
l'écoute (voir « Quand aucune respelling ne peut marcher »). Pour le reste, rien n'a pu être
écouté ici, et le principe du fichier est qu'on ne retient une réécriture qu'après l'avoir
entendue. Les mots nouveaux de cette narration, par ordre de risque décroissant :

- `skills` — anglicisme court, pluriel anglais : candidat sérieux à la bascule en phonèmes
  anglais, comme `token` et `shell` avant lui.
- `daily` (dans « Copier pour le daily ») — le libellé de l'application, donc à dire tel quel.
- `todo`/`todos` — déjà signalé à la passe précédente, toujours pas écouté.
- `cartographe`, `cartographie` — français, mais longs ; à vérifier qu'ils ne sont pas hachés.
- `delta`, `agent de domaine`, `sous-agents` — a priori sans piège.

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
| `case` | mal rendu **par le modèle** | `option à cocher`, `cellule` | le SEUL cas où la respelling est impuissante — voir juste en dessous |

### Quand aucune respelling ne peut marcher

`case` (signalé à l'écoute du film de septembre) est le seul cas du corpus où réécrire
l'orthographe ne sert à rien : **espeak phonémise déjà correctement**.
`espeak-ng -v fr -q -x "une case à cocher"` rend `yn k'az a koS'e` — exactement ce qu'un
francophone dit — et `caze` comme `kaze` rendent les mêmes phonèmes. Mêmes phonèmes, même
audio : le défaut est dans le MODÈLE (siwis), pas dans le phonémiseur.

La seule sortie est de **changer le mot prononcé** : « option à cocher » (`Opsj'O~`) et, pour la
grille de liens, « cellule » (`sEl'yl`). Le texte écrit, lui, garde « case ».

**La méthode à retenir** : devant un mot qui sonne faux, phonémiser d'abord. Si espeak rend déjà
ce qu'on attend, ne pas chercher de graphie — il n'y en a pas ; chercher un synonyme.

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
- **Un clic qui part dans le vide, sans erreur.** L'en-tête est `position: sticky` : un élément
  ramené dans la fenêtre par `scrollIntoViewIfNeeded` peut se retrouver DESSOUS. Playwright le
  déclare visible (l'occlusion n'entre pas dans son critère), mais les clics du parcours sont de
  vrais événements souris — ils atteignent alors le titre de l'en-tête, la scène suivante se joue
  sur un écran inchangé, et **rien n'est levé**. `versEl` dégage désormais la hauteur de
  l'en-tête ; la panne ne se déclenchait qu'après une étape ayant laissé la page défilée, ce qui
  la rendait insaisissable. `elementFromPoint` au point du clic est le seul diagnostic qui tranche.
- **Une donnée de démo datée en relatif change d'état à minuit.** La pastille Jenkins compte les
  jobs du JOUR : passé minuit, le jeu de démo n'en avait plus, et l'enregistrement anglais a
  échoué là où le français était passé une heure plus tôt. Corrigé côté `src/demo-jenkins.js`.
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
