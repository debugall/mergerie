'use strict';
/* Client de l'API GitHub (REST v3) — MÊME INTERFACE que src/gitlab.js.

   Tout le reste de l'application consomme une forme NORMALISÉE (celle historiquement
   produite par gitlab.js) : une PR est donc traduite en « MR » ici, et nulle part
   ailleurs. `iid` = numéro de PR, `source_branch` = head.ref, etc. Grâce à ça, aucun
   appelant (discover, converge, gitops, server) ne connaît la forge : il demande son
   client à src/forge.js et appelle les mêmes fonctions.

   Vocabulaire GitHub → GitLab retenu :
     pull request → merge request      | number       → iid
     issue comment → note de MR        | review comment → discussion inline
     `merged: true` → state 'merged'   (GitHub dit `closed` pour une PR mergée) */

const { t } = require('../public/i18n-runtime.js');
const httpreq = require('./httpreq');

// Agent TLS dédié (GitHub Enterprise à CA interne), scopé à ce client comme pour GitLab.
const githubAgent = httpreq.makeAgentFactory('GITHUB_CA_CERT', 'GITHUB_INSECURE_TLS');
const request = (url, opts = {}) => httpreq.request(url, { ...opts, agent: githubAgent() });

const DEFAULT_HOST = 'https://github.com';

/* Identifiant de dépôt : "owner/repo". Accepte une URL web, une URL de clone https
   ou ssh, avec ou sans .git. Contrairement à GitLab il n'y a PAS de sous-groupes :
   on ne garde donc que les deux derniers segments. */
function normalizeProject(project) {
  let p = String(project || '').trim();
  if (p.includes('://')) {
    try { p = new URL(p).pathname; } catch { /* laisse tel quel */ }
  } else if (p.includes('@') && p.includes(':')) {
    p = p.slice(p.indexOf(':') + 1);              // git@github.com:owner/repo.git
  }
  p = p.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').trim();
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/');
}

// Les chemins d'API GitHub portent owner/repo tel quel (pas d'encodage du '/').
function encodeProject(project) {
  return normalizeProject(project);
}

function apiBase(cfg) {
  const raw = String(cfg.github_url || '').trim().replace(/\/+$/, '');
  if (!raw || raw === DEFAULT_HOST || raw === 'http://github.com') return 'https://api.github.com';
  return `${raw}/api/v3`;                          // GitHub Enterprise
}

// Base des URLs WEB (liens affichés), distincte de la base d'API.
function webBase(cfg) {
  const raw = String(cfg.github_url || '').trim().replace(/\/+$/, '');
  return raw || DEFAULT_HOST;
}

function isConfigured(cfg) {
  return !!(cfg && cfg.github_token);
}

/* Appel API. `pathAndQuery` est relatif à la base, ou une URL absolue (pagination :
   le header Link renvoie des URLs complètes). Renvoie { data, headers }. */
async function githubFetchRaw(cfg, pathAndQuery, opts = {}) {
  if (!cfg.github_token) throw new Error(t('err.token-github-non-configure'));
  const url = /^https?:\/\//.test(pathAndQuery) ? pathAndQuery : `${apiBase(cfg)}${pathAndQuery}`;
  let res;
  try {
    res = await request(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${cfg.github_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // OBLIGATOIRE : sans User-Agent, l'API GitHub répond 403 sur toute requête.
        'User-Agent': 'mergerie',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
  } catch (e) {
    const code = (e && e.code) || '';
    const detail = (e && e.message) || String(e);
    throw new Error(t('err.github-connection', { code: code || t('err.network'), url: webBase(cfg), detail }));
  }
  if (res.status < 200 || res.status >= 300) {
    // Un quota épuisé se présente comme un 403 : le dire, plutôt que « token invalide ».
    const remaining = res.headers['x-ratelimit-remaining'];
    if (res.status === 403 && String(remaining) === '0') {
      const reset = Number(res.headers['x-ratelimit-reset'] || 0);
      const at = reset ? new Date(reset * 1000).toISOString().slice(11, 16) : '?';
      throw new Error(t('err.github-rate-limit', { at }));
    }
    throw new Error(t('err.github-http', {
      status: res.status, statusText: res.statusText, path: pathAndQuery,
      body: String(res.body).slice(0, 300),
    }));
  }
  if (res.status === 204 || !res.body) return { data: null, headers: res.headers };
  try { return { data: JSON.parse(res.body), headers: res.headers }; }
  catch { throw new Error(t('err.github-not-json', { path: pathAndQuery, body: String(res.body).slice(0, 200) })); }
}

async function githubFetch(cfg, pathAndQuery, opts = {}) {
  return (await githubFetchRaw(cfg, pathAndQuery, opts)).data;
}

/* Pagination GitHub : le header `Link` porte l'URL suivante (`rel="next"`).
   Il n'y a pas de compteur de pages comme chez GitLab — on suit les liens. */
function nextLink(headers) {
  const link = headers && headers.link;
  if (!link) return null;
  for (const part of String(link).split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

async function fetchAllPages(cfg, path, { max = 50 } = {}) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  let url = `${path}${sep}per_page=100`;
  for (let i = 0; i < max && url; i += 1) {
    const { data, headers } = await githubFetchRaw(cfg, url);
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data);
    url = nextLink(headers);
  }
  return out;
}

/* ---------- Normalisations PR → MR ---------- */

// GitHub dit `closed` pour une PR mergée : le reste du code teste `state === 'merged'`.
function mrState(pr) {
  if (pr.merged || pr.merged_at) return 'merged';
  return pr.state === 'open' ? 'opened' : 'closed';
}

function toMr(pr) {
  return {
    iid: pr.number,
    title: pr.title,
    state: mrState(pr),
    source_branch: pr.head && pr.head.ref,
    target_branch: pr.base && pr.base.ref,
    web_url: pr.html_url,
    sha: pr.head && pr.head.sha,
    created_at: pr.created_at,
    merged_at: pr.merged_at || null,
    author: pr.user ? (pr.user.login || '') : '',
    /* CONFLITS. `mergeable` est calculé de façon ASYNCHRONE par GitHub : il vaut `null` tant
       que le calcul n'a pas tourné, et il n'est renvoyé que par la route d'une PR unique —
       jamais par la liste. On rend donc trois valeurs et pas deux : `true` (conflits), `false`
       (aucun), `null` (on ne sait pas encore). Confondre « on ne sait pas » avec « non »
       ferait disparaître le bouton précisément quand il sert. */
    has_conflicts: pr.mergeable === false || pr.mergeable_state === 'dirty' ? true
      : (pr.mergeable === true ? false : null),
    // Équivalent des diff_refs GitLab : seul head_sha est requis (commentaire inline).
    diff_refs: {
      base_sha: (pr.base && pr.base.sha) || null,
      start_sha: (pr.base && pr.base.sha) || null,
      head_sha: (pr.head && pr.head.sha) || null,
    },
  };
}

/* ---------- Merge requests (pull requests) ---------- */

async function listOpenMRs(cfg, project, pattern) {
  const items = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/pulls?state=open`);
  const p = (pattern || '').trim();
  return items
    .filter((pr) => !p || ((pr.head && pr.head.ref) || '').includes(p))
    .map((pr) => {
      const m = toMr(pr);
      return {
        iid: m.iid, title: m.title, source_branch: m.source_branch, target_branch: m.target_branch,
        web_url: m.web_url, sha: m.sha, created_at: m.created_at, author: m.author,
      };
    });
}

async function getMergeRequest(cfg, project, iid) {
  return toMr(await githubFetch(cfg, `/repos/${encodeProject(project)}/pulls/${iid}`));
}

async function listAllMRs(cfg, project) {
  const items = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/pulls?state=all&sort=updated&direction=desc`);
  return items.map((pr) => ({
    iid: pr.number, state: mrState(pr),
    source_branch: pr.head && pr.head.ref, target_branch: pr.base && pr.base.ref,
    merged_at: pr.merged_at, web_url: pr.html_url, title: pr.title,
  }));
}

/* Création d'une PR. ⚠ Contrairement à GitLab, l'API GitHub n'accepte NI le squash NI
   la suppression de la branche à la création : ce sont des décisions de merge. Les deux
   options éventuellement choisies ici sont donc mémorisées côté application (table `mr`)
   et appliquées au moment du merge. */
async function createMergeRequest(cfg, project, { source_branch, target_branch, title }) {
  const pr = await githubFetch(cfg, `/repos/${encodeProject(project)}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ head: source_branch, base: target_branch, title }),
  });
  return toMr(pr);
}

/* Merge. GitHub renvoie `{ merged, message }` et NON la PR : on relit la PR pour
   rendre l'état normalisé que l'appelant teste (`state === 'merged'`).

   Les deux options du merge n'ont PAS la même forme que chez GitLab :
   - « squash » est une MÉTHODE de merge (`merge_method`), pas un drapeau ;
   - la suppression de la branche source n'existe pas dans l'API de merge : c'est un
     appel séparé, fait APRÈS coup et en best-effort (un merge réussi ne doit pas être
     signalé en échec parce que la branche n'a pas pu être supprimée). */
async function mergeMergeRequest(cfg, project, iid, opts = {}) {
  const enc = encodeProject(project);
  const body = opts.squash ? { merge_method: 'squash' } : {};
  await githubFetch(cfg, `/repos/${enc}/pulls/${iid}/merge`, { method: 'PUT', body: JSON.stringify(body) });
  const mr = await getMergeRequest(cfg, project, iid);
  if (opts.removeSourceBranch && mr && mr.state === 'merged' && mr.source_branch) {
    try { await deleteBranch(cfg, project, mr.source_branch); }
    catch { /* branche protégée ou déjà supprimée : le merge, lui, a bien eu lieu */ }
  }
  return mr;
}

// Fichiers modifiés par une PR (badge « risque » + règles par chemin).
async function listMrChangedPaths(cfg, project, iid) {
  const files = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/pulls/${iid}/files`);
  const out = [];
  for (const f of files) {
    if (f.filename) out.push(f.filename);
    if (f.previous_filename) out.push(f.previous_filename);   // renommage : les deux chemins comptent
  }
  return [...new Set(out)];
}

/* ---------- Commentaires ----------
   GitLab a UN concept (discussion = fil de notes, inline si `position`).
   GitHub en a DEUX : les issue comments (généraux) et les review comments (inline,
   chaînés par `in_reply_to_id`). On reconstruit la forme GitLab :
   - un issue comment devient un fil d'une seule note, sans position, d'id `issue-<id>` ;
   - les review comments sont groupés par racine, l'id du fil est celui de la racine.
   Le préfixe `issue-` permet à replyToDiscussion de savoir sur quelle API répondre. */

function toNote(c, position) {
  const login = (c.user && c.user.login) || '';
  return {
    id: c.id,
    body: c.body,
    system: false,                       // pas d'équivalent des notes système GitLab
    created_at: c.created_at,
    resolved: false,                     // l'état « résolu » n'existe qu'en GraphQL
    // `username` autant que `name` : c'est sur lui que se compare l'auteur d'un
    // commentaire au compte du jeton, comme côté GitLab.
    author: { name: login, username: login },
    position: position || null,
  };
}

// Position GitHub → position GitLab (le front lit new_path/old_path/new_line/old_line).
function toPosition(c) {
  if (!c.path) return null;
  const onLeft = c.side === 'LEFT';
  const line = c.line != null ? c.line : c.original_line;
  return {
    new_path: onLeft ? null : c.path,
    old_path: onLeft ? c.path : null,
    new_line: onLeft ? null : (line != null ? line : null),
    old_line: onLeft ? (line != null ? line : null) : null,
  };
}

async function listMrDiscussions(cfg, project, iid) {
  const enc = encodeProject(project);
  const [review, general] = await Promise.all([
    fetchAllPages(cfg, `/repos/${enc}/pulls/${iid}/comments`),
    fetchAllPages(cfg, `/repos/${enc}/issues/${iid}/comments`),
  ]);
  const threads = new Map();            // id de racine -> discussion
  const order = [];
  for (const c of review) {
    const rootId = c.in_reply_to_id || c.id;
    if (!threads.has(rootId)) { threads.set(rootId, { id: String(rootId), notes: [] }); order.push(rootId); }
    threads.get(rootId).notes.push(toNote(c, toPosition(c)));
  }
  const out = order.map((id) => threads.get(id));
  for (const c of general) out.push({ id: `issue-${c.id}`, notes: [toNote(c, null)] });
  return out;
}

// Commentaire général de MR = issue comment.
async function postMrNote(cfg, project, iid, body) {
  return githubFetch(cfg, `/repos/${encodeProject(project)}/issues/${iid}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

/* Commentaire inline. GitHub veut commit_id + path + line + side, là où GitLab veut
   une `position` complète : on dérive l'un de l'autre. Sans position → issue comment. */
async function postMrDiscussion(cfg, project, iid, body, position) {
  const enc = encodeProject(project);
  if (!position) return postMrNote(cfg, project, iid, body);
  const onLeft = position.new_line == null && position.old_line != null;
  const payload = {
    body,
    commit_id: position.head_sha,
    path: onLeft ? (position.old_path || position.new_path) : (position.new_path || position.old_path),
    side: onLeft ? 'LEFT' : 'RIGHT',
    line: Number(onLeft ? position.old_line : position.new_line),
  };
  const c = await githubFetch(cfg, `/repos/${enc}/pulls/${iid}/comments`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  return { id: String(c.id), notes: [toNote(c, toPosition(c))] };
}

/* Modifie un commentaire déjà posté. GitHub range les commentaires de review (inline) et
   ceux d'issue (généraux) sous deux ressources distinctes, avec des identifiants de
   familles différentes : il faut savoir laquelle viser. GitLab, lui, n'a qu'une route —
   d'où ce paramètre présent dans le contrat commun mais ignoré là-bas. */
async function updateNote(cfg, project, iid, noteId, body, opts = {}) {
  const enc = encodeProject(project);
  const kind = opts.inline ? 'pulls' : 'issues';
  return githubFetch(cfg, `/repos/${enc}/${kind}/comments/${encodeURIComponent(noteId)}`, {
    method: 'PATCH', body: JSON.stringify({ body }),
  });
}

// Compte associé au jeton — sert à savoir quels commentaires sont les miens.
async function currentUser(cfg) {
  const u = await githubFetch(cfg, '/user');
  return { username: (u && u.login) || '' };
}

// Réponse à un fil : `discussionId` est l'id de la note RACINE (ou `issue-<id>`).
async function replyToDiscussion(cfg, project, iid, discussionId, body) {
  const enc = encodeProject(project);
  const id = String(discussionId || '');
  if (id.startsWith('issue-')) return postMrNote(cfg, project, iid, body);
  return githubFetch(cfg, `/repos/${enc}/pulls/${iid}/comments/${encodeURIComponent(id)}/replies`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

/* ---------- Dépôts, branches, commits ---------- */

async function listAccessibleProjects(cfg) {
  const items = await fetchAllPages(cfg, '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member');
  return items.map((r) => ({
    id: r.id,
    project: r.full_name,
    name: r.full_name,
    url: r.clone_url,
    ssh_url: r.ssh_url,
  }));
}

async function defaultBranch(cfg, project) {
  const r = await githubFetch(cfg, `/repos/${encodeProject(project)}`);
  return (r && r.default_branch) || null;
}

async function listBranches(cfg, project) {
  const enc = encodeProject(project);
  const [items, def] = await Promise.all([
    fetchAllPages(cfg, `/repos/${enc}/branches`),
    defaultBranch(cfg, project).catch(() => null),
  ]);
  return { branches: items.map((b) => b.name), default: def };
}

// Branches AVEC leur SHA de tête (aperçu et restauration de l'onglet Git).
async function listBranchesFull(cfg, project) {
  const enc = encodeProject(project);
  const [items, def] = await Promise.all([
    fetchAllPages(cfg, `/repos/${enc}/branches`),
    defaultBranch(cfg, project).catch(() => null),
  ]);
  return items.map((b) => ({
    name: b.name,
    sha: b.commit && b.commit.sha,
    default: b.name === def,
    protected: !!b.protected,
    merged: false,                       // pas exposé par l'API branches
    committed_date: (b.commit && b.commit.commit && b.commit.commit.committer
      && b.commit.commit.committer.date) || null,
    author: (b.commit && b.commit.commit && b.commit.commit.author
      && b.commit.commit.author.name) || '',
  }));
}

/* Tags. `GET /tags` ne donne ni la date ni la nature (annoté ou non) — les obtenir
   coûterait un appel par tag. On renvoie donc le nom et le SHA du commit, ce dont
   dépendent l'aperçu, la suppression et la restauration ; la date reste vide. */
async function listTags(cfg, project) {
  const items = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/tags`);
  return items.map((x) => ({
    name: x.name,
    sha: x.commit && x.commit.sha,
    target: null,
    message: '',
    annotated: false,
    committed_date: null,
    author: '',
  }));
}

// Refs protégées : GitHub porte le drapeau sur la branche elle-même.
async function listProtectedBranches(cfg, project) {
  try {
    const items = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/branches?protected=true`);
    return items.map((b) => b.name);
  } catch { return []; }                 // droits insuffisants : on n'empêche pas l'aperçu
}

/* Tags protégés : l'API « tag protection » historique est retirée, remplacée par les
   rulesets. Best-effort — en cas d'échec on renvoie [] : GitHub refusera de toute
   façon la suppression côté serveur, et gitops journalise l'échec ligne par ligne. */
async function listProtectedTags(cfg, project) {
  try {
    const items = await fetchAllPages(cfg, `/repos/${encodeProject(project)}/rulesets`);
    const names = [];
    for (const rs of items) {
      const inc = (rs.conditions && rs.conditions.ref_name && rs.conditions.ref_name.include) || [];
      for (const ref of inc) {
        const m = /^refs\/tags\/(.+)$/.exec(String(ref));
        if (m) names.push(m[1]);
      }
    }
    return names;
  } catch { return []; }
}

// Dernier commit de la branche par défaut, rendu à la forme GitLab (dashboard).
// Normalise un commit GitHub vers la forme commune (celle de GitLab).
function versCommit(c) {
  if (!c) return null;
  const commit = c.commit || {};
  return {
    id: c.sha,
    short_id: String(c.sha || '').slice(0, 8),
    title: String(commit.message || '').split('\n')[0],
    author_name: (commit.author && commit.author.name) || (c.author && c.author.login) || '',
    committed_date: (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null,
    web_url: c.html_url || '',
  };
}

/* Dernier commit, TOUTES BRANCHES confondues.
 *
 * `/commits` ne connaît que la branche par défaut, et GitHub n'a pas d'équivalent du
 * `all=true` de GitLab. Les ÉVÉNEMENTS du dépôt, eux, portent les pushes de toutes les
 * branches : on y prend le plus récent, puis on relit le commit désigné pour disposer des
 * mêmes champs qu'ailleurs (lien web, date de commit).
 *
 * Deux limites assumées, d'où le repli : les événements expirent au bout de 90 jours, et
 * l'API peut être absente selon l'instance. Dans ces cas on retombe sur la branche par
 * défaut — une information partielle vaut mieux qu'une ligne absente du tableau. */
async function latestCommit(cfg, project) {
  const enc = encodeProject(project);
  try {
    const evts = await githubFetch(cfg, `/repos/${enc}/events?per_page=30`);
    const push = (Array.isArray(evts) ? evts : []).find((e) => e && e.type === 'PushEvent');
    const p = (push && push.payload) || {};
    const dernier = (p.commits || [])[(p.commits || []).length - 1];
    const sha = p.head || (dernier && dernier.sha);
    if (sha) {
      const c2 = versCommit(await githubFetch(cfg, `/repos/${enc}/commits/${encodeURIComponent(sha)}`));
      if (c2) return c2;
    }
  } catch { /* événements indisponibles : on retombe sur la branche par défaut */ }

  const items = await githubFetch(cfg, `/repos/${enc}/commits?per_page=1`);
  return versCommit(Array.isArray(items) && items.length ? items[0] : null);
}

/* Commits d'une PÉRIODE — pendant GitHub de `gitlab.commitsBetween`, même forme en sortie.

   Différence assumée : GitHub ne sait pas lister « toutes branches » en un appel. Il
   faudrait énumérer les branches puis paginer chacune — des dizaines d'appels par dépôt,
   pour un compte qui compterait plusieurs fois les commits partagés. On s'en tient donc à
   la branche par défaut, et l'écran le dit plutôt que de laisser croire à un compte complet. */
async function commitsBetween(cfg, project, sinceIso, untilIso, maxPages = 12) {
  const enc = encodeProject(project);
  const out = [];
  let partiel = false;
  for (let page = 1; ; page += 1) {
    if (page > maxPages) { partiel = true; break; }
    const q = `since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}&per_page=100&page=${page}`;
    const items = await githubFetch(cfg, `/repos/${enc}/commits?${q}`);
    if (!Array.isArray(items) || !items.length) break;
    for (const c of items) {
      const cm = (c && c.commit) || {};
      const auteur = (cm.author && (cm.author.email || cm.author.name)) || (c.author && c.author.login) || '';
      out.push({ date: (cm.author && cm.author.date) || (cm.committer && cm.committer.date) || null, author: auteur });
    }
    if (items.length < 100) break;
  }
  return { commits: out, partiel };
}

/* Une ref précise (branche ou tag), à la forme GitLab, ou null si absente (404).
   Pour un tag on résout la ref puis le commit pointé, afin d'exposer la même
   structure `{ commit: { id, short_id, committed_date, author_name } }`. */
async function getRef(cfg, project, kind, name) {
  const enc = encodeProject(project);
  try {
    if (kind === 'tag') {
      const ref = await githubFetch(cfg, `/repos/${enc}/git/ref/tags/${name.split('/').map(encodeURIComponent).join('/')}`);
      let sha = ref && ref.object && ref.object.sha;
      if (ref && ref.object && ref.object.type === 'tag') {
        const tagObj = await githubFetch(cfg, `/repos/${enc}/git/tags/${sha}`);   // tag annoté → commit pointé
        sha = (tagObj && tagObj.object && tagObj.object.sha) || sha;
      }
      if (!sha) return null;
      const c = await githubFetch(cfg, `/repos/${enc}/commits/${sha}`);
      return {
        name,
        commit: {
          id: c.sha,
          short_id: String(c.sha || '').slice(0, 8),
          committed_date: (c.commit && c.commit.committer && c.commit.committer.date) || null,
          author_name: (c.commit && c.commit.author && c.commit.author.name) || '',
        },
      };
    }
    const b = await githubFetch(cfg, `/repos/${enc}/branches/${name.split('/').map(encodeURIComponent).join('/')}`);
    return {
      name: b.name,
      commit: {
        id: b.commit && b.commit.sha,
        short_id: String((b.commit && b.commit.sha) || '').slice(0, 8),
        committed_date: (b.commit && b.commit.commit && b.commit.commit.committer
          && b.commit.commit.committer.date) || null,
        author_name: (b.commit && b.commit.commit && b.commit.commit.author
          && b.commit.commit.author.name) || '',
      },
    };
  } catch (e) {
    if (/\b404\b/.test(String(e && e.message))) return null;    // ref absente de ce dépôt
    throw e;
  }
}

/* ---------- Écritures sur les refs (onglet Git) ---------- */

// GitHub exige un SHA pour créer une ref, là où GitLab accepte un nom de branche.
async function resolveSha(cfg, project, ref) {
  const enc = encodeProject(project);
  const c = await githubFetch(cfg, `/repos/${enc}/commits/${encodeURIComponent(ref)}`);
  return c && c.sha;
}

async function createBranch(cfg, project, branch, ref) {
  const enc = encodeProject(project);
  const sha = /^[0-9a-f]{40}$/i.test(String(ref)) ? String(ref) : await resolveSha(cfg, project, ref);
  return githubFetch(cfg, `/repos/${enc}/git/refs`, {
    method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
}

async function deleteBranch(cfg, project, branch) {
  const enc = encodeProject(project);
  return githubFetch(cfg, `/repos/${enc}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
}

/* Tag. Avec message → objet de tag annoté puis la ref qui le pointe (deux appels,
   comme git le fait) ; sans message → ref directe sur le commit (tag léger). */
async function createTag(cfg, project, tag, ref, message) {
  const enc = encodeProject(project);
  const sha = /^[0-9a-f]{40}$/i.test(String(ref)) ? String(ref) : await resolveSha(cfg, project, ref);
  let target = sha;
  if (message && message.trim()) {
    const obj = await githubFetch(cfg, `/repos/${enc}/git/tags`, {
      method: 'POST',
      body: JSON.stringify({
        tag, message: message.trim(), object: sha, type: 'commit',
        tagger: { name: 'mergerie', email: 'noreply@mergerie.dev', date: new Date().toISOString() },
      }),
    });
    target = (obj && obj.sha) || sha;
  }
  return githubFetch(cfg, `/repos/${enc}/git/refs`, {
    method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: target }),
  });
}

async function deleteTag(cfg, project, tag) {
  const enc = encodeProject(project);
  return githubFetch(cfg, `/repos/${enc}/git/refs/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
}

// Validation de la connexion (bouton « Tester ») : renvoie le compte associé au token.
async function testConnection(cfg) {
  const u = await githubFetch(cfg, '/user');
  return { login: (u && u.login) || '' };
}

// URL web d'une ref (liens de l'onglet Git) — pendant de refUrl côté GitLab.
function refWebUrl(cfg, project, kind, name) {
  const seg = kind === 'tag' ? 'releases/tag' : 'tree';
  return `${webBase(cfg)}/${normalizeProject(project)}/${seg}/${encodeURIComponent(name)}`;
}

module.exports = {
  // mêmes noms que gitlab.js (contrat commun consommé via src/forge.js)
  listOpenMRs, postMrNote, encodeProject, normalizeProject, listAccessibleProjects, listBranches,
  updateNote, currentUser,
  latestCommit, commitsBetween, getRef, createMergeRequest, mergeMergeRequest, getMergeRequest, postMrDiscussion,
  listMrDiscussions, replyToDiscussion, listBranchesFull, listTags, listProtectedBranches,
  listProtectedTags, listMrChangedPaths, createBranch, deleteBranch, createTag, deleteTag, listAllMRs,
  // propres à GitHub
  isConfigured, testConnection, apiBase, webBase, refWebUrl,
};
