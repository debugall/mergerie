# Réorganisation de `src/` — plan d'implémentation

Ce document décrit comment passer d'un dossier `src/` plat de 87 fichiers, dominé par un
`server.js` de 8 500 lignes, à une arborescence par couche, avec des fichiers courts, une
direction de dépendance imposée par `npm run check`, et un historique git qui suit chaque
fichier déplacé. Il est écrit pour être exécuté étape par étape, chaque étape laissant la suite
verte et l'application identique pour l'utilisateur.

Le principe qui commande tout le reste : **un déplacement ne change pas une ligne de
comportement.** Un commit déplace ou découpe ; un autre commit, plus tard, améliore. Mélanger
les deux rend la relecture impossible et le `git bisect` inutile.

---

## 1. État des lieux (relevé le 19 septembre 2026, branche `improve_sec`)

### Les chiffres

| Mesure | Valeur |
|---|---|
| Fichiers dans `src/`, tous au même niveau | 87 |
| `src/server.js` | 8 533 lignes, **351 routes**, 118 fonctions, 66 `require` |
| `src/db.js` | 2 343 lignes, **81 tables**, **190 `ALTER TABLE`** |
| Fichiers de plus de 800 lignes | 8 (`server`, `db`, `store-registry`, `links`, `store`, `jobs`, `taskrunner`, `datasync`) |
| Cycles de dépendances entre modules | 7 chemins, formant 2 composantes fortement connexes |
| Commits touchant `server.js` | 119 sur 311 (38 %) |
| Commits touchant `db.js` | 69 sur 311 |
| Commits touchant au moins deux des cinq plus gros fichiers | 76 |
| Suite de tests | 205 fichiers, 2 581 tests, **60 modules de `src/` importés directement** |

Le dernier chiffre de la colonne "conflits" est le plus parlant : un commit sur quatre touche à
la fois `server.js` et `db.js`, ou `server.js` et `jobs.js`. Deux branches en parallèle sur ce
dépôt se rencontrent presque toujours dans `server.js`, souvent à cinq cents lignes d'écart
mais dans le même fichier, ce qui suffit à git pour demander une résolution manuelle dès qu'un
bloc voisin bouge.

### Ce qui est déjà bien, et qu'il ne faut pas casser

- **Les modules métier sont déjà découpés** : `reviewer`, `converge`, `verifyrun`, `taskrunner`,
  `datasync` ont chacun un rôle net, documenté dans `PLAN.md` (75 lignes de tableau). Le
  problème n'est pas le découpage du métier, c'est la couche HTTP (`server.js`) et le schéma
  (`db.js`) qui sont restés monolithiques, plus l'absence de dossiers.
- **`server.js` est déjà sectionné** par 40 commentaires `/* ---------- Titre ---------- */`
  (lignes 361, 826, 1188, 1487, 1650, 1837, 1880, 2001, 2053, 2102, 2684, 3117, 4075, 4476,
  4507, 5423, 5546, 6090, 6405, 6601, 7822, 8057…). Ces sections sont les futurs fichiers de
  routes : le découpage est déjà pensé, il n'est pas matérialisé.
- **`db.js` est sectionné de la même façon** (Vérification objective, Liens, Notes, Agents,
  `local_config`, identité, `local_state`…), et chaque `ALTER` suit le `CREATE` de sa table,
  ce que `npm run check` impose.
- **Trois modules sont des feuilles volontaires** : `paths.js` (lit `MERGERIE_DATA_DIR` au
  chargement, une fois), `store-registry.js` (aucun `require`, lisible comme du texte par les
  contrôles) et `ulid.js`. Leur position dans l'arborescence change, leur pureté non.
- **Les contrôles statiques** (`scripts/check-server.js`) encodent des bugs réels : `t`
  réservé à la traduction, `ALTER` après `CREATE`, un GET qui ne lance rien, `spawn` sans
  `process.env` brut, un test qui n'ouvre pas la base réelle à l'import. Ils lisent `src/`
  **sans récursion** (`fs.readdirSync(SRC)`) et le test-rule ne reconnaît que
  `require('../src/<un-segment>')`. **Déplacer un fichier dans un sous-dossier le sort
  silencieusement de tous ces contrôles.** C'est le premier risque du chantier, et la raison
  pour laquelle l'étape 0 est obligatoire avant tout `git mv`.

### Les sept cycles

```
git -> skillscan -> git
agentprofile -> agentschedule -> agentprofile
agentprofile -> agentknowledge -> agentprofile
agentknowledge -> agentprofile -> agentschedule -> agentknowledge
agentprofile -> jobs -> agentprofile
agentprofile -> jobs -> taskrunner -> agentprofile
agentknowledge -> agentprofile -> jobs -> reviewer -> agentknowledge
```

Tous passent par `agentprofile.js`, sauf `git ↔ skillscan`. Ils fonctionnent aujourd'hui parce
que le `require` est paresseux (dans la fonction, pas en tête de fichier : `agentprofile.js`
lignes 83, 91, 110, 159, 413, 536, 580…). Ils ne cassent rien, mais ils empêchent de dire
"ce dossier ne dépend pas de celui-là", et cette phrase est exactement ce qu'on veut pouvoir
vérifier à la fin.

### Ce que ce plan ne couvre pas

- **`public/app.js` (25 273 lignes)** est l'autre monolithe. Même diagnostic, autre plan :
  le front n'a pas de `require`, le découpage passe par des `<script>` ordonnés ou un
  bundler, et c'est une décision à part. Ce document ne parle que de `src/`.
- **`test/` (205 fichiers à plat)** garde sa forme. Les tests changent de `require`, pas de
  place : déplacer les tests en même temps que le code doublerait la surface de chaque commit.
  Un plan ultérieur pourra refléter l'arborescence de `src/` dans `test/unit/`.

---

## 2. Arborescence cible

```
src/
├── server.js                  point d'entrée — INCHANGÉ en chemin, réduit à ~200 lignes
├── cli.js                     `npm run pipe`, inchangé
│
├── app/                       la couche HTTP, et rien d'autre
│   ├── middleware/
│   │   ├── origine.js         « d'où vient cette requête ? » (Host, Sec-Fetch-Site, jeton)
│   │   ├── entetes.js         CSP et en-têtes de toute réponse
│   │   ├── langue.js          la langue de l'écran pour la durée de la requête
│   │   ├── memo-requete.js    les mémos vidés en entrée (cacheVerifs)
│   │   ├── ecriture-depot.js  écrire les fichiers du dépôt après chaque requête qui a écrit
│   │   └── corps.js           express.json / express.raw (audio) / statiques
│   ├── http.js                wrap, repoById, mrById, readFileSafe, ticketUrl, erreurs 400
│   ├── fichiers.js            servirFichierNonFiable — le SEUL res.sendFile
│   ├── planification.js       les timers de fond : autoRefresh, jiraWatch, retention, veille
│   └── routes/                UN fichier par préfixe d'API, monté par server.js
│       ├── statut.js          /api/status /api/whoami /api/me /api/footer /api/stats /api/config
│       ├── repos.js           /api/repos /api/local-roots /api/local-projects /api/discover
│       ├── mrs.js             /api/mrs (49 routes → voir découpe fine en §4.2)
│       ├── mrs-commentaires.js   commentaires inline en attente, publication
│       ├── mrs-resume.js      résumé d'une MR pour une bulle, diffview
│       ├── tasks.js           /api/tasks (38 routes)
│       ├── tasks-pieces.js    pièces jointes d'une session
│       ├── local-tasks.js     /api/local-tasks (hors dépôt)
│       ├── questions.js       /api/questions (question libre)
│       ├── agents.js          /api/agents, connaissance, skills
│       ├── verifiers.js       /api/verifiers /api/verifications /api/lots /api/verify
│       ├── jobs.js            /api/jobs
│       ├── git.js             /api/git /api/git-commands /api/git-run
│       ├── git-compare.js     comparer deux dépôts, merge de branche à branche
│       ├── docker.js          /api/docker /api/services /api/environments
│       ├── jenkins.js         /api/jenkins
│       ├── jira.js            /api/jira /api/context-links
│       ├── notes.js           /api/notes /api/todos /api/brief /api/notes-index
│       ├── links.js           /api/links /api/free-links /api/navigate
│       ├── data-sync.js       /api/data-sync /api/export /api/backup
│       ├── dictation.js       /api/dictation
│       ├── rules.js           /api/rules
│       └── acces.js           /acces/ (la page de jeton)
│
├── core/                      briques sans métier ; n'importe RIEN hors de core/
│   ├── paths.js               (feuille, lit l'env au chargement — ne bouge que de dossier)
│   ├── proc.js  httpreq.js  glob.js  zip.js  pmap.js  ulid.js  dirhash.js
│   ├── garde.js  nonfiable.js  notify.js  identite.js
│   └── i18n.js                `module.exports = require('../../public/i18n-runtime.js')`
│
├── db/                        le schéma — un fichier par domaine, CREATE et ses ALTER ensemble
│   ├── index.js               ouvre la base, PRAGMA, applique schema/* dans l'ordre, DEFAULTS,
│   │                          reconcilierTravauxCoupes — `require('../src/db')` reste valable
│   ├── reparation.js          « réparation, tout en haut, avant la moindre écriture »
│   └── schema/
│       ├── 00-config.js  01-repos.js  02-reviews.js  03-jobs.js  04-sessions.js
│       ├── 05-local-tasks.js  06-questions.js  07-agent-passes.js  08-verify.js
│       ├── 09-links.js  10-notes.js  11-jenkins.js  12-dictation.js  13-agents.js
│       ├── 14-local-config.js  15-identite.js  16-local-state.js  17-store.js
│       └── (l'ordre numérique EST l'ordre d'exécution ; un ALTER vit dans le fichier de
│            son CREATE, donc « ALTER avant CREATE » devient impossible par construction)
│
├── data/                      « le dossier de fichiers EST la base » et son transport
│   ├── store-registry.js      (feuille : aucun require, contrôlé comme du texte)
│   ├── store.js  datasync.js  localstate.js  localdirs.js  localsession.js
│   ├── config.js  configagent.js  approbation.js
│   ├── backup.js  retention.js
│
├── forge/                     GitLab et GitHub, derrière une seule porte
│   ├── index.js               ← l'actuel forge.js (clientFor) ; `require('../forge')`
│   ├── gitlab.js  github.js   (jamais importés d'ailleurs que index.js — contrôlé)
│
├── git/                       le clone local et ce qu'on en fait
│   ├── git.js  gitops.js  gitmerge.js  conflits.js  gitgraph.js  gitpalette.js
│   ├── localrepos.js  resolution.js  diffnum.js
│
├── agent/                     l'agent CLI et la mécanique d'une session
│   ├── copilot.js             le pilote du binaire (claude / copilot)
│   ├── session.js             ← agentsession.js
│   ├── args.js  policy.js  pass.js  input.js  defaults.js  protocol.js  prompts.js
│   ├── questions.js  pieces.js  skillscan.js  aisession.js  tasks.js
│   ├── profile/               ← agentprofile.js découpé (§4.4)
│   │   ├── index.js  modele.js  lancer.js  rendu.js
│   ├── knowledge.js           ← agentknowledge.js
│   └── schedule.js            ← agentschedule.js
│
├── review/                    reviewer.js  converge.js  note.js
├── session/                   taskrunner.js  localcoder.js  localsnapshot.js  asker.js
├── verify/                    verify.js  verifyrun.js  verifierenv.js
├── jobs/                      la file, et un runner par sorte de job
│   ├── index.js               file, startJob, journal, stop — `require('../jobs')` reste valable
│   └── runners/               task.js  converge.js  verify.js  docker.js  gitops.js
│                              local.js  ask.js  install.js  reconcile.js
├── integrations/              jira.js  jenkins.js  docker.js  dictation.js  docx.js  veille.js
├── notes/                     notes.js  brief.js  links.js  discover.js
└── demo/                      demo-*.js → agents.js comments.js dictation.js diff.js docker.js
                               git.js jenkins.js jira.js review.js shared.js verify.js
```

Vingt-deux dossiers de deuxième niveau au plus profond ; aucun fichier à plus de deux niveaux
sous `src/`. Le chemin d'un module se lit comme sa couche : `src/forge/gitlab.js`,
`src/app/routes/mrs.js`.

### Direction des dépendances (la règle qui fait tenir l'ensemble)

```
app  →  jobs  →  session · review · verify · agent · notes · integrations
                          ↓
                    forge · git · data · db
                          ↓
                        core
```

- Une flèche se lit "peut importer". `core/` n'importe rien hors de `core/`. `db/` n'importe
  que `core/` et `data/store-registry.js`. **Rien n'importe `app/`**, jamais.
- `demo/` peut importer n'importe quoi ; rien ne l'importe sauf `app/`, `jobs/` et les
  modules qui savent déjà tester `isDemo()` (`reviewer`, `verifyrun`, `dictation`, `gitops`,
  `taskrunner`) — la liste actuelle, à ne pas étendre.
- Une exception connue est **écrite dans le contrôle**, avec son motif, pas tolérée en
  silence. La matrice vit dans `scripts/check-deps.js` (§3, étape 0) et `npm run check` échoue
  sur un import qui la viole.

### Ce qui ne change PAS de chemin, et pourquoi

| Chemin | Qui en dépend |
|---|---|
| `src/server.js` | `package.json` (`main`, `start`, `dev`), `bin/mergerie.js` (le lance en processus enfant), `test/helpers/synchro-collegue.js` (idem), `test/helpers/app.js` |
| `src/cli.js` | `npm run pipe` |
| `require('../src/db')` | 25 fichiers de test — reste valable parce que `src/db/index.js` résout |
| `require('../src/jobs')` | 6 fichiers de test — idem avec `src/jobs/index.js` |
| `require('../src/forge')` | 1 test — idem |
| `public/i18n-runtime.js` | le front et le serveur partagent le même dictionnaire |
| `scripts/demo-seed.js` | livré dans le paquet npm (`files`), importe 6 modules de `src/` |

Les 11 clés exportées par `server.js` (`app`, `server`, `nommerBranches`, `close`…) restent
telles quelles : `test/helpers/app.js` les consomme.

---

## 3. Outillage préalable — étape 0, sans laquelle rien ne bouge

### 3.1 Un codemod de déplacement : `scripts/move-module.js`

```
node scripts/move-module.js src/gitlab.js src/forge/gitlab.js
```

Ce qu'il fait, et rien de plus :

1. `git mv` de l'ancien chemin vers le nouveau (l'historique suit avec `git log --follow`).
2. Dans **tous** les `.js` de `src/`, `test/`, `scripts/`, `bin/`, réécrit chaque
   `require('<relatif vers l'ancien>')` en `require('<relatif vers le nouveau>')`, recalculé
   depuis le fichier qui importe. Il traite aussi les `require` paresseux (dans une fonction)
   et les chaînes `'./x'` passées à `require` sous forme de variable — il n'y en a pas
   aujourd'hui, le script échoue s'il en trouve.
3. Dans le fichier déplacé, recalcule ses propres `require` relatifs (un fichier qui descend
   d'un niveau voit `./db` devenir `../db`).
4. Affiche la liste des fichiers réécrits et refuse de tourner si l'index git n'est pas propre.

Il ne touche ni la doc ni les commentaires : ceux-là se relisent à la main, à la fin (§6).

### 3.2 Les contrôles deviennent indifférents au chemin

Dans `scripts/check-server.js` :

- **Parcours récursif de `src/`** pour la vérification de syntaxe (ligne 37), la règle `t`
  (ligne 46), la règle `spawn` (ligne 309), et toute autre boucle `readdirSync(SRC)`. Une
  fonction `tousLesFichiers(dir)` remplace chaque `readdirSync`.
- **La règle "un test n'ouvre pas la base réelle à l'import"** (lignes 158-196) résout
  aujourd'hui `require('../src/<nom>')` vers `src/<nom>.js` et suit les `require('./x')`.
  Elle doit résoudre comme Node : chemin relatif à plusieurs segments, `index.js` d'un
  dossier, et suivre les `require('../x/y')`.
- **Les règles qui lisent `server.js` comme du texte** (un GET qui lance quelque chose,
  ligne 296 ; `res.sendFile` hors de `servirFichierNonFiable`, ligne 316) lisent désormais
  `src/server.js` **et** `src/app/**/*.js` concaténés. La règle `sendFile` compte alors tous
  les appels hors de `src/app/fichiers.js`.
- **La règle `ALTER après CREATE`** (ligne 141) lit `src/db.js` ; elle lira `src/db/schema/*.js`
  dans l'ordre numérique, comme un seul texte. Elle garde son sens (un ALTER d'un fichier
  ultérieur sur une table d'un fichier antérieur reste valide) et gagne une règle jumelle :
  **un ALTER vit dans le fichier du CREATE de sa table**, sinon échec.
- **La règle `ALLOWED` / `UPDATE config SET`** (ligne 76) lit `src/config.js` ; le chemin
  devient `src/data/config.js`. Idem pour `store-registry`, `store`.
- Les messages d'erreur qui écrivent `src/server.js` ou `src/db.js:${i}` en dur écrivent le
  chemin réel du fichier fautif.

Dans `scripts/check-docs.js`, ligne 122 : `src/verify.js` → `src/verify/verify.js`.

**Preuve que l'étape 0 est finie** : lancer `npm run check` sur l'arborescence actuelle
donne exactement le même résultat qu'avant ; puis déplacer un fichier à la main dans un
sous-dossier avec une faute volontaire (`spawn` avec `process.env`, ou une variable `t`) et
vérifier que le contrôle la voit toujours. Sans cette seconde moitié, on ne sait pas si les
contrôles suivent.

### 3.3 Un nouveau contrôle : `scripts/check-deps.js`

Il lit chaque `require` relatif de `src/`, détermine le dossier de l'importeur et de
l'importé, et vérifie la matrice de §2. Deux règles s'y ajoutent :

- **`src/forge/gitlab.js` et `src/forge/github.js` ne sont importés que par
  `src/forge/index.js`** — la règle de `CLAUDE.md` que rien ne vérifiait encore.
- **Aucun cycle** entre modules, calculé par parcours en profondeur. Tant que les sept cycles
  actuels existent, le contrôle les liste **nommément** dans une liste `CYCLES_CONNUS` et
  n'échoue que sur un cycle nouveau. Chaque cycle cassé est retiré de la liste dans le même
  commit ; la liste vide marque la fin de l'étape 5.

Il est branché dans `npm run check` dès l'étape 0, où il passe trivialement (tout est dans le
même dossier).

### 3.4 Une taille de fichier surveillée

Dans `check-server.js`, un avertissement (pas un échec) au-dessus de **600 lignes**, et un
échec au-dessus de **1 200**, avec une liste d'exceptions nommées qui commence par les huit
fichiers actuels et **ne peut que rétrécir** : ajouter un nom à la liste est un choix qui se
relit, pas un réflexe. Le seuil compte les lignes sans les commentaires de tête : la doc en
tête de fichier est une convention du projet, elle ne doit pas pousser à se raccourcir.

### 3.5 La preuve de non-régression, préparée avant le premier `git mv`

Trois relevés à prendre **avant** et à comparer **après chaque étape** :

```bash
# 1. Le schéma d'une base NEUVE, trié — la référence pour l'étape 3 (db.js)
MERGERIE_DATA_DIR=$(mktemp -d) node -e "require('./src/db')" \
  && sqlite3 $MERGERIE_DATA_DIR/reviewer.db .schema | sort > /tmp/schema-avant.sql

# 2. Les routes, méthode + chemin, triées — la référence pour l'étape 2 (server.js)
grep -ohE "app\.(get|post|put|delete|patch)\('[^']+'" src/server.js src/app/routes/*.js 2>/dev/null \
  | sort > /tmp/routes-avant.txt

# 3. Le nombre de tests et de fichiers — le compte qui trahit un fichier oublié
npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)'
```

Un `diff` vide sur (1) et (2), le même compte sur (3) : voilà ce que "rien n'a changé" veut
dire, et c'est ce qu'on écrit dans le message du commit.

---

## 4. Les étapes, dans l'ordre

Le chantier se fait **sur la branche `improve_sec`**, une étape après l'autre, chaque étape
close par un commit qui laisse la suite verte. Deux règles de conduite en découlent :

- **`develop` est fusionné dans `improve_sec` avant l'étape 1** (c'est déjà le cas au
  commit `98e083d`) et **à nouveau avant l'étape 2** si `develop` a bougé entre-temps : un
  déplacement de `server.js` se fusionne sans douleur tant que l'autre côté n'a pas touché
  aux mêmes sections, et très mal après.
- **Pendant les étapes 2 et 3, aucune autre branche ne touche `server.js` ni `db.js`**, et
  `improve_sec` est fusionnée dans `develop` dès l'étape 6 finie, sans attendre autre chose.
  Une branche de refonte qui vit longtemps entre en conflit avec tout ce qui se développe à
  côté, ce qui est précisément le mal qu'on soigne : le chantier se fait d'un trait.

Le rythme d'un commit : `move-module` (ou l'extraction à la main pour les découpes), `npm run
check`, `npm test`, comparaison des trois relevés, commit avec `-s`, message d'une ligne qui dit
le déplacement, en anglais : `Move forge clients under src/forge/`.

### Étape 1 — Les feuilles et les dossiers sans cycle (½ journée)

Pur `move-module`, un commit par dossier, du moins couplé au plus couplé :

1. `demo/` : 11 fichiers `demo-*.js`, renommés sans le préfixe (le dossier le dit).
2. `core/` : `paths`, `proc`, `httpreq`, `glob`, `zip`, `pmap`, `ulid`, `dirhash`, `garde`,
   `nonfiable`, `notify`, `identite`, plus le nouveau `core/i18n.js`. Puis remplacer les 41
   `require('../public/i18n-runtime.js')` par `require('<relatif>/core/i18n')` — un seul
   commit, vérifié par la règle `t` qui doit reconnaître la nouvelle forme d'import (adapter
   sa détection en même temps).
3. `forge/` : `forge.js` → `forge/index.js`, `gitlab.js`, `github.js`. `check-deps` active
   la règle "importés seulement par index.js" à ce commit.
4. `integrations/` : `jira`, `jenkins`, `docker`, `dictation`, `docx`, `veille`.
5. `git/` : `git`, `gitops`, `gitmerge`, `conflits`, `gitgraph`, `gitpalette`, `localrepos`,
   `resolution`, `diffnum`. Le cycle `git ↔ skillscan` reste (require paresseux, ligne 275 de
   `git.js`) et entre dans `CYCLES_CONNUS`.
6. `data/` : `store-registry`, `store`, `datasync`, `localstate`, `localdirs`, `localsession`,
   `config`, `configagent`, `approbation`, `backup`, `retention`.
7. `verify/`, `review/`, `session/`, `notes/`, `agent/` (sans découper `agentprofile` encore).

À la fin de l'étape 1, `src/` ne contient plus à plat que `server.js`, `cli.js`, `db.js` et
`jobs.js`. Les tests ont changé de `require` (le codemod l'a fait), pas de contenu.

### Étape 2 — `server.js` → `src/app/` (3 à 4 jours, le cœur du chantier)

#### 4.2.1 Les fondations, d'abord

1. **`app/http.js`** : `wrap`, `repoById`, `mrById`, `readFileSafe`, `ticketUrl`,
   `parseConvergeOpts`, `gardeConfigAgent`. Ce sont les fonctions que les routes se partagent ;
   elles sortent en premier parce que chaque fichier de routes en aura besoin.
2. **`app/fichiers.js`** : `servirFichierNonFiable`, et le contrôle `sendFile` pointe dessus.
3. **`app/middleware/*.js`** : les six blocs des lignes 135-360, dans l'ordre où `server.js`
   les monte. Chaque fichier exporte `(app, ctx) => void` et **l'ordre de montage est écrit
   dans `server.js`, en clair, avec un commentaire par ligne** — la sécurité du serveur tient
   à cet ordre (la garde d'origine avant tout, les en-têtes avant même un refus).
4. **`app/planification.js`** : les quatre timers et la veille, avec `demarrer()` /
   `arreter()` ; `server.close()` appelle `arreter()`.

Le mémo `cacheVerifs` (ligne 235, vidé par un middleware à chaque requête) devient un module
`app/middleware/memo-requete.js` qui expose `get()`, `set()`, `vider()` ; les routes qui le
lisent l'importent au lieu de fermer sur une variable de `server.js`.

#### 4.2.2 Les routes, une section à la fois

**La forme d'un fichier de routes** :

```js
'use strict';
/* /api/verifiers — les vérificateurs : définir, lister, lancer, lire un résultat.
   Ce que « vérifier » veut dire est dans src/verify/ ; ici, seulement le HTTP. */
const { wrap, repoById } = require('../http');
const { t } = require('../../core/i18n');
const verifyrun = require('../../verify/verifyrun');

module.exports = function monter(app) {
  app.get('/api/verifiers', wrap(async (req, res) => { /* … verbatim … */ }));
  // …
};
```

Pas de `express.Router()` : les routes gardent leur chemin complet, ce qui permet de `grep`
une URL et de tomber sur sa définition, et les règles de `check-server` continuent de
reconnaître `app.get('/api/…'`. `server.js` les monte dans l'ordre alphabétique des fichiers,
sauf `acces.js` en premier et `statut.js` en second — cet ordre est écrit et commenté, parce
qu'Express fait jouer l'ordre de déclaration sur les chemins qui se recouvrent
(`/api/mrs/:id` et `/api/mrs/summary`, par exemple : à vérifier dans le relevé des routes
qu'aucune paire de ce genre ne change de fichier).

**L'ordre des extractions**, du plus isolé au plus imbriqué, un commit par fichier :

| Commit | Fichier | Section(s) de `server.js` | Routes |
|---|---|---|---|
| 1 | `acces.js`, `statut.js` | 361 Statut / config, 826 Statistiques | ~12 |
| 2 | `jenkins.js` | 1188 | 9 |
| 3 | `jira.js` | 1487, 1650, 6526 (B5) | 18 |
| 4 | `dictation.js` | 1837 | 5 |
| 5 | `repos.js` | 1880, 2001, 5546 (découverte) | ~14 |
| 6 | `docker.js` | 2102, 2159, 2184 (B6, B8) | 21 + services + environments |
| 7 | `git.js`, `git-compare.js` | 2053, 7822, 7827, 8057, 8114, 8215 | 21 + 4 + 1 |
| 8 | `notes.js`, `links.js` | 6090, 6405 | 11 + 7 + 3, 5 + 6 + 1 |
| 9 | `data-sync.js` | 5423, 6046, 6073 | 6 + export + backup |
| 10 | `rules.js`, `verifiers.js` | 4476, 4507, 4813, 5119, 5170, 5236, 5294 | 4, 10 + 5 + 4 + 2 |
| 11 | `questions.js` | 4075 | 13 |
| 12 | `agents.js` | 3117, 3203, 3299 | 20 + 2 |
| 13 | `local-tasks.js` | (mêlé à 2684-3552) | 17 |
| 14 | `tasks.js`, `tasks-pieces.js` | 2684, 2835, 2951, 3552 | 38 |
| 15 | `mrs.js`, `mrs-commentaires.js`, `mrs-resume.js` | 6601, 7177, 7575 | 49 |
| 16 | `jobs.js` | (dispersé) | 10 |

Les sections `tasks` et `mrs` sont les plus longues (plus de 800 lignes chacune) et les plus
modifiées ; elles arrivent en dernier, quand la forme est rodée sur quatorze fichiers plus
simples. Le fichier `mrs.js` se découpe **à la création** en trois (liste et actions,
commentaires, résumé et diff), pour ne pas naître à 1 500 lignes.

**Un commit d'extraction ne réécrit pas le corps d'une route.** Si une fonction de
`server.js` n'est utilisée que par une section, elle part avec elle ; si deux sections la
partagent, elle va dans `app/http.js` (HTTP) ou dans le module métier concerné (si elle parle
au métier : une fonction qui calcule quelque chose sur une MR n'a rien à faire dans `app/`).
Ce second cas est le seul où l'extraction change un module métier, et il se signale dans le
message du commit.

**Après le commit 16**, `server.js` contient : le chargement du `.env` (lignes 1-60, qui
doit rester **avant** tout `require` qui lit l'env — c'est déjà commenté), la création de
`app`, le montage ordonné des middlewares puis des routes, `listen`, `planification.demarrer()`,
et `module.exports` inchangé. Environ 200 lignes.

#### 4.2.3 La preuve

- Le relevé des routes (§3.5, point 2) est **identique** : même méthode, même chemin, même
  nombre (351).
- `npm test` : même compte. Les tests de routes passent par HTTP, ils ne savent pas d'où vient
  la route ; c'est ce qui rend cette étape sûre.
- Le replay CI depuis `git archive` (procédure de `CLAUDE.md`) sur le commit 16 : un fichier
  de routes non `git add`-é est exactement le genre d'oubli que seul l'archive révèle.

### Étape 3 — `db.js` → `src/db/` (1 à 2 jours)

1. `db.js` → `db/index.js` (`move-module`). Les 25 tests qui font `require('../src/db')`
   ne changent pas. Commit.
2. Extraire `db/reparation.js` (lignes 21-193 : ce qui se répare avant la moindre écriture).
3. Extraire les fichiers `schema/NN-*.js` section par section, **dans l'ordre du fichier**
   (l'ordre de création des tables est l'ordre des migrations, et une migration peut lire une
   table créée plus haut). Chaque fichier exporte `(db) => void` et contient les `CREATE` de
   son domaine **et chacun de leurs `ALTER`** — les 190 `try { db.exec('ALTER…') } catch {}`
   suivent leur table. `db/index.js` tient la liste ordonnée, explicite :

   ```js
   for (const nom of ['00-config', '01-repos', /* … */ '17-store']) require(`./schema/${nom}`)(db);
   ```

4. Les déclencheurs `uid`, la reprise des `slug`, le drain de `local_config` (lignes 1666-2100)
   sont du code de migration, pas du schéma : ils vont dans `db/migrations/` avec la même
   forme, appliqués après le schéma, dans l'ordre. `reconcilierTravauxCoupes` et `DEFAULTS`
   restent exportés par `index.js`.

**La preuve** : le `.schema` trié d'une base **neuve** (§3.5, point 1) est byte-à-byte
identique avant et après. Puis, sur une copie de `data-demo/reviewer.db` (une base qui a
traversé toutes les migrations), ouvrir avec le nouveau `db/` et comparer `PRAGMA table_info`
de chaque table : identique aussi. Ces deux comparaisons remplacent la lecture des 190
`ALTER` un par un.

### Étape 4 — `jobs.js` → `src/jobs/` (1 journée)

`jobs.js` a dix sortes de jobs (`ask`, `converge`, `converge-session`, `docker`, `gitops`,
`install`, `local`, `reconcile`, `task`, `verify`) dans un `switch`. Chaque `case` devient
`jobs/runners/<sorte>.js` exportant `async (job, ctx) => void` ; `jobs/index.js` garde la file,
`startJob`, le journal, l'arrêt, et un objet `RUNNERS` qui remplace le `switch`. Les 6 tests
qui importent `../src/jobs` ne changent pas. `exigerDossierCompose` et les autres exports
partagés restent sur `index.js`.

### Étape 5 — Casser les sept cycles (1 à 2 jours)

Un commit par cycle, `CYCLES_CONNUS` rétrécit d'un nom à chaque fois.

- **`git ↔ skillscan`** : `git.js` ligne 275 invalide le cache de `skillscan` après un
  `fetch`. Inverser : `git.js` expose un événement `apresFetch(fn)` ; `skillscan` s'y abonne
  au chargement. `git` ne connaît plus `skillscan`.
- **`agentprofile ↔ agentschedule`**, **`agentprofile ↔ agentknowledge`** : `agentprofile.js`
  (742 lignes) mélange trois choses — le **modèle** d'un profil (lecture, validation, valeurs
  par défaut), son **rendu** (la phrase de l'horaire, les tokens de la connaissance : lignes
  83-110) et son **lancement** (ligne 536, `require('./jobs')`). Découper en
  `agent/profile/modele.js` (aucune dépendance vers schedule, knowledge ou jobs),
  `agent/profile/rendu.js` (dépend de schedule et knowledge, pour l'affichage) et
  `agent/profile/lancer.js` (dépend de jobs). `agentschedule` et `agentknowledge` n'importent
  que `modele.js` : les deux cycles tombent.
- **`agentprofile ↔ jobs`**, **`… → taskrunner → agentprofile`** : `taskrunner` et le runner
  `task` importent `modele.js` ; seul `lancer.js` importe `jobs`. Tombent avec le précédent.
- **`agentknowledge → agentprofile → jobs → reviewer → agentknowledge`** : `reviewer` lit la
  connaissance d'un agent pour l'injecter dans le prompt (`agentknowledge` en `require` de
  tête). Une fois `agentprofile` découpé, il ne reste que `reviewer → knowledge → modele`,
  sans retour : tombe.

À la fin, `CYCLES_CONNUS = []` et le contrôle échoue sur tout cycle. C'est le moment où la
matrice de dépendances de §2 passe d'avertissement à échec.

### Étape 6 — La documentation et les règles (½ journée)

- **`PLAN.md`**, section « Modules » : le tableau de 75 lignes devient un tableau par dossier,
  avec une phrase par dossier qui dit ce qu'il contient et ce qu'il ne doit pas importer. Les
  chemins cités ailleurs dans `PLAN.md` (14 mentions) sont mis à jour.
- **`CLAUDE.md`** : six chemins (`src/gitlab.js`, `src/github.js`, `src/forge.js`,
  `src/config.js`, `src/db.js`, `src/paths.js`) et la règle « une migration après son
  CREATE » qui devient « un ALTER dans le fichier de son CREATE ». Ajouter la règle de
  direction des dépendances, en une phrase, avec le nom du contrôle.
- **`CONTRIBUTING.md`** (3 chemins), **`docs/guide.fr.md` / `guide.en.md`** (1 chemin chacun,
  même section — `check:docs` veille à ce qu'ils restent alignés), **`SECURITY.md`** (relire :
  il décrit la garde d'origine sans citer de fichier, mais `app/middleware/origine.js` mérite
  d'y être nommé).
- **`CHANGELOG.md`**, `## [Unreleased]`, section `Changed` : une entrée courte, pour
  l'utilisateur — rien ne change pour lui, sauf qu'un fork ou une lecture du code trouve
  chaque chose dans un dossier qui la nomme. Une ligne.

---

## 5. Les bonnes pratiques qui restent après le chantier

Ce sont elles qui empêchent `src/app/routes/mrs.js` de redevenir un `server.js` dans deux ans.
Chacune est soit vérifiée par `npm run check`, soit écrite dans `CLAUDE.md` ; une pratique qui
n'est ni l'un ni l'autre n'existe pas.

1. **Un fichier, une responsabilité, un nom qui la dit.** Le chemin est la documentation de
   premier niveau : `src/verify/verifyrun.js` dit sa couche et son rôle. Un fichier dont le
   nom demande un commentaire pour être compris est mal nommé.
2. **Taille surveillée** : avertissement à 600 lignes, échec à 1 200, exceptions nommées et
   décroissantes (§3.4). Un fichier qui approche 600 lignes se découpe **avant** la
   fonctionnalité qui l'y aurait poussé, dans un commit à part.
3. **La direction des dépendances est un contrôle, pas une intention.** `check-deps` échoue
   sur un import qui remonte (`git/` qui importe `app/`), sur un `gitlab.js` importé hors de
   `forge/index.js`, sur un cycle. Une exception s'ajoute dans le script, avec sa raison, et se
   relit en revue.
4. **Pas de fichier « barrel »** qui ré-exporte tout un dossier (`module.exports = { ...a,
   ...b }`). Ils recréent le module-dieu sous un autre nom, masquent qui dépend de quoi, et
   fabriquent des cycles. Seuls `db/index.js`, `jobs/index.js` et `forge/index.js` sont des
   points d'entrée, parce que le dossier **est** une unité (une base, une file, une porte). On
   importe le fichier, pas le dossier.
5. **Une route ne contient que du HTTP** : lire la requête, appeler un module métier,
   répondre. Une fonction de plus de trente lignes dans `app/routes/` est un signal qu'un
   morceau de métier s'y est glissé ; elle descend dans la couche qui le possède.
6. **Un déplacement est un commit, une amélioration en est un autre.** Le message dit
   lequel. Un commit qui déplace ET modifie ne se relit pas et ne se bisecte pas.
7. **`git mv`, jamais copier-coller-supprimer**, pour que `git log --follow` et `git blame`
   traversent le déplacement. Le codemod le garantit.
8. **Les `require` en tête de fichier, sauf raison écrite.** Un `require` paresseux dans une
   fonction est admis pour casser un cycle **en attendant** de le résoudre, avec un commentaire
   qui dit lequel ; `check-deps` les voit aussi, ils ne sont pas une échappatoire.
9. **Un commentaire de tête par fichier**, dans le style du projet : ce que le fichier fait,
   ce qu'il ne fait pas, et le module qui fait le reste. Les nouveaux fichiers de routes le
   reçoivent à la création.
10. **Un nouveau domaine, un nouveau dossier**, avec ses routes, son schéma, son module : le
    support Bitbucket de la roadmap, c'est `src/forge/bitbucket.js` et rien d'autre à toucher
    hors de `forge/index.js` — si ce n'est pas le cas, la structure a un défaut à corriger
    avant d'ajouter la fonctionnalité.

---

## 6. Risques, et ce qui les couvre

| Risque | Ce qui le couvre |
|---|---|
| Un contrôle statique cesse de voir un fichier déplacé | Étape 0 : parcours récursif, testé avec une faute volontaire dans un sous-dossier |
| Un test importe un chemin périmé | Le codemod réécrit tous les `require` ; un test qui échoue au `require` échoue fort (pas de skip silencieux) ; le compte de tests est comparé |
| Un fichier oublié dans l'index git, invisible localement | Replay CI depuis `git archive` à chaque fin d'étape (`CLAUDE.md`) |
| Une route change d'ordre et un chemin paramétré en avale un autre | Relevé des routes avant/après ; ordre de montage écrit dans `server.js` ; les tests HTTP |
| Le schéma d'une base neuve diverge de l'ancien | `.schema` trié d'une base neuve, identique byte-à-byte ; `table_info` d'une base migrée |
| `paths.js` ou un module lit l'env avant qu'il soit posé | Ne change pas : le codemod ne réordonne aucun `require` ; la règle « test qui ouvre la base réelle » suit les nouveaux chemins |
| Une branche fonctionnelle ouverte pendant l'étape 2 | `develop` fusionné dans `improve_sec` avant les étapes 1 et 2 ; pas de branche sur `server.js` / `db.js` pendant les étapes 2-3 ; `improve_sec` fusionnée dans `develop` dès l'étape 6 |
| La refonte dérive vers des améliorations « tant qu'on y est » | Règle 6 ; la revue Mergerie de chaque MR de refonte reçoit la consigne « signaler tout changement de comportement » |
| `scripts/demo-seed.js` (livré dans le paquet npm) importe des chemins périmés | Il est dans le périmètre du codemod ; `npm run demo` fait partie de la vérification de chaque étape |

## 7. Ordre de grandeur

| Étape | Durée | Commits |
|---|---|---|
| 0 — outillage et contrôles | 1 j | 3-4 |
| 1 — feuilles et dossiers | ½ j | 7 |
| 2 — `server.js` → `app/` | 3-4 j | ~20 |
| 3 — `db.js` → `db/` | 1-2 j | ~20 |
| 4 — `jobs.js` → `jobs/` | 1 j | ~11 |
| 5 — les cycles | 1-2 j | 7 |
| 6 — documentation | ½ j | 1-2 |
| **Total** | **8-11 j** | **~70** |

Un peu plus de deux semaines de travail sur `improve_sec`, à faire d'un trait plutôt que par
morceaux espacés : entre deux étapes, chaque branche fonctionnelle ouverte est un conflit de
plus à résoudre. La récompense est mesurable avec les mêmes outils qu'au §1 : dans six mois, la part
des commits touchant `server.js` (aujourd'hui 38 %) doit être tombée à celle du seul montage
des routes — quelques pour cent —, et un commit qui touche deux dossiers de `src/` doit être
l'exception qu'on explique, pas la norme.

---

## 8. Ce qui a été fait — et où l'exécution s'écarte du plan

Le chantier a été mené sur la branche `refacto` (créée depuis `develop` le 19 septembre 2026),
étape par étape, chaque étape commitée avec `npm run check` vert et la suite complète verte
(2 698 tests, 0 échec, 0 skip — le même compte qu'avant le premier déplacement). Le schéma d'une
base neuve et celui d'une copie de la base réelle sont identiques byte à byte avant et après
l'étape 3 ; le relevé des 351 routes (méthode + chemin) est identique avant et après l'étape 2.
Les écarts par rapport aux sections précédentes, et pourquoi :

- **Le codemod réécrit aussi `require.resolve(…)`** (§3.1) : un test qui vide le cache d'un module
  le nomme ainsi, et la première version du script l'avait manqué.
- **`server.js` a été découpé par un outil, en un commit** (§4.2 prévoyait seize commits) : un
  mini-lexer découpe le fichier en unités de premier niveau, une table les affecte à un fichier,
  et les `require` de chaque fichier généré se calculent d'après les identifiants qu'il utilise —
  reproductible, et relu par le relevé des routes plutôt que commit par commit. Les fichiers de
  routes s'accrochent à l'application en se chargeant (`const { app } = require('../app')`) au
  lieu d'exporter `monter(app)` : les corps restent au mot près, à la colonne près. Les helpers
  partagés par plusieurs fichiers de routes vivent dans `app/lib/` (par domaine : `sessions`,
  `verifications`, `visionneuse`, `jira`, `decouverte`…), pas seulement dans `http.js`. Les
  routes sont chargées dans l'ordre alphabétique : chaque paire « motif / chemin littéral » de
  même méthode a été relue, aucune ne change d'ordre. Deux états de module qui devaient traverser
  un fichier sont lus par une fonction (`lireJiraBadge`, `oublierChampSprint`) : un `let` exporté
  n'est qu'un instantané.
- **`db.js` est découpé en tranches CONTIGUËS, pas par table** (§4.3) : regrouper les 190 `ALTER`
  par table aurait changé l'ordre d'exécution des migrations, et rien ne permet de le vérifier
  sans une base de chaque version passée. Les dix-sept tranches de `db/schema/` sont des morceaux
  successifs de l'ancien fichier, jouées à la même place par `db/index.js` ; la règle « un ALTER
  dans le fichier de son CREATE » devient « dans la tranche qui a créé la table, ou une tranche
  ultérieure », ce que `npm run check` vérifie. `db/connexion.js` ouvre la base ; les tranches
  l'importent, comme les routes importent l'application.
- **`jobs/` tient par un registre** (§4.4) : les exécutants s'inscrivent dans `file.js`
  (`enregistrer('task', runTaskJob)`) au chargement, et l'ordonnanceur les lit par sorte de job.
  Sans ce registre, un exécutant qui enchaîne une vérification (`startVerifyJob`) importerait
  l'ordonnanceur qui l'importe — le cycle que l'étape 5 devait casser. `apres-session.js` porte ce
  qui s'enchaîne quand une session finit.
- **Les cycles étaient deux composantes, pas sept** (§1) : `git ↔ skillscan`, cassé par un
  abonnement (`git.surClone(fn)`) ; et une composante de douze fichiers autour du profil d'agent,
  cassée en trois commits : la grammaire des horaires sort de `schedule.js` (`agent/horaire.js`),
  le coût d'un fichier de connaissance sort de `knowledge.js` (`agent/knowledge-texte.js`), puis
  `agent/profile.js` devient `profile/{modele,prompt,apres,lancer}.js` — `modele` importable par
  tous, `lancer` seul à toucher `jobs/`, et la mise à jour de connaissance (`refreshKnowledge`)
  déménage de `knowledge.js` vers `lancer.js` pendant que `knowledge.js` ne fait plus que
  préparer son contexte (`preparerRefresh`). `taskrunner`, `knowledge`, `schedule` et l'exécutant
  de session importent les sous-modules directement ; `profile/index.js` garde l'interface
  d'avant pour `app/` et les tests. `CYCLES_CONNUS` est vide.
- **Trois modules ont changé de dossier en route**, parce que la matrice les a refusés :
  `retention.js` (ménage de session) en `session/`, `prompts.js` (constantes) en `core/`, et
  `decouperCommande` extraite de `verify.js` vers `core/commande.js` pour que `data/config.js`
  ne remonte pas vers `verify/`.
- **Deux tests unitaires lisaient des modules par chemin en dur** (`unit-session-followup-draft`,
  `unit-session-label`) : ils passent par `test/helpers/sources.js` (`lireSource('review/converge')`,
  `lireDossier('jobs')`). Un test qui vide le cache de `httpreq` a été suivi par le codemod.
- **La liste des exceptions de taille a rétréci de trois noms** (`server.js`, `db.js`, `jobs.js`) ;
  restent `store-registry`, `links`, `store`, `taskrunner`, `datasync`, à découper plus tard.
- **La documentation** : `PLAN.md` liste les modules par dossier ; `CLAUDE.md`, `CONTRIBUTING.md`,
  `SECURITY.md` et `CHANGELOG.md` sont à jour.

