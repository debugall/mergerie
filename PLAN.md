# Mergerie — Architecture

Application locale mono-utilisateur (Node + Express + SQLite + front vanilla) pour :
1. **Reviewer** les merge requests GitLab **et les pull requests GitHub** assisté par IA (skill `git-review` via un CLI d'agent).
2. Piloter des **sessions de dev** automatisées (l'IA modifie le code, commit, push, ouvre/merge la MR).
3. **Explorer du code en lecture seule** : poser une question sur un ou plusieurs dépôts et obtenir une réponse de synthèse en Markdown.


> **Convention de vocabulaire.** Tout le code manipule la forme normalisée héritée de GitLab : une
> *pull request* GitHub est traduite en « MR » par `github.js` (`number`→`iid`, `head.ref`→`source_branch`…).
> Dans ce document, **« MR »** désigne donc les deux, et aucun module en amont ne distingue les forges.

## Stack

- **Back** : Node 22.9+ + Express. Shelle `git` et le binaire d'agent (`copilot`/`claude`) via `child_process`. Clients HTTP GitLab et GitHub en `https`/`http` natif (agent TLS scopé par forge). `gpt-tokenizer` (pur JS, hors-ligne, **optionnel** : repli sur estimation) pour le comptage de tokens du footer.
- **BDD** : SQLite via `better-sqlite3` (fichier unique, migrations `ALTER TABLE` idempotentes au démarrage).
- **Front** : SPA vanilla (HTML/CSS/JS), servie en statique, **zéro dépendance réseau** au runtime (rendu markdown + coloration syntaxique maison).

## Modules (`src/`)

| Fichier | Rôle |
|---|---|
| `paths.js` | chemins des données ; `MERGERIE_DATA_DIR` pour isoler `data/` |
| `db.js` | schéma SQLite + migrations ; reset des jobs `running` au boot |
| `config.js` | lecture/écriture de la config (row unique) |
| `httpreq.js` | requête HTTP(S) bas niveau partagée par les clients de forge + fabrique d'**agent TLS scopé** (`GITLAB_CA_CERT`/`GITLAB_INSECURE_TLS`, `GITHUB_CA_CERT`/`GITHUB_INSECURE_TLS`) ; timeout de 30 s (sans lui, une forge qui ne répond jamais gèlerait la file de jobs) |
| `forge.js` | **aiguillage de forge** : `clientFor(repo)` renvoie `gitlab.js` ou `github.js` selon `repo.forge`. **Règle du projet : aucun autre module n'appelle un client en direct.** Les deux clients exposent la MÊME interface et la même forme normalisée, donc aucun appelant n'a de branche `if (github)`. Aussi : `isConfigured(cfg, forge)`, `refUrl` (URL web d'une ref, format propre à chaque forge) |
| `github.js` | client API GitHub REST v3, **même interface que `gitlab.js`**. Traduit PR → MR (`number`→`iid`, `head.ref`→`source_branch`, `merged:true`→`state:'merged'` — GitHub dit `closed` pour une PR mergée), issue comments + review comments → **discussions** (fils reconstruits via `in_reply_to_id`), position inline (`commit_id`/`path`/`line`/`side`) ↔ position GitLab. Pagination par header **`Link`** (pas de compteur de pages), `User-Agent` obligatoire (403 sinon), 403 + `X-RateLimit-Remaining: 0` → message de quota dédié. GitHub Enterprise : base `<url>/api/v3` |
| `gitlab.js` | client API v4 : MR, projets, branches (avec SHA), **dernier commit** (`latestCommit`), **tags**, **refs protégées**, **création/suppression de branche et tag**, discussions, merge, notes ; agent TLS scopé + messages d'erreur explicites |
| `git.js` | clone/fetch (SSH ou HTTPS+token), diff ciblé `target...source` & **diff delta** `reviewed_sha..current_sha` (re-review incrémentale) & contexte complet, arbre, contenu de fichier, création de branche, commit, push, **tagger d'un tag annoté** (`tagAuthor`), **branches portant un commit** (`branchesForCommit`, pour « sur quelle branche ce tag a-t-il été posé ») ; **remise à zéro défensive du worktree** avant une session de codage ; masquage du token dans les logs |
| `copilot.js` | runner de l'agent (`<bin> [args] -p <prompt>`), streaming ligne à ligne, **mode dry-run** (mock depuis le diff) |
| `note.js` | extraction de la note globale d'un rapport (texte libre) |
| `glob.js` | matching glob minimal (gitignore-like) pour les **règles par chemin** et le badge « risque » |
| `resolution.js` | suivi de résolution : parsing des constats structurés, empreinte stable, **garde-fou git** (résolu ↔ disparu), diff entre passes |
| `reviewer.js` | pipeline de review : clone → diff → prompt(s) → écriture fichier → BDD ; contexte ticket + règles ; modif IA ; re-review incrémentale |
| `converge.js` | **« Converger »** : orchestrateur (machine à états) review → correction IA (commit + push) → re-review incrémentale, jusqu'au seuil / à la régression / au plafond ; **`convergeSession`** : depuis une session de dev (dev → push → crée la MR → upsert → `convergeRun`), par projet en série |
| `taskrunner.js` | pipeline de dev session : branche → prompt IA → commit → diff → push ; **session reprenable par cible** (`task-{taskId}-target-{tgId}`) → **continuité** : run initial / followup / relance / reprise après questions / passes de convergence reprennent la même session ; **« l'IA pose une question »** (bloc `<<<QUESTIONS>>>` → `needs_input` → `runTaskAnswer`) |
| `agentsession.js` | **reprise de session d'agent** : `runInSession({ key, handle, cwd, resume })` — claude `--session-id`/`--resume`, copilot `COPILOT_HOME` isolé + `--continue` (auth importée par symlink). Utilisée par `taskrunner`, `reviewer`, `converge` ; repli one-shot `copilot.runPrompt` si backend inconnu / dry-run (le comptage de tokens passe alors par `copilot.recordUsage`). `resumeCommand(backend, handle, cwd)` bâtit la **commande de reprise au terminal** (bouton « Reprendre au terminal ») : `cd '<cwd>' && claude --resume <id>` / `… COPILOT_HOME='<home>' copilot --continue` (shell-quotée) |
| `questions.js` | protocole du bloc `<<<QUESTIONS>>>` : instruction de prompt + `parseQuestions` (JSON strict, 5 max, malformé → ignoré) + `buildAnswerInstruction` (reprise) — calque des `FINDINGS` |
| `aisession.js` | banc d'essai « reprise de session » (endpoint `POST /api/ai-sessions/test`) : deux passes (mémorise un marqueur → le rappelle en reprise) via `agentsession`, simulé en dry-run |
| `localcoder.js` | **« Codage hors dépôt »** : l'IA réalise le prompt dans des dossiers locaux arbitraires, en place, **sans git** (ni branche, ni commit, ni push). **Session reprenable par dossier** (`local-{taskId}-dir-{dirId}`) → `runLocalFollowup` (« Demander une correction ») rejoue une passe en REPRENANT la session de chaque dossier ; `saveAgentOutput` écrit le **retour de l'agent** (`output.md` → `local_task_dir.output_path`, bouton « Retour de l'IA ») |
| `jobs.js` | **file séquentielle** (un job à la fois), log persistant, stop, kinds `review`/`rereview`/`modify`/`explain`/`task`/`gitops`/`converge`/`converge-session`/`local` |
| `proc.js` | suivi du process enfant courant + annulation (Stop) |
| `notify.js` | **ring buffer en mémoire** des événements (notifications bureau) : `push`/`since`/`latestId` |
| `discover.js` | découverte des MR ouvertes filtrées par pattern |
| `gitgraph.js` | analyse du graphe des branches (clone local) : ahead/behind, « mergée dans », origine **inférée avec niveau de confiance** |
| `jira.js` | client Jira Cloud (Basic, API v3) + **convertisseur ADF → Markdown** ; fetch du contexte ticket au discover (best-effort) ; **onglet Jira** : `listAssignees` (`myself` + assignés récents découverts via `assignee IS NOT EMPTY` → cases du filtre par personne, moi coché par défaut) + `searchByAssignees` (JQL `assignee IN (accountIds)`, vide = `currentUser()` ; accountIds validés anti-injection JQL ; écarte `statusCategory = Done` sauf `includeDone`, tri `updated DESC`) + `transitions`/`transitionIssue` (changer l'état via l'API transitions) + `addComment` (`textToAdf` : texte brut → ADF pour poster un commentaire) + `issueDetail` (métadonnées + description ADF→MD + commentaires ADF→MD + **pièces jointes** : métadonnées seulement, contenu à la demande) + `downloadAttachment` (proxy : récupère le fichier avec le token, suit la redirection Jira→média en **retirant l'auth hors hôte**, bufferisé, ≤ 25 Mo ; **`inline` UNIQUEMENT pour les images matricielles** png/jpeg/gif/webp/bmp/avif — `image/svg+xml` (script possible) et tout le reste en `attachment`, + `X-Content-Type-Options: nosniff` et CSP `sandbox` : un SVG ouvert en navigation top-level ne peut pas exécuter de script sur l'origine de l'app). Images **embarquées** (ADF `mediaSingle`) : `adfToMarkdown(adf, {attachments})` résout le nom de fichier du média vers l'id de pièce jointe → `![nom](/api/jira/attachment/id)` (rendu inline par `mdToHtml`, restreint à ce proxy = sûr ; clic = lightbox), placeholder nommé sinon. **Cloud a retiré l'ancien `/search` (410 Gone)** → on appelle le nouveau **`/rest/api/3/search/jql`** (recherche enhanced, sans `total`), avec repli sur `/search` si 404 (Jira Server/DC) |
| `demo-jira.js` | tickets Jira FICTIFS du mode démo (affectés + détail + commentaires, séquence figée) |
| `gitops.js` | opérations multi-dépôts (onglet Git) : aperçu, exécution via l'API, **restauration** d'une suppression (fetch de sécurité + SHA journalisé) |
| `demo-git.js` | **données Git statiques du mode démo** (`MERGERIE_DEMO=1`) : un jeu fictif cohérent par dépôt (branches + tags) d'où dérivent les réponses de `refs`/explorateur/`find-ref`/`tag-author` et l'aperçu d'action — les onglets Git, sinon *live*, restent consultables hors-ligne (boutons sans effet) |
| `docker.js` | **onglet Docker** : découverte à deux sources (COMPOSE = scan des répertoires locaux pour les fichiers compose ; HORS-COMPOSE = `docker ps -a` sans label `com.docker.compose.project`) ; **drift .env** = effectif (`docker inspect`) vs attendu (`docker compose config --format json`) → **diff nominatif** par service (variables ajoutées/modifiées/supprimées, **valeurs sensibles masquées**), badges `synchro`/`drift config`/`drift image`/`compose modifié`/`non créé` ; actions **stop**/up/restart/pull/**recreate** (`--force-recreate` ciblé)/**build** (`up -d --build` : reconstruit l'image puis recrée) + `down` (aperçu, **jamais `-v`**) ; **perf** : `composeProjects` fait UN SEUL `docker ps -a` partagé + calcule les projets en **parallèle borné** (`pMap`, 6) avec les `inspect` de services en parallèle ; **affichage progressif** via `composeFileList` (liste légère : scan + un `ps -a`, nom provisoire `defaultProjectName`, tri activité récente) puis `composeOne(dir, file)` (détail à la demande, valide que le fichier est connu sous les racines) ; **Makefile** à côté du compose : `parseMakefileTargets` (cibles + desc `## …`, hors variables/motifs/.PHONY), recherche + `runMake` (cible **whitelistée** depuis le fichier) ; orphelins : `reconstructRunCommand` (inspect → `docker run` lisible), **stop**, suppression après **sauvegarde de l'inspect**. **Logs** : `listContainers` (liste plate depuis `docker ps -a`) + `spawnLogs(id, tail)` (renvoie le process `docker logs -f --tail N -- <id>` à câbler en SSE ; validé par `validRef`). On shelle le CLI `docker`/`make` (comme git/agent), `--format json` ; binaire `docker` résolu via `DOCKER_BIN` → PATH → emplacements usuels. Anti flag-smuggling (`validRef` + `--`). Démon injoignable / CLI hors PATH → message actionnable |
| `demo-docker.js` | **données Docker statiques du mode démo** : 2 projets compose (dont un service en drift config avec diff visible + secret masqué, un en drift image, un non créé) + 2 containers hors-compose avec commande reconstituée |
| `server.js` | chargement `.env`, endpoints REST, static (`Cache-Control: no-cache` → le navigateur revalide à chaque chargement, plus de « je ne vois pas mes changements ») |

## Modèle de données (SQLite)

- **config** (row unique) — `gitlab_url`, `access_token`, `clone_path`, `review_skill`, `auto_refresh_minutes` (0 = désactivé), `language`, `review_explain` (`'1'`/`'0'` : générer l'explication pédagogique lors d'une review), `converge_threshold` (seuil cible /10, défaut 8) et `converge_max_passes` (plafond de passes, défaut 3), templates de prompt ; **GitHub** : `github_url` (vide = github.com, sinon GitHub Enterprise) et `github_token` (secret masqué) ; **Jira** : `jira_url`, `jira_email`, `jira_token` (secret masqué).
- **repo** — `project`, `url`, `branch_pattern` (vide = toutes les MR), `enabled`, **`forge`** (`'gitlab'` par défaut | `'github'`). L'unicité d'un dépôt est le **couple `(forge, project)`** : `acme/web` peut exister sur les deux forges.
- **mr** — MR découverte : `iid`, `title`, `source_branch`, `target_branch`, `author`, `gitlab_created_at`, `current_sha`, `reviewed_sha`, `status` (`to_review`/`reviewed`/`done`), `last_error`, `closed_seen`, `ticket_text`/`ticket_image` (contexte manuel), **contexte Jira** `ticket_jira_text`/`ticket_jira_key`/`ticket_jira_at`/`ticket_jira_error` (récupéré au discover, distinct du manuel — concaténés à la review), et **session de review** `review_session_key`/`review_session_backend`/`review_session_cwd` (continuité : « Relancer la review » reprend la même session).
- **review** — `md_path`, `explanation_path`, `diff_path` (fichiers sur disque).
- **review_version** — **historique des reviews** : une ligne par passe (`version`, `md_path`, `explanation_path`, `note_value`, `reviewed_sha`, `kind` review/modify). Chaque review écrit `review-v<N>.md` au lieu d'écraser ; la table `review` pointe la version la plus récente, donc rien d'autre ne change. Migration idempotente : les reviews existantes deviennent leur version 1. Porte aussi les **agrégats de résolution** `n_new/n_persistent/n_resolved/n_disappeared` (renseignés dès la 2ᵉ passe).
- **finding** — **suivi de résolution** : les constats structurés d'une passe de review (`version`, `fingerprint` = hash(fichier+titre normalisé, SANS la ligne), `file`, `line`, `severity`, `title`, `status`). `status` ∈ new/persistent/resolved/disappeared, calculé en comparant à la passe précédente. « resolved » n'est posé que si la ligne a **changé entre les deux `reviewed_sha`** (garde-fou git) ; sinon « disappeared ». Agrégats (`n_new/n_persistent/n_resolved/n_disappeared`) portés par `review_version` pour le bandeau et le taux de résolution.
- **review_rule** — déclencheur `branch_match` (fragment de branche) **et/ou** `path_match` (glob sur les fichiers du diff), `label` (badge « risque »), `content`, `enabled`. Le risque d'une MR vient de ce qu'elle touche.
- **repo_link** — projets liés PAR DÉFAUT d'un dépôt (`repo_id`, `linked_repo_id`, `branch`) : copiés dans `mr_link` à la découverte d'une nouvelle MR (pré-remplissage zéro clic), définis depuis la modale Contexte.
- **mr_link** — projets liés d'une MR (`repo_id`, `branch`) : à la review, l'IA les consulte en lecture seule (montés en symlink sous `ai-dev-tools-internal/linked/`, worktrees remis à zéro après) et analyse l'impact des changements. Auto-lien exclu.
- **mr.changed_paths** — chemins des fichiers modifiés (rempli au discover via l'API et à la review via le diff) : source du **badge « risque »** (chemins × règles, sans IA).
- **job** / **job_log** — jobs de fond + log en direct persistant.
- **comment_log** — commentaires niveau MR postés depuis l'app.
- **task** / **task_image** — sessions : `kind` (`code`/`explore`), `prompt`, `commit_message`, `auto_push`, `status` (agrégé depuis les projets), `md_path` (réponse d'exploration), `created_at`. Champs historiques mono-projet conservés mais inutilisés. Ancien format : `prompt`, `branch`, `base_branch`, `commit_message`, `auto_push`, `status` (`new`/`running`/`committed`/`pushed`/`error`), `commit_sha`, `diff_path`, `push_command`, `mr_iid`/`mr_url`/`mr_target`/`mr_merged`, `last_error`.
- **task_target** — **un projet d'une session** : `repo_id`, `branch`, `base_branch`, `status` (dont **`needs_input`** — l'agent a posé des questions, état d'ATTENTE hors compteur d'échec), `commit_sha`, `diff_path`, `push_command`, `mr_iid`/`mr_url`/`mr_target`/`mr_merged`, `last_error`, et pour l'ask→resume : `questions_json` (questions + réponses) + `session_key`/`session_backend`/`session_cwd` (handle de reprise ; le `cwd` fait partie de l'identité de session). C'est ici que vit l'état d'exécution : une session peut porter sur plusieurs dépôts, chacun avec son commit, son diff et sa MR. `task.ask_questions` porte le toggle par session (défaut off). Migration idempotente : chaque tâche mono-projet existante est convertie en une session à un seul target.
- **usage** — consommation de tokens de l'agent IA (footer) : `kind`, `prompt_chars`, `output_chars`, `tokens_est`, `created_at`. Une ligne par appel IA. L'entrée inclut le prompt **et le diff** (que l'agent lit lui-même : on ne lui passe que le chemin) ; la sortie inclut le **rapport écrit dans le fichier**, complété après lecture. Comptage exact via `gpt-tokenizer`, sinon ≈ car./4. ⚠️ Le travail interne de l'agent (lectures de fichiers, appels d'outils, tours de raisonnement) reste invisible : le total est un **minorant**.
- **git_op** — journal des opérations de l'onglet Git : `batch_id`, `action`, `project`, `ref_name`, `ref_sha`, `tag_sha`, `tag_message`, `status`, `fetched`, `restored_at`. Sert l'historique **et la restauration** : le SHA d'une ref supprimée y est conservé, avec le drapeau `fetched` (objets rapatriés localement avant la suppression). Un tag annoté garde ses deux SHA (tag + commit).
- **local_task** / **local_task_dir** / **local_task_image** — **« Codage hors dépôt »** : une session (`prompt`, `status`), ses **dossiers locaux** (`path`, `status`, `last_error`, `output_path` = retour de l'agent, `session_key`/`session_backend`/`session_cwd` = handle de reprise) et ses **captures** jointes au prompt (comme `task_image`). Aucun `repo_id` (hors git) → tables dédiées plutôt que `task`/`task_target` (dont `repo_id`/`branch` sont NOT NULL). L'IA code EN PLACE dans chaque dossier, sans commit ; les captures sont référencées par **chemin absolu** dans le prompt (agent en place, sans clone → rien copié dans les dossiers de l'utilisateur). Le formulaire réutilise la **modale de codage** (kind `local`).
- **convergence_run** — une **boucle « Converger »** rattachée à une MR : `status` (running/converged/capped/regressed/no_change/stopped/error), `threshold` (/10), `max_passes`, `passes_done`, `start_note`/`best_note` (/10), `best_version` (→ review_version), `message`, `started_at`/`finished_at`. L'historique fin (note par passe) vit déjà dans `review_version` ; cette table ne porte que l'état global de la boucle.
- **feed** — journal d'événements « frais » du footer : `type` (`mr_opened`/`mr_merged`), `mr_iid`, `project`, `author`, `title`, `at`. Émis par `discover` (nouvelle MR ; MR ouverte disparue de la forge = mergée/fermée, avec garde d'ancienneté 7 j anti-fantômes + flag `mr.closed_seen` anti-doublon) et par le merge applicatif.

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
(review / explain / modify) sont **éditables** (Réglages, défauts dans `src/prompts.js`, `{placeholders}`
remplis à l'exécution) ; **tout le reste ci-dessous est en dur dans le code** et jamais montré à l'utilisateur.

**Gabarits de base éditables** (`src/prompts.js`, fr/en, variables `{skill}` `{source}` `{target}` `{diff_file}` `{previous}` `{instruction}`) :
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
- **Exploration** (`taskrunner.runExploration`) : « Tu explores N dépôt(s)… QUESTION : `{question}` … LECTURE SEULE — ne modifie/crée/supprime AUCUN fichier… écris UNE SEULE réponse de synthèse … UNIQUEMENT dans le fichier `{out_file}` ». (worktrees remis à zéro après → garantie structurelle.)
- **Correction de review** (même texte, deux points d'entrée) : « Voici une revue de code de la branche X. Applique directement… les corrections PERTINENTES (bugs, sécurité, robustesse, correction fonctionnelle ; ignore le cosmétique ou ambigu).\n\n`=== RAPPORT DE REVUE ===`\n`{reviewMd}` ». Utilisé par la **convergence** (`converge.applyFixAndPush`) **et** par le bouton **« Corriger la review »** d'une MR (`POST /api/mrs/:id/fix-review`, `server.js` — crée une session de codage préremplie avec ce prompt).
- **Codage hors dépôt** (`localcoder.js`) : « Réalise la tâche… dans ce dossier. Modifie directement les fichiers… » (EN PLACE, sans git).
- **L'IA pose une question** (opt-in, `questions.QUESTIONS_INSTRUCTION`) : consigne d'émettre un bloc `<<<QUESTIONS>>>` et de **s'arrêter avant** d'implémenter la partie ambiguë ; **reprise** (`questions.buildAnswerInstruction`) : « Voici les réponses à tes questions : … Poursuis la tâche à partir de là. ».
- **Banc d'essai de reprise** (`aisession.js`) : deux prompts de test (« Mémorise ce marqueur secret : X … » puis « Rappelle-moi le marqueur… »).

**Formats de sortie EXIGÉS (contrats de parsing)** :
- **`<<<FINDINGS` … `FINDINGS>>>`** (`resolution.js` `START`/`END`) : une ligne par constat, `sévérité | fichier | ligne | titre court` ; sévérité ∈ {blocker, major, minor, info} ; **titre stable** (clé d'appariement du suivi de résolution). Émis aussi par le mock dry-run (`copilot.mockReport`). Parsé par `resolution.parseFindings`, retiré du Markdown affiché.
- **`<<<QUESTIONS` … `QUESTIONS>>>`** (`questions.js`) : **tableau JSON** `[{ id, question, context, options: [{value,label}]|null }]` ; `options:null` → réponse libre ; **5 max** ; malformé/absent → ignoré (session non bloquée). Simulé par le dry-run (`taskrunner.DRYRUN_QUESTIONS`).
- **Note globale `X/Y`** (`note.js` `extractNote`) : cherchée en texte libre du rapport (ligne « note »/« score » avec fraction, sinon toute fraction sur base 5/10/20/100, sinon lettre A–F). Normalisée en `note_value` ∈ [0,1].
- **`--output-format stream-json --verbose`** (claude, `agentsession.js`) : émet des **événements NDJSON en direct** (streaming — progression visible : texte de l'assistant + outils utilisés `🔧`), et le dernier `type:result` expose `result` (texte) + `session_id` (vérification croisée de la reprise). Copilot est streamé ligne par ligne (pas de mode événements). Le texte final de l'agent est **sauvegardé** (`taskrunner.saveAgentOutput` → `output.md`, `task_target.output_path`) → consultable via **« Retour de l'IA »**.
- **Marqueur `=== RAPPORT DE REVUE ===`** : séparateur en dur entre la consigne de correction et le rapport injecté (convergence).

## File de jobs

Un **worker séquentiel** unique traite une file : reviews, re-reviews, modifs et tâches passent par la même file (un traitement à la fois). État persisté en `job`/`job_log` → survit à la fermeture d'onglet. **Stop** tue le process enfant et vide la file. Actions de session (kind `task`) : `run` / `followup` / `push` / **`answer`** (reprise après réponses aux questions de l'IA).

## Rafraîchissement automatique des MR

Optionnel, piloté par `config.auto_refresh_minutes` (0 = off, **minimum 1 min** contre les rate limits). **Côté serveur** : un `setInterval` relance `discoverAll()` (appel API de la forge de chaque dépôt), sans chevauchement (garde `autoRefreshBusy`) ; (re)configuré au démarrage et à chaque `PUT /api/config`. **Côté front** : l'intervalle est exposé dans `GET /api/status` (`autoRefreshMinutes`) ; un polling recharge alors les listes **depuis la base locale** (aucun appel de forge supplémentaire) pour que la liste des MR à traiter se mette à jour toute seule.

## API REST (extrait)

- Config/dépôts : `GET/PUT /api/config`, `GET/POST/PUT/DELETE /api/repos[...]`, `POST /api/repos/bulk` (champ **`forge`**, absent = `gitlab` → contrat inchangé), `GET /api/gitlab/projects|branches`, **`GET /api/github/projects`**, **`POST /api/github/test`** (valide le token, renvoie le login).
- Découverte/jobs : `POST /api/discover`, `POST /api/jobs/review`, `POST /api/jobs/stop`, `GET /api/jobs/current[/log]`.
- Diff avant review : `GET /api/mrs/:id/diffview` (clone à la demande + diff en direct, pour juger sans appel IA).
- Résolution : `GET /api/mrs/:id/findings[?v=N]` (constats + statut d'une version), delta inclus dans `GET /api/mrs/:id/versions`, taux dans `GET /api/stats`.
- MR : `GET /api/mrs[/:id]`, `/:id/review` (body `explain` optionnel : surcharge ponctuelle du réglage global), `/:id/explain` (génère l'explication seule), `/:id/rereview` (body `incremental` optionnel : ne relire que le delta depuis `reviewed_sha`), `/:id/converge` (body `threshold`/`maxPasses` optionnels : lance la boucle « Converger »), `/:id/modify|fix-review|done|reopen|delete-review|comment|clear-error|merge`, `/:id/diff|tree|file|filediff`, `/:id/discussion[s]`, `/:id/discussions/:discId/reply`, `/:id/ticket[-image]`.
- Règles : `GET/POST/PUT/DELETE /api/rules`.
- Sessions : `GET/POST/PUT/DELETE /api/tasks[...]` (avec `kind`, `targets: [{repo_id, branch, base_branch}]`, et `ask_questions` : opt-in « l'IA peut poser des questions »), `/:id/run|followup|md|clear-error|image`, `/:id/converge` (body `threshold`/`maxPasses` : du prompt à la/les MR convergée(s)).
- Codage hors dépôt : `GET/POST/DELETE /api/local-tasks[/:id]` (`{ prompt, dirs: [chemins] }`), `/:id/run` (l'IA code dans chaque dossier local, sans git), **`/:id/followup`** (`{ instruction }` → nouvelle passe reprenant la session de chaque dossier), **`GET /:id/dirs/:did/output`** (retour de l'agent pour un dossier).
- Actions **par projet** : `/api/tasks/:id/targets/:tid/diff|push|mr|merge`, **`/diffview|/file|/filediff`** (viewer plein écran — MÊMES helpers serveur que les routes de MR : `viewerPayload`/`viewerFile`/`viewerFileDiff`, seul le contexte de clone change), et **`/answer`** (`{ answers: {qid: valeur} }` → **passe le projet en `running` dès l'envoi** — il quitte `needs_input` pour que le formulaire ne réapparaisse pas pendant la reprise — puis reprise de la session d'agent après réponses aux questions ; une reprise en échec → `error` avec la vraie raison). Les projets exposent `resume_cmd` (commande de reprise au terminal) et, en attente, `questions` (bloc parsé).
- Reprise de session (banc d'essai) : `POST /api/ai-sessions/test` (deux passes dans la même session pour valider la reprise ; simulé en dry-run).
- Git multi-dépôts : `GET /api/git/refs` (branches/tags), `POST /api/git/preview` (aucun effet), `POST /api/git/execute` (via la file de jobs), `GET /api/git/ops`, `POST /api/git/ops/:id/restore`, `GET /api/git/branches` (explorateur, exige un clone local), `GET /api/git/tag-author?repo_id&tag` (**auteur exact d'un tag** — le *tagger* d'un tag annoté, lu à la demande dans le clone local car aucune des deux API de forge ne l'expose), `GET /api/git/find-ref?name&type` (**recherche d'une ref à travers tous les dépôts actifs** : tag et/ou branche ; pour un tag trouvé, on renseigne aussi la ou les **branches qui le portent** via le clone local ; dépôt injoignable marqué `error`, jamais confondu avec « absente ») ; `POST /api/git/mr` crée une MR entre une branche et sa source depuis l'explorateur.
- Répertoires locaux (`localrepos.js`) : `GET/POST/DELETE /api/local-roots[/:id]`, `GET /api/local-roots/:id/projects`, `GET /api/local-projects/branches`, `POST /api/navigate/checkout` (positionne N projets sur leur branche, bilan par projet). **Commandes Git** : `GET/POST/PUT/DELETE /api/git-commands[/:id]` (**palette** nom + commande figée, Réglages → Git), **`POST /api/git-run`** (`{ targets: [{root_id, name}], command }` → **même commande git à la racine de chaque projet** ; `parseGitArgs` tokenise en respectant les guillemets, **sans shell** ; `assertSafeGitArgs` **refuse les options git à exécution arbitraire** (`-c`/`--config`, `--upload-pack`/`--receive-pack`/`--exec`, `-C`/`--git-dir`/`--work-tree`/`--namespace`/`--exec-path`, transport `ext::`/`fd::`) et **impose une sous-commande en tête** — « sans shell » ne suffit pas car git a lui-même des flags-RCE ; exécution préfixée de `-c protocol.ext.allow=never` + `GIT_TERMINAL_PROMPT=0` ; capture stdout+stderr et le code de sortie **sans lever** sur code ≠ 0 ; bilan `{command, results:[{project, code, ok, output, truncated}], counts}`).
- Docker : `GET /api/docker/status` (démon joignable ? sinon message actionnable), `GET /api/docker/compose` (tous les projets compose + drift ; un seul `ps -a`, projets calculés en parallèle), **`GET /api/docker/compose/list`** (liste légère → affichage progressif) + **`GET /api/docker/compose/one?dir=&file=`** (détail d'un projet à la demande), `GET /api/docker/orphans` (containers hors-compose), `POST /api/docker/compose/preview-down` (aperçu, sans effet), `POST /api/docker/compose/action` (`{ dir, action: up|restart|pull|recreate|build|down, services }` → file de jobs, log streamé ; `build` = `up -d --build`), **`POST /api/docker/bulk-action`** (`{ action, targets: [{dir, service}] }` → **action groupée** : services cochés regroupés par répertoire → un `docker compose` par projet, dans un seul job `op:compose-bulk` séquentiel, un échec n'arrête pas les autres), `GET /api/docker/orphan/:id/reconstitute` (inspect → `docker run` lisible), `POST /api/docker/orphan/:id/remove` (sauvegarde l'inspect puis supprime), `GET /api/docker/backups`, `GET /api/docker/summary` (`{error, unhealthy, total, running}` → badges santé du menu : rouge = restarting/dead, orange = unhealthy ; **polling front toutes les 30 s** — un seul `docker ps -a`, en pause si l'onglet navigateur est masqué → l'état s'affiche dans le titre du menu même hors de l'onglet Docker), `GET /api/docker/containers` (liste plate pour l'onglet Logs), **`GET /api/docker/logs/stream?ids=…&tail=N`** (SSE — **seul endpoint non-JSON** : un `docker logs -f` par container, lignes `data: {c,m}` taguées par container ; process tués à la déconnexion ; ≤ 12 containers ; filtrage inclure/exclure fait **côté client**, persisté en localStorage).
- Jira : `POST /api/jira/test` (valide URL/email/token sur un ticket témoin), `POST /api/jira/fetch` (récupère un ticket par sa clé → contexte Markdown prêt à injecter dans une session), `POST /api/mrs/:id/jira-refresh` (re-fetch à la demande), **`GET /api/jira/assignees`** (`{ me, people }` → filtre par personne : moi + assignés récents), **`GET /api/jira/tickets?assignees=<accountIds>&includeDone=0|1`** (tickets des personnes cochées ; vide = mes tickets → `{ configured, issues, total }`), **`GET /api/jira/issue/:key`** (détail : métadonnées + description + commentaires + pièces jointes + **transitions** possibles), **`POST /api/jira/issue/:key/transition`** (`{ transitionId }` → **change l'état** du ticket ; id validé numérique), **`POST /api/jira/issue/:key/comment`** (`{ text }` → **poste un commentaire** ; texte converti en ADF via `textToAdf`), **`GET /api/jira/attachment/:id`** (proxy de téléchargement d'une pièce jointe — id numérique, URL construite sur la base Jira configurée → pas de SSRF ; `Content-Disposition` unicode).
- Dashboard/footer : `GET /api/stats` (funnel, distribution + **évolution hebdo de la note** via review_version, table par projet avec **taux de résolution** et **tendance** 28 j vs 28 j, **coût en tokens par type d'appel** + **coût moyen par MR reviewée** depuis la table usage — total = minorant), `GET /api/dashboard/commits` (**dernier commit par dépôt** — live depuis la forge du dépôt, best-effort, chargé en asynchrone : alimente la colonne « dernier commit » du tableau projets ET le **Top 5 activité récente**), `GET /api/footer` (tokens, activité perso, paliers, activité équipe).
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

Le **serveur émet des faits**, le **client décide**. `src/notify.js` est un simple **ring buffer en
mémoire** (300 événements max, ids croissants) alimenté par les points chauds : `queue_done` (fin de
file, `jobs.js`), `review_done` (note/10, `reviewer.js`), `job_failed` (× review/session/file,
`jobs.js`), `session_done` et **`needs_input`** (l'IA a posé une question, `jobs.js`), `converge_done`,
`mr_new`/`mr_merged` (`discover.js`). Le client fait un
**long-poll léger** (`GET /api/notifications?after=` toutes les 5 s) ; **le premier passage cale le
curseur sans rejouer l'historique**. Le filtrage est **100 % côté navigateur** (localStorage
`mergerie_notif`) : types activés, **seuil de note basse**, **mode silencieux**. Critère de tri —
*une notif appelle une action ou clôt une attente* ; le reste vit au footer. Le **clic** ramène au bon
endroit via le routage d'onglets existant (`Notification.onclick` → focus + `openReport`/`navTab`). Les
notifs sont **persistantes** (`requireInteraction`) : elles restent affichées jusqu'à action/fermeture,
pour ne pas être manquées. Réglages fins dans un **sous-onglet dédié** *Réglages → Notifications*, avec le
statut de permission (accordée / refusée / à demander) et un bouton *Tester* — un refus silencieux étant le
piège classique de l'API. Aucune persistance serveur : redémarrage = buffer vide, sans rejeu.

## Commentaires (les deux forges)

Le front et `server.js` ne connaissent QU'UNE forme, celle de GitLab (un fil = une `discussion` portant des
`notes`, inline si `position`). `github.js` la reconstitue depuis les deux concepts GitHub.

| | GitLab | GitHub |
|---|---|---|
| **Niveau MR** | `POST .../notes` | `POST /issues/{n}/comments` (issue comment) |
| **Inline** | `POST .../discussions` avec une `position` complète (`base_sha`/`start_sha`/`head_sha` récupérés via la MR, `old_path`/`new_path`, `old_line`/`new_line`) | `POST /pulls/{n}/comments` avec `commit_id` (= head_sha) + `path` + `line` + `side` (`RIGHT` si `new_line`, `LEFT` sinon) |
| **Réponses** | `POST .../discussions/:id/notes` | `POST /pulls/{n}/comments/{id}/replies`, l'`id` étant celui de la note **racine** du fil |
| **Lecture** | `GET .../discussions` | `GET /pulls/{n}/comments` (fils regroupés par `in_reply_to_id`) + `GET /issues/{n}/comments` (fils d'une note, id préfixé `issue-` pour savoir où répondre) |

Les numéros de ligne sont calculés à partir du diff à contexte complet. Inline affichés sous leur ligne,
généraux dans le détail du rapport (notes système filtrées — GitHub n'en a pas d'équivalent).

## Sécurité / robustesse


- **TLS scopé par forge** (jamais de `NODE_TLS_REJECT_UNAUTHORIZED` global) ; CA pinning ou insecure opt-in, séparément pour GitLab et GitHub.
- **Tokens masqués** dans les logs (GitLab ET GitHub : `git.secretsOf(cfg)`) ; stockés en BDD locale, jamais renvoyés en clair (masque `***` en lecture, renvoyer le masque n'écrase pas).
- **Clone HTTPS authentifié selon la forge** : `oauth2:<token>@` pour GitLab, `x-access-token:<token>@` pour GitHub.
- Nom de **branche validé** (anti argument-injection git) ; **chemins de fichier validés** contre l'arborescence (anti traversal).
- Rendu markdown **escape-first** (pas d'HTML brut → pas de XSS) ; contenu distant (commentaires) rendu via ce renderer.
- Commandes git/agent lancées via `spawn` (pas de shell).
- **Contexte Jira** (donnée externe) : convertisseur ADF qui ne propage que les `href` http(s)/mailto ; fetch best-effort qui n'interrompt jamais le discover ; `jira_token` masqué comme les tokens de forge.

## Interface

Sept onglets : **Reviews** (filtre segmenté sur les 3 stades d'une MR) · **Dev IA** (sous-onglets
Codage / Exploration) · **Statistiques** · **Git** (sous-onglets Actions / Navigation / **Commandes Git** / Explorateur de branches / Trouver une ref / Historique) · **Docker** (sous-onglets Compose / Hors-compose / Logs / Actions ; drift .env, badges santé du menu, tail live des logs, actions groupées ; **Compose : recherche de service/container + filtre d'état**, tous deux persistés et appliqués côté client — le prédicat d'état est celui d'*Actions* (`dactMatchesFilter`), un seul comportement à maintenir) · **Jira** (mes tickets affectés : liste filtrable par statut — choix persisté — → détail avec contenu, métadonnées, commentaires, pièces jointes, changement d'état, ajout de commentaire) ·
**Réglages** (sous-onglets Règles / Dépôts / Notifications / Général / **Git** / **Jira** / Merge Request / AI sessions ; les champs sont éclatés sur plusieurs sous-onglets mais restent **un seul `#configForm`** via l'attribut HTML `form=` : URL GitLab / access token / **URL et token GitHub** / dossier de clonage → **Git** ; URL/email/jeton Jira → **Jira** ; + la **palette de commandes** dans Git).
**Statistiques** : chaque graphe porte une **légende d'utilité** (la question à laquelle il répond) ; camembert des tokens en `conic-gradient` (pas de calcul d'arc SVG).
Système de design à variables CSS (typographie, espacement, rayons, élévation, mouvement), composant
`.btn` unique à hauteur fixe, sprite **SVG inline** (aucune icône emoji, rendu identique partout),
thème clair/sombre/auto avec contrastes **WCAG AA vérifiés** dans les deux thèmes.
Règle globale `[hidden] { display: none !important }` : sans elle, toute règle posant un `display`
neutralise silencieusement l'attribut — source récurrente de bugs.
Toute liste où l'on choisit un dépôt utilise un **combo avec recherche** (un `<select>` natif
devient inutilisable au-delà de quelques dizaines de projets) — `repoComboHtml`/`wireRepoCombos`,
partagé par l'onglet Git ; le modale de session et l'ajout en masse ont leur équivalent.
**Garde-fous statiques** (`npm run check`) : `check-front.js` (sélecteur `$` traité en liste,
sous-onglet sans `segmented`, id inconnu, icône absente, `busy()` mal appelé, `<select>` de dépôt
sans recherche) et `i18n-check.js` (parité fr/en, clés absentes, entités HTML, français en dur).
Chacun est né d'un bug réel : ils attrapent en statique ce que `node --check` ne voit pas.

## Internationalisation (fr / en)

Dictionnaire unique `public/i18n.js` (UMD : chargé côté navigateur **et** côté serveur — les messages
d'erreur du serveur sont de l'interface), moteur `public/i18n-runtime.js` (`tr()`, pluriels
`{one, other}`, `currentLocale()`). La préférence vit en base (`config.language`) car le serveur en a
besoin, avec un miroir `localStorage` pour appliquer la langue avant le premier rendu. Les rapports IA
suivent la langue via les gabarits de prompt de `src/prompts.js`, **sans jamais écraser un prompt
personnalisé**.


## Environnement cible

WSL/MAC/Linux. GitLab self-hosted ou GitHub Enterprise avec CA d'entreprise → `GITLAB_CA_CERT`/`GITHUB_CA_CERT` (ou `GITLAB_INSECURE_TLS=1`/`GITHUB_INSECURE_TLS=1`), et `GIT_CLONE_SSH=1` pour le clone. Agent IA lancé avec le flag « yolo » pour autoriser la modification de fichiers. `.env` chargé automatiquement au démarrage.

## Mode dry-run

Sans binaire d'agent (ou `COPILOT_DRY_RUN=1`) : rapports/tâches mock générés depuis le diff → pipeline complet testable hors-ligne. `npm run pipe` = smoke test sur un dépôt synthétique.
