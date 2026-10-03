'use strict';
/* @mergerie/plugin-sdk — tester un plugin SANS lancer Mergerie.
 *
 * `createTestContext({ manifest })` rend un ctx EN MÉMOIRE : le même constructeur que le
 * serveur (`lib/contexte.js`), nourri de substituts — une base SQLite en mémoire avec le socle
 * des plugins, un bus, un dictionnaire, un registre, une horloge que le test avance à la main,
 * un client HTTP réel, des notifications collectées, un routeur qu'on appelle directement
 * (`http.call(method, path, { query, body })`) ou qu'on monte sur Express (`http.express()`).
 *
 * Ce que le test prouve avec ce ctx vaut pour le serveur : il n'y a pas de seconde API. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const contrat = require('./contract');
const { creerContexte, primitivesDe, SQL_SOCLE } = require('./lib/contexte');
const { creerBus } = require('./lib/bus');
const registreMod = require('./lib/registre');
const horlogeMod = require('./lib/horloge');
const manifeste = require('./lib/manifeste');
const schema = require('./lib/schema');
const dbplugin = require('./lib/dbplugin');

/* Un client HTTP(S) minimal, au même contrat que celui du cœur (`{ status, statusText, headers, body }`),
   avec la convention TLS `<NOM>_CA_CERT` / `<NOM>_INSECURE_TLS`. */
function requestNode(url, { method = 'GET', headers = {}, body, agent } = {}) {
  const https = require('https'); const http = require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const opts = { method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers };
    if (u.protocol === 'https:' && agent) opts.agent = agent;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', body: data, headers: res.headers || {} }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { const e = new Error('délai dépassé (30 s)'); e.code = 'ETIMEDOUT'; req.destroy(e); });
    if (body != null) req.write(body);
    req.end();
  });
}
function makeAgentFactory(caEnv, insecureEnv) {
  let agent; let fait = false;
  return () => {
    if (fait) return agent;
    fait = true;
    const https = require('https'); const fs = require('fs');
    if (process.env[caEnv]) agent = new https.Agent({ ca: fs.readFileSync(process.env[caEnv]) });
    else if (process.env[insecureEnv] === '1') agent = new https.Agent({ rejectUnauthorized: false });
    return agent;
  };
}

/** Un dictionnaire de test : `t` rend la clé quand elle manque, comme le moteur du cœur. */
function creerI18n(lang = 'fr') {
  const dict = { fr: {}, en: {} };
  let courante = lang;
  return {
    dict,
    getLang: () => courante,
    setLang: (l) => { courante = dict[l] ? l : 'fr'; },
    t: (key, params) => {
      let s = (dict[courante] || {})[key]; if (s == null) s = (dict.fr || {})[key]; if (s == null) return key;
      if (typeof s === 'object') s = params && Number(params.n) === 1 ? s.one : s.other;
      return String(s).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? params[k] : m));
    },
  };
}

/** Le routeur du ctx, appelable sans serveur. */
function creerHttp(sortie) {
  const trouver = (method, chemin) => {
    for (const r of sortie.routes) {
      if (r.method !== method.toUpperCase()) continue;
      const motif = new RegExp(`^${r.path.replace(/:[A-Za-z_]+/g, '([^/]+)')}$`);
      const m = chemin.match(motif);
      if (!m) continue;
      const noms = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map((x) => x[1]);
      const params = {}; noms.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { r, params };
    }
    return null;
  };
  return {
    routes: () => sortie.routes.map((r) => `${r.method} ${r.path}`),
    async call(method, chemin, { query = {}, body = {}, headers = {}, lang = 'fr' } = {}) {
      const [p, qs] = String(chemin).split('?');
      const q = { ...Object.fromEntries(new URLSearchParams(qs || '')), ...query };
      const t = trouver(method, p);
      if (!t) return { status: 404, body: { error: `route inconnue : ${method.toUpperCase()} ${p}` } };
      let statut = 200; let envoye = null; const entetes = {};
      const reply = {
        status: (n) => { statut = n; return reply; }, header: (k, v) => { entetes[k] = v; return reply; },
        json: (b, s) => { if (!envoye) envoye = { status: s || statut, body: b, headers: entetes }; return reply; },
        text: (s, st) => { if (!envoye) envoye = { status: st || statut, body: String(s), headers: entetes }; return reply; },
      };
      try {
        const v = await t.r.handler({ method: method.toUpperCase(), path: p, url: chemin, query: q, params: t.params, body, headers, lang }, reply);
        if (envoye) return envoye;
        return { status: statut, body: v === undefined || v === reply ? { ok: true } : v, headers: entetes };
      } catch (e) {
        return { status: Number.isInteger(e.status) ? e.status : 400, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
      }
    },
    /** Un routeur Express (si express est installé), montable sous le préfixe de son choix — pour supertest. */
    express() {
      // eslint-disable-next-line global-require
      const express = require('express');
      const router = express.Router();
      router.use(express.json());
      for (const r of sortie.routes) {
        router[r.method.toLowerCase()](r.path, (req, res) => {
          this.call(r.method, req.path, { query: req.query, body: req.body, headers: req.headers }).then((out) => res.status(out.status).json(out.body));
        });
      }
      return router;
    },
  };
}

/**
 * Un ctx en mémoire pour tester un plugin.
 * @param {object} [options]
 * @param {object} [options.manifest] le plugin.json (sinon lu dans `options.dir`)
 * @param {string} [options.dir] le dossier du plugin
 * @param {string[]} [options.permissions] remplace celles du manifeste
 * @param {object[]} [options.repos] les dépôts que `ctx.repos` rend
 * @param {object} [options.env] l'environnement que `ctx.env` lit
 * @param {boolean} [options.demo] ce que `ctx.demo.isDemo()` rend
 * @param {(m: string) => void} [options.log]
 */
function createTestContext(options = {}) {
  let m = options.manifest;
  if (!m && options.dir) { const lu = manifeste.lire(options.dir); if (!lu.ok) throw new Error(`manifeste invalide : ${lu.erreurs.join(' ; ')}`); m = lu.manifeste; }
  if (!m) m = { name: 'test-plugin', version: '0.0.0', apiVersion: contrat.API_VERSION, displayName: 'Test', description: 'ctx de test', main: 'index.js' };
  if (options.permissions) m = { ...m, permissions: options.permissions };
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(SQL_SOCLE);
  db.exec('CREATE TABLE IF NOT EXISTS repo (id INTEGER PRIMARY KEY, project TEXT, url TEXT, forge TEXT DEFAULT \'gitlab\', enabled INTEGER DEFAULT 1, fetch_mrs INTEGER DEFAULT 1)');
  for (const r of options.repos || []) db.prepare('INSERT INTO repo (id, project, url, forge, enabled, fetch_mrs) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.project, r.url || '', r.forge || 'gitlab', r.enabled === false ? 0 : 1, r.fetch_mrs === false ? 0 : 1);
  const journal = [];
  const log = options.log || ((msg) => journal.push(msg));
  const bus = creerBus({ log });
  const i18n = creerI18n(options.lang || 'fr');
  const registre = registreMod.creer();
  const horloge = horlogeMod.creer({ log });
  const notifications = [];
  const sortie = {};
  const ctx = creerContexte(m, {
    log, sortie, bus, i18n, registre, horloge,
    db: () => db,
    net: { request: options.request || requestNode, makeAgentFactory },
    notify: { push: (type, data) => notifications.push({ type, data, at: new Date().toISOString() }) },
    exec: {},
    dataDir: () => options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), `mergerie-plugin-${m.name}-`)),
    env: options.env || {},
    isDemo: () => !!options.demo,
  });
  horloge.demarrer({ demo: !!options.demo });
  return {
    ctx,
    db, bus, i18n, registre, horloge, log: journal, notifications, sortie,
    http: creerHttp(sortie),
    /** Joue toutes les tâches périodiques du plugin, une fois. */
    tick: () => horloge.tick(m.name),
    /** Les déclarations d'écran du plugin. */
    ui: () => registre.declarations(m.name),
    /** Les seeds de démo du plugin, jouées. */
    seed: async () => { for (const s of sortie.seeds) await s(ctx); return sortie.seeds.length; },
    /** Émet un événement du cœur vers le plugin (comme le serveur le ferait). */
    emit: (nom, payload) => bus.emit(nom, payload),
    /** Retire une ressource : abonnements, tâches, registre — ce que fait la désactivation. */
    close: () => { bus.offAll(m.name); horloge.arreterTout(m.name); registre.oublier(m.name); db.close(); },
  };
}

/** Active un plugin (dossier) sur un ctx de test et rend { ctx, instance, … }. */
async function activatePlugin(dir, options = {}) {
  const lu = manifeste.lire(dir);
  if (!lu.ok) throw new Error(`manifeste invalide : ${lu.erreurs.join(' ; ')}`);
  const t = createTestContext({ ...options, manifest: lu.manifeste });
  // eslint-disable-next-line global-require
  const instance = require(path.join(dir, lu.manifeste.main));
  await instance.activate(t.ctx);
  t.instance = instance;
  t.deactivate = async () => { if (typeof instance.deactivate === 'function') await instance.deactivate(); t.close(); };
  return t;
}

module.exports = {
  createTestContext, activatePlugin, primitivesDe,
  contract: contrat, API_VERSION: contrat.API_VERSION,
  validateManifest: manifeste.valider, readManifest: manifeste.lire,
  schema, dbplugin, createBus: creerBus,
};
