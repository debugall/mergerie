'use strict';
/* L'HÔTE D'UN PLUGIN TIERS : un `worker_thread` par plugin, et le ctx réel de ce côté-ci.
 *
 * Le plugin ne voit qu'un MANDATAIRE de ctx (`worker.js`) : chaque appel traverse la frontière
 * par message. Deux voies :
 *   — SYNCHRONE, pour ce qui l'est dans l'API (`db.prepare(...).get()`, `settings.get()`,
 *     `secrets.get()`, les `register*`) : le worker poste la demande puis `Atomics.wait` sur un
 *     tampon partagé ; l'hôte répond sur un port dédié et réveille. Le code du plugin reste
 *     celui qu'il serait en processus — même API, même forme.
 *   — ASYNCHRONE, pour ce qui rend une promesse (`events.emit`, `net.request`, `exec`,
 *     `services.call`) : un identifiant, une promesse en attente, une réponse.
 * Dans l'autre sens, l'hôte pousse au worker ce qui le concerne : un événement auquel il est
 * abonné, un tic de tâche périodique, une requête HTTP sur une de ses routes, un service
 * demandé, un changement de réglages, la demande de semer la démo.
 *
 * Le crash du worker ne tue pas le serveur : il met le plugin « en erreur ». Un `activate()`
 * qui ne répond pas en 10 s est tué. Une requête HTTP sans réponse en 60 s rend 504. */
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const { creerContexte } = require('./contexte');

const DELAI_ACTIVATE_MS = 10_000;
const DELAI_HTTP_MS = 60_000;

/** Ce qui ne traverse pas une frontière : fonctions et handles. Une primitive qui en rend un est enveloppée ici. */
class HoteWorker {
  constructor(fiche, { log, sortie }) {
    this.fiche = fiche;
    this.nom = fiche.nom;
    this.log = log;
    this.sortie = sortie;
    this.ctx = creerContexte(fiche.manifeste, { log, sortie });
    this.worker = null;
    this.attentes = new Map();   // id → { resolve, reject } (réponses attendues DU worker)
    this.seq = 0;
    this.statements = new Map(); // handle → statement better-sqlite3
    this.stmtSeq = 0;
    this.tachesWorker = new Map(); // id local → id horloge
    this.relais = new Map();       // id local d'abonnement → { name, fn }
    this.mort = null;
  }

  /* ---------- Cycle de vie ---------- */
  activer() {
    const { port1, port2 } = new MessageChannel();
    this.portSync = port1;
    const sab = new SharedArrayBuffer(8);
    this.int32 = new Int32Array(sab);
    this.worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { dir: this.fiche.dir, manifeste: this.fiche.manifeste, sab, port: port2, racine: path.join(__dirname, '..', '..') },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', (m) => this.recevoir(m));
    this.worker.on('error', (e) => this.tomber(`worker : ${(e && e.message) || e}`));
    this.worker.on('exit', (code) => { if (code !== 0 && !this.mort) this.tomber(`worker arrêté (code ${code})`); });
    port1.on('message', (m) => this.recevoirSync(m));
    return this.attendre('activated', DELAI_ACTIVATE_MS, `activate() de ${this.nom} n'a pas répondu en ${DELAI_ACTIVATE_MS / 1000} s`)
      .catch((e) => { this.terminer(); throw e; });
  }
  desactiver() {
    if (!this.worker || this.mort) return Promise.resolve();
    this.worker.postMessage({ t: 'deactivate' });
    return this.attendre('deactivated', 5_000, 'deactivate() n’a pas répondu').finally(() => this.terminer());
  }
  terminer() {
    this.mort = this.mort || 'terminé';
    for (const [, a] of this.attentes) a.reject(new Error(`plugin ${this.nom} arrêté`));
    this.attentes.clear();
    this.statements.clear();
    if (this.worker) { try { this.worker.terminate(); } catch { /* déjà parti */ } }
    this.worker = null;
  }
  tomber(message) {
    if (this.mort) return;
    this.mort = message;
    this.log(`plugin tiers tombé : ${message}`);
    this.fiche.error = message; this.fiche.actif = false;
    this.terminer();
  }
  semer() {
    if (!this.worker) return Promise.resolve(0);
    this.worker.postMessage({ t: 'seed' });
    return this.attendre('seeded', 30_000, 'demo.seed n’a pas répondu').then((m) => m.n || 0);
  }

  /* ---------- Attentes ---------- */
  attendre(type, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.attentes.delete(type); reject(new Error(message)); }, ms);
      this.attentes.set(type, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }
  repondreAttente(type, valeur, erreur) {
    const a = this.attentes.get(type);
    if (!a) return;
    this.attentes.delete(type);
    if (erreur) a.reject(new Error(erreur)); else a.resolve(valeur);
  }

  /* ---------- Messages asynchrones venus du worker ---------- */
  recevoir(m) {
    switch (m.t) {
      case 'ready': if (this.worker) this.worker.postMessage({ t: 'activate' }); break;
      case 'activated': this.repondreAttente('activated', m); break;
      case 'activateError': this.repondreAttente('activated', null, m.message); break;
      case 'deactivated': this.repondreAttente('deactivated', m); break;
      case 'seeded': this.repondreAttente('seeded', m); break;
      case 'log': this.log(String(m.message)); break;
      case 'reply': this.repondreAttente(`reply:${m.id}`, m.value, m.error); break;
      case 'rpcAsync': this.rpcAsync(m); break;
      default: break;
    }
  }
  async rpcAsync(m) {
    let value; let error = null;
    try { value = await this.appeler(m.prim, m.args); } catch (e) { error = (e && e.message) || String(e); }
    if (this.worker) this.worker.postMessage({ t: 'rpcAsyncResult', id: m.id, value, error });
  }

  /* ---------- Les appels synchrones ---------- */
  recevoirSync(m) {
    if (m.t !== 'rpc') return;
    let value; let error = null;
    try { value = this.appeler(m.prim, m.args); if (value && typeof value.then === 'function') throw new Error(`${m.prim} rend une promesse : appel asynchrone attendu`); }
    catch (e) { error = (e && e.message) || String(e); }
    try { this.portSync.postMessage({ t: 'rpcResult', id: m.id, value, error }); }
    catch (e) { this.portSync.postMessage({ t: 'rpcResult', id: m.id, value: undefined, error: `résultat non sérialisable : ${e.message}` }); }
    Atomics.store(this.int32, 0, 1);
    Atomics.notify(this.int32, 0);
  }

  /** Une primitive du ctx réel, par son nom à plat (`settings.get`), avec les cas qui demandent une enveloppe. */
  appeler(prim, args) {
    const ctx = this.ctx;
    const nom = this.nom;
    switch (prim) {
      case 'db.prepare': {
        const stmt = ctx.db.prepare(args[0]);
        const h = ++this.stmtSeq;
        this.statements.set(h, stmt);
        if (this.statements.size > 500) { const premier = this.statements.keys().next().value; this.statements.delete(premier); }
        return { handle: h };
      }
      case 'db.stmt': {
        const stmt = this.statements.get(args[0]);
        if (!stmt) throw new Error('requête préparée inconnue (expirée ?)');
        const methode = args[1];
        if (!['get', 'all', 'run', 'pluck', 'raw'].includes(methode)) throw new Error(`statement.${methode} indisponible depuis un worker`);
        const r = stmt[methode](...(args[2] || []));
        if (methode === 'pluck' || methode === 'raw') return { handle: args[0] };
        return r;
      }
      case 'events.on': {
        // Le worker garde le handler ; ici un relais, qui attend que le worker ait fini.
        const id = args[0]; const evenement = args[1];
        const fn = (payload) => {
          if (!this.worker) return undefined;
          const rid = ++this.seq;
          this.worker.postMessage({ t: 'event', id, rid, name: evenement, payload });
          return this.attendre(`reply:${rid}`, 30_000, `handler de ${evenement} sans réponse`);
        };
        this.relais.set(id, { name: evenement, fn });
        ctx.events.on(evenement, fn);
        return true;
      }
      case 'events.off': {
        const r = this.relais.get(args[0]);
        if (r) { ctx.events.off(r.name, r.fn); this.relais.delete(args[0]); }
        return true;
      }
      case 'schedule': {
        const id = args[0];
        const idHorloge = ctx.schedule(args[1], () => {
          if (!this.worker) return undefined;
          const rid = ++this.seq;
          this.worker.postMessage({ t: 'tick', id, rid });
          return this.attendre(`reply:${rid}`, 10 * 60_000, 'tâche périodique sans réponse').catch((e) => this.log(e.message));
        }, args[2] || {});
        this.tachesWorker.set(id, idHorloge);
        return idHorloge;
      }
      case 'unschedule': return ctx.unschedule(this.tachesWorker.get(args[0]) || args[0]);
      case 'http.route': {
        const [id, method, chemin] = args;
        ctx.http.router[method.toLowerCase()](chemin, (req, reply) => {
          if (!this.worker) { reply.status(503); return { error: `plugin ${nom} arrêté` }; }
          const rid = ++this.seq;
          this.worker.postMessage({ t: 'http', id, rid, req: { method: req.method, path: req.path, url: req.url, query: req.query, params: req.params, body: req.body, headers: req.headers, lang: req.lang } });
          return this.attendre(`reply:${rid}`, DELAI_HTTP_MS, `plugin ${nom} : pas de réponse en ${DELAI_HTTP_MS / 1000} s`)
            .then((r) => { if (r && r.status) reply.status(r.status); for (const [k, v] of Object.entries((r && r.headers) || {})) reply.header(k, v); return r && r.kind === 'text' ? reply.text(r.body) : r.body; })
            .catch((e) => { reply.status(504); return { error: e.message }; });
        });
        return true;
      }
      case 'services.register': {
        const [id, nomService] = args;
        ctx.services.register(nomService, (payload) => {
          if (!this.worker) return Promise.reject(new Error(`plugin ${nom} arrêté`));
          const rid = ++this.seq;
          this.worker.postMessage({ t: 'service', id, rid, payload });
          return this.attendre(`reply:${rid}`, 30_000, `service ${nomService} sans réponse`);
        });
        return true;
      }
      case 'settings.onChange': {
        ctx.settings.onChange((s) => { if (this.worker) this.worker.postMessage({ t: 'settingsChanged', settings: s }); });
        return true;
      }
      case 'repos.onRemoved': {
        ctx.repos.onRemoved((repo) => { if (this.worker) this.worker.postMessage({ t: 'repoRemoved', repo }); });
        return true;
      }
      case 'ui.registerPaletteProvider': {
        ctx.ui.registerPaletteProvider((q, limite) => {
          if (!this.worker) return [];
          const rid = ++this.seq;
          this.worker.postMessage({ t: 'palette', rid, q, limit: limite });
          return this.attendre(`reply:${rid}`, 5_000, 'palette sans réponse');
        });
        return true;
      }
      case 'demo.seed': return true;   // le worker garde la fonction ; `semer()` la fera jouer
      case 'http.sse': throw new Error(`${nom} : http.sse n'est pas disponible depuis un worker en V1 (non éprouvé)`);
      default: {
        const [a, b] = prim.split('.');
        const cible = b ? (ctx[a] && ctx[a][b]) : ctx[a];
        if (typeof cible !== 'function') throw new Error(`primitive inconnue ou non permise : ${prim}`);
        return cible(...args);
      }
    }
  }
}

module.exports = { HoteWorker, DELAI_ACTIVATE_MS, DELAI_HTTP_MS };
