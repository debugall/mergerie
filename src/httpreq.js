'use strict';
/* Requête HTTP(S) bas niveau, partagée par les clients de forge (gitlab.js, github.js).

   L'agent TLS est fourni par l'appelant : chaque forge a le sien, calculé depuis ses
   propres variables d'environnement. On ne touche JAMAIS au TLS global du process. */

const https = require('https');
const http = require('http');
const fs = require('fs');

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

// Renvoie { status, statusText, body, headers }. `agent` s'applique au HTTPS seulement.
function request(url, { method = 'GET', headers = {}, body, agent } = {}) {
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
    if (u.protocol === 'https:' && agent) opts.agent = agent;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        statusText: res.statusMessage || '',
        body: data,
        headers: res.headers || {},
      }));
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const err = new Error(`délai dépassé après ${REQUEST_TIMEOUT_MS / 1000}s`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { request, makeAgentFactory, REQUEST_TIMEOUT_MS };
