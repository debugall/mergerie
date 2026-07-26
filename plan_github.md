# Plan — Support GitHub complet : parité de toutes les fonctionnalités

## Objectif

Mergerie fonctionne **indifféremment avec GitLab et GitHub**, dépôt par dépôt :

1. **Réglages → Git** : bloc « Connexion GitHub » (URL optionnelle pour GitHub Enterprise, token,
   bouton *Tester la connexion GitHub*), sur le même modèle que le bloc GitLab.
2. **Réglages → Dépôts** : bouton **« Ajout en masse depuis GitHub »** à côté de l'existant (même
   modale, avec recherche — règle projet : toute liste de projets a une recherche).
3. **Tout le reste marche pareil** sur un dépôt GitHub : découverte des PR, review notée/versionnée,
   re-review incrémentale, contexte ticket, commentaires (généraux, inline, réponses), merge,
   convergence, sessions de dev (créer la PR, merger), onglet Git (branches/tags/refs protégées,
   explorateur, trouver une ref, suppressions restaurables), statistiques (dernier commit).

**Principe directeur** : le code appelant consomme déjà une **forme normalisée** (MR :
`{ iid, title, source_branch, target_branch, web_url, sha, created_at, author, state }` ; branches :
`{ name, default, protected }` ; etc.). On ne change **pas** cette forme : `src/github.js` normalise
les objets GitHub vers elle, et un dispatcher choisit le client selon `repo.forge`. Aucun schéma de
MR/review/task ne change (le `iid` d'une PR = son `number` ; la colonne historique
`gitlab_created_at` garde son nom).

---

## Étape 1 — Schéma & config

**`src/db.js`** (migrations idempotentes, style existant)
- `ALTER TABLE repo ADD COLUMN forge TEXT DEFAULT 'gitlab'` — l'existant reste `gitlab`.
- `ALTER TABLE config ADD COLUMN github_url TEXT DEFAULT ''` et `… github_token TEXT DEFAULT ''`.

**`src/config.js`**
- `github_url`, `github_token` dans `ALLOWED` **et** dans le `UPDATE config SET …` (les deux, sinon
  valeur perdue silencieusement). Normaliser `github_url` comme `gitlab_url` (trim, pas de slash
  final). Vide = `https://github.com`.

**`src/server.js` — masquage** (répliquer le motif `jira_token` aux trois points) :
- `GET /api/config` + réponse `PUT` : `github_token: c.github_token ? '***' : ''`.
- `PUT /api/config` : `if (patch.github_token === '***') delete patch.github_token;`.

## Étape 2 — Client GitHub complet : `src/github.js`

Nouveau module, **seul endroit** qui parle à l'API GitHub (même règle de centralisation que
`gitlab.js`). Extraire le helper `request()` de `gitlab.js` vers un module partagé (ex.
`src/httpreq.js`) ; `gitlab.js` garde son agent TLS scopé, `github.js` a le sien (env
`GITHUB_CA_CERT` / `GITHUB_INSECURE_TLS` en miroir de GitLab, pour une instance Enterprise à CA
interne).

Base : `apiBase(cfg)` — `github_url` vide ou `github.com` → `https://api.github.com` ; sinon
GitHub Enterprise → `<github_url>/api/v3`. `githubFetch(cfg, path, opts)` avec headers
`Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, **`User-Agent: mergerie`** (403 sans lui). Pagination générique
par header **`Link`** (`rel="next"`) — pas de `x-total-pages` à la GitLab. Erreurs actionnables :
401 → token ; 403 + `X-RateLimit-Remaining: 0` → rate limit (ne pas dire « token invalide ») ;
404 sur une PR/ref → introuvable.

**Interface = celle de `gitlab.js`**, mêmes noms, mêmes formes de retour. Table de correspondance :

| Fonction (contrat inchangé) | Endpoint GitHub | Normalisation / pièges |
|---|---|---|
| `normalizeProject(input)` | — | `owner/repo` (URL web ou clone acceptées). Pas de sous-groupes, pas d'URL-encoding du `/` |
| `encodeProject(p)` | — | identité (`/repos/{owner}/{repo}`) |
| `listAccessibleProjects(cfg)` | `GET /user/repos?per_page=100&sort=pushed` | → `{ project: full_name, name, url: clone_url }` |
| `listOpenMRs(cfg, project, pattern)` | `GET /repos/{p}/pulls?state=open&per_page=100` | PR → forme MR : `iid=number`, `source_branch=head.ref`, `target_branch=base.ref`, `sha=head.sha`, `author=user.login`, `web_url=html_url`, `created_at` ; filtre `pattern` sur la branche comme côté GitLab |
| `getMergeRequest(cfg, project, iid)` | `GET /pulls/{n}` | **état normalisé** : `merged: true` → `state='merged'`, sinon `open→'opened'`, `closed→'closed'` (le code teste `state === 'merged'`) |
| `listAllMRs(cfg, project)` | `GET /pulls?state=all&per_page=100` | même forme |
| `listMrChangedPaths(cfg, project, iid)` | `GET /pulls/{n}/files` (paginé) | → `[filename]` (old+new : inclure `previous_filename` si renommage) |
| `createMergeRequest(cfg, project, {source_branch, target_branch, title})` | `POST /pulls` `{head, base, title}` | retour normalisé (`iid`, `web_url`) |
| `mergeMergeRequest(cfg, project, iid)` | `PUT /pulls/{n}/merge` | puis relire la PR pour renvoyer l'état normalisé (l'appelant vérifie `merged`) |
| `postMrNote(cfg, project, iid, body)` | `POST /issues/{n}/comments` | les commentaires généraux d'une PR sont des issue comments |
| `listMrDiscussions(cfg, project, iid)` | `GET /pulls/{n}/comments` + `GET /issues/{n}/comments` | reconstruire la forme GitLab `{ id, notes: [{author, body, created_at}], position? }` : fils inline groupés par racine via `in_reply_to_id` (racine = commentaire sans `in_reply_to_id`, id du fil = id de la racine) ; issue comments = discussions sans position ; filtrer les notes « système » n'existe pas (pas d'équivalent) |
| `postMrDiscussion(cfg, project, iid, body, position)` | `POST /pulls/{n}/comments` | mapping position : `commit_id` = head_sha, `path` = new_path sinon old_path, `line` = new_line sinon old_line, `side` = RIGHT si new_line sinon LEFT |
| `replyToDiscussion(cfg, project, iid, discussionId, body)` | `POST /pulls/{n}/comments/{id}/replies` | `discussionId` = id du commentaire racine ; si le fil est un issue comment → `POST /issues/{n}/comments` |
| `listBranches(cfg, project)` | `GET /branches?per_page=100` + `GET /repos/{p}` | → `{ names, default }` (default depuis le repo) |
| `listBranchesFull(cfg, project)` | idem | → `[{ name, default, protected }]` (`protected` est déjà dans la réponse) |
| `latestCommit(cfg, project)` | `GET /commits?per_page=1` | → `{ sha, title, author, date, web_url }` |
| `getRef(cfg, project, kind, name)` — kind branch ou tag | `GET /branches/{name}` / `GET /git/ref/tags/{name}` | 404 → null (existence d'une ref, aperçu gitops) |
| `createBranch(cfg, project, branch, ref)` | résoudre `ref` en sha (`GET /commits/{ref}`) puis `POST /git/refs` `{ref:'refs/heads/…', sha}` | GitLab accepte un nom de ref, GitHub exige un sha |
| `deleteBranch(cfg, project, branch)` | `DELETE /git/refs/heads/{branch}` | |
| `createTag(cfg, project, tag, ref, message)` | message → `POST /git/tags` (objet annoté, `tagger` requis) puis `POST /git/refs` ; sans message → ref directe | tagger : `{name:'mergerie', email:'noreply@mergerie.dev', date}` |
| `deleteTag(cfg, project, tag)` | `DELETE /git/refs/tags/{tag}` | |
| `listTags(cfg, project)` | `GET /tags?per_page=100` (paginé) | → `[{ name, commit: {sha, created_at}, … }]` aligné sur la forme GitLab consommée par l'explorateur |
| `listProtectedBranches(cfg, project)` | dérivé de `listBranchesFull` (flag `protected`) | → `[name]` |
| `listProtectedTags(cfg, project)` | **best-effort** `GET /repos/{p}/rulesets` (rulesets de tags) ; erreur/absent → `[]` | l'API « tag protection » historique est dépréciée ; GitHub refusera de toute façon la suppression côté serveur et gitops journalise l'échec ligne par ligne |
| `testConnection(cfg)` | `GET /user` | → `{ login }` (bouton *Tester*) |

## Étape 3 — Dispatcher : `src/forge.js`

```js
const gitlab = require('./gitlab');
const github = require('./github');
const forgeOf = (repo) => (repo && repo.forge === 'github' ? 'github' : 'gitlab');
const clientFor = (repo) => (forgeOf(repo) === 'github' ? github : gitlab);
module.exports = { forgeOf, clientFor };
```

**Remplacer chaque appel direct `gitlab.<fn>(cfg, repo.project, …)` par
`forge.clientFor(repo).<fn>(cfg, repo.project, …)`.** Inventaire exhaustif des points d'appel (tous
ont la ligne `repo`/`mr`/`tg` sous la main — joindre `repo.forge` dans les SELECT qui ne la
remontent pas encore, notamment `mrById`/`taskTargets`/les jointures de `server.js`) :

- **`src/discover.js`** : `listOpenMRs`, `listMrChangedPaths`, `getMergeRequest` (garde d'ancienneté),
  boucle par dépôt → client par dépôt. `upsertMrFromApi` reçoit déjà la forme normalisée : rien à changer.
- **`src/converge.js`** : `getMergeRequest`, `createMergeRequest`, `listBranches`.
- **`src/gitops.js`** : `listBranchesFull`, `listTags`, `listProtectedBranches`, `listProtectedTags`,
  `createBranch`×2, `createTag`×2, `deleteBranch`, `deleteTag` (aperçu, exécution, restauration).
- **`src/server.js`** (~15 sites) : notes/discussions/réponses, merge (MR et cible de session),
  `listBranches` (endpoint `/api/gitlab/branches` — garder l'URL, dispatcher à l'intérieur),
  `latestCommit` (dashboard), `getRef`/refs gitops, `createMergeRequest` (session et explorateur),
  `listAllMRs` (explorateur : « mergée dans »), `normalizeProject` (POST/PUT `/api/repos` : choisir le
  normalizer selon la forge de la ligne).

**`src/git.js`** — clone/push HTTPS+token : `authUrl()` force `username='oauth2'` (GitLab). Passer la
forge (ou le repo) : GitLab → `oauth2:<gitlab_token>@`, GitHub → `x-access-token:<github_token>@`, et
choisir le token selon la forge. `GIT_CLONE_SSH=1` reste valable tel quel pour les deux (la clé SSH de
l'utilisateur décide). Le masquage du token dans les logs doit couvrir les deux tokens.

**`src/jobs.js` / `reviewer.js` / `taskrunner.js` / `localcoder.js`** : aucun appel API forge direct
(tout passe par `git.js` et les callbacks) — vérifier seulement que les objets `repo` transportés
portent `forge` là où ils finissent par appeler `git.cloneUrl`.

## Étape 4 — Endpoints

- `GET /api/github/projects` — miroir de `/api/gitlab/projects` (flag `already` calculé sur les dépôts
  **github** uniquement).
- `POST /api/github/test` — motif `/api/jira/test` : accepte les valeurs non sauvegardées du body,
  `'***'` → token en base, renvoie `{ ok, login }`.
- `POST /api/repos/bulk` — champ `forge` (`'gitlab'` par défaut, contrat rétro-compatible) :
  normalizer selon forge, **dédup par couple `(forge, project)`** (deux homonymes doivent coexister) —
  adapter le `Set` (`` `${forge}:${p}` ``) et l'INSERT (colonne `forge`). Même correction dans le POST
  unitaire `/api/repos` et le PUT (une ligne ne change jamais de forge après création).
- `GET /api/repos` : renvoyer `forge` (badge UI).

## Étape 5 — Front

**`public/index.html`**
- Réglages → Git : fieldset « Connexion GitHub » sous le bloc GitLab — URL (icône *i* : « Vide =
  github.com ; pour GitHub Enterprise, l'URL de ton instance »), token (type password, masque `***` ;
  icône *i* : token classic scope `repo`, ou fine-grained *Contents Read/Write* + *Pull requests
  Read/Write* + *Metadata*), bouton `#btnTestGithub` (gabarit de `#btnTestGitlab`, icône `#i-zap`).
  Champs rattachés à `#configForm` via `form=` (comme les champs Jira).
- Réglages → Dépôts : bouton `#btnBrowseGithub` « Ajout en masse depuis GitHub » ; renommer l'existant
  en « … depuis GitLab ».
- **Sprite** : ajouter `#i-gitlab` et `#i-github` (logos simplifiés en `currentColor` — thèmes
  clair/sombre) ; `check-front.js` exige que toute icône utilisée existe.

**`public/app.js`**
- `openBulk(forge)` : modale existante paramétrée (titre, source `/api/{forge}/projects`, `forge` dans
  le POST). Recherche et « tout cocher » inchangés. État vide GitHub : même motif (action `go-config`
  → sous-onglet Git).
- Badge de forge sur chaque ligne de dépôt (liste Réglages → Dépôts) et partout où un projet
  s'affiche de façon ambiguë (les combos de sélection de dépôt affichent le badge si deux homonymes).
- `#btnTestGithub` : cloner le handler GitLab sur `/api/github/test` (affiche `login`).
- Liens externes : les cartes MR utilisent `web_url` (déjà normalisé) — vérifier qu'aucun libellé en
  dur ne dit « GitLab » là où la forge peut être GitHub (cartes, titres de boutons, messages d'erreur
  — remplacer par « la forge » ou dispatcher le libellé).

**`public/i18n.js`** — toutes les chaînes nouvelles/modifiées en **fr ET en** (parité bloquante via
`npm run i18n:check`).

## Étape 6 — Tests (e2e d'abord — règle projet)

**`test/helpers/mock-github.js`** (calqué sur `mock-gitlab.js`) : serveur HTTP local simulant l'API
REST GitHub utilisée — `/user`, `/user/repos` (**paginé via header `Link`**, 2 pages), `/repos/{p}`,
`/pulls` (list/create/get/merge), `/pulls/{n}/files`, `/pulls/{n}/comments` (+ replies),
`/issues/{n}/comments`, `/branches`, `/tags`, `/git/refs` (create/delete), `/commits`. Vérifie
`Authorization` et `User-Agent` sur chaque requête. État mutable comme `mock-gitlab.state`.

**`test/e2e-github.test.js`** — le pipeline complet sur un dépôt `forge='github'` :
1. Config : masquage `***` (GET, PUT sans écrasement, `/api/github/test` avec masque et avec valeur).
2. Bulk : pagination Link, flag `already`, dédup `(forge, project)`, homonyme GitLab coexistant,
   rétro-compat (bulk sans `forge` = gitlab).
3. **Discover → review → re-review incrémentale** : PR découvertes (pattern de branche respecté),
   review dry-run, note, suivi de résolution.
4. **Commentaires** : note générale, discussion inline (position mappée), réponse à un fil.
5. **Merge** : la PR passe `merged`, la MR sort de la file.
6. **Session de dev → PR → convergence** : branche, commit, push (URL `x-access-token@`), création de
   la PR, `convergeSession` jusqu'au seuil (mock note croissante).
7. **Onglet Git** : aperçu + création/suppression de branche et tag, refus des refs protégées
   (flag `protected` du mock), restauration d'une suppression.
8. **Mixte** : un dépôt GitLab + un dépôt GitHub actifs → discover interroge chaque mock, les listes
   mélangent les deux forges sans collision.

Vérifs statiques : `npm run check` (icônes, i18n, ids).

## Étape 7 — Docs & démo (règle projet)

- **README.md / README.fr.md** : Mergerie gère **GitLab et GitHub** — mise à jour du pitch (« for
  GitLab » → « for GitLab & GitHub »), de la ligne Settings et de la section démarrage (tokens des
  deux forges optionnels, au moins une configurée).
- **ROADMAP.md** : « GitHub support » → fait ; reste Bitbucket.
- **PLAN.md** : modules `github.js`, `forge.js`, `httpreq.js` ; `repo.forge` +
  `github_url`/`github_token` ; note sur la forme normalisée MR/PR et le mapping des discussions.
- **Mode démo** : `scripts/demo-seed.js` — au moins un dépôt `forge='github'` avec sa MR reviewée,
  pour que badges et listes mixtes soient visibles dans la démo. `demo-git.js` : jeu de refs pour le
  dépôt github aussi.
- **CLAUDE.md** : la règle « l'app sera plus tard intégrée avec GitHub » devient « l'app gère GitLab
  et GitHub ; tout appel de forge passe par `src/forge.js` (jamais `gitlab.js`/`github.js` en direct
  depuis les autres modules) ».

## Pièges connus (résumé)

1. **User-Agent obligatoire** sur l'API GitHub (403 sinon).
2. **Pagination `Link`** (`rel="next"`) — à appliquer sur pulls/branches/tags/files/comments aussi.
3. **Rate limit** : 403 + `X-RateLimit-Remaining: 0` → message dédié, pas « token invalide ».
4. **État de PR** : normaliser `merged:true` → `'merged'` (GitHub dit `closed` pour une PR mergée).
5. **Inline comments** : GitHub veut `commit_id + path + line + side` — dériver de la position GitLab ;
   les réponses passent par l'id du commentaire **racine**.
6. **`createBranch`** : GitHub exige un **sha** (résoudre la ref d'abord) ; GitLab acceptait un nom.
7. **Clone HTTPS** : username `x-access-token` pour GitHub (`oauth2` = GitLab) ; masquer les deux
   tokens dans les logs.
8. **Dédup `(forge, project)`** partout où `project` servait de clé (bulk, POST unitaire, `already`).
9. **Masquage `***`** : GET, PUT, endpoint de test — trois points.
10. **GitHub Enterprise** : base API `<url>/api/v3` ; CA interne via `GITHUB_CA_CERT`.
11. **Tags protégés** : best-effort (rulesets) avec repli `[]` — l'API GitHub refuse de toute façon la
    suppression d'une ref protégée, gitops journalise l'échec.
12. Ne pas oublier le `UPDATE config SET` dans `config.js` en plus de `ALLOWED`.

## Critères d'acceptation

- [ ] Token GitHub dans Réglages → Git, *Tester* affiche le login ; secret jamais en clair.
- [ ] Ajout en masse depuis GitHub (recherche, tout cocher, `already`, dédup) ; homonymes GitLab/GitHub
      coexistent avec leur badge.
- [ ] Sur un dépôt GitHub : discover → review notée → re-review incrémentale → commentaires (général,
      inline, réponse) → merge, identiques à GitLab.
- [ ] Session de dev sur un dépôt GitHub : code → commit → push → **PR créée** → convergence → merge
      depuis l'app. Sessions multi-projets **mixtes** (un GitLab + un GitHub) OK.
- [ ] Onglet Git complet sur un dépôt GitHub (refs, aperçu, suppressions restaurables, explorateur,
      trouver une ref) ; statistiques avec dernier commit GitHub.
- [ ] `npm run check` + `npm test` verts (e2e GitHub inclus) ; fr/en ; clair/sombre.
- [ ] README / PLAN / ROADMAP / CLAUDE.md / démo à jour.
