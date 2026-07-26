'use strict';
// Client minimal de l'API GitLab v4 (module natif https/http).
// La configuration TLS est SCOPÉE à ces requêtes via un agent dédié :
// on ne touche jamais au TLS global du process.

const https = require('https');
const http = require('http');
const fs = require('fs');
const { t } = require('../public/i18n-runtime.js');

// Agent TLS dédié aux requêtes GitLab (calculé une fois).
let _agentComputed = false;
let _agent; // undefined = agent par défaut (vérification TLS normale)
function gitlabAgent() {
  if (_agentComputed) return _agent;
  _agentComputed = true;
  const caPath = process.env.GITLAB_CA_CERT;
  if (caPath) {
    // Option propre : épingler le CA self-hosted (vérification TLS conservée).
    _agent = new https.Agent({ ca: fs.readFileSync(caPath) });
  } else if (process.env.GITLAB_INSECURE_TLS === '1') {
    // Repli explicite et LOCAL : vérif désactivée POUR GITLAB UNIQUEMENT.
    console.warn('⚠️  GITLAB_INSECURE_TLS=1 : vérification TLS désactivée pour les requêtes GitLab uniquement.');
    _agent = new https.Agent({ rejectUnauthorized: false });
  } else {
    _agent = undefined;
  }
  return _agent;
}

// Normalise un identifiant de projet vers le chemin attendu par l'API GitLab :
// accepte "group/projet", une URL de clone https, ssh, avec ou sans .git,
// espaces parasites, etc. -> "group/sous-groupe/projet".
function normalizeProject(project) {
  let p = String(project || '').trim();
  if (p.includes('://')) {
    // URL https -> on prend le pathname
    try { p = new URL(p).pathname; } catch { /* laisse tel quel */ }
  } else if (p.includes('@') && p.includes(':')) {
    // forme SSH git@host:group/projet.git -> partie après ':'
    p = p.slice(p.indexOf(':') + 1);
  }
  p = p.replace(/\.git$/i, '');       // enlève .git
  p = p.replace(/^\/+|\/+$/g, '');    // enlève slashs de début/fin
  return p.trim();
}

function encodeProject(project) {
  return encodeURIComponent(normalizeProject(project));
}

function apiBase(cfg) {
  if (!cfg.gitlab_url) throw new Error(t('err.url-gitlab-non-configuree-configuration'));
  return `${cfg.gitlab_url}/api/v4`;
}

// Plafond de patience sur une requête GitLab : au-delà, on préfère une erreur claire
// à un job de fond bloqué indéfiniment.
const REQUEST_TIMEOUT_MS = 30_000;

// Requête HTTPS bas niveau, agent TLS scopé. Renvoie { status, statusText, body }.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
    };
    if (u.protocol === 'https:') opts.agent = gitlabAgent();
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', body: data }));
    });
    req.on('error', reject);
    // Sans timeout, un GitLab qui accepte la connexion sans jamais répondre (VPN qui
    // tombe, proxy) gèle le job de fond ET toute la file derrière lui : seul un
    // redémarrage du serveur en sort. Le code ETIMEDOUT est déjà expliqué plus bas.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const err = new Error(`délai dépassé après ${REQUEST_TIMEOUT_MS / 1000}s`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

async function gitlabFetch(cfg, pathAndQuery, opts = {}) {
  if (!cfg.access_token) throw new Error(t('err.token-gitlab-non-configure-configuration'));
  const url = `${apiBase(cfg)}${pathAndQuery}`;
  let res;
  try {
    res = await request(url, {
      method: opts.method || 'GET',
      headers: {
        'PRIVATE-TOKEN': cfg.access_token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
  } catch (e) {
    // Erreur réseau/TLS -> surface la vraie cause plutôt qu'un "fetch failed".
    const code = e && e.code ? e.code : '';
    const detail = (e && e.message) || String(e);
    const hints = {
      ENOTFOUND: "hôte introuvable : vérifie l'URL GitLab (schéma https://, pas de /api/v4, pas de faute de frappe).",
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "CA d'entreprise inconnue de Node. Exporte le CA interne et lance avec GITLAB_CA_CERT=/chemin/ca.pem (recommandé), ou GITLAB_INSECURE_TLS=1 en dépannage.",
      UNABLE_TO_GET_ISSUER_CERT: "CA d'entreprise inconnue de Node. Fournis GITLAB_CA_CERT=/chemin/ca.pem, ou GITLAB_INSECURE_TLS=1 en dépannage.",
      CERT_UNTRUSTED: "certificat non fiable pour Node. Fournis GITLAB_CA_CERT=/chemin/ca.pem, ou GITLAB_INSECURE_TLS=1 en dépannage.",
      ECONNREFUSED: 'connexion refusée : mauvais port/URL, ou GitLab non accessible depuis cette machine (VPN ?).',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat TLS non vérifiable (GitLab self-hosted). Fournis GITLAB_CA_CERT ou relance avec GITLAB_INSECURE_TLS=1.',
      SELF_SIGNED_CERT_IN_CHAIN: 'certificat auto-signé (GitLab self-hosted). Fournis GITLAB_CA_CERT ou relance avec GITLAB_INSECURE_TLS=1.',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat auto-signé (GitLab self-hosted). Fournis GITLAB_CA_CERT ou relance avec GITLAB_INSECURE_TLS=1.',
      ETIMEDOUT: 'délai dépassé : GitLab injoignable (réseau/proxy/VPN).',
    };
    const hint = hints[code] || '';
    throw new Error(t('err.gitlab-connection', { code: code || t('err.network'), url: cfg.gitlab_url, detail }));
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(t('err.gitlab-http', { status: res.status, statusText: res.statusText, path: pathAndQuery, body: String(res.body).slice(0, 300) }));
  }
  if (res.status === 204 || !res.body) return null;
  try { return JSON.parse(res.body); }
  catch { throw new Error(t('err.gitlab-not-json', { path: pathAndQuery, body: String(res.body).slice(0, 200) })); }
}

// Liste les MR ouvertes d'un projet. Si `pattern` est vide -> toutes les MR,
// sinon uniquement celles dont source_branch contient `pattern`.
async function listOpenMRs(cfg, project, pattern) {
  const enc = encodeProject(project);
  const out = [];
  let page = 1;
  for (;;) {
    const items = await gitlabFetch(
      cfg,
      `/projects/${enc}/merge_requests?state=opened&per_page=100&page=${page}`,
    );
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 20) break; // garde-fou
  }
  const p = (pattern || '').trim();
  return out
    .filter((m) => !p || (m.source_branch || '').includes(p))
    .map((m) => ({
      iid: m.iid,
      title: m.title,
      source_branch: m.source_branch,
      target_branch: m.target_branch,
      web_url: m.web_url,
      sha: m.sha,
      created_at: m.created_at,
      author: m.author ? (m.author.name || m.author.username || '') : '',
    }));
}

// Liste tous les projets GitLab dont l'utilisateur est membre (accessibles).
async function listAccessibleProjects(cfg) {
  const out = [];
  let page = 1;
  for (;;) {
    const items = await gitlabFetch(
      cfg,
      `/projects?membership=true&simple=true&per_page=100&page=${page}&order_by=path&sort=asc`,
    );
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 50) break; // garde-fou (5000 projets max)
  }
  return out.map((p) => ({
    id: p.id,
    project: p.path_with_namespace,
    name: p.name_with_namespace || p.name,
    url: p.http_url_to_repo,
    ssh_url: p.ssh_url_to_repo,
  }));
}

// Liste les branches d'un projet (nom + branche par défaut).
// Une ref précise (branche ou tag) d'un projet. Renvoie l'objet GitLab, ou null si
// la ref n'existe pas (404). Toute autre erreur (accès, réseau) est propagée.
async function getRef(cfg, project, kind, name) {
  const enc = encodeProject(project);
  const seg = kind === 'tag' ? 'tags' : 'branches';
  try {
    return await gitlabFetch(cfg, `/projects/${enc}/repository/${seg}/${encodeURIComponent(name)}`);
  } catch (e) {
    if (/\b404\b/.test(String(e && e.message))) return null; // ref absente de ce dépôt
    throw e;
  }
}

// Dernier commit d'un projet (branche par défaut). Renvoie l'objet commit GitLab
// (id, short_id, title, author_name, committed_date, web_url) ou null si vide.
async function latestCommit(cfg, project) {
  const enc = encodeProject(project);
  const items = await gitlabFetch(cfg, `/projects/${enc}/repository/commits?per_page=1`);
  return Array.isArray(items) && items.length ? items[0] : null;
}

async function listBranches(cfg, project) {
  const enc = encodeProject(project);
  const out = [];
  let page = 1;
  for (;;) {
    const items = await gitlabFetch(cfg, `/projects/${enc}/repository/branches?per_page=100&page=${page}`);
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 50) break;
  }
  return {
    branches: out.map((b) => b.name),
    default: (out.find((b) => b.default) || {}).name || null,
  };
}

// Poste une note (commentaire niveau MR) et renvoie l'objet note.
async function postMrNote(cfg, project, iid, body) {
  const enc = encodeProject(project);
  return gitlabFetch(
    cfg,
    `/projects/${enc}/merge_requests/${iid}/notes`,
    { method: 'POST', body: JSON.stringify({ body }) },
  );
}

// Crée une merge request et renvoie l'objet MR (iid, web_url…).
async function createMergeRequest(cfg, project, { source_branch, target_branch, title }) {
  const enc = encodeProject(project);
  return gitlabFetch(cfg, `/projects/${enc}/merge_requests`, {
    method: 'POST',
    body: JSON.stringify({ source_branch, target_branch, title }),
  });
}

// Merge une merge request.
async function mergeMergeRequest(cfg, project, iid) {
  const enc = encodeProject(project);
  return gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}/merge`, { method: 'PUT' });
}

// Récupère une MR complète (pour ses diff_refs : base_sha, start_sha, head_sha).
async function getMergeRequest(cfg, project, iid) {
  const enc = encodeProject(project);
  return gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}`);
}

// Répond à une discussion existante (ajoute une note au fil).
async function replyToDiscussion(cfg, project, iid, discussionId, body) {
  const enc = encodeProject(project);
  return gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

// Liste toutes les discussions (commentaires) d'une MR.
async function listMrDiscussions(cfg, project, iid) {
  const enc = encodeProject(project);
  const out = [];
  let page = 1;
  for (;;) {
    const items = await gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}/discussions?per_page=100&page=${page}`);
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 50) break;
  }
  return out;
}

// Poste une discussion (commentaire) — inline si `position` est fournie.
async function postMrDiscussion(cfg, project, iid, body, position) {
  const enc = encodeProject(project);
  const payload = position ? { body, position } : { body };
  return gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}/discussions`, {
    method: 'POST', body: JSON.stringify(payload),
  });
}


/* ---------- Opérations sur les refs (onglet Git) ----------
   Les ÉCRITURES passent par l'API et non par le clone local : elles sont atomiques,
   il n'y a pas d'état local à synchroniser, et une ref protégée est refusée
   proprement par le serveur au lieu d'échouer au milieu d'un push. */

// Pagination générique — l'API GitLab plafonne à 100 éléments par page.
async function fetchAllPages(cfg, path) {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await gitlabFetch(cfg, `${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(items) || !items.length) break;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

// Branches AVEC leur SHA de tête : indispensable pour l'aperçu (on montre ce qu'on
// s'apprête à supprimer) et pour la restauration (on rejoue ce SHA).
async function listBranchesFull(cfg, project) {
  const items = await fetchAllPages(cfg, `/projects/${encodeProject(project)}/repository/branches`);
  return items.map((b) => ({
    name: b.name,
    sha: b.commit && b.commit.id,
    default: !!b.default,
    protected: !!b.protected,
    merged: !!b.merged,
    committed_date: b.commit && b.commit.committed_date,
    author: b.commit && b.commit.author_name,
  }));
}

async function listTags(cfg, project) {
  const items = await fetchAllPages(cfg, `/projects/${encodeProject(project)}/repository/tags`);
  return items.map((t) => ({
    name: t.name,
    // Pour un tag ANNOTÉ, l'objet tag et le commit ont deux SHA différents.
    // On garde les deux : restaurer avec le seul SHA de commit perdrait le message.
    sha: t.commit && t.commit.id,
    target: t.target,
    message: t.message || '',
    annotated: !!(t.message && t.message.trim()),
    committed_date: t.commit && t.commit.committed_date,
    // Auteur du commit pointé par le tag (donnée exposée par l'API tags).
    author: (t.commit && t.commit.author_name) || '',
  }));
}

// Refs protégées : on les connaît AVANT d'agir, pour que l'aperçu le dise
// plutôt que de laisser l'exécution échouer sur la moitié des dépôts.
async function listProtectedBranches(cfg, project) {
  try {
    const items = await fetchAllPages(cfg, `/projects/${encodeProject(project)}/protected_branches`);
    return items.map((b) => b.name);
  } catch { return []; }   // droits insuffisants : on n'empêche pas l'aperçu
}
async function listProtectedTags(cfg, project) {
  try {
    const items = await fetchAllPages(cfg, `/projects/${encodeProject(project)}/protected_tags`);
    return items.map((t) => t.name);
  } catch { return []; }
}

async function createBranch(cfg, project, branch, ref) {
  return gitlabFetch(cfg, `/projects/${encodeProject(project)}/repository/branches`, {
    method: 'POST',
    body: JSON.stringify({ branch, ref }),
  });
}
async function deleteBranch(cfg, project, branch) {
  return gitlabFetch(cfg, `/projects/${encodeProject(project)}/repository/branches/${encodeURIComponent(branch)}`, { method: 'DELETE' });
}
async function createTag(cfg, project, tag, ref, message) {
  const payload = { tag_name: tag, ref };
  if (message && message.trim()) payload.message = message.trim();   // tag annoté
  return gitlabFetch(cfg, `/projects/${encodeProject(project)}/repository/tags`, {
    method: 'POST', body: JSON.stringify(payload),
  });
}
async function deleteTag(cfg, project, tag) {
  return gitlabFetch(cfg, `/projects/${encodeProject(project)}/repository/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
}

// Merge requests d'un projet, tous états confondus : c'est la SEULE source
// certaine de « cette branche a été mergée dans X » (git ne l'enregistre pas).
// Chemins des fichiers modifiés par une MR (pour le badge « risque » et les règles
// par chemin). Endpoint /changes : le plus compatible entre versions de GitLab.
async function listMrChangedPaths(cfg, project, iid) {
  const enc = encodeProject(project);
  const data = await gitlabFetch(cfg, `/projects/${enc}/merge_requests/${iid}/changes`);
  const changes = (data && data.changes) || [];
  return [...new Set(changes.map((x) => x.new_path || x.old_path).filter(Boolean))];
}

async function listAllMRs(cfg, project) {
  const items = await fetchAllPages(cfg, `/projects/${encodeProject(project)}/merge_requests?state=all&order_by=updated_at`);
  return items.map((m) => ({
    iid: m.iid, state: m.state, source_branch: m.source_branch, target_branch: m.target_branch,
    merged_at: m.merged_at, web_url: m.web_url, title: m.title,
  }));
}

module.exports = { listOpenMRs, postMrNote, encodeProject, normalizeProject, listAccessibleProjects, listBranches, latestCommit, getRef, createMergeRequest, mergeMergeRequest, getMergeRequest, postMrDiscussion, listMrDiscussions, replyToDiscussion,
  listBranchesFull, listTags, listProtectedBranches, listProtectedTags, listMrChangedPaths,
  createBranch, deleteBranch, createTag, deleteTag, listAllMRs };
