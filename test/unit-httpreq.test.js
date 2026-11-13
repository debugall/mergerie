'use strict';
/* `src/core/httpreq` derrière un proxy : une cible https passe par un tunnel CONNECT, dont la
   poignée de main TLS est attendue. Un certificat refusé (proxy d'entreprise qui signe lui-même,
   CA absente) est un rejet ordinaire — pas un `error` sans écouteur qui tuait le process. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-httpreq-'));

const CERT = path.join(__dirname, 'fixtures', 'tls', 'cert.pem');
const CLE = path.join(__dirname, 'fixtures', 'tls', 'cle.pem');

/* Un proxy HTTP qui ne sait que CONNECT : il note chaque tunnel demandé, relaie en TCP. */
function proxyConnect({ refuser = false } = {}) {
  const state = { tunnels: [] };
  const server = http.createServer((req, res) => { state.tunnels.push({ method: req.method }); res.writeHead(405); res.end(); });
  server.on('connect', (req, client, head) => {
    state.tunnels.push({ method: 'CONNECT', cible: req.url });
    if (refuser) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const [hote, port] = req.url.split(':');
    const amont = net.connect(Number(port), hote, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) amont.write(head);
      amont.pipe(client); client.pipe(amont);
    });
    // Un bout fermé ferme l'autre : `pipe` seul laisse la socket survivante en pause, jamais lue, jamais close.
    amont.on('close', () => client.destroy());
    client.on('close', () => amont.destroy());
    amont.on('error', () => {}); client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, state,
    // Les tunnels ouverts tiennent `close` en haleine : on les coupe d'abord.
    stop: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

describe('httpreq : cible https derrière un proxy', () => {
  let httpreq; let cible; let base; const hits = [];
  before(async () => {
    httpreq = require('../src/core/httpreq');
    cible = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(CLE) }, (req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((r) => cible.listen(0, '127.0.0.1', r));
    base = `https://localhost:${cible.address().port}`;
  });
  after(() => { cible.closeAllConnections(); return new Promise((r) => cible.close(() => r())); });

  test('la requête passe VRAIMENT par le tunnel CONNECT, avec la CA épinglée de la cible', async () => {
    const proxy = await proxyConnect();
    try {
      hits.length = 0;
      const r = await httpreq.request(`${base}/par-le-tunnel`, { proxy: proxy.url, tls: { ca: fs.readFileSync(CERT) } });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { ok: true, path: '/par-le-tunnel' });
      assert.deepEqual(proxy.state.tunnels, [{ method: 'CONNECT', cible: `localhost:${cible.address().port}` }], 'un tunnel, vers la cible');
      assert.deepEqual(hits, ['/par-le-tunnel'], 'la cible a reçu la requête');
    } finally { await proxy.stop(); }
  });

  test('un certificat refusé rejette la promesse — le process survit', async () => {
    const proxy = await proxyConnect();
    try {
      hits.length = 0;
      await assert.rejects(httpreq.request(`${base}/refuse`, { proxy: proxy.url }), (err) => /SELF_SIGNED|UNABLE_TO|CERT/.test(err.code || err.message));
      assert.equal(proxy.state.tunnels.length, 1, 'le tunnel a bien été ouvert');
      assert.deepEqual(hits, [], 'rien n’a atteint la cible');
      // Le process est encore là pour la requête suivante, en clair cette fois (dépannage).
      const r = await httpreq.request(`${base}/insecure`, { proxy: proxy.url, tls: { rejectUnauthorized: false } });
      assert.equal(r.status, 200);
    } finally { await proxy.stop(); }
  });

  test('un proxy qui refuse le CONNECT → EPROXY', async () => {
    const proxy = await proxyConnect({ refuser: true });
    try {
      await assert.rejects(httpreq.request(`${base}/x`, { proxy: proxy.url, tls: { ca: fs.readFileSync(CERT) } }), { code: 'EPROXY' });
    } finally { await proxy.stop(); }
  });

  test('une poignée de main qui ne vient pas est bornée par le délai', async () => {
    // Un « proxy » qui dit 200 au CONNECT puis se tait : TLS n’aboutira jamais.
    const tenues = []; const muet = http.createServer();
    muet.on('connect', (req, client) => { tenues.push(client); client.on('error', () => {}); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
    await new Promise((r) => muet.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(httpreq.request(`${base}/lent`, { proxy: `http://127.0.0.1:${muet.address().port}`, timeoutMs: 300 }), { code: 'ETIMEDOUT' });
    } finally { for (const c of tenues) c.destroy(); await new Promise((r) => muet.close(() => r())); }
  });
});
