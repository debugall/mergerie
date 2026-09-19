# Mergerie — Architecture

Application locale mono-utilisateur (Node + Express + SQLite + front vanilla) pour :
1. **Reviewer** les merge requests GitLab **et les pull requests GitHub** assisté par IA (via un CLI d'agent ; le gabarit de prompt peut invoquer un skill, il n'en impose aucun).
2. Piloter des **sessions de dev** automatisées (l'IA modifie le code, commit, push, ouvre/merge la MR).
3. **Explorer du code en lecture seule** : poser une question sur un ou plusieurs dépôts et obtenir une réponse de synthèse en Markdown.


> **Convention de vocabulaire.** Tout le code manipule la forme normalisée héritée de GitLab : une
> *pull request* GitHub est traduite en « MR » par `github.js` (`number`→`iid`, `head.ref`→`source_branch`…).
> Dans ce document, **« MR »** désigne donc les deux, et aucun module en amont ne distingue les forges.

## Stack

- **Back** : Node 22.9+ + Express. Shelle `git` et le binaire d'agent (`copilot`/`claude`) via `child_process`. Clients HTTP GitLab et GitHub en `https`/`http` natif (agent TLS scopé par forge). `gpt-tokenizer` (pur JS, hors-ligne, **optionnel** : repli sur estimation) pour le comptage de tokens du footer.
- **BDD** : SQLite via `better-sqlite3` (fichier unique, migrations `ALTER TABLE` idempotentes au démarrage).
- **Front** : SPA vanilla (HTML/CSS/JS), servie en statique, **zéro dépendance réseau** au runtime (rendu markdown + coloration syntaxique maison).
- **`public/vendor/`** : les bibliothèques tierces posées telles qu'elles sont publiées, plutôt qu'installées — `mermaid.min.js` (12.0.0, MIT, 5,4 Mo) rend les blocs ` ```mermaid ` des notes. En npm, mermaid c'est 23 dépendances directes et 124 Mo décompressés pour un fichier dont le navigateur a seul besoin ; le dépôt garde ses **trois** dépendances runtime et `npm install` sa durée. Chargé **à la demande**, au premier diagramme rencontré dans un rendu, jamais depuis un CDN. Voir `public/vendor/README.md` pour la mise à jour.

## Modules (`src/`)

Rangés par **couche** depuis la réorganisation de septembre 2026 : une couche n’importe que ce qui est en dessous d’elle, et `npm run check` (`scripts/check-deps.js`) refuse un import qui remonte, un cycle, ou `gitlab.js` importé hors de `forge/`.

```
app  →  jobs  →  session · review · verify · agent · notes · integrations
                          ↓
                    forge · git · data · db
                          ↓
                        core
```

Un fichier se déplace avec `node scripts/move-module.js <ancien> <nouveau>`, qui réécrit tous les `require` ; un test qui lit un module comme du texte le retrouve par `test/helpers/sources.js` (`lireSource('session/taskrunner')`), jamais par un chemin en dur.

### `core/`

Les briques sans métier : chemins, processus, HTTP, identité git, notifications, prompts, traduction. N’importe rien hors de `core/`.

| Fichier | Rôle |
|---|---|
| `core/commande.js` | découper une ligne de commande en mots, sans shell — partagé par les vérificateurs, la dictée et la validation des réglages |
| `core/dirhash.js` / `data/localdirs.js` | l'empreinte d'un chemin local (pur, utilisable pendant les migrations) et sa résolution sur CE poste |
| `core/garde.js` | accès : hôte admis, site étranger, adresse de dépôt admise, jeton d'accès (voir *Sécurité*) |
| `core/glob.js` | matching glob minimal (gitignore-like) pour les **règles par chemin** et le badge « risque » |
| `core/httpreq.js` | requête HTTP(S) bas niveau partagée par les clients de forge + fabrique d'**agent TLS scopé** (`GITLAB_CA_CERT`/`GITLAB_INSECURE_TLS`, `GITHUB_CA_CERT`/`GITHUB_INSECURE_TLS`) ; timeout de 30 s (sans lui, une forge qui ne répond jamais gèlerait la file de jobs) |
| `core/i18n.js` | le dictionnaire du serveur (`public/i18n-runtime.js`) à une profondeur près : tout module traduit avec `require('…/core/i18n')`, et `npm run check` reconnaît à cet import que `t` y est réservé |
| `core/identite.js` | l'identité git du poste — pas de compte Mergerie, pas de mot de passe |
| `core/nonfiable.js` | balisage à nonce des données non fiables dans les prompts |
| `core/notify.js` | **ring buffer en mémoire** des événements (notifications bureau) : `push`/`since`/`latestId` |
| `core/paths.js` | chemins des données ; `MERGERIE_DATA_DIR` pour isoler `data/` |
| `core/proc.js` | suivi du process enfant courant + annulation (Stop) ; enfants lancés en groupe (`detached`), « Stop » tue le groupe entier (`tuerGroupe`), `tuerTout` à l'arrêt du serveur |
| `core/ulid.js` | l'identité qui survit au partage : ULID triable par date (monotone dans la milliseconde), `slugifier` / `slugLibre` pour les noms de fichiers. Aucune dépendance |

### `db/`

Le schéma SQLite : la connexion, la réparation, dix-sept tranches chronologiques jouées dans l’ordre de `index.js`. N’importe que `core/` et le registre des familles.

| Fichier | Rôle |
|---|---|
| `db/connexion.js` | ouvre la base, pose les PRAGMA et la fonction SQL `mergerie_ulid()` ; rien d’autre |
| `db/index.js` | schéma SQLite + migrations ; reset des jobs `running` au boot ; `local_config` (drain des réglages de poste, **assertion de colonnes gelées**) ; déclencheurs `uid` et reprise des `slug` |
| `db/index.js` | la table des matières : la réparation, puis les tranches de `schema/` dans l’ordre, puis les jobs coupés et `reconcilierTravauxCoupes` ; exporte la base prête |
| `db/reparation.js` | ce qui se répare avant la moindre écriture (déclencheurs orphelins) |
| `db/schema/` | dix-sept tranches CONTIGUËS de l’ancien `db.js`, chacune un morceau du fichier à sa place — l’ordre des migrations n’a pas changé ; une nouvelle colonne va dans la tranche qui a créé sa table ou dans une tranche ultérieure, jamais avant (`npm run check`) |

### `data/`

« Le dossier de fichiers EST la base » et son transport : le registre des familles, le store, la synchro git, la configuration coupée en deux, l’état de poste, les approbations, la sauvegarde.

| Fichier | Rôle |
|---|---|
| `data/approbation.js` | approbation locale de ce qui exécute du code arrivé par la synchro (voir *Sécurité*) |
| `data/config.js` | lecture/écriture de la config — **deux tables, un seul objet** : `config` (équipe) et `local_config` (ce poste), le registre disant la destination de chaque champ |
| `data/configagent.js` | arrêt quand une branche modifie la configuration d'agent (`CLAUDE.md`, `.claude/`…) |
| `data/datasync.js` | git comme moyen de transport : commits groupés, boucle pull-rebase-push, conflits résolus sans jamais bloquer, historique d'un fichier. Ne connaît que des fichiers — aucune ligne |
| `data/localsession.js` | le handle d'une session d'agent : il ne vaut que dans le `~/.claude` du poste qui l'a créé |
| `data/localstate.js` | `local_state` (état dérivé de ce poste) et `local_pref` (préférences de ce poste), même forme, durées de vie différentes |
| `data/store-registry.js` | **la famille de chaque table** : P (partagé, part dans le dépôt d'équipe), L (local), C (cache reconstructible), avec le nom de fichier, la stratégie de fusion et les colonnes qui ne sortent jamais. Pur : aucun `require` vers la base, donc lisible par `npm run check` et par les tests |
| `data/store.js` | **le dossier de fichiers EST la base** : sérialisation déterministe, écriture fichier+SQLite dans une seule transaction, export complet, hydratation complète et incrémentale, traduction des références par clé naturelle |

### `forge/`

GitLab et GitHub derrière une seule porte : `index.js` (`clientFor`) est le seul à importer `gitlab.js` et `github.js` — `npm run check` le vérifie.

| Fichier | Rôle |
|---|---|
| `forge/github.js` | client API GitHub REST v3, **même interface que `gitlab.js`**. Traduit PR → MR (`number`→`iid`, `head.ref`→`source_branch`, `merged:true`→`state:'merged'` — GitHub dit `closed` pour une PR mergée), issue comments + review comments → **discussions** (fils reconstruits via `in_reply_to_id`), position inline (`commit_id`/`path`/`line`/`side`) ↔ position GitLab. Pagination par header **`Link`** (pas de compteur de pages), `User-Agent` obligatoire (403 sinon), 403 + `X-RateLimit-Remaining: 0` → message de quota dédié. GitHub Enterprise : base `<url>/api/v3` |
| `forge/gitlab.js` | client API v4 : MR, projets, branches (avec SHA), **dernier commit** (`latestCommit`), **tags**, **refs protégées**, **création/suppression de branche et tag**, discussions, merge, notes ; agent TLS scopé + messages d'erreur explicites |
| `forge/index.js` | **aiguillage de forge** : `clientFor(repo)` renvoie `gitlab.js` ou `github.js` selon `repo.forge`. **Règle du projet : aucun autre module n'appelle un client en direct.** Les deux clients exposent la MÊME interface et la même forme normalisée, donc aucun appelant n'a de branche `if (github)`. Aussi : `isConfigured(cfg, forge)`, `refUrl` (URL web d'une ref, format propre à chaque forge) |

### `git/`

Le clone local et ce qu’on en fait : commandes, opérations multi-dépôts, merge de branche à branche, explorateur, numérotation des diffs.

| Fichier | Rôle |
|---|---|
| `git/git.js` | clone/fetch (SSH ou HTTPS+token), diff ciblé `target...source` & **diff delta** `reviewed_sha..current_sha` (re-review incrémentale) & contexte complet, arbre, contenu de fichier, création de branche, commit, push, **tagger d'un tag annoté** (`tagAuthor`), **branches portant un commit** (`branchesForCommit`, pour « sur quelle branche ce tag a-t-il été posé ») ; **remise à zéro défensive du worktree** avant une session de codage ; masquage du token dans les logs |
| `git/gitgraph.js` | analyse du graphe des branches (clone local) : ahead/behind, « mergée dans », origine **inférée avec niveau de confiance** |
| `git/gitops.js` | opérations multi-dépôts (onglet Git) : aperçu, exécution via l'API, **restauration** d'une suppression (fetch de sécurité + SHA journalisé) |
| `git/gitpalette.js` | liste blanche de la palette git |
| `git/resolution.js` | suivi de résolution : parsing des constats structurés, empreinte stable, **garde-fou git** (résolu ↔ disparu), diff entre passes |

### `agent/`

L’agent CLI et la mécanique d’une session : le pilote du binaire, les arguments, la politique, les passes, les pièces, les skills, la connaissance d’un agent de domaine, l’horaire, et le profil (`profile/`, quatre modules sans cycle).

| Fichier | Rôle |
|---|---|
| `agent/aisession.js` | banc d'essai « reprise de session » (endpoint `POST /api/ai-sessions/test`) : deux passes (mémorise un marqueur → le rappelle en reprise) via `agentsession`, simulé en dry-run |
| `agent/args.js` | **options d'un profil d'agent → argv**. `argsFor(backend, options)` rend `{ args, ignored }` : sur `claude`, `--model`, `--append-system-prompt` (JAMAIS `--system-prompt`, qui remplacerait le `CLAUDE.md` du dépôt et ses skills), `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--agents <json>`, `--add-dir` ; sur `copilot`, `--model` seul, le reste dans `ignored` (annoncé au journal du run). **Invariant : sans options, `args = []`** — l'argv d'une session ordinaire est byte-identique à celui d'avant les agents. `validate()` refuse à la SAUVEGARDE ce qui échouerait au lancement (`permission-mode default` : stdin est fermée, personne ne pourrait répondre) |
| `agent/copilot.js` | runner de l'agent (`<bin> [args] -p <prompt>`), streaming ligne à ligne, **mode dry-run** (mock depuis le diff) |
| `agent/defaults.js` | les textes des trois agents livrés, en fr et en en : enquêteur, documentaliste, cartographe (+ le gabarit du document de connaissance) |
| `agent/horaire.js` | la grammaire d’un horaire d’agent (`daily 07:00`, `weekly mon 07:00`…) : lire, canoniser, prochain créneau, phrase — pur, importable par le profil sans dépendre du ticker |
| `agent/input.js` | **ce que Mergerie écrit POUR l'agent**, à la racine des clones (qui n'appartient à aucun dépôt) sous `ai-dev-tools-internal/` : `recent.md` (MR mergées sur 7 jours + adresses des services, plafonné à 30 000 caractères et coupé par dépôt), `knowledge.md`, et pour une mise à jour `knowledge-previous.md` / `gaps.md` / `commits.md` |
| `agent/knowledge-texte.js` | le fichier d’une version de connaissance et son coût en tokens — séparé pour que la fiche d’un agent l’affiche sans que `knowledge.js` et le profil se referment en cycle |
| `agent/knowledge.js` | **la connaissance d'un agent de domaine** : `parseHeader` (`<<<AGENT>>>`), `verifierChemins` (ouverts SOUS le clone ; `..` et chemins absolus → non vérifiés), `ingest` (création directe / mise à jour `pending`), `conserverNotes` (« Notes de l'équipe » recopiée **par le code**), `activer`, `editer`, `addGaps`, `age` (commits depuis le SHA sur les chemins cités — sans IA, cache 1 h), `refresh`, `diffSummary`, `indexFor` (≤ 4 000 caractères), `publierDansNotes` |
| `agent/pass.js` | **historique des itérations** d'une session : une ligne `agent_pass` par passe (prompt réellement envoyé + `output-v<N>.md`, et sur dépôt le patch `diff-v<N>.patch` de cette seule passe), pour les sessions sur dépôt (`scope='task'`) comme pour le codage hors dépôt (`scope='local'`). Même motif que `review_version` : chaque passe écrit son fichier, `output_path` de l'unité pointe la plus récente, rien d'autre ne change. Une seule table pour les deux familles → pas de clé étrangère possible, d'où le nettoyage explicite aux suppressions |
| `agent/policy.js` | permissions de l'agent par saveur, environnement en liste blanche, bornes (tours, dépense) |
| `agent/profile/apres.js` | ce qu’on fait de la sortie d’un run réussi : carte de connaissance, page de notes, sous-pages, entrées d’un agent de fichier |
| `agent/profile/index.js` | **du profil au lancement** : CRUD + `valider()`, `optionsFor(task)` (options de `runInSession`, allowlist par défaut selon `kind`), `systemPromptFor()` (en-tête fabriqué + rôle + index de connaissance), `composer()` (la demande : skills → gabarit → fichiers d'entrée → sous-agents → consignes permanentes → protocoles), `materialize()`/`lancer()` (**`auto_push` toujours 0** : un agent ne pousse jamais de lui-même), `apresRun()` (page de notes / création d'agent / écarts), `seedBuiltins()` (jamais de réécriture d'une ligne existante) |
| `agent/profile/lancer.js` | lancer un agent (une `task` dans la file) et mettre à jour sa connaissance — le seul module du profil qui touche `jobs/` |
| `agent/profile/modele.js` | le profil : lire, lister, valider, créer, modifier, dupliquer, supprimer, restaurer, et sa fiche (`decorer`) — importable par tous |
| `agent/profile/prompt.js` | d’un profil aux options du CLI, au prompt système, à la demande composée avec la connaissance, aux cibles, à la matérialisation d’un run |
| `agent/protocol.js` | les trois blocs de service d'un run d'agent : `<<<REPO>>>` (l'enquêteur nomme le dépôt trouvé), `<<<AGENT>>>` (le cartographe décrit l'agent à créer), `<<<STALE>>>` (un agent de domaine signale un écart). `extraire` / `lignes` / `nettoyer`. **Un bloc mal formé n'est jamais une erreur de run** : le run a travaillé, c'est le protocole qui a raté |
| `agent/questions.js` | protocole du bloc `<<<QUESTIONS>>>` : instruction de prompt + `parseQuestions` (JSON strict, 5 max, malformé → ignoré) + `buildAnswerInstruction` (reprise) — calque des `FINDINGS` |
| `agent/schedule.js` | **horaires** : `daily HH:MM` / `weekly <jour> HH:MM` / `monthly 1..28 HH:MM` (pas cron — trois cas qu'on relit sans manuel). `prochainCreneau` raisonne sur le DERNIER créneau passé, ce qui rattrape un rendez-vous manqué au lieu de le perdre ; `tick()` respecte `config.agent_auto_max` et écrit `schedule_fired_at` même quand le plafond bloque (sinon on réessaierait chaque minute) |
| `agent/session.js` | **reprise de session d'agent** : `runInSession({ key, handle, cwd, resume })` — claude `--session-id`/`--resume`, copilot `COPILOT_HOME` isolé + `--continue` (auth importée par symlink). Utilisée par `taskrunner`, `reviewer`, `converge` ; repli one-shot `copilot.runPrompt` si backend inconnu / dry-run (le comptage de tokens passe alors par `copilot.recordUsage`). `resumeCommand(backend, handle, cwd)` bâtit la **commande de reprise au terminal** (bouton « Reprendre au terminal ») : `cd '<cwd>' && claude --resume <id>` / `… COPILOT_HOME='<home>' copilot --continue` (shell-quotée). Le `cd` n'est émis que si le cwd est CONNU — il ne l'est pas pour une session fournie à la création : le bouton doit exister quand même, sans quoi il disparaîtrait précisément dans le cas où l'on cherche cette session |
| `agent/skillscan.js` | **découverte des skills et sous-agents de fichier** : `.claude/skills/<nom>/SKILL.md` et `.claude/agents/<nom>.md` des dépôts clonés et du home (`MERGERIE_CLAUDE_HOME` pour les tests). Frontmatter minimal maison — `user-invocable`, `disable-model-invocation`, `allowed-tools`/`tools` ; sans frontmatter, le nom vient du dossier. Cache mémoire 5 min, invalidé par `git.ensureRepo` et par `POST /api/skills/rescan`. **Lecture seule, jamais d'écriture dans un `.claude/`.** `ligneSkills()` compose la ligne `/mon-skill` qui ouvre la demande, en RÉSOLVANT les skills cochés contre le disque (un corps de requête ne peut pas injecter de texte en tête du prompt) |
| `agent/tasks.js` | **création d'une session, en un seul endroit** : `POST /api/tasks` et `agentprofile.lancer()` appellent la même `creerTask` — deux insertions parallèles auraient divergé au premier champ ajouté, et un run d'agent aurait cessé d'être une session |

### `review/`

La review d’une merge request et sa convergence.

| Fichier | Rôle |
|---|---|
| `review/converge.js` | **« Converger »** : orchestrateur (machine à états) review → correction IA (commit + push) → re-review incrémentale, jusqu'au seuil / à la régression / au plafond ; **`convergeSession`** : depuis une session de dev (dev → push → crée la MR → upsert → `convergeRun`), par projet en série |
| `review/note.js` | extraction de la note globale d'un rapport (texte libre) |
| `review/reviewer.js` | pipeline de review : clone → diff → prompt(s) → écriture fichier → BDD ; contexte ticket + règles ; modif IA ; re-review incrémentale |

### `session/`

Les sessions de codage : sur dépôt, hors dépôt, question libre, instantanés, rétention.

| Fichier | Rôle |
|---|---|
| `session/asker.js` | **« Question libre »** : une question posée à l'IA SANS dépôt ni dossier, et sa réponse gardée. C'est l'exploration débarrassée du code — donc ni clone, ni checkout, ni garantie de lecture seule à tenir. L'agent tourne dans un dossier à lui (`tasks/ask/<id>/`) : un `cwd` STABLE est ce qui rend la session reprenable (`ask-{id}`), et un agent qui décide d'écrire un fichier ne doit pas le semer ailleurs. La réponse est écrite dans un fichier par l'agent, pas lue sur la sortie standard — où elle arrive tronquée et mêlée à ses traces |
| `session/localcoder.js` | **« Codage hors dépôt »** : l'IA réalise le prompt dans des dossiers locaux arbitraires, en place, **sans git dans le dossier de l'utilisateur** (ni branche, ni commit, ni push ; le diff par itération passe par `localsnapshot.js`). **Session reprenable par dossier** (`local-{taskId}-dir-{dirId}`) → `runLocalFollowup` (« Envoyer un suivi ») rejoue une passe en REPRENANT la session de chaque dossier ; `saveAgentOutput` écrit le **retour de l'agent** (`output.md` → `local_task_dir.output_path`, bouton « Retour de l'IA ») |
| `session/localsnapshot.js` | **Ce qu'une itération hors dépôt a changé**, sans rien poser chez l'utilisateur : un dépôt de suivi dont le `.git` vit sous `data/tasks/local/<task>/<dir>/suivi.git` et dont `core.worktree` pointe le dossier de l'utilisateur. Deux commits par passe (`avant`/`apres`, `--allow-empty` pour pouvoir dire « rien n'a changé ») et le diff entre les deux. Respecte le `.gitignore` du dossier, plus une liste de dossiers d'artefacts ; **garde-fou** de volume (20 000 fichiers / 512 Mo) évalué une seule fois, avec un témoin sur disque — au-delà on renonce et l'écran se tait, plutôt que de ralentir le codage. **Ménage automatique** (`menage()`, branché sur `retention.demarrer` : au démarrage puis une fois par jour) — supprime les dépôts que plus aucun `local_task_dir` ne référence, compacte les autres (`gc --auto`). Best-effort de bout en bout |
| `session/taskrunner.js` | pipeline de dev session : branche → prompt IA → commit → diff → push ; **session reprenable par cible** (`task-{taskId}-target-{tgId}`) → **continuité** : run initial / followup / relance / reprise après questions / passes de convergence reprennent la même session — y compris une session **fournie à la création** (voir `task_target.session_key`). L'**exploration** tourne elle aussi dans une session (`explore-{taskId}`, cwd = racine des clones, partagée par toutes ses cibles ; son « Reprendre au terminal » vit donc au niveau de la CARTE et non de chaque projet — le répéter par ligne afficherait N fois la même commande) : une question de suivi la REPREND au lieu de recoller la réponse précédente dans le prompt — l'agent garde ce qu'il a lu, pas seulement ce qu'il a écrit. La réinjection de la réponse précédente ne subsiste que hors session (dry-run, backend non reprenable, repli après échec de reprise) ; **« l'IA pose une question »** (bloc `<<<QUESTIONS>>>` → `needs_input` → `runTaskAnswer`) |

### `verify/`

La vérification objective : le verdict, son exécution, l’environnement des vérificateurs.

| Fichier | Rôle |
|---|---|
| `verify/verify.js` | **vérification objective — la partie qui DÉCIDE**, sans aucune dépendance (ni git, ni base, ni réseau) : `decouperCommande` (tokenise une commande, guillemets respectés, et REFUSE les métacaractères de shell — il n'y a pas de shell, les laisser passer donnerait un échec incompréhensible), `parserTap` (feuilles seulement, nom hiérarchique `suite › test`, `# TODO`/`# SKIP`, `Bail out!`, accolades de vitest, bloc YAML ou lignes indentées de mocha, contrôle par le plan pour détecter une sortie tronquée), `parserJUnit` (analyseur étroit : `<testcase>` + `<failure>`/`<error>`, attributs en guillemets simples ou doubles, message en attribut — Surefire — ou dans le texte — PHPUnit, jest), `nouvellesLignes` (ce qui apparaît à la tête et pas à la base), `composerRunCommandes` (LE CODE DE SORTIE DÉCIDE ; le format reconnu ne fournit que des noms, et une contradiction entre les deux est signalée), `validerReponse` (contrat v1 : `version`, `status`, ≤ 50 `failed`, extraits ≤ 4 ko, réponse ≤ 256 ko — une sortie hors schéma ne devient jamais un vert), `derniereLigneJson` (le script peut bavarder sur stdout, seule sa dernière ligne JSON compte), `deltaImputable` (`failed(head) − failed(base)`, clé = `test`), `composerVerdict` (les 6 lignes du tableau des verdicts), `estPerime`, `normaliserRemote`/`memeDepot`. C'est ce module qu'on prouve en unitaire |
| `verify/verifyrun.js` | **exécution**, pour les DEUX familles de vérificateurs (`lancer(role)` aiguille, tout le reste est commun) : `lancerCommandes` (liste de commandes sans shell, arrêt à la première en échec, budget de temps GLOBAL réparti entre elles, sortie nettoyée de l'ANSI et streamée dans le journal, `envVerifier` = env minimal + variables déclarées), `detailDesTests` (rapport JUnit déclaré, sinon TAP dans la sortie, sinon rien — et on le dit),  `appelerScript` (spawn **sans shell**, env minimal sans jeton, SIGTERM puis SIGKILL à +10 s, **stdout fait foi sur le code de sortie**), worktrees (`ajouterWorktree`/`retirerWorktree`/`gcWorktrees` au boot), mode **in place** (`inspecterWorkdir` → consentement + identité du remote + refus si des fichiers **suivis** ont bougé — les fichiers NON SUIVIS ne bloquent pas : ils ne sont dans aucun commit, le checkout détaché ne les touche pas, et refuser à cause d'eux interdisait le mode à tout répertoire portant un `.env` ou un dossier d'artefacts ; ils sont comptés, annoncés par « Tester le répertoire » et notés au journal du run, car ils restent là pendant les tests ; `preparerInPlace` fetch + `checkout --detach` ; `restaurerInPlace` dans un `finally`, échec → `restore_error` persistant), `lireContexte` (dépôts couverts hors lot, **lecture seule**), `executerVerification` (résolution des refs en SHAs, **run base rejoué à chaque fois**, run head, verdict — le cache par jeu de SHAs a été retiré : il pariait sur un environnement inchangé, que rien ne permet de vérifier, et se trompait dans les deux sens — rouge corrigé hors git resté collé, vert périmé faisant accuser la branche) et `commenterSurForge` (opt-in). Court-circuité en **mode démo** avant la moindre commande git |

### `notes/`

Les notes, le brief du matin, les liens, la découverte des MR et des tickets.

| Fichier | Rôle |
|---|---|
| `notes/brief.js` | **le brief « Aujourd'hui »** : les 7 sections, en SQL, **sans IA ni réseau** (un résumé rédigé par un agent aurait coûté un appel chaque matin pour reformuler des faits qui se lisent déjà). Ordre « action d'abord » ; une section vide arrive vide et c'est le front qui la masque, en un endroit. Deux règles non évidentes : les todos échues n'apparaissent QUE dans *Rappels* (jamais deux fois), et un verdict de vérification **périmé** (branche avancée depuis) est écarté — il enverrait corriger un problème peut-être déjà corrigé. **Lignes écartées à la main** (`brief_hidden`) : le brief recalcule tout chaque matin, un fait qui reste vrai revient indéfiniment. La clé est l'objet VU (ce verdict-ci, cette MR-là), pas le sujet : une nouvelle vérification du même lot reparaît. Le filtrage est posé dans `construire()`, après le calcul — chaque section garde une requête qui dit ce qui est vrai — et les sections demandent `MAX + écartés` pour que retirer une ligne fasse REMONTER la neuvième au lieu de rétrécir la section |
| `notes/discover.js` | découverte des MR ouvertes filtrées par pattern |
| `notes/links.js` | **onglet Liens** : grille services × environnements, liens libres, palette, import. Quatre décisions y sont figées : une URL par case ÉCRITE (deviner l'adresse de preprod depuis celle de dev envoie un jour sur le mauvais environnement) ; `http(s)` UNIQUEMENT partout (ces liens s'ouvrent d'un clic depuis l'app) ; les gabarits ne connaissent que `{env}`/`{branch}`/`{mr_iid}`/`{service}`, refusés à la SAISIE si inconnus, et chaque valeur substituée est URL-encodée ; la FRÉCENCE (`uses / (1 + jours)`) et non la fréquence, sinon ce qu'on a martelé le mois dernier reste en tête à vie. Aussi : `parserBookmarks()` (format Netscape, analysé jamais rendu, tolérant aux exports bancals) et `appliquerImport()` (REJOUABLE : une URL connue est ignorée, le compte des ignorés est rendu — un silence passerait pour un échec) ; `nomDepuisUrl()` (CE QUE L'ÉCRAN AFFICHE d'une adresse sans nom : dernier segment du chemin, sinon l'hôte débarrassé de ce que la ligne et la colonne disent déjà — calculé ICI et non côté navigateur, pour n'avoir qu'une version de la règle) ; `analyserCollage()`/`appliquerCollage()` (coller une adresse : on PROPOSE un rangement, on ne le décide pas — une URL dont l'hôte ne cite aucun environnement connu tombe en lien libre, jamais dans une colonne « probable ») ; `reordonnerEnvironnements()`/`reordonnerServices()` (l'ordre COMPLET en un appel, ce que produit un glisser-déposer ; ce que le client n'a pas cité reste derrière) |
| `notes/notes.js` | **onglet Notes** : pages, todos, rappels. Toute la logique et les requêtes, aucune route ni rendu. Trois règles y sont figées : `due_at` porte À LA FOIS l'échéance et le rappel (pas d'entité `reminder`, donc pas deux vérités à réconcilier) ; **tout changement de `due_at` remet `reminded_at` à NULL** — sans ce reset, snoozer un rappel déjà notifié le rendrait définitivement muet ; les todos faites ne sont **jamais supprimées** (barrées 7 jours, puis `archived_at`, `demarrerArchivage()` au boot puis une fois par jour, `unref`). Aussi : `slugifier()` (nom de fichier d'export, une traversée de chemin n'y survit pas), `calculerSnooze()` (+1 h ; « demain 9 h » construit par composants, donc 9 h AU CADRAN même à un changement d'heure) et `indexAutolink()` (table iid → dépôts, **bornée** aux MR ouvertes ou actives depuis moins de six mois : sans clause, la requête sérialisait la table `mr` entière à chaque ouverture de l'onglet — celui de l'atterrissage quotidien — pour résoudre trois `!214`, et la rétention ne borne pas cette table) |

### `integrations/`

Jira, Jenkins, Docker, la dictée vocale, l’export .docx, la veille de fond.

| Fichier | Rôle |
|---|---|
| `integrations/dictation.js` | **dictée vocale** (whisper.md) : trois fournisseurs derrière UNE `transcrire()` — `local` (whisper.cpp, `whisper-server` lancé et surveillé comme `claude`/`copilot` : port libre de 127.0.0.1, chauffe sur une seconde de silence, requêtes **sérialisées** — deux décodages sur un même GPU se gênent —, arrêt après inactivité, journal de 200 lignes), `openai` (tout endpoint `/v1/audio/transcriptions` ; le MÊME client HTTP sert les deux, `whisper-server --inference-path` répondant la forme d'OpenAI) et `browser` (rien ici : la page transcrit et n'envoie aucun audio). Le levier de précision est le **prompt de vocabulaire** construit depuis la base à chaque requête (glossaire, dépôts, services, environnements, préfixes Jira, vérificateurs, jobs Jenkins, branches ouvertes, socle technique, phrase d'amorce ponctuée), tronqué à **224 tokens** sans jamais évincer le glossaire ni couper un terme. Aussi : `diagnostic()` (les étapes ordonnées du panneau, arrêt à la première ✗), `commandeInstallation()` (chemin de script **fixe**, modèle en liste fermée, GPU énuméré) et `lireResultatInstallation()`/`reglagesDepuisResultat()` (la ligne `MERGERIE_RESULT` du script remplit les réglages). L'audio n'est **jamais écrit sur disque** ni journalisé |
| `integrations/docker.js` | **onglet Docker** : découverte à deux sources (COMPOSE = scan des répertoires locaux pour les fichiers compose ; HORS-COMPOSE = `docker ps -a` sans label `com.docker.compose.project`) ; **drift .env** = effectif (`docker inspect`) vs attendu (`docker compose config --format json`) → **diff nominatif** par service (variables ajoutées/modifiées/supprimées, **valeurs sensibles masquées**), badges `synchro`/`drift config`/`drift image`/`compose modifié`/`non créé` ; actions **stop**/up/restart/pull/**recreate** (`--force-recreate` ciblé)/**build** (`up -d --build` : reconstruit l'image puis recrée) + `down` (aperçu, **jamais `-v`**) ; **perf** : `composeProjects` fait UN SEUL `docker ps -a` partagé + calcule les projets en **parallèle borné** (`pMap`, 6) avec les `inspect` de services en parallèle ; **affichage progressif** via `composeFileList` (liste légère : scan + un `ps -a`, nom provisoire `defaultProjectName`, tri activité récente) puis `composeOne(dir, file)` (détail à la demande, valide que le fichier est connu sous les racines) ; **Makefile** à côté du compose : `parseMakefileTargets` (cibles + desc `## …`, hors variables/motifs/.PHONY), recherche + `runMake` (cible **whitelistée** depuis le fichier) ; orphelins : `reconstructRunCommand` (inspect → `docker run` lisible), **stop**, suppression après **sauvegarde de l'inspect**. **Logs** : `listContainers` (liste plate depuis `docker ps -a`) + `spawnLogs(id, tail)` (renvoie le process `docker logs -f --tail N -- <id>` à câbler en SSE ; validé par `validRef`). On shelle le CLI `docker`/`make` (comme git/agent), `--format json` ; binaire `docker` résolu via `DOCKER_BIN` → PATH → emplacements usuels. Anti flag-smuggling (`validRef` + `--`). Démon injoignable / CLI hors PATH → message actionnable |
| `integrations/docx.js` | **export d'une réponse d'agent en `.docx`**, sans dépendance : Markdown → OOXML (titres, paragraphes, listes indentées, blocs de code, citations, filets, **tableaux**, et en ligne `code`/gras/italique — exactement le sous-ensemble que `mdToHtml` AFFICHE), puis empaquetage **ZIP** écrit à la main (CRC-32 + `zlib.deflateRawSync`). Deux détails qui rendent sinon le fichier « illisible » pour Word : l'échappement XML et le retrait des caractères de contrôle. Dates ZIP figées → export **reproductible**. Le HTML et le PDF, eux, restent au front (contenu déjà rendu, boîte d'impression du navigateur) || `jira.js` | client Jira Cloud (Basic, API v3) + **convertisseur ADF → Markdown** ; fetch du contexte ticket au discover (best-effort) ; **onglet Jira** : `listAssignees` (`myself` + assignés récents découverts via `assignee IS NOT EMPTY` → cases du filtre par personne, moi coché par défaut) + `searchByAssignees` (JQL `assignee IN (accountIds)`, vide = `currentUser()` ; accountIds validés anti-injection JQL ; écarte `statusCategory = Done` sauf `includeDone`, tri `updated DESC`) + `transitions`/`transitionIssue` (changer l'état via l'API transitions) + `addComment` (`textToAdf` : texte brut → ADF pour poster un commentaire) + `issueDetail` (métadonnées + description ADF→MD + commentaires ADF→MD + **pièces jointes** : métadonnées seulement, contenu à la demande) + `downloadAttachment` (proxy : récupère le fichier avec le token, suit la redirection Jira→média en **retirant l'auth hors hôte**, bufferisé, ≤ 25 Mo ; **`inline` UNIQUEMENT pour les images matricielles** png/jpeg/gif/webp/bmp/avif — `image/svg+xml` (script possible) et tout le reste en `attachment`, + `X-Content-Type-Options: nosniff` et CSP `sandbox` : un SVG ouvert en navigation top-level ne peut pas exécuter de script sur l'origine de l'app). Images **embarquées** (ADF `mediaSingle`) : `adfToMarkdown(adf, {attachments})` résout le nom de fichier du média vers l'id de pièce jointe → `![nom](/api/jira/attachment/id)` (rendu inline par `mdToHtml`, restreint à ce proxy = sûr ; clic = lightbox), placeholder nommé sinon. **Cloud a retiré l'ancien `/search` (410 Gone)** → on appelle le nouveau **`/rest/api/3/search/jql`** (recherche enhanced, sans `total`), avec repli sur `/search` si 404 (Jira Server/DC) |
| `integrations/jenkins.js` | **client Jenkins** (voir/lancer des jobs). Trois particularités de Jenkins portent tout le module : les jobs forment un ARBRE (dossiers, multibranches) qu'on aplatit en chemins `a/b/c` → URL `/job/a/job/b/job/c` ; l'état tient dans une COULEUR (`blue`=succès, suffixe `_anime`=en cours) traduite ici et non dans une feuille de style ; lancer est un POST donc soumis au CSRF — le crumb est demandé ET son cookie renvoyé avec lui (le crumb seul donne un 403 aussi sûrement que rien). Avec paramètres → `buildWithParameters` (`build` les ignorerait en silence). Aucune requête sans un geste : pas de sondage |
| `integrations/veille.js` | **veille de fond du serveur** (B14/B15) : un timer d'une minute, deux surveillances. **Jenkins** — `attendreJenkins(chemin, depuis)` est appelé par `POST /api/jenkins/build` avec le dernier numéro connu de l'écran ; le tour suivant lit `jenkins.detail(…, 1)` et pousse `jenkins_done` quand un build **strictement plus grand** est terminé. Rien n'est demandé à Jenkins tant qu'aucun lancement n'est attendu (un outil local ne martèle pas le CI de l'équipe), et une attente qui n'aboutit pas s'oublie au bout de 6 h. **Docker** — `listContainers()` (un seul `docker ps -a`), et `docker_down` sur une **transition** « tournait → tombé », jamais sur un état : sinon le conteneur arrêté depuis trois jours redonne l'alerte à chaque tour. `estTombe` est partagé avec le badge de santé — l'alarme et le badge doivent dire la même chose du même conteneur. Le dernier relevé (`dockerTombes()`) alimente la section Docker du brief, qui reste ainsi **sans réseau**. Désactivée en démo ; timer `unref` |
| `public/ansi-runtime.js` | **séquences d'échappement ANSI** — même code dans le navigateur et dans Node (montage de `i18n-runtime.js`). `stripAnsi` rend le texte nu, `parseAnsi` des segments { fg, bright, bold, underline }. Une application dans un container colore sa sortie, `docker logs` la relaie telle quelle, et le navigateur n'est pas un terminal : il affichait `ESC[34mdebug ESC[39m`. Le SSE Docker envoie la ligne BRUTE (le client décide, cf. case « afficher les couleurs ») ; les lignes de `job_log`, elles, sont nettoyées à l'écriture — elles sont persistées, pas rejouables. Les couleurs de FOND sont ignorées : elles supposent un terminal dont on maîtrise le contraste, pas deux thèmes |
| `public/dictation-mic.js` | **la capture**, côté navigateur : `getUserMedia` 16 kHz mono + `AudioWorklet` (`dictation-worklet.js`), **découpage aux silences** (RMS glissant, seuil adaptatif au bruit de fond, segment fermé après le silence réglé ou 12 s), envoi par segment numéroté avec le contexte glissant, **réordonnancement** des réponses, insertion par `setRangeText` + `InputEvent` synthétique (une affectation de `.value` contournerait l'autosave des brouillons et la garde `configFrappe`), cible retrouvée par **sélecteur stable** à chaque insertion (les cartes se redessinent toutes les 1,5 s), seconde passe sur l'audio complet à l'arrêt, bandeau « texte non inséré » si le champ a disparu |
| `public/dictation-runtime.js` | **la logique PURE de la dictée**, même code dans le navigateur et dans Node (montage de `i18n-runtime.js`) : validation et fabrication du WAV 16 kHz, normalisation (`!214`/`PROJ-720` depuis leurs formes parlées, espace insécable française **hors blocs de code**, majuscule après un point), commandes vocales, liste de corrections, filtre anti-hallucination (phrases fantômes FR/EN, boucles, répétition), similarité de mots. Partagée parce que le fournisseur `browser` transcrit **sans passer par le serveur** et doit produire exactement le même texte |

### `jobs/`

La file de jobs : son état et le registre des exécutants (`file.js`), l’ordonnanceur, ce qui s’enchaîne après une session, et un exécutant par sorte de job (`runners/`). Importée par `app/` et par `agent/profile/lancer.js` seulement.

| Fichier | Rôle |
|---|---|
| `jobs/apres-session.js` | ce qui s’enchaîne quand une session finit : suivi automatique, question devenue todo, vérification |
| `jobs/file.js` | l’état de la file (ce qui attend, ce qui tourne), le journal, les clés de conflit, la relance — et le registre des exécutants |
| `jobs/index.js` | **file séquentielle** (un job à la fois), log persistant, stop, kinds `review`/`rereview`/`modify`/`explain`/`task`/`gitops`/`converge`/`converge-session`/`local`/`ask` |
| `jobs/ordonnanceur.js` | lancer, promouvoir, arrêter, rejouer, et tous les `start…Job` |
| `jobs/runners/` | un exécutant par sorte de job (`task`, `converge`, `local`, `ask`, `gitops`, `docker`, `install`, `reconcile`, `verify`, `review`), inscrit dans le registre au chargement par `jobs/index.js` |

### `app/`

La couche HTTP, et rien d’autre : `app.js` crée l’application, `middleware/` la garde (dans l’ordre où `server.js` les charge), `http.js` et `lib/` portent ce que les routes partagent, `routes/` déclare un fichier par domaine. Rien n’importe `app/` sauf `server.js`.

| Fichier | Rôle |
|---|---|
| `app/app.js` | l’application Express, créée ici pour que middlewares et routes s’y accrochent en s’important |
| `app/fichiers.js` | servir un fichier qui ne vient pas de nous — le SEUL `res.sendFile` (`npm run check`) |
| `app/http.js` | ce que toutes les routes partagent : `wrap`, `repoById`, `mrById`, la garde de configuration d’agent, les options de convergence |
| `app/lib/` | ce que plusieurs fichiers de routes partagent, par domaine : `sessions`, `pieces`, `partage`, `verifications`, `visionneuse`, `decouverte` (et les reviews/vérifications automatiques), `jira` (surveillance, badge, engagements), `connexions`, `merge`, `branches`, `forge-identite` |
| `app/middleware/` | `entetes` (CSP, nosniff), `origine` (Host, Sec-Fetch-Site, jeton, origine des écritures), `memo-requete`, `langue`, `ecriture-depot`, `corps` (JSON, audio, statiques), `erreurs` (le dernier filet) — chargés par `server.js` dans cet ordre, qui est la sécurité du serveur |
| `app/planification.js` | le rafraîchissement automatique des MR |
| `app/routes/` | un fichier par domaine, chargés par `server.js` dans l’ordre alphabétique : `statut`, `activite`, `config`, `repos`, `mrs` (+ `mrs-resume`, `mrs-commentaires`), `tasks` (+ `tasks-liste`, `tasks-iterations`, `tasks-actions`), `local-tasks`, `questions`, `agents`, `agent-passes`, `pieces`, `verifiers`, `verifications`, `rules`, `jobs`, `git` (+ `git-compare`, `git-merge`), `docker`, `jenkins`, `jira`, `notes`, `links`, `data-sync`, `dictation`. Une route ne contient que du HTTP |

### `demo/`

Le mode démo : les faux services et les fixtures, branchés depuis `app/` et cinq modules nommés.

| Fichier | Rôle |
|---|---|
| `demo/agents.js` | le décor des agents : skills fictifs, âges fixes, et surtout les SORTIES d'agent en dry-run, avec de **vrais blocs de protocole** — c'est le même parseur qui les lit qu'en production. Le rôle joué se déduit de ce que la demande réclame, pas du nom du profil (une mise à jour de connaissance est portée par l'agent de domaine mais exécutée par le cartographe) |
| `demo/comments.js` | **commentaires de MR fictifs du mode démo** (en mémoire) : sans jeton, l'écran de review affichait « commentaires indisponibles » et la moitié du rapport restait morte. Le jeu contient volontairement **un commentaire de moi et un d'un collègue** — c'est ce qui rend visible la règle « on ne modifie que les siens », que le module fait respecter comme le ferait la forge |
| `demo/dictation.js` | **moteur de dictée simulé** (`MERGERIE_DEMO=1` ou `DICTATION_DRY_RUN=1`) : il valide l'en-tête WAV, mesure la **durée réelle** de l'audio reçu et rend une phrase scriptée FR/EN choisie pour MONTRER ce que le vocabulaire apporte (`/health`, `!216`, `PROJ-1408` bien écrits). Hors démo et sans moteur, **rien n'est inventé** — un faux texte serait un mensonge, comme un faux verdict de vérification |
| `demo/docker.js` | **données Docker statiques du mode démo** : 2 projets compose (dont un service en drift config avec diff visible + secret masqué, un en drift image, un non créé) + 2 containers hors-compose avec commande reconstituée |
| `demo/git.js` | **données Git statiques du mode démo** (`MERGERIE_DEMO=1`) : un jeu fictif cohérent par dépôt (branches + tags) d'où dérivent les réponses de `refs`/explorateur/`find-ref`/`tag-author` et l'aperçu d'action — les onglets Git, sinon *live*, restent consultables hors-ligne (boutons sans effet) |
| `demo/jenkins.js` | jeu de jobs fictifs pour `MERGERIE_DEMO=1` (dossiers, un en cours, un rouge, un instable, un désactivé, un paramétré) : chaque cas que l'écran doit savoir rendre |
| `demo/jira.js` | tickets Jira FICTIFS du mode démo (affectés + détail + commentaires, séquence figée) |
| `demo/review.js` | rapports de review du mode démo : constats pointant des fichiers qui existent VRAIMENT dans le diff de démo, versions successives, résolutions vérifiées. |
| `demo/shared.js` | le dépôt de données du mode démo : un vrai dépôt git local, trois auteurs fictifs, un faux distant nu |
| `demo/verify.js` | **verdict simulé du mode démo** : rouge puis vert en alternance — c'est la SÉQUENCE (échec nommé → correction → vert) qui rend la fonctionnalité lisible, un vert perpétuel ne dirait rien |

### À la racine

Les deux points d’entrée.

| Fichier | Rôle |
|---|---|
| `server.js` | chargement `.env`, endpoints REST, static (`Cache-Control: no-cache` → le navigateur revalide à chaque chargement, plus de « je ne vois pas mes changements ») — depuis la réorganisation, réduit au point d’entrée : le `.env`, l’application, l’ordre de montage de `app/`, `listen`, les timers de fond |

## Modèle de données (SQLite)

- **config** (row unique) — `gitlab_url`, `access_token`, `clone_path`, `ai_extra_instructions` (consignes permanentes ajoutées au prompt de TOUTES les sessions de codage, dépôt et hors dépôt, run comme suivi — une seule fonction `prompts.avecConsignes` pour les deux chemins), `auto_refresh_minutes` (0 = désactivé), `language`, `review_explain` (`'1'`/`'0'` : générer l'explication pédagogique lors d'une review), `auto_post_review` (`'1'`/`'0'`, **défaut `'0'`** : publier le rapport de review en commentaire sur la MR à la fin de chaque review), `auto_post_blocking_only` (`'1'`/`'0'`, **défaut `'0'`** : ne publier automatiquement qu'un rapport portant au moins un constat `blocker`), `auto_review_new` (`'1'`/`'0'`, **défaut `'0'`** : reviewer toute MR nouvellement découverte) `auto_rereview_stale` (`'1'`/`'0'`, **défaut `'0'`** : relancer la review quand le rapport se périme) et `review_auto_max` (plafond par découverte, défaut 5, `0` = sans limite), `converge_threshold` (seuil cible /10, défaut 8) et `converge_max_passes` (plafond de passes, défaut 3), templates de prompt ; **GitHub** : `github_url` (vide = github.com, sinon GitHub Enterprise) et `github_token` (secret masqué) ; **Jira** : `jira_url`, `jira_email`, `jira_token` (secret masqué) ; **dictée vocale** : `dictation_provider` (`off` par défaut | `local` | `openai` | `browser` — une valeur inconnue retombe sur `off`, un réglage illisible ne doit pas laisser croire qu'un micro est actif), `dictation_model`, `dictation_vad_model`, `dictation_command` (vide = `whisper-server` du PATH), `dictation_url` / `dictation_api_key` (secret masqué) / `dictation_remote_model`, `dictation_language` (`auto` = celle de l'interface), `dictation_vocabulary` (glossaire, jamais évincé par la limite du moteur) et `dictation_replacements` (`entendu => écrit`), `dictation_silence_ms` (borné [400, 1500], défaut 700), `dictation_final_pass` (`'1'` : relire l'audio complet à l'arrêt) et `dictation_idle_minutes` (arrêt du moteur, `0` = jamais, défaut 15). **`verify_jira_comment`** (`'1'`/`'0'`, **défaut `'0'`**, B10) : commenter le ticket Jira de la merge request quand une vérification casse — mêmes gardes que le commentaire de forge (`verify.doitCommenterAuto`), une seule fois par ticket.
- **repo** — `project`, `url`, `branch_pattern` (vide = toutes les MR), `enabled`, **`fetch_mrs`** (1 par défaut : décoché, la découverte ignore le dépôt sans le désactiver ailleurs), **`forge`** (`'gitlab'` par défaut | `'github'`). L'unicité d'un dépôt est le **couple `(forge, project)`** : `acme/web` peut exister sur les deux forges.
- **mr** — MR découverte : `changed_files` / `changed_additions` / `changed_deletions` (taille du changement, relevée avec `changed_paths` dans le MÊME appel) ; `squash` / `remove_source_branch` (options choisies à la création, appliquées au merge — indispensable pour GitHub dont l'API de création ne les accepte pas), `iid`, `title`, `source_branch`, `target_branch`, `author`, `gitlab_created_at`, **`merged_at`** (l'instant du merge DONNÉ PAR LA FORGE : le délai de cycle le mesurait depuis une ligne du journal d'activité, écrite quand CE poste cessait de voir la MR ouverte — inutilisable à plusieurs, et absente sur un poste qui vient de rejoindre), `current_sha`, `reviewed_sha`, `status` (`to_review`/`reviewed`/`done`), `last_error`, `closed_seen`, `ticket_text`/`ticket_image` (contexte manuel), **contexte Jira** `ticket_jira_text`/`ticket_jira_key`/`ticket_jira_at`/`ticket_jira_error` (récupéré au discover, distinct du manuel — concaténés à la review), et **session de review** `review_session_key`/`review_session_backend`/`review_session_cwd` (continuité : « Relancer la review » reprend la même session). **`ticket_jira_status`/`ticket_jira_category`** : l'état du ticket rangé À LA DÉCOUVERTE, pour toutes les MR à ticket et pas seulement les watchées — zéro appel de plus, l'issue étant déjà lue en entier pour son contexte. **LE RATTRAPAGE DES FERMÉES** (`discover.js`) : la découverte ne liste que les MR OUVERTES, donc une MR déjà fermée n'en ressort jamais — un poste qui rejoint l'équipe reçoit des reviews sur des MR fermées depuis des mois et n'a qu'un numéro en tête de rapport. Un SEUL appel `listAllMRs` par dépôt complète titre, branches, auteur, lien, dates ; `COALESCE` partout (on ne remplace jamais ce qu'on a, la liste des ouvertes étant plus riche), et un repère dans `local_state` retient combien il en restait d'incomplètes — sans lui on rappellerait la forge à chaque tour pour des MR fermées sans merge, qui n'auront jamais de date.
- **review** — `md_path`, `explanation_path`, `diff_path` (fichiers sur disque).
- **make_run** (clé `dir` + `target`) — la DERNIÈRE exécution d'une cible Makefile : `started_at`, `finished_at`, `ok`. Écrasée à chaque lancement — ce qui compte est la dernière, pas l'historique.
- **verify_run_test** (A26) — de quoi dire qu'un test est **instable**, sans rien demander à personne : une ligne par test ROUGE et par run, plus une ligne à `test` NULL qui marque le run lui-même (sans elle, un run tout vert ne laisserait aucune trace). `targets_key` = les couples `dépôt:sha` triés — deux runs ne sont comparables que sur le MÊME code. Seuls les runs qui NOMMENT leurs tests (TAP, JUnit) y entrent ; purgée par la rétention comme les autres traces. `testsInstables(verificationId)` rend les tests rouges à un run et verts à un autre sur la même clé, à partir de deux runs — un seul ne prouve rien.
- **task.agent_draft_json** (A18) — le profil d'agent qu'on ESSAIE, tel qu'il est dans le formulaire, porté par la session sans qu'aucun agent ne soit créé. `agentprofile.optionsFor` le lit exactement comme il lirait une ligne `agent` : un second chemin d'options finirait par ne plus essayer ce qu'on croit essayer.
- **todo** — `link_kind` a été élargi de `('mr','ticket','repo')` à **`('mr','ticket','repo','branch','verification','build','container')`** (B16). SQLite ne sachant pas modifier une contrainte, la table est **reconstruite** (deuxième et dernière migration de ce type après `service_url`), tout étant recopié tel quel. Les références des nouveaux types : `<repo_id>:<branche>`, l'id d'une vérification, `<job>#<numéro>`, le nom d'un conteneur. `notes.LINK_KINDS` doit rester aligné sur ce `CHECK` : ce que l'un accepte et que l'autre refuse sort en erreur SQLite brute à l'écran.
- **repo_jenkins** — quel job Jenkins déploie quel dépôt (`repo_id`, `job_path`, `param` = le paramètre qui recevra la branche). Déclaré dans Réglages → Jenkins ; proposé sur les merge requests vérifiées vertes du dépôt.
- **usage** — porte désormais `owner_kind` / `owner_id` : une dépense se rattache à SA session (task / ask / local). Les lignes antérieures gardent des colonnes nulles et restent comptées dans leur famille.
- **agent** — un **profil de session** : `name` (unique), `description`, `builtin_key` (`investigator`/`librarian`/`cartographer`, ou NULL), `kind` (`explore`/`code`), `scope_kind` (`repos`/`all_repos`), `system_prompt` (AJOUTÉ au prompt système du CLI), `prompt_template` (`{question}`, `{repos}`, `{today}`), `model`, `permission_mode` (vide = `acceptEdits` ; `default` refusé), `allowed_tools_json`/`disallowed_tools_json`, `max_turns`, `skills_json`, `subagents_json`, `output_kind` (`report`/`note_page`/`agent`) + `output_ref` (pour `note_page`, la page **racine** : l'agent y rattache autant de sous-pages qu'il juge nécessaire via `<<<PAGE>>>`, appariées par TITRE d'un run à l'autre — celles qu'il ne produit plus sont gardées, pas supprimées : une sous-page a pu être complétée à la main), **`knowledge_prompt` non nul = agent de DOMAINE** (pas de colonne de famille : le sujet suffit à le dire), `schedule` + `schedule_fired_at`, `defaults_json`.
- **agent_repo** — le périmètre d'un agent (`agent_id`, `repo_id`, `branch`, `role` `target`/`readonly`).
- **agent_knowledge** — la connaissance d'un agent de domaine, **versionnée** : `version`, `md_path` (`data/agents/<id>/knowledge-v<N>.md`), `repos_json` (par dépôt : `sha` au moment de l'écriture, `paths` cités, `unverified`), `task_id` (NULL = édition à la main), `diff_summary`, `gaps_json` (les écarts remontés par les runs), `status` (`pending`/`active`/`superseded`). Un **index unique partiel** garantit une seule version `active` par agent : deux cartes en service seraient deux vérités.
- **task** (colonnes d'agent) — `agent_id` (`ON DELETE SET NULL`), `agent_name` (recopié : une session reste lisible après suppression du profil), `triggered_by` (`manual`/`schedule`), et **`agent_question`** — la demande TELLE QU'ELLE A ÉTÉ TAPÉE. `task.prompt` porte la demande *composée* (gabarit, fichiers d'entrée, consignes, protocoles) : c'est ce que l'agent reçoit, et c'est illisible pour un humain. Le titre du rapport, la carte et le sujet d'un agent de domaine viennent tous de la question d'origine.
- **agent_pass.cost_usd** / **usage.cost_usd** — le coût ANNONCÉ par le backend quand il en annonce un (`result.total_cost_usd` du flux `claude`), à côté de l'estimation en tokens, qui reste calculée partout.
- **review_version** — **historique des reviews** : une ligne par passe (`version`, `md_path`, `explanation_path`, `note_value`, `reviewed_sha`, `kind` review/modify). Chaque review écrit `review-v<N>.md` au lieu d'écraser ; la table `review` pointe la version la plus récente, donc rien d'autre ne change. Migration idempotente : les reviews existantes deviennent leur version 1. Porte aussi l'**instruction** de la demande quand `kind = 'modify'` (l'historique des régénérations, affiché dans la section « Demander une modification »), et les **agrégats de résolution** `n_new/n_persistent/n_resolved/n_disappeared` (renseignés dès la 2ᵉ passe).
- **finding** — **suivi de résolution** : les constats structurés d'une passe de review (`version`, `fingerprint` = hash(fichier+titre normalisé, SANS la ligne), `file`, `line`, `severity`, `title`, `status`). `status` ∈ new/persistent/resolved/disappeared, calculé en comparant à la passe précédente. « resolved » n'est posé que si la ligne a **changé entre les deux `reviewed_sha`** (garde-fou git) ; sinon « disappeared ». Agrégats (`n_new/n_persistent/n_resolved/n_disappeared`) portés par `review_version` pour le bandeau et le taux de résolution.
- **commit_activity** — activité mensuelle d'un dépôt (`repo_id`, `month`, `commits`, **`active_days`** = journées distinctes où un commit est tombé, c'est ce que le graphe met en hauteur, `authors` = contributeurs distincts, `partiel` = plafond de pagination atteint donc minorant, `fetched_at`). Cache, pas source de vérité : reconstructible depuis la forge.
- **jira_watch** — `key` (clé du ticket, PK), `summary`, `status` + `status_category` (**dernier état connu** : c'est lui qu'on compare pour décider s'il y a eu changement), `added_at`, `checked_at`, `changed_at`, `error`, **`note`** (pourquoi on surveille ce ticket — texte libre borné à 500 caractères, modifiable par `PATCH /api/jira/watch/:key` ; les vérifications périodiques réécrivent le résumé et l'état, jamais la note). Alimente les notifications de changement d'état.
- **review_rule** — déclencheur `branch_match` (fragment de branche) **et/ou** `path_match` (glob sur les fichiers du diff), `label` (badge « risque »), `content`, `enabled`. Le risque d'une MR vient de ce qu'elle touche.
- **repo_link** — projets liés PAR DÉFAUT d'un dépôt (`repo_id`, `linked_repo_id`, `branch`) : copiés dans `mr_link` à la découverte d'une nouvelle MR (pré-remplissage zéro clic), définis depuis la modale Contexte.
- **mr_link** — projets liés d'une MR (`repo_id`, `branch`) : à la review, l'IA les consulte en lecture seule (montés en symlink sous `ai-dev-tools-internal/linked/`, worktrees remis à zéro après) et analyse l'impact des changements. Auto-lien exclu.
- **mr.changed_paths** — chemins des fichiers modifiés (rempli au discover via l'API et à la review via le diff) : source du **badge « risque »** (chemins × règles, sans IA).
- **job** / **job_log** — jobs de fond + log en direct persistant. La colonne **`retry`** garde l'INTENTION du job (quelle fonction, sur quel objet) et non les lignes traitées : relancer une review re-déduit sa liste de l'état des MR, donc reprend là où l'arrêt a eu lieu au lieu de refaire ce qui est fait. Les opérations **git** en sont exclues — rejouer « supprimer ces douze branches » depuis un bouton de bandeau, sans repasser par l'aperçu, est précisément ce qu'il ne faut pas permettre. `started_at`/`finished_at` sont exposés par `GET /api/jobs/current/log` : le panneau de logs en tire le **temps écoulé**, calculé depuis la date serveur et non depuis l'ouverture de la page (un onglet ouvert en cours de job afficherait sinon un temps faux).
- **comment_log** — commentaires niveau MR postés depuis l'app.
- **task** — sessions : `kind` (`code`/`explore`), `prompt`, `commit_message`, `auto_push`, `status` (agrégé depuis les projets), `md_path` (réponse d'exploration), **`followup_draft`** / **`followup_auto`** (suivi écrit pendant la session : envoyé à la main, ou tout seul à la fin si la case est armée ; `local_task` a les siennes), `created_at`, **`finished_at`** (fin de la dernière EXÉCUTION — distinct d'`updated_at`, qui bouge aussi quand on corrige un prompt ou qu'on pousse ; c'est lui qui trie les listes Dev IA, `ORDER BY (status='running') DESC, COALESCE(finished_at, created_at) DESC`, pour montrer d'abord ce qui vient de tourner).  Champs historiques mono-projet conservés mais inutilisés. Ancien format : `prompt`, `branch`, `base_branch`, `commit_message`, `auto_push`, `status` (`new`/`running`/`committed`/`pushed`/`error`), `commit_sha`, `diff_path`, `push_command`, `mr_iid`/`mr_url`/`mr_target`/`mr_merged`, `last_error`. **`notify_jira`** : commenter le ticket Jira à chaque création de merge request (décoché par défaut). **`review_after`** : lancer la review de la merge request dès sa création (décoché par défaut).
- **task_target** — **un projet d'une session** : `repo_id`, `branch`, `base_branch`, `status` (dont **`needs_input`** — l'agent a posé des questions, état d'ATTENTE hors compteur d'échec), `commit_sha`, `diff_path`, `push_command`, `mr_iid`/`mr_url`/`mr_target`/`mr_merged`, `last_error`, et pour l'ask→resume : `questions_json` (questions + réponses) + `session_key`/`session_backend`/`session_cwd` (handle de reprise ; le `cwd` fait partie de l'identité de session). C'est ici que vit l'état d'exécution : une session peut porter sur plusieurs dépôts, chacun avec son commit, son diff et sa MR. `task.ask_questions` porte le toggle par session (défaut off). Migration idempotente : chaque tâche mono-projet existante est convertie en une session à un seul target.
- **usage** — consommation de tokens de l'agent IA (footer) : `kind`, `prompt_chars`, `output_chars`, `tokens_est`, `created_at`. Une ligne par appel IA. L'entrée inclut le prompt **et le diff** (que l'agent lit lui-même : on ne lui passe que le chemin) ; la sortie inclut le **rapport écrit dans le fichier**, complété après lecture. Comptage exact via `gpt-tokenizer`, sinon ≈ car./4. ⚠️ Le travail interne de l'agent (lectures de fichiers, appels d'outils, tours de raisonnement) reste invisible : le total est un **minorant**.
- **git_op** — journal des opérations de l'onglet Git : `batch_id`, `action`, `project`, `ref_name`, `ref_sha`, `tag_sha`, `tag_message`, `status`, `fetched`, `restored_at`. Sert l'historique **et la restauration** : le SHA d'une ref supprimée y est conservé, avec le drapeau `fetched` (objets rapatriés localement avant la suppression). Un tag annoté garde ses deux SHA (tag + commit).
- **task_target.session_key** / **local_task_dir.session_key** — handle de la session d'agent, créé à la première passe… ou **fourni à la création** : le champ facultatif « reprendre une session d'agent existante » (création ET édition) range l'identifiant sur chaque unité comme si la première passe l'avait produit, de sorte que les exécutants n'ont rien à savoir — ils reprennent déjà dès qu'un handle existe. `session_cwd` reste NULL dans ce cas : on ignore d'où vient la session, et le garde-fou « même cwd » ne doit pas refuser ce que l'utilisateur a demandé ; si la reprise échoue, le repli habituel repart sur une session neuve avec le contexte réinjecté. Un identifiant partant par `-` est refusé (il serait passé tel quel à l'agent), et avec `claude` la forme UUID est exigée — mieux vaut le dire avant de cloner. En **édition**, le champ est pré-rempli du handle COMMUN aux unités (vide si elles divergent, plutôt que d'en afficher un au hasard) ; le PUT n'écrit que si la valeur change vraiment, et un champ **vide ne signifie jamais « efface »** — on ne perd pas une session sur un formulaire simplement soumis.
- **task.hidden** / **local_task.hidden** — session **rangée** : elle sort de la liste sans rien perdre (diffs, passes d'agent, MR). Le filtrage est fait **côté front** — l'API renvoie tout, et la case « afficher les sessions masquées » (persistée en localStorage) décide ; un décompte à côté de la case rappelle combien de sessions sont retirées de la vue, sinon on les croit supprimées.
- **agent_pass** — une **itération** d'agent : `scope` (`task`|`local`|`ask`|`review`), `task_id`, `unit_id` (cible ou dossier), `n`, `kind` (`run`/`followup`/`answer`/`converge-fix`), `prompt` (ce qui a été envoyé) et `output_path`. C'est ce qui permet de relire n'importe quelle passe d'une session, avec sa demande. La DERNIÈRE passe de codage d'une unité porte en plus ses deux bornes (`base_sha`, `head_sha`) et le patch entre elles (`diff_path`) : c'est ce qui permet de relire **le dernier suivi** au lieu de tout le diff. Seule la dernière est gardée — `attacherDiff` efface la mesure des précédentes (fichier ET bornes : garder les bornes seules leur ferait dire « rien changé », ce qui serait faux), et `purgerDiffsAnciens`, appelé par la rétention, ramène l'existant à la même règle. Sur dépôt, les bornes sont deux commits de la branche ; hors dépôt, deux commits du dépôt de suivi de `localsnapshot.js`. `head_sha` sans `diff_path` n'est pas une anomalie — c'est une itération qui n'a rien changé au code, et le dire vaut mieux qu'ouvrir une vue vide ; les trois colonnes restent nulles quand la mesure a été abandonnée (dossier démesuré) ou qu'elle est antérieure à la fonctionnalité. Le scope `review` (`task_id` = la MR, `unit_id = 0`) porte les **questions posées sur un rapport** : elles ne créent ni version ni note — c'est tout leur intérêt —, et `reviewer.askReview` n'écrit nulle part ailleurs, si bien que la garantie tient au code et non au prompt.
- **local_task** / **local_task_dir** / **local_task_image** — **« Codage hors dépôt »** : une session (`prompt`, `status`, `finished_at` — même tri que `task`), ses **dossiers locaux** (`path`, `status`, `last_error`, `output_path` = retour de l'agent, `session_key`/`session_backend`/`session_cwd` = handle de reprise) et ses **captures** jointes au prompt (comme `task_image`). Aucun `repo_id` (hors git) → tables dédiées plutôt que `task`/`task_target` (dont `repo_id`/`branch` sont NOT NULL). L'IA code EN PLACE dans chaque dossier, sans commit ; les captures sont référencées par **chemin absolu** dans le prompt (agent en place, sans clone → rien copié dans les dossiers de l'utilisateur). Le formulaire réutilise la **modale de codage** (kind `local`), en création comme en **édition** (les chemins absolus stockés sont retraduits en « répertoire local + nom de projet » pour repeupler le picker ; un projet qui ne se résout pas fait ÉCHOUER l'enregistrement au lieu d'être retiré en silence) : bouton principal « Lancer le codage » (crée + lance, le geste courant) **et** « Créer sans lancer » — la session part alors en statut `new` et sa carte porte un « Lancer », comme un codage ou une exploration.
- **question** — **« Question libre »** : une question posée à l'IA SANS dépôt ni dossier, et sa réponse gardée (`prompt`, `label`, `status`, `md_path`, `session_key`/`session_backend`/`session_cwd`, `followup_draft`/`followup_auto`, `hidden`, `finished_at`). Table à elle : `task` porte un `repo_id NOT NULL` et `local_task` agrège son statut depuis ses DOSSIERS — greffer la question sur l'une des deux aurait rendu optionnel ce qui fait justement leur nature, et obligé chaque écran des trois autres saveurs à gérer un cas « sans cible » qui ne les concerne pas. Aucune ligne fille : une question n'a qu'une réponse, donc rien à répartir. Ses passes vivent dans `agent_pass` sous le scope `ask` (`unit_id = 0`), ce qui donne la colonne d'itérations (avec sa recherche sur les demandes) sans code en plus. Une passe porte aussi `favori` et `titre` — du rangement pour la colonne de gauche, jamais envoyé à l'agent ; une seule route (`PUT /api/agent-passes/:id`, désignée par l'id de ligne) sert les quatre saveurs.
- **verifier** / **verifier_repo** / **verifier_command** — un **vérificateur** (`name`, `kind` (toujours `commands` — la famille `script` a été retirée en 2.0, les lignes héritées sont conservées, marquées à l'écran et refusées au lancement), `timeout_s`, `run_base`, `comment_on_forge`, `env_json` = variables ajoutées à l'env minimal, `report_path` = rapport JUnit relatif au dépôt, `parse_tap`), ses **commandes ordonnées** quand `kind = 'commands'` (l'ordre porte du sens : `npm ci` avant `npm test`), et sa **couverture déclarative** (`repo_id`, `mode` `worktree`|`in_place`, `workdir`, `checkout_allowed`). Déclarer un dépôt dit « ce script sait le tester » — ce n'est pas un checkout : seuls les dépôts effectivement visés par une vérification sont préparés.
- **lot** / **lot_member** — des merge requests **qui ne valent qu'ensemble**, nommées une fois pour toutes et re-vérifiables d'un bouton. Deux MR du même dépôt sont refusées (à la création ET au lancement) : on ne saurait pas quel code a été testé.
- **verification** — un **rapport**, et il est traité comme une **archive** : `verifier_id`/`lot_id` se **détachent** (`ON DELETE SET NULL`) et `verifier_name`/`lot_name` sont **recopiés** à la création. Supprimer un vérificateur ne doit ni effacer les verdicts rendus, ni — pire — être refusé à cause d'eux. Le reste : `status`, `verdict` (`verified_pass`/`verified_fail`/`broken_base`/`verify_error`), `targets_json` (dépôt, MR, branche, **SHAs résolus**, mode), `context_json` (dépôts couverts hors lot, constatés), `base_run_json`/`head_run_json`/`imputable_json`, `log_excerpt`, `restore_error`. Le lien vers les MR vit dans `targets_json`, pas dans une colonne : une vérification en porte plusieurs.
- **convergence_run** — une **boucle « Converger »** rattachée à une MR : `status` (running/converged/capped/regressed/no_change/stopped/error), `threshold` (/10), `max_passes`, `passes_done`, `start_note`/`best_note` (/10), `best_version` (→ review_version), `message`, `started_at`/`finished_at`. L'historique fin (note par passe) vit déjà dans `review_version` ; cette table ne porte que l'état global de la boucle.
- **note_page** — une **page de notes** : `title`, `content` (Markdown brut — le stockage ne porte jamais de HTML : on relit ses notes ailleurs, et un `.md` exporté ne doit pas charrier de balises), `pinned`, `shared`, `created_at`, `updated_at`. **`shared` décide ligne par ligne de ce qui part dans le dépôt d'équipe** (`partageable(row, ctx)` au registre) — comme sur `task`, `local_task` et `question` : ailleurs la famille de la table suffit, parce que le reste est un produit. `DEFAULT 0` — le défaut d'une case qui publie est « non », et c'est le seul défaut rattrapable. Décocher RETIRE les fichiers du dépôt (sinon la case aurait menti) ; partager une sous-page emporte sa mère et départager une mère reprend ses filles (le fichier d'une sous-page la désigne par son slug : seule, elle serait orpheline chez le collègue) ; une page hydratée depuis le dépôt arrive `shared = 1` — elle y est, donc elle est partagée. `parent_id` — **un seul étage** de sous-pages (une sous-page ne peut pas en contenir : « le détail du détail » veut dire qu'il fallait une page de plus, pas un étage de plus, et une arborescence profonde ne se navigue pas dans une colonne de 300 pixels). Le parent emporte ses sous-pages (cascade). Une recherche qui trouve une sous-page ramène son parent, marqué `contexte` : un enfant décalé sous rien ne se lit pas. La liste ne renvoie PAS `content` (vingt pages à chaque affichage de colonne pour n'en lire qu'une) ; la recherche, elle, porte bien dessus — c'est souvent là que se trouve le mot cherché.
- **piece_jointe** — les **pièces jointes d'une session** : captures ET documents, une seule table pour les quatre saveurs (`scope` = `task` / `local` / `ask`, comme `agent_pass`). `name` = nom d'origine (montré à l'écran, donné à l'agent), `path` = fichier sur disque sous un nom FABRIQUÉ (un nom venu d'un formulaire n'a rien à faire dans un chemin), `followup` = la pièce illustre une demande de suivi et n'accompagne que celle-là. Pas de clé étrangère (trois tables parentes) : ménage explicite à la suppression, comme `agent_pass`. Les anciennes `task_image` / `local_task_image` sont reprises puis supprimées au démarrage.
- **note_image** — une **capture collée dans une page** : `page_id`, `path` (fichier sous `data/notes/<page>/`), `created_at`. Le contenu de la page ne porte qu'un lien `![](/api/notes/<page>/images/<id>)` — une image en base64 dans `content` rendrait la ligne lourde de plusieurs mégaoctets, réécrite en entier à chaque autosauvegarde. Le rendu n'accepte QUE cette forme d'URL (même garde-fou que les pièces jointes Jira) : une adresse écrite à la main reste du texte. Suppression de la page : lignes en cascade, fichiers retirés explicitement par la route DELETE.
- **todo** — `title`, `priority` (high/normal/low), `status` **binaire** (open/done — une todo de poste de travail se coche, elle ne se pilote pas), `note`, **`link_kind`/`link_ref`** (mr → `mr.id` | ticket → clé | repo → `repo.id` ; le couple va ensemble, un type sans référence donnerait un bouton qui ne mène nulle part), **`due_at`** (échéance ET rappel), `reminded_at` (posé par le CLIENT après affichage de la notification, pas à la lecture de la liste : une notification qui échoue ne doit pas consommer l'unique occasion de prévenir), `done_at` (fait courir les 7 jours), `archived_at`. Tri : priorité, puis échéance, les sans-date en dernier — sinon les plus nombreuses repousseraient en bas ce qui est dû aujourd'hui.
- **config.brief_on_open** (`'1'`/`'0'`) et **config.stale_mr_days** (défaut 5, borné [1,90]) — l'atterrissage sur le brief à la première ouverture de la journée, et le seuil au-delà duquel une MR reviewée et toujours ouverte est « dormante ». Le réglage vit en base (il vaut pour l'outil) ; la DATE du dernier brief affiché reste en localStorage (`mergerie_brief_seen`) — deux navigateurs ouverts n'ont pas à se voler le brief l'un l'autre.
- **feed** — journal d'événements « frais » du footer : `type` (`mr_opened`/`mr_merged`), `mr_iid`, `project`, `author`, `title`, `at`. Émis par `discover` (nouvelle MR ; MR ouverte disparue de la forge = mergée/fermée, avec garde d'ancienneté 7 j anti-fantômes + flag `mr.closed_seen` anti-doublon) et par le merge applicatif.

## Base partagée — le registre des familles (`store-registry.js`)

Mergerie est mono-poste : une base SQLite, des fichiers à côté. Pour qu'une **équipe** partage le
travail accumulé (reviews, règles, vérificateurs, agents et leur carte du code, notes, todos), ce
travail part dans un **dépôt git d'équipe** qui fait foi, chacun gardant son instance, ses jetons
et son abonnement IA. La spécification complète est `shared_database.md` ; ce qui est en place est
le socle sur lequel tout le reste s'appuie.

**La décision de fond n'est pas technique, elle est de classement** : chaque table appartient à
une famille, et à une seule, déclarée dans `src/data/store-registry.js`.

- **P — partagé** (36 tables) : le travail accumulé. Une ligne = un fichier du dépôt
  (`todos/<uid>.json`, `notes/<slug>.md`, `reviews/<forge>/<projet>/<iid>/<uid>.md`), ou une
  **liste dans le fichier de son parent** quand elle ne se modifie qu'avec lui (`repo_link`,
  `verifier_command`, `finding`, `service_url`…). Chaque entrée dit aussi comment deux postes se
  départagent : `append-only` (le fichier est nommé par un ULID, deux postes ne touchent jamais le
  même — aucun conflit possible) ou `last-writer` (le plus récent gagne, l'autre est prévenu et
  récupère sa version d'un clic).
- **L — local** (10 tables) : secret, ou propre à un poste. N'entre jamais dans le dépôt. **Tout
  l'onglet Liens en fait partie** — la grille « services × environnements », les gabarits d'URL de
  contexte et les liens libres décrivent où l'on va travailler, pas ce qu'on a produit. Les
  partager imposerait à l'équipe la façon dont une personne range ses raccourcis, et ferait entrer
  dans un dépôt des adresses d'infrastructure que rien n'oblige à écrire quelque part.
- **C — cache** (8 tables) : relu de la forge, de Jenkins, de Docker ou du disque. Le partager
  serait partager du périmé. `job_log` pèse à lui seul 58 % de la base : de la console
  d'exécution locale, précisément ce qui n'a aucune raison de voyager.

**Deux tables sont coupées en deux**, et c'est assumé plutôt que déduit : `config` est P (gabarits
de prompt, seuils, URLs de forge — deux reviews de la même MR faites avec des consignes
différentes ne sont pas comparables) mais porte les jetons, nommés un par un dans `locales` ;
`mr` est C (la forge fait foi du titre, des branches, du SHA) mais porte l'état du travail du
relecteur — `status`, `reviewed_sha`, le contexte saisi à la main —, nommé un par un dans
`partagees`.

**Ce qui tient la classification**, parce qu'une déclaration ne s'exécute pas et que rien ne la
contredit quand elle ment :

- `npm run check` échoue sur une table du schéma (`db/schema/`) absente du registre **et** sur une entrée du
  registre sans table — dans les deux sens, parce que dans les deux sens l'oubli est silencieux :
  classée par défaut en partagé, une table nouvelle enverrait un jour un secret sur la forge ;
  classée par défaut en local, elle ne serait jamais partagée sans que personne ne comprenne
  pourquoi. Il vérifie aussi qu'une table P sait devenir un fichier (`cle` + `chemin`, ou
  `parent` + `liste`) et que sa stratégie de fusion est connue.
- `test/unit-store-registry.test.js` lit le schéma d'une base **neuve** et confronte le registre à
  ces colonnes réelles. Le contrôle qui compte : **toute colonne dont le nom dit qu'elle porte un
  secret ou un chemin de poste** (`*token*`, `*_key`, `*_path`, `*cwd*`, `password`, `secret`) doit
  être déclarée locale, ou justifiée nommément dans `EXCEPTIONS` — c'est ainsi que
  `repo_jenkins.job_path` (un chemin dans Jenkins) et `agent_knowledge.tokens` (un *nombre* de
  jetons) restent d'équipe, en le disant. Cette barrière échoue **en se fermant** : une colonne
  ajoutée l'an prochain et oubliée fait rougir les tests au lieu de partir sur la forge. Un secret
  commité dans git est définitif — l'historique est immuable, chaque clone le garde, la forge le
  garde ; il faut révoquer. La barrière vaut donc largement sa gêne.

### Les réglages coupés en deux (`local_config`)

`config` reste la table d'**équipe** — gabarits de prompt, seuils, politiques, URL de la forge,
glossaire de dictée. Les colonnes de **poste** déménagent dans `local_config`, jumelle à ligne
unique : les sept jetons (`access_token`, `github_token`, `jira_token`, `jenkins_token`,
`dictation_api_key`, plus `jira_email` et `jenkins_user`), `clone_path`, `language`,
`jenkins_refresh_minutes`, `git_commands_seeded` et le moteur de dictée.

- **Le tri est déclaré, pas déduit** : chaque colonne de `config` figure nommément dans `locales`
  ou dans `partagees` du registre, et un test exige que les deux listes **couvrent le schéma
  exactement**. Ailleurs une colonne nouvelle est partagée par défaut, ce qui est le bon défaut ;
  ici ce serait une fuite — cette table est le seul fourre-tout du schéma.
- **Vidée et gelée, pas supprimée** : `DROP COLUMN` sur une base en service est irréversible, et
  une lecture oubliée doit trouver du vide plutôt qu'un jeton périmé qu'elle croirait bon. Le
  drain est idempotent ; une **assertion au démarrage** refuse une colonne gelée non vide — après
  le drain, ce ne peut plus être qu'un bug du schéma (`db/schema/13-local-config.js`), donc le serveur refuse de partir.
- **Rien ne change pour le reste du code** : `getConfig()` rend le même objet, `updateConfig()`
  accepte le même patch. Seule la table de destination change, et `npm run check` refuse un champ
  d'`ALLOWED` sans destination, ou écrit du mauvais côté.
- **L'écran le dit** : `GET /api/config` renvoie `scopes` (produit par le registre), et chaque
  champ de `#configForm` reçoit un badge « équipe » / « ce poste ». La liste n'est pas recopiée
  côté client : dupliquée, elle mentirait au premier réglage déplacé — et un badge qui ment sur un
  jeton est pire que pas de badge.
- L'amorçage des commandes git a déménagé en fin de schéma (`db/schema/10-jenkins-config.js`) : son drapeau est devenu une donnée de
  poste, et lu avant le drain il aurait réintroduit les cinq entrées à chaque démarrage.

### L'identité qui survit au partage (`uid`, `slug`, `src/core/ulid.js`)

Les entiers auto-incrémentés sont **locaux par nature** : deux postes créent chacun le dépôt n° 12,
deux reviews de la même MR reçoivent chacune la version 2. Plutôt que de réécrire 852 requêtes,
chaque table partagée reçoit une colonne `uid` — un **ULID** (26 caractères, `src/core/ulid.js`, une
vingtaine de lignes, aucune dépendance). Les jointures continuent de passer par les entiers ;
l'uid ne sert qu'à franchir la frontière entre deux postes.

- **Triable par date de création** : les dix premiers caractères encodent l'horodatage. C'est cette
  propriété qui remplace les compteurs partagés — `review_version.version`, `agent_pass.n` et
  `agent_knowledge.version` se renumérotent en relisant les uids dans l'ordre. Deux postes qui
  reviewent la même MR en même temps produisent v2 et v3, jamais deux v2, et dans le même ordre
  chez tout le monde. Le générateur est **monotone dans la milliseconde** (variante « monotonic »
  de la spécification ULID) : on insère volontiers vingt-cinq lignes dans la même milliseconde, et
  sans cela leur ordre retomberait sur la partie aléatoire, c'est-à-dire sur rien.
- **Posé par un déclencheur, pas par les appelants** : `db.function('mergerie_ulid', …)` rend la
  fonction appelable depuis SQL, et un `AFTER INSERT … WHEN NEW.uid IS NULL` par table pose l'uid.
  Aucun des ~100 `INSERT` de l'application n'a à y penser, donc aucun ne peut l'oublier — y compris
  ceux du mode démo et des scripts. Contrepartie assumée : la base ne s'**écrit** plus depuis le
  `sqlite3` en ligne de commande ; elle se lit toujours.
- **Les lignes existantes sont reprises dans l'ordre** : l'horodatage de leur uid vient de leur
  `created_at`, pas de l'instant de la migration — sinon le tri des versions deviendrait aléatoire
  sur toute base déjà en service.
- **LE DIFF D'UNE ITÉRATION NE VOYAGE PAS, IL SE REFAIT** (`diffDePasse`, `app/lib/sessions.js`) : le patch est un fichier du clone de la machine qui a fait tourner l'agent ; l'envoyer dans le dépôt d'équipe y mettrait des centaines de kilo-octets entièrement recalculables. Ce qui voyage, ce sont les deux BORNES (`base_sha`, `head_sha`). Chez le collègue, `git diff base..head` sur SON clone rend le même patch à l'octet près ; `has_diff` est donc vrai dès que les deux bornes diffèrent, et si le clone n'a pas encore ces commits, l'écran le dit avec le geste qui répare plutôt que d'ouvrir une vue vide. Corollaire : « cette itération n'a rien changé » se déduit de `base_sha === head_sha`, JAMAIS de l'absence de patch — sur une session reçue, l'absence de patch est la règle.

- **CE QUI FAIT QU'UNE LIGNE EST LA MÊME D'UN POSTE À L'AUTRE** (`cleNaturelle` au registre, `store.upsert`) : l'uid fait l'identité, mais il est tiré LOCALEMENT. Deux postes qui découvrent la même merge request chez la forge, installent le même agent livré ou nomment pareil un vérificateur produisent deux uid pour un seul objet — et la base refuse la seconde ligne (`UNIQUE(repo_id, iid)`, `UNIQUE(slug)`, `UNIQUE(name)`), si bien que la review du collègue n'arrive JAMAIS. On déclare donc, table par table, ce qui fait l'identité réelle (`mr` → dépôt + numéro, `review` → sa merge request, `verifier` → son nom, `agent`/`note_page` → leur slug) : la ligne locale ADOPTE l'uid du dépôt, le fichier faisant foi. Un test relit les unicités RÉELLES d'une base neuve et exige pour chacune une clé naturelle ou une raison écrite (`UNIQUES_SANS_CLE`) — sans quoi le prochain cas se découvre en production, chez quelqu'un d'autre.

- **`slug` pour ce qu'on nomme en toutes lettres** (`agent`, `note_page`) : c'est lui qui nommera
  le fichier dans le dépôt partagé (`agents/documentaliste/`, `notes/deploiement-prod.md`). **Figé
  à la création**, suffixé `-2`, `-3` sur homonymie : renommer ne déplace pas le fichier, sans quoi
  chaque renommage apparaîtrait chez les collègues comme une suppression suivie d'un ajout, et
  l'historique git du fichier serait perdu. Il ne peut pas vivre dans un déclencheur (il faut
  relire la table), donc `npm run check` refuse un `INSERT INTO agent` ou `INSERT INTO note_page`
  qui ne le renseigne pas.

### Ce qui n'appartient qu'à ce poste (`local_state`, `local_pref`, `local_dir_map`)

Trois colonnes vivaient dans des tables partagées où elles n'avaient rien à faire — non parce
qu'elles sont secrètes, mais parce qu'elles **ne veulent rien dire ailleurs** :

- `agent.schedule_fired_at` → **`local_state`**. « Cet agent a tiré » : chez qui ? Trois instances
  allumées liraient chacune le tir des deux autres.
- `jira_watch.checked_at` / `error` → **`local_state`**. Ce qu'on surveille est d'équipe ; QUAND ce
  poste a regardé, et son erreur réseau, non. Recollés à la lecture, en deux requêtes.
- `task.hidden` et ses jumelles → **`local_pref`**. Ranger une session la retire de SA vue ; la
  supprimer la supprime pour tout le monde, et la confirmation le dit.
- `local_task_dir.path` → **`local_dir_map`**. Un chemin absolu ne désigne rien sur le poste d'en
  face. La ligne partagée porte `dir_hash` (l'empreinte du chemin normalisé, qui ne révèle ni
  l'arborescence ni le nom de l'utilisateur), `dir_label` et `owner` ; chaque poste résout le
  chemin chez lui. Ailleurs, la session se relit et « Relancer » est **refusé** plutôt que de
  faire travailler l'agent dans un homonyme.

Pas de clé étrangère : quatre parents possibles, comme pour `agent_pass` et `piece_jointe`. Le
ménage est explicite (`oublier()`). La référence est l'**uid** du parent, jamais son id entier —
qui se renumérote d'un poste à l'autre.

### La couche `store` : le dossier de fichiers EST la base

`src/data/store.js` fait de `data/shared/` la source de vérité ; SQLite redevient un cache
reconstructible, et les 852 requêtes de lecture ne changent pas.

- **Un fichier par entité**, nommé par un ULID ou une clé naturelle. C'est ce qui rend les
  conflits rares : deux postes ne touchent le même fichier que s'ils ont vraiment modifié la même
  chose. Un document Markdown en produit **deux** — le corps, relisible tel quel hors de l'outil,
  et son `.json` jumeau (`notes/deploiement-prod.md` + `.json`).
- **Sérialisation déterministe** : clés triées récursivement, deux espaces, aucun champ nul écrit,
  une nouvelle ligne finale. Deux écritures du même état donnent le même octet — sans quoi
  « git status propre » ne voudrait plus dire « rien n'a changé ».
- **Fichier et base dans la MÊME transaction SQLite** : si le fichier ne s'écrit pas, la ligne non
  plus. « Enregistré » ne peut jamais vouloir dire « enregistré ici seulement ».
- **Aucun identifiant de poste dans un fichier** : un dépôt se désigne `gitlab/acme/web`, une MR
  `gitlab/acme/web!218`, un agent par son slug. Une référence qui ne se résout pas est **reportée**
  (une sous-page arrivée avant son parent), puis **signalée** — jamais devinée : perdre un lien
  vaut mieux que pointer sur la mauvaise merge request.
- **Hydratation** complète ou incrémentale (`git diff --name-only`), par upsert sur l'uid. Les
  compteurs par parent (`agent_knowledge.version`) sont **recalculés dans l'ordre des uid**.
- **TOUTES les tables partagées** y passent : dépôts, merge requests (leur état de relecture
  seulement), reviews et leurs versions, constats, convergences, règles, vérificateurs et leurs
  verdicts, agents et leur carte du code, sessions de codage et d'exploration, questions libres,
  passes d'agent, pièces jointes, notes et captures, todos, lots, réglages d'équipe.
- **ON DIT CE QU'ON VA FAIRE AVANT DE LE FAIRE** (`GET /api/data-sync/preview`, `store.apercuExport()`) : le rattachement et « Tout ré-envoyer » ouvrent un récapitulatif — sens de l'échange (initialiser / rejoindre / injoignable), ce qui part par famille, **ce qui RESTE sur ce poste** (sessions et todos privées par défaut : c'est là que sont les surprises), combien de documents le distant porte déjà, et fichier par fichier combien seront **ajoutés / modifiés / inchangés**. `supprimes` vaut 0 et ce n'est pas une estimation : l'export écrit, il ne supprime jamais — d'où le compte des fichiers du dépôt qui ne seront **pas touchés**, ceux des collègues. `apercuExport()` compose en mémoire ce que `exporterTout` écrirait et n'écrit rien. **Deux colonnes côte à côte** pour ce qui part et ce qui reste — leur opposition EST l'information, une par famille avec le nombre à gauche —, puis les quatre chiffres des fichiers, zéro des suppressions compris : c'est celui qu'on vient vérifier. **Devant un dépôt VIDE, tout compte comme ajouté** : `apercuExport()` compare au répertoire de travail, qui porte déjà ce que ce poste s'est écrit à lui-même, et annoncer « 0 ajouté, 12 inchangés » avant d'initialiser un dépôt nu reviendrait à dire que rien ne part. L'aperçu interroge le distant (`ls-remote`), donc il prend le temps du réseau : le bouton tourne (`busy()`) et la ligne d'état dit ce qu'on attend — sinon on le re-clique.
- **UNE CONVERSATION D'AGENT NE VOYAGE PAS, SA TRANSCRIPTION SI** (`transcriptionDesPasses`, `taskrunner.js`) : `session_key` ne vaut que dans le `~/.claude` de la machine qui l'a ouvert — il vit dans `local_session` et ne part jamais. Le suivi envoyé depuis le poste qui a REÇU la session repartait donc d'un agent neuf, avec le seul texte du suivi : ni la tâche d'origine, ni les échanges précédents. Le repli `promptRepli` existait mais ne servait qu'après un échec de reprise, jamais quand il n'y avait rien à reprendre. On réinjecte désormais `buildCodePrompt(task)` + la transcription des passes partagées (demande + retour de chacune, blocs de protocole retirés) dès que `doResume` est faux. Bornée **par la fin** (24 000 caractères, 4 000 par retour) : on garde les plus récentes et on DIT combien sont omises. La passe enregistrée, elle, garde le prompt de l'utilisateur — sans quoi la transcription contiendrait la transcription.
- **ET LE CAS SYMÉTRIQUE : RATTRAPER UNE SESSION LOCALE EN RETARD** (`passesVenuesDAilleurs`, `taskrunner.js`) : la session d'ici est reprenable, mais la passe du collègue arrivée par la synchro n'est PAS dans la mémoire de l'agent local — il repart de l'état où il avait laissé les choses, sur une branche qui porte déjà les commits de l'autre. Chaque passe locale pose un repère dans `local_state` (`session`/`<uid de la cible>`/`derniere_passe`) : l'**uid** de la passe, jamais son `n` — ce dernier est un compteur local, renuméroté à chaque hydratation dans l'ordre des uid, et un repère posé dessus désignerait une autre passe dès qu'une itération s'intercale. Toute passe d'uid postérieur vient d'ailleurs : on réinjecte celles-là SEULES, sous un en-tête qui dit ce qui s'est passé. On ne rejoue pas sa propre conversation — l'agent s'en souvient, et la lui resservir le ferait douter de ce qu'il a fait. Sans repère — toutes les sessions qui existaient déjà — on reconnaît une passe venue d'ailleurs à SON FICHIER : l'hydratation écrit `tasks/passes/<session>/pass-<uid>.md`, une passe produite ici s'écrit `output-v<n>.md` dans le dossier de son unité. Sans cette lecture, une passe arrivée AVANT la première itération locale lui serait antérieure, donc invisible pour toujours. Dès la première itération locale, le repère reprend la main.
- **UN DIFF NE SE TRANSPORTE PAS, IL SE RECALCULE** (`diffDeLaMr`, `app/lib/visionneuse.js`) : `review.diff_path` est un chemin LOCAL, il ne part pas dans le dépôt de données — et `/api/mrs/:id/diff` comme `/tree` ne lisaient que lui. Le collègue qui reçoit une review ouvrait « le code » sur un arbre sans un seul fichier colorié et un diff vide. Le diff d'une MR est une fonction de deux références que tout le monde a : on le recalcule depuis le clone quand le fichier manque, en visant le **commit relu** tant que le clone le porte (l'arbre affiché montre ce commit-là), repli sur la tête de branche sinon. **Aucun `fetch`** tant que les références sont présentes : `/diff` et `/tree` partent en parallèle depuis l'écran, et deux fetch simultanés se disputeraient les verrous du clone. `git.diffTroisPoints` sert les deux chemins, pour que l'arbre et les fichiers marqués parlent du même commit.
- **…ET POUR UNE SESSION, ON VISE SON COMMIT** (`diffDeLaCible`, `app/routes/tasks.js`) : `task_target.diff_path` est lui aussi un fichier local. Un repli existait — `git.branchDiff` — mais il comparait `origin/<base>...HEAD`, et HEAD c'est la branche sur laquelle le CLONE se trouve, pas celle de la session : sur le poste qui a fait tourner l'agent les deux coïncident (d'où un test qui passait pour de mauvaises raisons), ailleurs il rendait le diff d'un travail sans rapport. On vise `origin/<base_branch>...<commit_sha>` — la référence même que l'arbre affiche à côté.
- **LE TITRE D'UNE MR VOYAGE, LE SHA NON** (`store-registry.js`, entrée `mr`) : titre, branches et auteur ne partaient que pour une MR FERMÉE — partager du mutable fait voyager du périmé. L'argument tombe devant ce qu'il produit : le poste qui n'a pas encore découvert la MR l'affichait SANS TITRE dans « à relire », et « Voir le diff » partait sur `origin/null...origin/null`. Il n'y a pas de tour de rôle : les deux postes lisent la MÊME forge, donc convergent ; le pire cas est un titre d'une minute en retard, qui vaut mieux qu'une ligne vide — et c'est tout ce qu'aura un poste sans jeton de forge. Le **SHA courant**, lui, ne part pas : il avance à chaque push, et c'est le seul champ dont une valeur en retard fait relire un diff qui n'existe plus. `targetedDiff` refuse une branche vide avec un message qui NOMME ce qui manque, et la liste affiche le numéro seul plutôt qu'un tiret cadratin pendu.
- **UNE LIGNE QUI NE SAIT PAS ENCORE DEVENIR UN FICHIER RESTE DANS LA FILE** (`ecouler`, `store.js`) : l'intention était écrite au-dessus du `catch` — une review dont la MR vient d'être supprimée, une passe dont la session ne se résout pas encore attendent le passage suivant. Un `oublier.run()` INCONDITIONNEL suivait le `catch` et retirait la ligne de toute façon : le fichier n'était jamais écrit, la file était vide, et rien ne le disait. Constaté en vrai : deux suivis sur neuf sans fichier dans le dépôt, jamais écrits, file vide, aucune erreur. La ligne est désormais gardée quand l'échec est un « pas encore » (`store :` ou `store-registry:`), et un échec définitif est JOURNALISÉ — une fois par ligne et par processus — au lieu de disparaître.
- **LE FICHIER D'UNE MR NE PORTE PAS SON `updated_at`** (`store-registry.js`, entrée `mr`) : la découverte réécrit CHAQUE merge request ouverte à chaque passage — mêmes valeurs, horodatage neuf. Exporté, il faisait changer tous les fichiers de MR à chaque découverte : un commit par MR et par tour, et un CONFLIT de rebase sur chacun dès que deux postes découvraient entre deux synchros, sur des documents que personne n'avait touchés. Il n'est pas dans `partagees` : c'est une observation locale, du même bois que `current_sha`.
- **LE REBASE BOUCLE JUSQU'À CONVERGER** (`rebaser`, `datasync.js`) : un rebase coince autant de fois qu'il a de commits à rejouer. On n'en résolvait qu'un — le second faisait échouer `--continue`, on abandonnait, les versions écrasées n'étaient même pas gardées, et le tour suivant rejouait la même scène : « ↑2 » pour toujours. On boucle tant que `.git/rebase-merge` existe, on `--skip` un commit rejoué que la résolution a vidé, et on n'abandonne qu'en dernier recours — en le DISANT dans `etatSync.erreur`.
- **UNE BASE VIDE SE RÉHYDRATE, ET NE VIDE PAS LE DÉPÔT** (`tourMaintenant`, `balayer`) : à ↑0 ↓0 le tour sortait avant la branche qui hydrate, donc « supprime `reviewer.db`, tout revient » était faux sans un clic. Le retour anticipé exige désormais `dernierHydrate()`. Et le balayage REFUSE de retirer une dizaine de fichiers pour une table qui n'a plus aucune ligne : c'est le pendant exact du garde-fou de l'hydratation — supprimer sa dernière note, elle, ne retire qu'un fichier.
- **UN DOCUMENT MALFORMÉ N'EMPORTE PAS L'HYDRATATION** (`hydraterFichiers`) : seul `upsert` était protégé ; `fromFile` (qui écrit sur le disque et refuse un chemin hors du dossier de données) et `hydraterListes` ne l'étaient pas. Une exception remontait au tour, `hydrated_at` n'avançait plus, et chaque tour rejouait le même échec — la synchro de l'équipe bloquée par un fichier d'un seul poste.
- **LA FILE D'ÉCRITURES SURVIT À UNE HYDRATATION** (`hydraterFichiers`) : le vidage de fin emportait aussi ce qui attendait AVANT — une ligne gardée faute de dépendance, ce qu'un traitement de fond avait écrit sans qu'aucune requête ne l'écoule. On relève la file d'avant et on la remet.
- **UN TOUR COMMITE AVANT DE POUSSER** (`tourMaintenant`, `datasync.js`) : la file d'écritures est écoulée par le serveur à la fin de chaque requête NON-GET (`res.on('finish')`), et c'est `marquerSale` qui arme alors le commit groupé. Tout ce qui s'écrit HORS d'une requête ne passait par personne — découverte de MR, review qui se termine, session qui commite, veille Jira : le travail restait dans la file, aucun commit n'était armé, et le tour ne trouvait rien à pousser. Vu de l'utilisateur : « ça ne part que quand je clique », le bouton appelant `commiter()` puis `tour()`. Le tour fait désormais le même geste ; sans rien à commiter, c'est un `git add -A` et un `diff --cached` vide.
- **UN SEUL GIT À LA FOIS DANS LE DÉPÔT** (`seul()`, `datasync.js`) : le tour périodique, le commit groupé (armé 3 s après la dernière écriture) et le rattachement écrivent dans `data/shared` sans se connaître. Deux à la fois = `Unable to create index.lock: File exists`, et c'est le geste de l'utilisateur qui échoue parce qu'une minuterie avait pris le verrou. `enCours` ne protégeait que le tour contre lui-même. Les trois passent par une file : une demande **attend son tour au lieu d'échouer**, dans l'ordre demandé, et la file survit à une opération qui échoue. Le tour périodique, lui, est **sauté** s'il tombe pendant un autre geste — il repassera. Les appels internes (`rattacher` commite lui-même) passent par la version nue : se remettre en file derrière soi ne se débloquerait jamais. Le test ne compte pas les erreurs, qui dépendent du moment, mais les **processus git vivants en même temps**.
- **UNE ADRESSE N'EST PAS UNE OPTION** (`sansOption`, `datasync.js`) : l'URL et la branche partent telles quelles dans l'argv de `git`, et l'URL ne vient pas que des réglages — l'aperçu la prend dans la query string d'un GET, que n'importe quelle page ouverte dans le navigateur peut appeler. Une valeur qui commence par un tiret (`--upload-pack=<commande>`) serait lue comme une option, c'est-à-dire une commande exécutée ici. Elle est refusée à la source plutôt que comptée sur un `--` à chaque appel : un oubli y serait invisible.
- **« TOUT RÉ-ENVOYER »** (`POST /api/data-sync/reexport`) : « Synchroniser » n'envoie que ce que la FILE porte, donc rien après un dépôt vidé à la main. Le geste passe par `rattacher` — un dépôt remis à zéro par une branche orpheline n'a plus d'ancêtre commun avec l'historique local, et un commit suivi d'un push serait refusé. Il LIT le dépôt avant d'écrire : le travail d'un collègue est hydraté puis réécrit à l'identique, jamais perdu.

- **UNE SYNCHRO NE VIDE PAS UNE BASE** (`hydraterFichiers`, garde-fou avant les suppressions) : « un fichier parti emporte sa ligne » est juste pour UN document, et catastrophique pour un dépôt remis à zéro — reviews, sessions, agents, vérificateurs effacés d'un coup, le reste par cascade SQL. C'est arrivé en vrai. On compare donc ce qui disparaît à ce qui RESTE : plus de dix documents disparus ET plus que ce qui reste — OU plus rien du tout à l'arrivée, qui est le même accident sur un petit dépôt — = le dépôt a été vidé, pas les objets supprimés. On refuse, on garde tout, et `etatSync.erreur` le dit (le pied de page passe au rouge) plutôt que d'afficher « à jour ». Les fichiers manquants se réécrivent d'un « Cloner / rattacher ».

- **CE QUI SORT NE DIT PAS OÙ L'ON HABITE** (`ctx.masquer`, `store.js`) : `last_error` (session, cible, dossier hors dépôt, question), `log_excerpt`, `restore_error`, `context_json` sont des textes produits par un processus lancé ICI — ils citent `/Users/<login>/…`. Les trois racines connues (dossier de données, dossier de clonage, home) sont remplacées à l'export par `<data>`, `<clones>`, `~` : le message garde son sens et se lit sur n'importe quelle machine. La plus LONGUE d'abord, sinon masquer le home empêcherait de reconnaître le reste.

- **UNE POLITIQUE AUTOMATIQUE A UN EXÉCUTANT** (`auto_runner`, réglage d'équipe ; `executantAuto()`/`autoAMoi()` dans `app/lib/decouverte.js`) : `auto_review_new`, `auto_rereview_stale` et les cases `auto_on_*` d'un vérificateur voyagent, mais chaque instance a sa propre file de jobs et sa propre découverte — deux postes allumés donnaient DEUX reviews par merge request (deux versions, deux facturations) et deux commentaires sur la forge. C'est le cas des agents planifiés (`agent.runner`), que le spec avait vu, appliqué aux politiques, qu'il avait manquées. Sans exécutant désigné : personne n'agit (défaut sûr). En mono-poste (`data_repo_url` vide) : comportement inchangé à l'octet près. **Deuxième réponse, `@auteur`** (`AUTEUR_AUTO`) : la décision devient par merge request — `mrsAMoi()` ne garde que celles dont l'auteur est le compte du jeton de la forge (`mrDeMoi`, via `forgeIdentite`) ; compte inconnu ⇒ rien ne part, et le journal le dit.

- **LES NOMS SONT D'ÉQUIPE, LES VALEURS NON** (`src/verify/verifierenv.js`) : `verifier.env_json` portait des VALEURS d'environnement — le lieu naturel d'un `DATABASE_URL` ou d'un `NPM_TOKEN` — et `INTERDITS` ne regarde que le NOM de colonne, donc rien ne l'arrêtait. La colonne est vidée et GELÉE (assertion au démarrage, comme les jetons de `config`) ; le fichier porte `env_keys` (les noms seuls, pour que le collègue sache quoi renseigner) et les valeurs vivent dans `local_state` (`kind = 'verifier_env'`, `ref` = uid du vérificateur). La carte d'un vérificateur dit combien de variables restent à renseigner ICI. `INTERDITS` gagne `/^env(_json)?$/i` pour que la prochaine colonne du même genre ne repasse pas. De même, `agent_pass.cost_usd` est LOCAL : la dépense est déjà opt-in par un total quotidien, la partager par passe la redonnait par session.

- **UN BROUILLON NE PART JAMAIS**, quelle que soit la case de son parent : `mr_comment_draft` (famille **L**), `task.followup_draft`, `question.followup_draft`, `local_task.followup_draft`, `task.agent_draft_json` (tous dans `locales`). Un brouillon n'est pas un commentaire — il se modifie jusqu'à un envoi explicite —, et les partager faisait que deux relecteurs de la même MR se voyaient mutuellement RÉDIGER, le `last-writer` du fichier de la MR pouvant écraser les remarques de l'un par celles de l'autre. Le PRODUIT, c'est le commentaire POSTÉ : `comment_log` (d'équipe), alimenté aussi par l'envoi des remarques inline.

- **PRODUIT OU PROCESSUS — la règle qui décide entre « par table » et « ligne par ligne ».** Un objet que l'équipe *consomme* (review, règle, vérificateur, agent, carte du code, lot, état d'une MR) se partage **par table** : c'est un produit, et le produire pour soi seul n'aurait guère de sens. Un objet qui décrit *comment une personne a travaillé* (session de codage, exploration, question libre, page de notes) se partage **ligne par ligne, sur choix explicite, défaut non** — une seule mécanique pour tous : la colonne `shared INTEGER NOT NULL DEFAULT 0` et `partageable(row, ctx)` au registre. Les ENFANTS suivent leur parent (`agent_pass`, `piece_jointe` → `ctx.sessionPartagee(scope, id)`) : une session ne peut pas être « à moitié » partagée, publier le retour de l'agent sans la demande qui l'a produit n'aurait pas de sens. Ce qui arrive du dépôt pose `shared: 1` (il est là, donc il est partagé) ; décocher RETIRE les fichiers ; le jour où une donnée devient privée, elle sort du dépôt (balayage unique, repère dans `local_state`). **Seul l'auteur** (au sens git, `auteurs()`) bascule ou supprime : un collègue RANGE (`hidden`, préférence de poste) — supprimer effacerait le travail d'un autre chez tout le monde.

- **QUATRE ONGLETS RESTENT À SOI, comme Liens** : **Docker**, **Jenkins**, **Git** et **Jira**. Une palette de commandes git, un job Jenkins visé, un conteneur sauvegardé, un ticket surveillé : tout cela décrit une MACHINE, ses accès et une façon de travailler — pas un produit. Le partager imposerait à chacun l'outillage du voisin, ferait voyager un journal d'actions que personne d'autre ne peut rejouer, et remplirait la liste de todos de tout le monde au premier changement d'état d'un ticket suivi par un seul. `store.js` retire UNE FOIS du dépôt les fichiers de ces onglets (repère `menus_locaux` dans `local_state`) : le balayage ne connaît que les tables qui écrivent encore, donc sans ce retrait ils resteraient là et la prochaine hydratation d'un collègue les reposerait chez lui.

**CE N'EST PAS L'APPELANT QUI PRÉVIENT LE STORE, C'EST LA BASE.** Un déclencheur par table
partagée note la ligne touchée dans `store_sale` ; `store.ecouler()` écrit ensuite les fichiers.
L'application compte plus de deux cents écritures réparties dans vingt modules : les passer une
par une en revue, c'était se donner rendez-vous avec l'oubli — il aurait suffi qu'une écriture
ajoutée l'an prochain n'appelle pas le `store` pour qu'un objet cesse silencieusement d'être
partagé. Trois conséquences, toutes voulues :

- **La file est dans la même transaction que l'écriture.** Un processus tué entre la ligne et le
  fichier ne perd rien : le démarrage suivant trouve la file et écrit ce qui manque.
- **On écoule après la réponse HTTP**, pas avant : l'utilisateur n'attend pas l'écriture de ses
  fichiers, et une erreur de disque ne transforme pas une sauvegarde réussie en erreur 500.
- **Une suppression déclenche un BALAYAGE.** Elle ne peut pas dire quel fichier retirer — le
  chemin se calcule en JavaScript, pas en SQL : on compare donc le dossier aux lignes restantes.
  Plus coûteux, mais c'est le seul moyen de garantir qu'il ne reste jamais un fichier orphelin,
  lequel ferait revenir l'objet à la prochaine hydratation.

Deux pièges rencontrés, notés parce qu'ils ne se devinent pas : `INSERT OR IGNORE` **ne
fonctionne pas dans un déclencheur** (SQLite applique la résolution de conflit de l'instruction
extérieure), d'où une file sans clé primaire et un `DISTINCT` à la lecture ; et un `ORDER BY id`
échoue sur les tables nommées par une clé naturelle (`jira_watch`, `config`), d'où `rowid`
partout.

### La synchronisation git (`datasync.js`)

- **Commits groupés** trois secondes après la dernière écriture : une review, c'est trois fichiers
  et une MR touchée ; sans regroupement, quatre commits pour un seul geste. Message généré, en
  anglais, sur une ligne, **à partir du geste** (`note "Prod deploy"`, `todo done: …`) — pas
  « update 3 files ».
- **Boucle** `fetch` → `pull --rebase` → hydratation incrémentale → `push`, trois essais puis on
  laisse les commits locaux. **Hors ligne est le cas normal**, pas une panne.
- **Conflits** : la version distante l'emporte, la sienne est **gardée** dans `local_state` et
  reprenable d'un clic. Attention au piège : **pendant un rebase, `--ours` et `--theirs` sont
  inversés** par rapport à un merge — c'est `--ours` qui désigne la version d'en face. Les
  conflits sont regroupés **par objet**, pas par fichier : l'utilisateur a modifié une page, pas
  deux fichiers.
- **L'écran suit la synchro** : `store.versionDonnees()` avance à chaque hydratation qui pose ou
  retire des lignes, `/api/status` le sert (`dataVersion`), et la page recharge compteurs et écran
  affiché quand il change. Une page de notes s'enregistre avec la date de ce qu'elle affiche
  (`base_updated_at`) : différente, 409 `PAGE_MODIFIEE` et le choix à l'écran. Le formulaire des
  réglages n'envoie que ses champs modifiés.
- **Auteur d'un partage** = premier à avoir écrit le fichier (`local_state` `author/first`, relu
  par `git log --diff-filter=A`), pas le dernier : une page corrigée par l'équipe reste à qui l'a
  partagée, et lui seul peut la retirer ou la supprimer.
- **Identité = identité git** (`src/core/identite.js`). Sans `user.name`, rien n'est commité, et
  l'écran le dit : un historique dont l'auteur est « unknown » ne répond pas à la seule question
  qu'on lui pose.
- **Exécutant d'un agent planifié** (`agent.runner`) : sans lui, trois instances lanceraient trois
  fois le même agent. Vide = à la main seulement, et c'est le défaut.
- **Historique d'une page de notes** (`git log` sur son fichier) : le seul service que git rend
  gratuitement, et qu'il fallait prendre.

### La merge request, coupée en deux (§ 10)

`mr` est un **cache** : la forge fait foi de son titre, de ses branches, de son SHA, de son
auteur et de ses fichiers changés — les écrire dans le dépôt ferait voyager du périmé. Ce qui se
partage, c'est ce qu'un **humain** a décidé : `status`, `reviewed_sha`, le contexte saisi à la
main, les options de merge, les projets liés, les brouillons de commentaire et le journal des
commentaires postés. Ces colonnes sont nommées une par une dans `partagees`, et c'est la seule
liste qui fasse foi. Une MR absente de la forge mais présente dans le dépôt — fermée depuis —
est hydratée telle quelle : ses reviews restent lisibles.

`mr` porte tout de même un `uid`, alors que son FICHIER est nommé par la clé naturelle : les deux
ne servent pas à la même chose. Le fichier se nomme `mrs/gitlab/acme/web/218.json`, qui désigne
la même merge request partout ; l'uid est une identité **locale** stable, qui rattache le handle
de session de review dans `local_session` — un `id` entier ne conviendrait pas, SQLite les
recycle, et une MR supprimée puis redécouverte hériterait de la session d'une autre.

### « par &lt;nom&gt; » — sans colonne `author`

Le fichier d'un objet partagé a été commité par quelqu'un : git le sait. Tenir une colonne à côté
serait une seconde vérité à aligner, et elle mentirait le jour où le fichier est corrigé à la
main. `datasync` lit `git log --format=%x00%an --name-only` après chaque `pull` — un seul appel
pour tous les fichiers touchés — et garde le nom dans `local_state`. L'API l'expose sur les
sessions, les vérifications et la dernière passe de review ; en mono-poste il n'y en a pas, et
« par moi » sur chaque carte n'apprendrait rien.

### Ce qui reste à faire

Les six lots de `shared_database.md` sont livrés. Restent deux choses que la spécification
elle-même laisse ouvertes : la **rétention** ne purge pas encore le dépôt de données (elle
supprime les lignes, donc les fichiers suivent, mais l'historique git garde tout — ce qui est le
but), et **git LFS** n'est pas câblé (le `.gitattributes` du § 11 n'est pas fourni : une équipe
qui dépasse quelques centaines de mégaoctets l'ajoutera elle-même, git s'en charge sans que
Mergerie ait rien à faire).

## Ce que le rapport d'améliorations a ajouté (2e passe)

- **`usage.owner_kind = 'mr'`** : une review porte enfin son coût. `copilot.runPrompt` transmet
  `meta.owner` ; `reviewer.js` le pose dans les deux points d'enregistrement (session d'agent ou non).
  Sans lui, les statistiques ne pouvaient donner qu'une MOYENNE par merge request.
- **`review_rule.repo_id`** (NULL = tous les dépôts) : `reviewer.js` écarte la règle avant même de
  regarder son motif. Limiter la portée passait sinon par un `path_match` que seul ce dépôt satisferait.
- **`jira_watch.todo_on_change`** : au changement d'état, `notes.todoAuto('jira_watch', clé, …)` pose la
  todo avec le MOTIF de surveillance en note. Best-effort : la surveillance ne casse pas pour une todo.
- **`config.task_default_*`** (4 colonnes) : les cases de la modale de session sont des habitudes de
  TRAVAIL, distinctes des habitudes de DÉPÔT (branche de départ, squash) qui vivent dans le navigateur.
- **`docker.restoreArgs` / `restoreContainer`** : distincts de `reconstructRunCommand`, qui compose une
  ligne À LIRE et masque les secrets. Restaurer rejoue les VRAIES valeurs, en tableau d'arguments — ce
  module n'appelle jamais de shell.
- **Routes neuves** : `POST /api/mrs/:id/notify-jira` (B2), `GET /api/notes/:id/images` (B6),
  `GET /api/jenkins/build-links` (B10), `GET /api/docker/local-links` (B8),
  `POST /api/docker/backups/:id/restore` + `DELETE` (A/Docker 1), `GET /api/agent-sessions`.
- **`brief.pretesAMerger`** : la péremption d'un verdict ne se lit pas en SQL (les cibles vivent en JSON
  dans `verification.targets_json`) — le compte se fait donc en JS, avec la règle exacte de l'écran.

## Pipeline de review (par MR)

1. **Discover** (API) : liste les MR ouvertes filtrées → upsert `mr`.
2. **Review** (job de fond, séquentiel) :
   - clone/fetch (SSH ou HTTPS+token) + submodules ;
   - **diff ciblé** `origin/target...source` écrit **dans le clone** (`ai-dev-tools-internal/`, bac à sable de l'IA ; ce dossier est ajouté à `.git/info/exclude` du clone pour ne jamais être committé) ;
   - contexte **ticket** (Jira auto + complément manuel + capture) et **règles** de branche injectés au prompt ; l'IA émet en plus un **bloc de constats structurés** (retiré du rapport affiché) qui alimente le suivi de résolution ;
   - l'IA **écrit son rapport dans un fichier** (pas de capture stdout polluée) → `review.md` ; un **2ᵉ appel optionnel** → `explanation.md` ;
   - **explication conditionnelle** : `reviewMr(…, { explain })` — `explain` surcharge le réglage global `config.review_explain` (`'1'` par défaut). En « review seule », le 2ᵉ appel est sauté et `explanation_path` reste `NULL` pour cette version (pas d'héritage de l'explication précédente, contrairement au `modify`) ;
   - `status = reviewed`, `reviewed_sha = current_sha`.
   - **Continuité de session** : hors dry-run et si le backend est reprenable, la review/modif tourne dans une **session d'agent par MR** (`review-mr-{id}`, via `agentsession`) → « Relancer la review » et « Régénérer le rapport » **reprennent** la session précédente (l'agent se souvient de son analyse). Repli one-shot sinon. Le comptage de tokens reste assuré (`copilot.recordUsage`).
3. **Modif IA**, **re-review** : même pipeline (kind dédié), écrase le rapport.
4. **Explication à la demande** : `explainMr` (kind `explain`) produit **la seule** explication pour la version courante d'une MR déjà reviewée (1 appel IA), sans nouvelle version — sert au bouton « Générer l'explication » quand la review a été lancée sans.
5. **Re-review incrémentale** : `reviewMr(…, { incremental })` (via `rereview` + `opts.incremental`). `prepareContext` diffuse alors le **delta** `git diff reviewed_sha..current_sha` (`git.diffRange`) au lieu du diff complet `target...source`, et signale `incremental` en retour ; `reviewMr` injecte le **rapport précédent** en `extra` et demande un rapport COMPLET à jour. **Best-effort** : SHA delta absent (force-push) ou `reviewed_sha == current_sha` → repli automatique sur le diff complet. Économique : petit diff = moins de tokens, c'est le moteur de la « boucle de convergence ».
6. **Review automatique à l'arrivée** : `lancerReviewsAuto(result.new_mr_ids)` dans `decouvrir()`, à côté de `lancerVerificationsAuto` et sur le même modèle — **un seul job** pour le lot (comme « Reviewer les N MR »), borné par `review_auto_max`, et ce qui n'est pas parti est compté dans `result.auto_review.plafonnees` puis journalisé. Branché sur `new_mr_ids`. `stale_mr_ids` a **sa propre case** (`auto_rereview_stale`) et son propre budget : `lancerRereviewsAuto` y filtre les MR qui ont VRAIMENT un rapport périmé (`review` existante et `reviewed_sha != current_sha`, hors `done`) et lance un `rereview` **incrémental** — sans le filtre, la case « rapport périmé » lancerait des premières reviews. Les deux passent par `lancerLotReview`, pour que le plafond ne puisse pas diverger entre elles.
7. **Rattrapage de la branche de départ** : bouton affiché **uniquement** si `task_target.mr_conflicts = 1`. Le drapeau vient de la forge (`has_conflicts`/`detailed_merge_status`/`merge_status` côté GitLab, `mergeable`/`mergeable_state` côté GitHub, normalisés en `true`/`false`/`null`) et se relève dans la passe de découverte qui interroge **déjà** ces merge requests pour savoir si elles sont mergées — aucun appel d'API de plus. `null` (GitHub calcule `mergeable` en différé) laisse le bouton caché : on ne devine pas. La modale de merge interroge la forge à l'ouverture (`GET /api/mrs/:id/merge-check`, ou `/api/tasks/:id/targets/:tid/merge-check` qui rend en plus `base_branch`/`rebasable`) : le résultat est écrit sur `mr.has_conflicts` **et** sur les `task_target` de la même branche, si bien que le bouton de la ligne suit sans attendre la découverte. Action de job `update-base` → `taskrunner.mettreAJourDepuisBase(taskId, targetId)`. `git.rebaseSur(cwd, base)` rejoue la branche sur `origin/<base>` ; à chaque arrêt, les fichiers `--diff-filter=U` partent dans `prompt.rebase-conflicts` (un `copilot.runPrompt` one-shot, pas la session de codage : résoudre un conflit n'est pas la suite de son fil), puis `git.rebaseContinuer` (`GIT_EDITOR=true`, sinon l'éditeur bloque le processus). Garde-fous : plafond de 5 résolutions, refus de continuer si un marqueur `<<<<<<<` subsiste, et `git.rebaseAbandonner` dans tous les cas d'échec — un rebase en plan rendrait le clone inutilisable. La cible repasse en `committed`, `force_push = 1`, `push_command` en `--force-with-lease` : **rien n'est poussé**. La case « Forcer le push » de la confirmation (option `check` de `confirmDialog`, qui rend alors `{ ok, checked }` au lieu d'un booléen) est envoyée en `force` à `POST /tasks/:id/targets/:tid/push` et fait autorité ; `pushTarget` ne retombe sur le drapeau que si l'appelant n'a rien dit (`force === undefined` : « Pousser tout », auto-push). `pushTarget` et l'auto-push d'`execOnTarget` lisent ce drapeau et passent `--force-with-lease --force-if-includes` (jamais `--force` : le bail est ce qui protège le commit d'un collègue), puis le remettent à 0. Un refus s'inscrit sur `task_target.last_error`, là où l'on a cliqué.
8. **Suivi pré-rempli avec un rapport** — deux boutons, deux routes, le même principe : le prompt est RENDU PAR LE SERVEUR, la liste des sessions ne porte que des booléens (`has_review`, `has_verify_fail`) parce qu'elle se redessine toutes les 1,5 s pendant un job.
   - review : `GET /api/tasks/:id/review-prompt` : `GET /api/tasks/:id/review-prompt`  (option `?target_id=`) relit les rapports **sur le disque** des merge requests des projets de la session et rend `prompt.apply-review` (un projet) ou `prompt.apply-review-multi` + un bloc par projet. La liste des sessions ne porte qu'un booléen `has_review` par cible — charrier le Markdown de chaque rapport à chaque rafraîchissement (toutes les 1,5 s pendant un job) serait hors de question. Côté écran, le bouton ne fait que **remplir** le champ de suivi, et confirme avant d'écraser un brouillon.
   - vérification : `GET /api/tasks/:id/verify-prompt` rend `promptCorrectionVerif(d, v)` — **la fonction même** qu'emploie `POST /api/verifications/:id/fix`, extraite pour que le suivi et la session neuve ne puissent pas donner deux textes différents. Filtré sur `verdict = 'verified_fail'` ET `imputable` non vide, exactement comme le drapeau qui décide de l'affichage du bouton.
9. **Rapport publié sur la merge request** : `reviewer.publierRapport(mr, cfg)` relit le rapport **sur le disque** (`review.md_path`), le poste via `forge.clientFor(mr).postMrNote`, l'inscrit dans `comment_log` et horodate `review.comment_posted_at`. Un seul chemin pour les deux déclencheurs — le bouton `Publier sur …` du rapport (`POST /api/mrs/:id/publish-review`, qui n'accepte **aucun corps** du client) et le réglage `auto_post_review`, appliqué en fin de `reviewMr` dans un `try/catch` : une forge injoignable est journalisée, elle ne fait pas échouer la review. Ce qui part automatiquement passe d'abord par `reviewer.publicationAutoRequise(cfg, findings)` (exportée, testée seule) : `auto_post_blocking_only` y exige au moins un constat `blocker` de la passe — une passe sans constat n'en a aucun, donc ne part pas, et le journal du job écrit le nombre de constats pour distinguer « rien de bloquant » d'un bloc de constats absent. Le bouton, geste explicite, ne consulte jamais cette règle. En mode démo, la note part dans le fil simulé de `demo-comments`.

## Merge de branche à branche (`gitmerge.js`, onglet Git → Merge)

1. **Un worktree dédié**, jamais le clone partagé : un merge se résout sur plusieurs requêtes, et laisser le clone à moitié fusionné bloquerait reviews, sessions et vérifications — le premier `ensureCleanWorktree` venu l'annulerait sans prévenir. Répertoire `data/merges/`, distinct de `data/worktrees/` que `verifyrun.gcWorktrees` vide à chaque démarrage : un merge se REPREND après un redémarrage.
2. **Détaché sur `origin/<destination>`**, `merge --no-commit --no-ff origin/<source>`, puis `push HEAD:refs/heads/<destination>`. Aucune branche locale créée ni déplacée : pas de collision avec la branche que le clone principal a sortie, et rien qui reste en avance après coup.
3. **Git fait foi** : les fichiers en conflit se relisent (`--diff-filter=U`), la résolution est un `write` + `git add`, le message part de `MERGE_MSG`. La table `git_merge` ne retient que le lien demande ↔ worktree.
4. **Un seul assembleur** : `src/git/conflits.js` (module PUR, sans base ni disque) découpe les marqueurs et recolle selon les choix. L'écran envoie des CHOIX, le serveur recolle ; l'édition libre envoie du texte. Deux assembleurs auraient fini par ne plus dire la même chose.
5. **Histoires sans ancêtre commun** : `git merge-base` est interrogé AVANT le worktree ; sans ancêtre, refus portant `code: 'UNRELATED'` (exposé par `wrap`, lu par `api()` côté écran) et message explicatif, plus une relance possible avec `--allow-unrelated-histories`.
6. **Deux gestes séparés** : `POST …/commit` refuse tant qu'un conflit reste, `POST …/push` refuse tant que rien n'est commité. `DELETE` retire le worktree et la ligne.

**Décor de démo** : `scripts/demo-seed.js` fabrique un dépôt git RÉEL (`data-demo/depots/tarification.git`, deux branches sur la même ligne) et marque une merge request `has_conflicts = 1`. Sans lui, l'onglet Merge et le bouton de rattrapage sont inatteignables en `npm run demo`. `demo-git.refs(project, kind, url)` lit les VRAIES refs quand l'URL désigne un dossier existant.

## Convergence (« Converger », `converge.js`)

Machine à états qui **orchestre les briques existantes** dans un **seul job de fond** (kind `converge`, tient la file — sous-étapes séquentielles). Boucle pour une MR :

1. Note **à jour** : si aucune review ou MR périmée, on (re)review d'abord (incrémentale si possible).
2. `note ≥ seuil` ? → **convergé**. `passes ≥ plafond` ? → **plafond**. Sinon :
3. **Correction IA** (`applyFixAndPush`) : `ensureRepo` → `checkout -B branch origin/branch` → prompt « applique les corrections du rapport » → `commitAll` → si rien de committé → **no_change** ; sinon `pushBranch`. Le nouveau SHA devient `mr.current_sha`. **Convergence depuis une session** (`ctx = { task, targetId }`) : la correction **reprend la session du dev** (continuité) et, si l'option « l'IA pose une question » est active, peut émettre un bloc `<<<QUESTIONS>>>` → **`needs_input`** : la boucle **s'arrête proprement**, la cible stocke les questions, notif `needs_input` ; l'utilisateur répond (formulaire de session) puis **relance Converger**. (Convergence depuis une MR : chemin one-shot, sans questions.)
4. **Re-review incrémentale** du delta (`reviewed_sha..newSha`) → nouvelle note.
5. `note ≥ seuil` → **convergé** ; `note ≤ note précédente` → **régression/stagnation** (arrêt) ; sinon on continue.

> **`needs_input` dans la boucle** : peut aussi survenir dès le **dev initial** d'une convergence-session (`bootstrapMrForTarget` → `execOnTarget`) — la MR n'est alors pas créée tant que les questions ne sont pas répondues.

**Garde-fous v1** : seuil atteint · note qui baisse/stagne · plafond de passes. **JAMAIS de merge** : la boucle prépare, l'humain valide (les commits sont poussés mais la MR n'est pas mergée). Toute la trace reste visible via `review_version` (note par passe) + git (commits). Réglages `converge_threshold`/`converge_max_passes` (globaux, surchargés au lancement). État exposé dans le détail MR (`convergence`) → **panneau de run** sur le rapport ; notification `converge_done` à la fin. *(v2 : garde-fou « hors périmètre » + action de lot « Converger la file ».)*

**Depuis une session de dev** (`convergeSession`, kind `converge-session`, endpoint `POST /api/tasks/:id/converge`) : *du prompt à la MR convergée*. Pour **chaque projet en série** — `bootstrapMrForTarget` : dev IA (réutilise `taskrunner.execOnTarget` avec `forcePush`) → commit → push → **crée la MR** via `forge.clientFor(tg).createMergeRequest` (cible = `task_target.base_branch`) → **upsert ciblé** de la MR dans la table `mr` (`discover.upsertMrFromApi`, via l'objet API complet pour le SHA) — puis délègue à `convergeRun(mrId)`. **Idempotent** : cible déjà codée → pas de recodage ; `mr_iid` déjà présent → convergence directe. Un projet en échec est consigné sur sa ligne `task_target` et n'interrompt pas les suivants. Bouton sur la **modale de nouvelle session** et le **détail de session** (kind `code`).

## Vérification objective (`verify.js` / `verifyrun.js`)

Une review donne un AVIS ; un vérificateur donne un FAIT. Le script est celui de l'utilisateur — Mergerie
fait **tout le git** et ne lui demande que « les tests passent-ils ».

**Double run causal.** On lance la suite sur la **base** avant de la lancer sur la **tête**, et le verdict
naît de la comparaison : `fail`/`fail` sans delta n'est pas un échec de la branche mais une **base rouge**.
Sans ce second run, un test cassé par quelqu'un d'autre serait imputé à la MR — c'est-à-dire un verdict
faux, ce qui est pire que pas de verdict. Le run base est **mis en cache** par jeu de SHAs (empreinte
portant aussi la commande : une commande modifiée invalide le cache).

**Deux familles, un seul verdict.** `commands` déduit son résultat des CODES DE SORTIE et cherche les noms
de tests dans un rapport JUnit déclaré, puis dans le TAP de la sortie, puis nulle part — auquel cas la
COMMANDE devient la clé du delta, ce qui dégrade juste : la même commande rouge des deux côtés donne
« base rouge », pas une accusation. Un vérificateur peut couvrir plusieurs dépôts : la même liste y est
REJOUÉE dans chacun, verdict = ET, échecs
préfixés du dépôt (deux projets ayant un test homonyme seraient sinon confondus par le delta). Arrêt à la
première commande en échec DANS un dépôt (dépendance), poursuite d'un dépôt à l'autre (indépendance).

**Ce qu'on refuse dépend de ce qui tourne**, et la distinction suit la réalité des runs. Une vérification
**multi-dépôts** est un run d'intégration : elle monte un environnement complet, souvent des containers sur
des ports et des bases fixes. Elle bloque donc tout le monde et se fait bloquer par tout le monde. Une
vérification **mono-dépôt** est contenue dans son répertoire : il suffit de vérifier qu'elle ne vise pas le
même dépôt qu'une autre. `verifyBloquePar(repoIds)` rend la RAISON (`meme-depot` | `integration`) plutôt
qu'un booléen — les deux ne se corrigent pas de la même façon, et le message le dit. Refuser globalement
renverrait l'utilisateur à son écran alors que tous les autres jobs de Mergerie attendent leur tour.

**Rien n'est jamais un vert par défaut.** Commande introuvable, sortie tronquée, timeout, workdir
invalide : tout tombe en `verify_error`. Le seul chemin vers `verified_pass` est une liste de commandes
allée jusqu'au bout, toutes sorties à zéro.

**Ce qu'on a trouvé est restauré.** Jamais de `stash` automatique — déplacer le travail non commité de quelqu'un sans le lui dire n'est pas un service à rendre : on refuse, il décide. Worktrees supprimés dans un `finally`, orphelins ramassés au boot,
répertoire *in place* remis sur sa ref d'origine y compris sur timeout — et si la restauration échoue,
`restore_error` le dit de façon persistante au lieu de le noyer dans un journal.

**« Corriger »** ouvre UNE session de codage couvrant **tous** les dépôts du lot, sur les **branches des MR**
(le push les met à jour en place), avec les tests cassés et les commits testés dans le prompt. L'imputabilité
d'un échec d'intégration est indécidable a priori : le test casse dans un dépôt, la cause est souvent dans
un autre. L'agent voit tout le lot et décide.

**Déclenchement automatique à la découverte.** Un vérificateur coché `auto_on_mr` part seul sur les merge
requests **nouvelles** de ses dépôts — `discoverAll` remonte `new_mr_ids`, et `lancerVerificationsAuto`
crée une vérification par MR couverte. Deux garde-fous portent tout le mécanisme : seules les MR NOUVELLES
comptent (une MR connue est revue à chaque synchronisation — sinon la même vérification repartirait
indéfiniment), et un plafond de `MAX_VERIF_AUTO = 5` par tour de découverte, parce que quinze batteries
fonctionnelles saturent la machine pour une heure et bloquent la file partagée avec les reviews. Au-delà du
plafond, les MR gardent leur bouton `Vérifier` et le journal serveur dit ce qui n'est pas parti. Les
vérifications d'un même dépôt sont MISES EN FILE au lieu d'être refusées (`enFile`) : elles ne tournent
jamais ensemble — le verrou `repo:<id>` tient — mais aucune n'est perdue en silence.

## Pipeline de session (par projet)

**Codage** — pour **chaque projet** de la session, séquentiellement : clone/fetch → branche (alignée
sur le remote si elle existe, sinon créée depuis la branche de départ saisie, ou à défaut la branche
par défaut du dépôt) → **prompt IA qui modifie les fichiers** → commit → diff persistant → push
(manuel avec confirmation, ou auto) → **créer la MR** → **merger** (seulement si la forge renvoie
`state=merged`). Un projet en échec est consigné sur **sa** ligne et n'interrompt pas les suivants ;
le statut de la session est un **agrégat** des statuts de ses projets.

**Enrichissement Jira (optionnel, à la création)** — `POST /api/jira/fetch { key }` réutilise
`jira.fetchIssue` + `issueToContext` (ADF → Markdown) et renvoie `{ key, summary, context }`. Le front
**préfixe le prompt** avec ce bloc de contexte (choix : injection visible/éditable plutôt qu'un champ
stocké séparé — zéro changement de schéma). Le numéro est pré-rempli via la clé détectée dans la
branche (`/([A-Za-z]+-\d+)/`, même règle que `jira.ticketKey`). `GET /api/status` expose
`jiraConfigured` pour n'afficher le bloc que si Jira est configuré.

**Exploration (lecture seule)** — chaque dépôt est placé sur la branche demandée, puis **un seul**
appel IA est lancé avec pour `cwd` la **racine des clones** : l'agent voit tous les projets en
sous-dossiers et produit **une synthèse transversale** écrite dans un `.md` persistant. Quoi qu'il
arrive (y compris en cas d'échec), les worktrees sont remis à zéro dans un `finally`
(`git checkout -- .` + `git clean -fd`) : l'agent tourne en mode « yolo » et *pourrait* écrire, la
garantie de lecture seule est donc structurelle et non déclarative. Les questions de suivi rejouent
le cycle avec la réponse précédente en contexte.

## Prompts injectés & formats de sortie imposés (en dur)

Ce que l'app **ajoute au prompt** de l'utilisateur et ce qu'elle **exige en sortie**. Les gabarits de base
(review / explain / modify) sont **éditables** (Réglages, défauts dans `src/core/prompts.js`, `{placeholders}`
remplis à l'exécution) ; **tout le reste ci-dessous est en dur dans le code** et jamais montré à l'utilisateur.

**Gabarits de base éditables** (`src/core/prompts.js`, fr/en, variables `{skill}` `{source}` `{target}` `{diff_file}` `{previous}` `{instruction}`) :
- `prompt_review` — « Utilise le skill `{skill}` pour faire la revue… du diff `{diff_file}`… note globale. »
- `prompt_explain` — explication pédagogique en Markdown.
- `prompt_modify` — « Voici un rapport existant : `{previous}` … applique `{instruction}`, renvoie le rapport complet. »

**Fragments ajoutés en dur au prompt** (à l'exécution, selon le contexte) :
- **Écriture dans un fichier** (review/explain/modify, `reviewer.js`) : « écris le résultat final en Markdown UNIQUEMENT dans le fichier `{out_file}` … sans le dupliquer dans la sortie standard. » → l'app lit ce fichier, repli sur stdout s'il est vide.
- **Bloc de constats** (review seule, `reviewer.js` `FINDINGS_INSTRUCTION`) : voir format ci-dessous.
- **Contexte de ticket** (`reviewer.js`) : bloc Jira (« Contexte du ticket `{KEY}` … ») et/ou texte du relecteur (« Contexte complémentaire fourni par le relecteur… »), entre `"""` ; capture d'écran : « une capture … est disponible dans le fichier `{rel}` — ouvre-la ». 
- **Règles de review** (review seule, `reviewer.js`) : « Critères additionnels spécifiques à vérifier… » puis une ligne `- (règle {why}) {content}` par règle qui matche (branche ou chemin).
- **Projets liés** (review seule, `reviewer.js`) : « Cette MR modifie le projet **X**. D'AUTRES PROJETS en dépendent… » + liste des montages lecture seule ; demande de citer fichier + ligne des impacts, **sans rien modifier** des projets liés.
- **Session de codage** (`taskrunner.buildCodePrompt`) : « Réalise la tâche de développement suivante dans ce dépôt. Modifie directement les fichiers nécessaires.\n\n`{prompt}` ».
- **Suivi de session** (`taskrunner.runTaskFollowup`) : « Tu travailles sur une branche existante… le travail précédent est déjà committé. Applique la demande de suivi… ».
- **Captures jointes** (`taskrunner.attachImages`) : « Des captures d'écran sont fournies (ouvre-les) : » + liste de chemins relatifs.
- **Exploration** (`taskrunner.runExploration`) : « Tu explores N dépôt(s)… QUESTION : `{question}` … LECTURE SEULE — ne modifie/crée/supprime AUCUN fichier… écris UNE SEULE réponse de synthèse … UNIQUEMENT dans le fichier `{out_file}` ». (worktrees remis à zéro après → garantie structurelle.) Une question de suivi n'ajoute « Tu as déjà produit la réponse suivante : """…""" » **que si la session n'est PAS reprise** : quand elle l'est, l'agent a déjà ce qu'il a écrit — et surtout ce qu'il a LU.
- **Correction de review** (même texte, deux points d'entrée) : « Voici une revue de code de la branche X. Applique directement… les corrections PERTINENTES (bugs, sécurité, robustesse, correction fonctionnelle ; ignore le cosmétique ou ambigu).\n\n`=== RAPPORT DE REVUE ===`\n`{reviewMd}` ». Utilisé par la **convergence** (`converge.applyFixAndPush`) **et** par le bouton **« Corriger la review »** d'une MR (`POST /api/mrs/:id/fix-review`, `server.js` — crée une session de codage préremplie avec ce prompt). La convergence y ajoute `QUESTIONS_INSTRUCTION` quand la session porte l'opt-in.
- **Codage hors dépôt** (`localcoder.js`) : « Réalise la tâche… dans ce dossier. Modifie directement les fichiers… » (EN PLACE, sans git) ; en suivi, « Tu as déjà travaillé dans ce dossier lors d'une passe précédente… » — même esprit que la session de codage, **sans la mention de git** : ici il n'y a ni branche ni commit précédent à évoquer.
- **Correction d'une vérification** (`POST /api/verifications/:id/fix`, `server.js`) : prompt bâti sur les FAITS du run — « La vérification « X » a échoué[ sur le lot]. », la liste des tests **imputables** (nom, message, extrait de journal tronqué à 12 lignes), « Commits testés : » (une ligne `branche @ sha8` par dépôt), puis « Corrige la cause dans le ou les dépôts concernés. Ne touche que ce qui est nécessaire. Commit et push sur les branches existantes : les merge requests seront mises à jour en place. ». Sans ces faits l'agent redécouvre au prix d'un aller-retour ce que la vérification sait déjà ; les branches EXISTANTES sont imposées pour que les MR se mettent à jour au lieu d'en ouvrir d'autres.
- **Repli quand la session à reprendre est introuvable** (`taskrunner.execOnTarget`, paramètre `promptRepli`) : on ouvre une session neuve avec un prompt qui **réinjecte la tâche d'origine** — une demande de suivi (« applique cette correction ») ne se comprend pas sans elle, et c'est la session perdue qui la portait. Le premier run passe son propre prompt tel quel : le défaut le dupliquerait.
- **L'IA pose une question** (opt-in, `questions.QUESTIONS_INSTRUCTION`) : consigne d'émettre un bloc `<<<QUESTIONS>>>` et de **s'arrêter avant** d'implémenter la partie ambiguë ; **reprise** (`questions.buildAnswerInstruction`) : « Voici les réponses à tes questions : … Poursuis la tâche à partir de là. ».
- **Banc d'essai de reprise** (`aisession.js`) : deux prompts de test (« Mémorise ce marqueur secret : X … » puis « Rappelle-moi le marqueur… »).

**Formats de sortie EXIGÉS (contrats de parsing)** :
- **`<<<FINDINGS` … `FINDINGS>>>`** (`resolution.js` `START`/`END`) : une ligne par constat, `sévérité | fichier | ligne | titre court` ; sévérité ∈ {blocker, major, minor, info} ; **titre stable** (clé d'appariement du suivi de résolution). Émis aussi par le mock dry-run (`copilot.mockReport`). Parsé par `resolution.parseFindings`, retiré du Markdown affiché.
- **`<<<QUESTIONS` … `QUESTIONS>>>`** (`questions.js`) : **tableau JSON** `[{ id, question, context, options: [{value,label}]|null }]` ; `options:null` → réponse libre ; **5 max** ; malformé/absent → ignoré (session non bloquée). Simulé par le dry-run (`taskrunner.DRYRUN_QUESTIONS`).
- **Note globale `X/Y`** (`note.js` `extractNote`) : cherchée en texte libre du rapport (ligne « note »/« score » avec fraction, sinon toute fraction sur base 5/10/20/100, sinon lettre A–F). Normalisée en `note_value` ∈ [0,1].
- **`--output-format stream-json --verbose`** (claude, `agentsession.js`) : émet des **événements NDJSON en direct** (streaming — progression visible : texte de l'assistant + outils utilisés `🔧`), et le dernier `type:result` expose `result` (texte) + `session_id` (vérification croisée de la reprise). Copilot est streamé ligne par ligne (pas de mode événements). Le texte final de l'agent est **sauvegardé** (`taskrunner.saveAgentOutput` → `output.md`, `task_target.output_path`) → consultable via **« Retour de l'IA »**.
- **Marqueur `=== RAPPORT DE REVUE ===`** : séparateur en dur entre la consigne de correction et le rapport injecté (convergence).
- *(Hors IA)* Les formats **TAP** et **JUnit XML** lus de la sortie des commandes d'un vérificateur sont eux aussi des contrats de parsing, mais imposés à un programme de l'utilisateur, pas à un agent : voir « Vérification objective ».

## Rétention de l'historique

`retention.js` — `config.retention_days` (défaut 90, 0 = illimité, plancher 7). Purge au démarrage puis une
fois par jour (`setInterval` **unref**, sinon le processus refuserait de s'arrêter) : `job_log`, `job` et
`feed` au-delà du délai. Les journaux sont supprimés AVANT leurs jobs — l'inverse laisserait des lignes
orphelines que plus rien ne référence (pas de cascade). Un job `queued`/`running` n'est **jamais** purgé,
si ancien soit-il. `usage` (coût cumulé en tokens, un total qui ne doit pas baisser) et `agent_pass`
(disparaît déjà avec sa session) sont épargnés à dessein.

`notes.js` a son propre ménage, distinct : les todos **faites** depuis plus de **7 jours** reçoivent
`archived_at` (au boot puis une fois par jour). Ce n'est pas une purge — rien n'est supprimé, la todo
sort seulement des listes par défaut et reste consultable sous « Archivées ».

## File de jobs

Un **worker séquentiel** traite une file : reviews, re-reviews, modifs et tâches passent par la même file (un traitement à la fois). État persisté en `job`/`job_log` → survit à la fermeture d'onglet. **Stop** sans argument tue tout et vide la file ; **avec un id**, il n'arrête que ce job. Un arrêt DEMANDÉ finit en `stopped`, jamais en `error` — les opérations git et docker étaient les seules à ne pas faire la distinction, et affichaient le Stop de l'utilisateur comme un échec. Un job `stopped`/`error` rejouable expose `can_retry` et se relance depuis le bandeau (`POST /api/jobs/:id/retry`), qui crée un NOUVEAU job.

**Une seconde voie, à la demande** : depuis le panneau de logs on voit la file (`GET /api/jobs/queue`) et on peut en sortir un job pour le lancer **à côté** de celui en cours (`POST /api/jobs/:id/start-now`). Ce n'est jamais automatique — deux jobs dans le même clone git le corrompent. Mergerie ne se contente pas d'avertir : `jobKeys(entry)` déduit ce que le job va toucher (`repo:<id>`, `dir:<chemin>`, `*` = périmètre inconnu → refus par prudence) et `keysClash` REFUSE le parallèle en cas d'intersection. **La voie séquentielle est soumise à la même règle** : `pump` ne démarre pas une tête de file qui entrerait en collision avec un job parallèle — sans ce test, promouvoir un job puis laisser la file avancer suffisait à mettre deux process dans le même clone. Elle ATTEND au lieu de sauter au suivant (l'ordre affiché est celui qu'on a sous les yeux), et la fin de n'importe quel job relance la tentative — pas seulement la fin d'un job principal, sinon la file resterait bloquée sur une tête en conflit. Plafond de **3 jobs simultanés** (`MAX_RUNNING`, voie séquentielle comprise). Ce n'est pas le code qui limite — contextes d'annulation, détection de conflit et onglets de journal passent tous à l'échelle sans rien changer — c'est la machine : chaque job de codage ou de review lance un agent, et au-delà on ne gagne plus de temps, on les fait ramer ensemble. Le bandeau décrivant UN job, il annonce combien tournent quand il y en a plusieurs — l'onglet dit lequel on lit. Un onglet **survit à la fin de son job** : il prend une pastille (vert terminé, rouge en erreur, gris arrêté) et garde son journal jusqu'au prochain LOT de jobs. Chaque onglet d'un job EN COURS porte son propre **Stop** (`POST /api/jobs/:id/stop`), qui n'arrête que lui et laisse la file intacte ; le Stop du bandeau reste le « tout arrêter » et le dit désormais quand plusieurs jobs tournent. Le job « courant » peut changer sans que rien ne commence (le principal finit, un parallèle devient le plus récent en cours) : le panneau ne se vide donc que pour un job qu'il ne suivait pas encore, et `GET /api/jobs/current/log` prend un `expect` — si l'id ne correspond plus à celui que le client croyait courant, son curseur ne vaut rien et les lignes repartent du début.

L'**annulation est par job** (`proc.js`) : un booléen de module suffisait tant qu'un seul job tournait, mais à deux il ferait qu'un Stop arrête le voisin et tue le mauvais process enfant. Le contexte est porté par un **`AsyncLocalStorage`** plutôt que passé en paramètre — les appels à `proc.*` descendent jusque dans `git.run` et `copilot.runPrompt`, un argument de plus aurait contaminé toutes les signatures intermédiaires. Hors job (explorateur, find-ref…), un contexte **ambiant** jamais annulé prend le relais. Actions de session (kind `task`) : `run` / `followup` / `push` / **`answer`** (reprise après réponses aux questions de l'IA).

## Rafraîchissement automatique des MR

Optionnel, piloté par `config.auto_refresh_minutes` (0 = off, **minimum 1 min** contre les rate limits). **Côté serveur** : un `setInterval` relance `discoverAll()` (appel API de la forge de chaque dépôt), sans chevauchement (garde `autoRefreshBusy`) ; (re)configuré au démarrage et à chaque `PUT /api/config`. **Côté front** : l'intervalle est exposé dans `GET /api/status` (`autoRefreshMinutes`) ; un polling recharge alors les listes **depuis la base locale** (aucun appel de forge supplémentaire) pour que la liste des MR à traiter se mette à jour toute seule.

## API REST (extrait)

- Config/dépôts : `GET/PUT /api/config`, `GET/POST/PUT/DELETE /api/repos[...]`, `POST /api/repos/bulk` (champ **`forge`**, absent = `gitlab` → contrat inchangé), `GET /api/gitlab/projects|branches`, **`GET /api/github/projects`**, **`POST /api/github/test`** (valide le token, renvoie le login).
- Découverte/jobs : `POST /api/discover`, `POST /api/jobs/review`, `POST /api/jobs/stop` (body `job_id` optionnel) et **`POST /api/jobs/:id/stop`**, `GET /api/jobs/current[/log]`, **`GET /api/jobs/:id/log`** (l'onglet du job parallèle), **`GET /api/jobs/queue`** (`{running, queued, parallelBusy}` — chaque job en attente porte ses `keys` et ses `conflicts`, de sorte que l'écran dit POURQUOI il ne peut pas démarrer au lieu de griser un bouton) et **`POST /api/jobs/:id/start-now`**, **`POST /api/jobs/:id/retry`**.
- Diff avant review : `GET /api/mrs/:id/diffview` (clone à la demande + diff en direct, pour juger sans appel IA).
- Résolution : `GET /api/mrs/:id/findings[?v=N]` (constats + statut d'une version), delta inclus dans `GET /api/mrs/:id/versions`, taux dans `GET /api/stats`.
- MR : `GET /api/mrs[/:id]`, `/:id/review` (body `explain` optionnel : surcharge ponctuelle du réglage global), `/:id/explain` (génère l'explication seule), `/:id/rereview` (body `incremental` optionnel : ne relire que le delta depuis `reviewed_sha`), `/:id/converge` (body `threshold`/`maxPasses` optionnels : lance la boucle « Converger »), `/:id/modify|fix-review|done|reopen|delete-review|comment|clear-error|merge`, `/:id/diff|tree|file|filediff`, `/:id/discussion[s]`, `/:id/discussions/:discId/reply`, **`PUT /:id/notes/:noteId`** (modifier un commentaire ; body `inline` pour aiguiller côté GitHub), `/:id/ticket[-image]`.
- **Agents** : `GET /api/agents[/:id]`, `POST /api/agents` (400 + `{ errors: [clé i18n] }`), `PUT/DELETE /api/agents/:id`, `POST /api/agents/:id/duplicate|restore`, **`POST /api/agents/:id/run`** (`mode: 'ask'` LANCE ; `mode: 'code'` ne lance PAS — il rend un `prefill` que la modale de session affiche, parce qu'un agent qui se met à écrire dans des dépôts qu'on n'a pas vus est exactement ce que la règle « un agent ne devine jamais un dépôt » interdit), `GET /api/agents/:id/preview` et `POST /api/agents/preview` (l'argv d'un formulaire non enregistré), **`POST /api/agents/domain`** (`{ subject, repo_ids? }` : lance le cartographe ; l'agent naîtra de la SORTIE du run), `GET/PUT /api/agents/:id/knowledge[/:version]`, `POST /api/agents/:id/knowledge/refresh|publish`, `POST /api/agents/:id/knowledge/:version/activate`, **`GET /api/agents/:id/age`** (route à part : elle fait un fetch par dépôt, jamais dans la liste), `POST /api/agents/tick` (déclenche un tick d'horaire sans attendre la minute).
- **Skills** : `GET /api/skills?repos=1,2` (`{ items, uncloned }`), `POST /api/skills/rescan`.
- Sessions et agents : `GET /api/tasks?agent_id=`, `POST /api/tasks` accepte `agent_id` (la demande est alors composée par le profil, `auto_push` forcé à 0) et `skills`, `GET /api/tasks/:id/md` rend le Markdown **sans** les blocs de protocole (`?raw=1` les garde), **`GET /api/tasks/:id/repo-hint`** (le dépôt nommé par `<<<REPO>>>`, résolu contre les dépôts connus — un dépôt inventé n'ouvre aucun bouton).
- Règles : `GET/POST/PUT/DELETE /api/rules`.
- Vérification objective : `GET/POST/PUT/DELETE /api/verifiers[/:id]`, **`GET /api/verifiers/for?repos=1,2`** (quels vérificateurs couvrent CE jeu de dépôts — sert à griser le bouton avec l'explication plutôt qu'à lancer un run voué à l'échec), **`POST /api/verifiers/test-workdir`** (`{repo_id, workdir}` → répertoire reconnu ? branche ? modifié ? — répondu pendant que le formulaire est encore sous les yeux) ; `POST /api/mrs/:id/verify`, **`POST /api/verify/mrs`** (`{mr_ids}` : vérifier ensemble sans lot enregistré), `GET/POST/DELETE /api/lots[/:id]` + `POST /api/lots/:id/verify`, `GET /api/verifications[?mr_id=]` et `GET /api/verifications/:id`, **`POST /api/verifications/:id/fix`** (session de correction multi-dépôts). Le **résumé** du dernier verdict voyage avec chaque MR de `GET /api/mrs` (badge) : verdict, péremption, nombre de tests cassés — jamais les journaux.
- Sessions : `GET/POST/PUT/DELETE /api/tasks[...]` (avec `kind`, `targets: [{repo_id, branch, base_branch}]`, `ask_questions` : opt-in « l'IA peut poser des questions », et **`session_id`** : session d'agent existante à reprendre au lieu d'en ouvrir une neuve — création seulement), `/:id/run|followup|md|clear-error|image|followup-draft` (`run` ET `followup` acceptent `targets: [ids]` pour ne (re)traiter que certains projets d'une session multi-dépôts — une remarque porte presque toujours sur un seul ; refusé sur une exploration, qui produit une synthèse unique), `/:id/converge` (body `threshold`/`maxPasses` : du prompt à la/les MR convergée(s)). **`PUT /:id/followup-draft`** (`{ instruction }`) enregistre le **suivi en attente** — écrit pendant que la session tourne, corrigé tant qu'il n'est pas parti, un texte vide vaut suppression ; `POST /:id/followup` **sans instruction** le reprend et l'efface en un geste (retiré AVANT le lancement, remis si le lancement échoue : deux clics rapides ne l'envoient pas deux fois). Le body accepte aussi **`auto`** : le suivi part alors SEUL à la fin de la session (`suiviAutomatique` dans `jobs.js`, le seul chemin d'envoi non déclenché par un clic — texte retiré et case désarmée AVANT le lancement, sinon la passe de suivi retrouve la consigne en finissant et la session boucle ; rien après un échec ni sur `needs_input` ; le vérificateur de session attend la fin de ce suivi). Décoché — le défaut — rien ne le déclenche : `taskrunner.js`, `localcoder.js`, `converge.js` et `copilot.js` ne connaissent même pas la colonne, et deux tests de source le vérifient, dont un qui exige que `jobs.js` ne la lise QUE dans cette fonction.
- Codage hors dépôt : `GET/POST/PUT/DELETE /api/local-tasks[/:id]` (`{ prompt, dirs: [chemins], session_id }` ; le **PUT** ne recrée les lignes de dossier que si leur composition change — sinon corriger le prompt effacerait statut, retour d'agent et handle de session), `/:id/run` (l'IA code dans chaque dossier local, sans git), **`/:id/followup`** (`{ instruction }` → nouvelle passe reprenant la session de chaque dossier), **`GET /:id/dirs/:did/output`** (retour de l'agent pour un dossier), **`PUT /:id/followup-draft`** (même contrat de suivi en attente que les sessions sur dépôt).
- Question libre : `GET/POST/PUT/DELETE /api/questions[/:id]` (`{ prompt, label }` — pas de cible, donc rien à valider d'autre), `/:id/run`, **`/:id/followup`** (`{ instruction }` → nouvelle passe REPRENANT la session d'agent), **`PUT /:id/followup-draft`**, **`GET /:id/md`** (la réponse) et **`GET /:id/passes[?n=]`** (l'historique des questions et de leurs réponses). Le **PUT** ne touche pas à la session : corriger une formulation ne doit pas faire perdre le fil. `POST /:id/hidden` range, `POST /:id/clear-error` solde l'erreur.
- Actions **par projet** : `/api/tasks/:id/targets/:tid/diff|push|mr|merge`, **`/diffview|/file|/filediff`** (viewer plein écran — MÊMES helpers serveur que les routes de MR : `viewerPayload`/`viewerFile`/`viewerFileDiff`, seul le contexte de clone change), et **`/answer`** (`{ answers: {qid: valeur} }` → **passe le projet en `running` dès l'envoi** — il quitte `needs_input` pour que le formulaire ne réapparaisse pas pendant la reprise — puis reprise de la session d'agent après réponses aux questions ; une reprise en échec → `error` avec la vraie raison). Les projets exposent `resume_cmd` (commande de reprise au terminal) et, en attente, `questions` (bloc parsé).
- **Dictée vocale** : **`POST /api/dictation/transcribe`** (corps BRUT `audio/wav`, ≤ 10 Mo ; `seq`, `ctx`, `final` et `lang` en query — Express 4 ne lit pas un multipart sans dépendance, et les métadonnées d'un segment y tiennent très bien ; répond `{text, command, seq, duration_ms, engine_ms, dropped}` où **`duration_ms` est mesurée sur le WAV reçu**, ce qui prouve en test que l'audio a traversé la chaîne), **`GET /api/dictation/status`** (fournisseur, langue, silence réglé, nombre de termes de vocabulaire, passages écartés, journal du moteur), **`POST /api/dictation/warmup`** (chauffe au survol du micro : charger le modèle coûte 1 à 3 s), **`POST /api/dictation/test`** (le diagnostic : étapes ordonnées `{key, status, detail, remedy}`, arrêt à la première ✗) et **`POST /api/dictation/install`** (`{model, vad, gpu}` validés **avant** la mise en file → job `install` dont le journal se lit par les routes de jobs existantes). L'audio n'est jamais écrit sur disque.
- Reprise de session (banc d'essai) : `POST /api/ai-sessions/test` (deux passes dans la même session pour valider la reprise ; simulé en dry-run).
- Git multi-dépôts : `GET /api/git/refs` (branches/tags), `POST /api/git/preview` (aucun effet), `POST /api/git/execute` (via la file de jobs), `GET /api/git/ops`, `POST /api/git/ops/:id/restore`, `GET /api/git/branches` (explorateur, exige un clone local), `GET /api/git/tag-author?repo_id&tag` (**auteur exact d'un tag** — le *tagger* d'un tag annoté, lu à la demande dans le clone local car aucune des deux API de forge ne l'expose), `GET /api/git/find-ref?name&type` (**recherche d'une ref à travers tous les dépôts actifs** : tag et/ou branche ; pour un tag trouvé, on renseigne aussi la ou les **branches qui le portent** via le clone local ; dépôt injoignable marqué `error`, jamais confondu avec « absente ») ; `POST /api/git/mr` crée une MR entre une branche et sa source depuis l'explorateur.
- Répertoires locaux (`localrepos.js`) : `GET/POST/DELETE /api/local-roots[/:id]`, `GET /api/local-roots/:id/projects`, `GET /api/local-projects/branches`, `POST /api/navigate/checkout` (positionne N projets sur leur branche, bilan par projet). **Commandes Git** : `GET/POST/PUT/DELETE /api/git-commands[/:id]` (**palette** nom + commande figée, Réglages → Git), **`POST /api/git-run`** (`{ targets: [{root_id, name}], command }` → **même commande git à la racine de chaque projet** ; `parseGitArgs` tokenise en respectant les guillemets, **sans shell** ; `assertSafeGitArgs` **refuse les options git à exécution arbitraire** (`-c`/`--config`, `--upload-pack`/`--receive-pack`/`--exec`, `-C`/`--git-dir`/`--work-tree`/`--namespace`/`--exec-path`, transport `ext::`/`fd::`) et **impose une sous-commande en tête** — « sans shell » ne suffit pas car git a lui-même des flags-RCE ; exécution préfixée de `-c protocol.ext.allow=never` + `GIT_TERMINAL_PROMPT=0` ; capture stdout+stderr et le code de sortie **sans lever** sur code ≠ 0 ; bilan `{command, results:[{project, code, ok, output, truncated}], counts}`).
- Docker : `GET /api/docker/status` (démon joignable ? sinon message actionnable), `GET /api/docker/compose` (tous les projets compose + drift ; un seul `ps -a`, projets calculés en parallèle), **`GET /api/docker/compose/list`** (liste légère → affichage progressif) + **`GET /api/docker/compose/one?dir=&file=`** (détail d'un projet à la demande), `GET /api/docker/orphans` (containers hors-compose), `POST /api/docker/compose/preview-down` (aperçu, sans effet), `POST /api/docker/compose/action` (`{ dir, action: up|restart|pull|recreate|build|down, services }` → file de jobs, log streamé ; `build` = `up -d --build`), **`POST /api/docker/bulk-action`** (`{ action, targets: [{dir, service}] }` → **action groupée** : services cochés regroupés par répertoire → un `docker compose` par projet, dans un seul job `op:compose-bulk` séquentiel, un échec n'arrête pas les autres), `GET /api/docker/orphan/:id/reconstitute` (inspect → `docker run` lisible), `POST /api/docker/orphan/:id/remove` (sauvegarde l'inspect puis supprime), `GET /api/docker/backups`, `GET /api/docker/summary` (`{error, exited, unhealthy, total, running}` → badges santé du menu. Les trois familles sont comptées **séparément** côté serveur (`healthSummary`) — un container arrêté n'est pas cassé — et c'est le BADGE qui additionne : **rouge = `error + exited`** (de l'extérieur, un service arrêté ne rend pas plus de service qu'un service en crash-loop), **orange = unhealthy**. La bulle du badge rouge garde la distinction : « 1 container en erreur (restarting/dead) · 1 container arrêté (exited) » ; **polling front toutes les 30 s** — un seul `docker ps -a`, en pause si l'onglet navigateur est masqué → l'état s'affiche dans le titre du menu même hors de l'onglet Docker), `GET /api/docker/containers` (liste plate pour l'onglet Logs), **`GET /api/docker/logs/stream?ids=…&tail=N`** (SSE — **seul endpoint non-JSON** : un `docker logs -f` par container, lignes `data: {c,m}` taguées par container ; process tués à la déconnexion ; ≤ 12 containers ; **`StringDecoder` par flux** — sans lui un caractère UTF-8 à cheval sur deux chunks se décoderait en deux moitiés invalides — et lignes envoyées **brutes** : le rendu (texte nu par défaut, couleurs sur demande) est un choix CLIENT, rejouable sur le tampon sans relancer le flux, et les filtres portent toujours sur le texte nu (`dlogText`) ; filtrage inclure/exclure fait **côté client**, persisté en localStorage).
- Jira : `POST /api/jira/test` (valide URL/email/token sur un ticket témoin), `POST /api/jira/fetch` (récupère un ticket par sa clé → contexte Markdown prêt à injecter dans une session), `POST /api/mrs/:id/jira-refresh` (re-fetch à la demande), **`GET /api/jira/assignees`** (`{ me, people }` → filtre par personne : moi + assignés récents), **`GET /api/jira/tickets?assignees=<accountIds>&includeDone=0|1`** (tickets des personnes cochées ; vide = mes tickets → `{ configured, issues, total }`), **`GET /api/jira/issue/:key`** (détail : métadonnées + description + commentaires + pièces jointes + **transitions** possibles), **`POST /api/jira/issue/:key/transition`** (`{ transitionId }` → **change l'état** du ticket ; id validé numérique), **`POST /api/jira/issue/:key/comment`** (`{ text }` → **poste un commentaire** ; texte converti en ADF via `textToAdf`), **`GET /api/jira/attachment/:id`** (proxy de téléchargement d'une pièce jointe — id numérique, URL construite sur la base Jira configurée → pas de SSRF ; `Content-Disposition` unicode). **Tickets surveillés** : `GET/POST /api/jira/watch` (`{ key, note }`), **`PATCH /api/jira/watch/:key`** (`{ note }` — corriger la raison sans perdre la date d'ajout ni l'état connu, ce qu'un retrait/ré-ajout ferait), `DELETE /api/jira/watch/:key`, `POST /api/jira/watch/check`.
- Dashboard/footer : `GET /api/stats` (funnel, **`lowScores`** = rapports notés < 7/10 encore au stade *reviewed*, ce que badge l'onglet Reviews en orange — restreint au travail EN ATTENTE, sinon le compteur ne redescendrait jamais, distribution + **évolution hebdo de la note** via review_version, table par projet avec **taux de résolution** et **tendance** 28 j vs 28 j, **coût en tokens par type d'appel** + **coût moyen par MR reviewée** depuis la table usage — total = minorant), `GET /api/dashboard/commits` (**dernier commit par dépôt SUIVI** — actif ET récupération des MR active —, **TOUTES BRANCHES confondues** — `all=true` chez GitLab ; GitHub n'a pas d'équivalent, on y lit les ÉVÉNEMENTS du dépôt (seuls porteurs des pushes hors branche par défaut) puis on relit le commit désigné, avec repli sur la branche par défaut si les événements sont absents ou expirés (90 j). Live depuis la forge, best-effort, chargé en asynchrone : alimente la colonne « dernier commit » du tableau projets ET le **Top 5 activité récente**), `GET /api/footer` (tokens, activité perso, paliers, activité équipe).
- Export : **`POST /api/export/docx`** (`{ title, markdown }` → `.docx` en pièce jointe, nom de fichier en UTF-8 via `filename*`). Seul format qui passe par le serveur — un ZIP se fabrique avec `zlib`, alors qu'au front il faudrait embarquer une bibliothèque de compression pour un bouton.
- **`GET /api/dashboard/activity`** — activité mensuelle des dépôts SUIVIS sur 6 mois (`{ configured, months, projects: [{ project, counts[6], authors[6], total, contributeurs, partiel, erreur }] }`). Cache en base par (dépôt, mois) : un mois clos est définitif, seul le mois courant est rafraîchi (TTL 30 min) — sinon six mois d'historique se repagineraient depuis la forge à chaque ouverture. Best-effort par dépôt : une forge injoignable remplit `erreur` sur SA ligne au lieu de vider l'écran.
- Activité : dépôts interrogés **4 à la fois** (`pmap.js`, partagé avec Docker) ; les commits de **robots** (`[bot]`, dependabot, renovate, github-actions, mergify) sont écartés du compte — sinon un dépôt abandonné mais mis à jour par un robot ne serait jamais « endormi » ; dates normalisées en **UTC** avant rangement, à la même échelle que les bornes `since`/`until` (les découper en local rangeait un commit du 1er à 1 h dans le mois suivant, quand il ne disparaissait pas faute de seau) ; deux demandes concurrentes du même dépôt partagent la même promesse.
- **`GET /api/dashboard/activity/:repoId`** — le même dépôt sur **12 mois** (clic sur le nom sous sa barre) : `counts`/`days`/`authors` par mois, totaux, `meilleurMois` et `dernierActif` nommés plutôt qu'à chercher à l'œil. Même cache que la vue d'ensemble — ses six premiers mois sont souvent déjà chargés.
- **`GET /api/backup`** — archive `.zip` datée : la base (copiée par l'API `backup()` de SQLite, PAS un `cp` — une copie brute pendant une écriture donne une base corrompue) + `reviews/`, `tasks/`, `tickets/` + un mode d'emploi de restauration. Clones et worktrees EXCLUS (reconstructibles par `git clone`). Assemblage en mémoire, plafonné à 256 Mo avec le fichier fautif nommé. Modules : `backup.js`, `zip.js` (sorti de `docx.js` : un `.docx` est un ZIP, une sauvegarde aussi).
- **Notes** : `GET/POST /api/notes`, `GET/PUT/DELETE /api/notes/:id` (le PUT est **partiel** — l'autosauvegarde n'envoie que ce qui a bougé, sinon le client devrait tenir une copie fidèle du reste et l'écraserait dès qu'elle serait périmée), **`GET /api/notes/:id/export`** (`text/markdown` + `Content-Disposition`, nom **slugifié**), **`GET /api/notes-index`** (table iid → dépôts + `jira` : ce dont le RENDU a besoin pour transformer `!214` en lien, pas la liste des MR).
- **Todos** : `GET /api/todos?status=open|done|archived|all`, `POST /api/todos`, `PUT /api/todos/:id` (édition, cocher/décocher ET **snooze** — `{snooze: 'hour'|'tomorrow'}` traduit en `due_at` côté serveur, pour que « demain 9 h » veuille dire la même chose d'où qu'il vienne), `DELETE /api/todos/:id`, **`GET /api/todos/reminders/due`** et **`POST /api/todos/:id/reminded`** (confirmation d'AFFICHAGE : lire la liste ne consomme pas le rappel).
- **Jenkins** : `GET /api/jenkins/jobs` (liste aplatie ; `configured:false` plutôt qu'une erreur — un onglet non configuré doit expliquer), `GET /api/jenkins/job?path=[&builds=N]` (détail + paramètres + les 10 derniers builds ; `builds` creuse l'historique — plafonné à 200, et tout ce qui n'est pas un entier positif retombe sur 10 : le chiffre vient d'une URL. Sert quand on FILTRE l'historique sur une valeur de paramètre, où dix lancements ne suffisent pas à répondre « quand est-ce parti en prod »), `GET /api/jenkins/console?path=&build=`, **`POST /api/jenkins/build`** (le seul geste qui écrit chez Jenkins), `POST /api/jenkins/test` (rend le NOM du compte : une URL qui répond ne prouve pas le jeton).
- **`GET /api/brief`** — les 7 sections en un appel, calculées en SQL (aucune IA, aucun réseau). Une section vide arrive vide ; c'est le front qui la masque. **`POST/DELETE /api/brief/hidden`** — écarter une ligne (`{kind, ref}`, `kind` validé contre `brief.ECARTABLES`) et tout réafficher. Rien n'est supprimé : le verdict ou la MR gardent leur page, seule la ligne de brief disparaît — c'est pourquoi écarter se fait sans confirmation.
- **Liens** : `GET/POST/PUT/DELETE /api/environments[/:id]` · `POST /api/environments/:id/move` (d'un cran, positions RENUMÉROTÉES avant l'échange — deux environnements créés dans la même seconde portent la même position, et un échange entre valeurs égales ne changerait rien) · `/api/services[/:id]` · `PUT /api/services/:id/urls` (une URL VIDE efface la case) · `/api/services/:id/context-links` + `DELETE /api/context-links/:id` · `/api/free-links[/:id]` · `POST /api/free-links/to-service` (mapping EXPLICITE lien → environnement, jamais deviné) · `POST /api/services` accepte `urls[]` (le service naît AVEC ses adresses, tout ou rien : une URL invalide au milieu ne laisse pas de service à moitié rempli) · **`GET /api/links/grid`** (grille complète + tags en usage) · **`POST /api/launcher`** (résultats de la palette ; les ACTIONS de navigation sont fournies par le client, seul à savoir ce qu'il sait faire ; **requête VIDE = un échantillon**, trois actions + trois merge requests + trois sessions récentes, et non les douze premiers de tout — sans requête le score de correspondance est le même partout, et c'est la source la plus nombreuse, les liens de la grille, qui prenait toutes les places) et `POST /api/launcher/used` (frécence) · **`POST /api/links/import`** (aperçu, ne crée RIEN) puis `/api/links/import/apply` · **`POST /api/links/paste/analyse`** (propositions, ne crée RIEN) puis **`POST /api/links/paste`** (tout ou rien) · **`POST /api/environments/reorder`** et **`POST /api/services/reorder`** (l'ordre complet, un seul enregistrement à la dépose) · **`GET /api/mrs/:id/links`** (boutons contextuels résolus, l'ID DE L'ADRESSE compris — la frécence se compte sur trois segments).
- Notifications : `GET /api/notifications?after=:id` (événements postérieurs à `:id` + `latest`, pour le long-poll léger du client).

## Footer « télémétrie live »

Barre fixe en bas, esthétique terminal, **anti-répétition** : un **rotateur pondéré** (front) tire des
*frames* générées par des **providers** à partir des données live de `GET /api/footer` — insights perso,
**paliers/anticipation**, **activité de l'équipe** (MR entrantes via `discover`, donc de la nouveauté même
en mode passif), réactif au contexte (heure/jour), easter-eggs rares. Jamais deux fois la même de suite ;
la majorité est *dérivée de données qui bougent*, donc pas de lassitude. **Compteur de tokens** en odomètre
animé (comptage exact `gpt-tokenizer` si installé, sinon estimation ≈ car./4, capté dans `copilot.runPrompt`
→ table `usage`). Pause quand l'onglet est caché (sobriété CPU).

## Notifications bureau

Le **serveur émet des faits**, le **client décide**. `src/core/notify.js` est un simple **ring buffer en
mémoire** (300 événements max, ids croissants) alimenté par les points chauds : `queue_done` (fin de
file, `jobs.js`), `review_done` (note/10, `reviewer.js`), `job_failed` (× review/session/file,
`jobs.js`), `session_done` et **`needs_input`** (l'IA a posé une question, `jobs.js`), `converge_done`,
**`verify_done`** (un verdict objectif est tombé, `jobs.js`), `mr_new`/`mr_merged` (`discover.js` —
et `mr_merged` aussi quand le merge part **d'ici** : `closed_seen` venant d'être posé, la découverte ne le
signalerait jamais, et le seul merge muet de l'outil aurait été celui qu'on a fait soi-même),
`git_done` (une opération git a abouti, `jobs.js`), `restore_error` (un dossier de l'utilisateur laissé
détaché après une vérification *in place*, `verifyrun.js`), `cap_reached` (un plafond automatique a laissé
du travail de côté, `server.js` — jusque-là un simple `console.log`), et les deux faits de la veille de
fond : `jenkins_done` (fin d'un build lancé d'ici — l'attente vivait dans le `localStorage` du navigateur
et ne progressait donc que l'onglet Jenkins ouvert) et `docker_down`.
Les **rappels de todos** font exception à ce montage : ils ne passent pas par le ring buffer mais par un
poll dédié (`GET /api/todos/reminders/due`, une fois par minute) — un rappel n'est pas un fait qui vient
de se produire côté serveur, c'est une échéance qui arrive, et il doit survivre à un onglet resté fermé
pendant qu'elle passait. D'où aussi le **rattrapage groupé** au chargement (N ≥ 2 → une seule
notification) et le marquage `reminded_at` **après** affichage. Le client fait un
**long-poll léger** (`GET /api/notifications?after=` toutes les 5 s) ; **le premier passage cale le
curseur sans rejouer l'historique**. Le filtrage est **100 % côté navigateur** (localStorage
`mergerie_notif`) : types activés, **seuil de note basse**, **mode silencieux**. **Rafraîchir l'écran n'est PAS
une notification** : sur `verify_done`, les listes se rechargent quel que soit le mode silencieux et même
si le navigateur a refusé la permission — sinon un badge de verdict resterait faux jusqu'au prochain clic. Critère de tri —
*une notif appelle une action ou clôt une attente* ; le reste vit au footer. Le **clic** ramène au bon
endroit via le routage d'onglets existant (`Notification.onclick` → focus + `openReport`/`navTab`). Les
notifs sont **persistantes** (`requireInteraction`) : elles restent affichées jusqu'à action/fermeture,
pour ne pas être manquées. Réglages fins dans un **sous-onglet dédié** *Réglages → Notifications*, avec le
statut de permission (accordée / refusée / à demander) et un bouton *Tester* — un refus silencieux étant le
piège classique de l'API. Aucune persistance serveur : redémarrage = buffer vide, sans rejeu.

## Commentaires (les deux forges)

**Publier le LIEN du rapport** (`reviewer.publierLienRapport`, `messageLien`, `lienDejaPublie`) : quand un dépôt de données est configuré, le commentaire ne porte que l'adresse web du fichier du rapport dans ce dépôt (calculée depuis son chemin, jamais reçue du navigateur, sans identifiants), la note et le numéro de passe. La synchro est poussée AVANT de publier (un lien vers un fichier resté local serait un 404). Le gabarit `review_link_template` (réglage d'équipe, `{url}` obligatoire ; `{blockers}`/`{majors}`/`{minors}` viennent de `constatsParSeverite`, même compte que la carte : la passe, hors constats résolus) met en forme ; `auto_post_review_link` fait de la publication automatique un lien plutôt que le rapport, avec repli sur le rapport si le lien ne peut pas être fait. Une marque de publication par passe évite qu'une autre instance reposte le même lien.

Le front et `server.js` ne connaissent QU'UNE forme, celle de GitLab (un fil = une `discussion` portant des
`notes`, inline si `position`). `github.js` la reconstitue depuis les deux concepts GitHub.

| | GitLab | GitHub |
|---|---|---|
| **Niveau MR** | `POST .../notes` | `POST /issues/{n}/comments` (issue comment) |
| **Inline** | `POST .../discussions` avec une `position` complète (`base_sha`/`start_sha`/`head_sha` récupérés via la MR, `old_path`/`new_path`, `old_line`/`new_line`) | `POST /pulls/{n}/comments` avec `commit_id` (= head_sha) + `path` + `line` + `side` (`RIGHT` si `new_line`, `LEFT` sinon) |
| **Réponses** | `POST .../discussions/:id/notes` | `POST /pulls/{n}/comments/{id}/replies`, l'`id` étant celui de la note **racine** du fil |
| **Lecture** | `GET .../discussions` | `GET /pulls/{n}/comments` (fils regroupés par `in_reply_to_id`) + `GET /issues/{n}/comments` (fils d'une note, id préfixé `issue-` pour savoir où répondre) |
| **Modification** | `PUT .../notes/{id}` — une seule route, quelle que soit la famille | **deux** ressources selon la famille : `PATCH /pulls/comments/{id}` (inline) ou `PATCH /issues/comments/{id}` (général), hors du chemin de la PR. D'où le paramètre `inline` du contrat commun, ignoré côté GitLab |
| **Qui suis-je** | `GET /user` → `username` | `GET /user` → `login` |

Les numéros de ligne sont calculés à partir du diff à contexte complet. Inline affichés sous leur ligne,
généraux dans le détail du rapport (notes système filtrées — GitHub n'en a pas d'équivalent).
Un commentaire n'est **modifiable que s'il est le mien** : le serveur compare l'auteur de la note au
compte du jeton (`GET /user`, mis en cache 30 min) et renvoie un drapeau `editable` par note ; l'échec
de cette identification rend simplement tout non modifiable, ce qui est le repli sûr. Les droits ne
sont pas re-vérifiés à l'écriture — c'est la forge qui les détient.

## Sécurité / robustesse


- **TLS scopé par forge** (jamais de `NODE_TLS_REJECT_UNAUTHORIZED` global) ; CA pinning ou insecure opt-in, séparément pour GitLab et GitHub.
- **Tokens masqués** dans les logs (GitLab ET GitHub : `git.secretsOf(cfg)`) ; stockés en BDD locale, jamais renvoyés en clair (masque `***` en lecture, renvoyer le masque n'écrase pas).
- **Jeton de forge hors du clone** (`git.enTetesForge`/`envGit`) : il part en en-tête `http.<forge>/.extraheader` (Basic `oauth2:` pour GitLab, `x-access-token:` pour GitHub) via `GIT_CONFIG_COUNT/KEY_n/VALUE_n`, dans l'environnement du seul processus git ; `origin` reste nue, et `nettoyerOrigines` retire au démarrage le jeton des clones d'avant. Toute commande git passe par `argsDurcis` : `core.hooksPath` vide, `fsmonitor` coupé, `protocol.ext.allow=never`, `--no-ext-diff --no-textconv` sur les sous-commandes de diff ; environnement en liste blanche.
- Nom de **branche validé** (anti argument-injection git) ; **chemins de fichier validés** contre l'arborescence (anti traversal).
- Rendu markdown **escape-first** (pas d'HTML brut → pas de XSS) ; contenu distant (commentaires) rendu via ce renderer.
- Commandes git/agent lancées via `spawn` (pas de shell).
- **Accès** (`garde.js`, début de `server.js`) : en-têtes (CSP `script-src 'self'`, `nosniff`, `no-referrer`) posés en premier ; garde `Host` (421 hors `localhost`/IP/`MERGERIE_ALLOWED_HOSTS`, contre le DNS rebinding) ; `/api` refusée sur `Sec-Fetch-Site: cross-site|same-site` ; exposé (`HOST` non-boucle) ⇒ `MERGERIE_ACCESS_TOKEN` obligatoire (cookie `HttpOnly` posé par `/acces`, ou `Bearer`), refus de démarrer sans lui.
- **Approbation locale** (`approbation.js`) : l'empreinte de ce qui décide d'exécuter (commandes d'un vérificateur, permissions/horaire d'un agent, `auto_review_new`/`auto_rereview_stale`/`auto_runner` + `verif_auto_authors='all'`) est gardée dans `local_state` ; différente ⇒ `APPROBATION` (409) au lancement, bloc « à approuver » à l'écran. L'écran renvoie la `signature` de l'état montré ; changé entre-temps ⇒ 409 `APPROBATION_PERIMEE`. Écrit par l'utilisateur ⇒ approuvé au passage ; existant à la montée de version ⇒ repris une fois (`reprendreLExistant`).
- **Import validé** (`store.validerDocument`, `lireFichierImport`) : types, listes fermées (`ENUMS`), 8 Mo, pas de lien symbolique ; append-only vérifié par empreinte du corps.
- **Politique d'agent par saveur** (`agentpolicy.js`) : lecture (`review explain question modify explore ask test`) ⇒ `sansModeLarge(COPILOT_ARGS)` + `--restricted` (ou `--permission-mode default` + liste de lecture + `--setting-sources user`) ; écriture ⇒ mode conservé + `--disallowedTools` des chemins de fuite ; partout : `Read/Edit` interdits sur la base et le `.env`, `envAgent` en liste blanche (+ `MERGERIE_AGENT_ENV`), `--max-turns` par défaut et plafond de dépense du jour (`exigerBudget`), réglages de POSTE (`local_config`). Vérifié contre le CLI : `--allowedTools` est SANS effet sous `--dangerously-skip-permissions`, `--disallowedTools` tient.
- **Données non fiables dans les prompts** (`nonfiable.js`) : `nonFiable(étiquette, texte)` enveloppe dans `<<<DONNEE nonce …>>>` (nonce par appel, imitations neutralisées) ; `avecPreambule` pose l'avertissement dans `runInSession`/`runReal`. Publication auto ⇒ bloc FINDINGS complet exigé ; convergence ⇒ `note.extractNoteStricte`.
- **Config d'agent d'une branche** (`configagent.js`) : `.claude/`, `CLAUDE.md`, `.mcp.json`, `.github/copilot-instructions.md`… touchés par la branche ⇒ 409 `CONFIG_AGENT` (fichiers + empreinte) aux routes de lancement, re-vérifié par le job après fetch ; accord gardé par empreinte dans `local_state`.
- **Palette git** (`gitpalette.js`) : liste blanche de sous-commandes, options refusées par préfixe, pas de chemin absolu ni `..`, remotes https/ssh ; délai 60 s, sortie plafonnée à la lecture.
- **Fichiers fournis par d'autres** : `servirFichierNonFiable` seul appelant de `res.sendFile` (inline = image matricielle ou PDF, sinon attachment ; `nosniff` + CSP `sandbox`). Docker : `jobs.exigerDossierCompose`.
- **Verrous** : `scripts/check-front.js` et `check-server.js` échouent sur un `on…=`, un script en ligne, une URL interpolée hors `safeUrl`, un `_blank` sans `rel`, un GET qui lance un processus, un `spawn` avec `process.env` brut, un `res.sendFile` hors de la porte prudente, un import non validé.
- **Contexte Jira** (donnée externe) : convertisseur ADF qui ne propage que les `href` http(s)/mailto ; fetch best-effort qui n'interrompt jamais le discover ; `jira_token` masqué comme les tokens de forge.

## Interface

- **Rendu Markdown** (`mdToHtml(md, opts)`) : échappe d'abord, puis une liste blanche. `opts.paragraphes` (constante `IA`) pour ce qu'une IA a écrit — rapports, explications, réponses, retours de session, cartes : des lignes consécutives forment un paragraphe et une ligne indentée continue sa puce, parce que les agents reviennent à la ligne vers cent caractères. Sans l'option (notes, Jira), chaque ligne reste un paragraphe : le retour à la ligne y est voulu. Titres jusqu'au niveau 6.

Sept onglets (leur ORDRE et leur visibilité se règlent dans *Réglages → Général* — préférence de navigateur, `mergerie_nav` ; un onglet masqué quitte aussi la palette et les raccourcis chiffrés, et *Réglages* n'est jamais masquable) : **Reviews** (filtre segmenté sur les 3 stades d'une MR ; sur *Reviewées* et *Traitées*, **trois cases de couleur de note** au-dessus de la liste — vert ≥ 7, orange 4–6,9, rouge < 4 —, cumulables, chacune portant le nombre de MR qu'elle fera apparaître, choix persisté ; décocher la dernière ramène tout, et le résumé de droite suit le filtre. Le stade *À traiter* n'en a pas : une MR n'y revient qu'après suppression de son rapport, donc sans note) · **Dev IA** (sous-onglets
Codage / Codage hors dépôt / Exploration ; **duplication d'une session** (les trois saveurs) — le
formulaire d'édition rouvert SANS identifiant, donc on CRÉE ; session d'agent jamais reprise, et
branche de travail décalée (`-2`, `-3`…) EN CODAGE seulement — en exploration la branche est celle
qu'on lit, la décaler pointerait vers une branche inexistante ;
recherche commune, **rangement des sessions terminées**
— drapeau `hidden` en base, case « afficher les sessions masquées » persistée, décompte de ce qui
est filtré ; prompt replié sur trois lignes avec « Voir plus », texte complet toujours dans le DOM) · **Statistiques** · **Git** (sous-onglets Actions / Navigation / **Commandes Git** / Explorateur de branches / **Comparer** (deux dépôts, une branche OU un tag de chaque côté — le genre voyage avec la ref, deux homonymes ne sont pas confondus : à gauche seulement / différents / à droite seulement, sans histoire commune requise ; un clic sur un fichier ouvre le diff de ses deux versions, calculé par `git diff --no-index` entre les deux blobs extraits — binaire et fichier trop gros annoncés) / Trouver une ref / Historique) · **Docker** (sous-onglets Compose / Hors-compose / Logs / Actions ; drift .env, badges santé du menu, tail live des logs, actions groupées ; **Compose : recherche de service/container + filtre d'état**, tous deux persistés et appliqués côté client — le prédicat d'état est celui d'*Actions* (`dactMatchesFilter`) et la LISTE d'états est la même (`DOCKER_STATE_FILTERS`, dont le menu d'Actions est peuplé au démarrage) : un seul comportement, un seul jeu de choix. « Ne tourne pas » se décline en **exited** (a tourné puis s'est arrêté → redémarrer), **created** (existe mais n'a jamais démarré → souvent un échec au démarrage) et **missing** (aucun container → `up`), avec `stopped` conservé comme chapeau des trois — c'est une valeur déjà persistée dans le navigateur, la retirer casserait les filtres enregistrés) · **Jira** (mes tickets affectés : liste filtrable par statut — choix persisté — → détail avec contenu, métadonnées, commentaires, pièces jointes, **tickets liés** (`issuelinks` + `subtasks` + parent non-epic, normalisés par `relatedOf` dans `src/integrations/jira.js` : le libellé vient du bout de lien rempli par Jira — `outward`↔`outwardIssue`, `inward`↔`inwardIssue` —, groupés par relation à l'écran, la clé ouvrant le ticket dans la colonne courante), changement d'état, ajout de commentaire ; le sous-onglet **Surveillés** affiche le MÊME panneau de détail — `renderJiraDetail(issue, box)` et gestionnaires câblés sur `.js-jira-detail`, une seule implémentation pour deux emplacements — avec sa propre sélection) ·
**Réglages** (sous-onglets Règles / Dépôts / Notifications / Général / **Git** / **Jira** / Merge Request / AI sessions ; les champs sont éclatés sur plusieurs sous-onglets mais restent **un seul `#configForm`** via l'attribut HTML `form=` : URL GitLab / access token / **URL et token GitHub** / dossier de clonage → **Git** ; URL/email/jeton Jira → **Jira** ; + la **palette de commandes** dans Git).
**Statistiques** : **activité des projets sur 6 mois** = une barre HORIZONTALE par dépôt suivi (hauteur du graphe bornée + défilement : vingt dépôts sans nom tronqué ni page repoussée), **longueur = jours d'activité** (journées où du code est arrivé — insensible au squash, et bornée donc comparable entre dépôts, contrairement au nombre de commits qui reste en infobulle), empilée par mois avec **une couleur par mois** (séquence froid → chaud : les mois se suivent, l'ordre reste lisible sans la légende ; six variables `--mois-N` par thème), ancien à gauche → récent à droite, endormis en gris mais VISIBLES, nom en clair à gauche — vingt dépôts se lisent d'un coup, ce qu'une liste de vingt lignes ne permet pas ; chaque graphe porte une **légende d'utilité** (la question à laquelle il répond) ; camembert des tokens en `conic-gradient` (pas de calcul d'arc SVG).
**Identité** : le logo (`public/images/mergerie-logo.svg` et sa variante sombre — un « M » en graphe
de commits dont les deux branches se rejoignent sur un commit de merge vert) est posé dans l'en-tête,
deux fichiers plutôt qu'un SVG en `currentColor` car seule l'encre du M change entre les thèmes, pas
le vert. La **favicon** reprend le même dessin en blanc sur une tuile qui porte l'état du job
(`faviconHref`) : le fichier ne peut pas servir tel quel, son encre sombre et transparente disparaît
sur une barre d'onglets sombre. Les PNG (`favicon-32`, `logo-512`) servent de repli raster.
Système de design à variables CSS (typographie, espacement, rayons, élévation, mouvement), composant
`.btn` unique à hauteur fixe, sprite **SVG inline** (aucune icône emoji, rendu identique partout),
thème clair/sombre/auto avec contrastes **WCAG AA vérifiés** dans les deux thèmes.
**Réduire une fenêtre.** Toute modale à saisie porte un bouton `—` posé par `fermerAuFond` : la
règle est « réductible = saisissable », pas une liste d'identifiants — une modale qui rend une
PROMESSE (`confirmDialog`, choix d'un vérificateur) passe `salissable: false` et n'en reçoit donc
pas, la réduire laisserait son appelant en attente pour toujours. La fenêtre est MASQUÉE (jamais
reconstruite : la saisie ne peut pas se perdre), rangée dans `#modalDock` au bas du menu avec son
titre, son onglet d'origine et le dernier champ touché (`DERNIER_CHAMP` — à l'instant du clic
l'élément actif est le bouton, pas le formulaire). L'observateur de `hidden` de `fermerAuFond`
distingue les trois cas : réduction (le drapeau `saisi` SURVIT, sinon la fenêtre reprise se
laisserait fermer d'un clic au fond), réapparition (elle sort du dock, quel que soit le chemin :
la puce ou son ouvreur), fermeture (remise à zéro). La croix de la puce passe par la vraie
fonction de fermeture — elle seule remet à zéro ce qui vit hors du DOM.
Règle globale `[hidden] { display: none !important }` : sans elle, toute règle posant un `display`
neutralise silencieusement l'attribut — source récurrente de bugs.
Toute liste où l'on choisit un dépôt utilise un **combo avec recherche** (un `<select>` natif
devient inutilisable au-delà de quelques dizaines de projets) — `repoComboHtml`/`wireRepoCombos`,
partagé par l'onglet Git ; le modale de session et l'ajout en masse ont leur équivalent.
**Même règle pour les branches**, pour la même raison en pire (un dépôt actif en compte des
centaines) : la ref source de Git → Actions est un `comboHtml('git-ref')`, la liste des refs à
supprimer et le tableau de l'explorateur ont un filtre qui **masque des lignes sans toucher aux
cases cochées** — on coche, on filtre autre chose, on coche encore, puis on supprime d'un coup.
Le sélecteur de branche de Git → Navigation et ceux de la modale de session étaient déjà des combos.
**Validation des formulaires — une seule règle.** *Une erreur de champ s'affiche SOUS le champ,
un toast n'annonce qu'un résultat d'action.* `erreurChamp(champ, message)` pose un `.field-error`
de 12 px après le champ (ou après son enveloppe `.combo` / `.inline-check`, sinon l'`overflow` le
rognerait), marque le champ `.is-invalid` + `aria-describedby` + `aria-invalid`, et efface le tout
à la première frappe. `signalerChamp` y ajoute le focus et le défilement ;
`viderErreursChamps(racine)` remet à zéro avant de revalider. Les toasts d'ERREUR ne s'installent
plus à demeure : huit secondes, minuteur suspendu tant que la souris ou le clavier est dessus, et
un `MutationObserver` sur l'attribut `hidden` de toutes les `.modal` les efface quand le
formulaire qui les a produits se ferme. Les ⓘ des libellés portent `tabindex="-1"` (six arrêts de
tabulation sur seize, dans la seule modale de session). **La bulle ne s'ouvre que sur son ⓘ** —
survol, clic, ou focus de l'icône elle-même. Une version l'ouvrait aussi au focus du CHAMP, pour
compenser ces icônes sorties du parcours : elle s'affichait alors par-dessus le champ qu'on venait
de cliquer, masquant ce qu'on allait y écrire. Une explication qu'on n'a pas demandée et qui cache
la saisie coûte plus qu'elle n'apporte.

**Les croisements entre onglets.** Ce qui fait la valeur de l'outil n'est pas la somme de ses
écrans mais ce qu'ils se disent. Règle : un croisement lit ce qui est DÉJÀ en base ou déjà
chargé, jamais un sondage de plus.
- `discover.js` ferme les todos liées à une merge request vue mergée (`notes.fermerTodosDeMr`,
  réglage `todo_close_on_merge`, coché par défaut).
- `/api/mrs` porte, pour chaque ligne : `size` (fichiers, +/−, relevés avec les chemins
  modifiés), `note_detail` (dernière `review_version`), `ticket_status` / `ticket_category`
  (depuis `jira_watch`, seule source Jira hors ligne), `jenkins_jobs` (table `repo_jenkins`).
  Le badge CI, lui, est composé côté écran à partir de la liste Jenkins déjà chargée — croisée
  sur le NOM DE BRANCHE (`job.ref`), jamais confondue avec le verdict objectif.
- `usage` porte `owner_kind`/`owner_id` : le coût se rattache à SA session, ce qui fait exister
  « les sessions les plus coûteuses » et la ligne `3 min · ~13 500 tokens` des cartes.
- `make_run` (une ligne par répertoire × cible) répond à « ai-je déjà passé les migrations ce
  matin ? ». `repo_jenkins` déclare quel job déploie quel dépôt.
- Les appels COÛTEUX sont faits à la demande, jamais pour une liste : `commitsSince` (au survol
  du badge « périmé »), `/api/docker/dir-state` (à l'ouverture de la confirmation d'une
  vérification in place), `/api/jenkins/console` (sur un build rouge sélectionné).

**#configForm est un formulaire ANCRE** : ses champs vivent dans six sous-onglets de Réglages et
s'y rattachent par l'attribut `form=`. Deux conséquences que le code doit tenir explicitement —
le navigateur ne trouve aucun bouton par défaut *dans* le formulaire, donc la soumission implicite
n'arrive jamais (un `keydown` sur Entrée appelle `requestSubmit()`) ; et chaque sous-onglet
rappelle `loadConfig` en s'ouvrant, ce qui écrasait une saisie non enregistrée (`configSale`
l'en empêche). L'état « modifications non enregistrées » est posé sur **tous** les boutons et
mentions du formulaire, dans tous les sous-onglets : c'est lui, l'avertissement au changement
d'onglet.

**Calme et repères** (issu de l'étude `ludique.md`, dont le fil conducteur est : *rien qui
n'apporte pas d'information*).
*Calme* — `titrerTextesTronques()` pose une info-bulle sur les lignes de carte réellement
coupées (mesure `scrollWidth > clientWidth`), et la retire quand la fenêtre s'élargit : une bulle
qui répète un texte lisible est du bruit. Un passage après rendu et un au redimensionnement.
`renderIfChanged(el, sig, html)` : chaque liste calcule la signature de ce qu'elle
affiche et ne touche au DOM que si elle a changé (pas de clignotement au rafraîchissement, et les
écouteurs déjà posés restent valides). L'entrée en cascade (`stagger`) est armée par le seul
drapeau `listeChargee`, posé par les `loadX()` : elle joue au chargement, jamais à la frappe d'un
filtre. Le journal est plafonné à `LOG_MAX_NODES` lignes (élagage par la tête, bandeau `.log-trunc`).
`openReport(id, {keep})` conserve défilement, sous-onglet et version tant que la signature du
rapport (`reportSig`) est identique.
*Repères* — le statut expose `targets` (`jobs.runningTargets()`) : le front marque la carte
concernée d'un liseré animé (`.card.running-now`). Un lot de review ne désigne que sa MR courante
(`current_mr_id`), l'animation se fige quand l'onglet est en arrière-plan et disparaît en mouvement
réduit. `etaText()` n'affiche un reste qu'au-delà de deux unités et vingt secondes, par paliers
grossiers, et se tait dès que le rythme dévie de plus de moitié.
*Activité* — `GET /api/jobs/history` liste les jobs passés en résolvant **côté serveur** le
libellé de leur objet (`job.target_kind` / `target_id`, colonnes ajoutées pour ça : la table ne
portait que `current_mr_id`, donc rien ne reliait un job à sa session). Le curseur « déjà vu » vit
dans le navigateur — c'est bien « depuis MA dernière visite ». Relire un job passé **épingle** son
volet, sinon le suivi du job courant reprenait la vue au sondage suivant.
*Navigation* — palette `Ctrl/Cmd + K` (actions figées + MR et sessions déjà en mémoire, huit
résultats), `j`/`k`/`Entrée`/`Échap` sur la liste visible, `?` pour l'aide. L'onglet et le stade de
Reviews sont mémorisés ; **rien d'autre** ne l'est (une modale ou un rapport périmés sont pires
qu'un démarrage propre). Le panneau de rapport s'ouvre sur le **delta depuis la dernière visite**
(instantané par stade, base de comparaison figée pendant quatre heures, trois faits au plus, rien
du tout si rien n'a bougé).
**Garde-fous statiques** (`npm run check`) : `check-front.js` (sélecteur `$` traité en liste,
sous-onglet sans `segmented`, id inconnu, icône absente, `busy()` mal appelé, **nom redéfini au
premier niveau d'`app.js`** (une `function` écrase la précédente par hoisting sans avertissement ; un `const`/`let` en double est pire — SyntaxError, et plus une ligne d'`app.js` ne s'exécute), **liste de
refs git sans recherche**, `<select>` de dépôt
sans recherche) et `i18n-check.js` (parité fr/en, clés absentes, entités HTML, français en dur).
Chacun est né d'un bug réel : ils attrapent en statique ce que `node --check` ne voit pas.

## Internationalisation (fr / en)

Dictionnaire unique `public/i18n.js` (UMD : chargé côté navigateur **et** côté serveur — les messages
d'erreur du serveur sont de l'interface), moteur `public/i18n-runtime.js` (`tr()`, pluriels
`{one, other}`, `currentLocale()`). La préférence vit en base (`config.language`) car le serveur en a
besoin, avec un miroir `localStorage` pour appliquer la langue avant le premier rendu. Les rapports IA
suivent la langue via les gabarits de prompt de `src/core/prompts.js`, **sans jamais écraser un prompt
personnalisé**.


## Paquet npm (`bin/mergerie.js`, `scripts/publish-npm.sh`)

`npx mergerie demo` et `npx mergerie` passent par **`bin/mergerie.js`**, déclaré dans `bin` de
`package.json`. Sous npx le paquet vit dans un cache (`~/.npm/_npx/…`) effacé sans prévenir, donc
la commande pose `MERGERIE_DATA_DIR` sur `~/.mergerie/data` (ou `~/.mergerie/demo`) quand il n'est
pas donné, puis lance `scripts/demo-seed.js` (qui honore désormais la variable au lieu de forcer
`data-demo/`) et `src/server.js` **en processus enfant** avec le même `--env-file-if-exists=.env`
que `npm start` — un `require` du serveur ne transmettrait pas Ctrl-C, et l'orphelin garderait le
port et la base. La liste **`files`** de `package.json` dit ce qui part sur le registre : `bin`,
`src`, `public` (dont `vendor/mermaid.min.js`), `scripts/demo-seed.js` ; README, LICENSE et
`package.json` sont ajoutés par npm ; tests, plans, données, GIF et vidéos ne partent jamais —
3 Mo archivés au lieu de 8,6. **`scripts/publish-npm.sh`** enchaîne `npm run check`, la
vérification de ce contenu, `npm pack`, puis un **essai réel** : `npm exec --package=<tgz> --
mergerie demo` depuis un dossier vide avec un `HOME` jetable (donc tout est téléchargé comme chez
un inconnu, binaire natif de `better-sqlite3` compris), attente du serveur, bannière de démo,
base dans `~/.mergerie/demo` et rien dans le cache ; `--publish` ajoute `npm publish`, refusé hors
de `main`, d'un arbre propre, d'un HEAD tagué ou sans `npm login`. `test/unit-bin.test.js` rejoue
la commande en sous-processus.

## Environnement cible

WSL/MAC/Linux. GitLab self-hosted ou GitHub Enterprise avec CA d'entreprise → `GITLAB_CA_CERT`/`GITHUB_CA_CERT` (ou `GITLAB_INSECURE_TLS=1`/`GITHUB_INSECURE_TLS=1`), et `GIT_CLONE_SSH=1` pour le clone. Agent IA lancé avec le flag « yolo » pour autoriser la modification de fichiers. `.env` chargé automatiquement au démarrage.

## Mode dry-run

Sans binaire d'agent (ou `COPILOT_DRY_RUN=1`) : rapports/tâches mock générés depuis le diff → pipeline complet testable hors-ligne. `npm run pipe` = smoke test sur un dépôt synthétique.
