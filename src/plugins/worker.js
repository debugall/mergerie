'use strict';
/* L'ENTRÉE D'UN WORKER DE PLUGIN TIERS : construit le ctx mandataire, charge `index.js` du
   plugin et répond à l'hôte (`hote-worker.js`). Le plugin reçoit ici EXACTEMENT la forme de ctx
   qu'un plugin embarqué reçoit en processus ; seule la frontière diffère.

   Le garde des `require` est posé avant de charger le plugin : un import qui remonterait vers
   `src/` échoue ici comme il échouerait en processus. */
const path = require('path');
const { parentPort, workerData, receiveMessageOnPort } = require('worker_threads');

const { dir, manifeste, sab, port, racine } = workerData;
const int32 = new Int32Array(sab);
const nom = manifeste.name;
const permissions = new Set(Array.isArray(manifeste.permissions) ? manifeste.permissions : []);

require(path.join(racine, 'src', 'plugins', 'garde-require.js')).surveiller(dir);

let seq = 0;
const handlers = { events: new Map(), schedules: new Map(), routes: new Map(), services: new Map(), settings: [], repos: [], palette: [], seeds: [] };
const attentesAsync = new Map();

/* ---------- Appels synchrones vers l'hôte ---------- */
function rpc(prim, args) {
  const id = ++seq;
  Atomics.store(int32, 0, 0);
  port.postMessage({ t: 'rpc', id, prim, args });
  for (;;) {
    Atomics.wait(int32, 0, 0, 30_000);
    const m = receiveMessageOnPort(port);
    if (!m) { if (Atomics.load(int32, 0) === 0) throw new Error(`${prim} : l'hôte n'a pas répondu`); continue; }
    const r = m.message;
    if (r.id !== id) continue;
    if (r.error) throw new Error(r.error);
    return r.value;
  }
}
function rpcAsync(prim, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    attentesAsync.set(id, { resolve, reject });
    parentPort.postMessage({ t: 'rpcAsync', id, prim, args });
  });
}

/* ---------- Le ctx mandataire ---------- */
const ctx = {
  name: nom, version: String(manifeste.version || ''), apiVersion: String(manifeste.apiVersion || '1'),
  log: (m, ...args) => parentPort.postMessage({ t: 'log', message: args.length ? `${m} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}` : String(m) }),
  i18n: { register: (l, d) => rpc('i18n.register', [l, d]), t: (k, p) => rpc('i18n.t', [k, p]), lang: () => rpc('i18n.lang', []) },
};
if (permissions.has('events')) {
  ctx.events = {
    on: (n, h) => { const id = ++seq; handlers.events.set(id, { name: n, h }); rpc('events.on', [id, n]); return () => { handlers.events.delete(id); rpc('events.off', [id]); }; },
    off: (n, h) => { for (const [id, e] of handlers.events) if (e.name === n && e.h === h) { handlers.events.delete(id); rpc('events.off', [id]); } },
    emit: (n, p) => rpcAsync('events.emit', [n, p]),
  };
}
if (permissions.has('settings')) {
  ctx.settings = {
    get: (k) => rpc('settings.get', [k]), set: (p) => rpc('settings.set', [p]), schema: () => rpc('settings.schema', []),
    onChange: (h) => { handlers.settings.push(h); if (handlers.settings.length === 1) rpc('settings.onChange', []); return () => { const i = handlers.settings.indexOf(h); if (i !== -1) handlers.settings.splice(i, 1); }; },
  };
}
if (permissions.has('secrets')) {
  ctx.secrets = { get: (k) => rpc('secrets.get', [k]), has: (k) => rpc('secrets.has', [k]), set: (k, v) => rpc('secrets.set', [k, v]), freshRequired: (...a) => rpc('secrets.freshRequired', a) };
}
if (permissions.has('db')) {
  const statement = (handle) => ({
    get: (...p) => rpc('db.stmt', [handle, 'get', p]),
    all: (...p) => rpc('db.stmt', [handle, 'all', p]),
    run: (...p) => rpc('db.stmt', [handle, 'run', p]),
    pluck: () => { rpc('db.stmt', [handle, 'pluck', []]); return statement(handle); },
    raw: () => { rpc('db.stmt', [handle, 'raw', []]); return statement(handle); },
  });
  ctx.db = {
    prefix: `plugin_${nom.replace(/-/g, '_')}_`,
    prepare: (sql) => statement(rpc('db.prepare', [sql]).handle),
    exec: (sql) => rpc('db.exec', [sql]),
    transaction: (fn) => fn(),      // une transaction ne traverse pas la frontière : chaque instruction est autonome
    tables: () => rpc('db.tables', []),
    classify: (t, f) => rpc('db.classify', [t, f]),
    migrate: (migrations) => {
      // Les fonctions `up` ne traversent pas : on les joue ici, en passant par le ctx mandataire.
      const sql = migrations.map((m) => (typeof m.up === 'function' ? { version: m.version, up: null } : m));
      let n = 0;
      const faites = new Set(rpc('db.appliedVersions', []));
      for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
        if (faites.has(m.version)) continue;
        if (typeof m.up === 'function') { m.up(ctx.db); rpc('db.markApplied', [m.version]); }
        else rpc('db.migrate', [[sql.find((x) => x.version === m.version)]]);
        n += 1;
      }
      return n;
    },
  };
}
if (permissions.has('http')) {
  const router = { routes: [] };
  for (const methode of ['get', 'post', 'put', 'delete', 'patch']) {
    router[methode] = (chemin, h) => { const id = ++seq; handlers.routes.set(id, h); rpc('http.route', [id, methode.toUpperCase(), chemin]); router.routes.push({ method: methode.toUpperCase(), path: chemin }); };
  }
  ctx.http = { router };
}
if (permissions.has('sse')) { ctx.http = ctx.http || {}; ctx.http.sse = () => { throw new Error(`${nom} : http.sse n'est pas disponible depuis un worker en V1`); }; }
if (permissions.has('schedule')) {
  ctx.schedule = (ms, fn, opts) => { const id = ++seq; handlers.schedules.set(id, fn); rpc('schedule', [id, ms, opts || {}]); return id; };
  ctx.unschedule = (id) => { handlers.schedules.delete(id); return rpc('unschedule', [id]); };
}
if (permissions.has('exec')) ctx.exec = (bin, args, opts) => rpcAsync('exec', [bin, args, opts]);
if (permissions.has('net')) ctx.net = { request: (url, opts) => rpcAsync('net.request', [url, opts]) };
if (permissions.has('repos')) {
  ctx.repos = {
    list: () => rpc('repos.list', []), byId: (id) => rpc('repos.byId', [id]),
    onRemoved: (h) => { handlers.repos.push(h); if (handlers.repos.length === 1) rpc('repos.onRemoved', []); return () => { const i = handlers.repos.indexOf(h); if (i !== -1) handlers.repos.splice(i, 1); }; },
  };
}
if (permissions.has('ui.tab') || permissions.has('ui.actions') || permissions.has('ui.palette')) ctx.ui = {};
if (permissions.has('ui.tab')) Object.assign(ctx.ui, { registerTab: (t) => rpc('ui.registerTab', [t]), registerSettingsTab: (t) => rpc('ui.registerSettingsTab', [t]), setBadge: (id, v) => rpc('ui.setBadge', [id, v]) });
if (permissions.has('ui.actions')) Object.assign(ctx.ui, { registerAction: (a) => rpc('ui.registerAction', [a]), registerDecorator: (d) => rpc('ui.registerDecorator', [d]), registerBriefSection: (s) => rpc('ui.registerBriefSection', [s]), registerLinkKind: (k) => rpc('ui.registerLinkKind', [k]) });
if (permissions.has('ui.palette')) ctx.ui.registerPaletteProvider = (fn) => { handlers.palette.push(fn); if (handlers.palette.length === 1) rpc('ui.registerPaletteProvider', []); };
if (permissions.has('notify')) ctx.notify = { registerKind: (k) => rpc('notify.registerKind', [k]), push: (t, d) => rpc('notify.push', [t, d]) };
if (permissions.has('demo')) ctx.demo = { isDemo: () => rpc('demo.isDemo', []), seed: (fn) => { handlers.seeds.push(fn); rpc('demo.seed', []); } };
if (permissions.has('env')) ctx.env = { get: (n) => rpc('env.get', [n]) };
if (permissions.has('services')) {
  ctx.services = {
    register: (n, fn) => { const id = ++seq; handlers.services.set(id, fn); rpc('services.register', [id, n]); },
    call: (n, p) => rpcAsync('services.call', [n, p]), has: (n) => rpc('services.has', [n]),
  };
}
Object.freeze(ctx);

/* ---------- Ce que l'hôte pousse ---------- */
let instance = null;
const repondre = (rid, value, error) => parentPort.postMessage({ t: 'reply', id: rid, value, error: error || null });

parentPort.on('message', async (m) => {
  try {
    switch (m.t) {
      case 'activate': {
        instance = require(path.join(dir, manifeste.main));
        if (typeof instance.activate !== 'function') throw new Error('index.js n’exporte pas activate(ctx)');
        await instance.activate(ctx);
        parentPort.postMessage({ t: 'activated' });
        break;
      }
      case 'deactivate': {
        try { if (instance && typeof instance.deactivate === 'function') await instance.deactivate(); } catch (e) { ctx.log(`deactivate : ${e.message}`); }
        parentPort.postMessage({ t: 'deactivated' });
        break;
      }
      case 'seed': {
        let n = 0;
        for (const s of handlers.seeds) { try { await s(ctx); n += 1; } catch (e) { ctx.log(`demo.seed : ${e.message}`); } }
        parentPort.postMessage({ t: 'seeded', n });
        break;
      }
      case 'event': {
        const h = handlers.events.get(m.id);
        try { if (h) await h.h(m.payload); repondre(m.rid, true); } catch (e) { repondre(m.rid, null, e.message); }
        break;
      }
      case 'tick': {
        const fn = handlers.schedules.get(m.id);
        try { if (fn) await fn(); repondre(m.rid, true); } catch (e) { repondre(m.rid, null, e.message); }
        break;
      }
      case 'http': {
        const h = handlers.routes.get(m.id);
        const reponse = { status: 200, headers: {}, kind: 'json', body: undefined };
        const reply = { status: (n) => { reponse.status = n; return reply; }, header: (k, v) => { reponse.headers[k] = v; return reply; }, json: (b, s) => { if (s) reponse.status = s; reponse.kind = 'json'; reponse.body = b; return reply; }, text: (s, st) => { if (st) reponse.status = st; reponse.kind = 'text'; reponse.body = String(s); return reply; } };
        try {
          const r = h ? await h(m.req, reply) : { error: 'route inconnue' };
          if (r !== undefined && r !== reply) reponse.body = r;
          repondre(m.rid, reponse);
        } catch (e) { repondre(m.rid, { status: Number.isInteger(e.status) ? e.status : 400, kind: 'json', body: { error: e.message } }); }
        break;
      }
      case 'service': {
        const fn = handlers.services.get(m.id);
        try { repondre(m.rid, fn ? await fn(m.payload) : null); } catch (e) { repondre(m.rid, null, e.message); }
        break;
      }
      case 'palette': {
        const out = [];
        for (const fn of handlers.palette) { try { out.push(...(await fn(m.q, m.limit) || [])); } catch (e) { ctx.log(`palette : ${e.message}`); } }
        repondre(m.rid, out);
        break;
      }
      case 'settingsChanged': for (const h of handlers.settings) { try { h(m.settings); } catch (e) { ctx.log(`settings.onChange : ${e.message}`); } } break;
      case 'repoRemoved': for (const h of handlers.repos) { try { h(m.repo); } catch (e) { ctx.log(`repos.onRemoved : ${e.message}`); } } break;
      case 'rpcAsyncResult': { const a = attentesAsync.get(m.id); if (a) { attentesAsync.delete(m.id); if (m.error) a.reject(new Error(m.error)); else a.resolve(m.value); } break; }
      default: break;
    }
  } catch (e) {
    if (m.t === 'activate') parentPort.postMessage({ t: 'activateError', message: (e && e.message) || String(e) });
    else ctx.log(`${m.t} : ${(e && e.message) || e}`);
  }
});

parentPort.postMessage({ t: 'ready' });
