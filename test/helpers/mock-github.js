'use strict';
/* Faux serveur GitHub pour les tests de bout en bout.

   Même principe que mock-gitlab.js : on remplace l'API distante par un serveur local
   piloté par les tests, ce qui exerce le VRAI client (src/github.js) — sa pagination
   par header Link, ses en-têtes obligatoires, sa normalisation PR → MR. Un mock de
   module ne prouverait rien du code réellement exécuté en production. */

const http = require('http');

function freshState() {
  return {
    token: 'gh-test-token',
    repos: [],               // [{ id, full_name, clone_url, ssh_url, default_branch }]
    pulls: {},               // project -> [pr]
    branches: {},            // project -> [{ name, protected, commit:{ sha, commit:{...} } }]
    tags: {},                // project -> [{ name, commit:{ sha } }]
    commits: {},             // project -> [commit] (le plus récent d'abord)
    files: {},               // `${project}#${n}` -> [{ filename, previous_filename }]
    reviewComments: {},      // `${project}#${n}` -> [comment]
    issueComments: {},       // `${project}#${n}` -> [comment]
    rulesets: {},            // project -> [ruleset]
    calls: [],               // journal { method, path, body }
    fail: {},                // fragment de chemin -> { status, body }
    mergeRefuses: false,     // vrai = l'API accepte mais la PR reste ouverte
    // Vérifications d'en-têtes : le client DOIT les envoyer (403 sinon, en vrai).
    sawUserAgent: true,
    nextNumber: 100,
    nextId: 5000,
    // Taille de page : 1 force la pagination par header Link (2 pages au moins).
    perPage: 1,
  };
}

const state = freshState();
function reset() { Object.assign(state, freshState()); }

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload === null ? '' : JSON.stringify(payload));
}

/* Pagination GitHub : on renvoie une tranche + un header `Link` vers la suivante.
   C'est exactement ce que le client doit savoir suivre (pas de compteur de pages). */
function paged(res, req, query, arr) {
  const per = Math.min(Number(query.get('per_page') || 30), state.perPage || 100);
  const page = Number(query.get('page') || 1);
  const start = (page - 1) * per;
  const slice = arr.slice(start, start + per);
  const headers = { 'Content-Type': 'application/json' };
  if (start + per < arr.length) {
    const u = new URL(req.url, state.base);
    u.searchParams.set('page', String(page + 1));
    u.searchParams.set('per_page', String(per));
    headers.Link = `<${state.base}${u.pathname}${u.search}>; rel="next"`;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(slice));
}

const prState = (pr) => (pr.merged ? 'closed' : pr.state);

function handle(req, res, pathname, query, body) {
  // Authentification (Bearer) et User-Agent : sans lui, GitHub répond 403 en vrai.
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${state.token}`) return json(res, 401, { message: 'Bad credentials' });
  if (!req.headers['user-agent']) {
    state.sawUserAgent = false;
    return json(res, 403, { message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header.' });
  }
  for (const [frag, err] of Object.entries(state.fail)) {
    if (pathname.includes(frag)) return json(res, err.status || 500, err.body || { message: 'boom' });
  }

  if (pathname === '/user') return json(res, 200, { login: 'testeur', id: 1 });
  if (pathname === '/user/repos') return paged(res, req, query, state.repos);

  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return json(res, 404, { message: 'Not Found' });
  const project = `${m[1]}/${m[2]}`;
  const rest = m[3] || '';

  const pullsOf = () => state.pulls[project] || [];
  const branchesOf = () => state.branches[project] || [];
  const tagsOf = () => state.tags[project] || [];

  // --- Dépôt (branche par défaut) ---
  if (rest === '') {
    const r = state.repos.find((x) => x.full_name === project);
    return json(res, 200, r || { full_name: project, default_branch: 'main' });
  }

  // --- Pull requests ---
  if (rest === '/pulls' && req.method === 'GET') {
    const wanted = query.get('state') || 'open';
    const all = pullsOf().filter((p) => wanted === 'all' || prState(p) === wanted);
    return paged(res, req, query, all);
  }
  if (rest === '/pulls' && req.method === 'POST') {
    // GitHub refuse une 2e PR ouverte sur la même branche source (422).
    const dup = pullsOf().find((p) => p.state === 'open' && !p.merged && p.head.ref === body.head);
    if (dup) return json(res, 422, { message: `A pull request already exists for ${body.head}.` });
    const number = state.nextNumber++;
    const src = branchesOf().find((b) => b.name === body.head);
    const pr = {
      number, title: body.title, state: 'open', merged: false, merged_at: null,
      head: { ref: body.head, sha: (src && src.commit.sha) || `sha-${number}` },
      base: { ref: body.base, sha: 'base-sha' },
      html_url: `https://github.test/${project}/pull/${number}`,
      created_at: new Date().toISOString(),
      user: { login: 'testeur' },
    };
    (state.pulls[project] = state.pulls[project] || []).push(pr);
    return json(res, 201, pr);
  }
  let mm = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest);
  if (mm) {
    const number = Number(mm[1]);
    const sub = mm[2] || '';
    const pr = pullsOf().find((p) => p.number === number);
    if (!pr) return json(res, 404, { message: 'Not Found' });
    const key = `${project}#${number}`;
    if (sub === '' && req.method === 'GET') return json(res, 200, pr);
    if (sub === '/merge' && req.method === 'PUT') {
      if (!state.mergeRefuses) { pr.merged = true; pr.merged_at = new Date().toISOString(); pr.state = 'closed'; }
      return json(res, 200, { merged: !state.mergeRefuses, message: 'ok' });
    }
    if (sub === '/files' && req.method === 'GET') return paged(res, req, query, state.files[key] || []);
    if (sub === '/comments' && req.method === 'GET') return paged(res, req, query, state.reviewComments[key] || []);
    if (sub === '/comments' && req.method === 'POST') {
      const c = {
        id: state.nextId++, body: body.body, path: body.path, line: body.line,
        side: body.side || 'RIGHT', commit_id: body.commit_id,
        user: { login: 'testeur' }, created_at: new Date().toISOString(), in_reply_to_id: null,
      };
      (state.reviewComments[key] = state.reviewComments[key] || []).push(c);
      return json(res, 201, c);
    }
    mm = /^\/comments\/(\d+)\/replies$/.exec(sub);
    if (mm && req.method === 'POST') {
      const rootId = Number(mm[1]);
      const root = (state.reviewComments[key] || []).find((c) => c.id === rootId);
      if (!root) return json(res, 404, { message: 'Not Found' });
      const c = {
        id: state.nextId++, body: body.body, path: root.path, line: root.line, side: root.side,
        user: { login: 'testeur' }, created_at: new Date().toISOString(), in_reply_to_id: rootId,
      };
      state.reviewComments[key].push(c);
      return json(res, 201, c);
    }
    return json(res, 404, { message: 'Not Found' });
  }

  /* --- Modification d'un commentaire ---
     GitHub range les commentaires de review et ceux d'issue sous DEUX ressources
     distinctes, hors du chemin de la PR. Les deux sont mockées : c'est précisément
     l'aiguillage entre elles que le code doit faire correctement. */
  mm = /^\/pulls\/comments\/(\d+)$/.exec(rest);
  if (mm && req.method === 'PATCH') {
    const id = Number(mm[1]);
    for (const list of Object.values(state.reviewComments)) {
      const c = list.find((x) => x.id === id);
      if (c) { c.body = body.body; return json(res, 200, c); }
    }
    return json(res, 404, { message: 'Not Found' });
  }
  mm = /^\/issues\/comments\/(\d+)$/.exec(rest);
  if (mm && req.method === 'PATCH') {
    const id = Number(mm[1]);
    for (const list of Object.values(state.issueComments)) {
      const c = list.find((x) => x.id === id);
      if (c) { c.body = body.body; return json(res, 200, c); }
    }
    return json(res, 404, { message: 'Not Found' });
  }

  // --- Issue comments (commentaires généraux d'une PR) ---
  mm = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (mm) {
    const key = `${project}#${Number(mm[1])}`;
    if (req.method === 'GET') return paged(res, req, query, state.issueComments[key] || []);
    const c = { id: state.nextId++, body: body.body, user: { login: 'testeur' }, created_at: new Date().toISOString() };
    (state.issueComments[key] = state.issueComments[key] || []).push(c);
    return json(res, 201, c);
  }

  // --- Branches ---
  if (rest === '/branches' && req.method === 'GET') {
    const onlyProtected = query.get('protected') === 'true';
    return paged(res, req, query, branchesOf().filter((b) => !onlyProtected || b.protected));
  }
  mm = /^\/branches\/(.+)$/.exec(rest);
  if (mm && req.method === 'GET') {
    const b = branchesOf().find((x) => x.name === decodeURIComponent(mm[1]));
    return b ? json(res, 200, b) : json(res, 404, { message: 'Branch not found' });
  }

  // --- Tags / commits ---
  if (rest === '/tags' && req.method === 'GET') return paged(res, req, query, tagsOf());
  if (rest === '/commits' && req.method === 'GET') return json(res, 200, state.commits[project] || []);
  mm = /^\/commits\/(.+)$/.exec(rest);
  if (mm && req.method === 'GET') {
    const ref = decodeURIComponent(mm[1]);
    const b = branchesOf().find((x) => x.name === ref);
    const sha = b ? b.commit.sha : ref;
    const known = (state.commits[project] || []).find((c) => c.sha === sha);
    return json(res, 200, known || { sha, commit: { message: 'commit', author: { name: 'Testeur', date: null }, committer: { date: null } }, html_url: '' });
  }

  // --- Refs (écritures : branches et tags) ---
  if (rest === '/git/refs' && req.method === 'POST') {
    const ref = String(body.ref || '');
    let mb = /^refs\/heads\/(.+)$/.exec(ref);
    if (mb) {
      if (branchesOf().some((b) => b.name === mb[1])) return json(res, 422, { message: 'Reference already exists' });
      (state.branches[project] = state.branches[project] || []).push({ name: mb[1], protected: false, commit: { sha: body.sha, commit: {} } });
      return json(res, 201, { ref, object: { sha: body.sha } });
    }
    mb = /^refs\/tags\/(.+)$/.exec(ref);
    if (mb) {
      if (tagsOf().some((x) => x.name === mb[1])) return json(res, 422, { message: 'Reference already exists' });
      (state.tags[project] = state.tags[project] || []).push({ name: mb[1], commit: { sha: body.sha } });
      return json(res, 201, { ref, object: { sha: body.sha } });
    }
    return json(res, 422, { message: 'bad ref' });
  }
  if (rest === '/git/tags' && req.method === 'POST') {
    // Objet de tag annoté : renvoie son propre SHA (distinct du commit pointé).
    return json(res, 201, { sha: `tagobj-${body.tag}`, tag: body.tag, object: { sha: body.object, type: 'commit' } });
  }
  mm = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (mm && req.method === 'DELETE') {
    const name = decodeURIComponent(mm[1]);
    const list = state.branches[project] || [];
    const i = list.findIndex((b) => b.name === name);
    if (i === -1) return json(res, 422, { message: 'Reference does not exist' });
    if (list[i].protected) return json(res, 403, { message: 'Protected branch' });
    list.splice(i, 1);
    return json(res, 204, null);
  }
  mm = /^\/git\/refs\/tags\/(.+)$/.exec(rest);
  if (mm && req.method === 'DELETE') {
    const name = decodeURIComponent(mm[1]);
    const list = state.tags[project] || [];
    const i = list.findIndex((x) => x.name === name);
    if (i === -1) return json(res, 422, { message: 'Reference does not exist' });
    list.splice(i, 1);
    return json(res, 204, null);
  }
  mm = /^\/git\/ref\/tags\/(.+)$/.exec(rest);
  if (mm && req.method === 'GET') {
    const name = decodeURIComponent(mm[1]);
    const tg = tagsOf().find((x) => x.name === name);
    return tg ? json(res, 200, { ref: `refs/tags/${name}`, object: { sha: tg.commit.sha, type: 'commit' } })
      : json(res, 404, { message: 'Not Found' });
  }

  // --- Rulesets (tags protégés) ---
  if (rest === '/rulesets' && req.method === 'GET') return paged(res, req, query, state.rulesets[project] || []);

  return json(res, 404, { message: `Not Found (${rest})` });
}

function start() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, state.base || 'http://localhost');
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      state.calls.push({ method: req.method, path: u.pathname + u.search, body });
      // GitHub Enterprise sert l'API sous /api/v3 : c'est ce que construit le client
      // quand une URL d'instance est configurée (cas des tests).
      const pathname = u.pathname.replace(/^\/api\/v3/, '');
      try { return handle(req, res, pathname, u.searchParams, body); }
      catch (e) { return json(res, 500, { message: e.message }); }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${srv.address().port}`;
      state.base = url;
      resolve({ url, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

module.exports = { start, state, reset };
