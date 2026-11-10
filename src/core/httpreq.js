'use strict';
// @ts-check
/* Requête HTTP(S) bas niveau, partagée par les clients de forge (gitlab.js, github.js) et par le
   contrôle au registre (review/registre.js).

   L'agent TLS est fourni par l'appelant : chaque forge a le sien, calculé depuis ses
   propres variables d'environnement. On ne touche JAMAIS au TLS global du process. */

const https = require('https');
const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const { t } = require('./i18n');

// Plafond de patience sur une requête de forge : au-delà, on préfère une erreur claire
// à un job de fond bloqué indéfiniment (un serveur qui accepte la connexion sans jamais
// répondre — VPN qui tombe, proxy — gèlerait la file entière).
const REQUEST_TIMEOUT_MS = 30_000;

/* Agent TLS d'une forge : CA épinglé (propre) ou vérification désactivée (dépannage).
   `caEnv`/`insecureEnv` sont les NOMS des variables d'environnement, pour que le
   message d'avertissement nomme celle que l'utilisateur a réellement posée. */
function makeAgentFactory(caEnv, insecureEnv) {
  let computed = false;
  let agent; // undefined = agent par défaut (vérification TLS normale)
  return function tlsAgent() {
    if (computed) return agent;
    computed = true;
    const caPath = process.env[caEnv];
    if (caPath) {
      agent = new https.Agent({ ca: fs.readFileSync(caPath) });
    } else if (process.env[insecureEnv] === '1') {
      console.warn(`⚠️  ${insecureEnv}=1 : vérification TLS désactivée pour ces requêtes uniquement.`);
      agent = new https.Agent({ rejectUnauthorized: false });
    } else {
      agent = undefined;
    }
    return agent;
  };
}

/* LE PROXY DE L'ENVIRONNEMENT, pour une URL : `HTTPS_PROXY` pour une cible https, `HTTP_PROXY`
   pour une cible http, `ALL_PROXY` à défaut, en majuscules ou en minuscules — la convention de
   curl, de git et de Node. `NO_PROXY` l'écarte : `*` pour tout, sinon une liste d'hôtes ou de
   suffixes (`.corp.example`, `localhost`, `127.0.0.1`, `hôte:port`). Rend l'URL du proxy, ou null.
   @param {string} url
   @param {NodeJS.ProcessEnv} [env] */
function proxyDepuisEnv(url, env = process.env) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const lire = (...noms) => { for (const n of noms) { const v = env[n]; if (v && String(v).trim()) return String(v).trim(); } return ''; };
  const proxy = u.protocol === 'https:' ? lire('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy') : lire('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!proxy) return null;
  const sans = lire('NO_PROXY', 'no_proxy');
  if (sans) {
    const hote = u.hostname.toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    for (const brut of sans.split(',')) {
      const e = brut.trim().toLowerCase();
      if (!e) continue;
      if (e === '*') return null;
      const [eh, ep] = e.startsWith('[') ? [e, ''] : e.split(':');
      if (ep && ep !== port) continue;
      const h = eh.replace(/^\./, '');
      if (hote === h || hote.endsWith(`.${h}`)) return null;
    }
  }
  return proxy;
}

/* Le corps d'une réponse, décompressé si le serveur l'a compressé (NuGet sert du gzip d'office). */
function corpsDe(res, morceaux) {
  const brut = Buffer.concat(morceaux);
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(brut).toString('utf8');
    if (enc === 'deflate') return zlib.inflateSync(brut).toString('utf8');
    if (enc === 'br') return zlib.brotliDecompressSync(brut).toString('utf8');
  } catch { /* corps annoncé compressé mais illisible : rendu tel quel */ }
  return brut.toString('utf8');
}

/* Un tunnel CONNECT à travers un proxy, pour une cible https : la socket TLS rendue porte la
   vérification du certificat de la CIBLE (CA épinglée comprise), pas celle du proxy.
   @param {URL} proxy @param {URL} cible @param {import('node:tls').ConnectionOptions} tlsOpts @param {number} timeoutMs
   @returns {Promise<import('node:tls').TLSSocket>} */
function tunnel(proxy, cible, tlsOpts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = proxy.protocol === 'https:' ? https : http;
    const port = cible.port || 443;
    const headers = /** @type {Record<string, string>} */ ({ Host: `${cible.hostname}:${port}` });
    if (proxy.username) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64')}`;
    const req = lib.request({
      method: 'CONNECT', hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      path: `${cible.hostname}:${port}`, headers,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(Object.assign(new Error(`proxy CONNECT ${res.statusCode}`), { code: 'EPROXY' })); return; }
      // La poignée de main TLS se joue ICI, avant de rendre la socket : rendue nue, un certificat
      // refusé (proxy d'entreprise qui signe lui-même, CA absente) émettait `error` sur une socket
      // que personne n'écoutait encore — et Node tuait le process entier.
      const sec = tls.connect({ ...tlsOpts, socket, servername: cible.hostname });
      const echec = (err) => { sec.destroy(); reject(err); };
      sec.once('error', echec);
      sec.setTimeout(timeoutMs, () => echec(Object.assign(new Error(t('err.http.timeout', { s: timeoutMs / 1000 })), { code: 'ETIMEDOUT' })));
      sec.once('secureConnect', () => { sec.removeListener('error', echec); sec.setTimeout(0); resolve(sec); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(Object.assign(new Error(t('err.http.timeout', { s: timeoutMs / 1000 })), { code: 'ETIMEDOUT' })); });
    req.end();
  });
}

/**
 * Renvoie { status, statusText, body, headers }. `agent` s'applique au HTTPS seulement.
 * `proxy` (URL) fait passer la requête par un proxy HTTP — en clair pour une cible http, par un
 * tunnel CONNECT pour une cible https, `tls` portant alors la CA de la cible ; `timeoutMs` borne
 * l'attente (30 s par défaut).
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string|Buffer|null, agent?: import('node:https').Agent|undefined, proxy?: string|null, tls?: import('node:tls').ConnectionOptions, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, statusText: string, body: string, headers: import('node:http').IncomingHttpHeaders }>}
 */
async function request(url, { method = 'GET', headers = {}, body, agent, proxy = null, tls: tlsOpts = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const p = proxy ? new URL(proxy) : null;
  /** @type {import('node:http').RequestOptions} */
  const opts = { method, hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, headers: { ...headers } };
  let lib = secure ? https : http;
  if (p && !secure) {
    // Proxy en clair : la requête part au proxy, avec l'URL complète en chemin.
    lib = p.protocol === 'https:' ? https : http;
    opts.hostname = p.hostname; opts.port = p.port || (p.protocol === 'https:' ? 443 : 80);
    opts.path = u.href;
    opts.headers = { ...opts.headers, Host: u.host };
    if (p.username) opts.headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`).toString('base64')}`;
  } else if (p && secure) {
    const socket = await tunnel(p, u, tlsOpts, timeoutMs);
    // Pas d'`agent` du tout : avec `agent: false`, Node fabrique un agent neuf et IGNORE
    // `createConnection` — la requête partait alors en direct, le tunnel ouvert pour rien.
    opts.createConnection = () => socket;
  } else if (secure && agent) {
    opts.agent = agent;
  } else if (secure && (tlsOpts.ca || tlsOpts.rejectUnauthorized === false)) {
    Object.assign(opts, tlsOpts);
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      /** @type {Buffer[]} */
      const morceaux = [];
      res.on('data', (c) => { morceaux.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        statusText: res.statusMessage || '',
        body: corpsDe(res, morceaux),
        headers: res.headers || {},
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const err = /** @type {NodeJS.ErrnoException} */ (new Error(t('err.http.timeout', { s: timeoutMs / 1000 })));
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { request, makeAgentFactory, proxyDepuisEnv, REQUEST_TIMEOUT_MS };
