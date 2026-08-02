'use strict';
/* Faux serveur GitLab + Jira pour les tests de bout en bout.

   L'application ne parle au monde extérieur que par ces deux API HTTP (et par git,
   couvert séparément avec de vrais dépôts locaux). En les remplaçant par un serveur
   local piloté par les tests, on exerce le VRAI client (gitlab.js / jira.js), la vraie
   pagination et la vraie gestion d'erreur — contrairement à un mock de module, qui
   ne prouverait rien du code réellement exécuté en production. */

const http = require('http');

// État mutable : chaque test le façonne avant d'appeler l'application.
function freshState() {
  return {
    token: 'test-token',
    projects: [],            // [{ id, path_with_namespace, name_with_namespace, http_url_to_repo, ssh_url_to_repo }]
    mrs: {},                 // project -> [mr]
    branches: {},            // project -> [{ name, default, protected, merged, commit:{ id, committed_date, author_name } }]
    commits: {},             // project -> [{ id, short_id, title, author_name, committed_date, web_url }] (le plus récent d'abord)
    tags: {},                // project -> [{ name, target, message, commit:{ id, committed_date } }]
    protectedBranches: {},   // project -> [name]
    protectedTags: {},       // project -> [name]
    discussions: {},         // `${project}!${iid}` -> [discussion]
    changes: {},             // `${project}!${iid}` -> [{ new_path }]
    jiraIssues: {},          // KEY -> { key, fields }
    calls: [],               // journal { method, path, body } pour les assertions
    fail: {},                // path fragment -> { status, body } pour forcer une erreur
    mergeRefuses: false,     // vrai = GitLab répond 200 sans merger (cas réel à couvrir)
    nextIid: 100,
    nextNoteId: 700,
  };
}

const state = freshState();

function reset() {
  Object.assign(state, freshState());
}

function json(res, status, payload) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Les projets arrivent encodés (grp%2Fapp) dans le chemin.
function projectOf(raw) {
  return decodeURIComponent(raw);
}

function handleGitlab(req, res, pathname, query, body) {
  const seg = pathname.replace(/^\/api\/v4/, '');
  if (req.headers['private-token'] !== state.token) {
    return json(res, 401, { message: '401 Unauthorized' });
  }
  // Panne forcée par le test (ex. dépôt inaccessible) — prioritaire sur tout le reste.
  for (const [frag, err] of Object.entries(state.fail)) {
    if (seg.includes(frag)) return json(res, err.status || 500, err.body || { message: 'boom' });
  }
  const page = Number(query.get('page') || 1);
  // Une seule page de résultats : la 2e est toujours vide (le client s'arrête dessus).
  const paged = (arr) => (page > 1 ? [] : arr);

  let m;
  // Compte associé au jeton — sert à savoir quels commentaires sont les miens.
  if (seg === '/user') return json(res, 200, { id: 1, username: 'testeur', name: 'Testeur' });
  // GET /projects (liste des projets accessibles)
  if (seg.startsWith('/projects?') || seg === '/projects') return json(res, 200, paged(state.projects));

  // /projects/:id/...
  m = /^\/projects\/([^/?]+)(\/[^?]*)?/.exec(seg);
  if (!m) return json(res, 404, { message: '404 Not Found' });
  const project = projectOf(m[1]);
  const rest = (m[2] || '').replace(/\?.*$/, '');

  const mrsOf = () => state.mrs[project] || [];
  const branchesOf = () => state.branches[project] || [];
  const tagsOf = () => state.tags[project] || [];
  const commitsOf = () => state.commits[project] || [];

  // --- Merge requests ---
  if (rest === '/merge_requests' && req.method === 'GET') {
    const wanted = query.get('state');
    const all = mrsOf().filter((x) => !wanted || wanted === 'all' || x.state === wanted);
    return json(res, 200, paged(all));
  }
  if (rest === '/merge_requests' && req.method === 'POST') {
    // GitLab refuse une 2e MR ouverte sur la même branche source (409). Le mock doit
    // le faire aussi, sinon un doublon passerait inaperçu ici et exploserait en prod.
    const dup = mrsOf().find((x) => x.state === 'opened' && x.source_branch === body.source_branch);
    if (dup) {
      return json(res, 409, { message: [`Another open merge request already exists for this source branch: !${dup.iid}`] });
    }
    const iid = state.nextIid++;
    const mr = {
      iid,
      title: body.title,
      state: 'opened',
      source_branch: body.source_branch,
      target_branch: body.target_branch,
      web_url: `https://gitlab.test/${project}/-/merge_requests/${iid}`,
      sha: `sha-${iid}`,
      created_at: new Date().toISOString(),
      author: { name: 'Testeur' },
      diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' },
    };
    (state.mrs[project] = state.mrs[project] || []).push(mr);
    return json(res, 201, mr);
  }
  m = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
  if (m) {
    const iid = Number(m[1]);
    const sub = m[2] || '';
    const mr = mrsOf().find((x) => x.iid === iid);
    if (!mr) return json(res, 404, { message: '404 Merge Request Not Found' });
    const key = `${project}!${iid}`;
    if (sub === '' && req.method === 'GET') return json(res, 200, mr);
    if (sub === '/merge' && req.method === 'PUT') {
      mr.state = state.mergeRefuses ? 'opened' : 'merged';
      return json(res, 200, mr);
    }
    if (sub === '/changes' && req.method === 'GET') {
      return json(res, 200, { ...mr, changes: state.changes[key] || [] });
    }
    if (sub === '/notes' && req.method === 'POST') {
      return json(res, 201, { id: 900 + (state.calls.length), body: body.body });
    }
    if (sub === '/discussions' && req.method === 'GET') {
      return json(res, 200, paged(state.discussions[key] || []));
    }
    if (sub === '/discussions' && req.method === 'POST') {
      const disc = {
        id: `disc-${(state.discussions[key] || []).length + 1}`,
        // id de note UNIQUE dans toute la MR : c'est lui que vise une modification.
        notes: [{ id: state.nextNoteId++, body: body.body, system: false, author: { name: 'Testeur', username: 'testeur' }, position: body.position || null }],
      };
      (state.discussions[key] = state.discussions[key] || []).push(disc);
      return json(res, 201, disc);
    }
    m = /^\/discussions\/([^/]+)\/notes$/.exec(sub);
    if (m && req.method === 'POST') {
      const disc = (state.discussions[key] || []).find((d) => d.id === decodeURIComponent(m[1]));
      if (!disc) return json(res, 404, { message: '404 Discussion Not Found' });
      const note = { id: state.nextNoteId++, body: body.body, system: false, author: { name: 'Testeur', username: 'testeur' } };
      disc.notes.push(note);
      return json(res, 201, note);
    }
    /* Modification d'une note : GitLab n'a qu'une route, quelle que soit la famille de
       commentaire — on cherche donc dans toutes les discussions de la MR. */
    m = /^\/notes\/([^/]+)$/.exec(sub);
    if (m && req.method === 'PUT') {
      for (const disc of state.discussions[key] || []) {
        const note = disc.notes.find((n) => String(n.id) === decodeURIComponent(m[1]));
        if (note) { note.body = body.body; return json(res, 200, note); }
      }
      return json(res, 404, { message: '404 Note Not Found' });
    }
    return json(res, 404, { message: '404 Not Found' });
  }

  // --- Commits (dernier commit d'un projet) ---
  if (rest === '/repository/commits' && req.method === 'GET') return json(res, 200, paged(commitsOf()));

  // --- Refs (branches / tags) ---
  if (rest === '/repository/branches' && req.method === 'GET') return json(res, 200, paged(branchesOf()));
  if (rest === '/repository/branches' && req.method === 'POST') {
    if (branchesOf().some((b) => b.name === body.branch)) return json(res, 400, { message: 'Branch already exists' });
    const src = branchesOf().find((b) => b.name === body.ref);
    const b = { name: body.branch, default: false, protected: false, merged: false, commit: { id: (src && src.commit.id) || body.ref } };
    (state.branches[project] = state.branches[project] || []).push(b);
    return json(res, 201, b);
  }
  m = /^\/repository\/branches\/(.+)$/.exec(rest);
  if (m && req.method === 'GET') {
    const b = branchesOf().find((x) => x.name === decodeURIComponent(m[1]));
    return b ? json(res, 200, b) : json(res, 404, { message: '404 Branch Not Found' });
  }
  if (m && req.method === 'DELETE') {
    const name = decodeURIComponent(m[1]);
    const list = state.branches[project] || [];
    const i = list.findIndex((b) => b.name === name);
    if (i === -1) return json(res, 404, { message: '404 Branch Not Found' });
    if ((state.protectedBranches[project] || []).includes(name)) return json(res, 403, { message: 'protected branch' });
    list.splice(i, 1);
    return json(res, 204, null);
  }
  if (rest === '/repository/tags' && req.method === 'GET') return json(res, 200, paged(tagsOf()));
  if (rest === '/repository/tags' && req.method === 'POST') {
    if (tagsOf().some((x) => x.name === body.tag_name)) return json(res, 400, { message: 'Tag already exists' });
    const src = branchesOf().find((b) => b.name === body.ref);
    const tag = {
      name: body.tag_name, target: `tagobj-${body.tag_name}`, message: body.message || '',
      commit: { id: (src && src.commit.id) || body.ref, committed_date: new Date().toISOString() },
    };
    (state.tags[project] = state.tags[project] || []).push(tag);
    return json(res, 201, tag);
  }
  m = /^\/repository\/tags\/(.+)$/.exec(rest);
  if (m && req.method === 'GET') {
    const tg = tagsOf().find((x) => x.name === decodeURIComponent(m[1]));
    return tg ? json(res, 200, tg) : json(res, 404, { message: '404 Tag Not Found' });
  }
  if (m && req.method === 'DELETE') {
    const name = decodeURIComponent(m[1]);
    const list = state.tags[project] || [];
    const i = list.findIndex((x) => x.name === name);
    if (i === -1) return json(res, 404, { message: '404 Tag Not Found' });
    list.splice(i, 1);
    return json(res, 204, null);
  }
  if (rest === '/protected_branches') return json(res, 200, paged((state.protectedBranches[project] || []).map((name) => ({ name }))));
  if (rest === '/protected_tags') return json(res, 200, paged((state.protectedTags[project] || []).map((name) => ({ name }))));

  return json(res, 404, { message: `404 Not Found (${rest})` });
}

/* Transitions proposées par le faux Jira. « En cours » est indispensable : c'est le seul
   état qui alimente le compteur du menu (catégorie `indeterminate`). */
const TRANSITIONS_MOCK = [
  { id: '21', name: 'En cours', to: { name: 'En cours', statusCategory: { key: 'indeterminate' } } },
  { id: '31', name: 'Terminé', to: { name: 'Terminé', statusCategory: { key: 'done' } } },
];

function handleJira(req, res, pathname, body = {}) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return json(res, 401, { errorMessages: ['unauthorized'] });
  // Utilisateur courant (pour cocher « moi » par défaut).
  if (pathname === '/rest/api/3/myself') return json(res, 200, { accountId: 'me-test', displayName: 'Testeur courant', avatarUrls: {} });
  /* Recherche. Le mock ne parle pas JQL, mais il en comprend les DEUX formes que le produit
     émet — `key IN (…)` (tickets surveillés) et `statusCategory = "In Progress"` (compteur du
     menu). Sans ça, un test de surveillance passerait quoi qu'on demande, et ne prouverait rien. */
  if (/^\/rest\/api\/3\/search/.test(pathname)) {
    const jql = String(new URL(req.url, 'http://localhost').searchParams.get('jql') || '');
    let issues = Object.values(state.jiraIssues);
    const keys = /key\s+IN\s*\(([^)]*)\)/i.exec(jql);
    if (keys) {
      const set = new Set(keys[1].split(',').map((k) => k.trim().replace(/^"|"$/g, '').toUpperCase()));
      issues = issues.filter((i) => set.has(String(i.key).toUpperCase()));
    }
    if (/statusCategory\s*=\s*"?In Progress"?/i.test(jql)) {
      issues = issues.filter((i) => i.fields && i.fields.status
        && i.fields.status.statusCategory && i.fields.status.statusCategory.key === 'indeterminate');
    }
    return json(res, 200, { issues, total: issues.length });
  }
  // Pièce jointe : métadonnées puis contenu binaire (proxy de téléchargement).
  const ac = /^\/rest\/api\/3\/attachment\/content\/(\d+)/.exec(pathname);
  if (ac) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`contenu-${ac[1]}`); return undefined; }
  const am = /^\/rest\/api\/3\/attachment\/(\d+)$/.exec(pathname);
  if (am) return json(res, 200, { id: am[1], filename: `fichier-${am[1]}.txt`, mimeType: 'text/plain', size: 12 });
  // Commentaires d'un ticket (avant /issue/:key, dont c'est un sous-chemin).
  const cm = /^\/rest\/api\/3\/issue\/([^/?]+)\/comment/.exec(pathname);
  if (cm) {
    if (req.method === 'POST') {
      // Commentaire créé : on renvoie un ADF simple (le vrai serveur renvoie le commentaire posté).
      return json(res, 201, { id: '99', author: { displayName: 'Testeur' }, created: '2026-07-25T12:00:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nouveau commentaire' }] }] } });
    }
    const issue = state.jiraIssues[decodeURIComponent(cm[1])];
    return json(res, 200, { comments: (issue && issue.comments) || [] });
  }
  // Transitions (changement d'état) : GET liste, POST applique (204).
  const tr = /^\/rest\/api\/3\/issue\/([^/?]+)\/transitions/.exec(pathname);
  if (tr) {
    if (req.method === 'POST') {
      /* Une transition APPLIQUE le nouvel état sur le ticket : sans ça, un test qui vérifie
         l'effet d'un changement d'état (statut de la liste, compteur du menu) passerait quoi
         qu'on fasse, et ne prouverait rien. */
      const demande = String((body.transition && body.transition.id) || '');
      const cible = TRANSITIONS_MOCK.find((x) => String(x.id) === demande);
      const issue = state.jiraIssues[decodeURIComponent(tr[1])];
      if (issue && cible) {
        issue.fields = issue.fields || {};
        issue.fields.status = { name: cible.to.name, statusCategory: { key: cible.to.statusCategory.key } };
      }
      res.writeHead(204); res.end(); return undefined;
    }
    return json(res, 200, { transitions: TRANSITIONS_MOCK });
  }
  const m = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(pathname);
  if (!m) return json(res, 404, { errorMessages: ['not found'] });
  const key = decodeURIComponent(m[1]);
  const issue = state.jiraIssues[key];
  if (!issue) return json(res, 404, { errorMessages: [`Issue ${key} does not exist`] });
  return json(res, 200, issue);
}

// Démarre le faux serveur sur un port libre. Renvoie { url, close }.
function start() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://localhost');
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      state.calls.push({ method: req.method, path: u.pathname + u.search, body });
      try {
        if (u.pathname.startsWith('/api/v4')) return handleGitlab(req, res, u.pathname, u.searchParams, body);
        if (u.pathname.startsWith('/rest/api')) return handleJira(req, res, u.pathname, body);
        return json(res, 404, { message: 'no route' });
      } catch (e) {
        return json(res, 500, { message: e.message });
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

module.exports = { start, state, reset };
