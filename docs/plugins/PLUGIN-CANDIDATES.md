# Les prochains plugins : Liens, Docker, Git — et ce qui reste dans le cœur

Étape 0 bis. Relevé **en lecture seule** (rien n'est extrait ici) des trois onglets qui suivront
Jenkins, pour dimensionner le ctx **une fois** : chaque extraction suivante doit être un
déplacement, pas une primitive de plus. Même grille que `JENKINS-INVENTORY.md`.

---

## 1. Liens (`links`)

| Volet | Contenu |
|---|---|
| Serveur | `notes/links.js` (1 365 l. : grille services × environnements, liens libres, tags, **palette globale** avec frécence, import Chrome, collage d'adresses, liens d'une MR `liensDeMr`), `app/routes/links.js` (28 routes : `/api/links/*`, `/api/environments*`, `/api/services*`, `/api/free-links*`, `/api/context-links/:id`, `/api/launcher*`, `/api/mrs/:id/links`) |
| Tables | `environment`, `service`, `service_url`, `context_link`, `free_link`, `launcher_usage` (`db/schema/08-liens.js`) — toutes **L** |
| Front | `js/ecrans/liens/` 8 fichiers (1 781 l.), ports `loadLinks`, `naviguerGrilleLiens`, `pris` ; `html/ecrans/liens.html`, `html/modales/liens.html` (192 l.), `css/ecrans/liens.css` (463), `i18n/liens.js` (337) |
| Tâches de fond | aucune (santé des liens : « seulement si un client regarde », non implémentée) |
| Secrets | aucun ; validation `http(s)` de toute URL (« jamais ouverte par l'outil ») |
| Tissages **sortants** (Liens → noyau) | `liensDeMr(mr)` appelé par `routes/mrs.js` (boutons d'environnement sur la carte, `{branch}` substitué), `routes/repos.js` (fiche), `routes/jira.js` (?), `routes/jenkins.js` (`build-links`) ; la **palette Ctrl+K** (`notes/links.palette`) agrège pages, MR, dépôts, vérificateurs, **jobs Jenkins**, projets compose, commandes git — c'est un service transverse hébergé dans Liens |
| Démo | `demo-seed.js` sème environnements, services, liens |
| Tests | `e2e-liens-*`, `e2e-menu-transverse-palette`, `unit-links*` |

**Primitives nécessaires** : `db`, `http.router`, `ui.registerTab`, `ui.registerSettingsTab`
(environnements), `ui.registerAction({target:'mr'})` (boutons d'environnement sur la carte),
`ui.registerAction({target:'repo'})` (fiche), **`ui.registerPaletteProvider(fn)`** (ses entrées),
**`ui.registerImporter({label, run})`** (Chrome), `demo.seed`, `i18n.register`.

**Ce qui doit REMONTER dans le cœur avant l'extraction** : la **palette** elle-même (agrégation,
frécence `launcher_usage`, raccourci Ctrl+K) — elle sert tous les écrans ; Liens n'en est qu'un
fournisseur parmi sept. `liensDeMr` doit devenir une **requête de service** entre plugins (Jenkins
→ Liens) ou un décorateur de MR fourni par Liens.

## 2. Docker (`docker`)

| Volet | Contenu |
|---|---|
| Serveur | `integrations/docker.js` (~810 l. : `docker ps/inspect/compose`, `spawn` sans shell via `git/git.run`, **cibles Makefile en liste blanche** l. 379, `spawnLogs` = processus long `docker logs -f`, `summary`, `estTombe`, `nomsConnus`), `app/routes/docker.js` (21 routes dont **`GET /api/docker/logs/stream` en SSE** l. 223, `bulk-action`, `preview-down`, `make/run`), `demo/docker.js`, `jobs/runners/docker.js` (actions compose exécutées **dans la file de jobs** du cœur) |
| Tables | `docker_backup` (**L**, `06-depots-reviews-git.js:17`) ; `local_root` (répertoires locaux, partagée avec Git/Dépôts) |
| Front | `js/ecrans/docker/` (ports `loadDocker`, `showDockerSub`, `refreshDockerBadges`, `marquerDockerVu`, `dockerStateLabel`, `dlogStop`), **poll santé 30 s** dans `demarrage.js:66` (pastilles err/warn du menu), logs multi-conteneurs en flux |
| Tâches de fond | `veille.tourDocker` (60 s, transition « tournait → tombé » → `notify.push('docker_down')`, décochée par défaut) ; `dockerTombes()` lu par le **brief** (`notes/brief.js:362-408`, section Docker sans réseau) |
| Secrets | aucun ; opérations **destructrices avec aperçu** (`preview-down` → confirmation) |
| Tissages **sortants** (Docker → noyau) : 18 importateurs de `integrations/docker.js` | `lib/decouverte.js`, `lib/jira.js`, `routes/{activite,git,jira,jira-spec,links,mrs-resume,notes,verifications}.js`, `jobs/{index,ordonnanceur}.js`, `veille.js`, `server.js` — à relire un par un : la plupart n'utilisent que `isDemo()`/`nomsConnus()`/`gitDuRepertoire()` ; les **vérificateurs** peuvent cibler un compose (`routes/verifications.js`) ; la **file de jobs** porte un runner docker |
| Démo | `demo/docker.js` (statique), `demo-seed.js` (sauvegardes) |
| Tests | `e2e-docker*`, `e2e-veille` (bloc Docker, bouchonne `docker.status/listContainers` **dans le processus**), `unit-docker*` |

**Primitives nécessaires** : `db`, `http.router`, **`http.sse(path, producer)`** (logs), **`exec(bin,
args, {cwd, timeout, allowlist})`** (docker, docker compose, make), `schedule` (veille 60 s),
`ui.registerTab` (avec **deux pastilles** err/warn et **poll 30 s** côté front), **`ui.confirm({preview})`**,
`notify.registerKind('docker_down', default:false)`, **`ui.registerBriefSection`**, `demo.seed` +
`demo.isDemo`, `events.emit('docker.container.down')`, `i18n.register`, et **`jobs.enqueue`** ⚠
(les actions compose passent aujourd'hui par la file de jobs du cœur — soit la file devient une
primitive publique `ctx.jobs.run({label, fn})`, soit le plugin exécute hors file et perd « Stop »,
le journal et la sérialisation ; décision à prendre avant Docker, pas avant Jenkins).

## 3. Git (`git`) — l'onglet, pas la couche

Distinguer **la couche `src/git/`** (service du cœur : `git.js` spawn générique + redaction,
`integrite.js`, `diffnum.js`, `conflits.js` utilisés par sessions, reviews, agents) de **l'onglet Git**
(explorateur, actions sur refs, comparer, merge assisté, commandes, tags par période).

| Volet | Contenu |
|---|---|
| Serveur (onglet) | `git/gitops.js` (349 : créer/supprimer branches et tags, journal `git_op`, restauration), `git/gitmerge.js` (377 : merge assisté, worktrees du dataDir, **`session/mergeai.js` l'importe** pour « Résoudre avec l'IA »), `git/gitgraph.js` (167 : ahead/behind), `git/localrepos.js` (391 : clones locaux, **palette de commandes `git_command` en liste blanche**, `spawn('git', tokens)` sans shell, **refus des flags à exécution arbitraire** l. 270), `git/gitpalette.js`, `git/resolution.js` (**`review/reviewer.js` l'importe**), `app/routes/{git,git-compare,git-merge}.js` (27 routes), `lib/branches.js` (annotation des branches : MR, ticket, verdict, session, **Jenkins**), `jobs/runners/gitops.js` (opérations git **dans la file de jobs**) |
| Tables | `git_command`, `git_op` (**L**), `git_merge` (merges en cours, **lue par le brief**), `local_root` |
| Front | `js/ecrans/git/` 7 fichiers (2 311 l.), ports `loadGit`, `showGitSub`, `gitAnalyze`, `brMergees`, `gitLoadRefs`…, `html/ecrans/git.html` (242), `i18n/git.js` (715) ; porte contextuelle « Résoudre dans Git → Merge » depuis une MR en conflit (`navigation.js:33`) |
| Tâches de fond | aucune ; `git.nettoyerOrigines` au démarrage est **cœur** |
| Secrets | jetons de forge dans les URL d'`origin` (redaction par `git.js`, cœur) |
| Tissages **sortants** | `session/mergeai.js` → `gitmerge` ; `review/reviewer.js` → `resolution` ; `agent/copilot.js` → `conflits` ; `routes/repos.js`, `routes/docker.js` → `localrepos` ; `jobs/index.js` → `gitops` ; `lib/branches.js` annote avec des données de 4 domaines |
| Démo | `demo/git.js`, `demo-seed.js` (merge à moitié résolu, `git_op`, `git_command`) |
| Tests | `e2e-git*`, `unit-git*`, `unit-gitops*`, `e2e-menu-git-*` — plusieurs **importent `src/git/*` au premier niveau** |

**Primitives nécessaires** : `db`, `http.router`, **`exec('git', args, {cwd, timeout, allowlist:
['fetch','branch','tag','push','log','rev-parse','merge','rebase',…], denyFlags: ['-c','--exec',
'--upload-pack',…]})`**, **`repos`** (registre : dépôts suivis, clones, `local_root`, chemins), **`jobs.run`**
⚠ (opérations git dans la file), `ui.registerTab`, `ui.registerSettingsTab` (palette de commandes),
`ui.registerPaletteProvider` (commandes git), `ui.registerAction({target:'mr'})` (« Résoudre dans Git »),
`ui.registerBriefSection` (merges en plan, opérations en échec), `notify.registerKind('git_done')`,
`events.on('session.finished')`, `demo.seed`, `i18n.register`.

**Ce qui doit REMONTER ou rester dans le cœur** : `gitmerge` (utilisé par les sessions IA pour la
résolution de conflits), `resolution` (reviews), `conflits` (agent), `git.js`, `integrite.js`,
`diffnum.js`, `localrepos` (dépôts/clones : registre `ctx.repos`), `lib/branches.js` (devient
l'explorateur du plugin, et ses 4 annotations deviennent 4 décorateurs `registerDecorator('branch')`).
Git est le plus couplé des trois : **la moitié de `src/git/` est un service du cœur**.

## 4. Les primitives que le ctx doit offrir dès maintenant

Union des quatre inventaires. En gras : exercée par Jenkins (éprouvée par l'extraction) ; en
italique : prévue pour Liens/Docker/Git, **non éprouvée** tant qu'un plugin ne l'utilise pas.

| Primitive | Permission | Jenkins | Liens | Docker | Git |
|---|---|---|---|---|---|
| **`events.on/emit/off`** | events | ✔ | ✔ | ✔ | ✔ |
| **`settings.get/set`** (+ schéma, + portée `team`/`machine` ⚠) | settings | ✔ | ✔ | ✔ | ✔ |
| **`secrets.get/set`** (masque `***`, lié à une URL) | secrets | ✔ | | | |
| **`db`** (préfixe, migrations, P/L/C) | db | ✔ | ✔ | ✔ | ✔ |
| **`http.router`** | http | ✔ | ✔ | ✔ | ✔ |
| *`http.sse(path, producer)`* | sse | | | ✔ | |
| **`schedule/unschedule`** | schedule | ✔ | | ✔ | |
| *`exec(bin, args, {cwd, timeout, allowlist, denyFlags})`* | exec ⚠ avertissement | | | ✔ | ✔ |
| **`repos`** (liste, `byId`, chemins de clone, `onRemoved`) | repos | ✔ | ✔ | ✔ | ✔ |
| *`jobs.run({label, fn})`* (file de jobs du cœur, Stop, journal) | jobs | | | ✔ | ✔ |
| **`net.request`** (HTTP sortant, TLS épinglable) | net | ✔ | | | |
| **`ui.registerTab`** (icône SVG, replié d'office, `onOpen`, recherche, liste `j/k`, raccourci, onboarding) | ui.tab | ✔ | ✔ | ✔ | ✔ |
| **`ui.registerSettingsTab`** (schéma + rendu libre, suit le menu) | ui.tab | ✔ | ✔ | | ✔ |
| **`ui.setBadge(tabId, {count, failed, warn})`** | ui.tab | ✔ | | ✔ | |
| **`ui.registerAction({target, label, when, handler})`** cibles `mr`, `session`, `branch`, `verification`, `repo` | ui.actions | ✔ | ✔ | | ✔ |
| **`ui.registerDecorator({target:'mr'\|'branch', render})`** | ui.actions | ✔ | ✔ | | ✔ |
| **`ui.registerPaletteProvider(fn)`** (serveur, sans réseau) | ui.palette | ✔ | ✔ | ✔ | ✔ |
| *`ui.registerImporter`* | ui.palette | | ✔ | | |
| *`ui.confirm({title, text, preview})`* (front, kit) | ui.tab | ✔ (lancer) | | ✔ | ✔ |
| **`ui.registerBriefSection`** | ui.actions | ✔ | | ✔ | ✔ |
| **`notes.registerLinkKind`** | ui.actions | ✔ (`build`) | | ✔ (`container`) | ✔ (`branch`) |
| **`notify.registerKind` + `notify.push`** | notify | ✔ | | ✔ | ✔ |
| **`log`** | — | ✔ | ✔ | ✔ | ✔ |
| **`demo.seed` + `demo.isDemo`** | demo | ✔ | ✔ | ✔ | ✔ |
| **`i18n.register`** (serveur **et** front) | — | ✔ | ✔ | ✔ | ✔ |
| **`env.get(name)`** (liste blanche `<PLUGIN>_*`) | env | ✔ | | | |

Vingt-six primitives contre quinze dans la liste fermée du prompt. Les onze de plus sont toutes
exigées par **Jenkins seul** sauf `sse`, `exec`, `jobs.run`, `registerImporter`, `confirm` (cinq
« non éprouvées »).

## 5. Ce qui reste dans le cœur, de façon permanente

**Noyau** : serveur HTTP et ses gardes (origine, jeton local, CSP, en-têtes), base SQLite et
migrations, `core/` entier (chemins, processus, HTTP sortant, i18n, notifications, prompts,
identité), file de jobs (`jobs/`), **loader de plugins et bus d'événements**, démo (`demo/shared`),
sauvegarde, rétention, données partagées (`store`, `datasync`, `store-registry`), Réglages (coquille,
onglets du noyau, page Plugins), palette Ctrl+K (agrégateur), notifications bureau (ring buffer,
cases à cocher), menus, raccourcis, thème, i18n, kit de composants front.

**Services métier** : sessions de codage et agents IA (`session/`, `agent/`), forges GitLab/GitHub
(`forge/`), reviews et convergence (`review/`), vérificateurs (`verify/`), Jira (+ brief technique,
Confluence), Notes / brief / todos (`notes/notes.js`, `notes/brief.js`, `notes/discover.js`), la
couche git de service (`git/git.js`, `integrite`, `diffnum`, `conflits`, `resolution`, `gitmerge`),
le registre des dépôts et répertoires locaux (`data/localdirs`, `git/localrepos`).

Tout onglet hors de cette liste — Jenkins, Liens, Docker, Git (onglet), et demain Statistiques ou
Jira si on le décidait — doit pouvoir devenir un plugin sans toucher au cœur. Un tissage entre un
onglet du cœur et un plugin (Liens ↔ cartes MR, Docker ↔ vérificateurs, Git ↔ MR en conflit) passe
par `registerAction`/`registerDecorator` ou par un événement, jamais par un `require`.

## 6. Ordre d'extraction recommandé : Liens → Docker → Git

1. **Liens** d'abord : aucune tâche de fond, aucun secret, aucune commande, des tables toutes
   locales, 28 routes CRUD. Une seule chose à remonter avant (la palette), et deux primitives
   nouvelles à éprouver (`registerPaletteProvider` côté fournisseur, `registerImporter`). C'est
   aussi celui dont Jenkins dépend (`build-links`) : extraire Liens tôt force à poser le tissage
   plugin ↔ plugin proprement.
2. **Docker** ensuite : il apporte `exec` (liste blanche, pas de shell), `sse` (logs), `confirm({preview})`
   et la question de la file de jobs — quatre primitives à risque, mais sur un domaine
   **sans écriture dans le travail de l'équipe** : une erreur d'isolation n'y corrompt ni une
   review ni une session.
3. **Git** en dernier : le plus couplé (la moitié de `src/git/` est un service du cœur, trois
   modules importés par sessions/reviews/agents, `lib/branches.js` annote avec quatre domaines,
   opérations dans la file de jobs, tests qui importent `src/git/*` directement). Il profite de
   tout ce que Docker aura éprouvé (`exec`, `jobs.run`) et de `repos` posé pour Liens et Jenkins.
   Il faut d'abord **découper `src/git/`** en service (reste) et onglet (part), ce qui est un
   chantier à part entière.
