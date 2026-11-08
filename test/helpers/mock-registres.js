'use strict';
/* UN FAUX REGISTRE POUR CHAQUE ÉCOSYSTÈME, sur un seul serveur HTTP local : les formes de réponse des
 * huit registres publics (npm, Packagist p2, PyPI, crates.io, RubyGems, proxy Go, Maven Central, NuGet
 * gzip), un 404 explicite, un chemin qui ne répond jamais, et le journal des requêtes reçues
 * (`hits`, avec leurs en-têtes) pour compter ce qui sort et vérifier le User-Agent. Un second serveur
 * joue le PROXY HTTP (`startProxy`) : il reçoit l'URL absolue, la relaie, et note ce qu'il a vu. */
const http = require('node:http');
const zlib = require('node:zlib');

const jours = (n) => new Date(Date.now() - n * 86400000).toISOString();

function start() {
  const state = { hits: [], hang: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.hits.push({ path: u.pathname + u.search, headers: req.headers });
    const json = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const p = u.pathname;
    if (p.startsWith('/hang')) { state.hang.push(res); return; }                       // ne répond jamais
    if (p.startsWith('/redirige')) { res.writeHead(302, { Location: 'http://exemple.invalid/ailleurs' }); res.end(); return; }
    if (p.startsWith('/casse')) { json(503, { error: 'maintenance' }); return; }
    // npm : GET /<name> (scope encodé %2F, décodé par l'URL)
    if (/^\/(@[^/]+\/)?[^/@]+$/.test(p) && !p.startsWith('/pypi') && !p.startsWith('/api') && !p.startsWith('/p2/') && !p.startsWith('/v3/') && !p.startsWith('/solrsearch')) {
      const name = decodeURIComponent(p.slice(1));
      if (name === 'left-pad' || name === '@acme/ui') return json(404, { error: 'Not found' });
      if (name === 'fastjson2') return json(200, { name, time: { created: jours(3), modified: jours(1), '2.0.1': jours(3) } });
      if (name === 'lodash') return json(200, { name, time: { created: '2012-04-23T16:37:11.912Z', modified: jours(10), '4.17.21': '2021-02-20T15:42:16.891Z' } });
      return json(200, { name, time: { created: jours(400), modified: jours(2), '1.0.0': jours(400) } });
    }
    // Packagist : GET /p2/<vendor>/<name>.json
    if (p.startsWith('/p2/')) {
      const name = p.slice(4).replace(/\.json$/, '');
      if (name === 'acme/inconnu') return json(404, {});
      return json(200, { packages: { [name]: [{ version: '7.8.0', time: jours(30) }, { version: '7.0.0', time: '2019-12-23T10:00:00+00:00' }, { version: 'dev-master', time: jours(1) }] } });
    }
    // PyPI : GET /pypi/<name>/json
    if (p.startsWith('/pypi/')) {
      const name = p.split('/')[2];
      if (name === 'inexistant') return json(404, { message: 'Not Found' });
      return json(200, { info: { name }, releases: { '6.0': [{ upload_time_iso_8601: '2021-10-13T18:00:00.000000Z' }], '5.0': [{ upload_time_iso_8601: '2018-03-13T18:00:00.000000Z' }] } });
    }
    // crates.io : GET /api/v1/crates/<name>
    if (p.startsWith('/api/v1/crates/')) {
      const name = p.split('/')[4];
      if (name === 'nope') return json(404, { errors: [{ detail: 'Not Found' }] });
      return json(200, { crate: { id: name, created_at: '2015-05-15T10:00:00.000000+00:00', updated_at: jours(5) } });
    }
    // RubyGems : GET /api/v1/versions/<name>.json
    if (p.startsWith('/api/v1/versions/')) {
      const name = p.split('/')[4].replace(/\.json$/, '');
      if (name === 'nope') { res.writeHead(404); res.end('This rubygem could not be found.'); return; }
      return json(200, [{ number: '7.1.0', created_at: jours(20) }, { number: '1.0.0', created_at: '2013-01-01T00:00:00.000Z' }]);
    }
    // Maven Central : GET /solrsearch/select?q=g:<g>+AND+a:<a>&core=gav&rows=…&wt=json
    if (p === '/solrsearch/select') {
      const q = u.searchParams.get('q') || '';
      if (/a:inconnu\b/.test(q)) return json(200, { response: { numFound: 0, docs: [] } });
      return json(200, { response: { numFound: 2, docs: [{ v: '2.0.0', timestamp: Date.now() - 10 * 86400000 }, { v: '1.0.0', timestamp: Date.parse('2017-06-01T00:00:00Z') }] } });
    }
    // NuGet : GET /v3/registration5-gz-semver2/<id>/index.json, servi en gzip
    if (p.startsWith('/v3/registration5-gz-semver2/')) {
      const id = p.split('/')[3];
      if (id === 'nope') return json(404, {});
      const corps = zlib.gzipSync(JSON.stringify({ items: [{ items: [{ catalogEntry: { version: '1.0.0', published: '2016-06-27T00:00:00Z' } }, { catalogEntry: { version: '13.0.3', published: jours(60) } }] }] }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(corps); return;
    }
    // Proxy Go : GET /<module>/@v/list puis /@v/<v>.info ; 410 pour un module parti
    if (p.includes('/@v/') || p.endsWith('/@latest')) {
      const module = p.split('/@')[0].slice(1);
      if (module === 'example.com/parti') { res.writeHead(410); res.end('gone'); return; }
      if (module === 'example.com/sanstag') {
        if (p.endsWith('/@v/list')) { res.writeHead(200); res.end(''); return; }
        return json(200, { Version: 'v0.0.0-20240101000000-abcdef', Time: jours(20) });
      }
      if (p.endsWith('/@v/list')) { res.writeHead(200); res.end('v1.2.0\nv1.0.0\nv1.10.0\n'); return; }
      const v = p.split('/@v/')[1].replace(/\.info$/, '');
      return json(200, { Version: v, Time: v === 'v1.0.0' ? '2019-09-03T12:00:00Z' : jours(12) });
    }
    json(404, { error: 'inconnu du faux registre' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base, state, server,
        /* `registry_urls` qui envoie les huit écosystèmes sur ce serveur. */
        urls: ['npm', 'composer', 'pypi', 'crates', 'rubygems', 'go', 'maven', 'nuget'].map((e) => `${e}=${base}`).join('\n'),
        reset: () => { state.hits.length = 0; },
        stop: () => new Promise((r) => { for (const res of state.hang) res.destroy(); server.close(() => r()); }),
      });
    });
  });
}

/* Un proxy HTTP en clair : la requête arrive avec son URL absolue, le proxy la relaie et note l'hôte visé. */
function startProxy() {
  const state = { hits: [] };
  const server = http.createServer((req, res) => {
    state.hits.push({ url: req.url, host: req.headers.host });
    let cible;
    try { cible = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const relais = http.request({ hostname: cible.hostname, port: cible.port, path: cible.pathname + cible.search, method: req.method, headers: { ...req.headers, host: cible.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    relais.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(relais);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`, state, server,
      stop: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

module.exports = { start, startProxy, jours };
