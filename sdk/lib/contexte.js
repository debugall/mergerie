'use strict';
/* LE CTX — ce qu'un plugin reçoit, et tout ce qu'il reçoit. Construit depuis le contrat
   (`../contract.js`) et les permissions du manifeste : une primitive dont la permission n'est
   pas déclarée n'est pas sur l'objet. Un plugin embarqué, un plugin tiers (dans un worker, par
   un mandataire) et un plugin sous test (`createTestContext`) reçoivent le MÊME ctx, bâti ICI,
   depuis des FOURNISSEURS injectés : la base, le bus, le dictionnaire, le registre, l'horloge,
   le client HTTP, les notifications, le registre des dépôts, l'environnement. Le cœur injecte
   les siens (`src/plugins/contexte.js`), le SDK des substituts en mémoire.

   Chaque primitive est bâtie PARESSEUSEMENT, à la première permission qui la demande : un
   test unitaire peut ainsi construire un ctx `net` + `i18n` sans ouvrir la moindre base. */
const contrat = require('../contract');
const schema = require('./schema');
const dbplugin = require('./dbplugin');
const exec = require('./exec');

const NOM_ENV = (nom) => String(nom).toUpperCase().replace(/-/g, '_');

/**
 * @param {object} manifeste le plugin.json validé
 * @param {object} f les fournisseurs :
 *   log(message) · bus (sdk/lib/bus) · i18n { dict, t, getLang } · registre (sdk/lib/registre) · horloge (sdk/lib/horloge)
 *   db() → connexion better-sqlite3 (paresseux) · net { request, makeAgentFactory } · notify { push }
 *   exec { options, tuer } · env (objet) · isDemo() · repos { list(), byId(id) } (sinon lus dans db)
 *   sortie : un objet où le ctx dépose ce qu'il a enregistré (routes, sse, seeds, settingsListeners, classements)
 */
function creerContexte(manifeste, f) {
  const nom = String(manifeste.name);
  const permissions = new Set(Array.isArray(manifeste.permissions) ? manifeste.permissions : []);
  const log = f.log || ((m) => console.log(`[${nom}] ${m}`));
  const sortie = f.sortie || {};
  sortie.seeds = sortie.seeds || [];
  sortie.settingsListeners = sortie.settingsListeners || [];
  sortie.routes = sortie.routes || [];
  sortie.sse = sortie.sse || [];
  sortie.dicts = sortie.dicts || { fr: {}, en: {} };
  let dbCache = null;
  const base = () => { if (!dbCache) dbCache = typeof f.db === 'function' ? f.db() : f.db; if (!dbCache) throw new Error(`${nom} : pas de base fournie au ctx`); return dbCache; };
  const isDemo = f.isDemo || (() => false);
  const env = f.env || {};

  const ctx = {
    name: nom,
    version: String(manifeste.version || ''),
    apiVersion: contrat.API_VERSION,
    log: (m, ...args) => log(args.length ? `${m} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}` : String(m)),
    i18n: {
      register: (locale, dict) => {
        if (!['fr', 'en'].includes(locale)) throw new Error(`${nom} : i18n.register — locale fr ou en`);
        if (!dict || typeof dict !== 'object') throw new Error(`${nom} : i18n.register — dictionnaire attendu`);
        const d = f.i18n.dict;
        if (!d[locale]) d[locale] = {};
        for (const [k, v] of Object.entries(dict)) { d[locale][k] = v; sortie.dicts[locale][k] = v; }
      },
      t: (key, params) => f.i18n.t(key, params),
      lang: () => f.i18n.getLang(),
    },
  };

  if (permissions.has('events')) {
    const emis = new Set(Array.isArray(manifeste.events && manifeste.events.emits) ? manifeste.events.emits : []);
    ctx.events = {
      on: (n, h) => f.bus.on(n, h, { proprietaire: nom }),
      off: (n, h) => f.bus.off(n, h),
      emit: (n, payload) => {
        if (!emis.has(n)) return Promise.reject(new Error(`${nom} : events.emit('${n}') — non déclaré dans plugin.json (events.emits)`));
        return f.bus.emit(n, payload);
      },
    };
  }

  /* ---------- Réglages et secrets : une table commune, le schéma du plugin ---------- */
  const schemaReglages = manifeste.settingsSchema || { type: 'object', properties: {} };
  const clesSecretes = new Set(schema.secrets(schemaReglages));
  const liaisons = schema.liaisons(schemaReglages);
  function lireReglages() {
    const d = schema.defauts(schemaReglages);
    for (const k of clesSecretes) delete d[k];
    for (const r of base().prepare('SELECT key, value FROM plugin_setting WHERE plugin = ?').all(nom)) {
      if (!Object.prototype.hasOwnProperty.call(schemaReglages.properties, r.key) || clesSecretes.has(r.key)) continue;
      try { d[r.key] = JSON.parse(r.value); } catch { d[r.key] = r.value; }
    }
    return d;
  }
  function ecrireReglages(patch) {
    const { valeurs, erreurs } = schema.valider(schemaReglages, patch);
    if (erreurs.length) { const e = new Error(erreurs.join(' ; ')); e.status = 400; throw e; }
    const avant = lireReglages();
    const maintenant = new Date().toISOString();
    const db = base();
    const poser = db.prepare('INSERT OR REPLACE INTO plugin_setting (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)');
    const poserSecret = db.prepare('INSERT OR REPLACE INTO plugin_secret (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)');
    const effacerSecret = db.prepare('DELETE FROM plugin_secret WHERE plugin = ? AND key = ?');
    db.transaction(() => {
      for (const [k, v] of Object.entries(valeurs)) {
        if (clesSecretes.has(k)) {
          if (v === '***') continue;                    // inchangé
          if (v === '') effacerSecret.run(nom, k); else poserSecret.run(nom, k, String(v), maintenant);
        } else poser.run(nom, k, JSON.stringify(v), maintenant);
      }
      /* UN SECRET LIÉ À UNE ADRESSE s'efface quand l'origine de l'adresse change sans qu'il soit
         refourni : le jeton saisi pour un hôte ne part pas vers un autre. */
      for (const [secret, cle] of Object.entries(liaisons)) {
        if (!(cle in valeurs) || secret in valeurs) continue;
        if (schema.origineDe(valeurs[cle]) !== schema.origineDe(avant[cle])) effacerSecret.run(nom, secret);
      }
    })();
    const apres = lireReglages();
    for (const h of sortie.settingsListeners) { try { h(apres); } catch (e) { log(`settings.onChange : ${e.message}`); } }
    return apres;
  }
  if (permissions.has('settings')) {
    ctx.settings = {
      get: (key) => { const all = lireReglages(); return key === undefined ? all : all[key]; },
      set: (patch) => ecrireReglages(patch),
      onChange: (h) => { if (typeof h !== 'function') throw new Error(`${nom} : settings.onChange(fn)`); sortie.settingsListeners.push(h); return () => { const i = sortie.settingsListeners.indexOf(h); if (i !== -1) sortie.settingsListeners.splice(i, 1); }; },
      schema: () => schemaReglages,
    };
  }
  if (permissions.has('secrets')) {
    ctx.secrets = {
      get: (key) => { const r = base().prepare('SELECT value FROM plugin_secret WHERE plugin = ? AND key = ?').get(nom, String(key)); return r ? r.value : ''; },
      has: (key) => !!base().prepare('SELECT 1 FROM plugin_secret WHERE plugin = ? AND key = ?').get(nom, String(key)),
      set: (key, value) => {
        const k = String(key);
        if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`${nom} : secrets.set — clé en snake_case`);
        if (value === '***') return;
        if (value === '' || value == null) base().prepare('DELETE FROM plugin_secret WHERE plugin = ? AND key = ?').run(nom, k);
        else base().prepare('INSERT OR REPLACE INTO plugin_secret (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)').run(nom, k, String(value), new Date().toISOString());
      },
      /* Le refus commun à tous les tests de connexion : le jeton en base ne part pas vers une
         autre origine que celle pour laquelle il a été saisi. */
      freshRequired: (urlBody, urlStored, tokenBody, tokenStored) => {
        if (urlBody == null || !tokenStored || (tokenBody && tokenBody !== '***')) return false;
        return schema.origineDe(urlBody) !== schema.origineDe(urlStored);
      },
    };
  }

  if (permissions.has('db')) {
    ctx.db = dbplugin.creer(base(), nom, { autres: () => (f.autresPlugins ? f.autresPlugins() : []), classer: (table, famille) => { (sortie.classements = sortie.classements || {})[table] = famille; } });
  }

  if (permissions.has('http')) {
    const router = { routes: sortie.routes };
    for (const methode of ['get', 'post', 'put', 'delete', 'patch']) {
      router[methode] = (chemin, handler) => {
        if (typeof chemin !== 'string' || !chemin.startsWith('/')) throw new Error(`${nom} : router.${methode} — chemin relatif commençant par « / » attendu (monté sous /api/plugins/${nom}/)`);
        if (/^\/api\//.test(chemin)) throw new Error(`${nom} : router.${methode}('${chemin}') — un plugin ne monte rien hors de /api/plugins/${nom}/`);
        if (typeof handler !== 'function') throw new Error(`${nom} : router.${methode}('${chemin}') — handler requis`);
        sortie.routes.push({ method: methode.toUpperCase(), path: chemin, handler });
      };
    }
    ctx.http = { router };
  }
  if (permissions.has('sse')) {
    ctx.http = ctx.http || {};
    ctx.http.sse = (chemin, producer) => {
      if (typeof chemin !== 'string' || !chemin.startsWith('/')) throw new Error(`${nom} : http.sse — chemin relatif attendu`);
      if (typeof producer !== 'function') throw new Error(`${nom} : http.sse — producer(req, send, close) requis`);
      sortie.sse.push({ path: chemin, producer });
    };
  }

  if (permissions.has('schedule')) {
    ctx.schedule = (ms, fn, opts) => f.horloge.planifier(nom, ms, fn, opts);
    ctx.unschedule = (id) => f.horloge.deplanifier(id);
  }

  if (permissions.has('exec')) {
    ctx.exec = (bin, args, opts) => exec.executer(nom, bin, args, opts, f.exec || {});
  }

  if (permissions.has('storage')) {
    if (!f.dataDir) throw new Error(`${nom} : la permission storage demande un fournisseur dataDir`);
    ctx.dataDir = f.dataDir(nom);
  }

  if (permissions.has('net')) {
    const tlsAgent = f.net.makeAgentFactory(`${NOM_ENV(nom)}_CA_CERT`, `${NOM_ENV(nom)}_INSECURE_TLS`);
    ctx.net = {
      request: (url, { method = 'GET', headers = {}, body } = {}) => {
        let u;
        try { u = new URL(String(url)); } catch { return Promise.reject(new Error(`${nom} : net.request — adresse invalide`)); }
        if (!/^https?:$/.test(u.protocol)) return Promise.reject(new Error(`${nom} : net.request — http(s) seulement`));
        return f.net.request(u.toString(), { method, headers, body, agent: tlsAgent() });
      },
    };
  }

  if (permissions.has('repos')) {
    const normaliser = (r) => (r ? { ...r, enabled: !!r.enabled, fetch_mrs: r.fetch_mrs == null ? true : !!r.fetch_mrs } : null);
    const lister = f.repos && f.repos.list ? f.repos.list : () => base().prepare('SELECT id, project, url, forge, enabled, fetch_mrs FROM repo ORDER BY project').all();
    const unSeul = f.repos && f.repos.byId ? f.repos.byId : (id) => base().prepare('SELECT id, project, url, forge, enabled, fetch_mrs FROM repo WHERE id = ?').get(Number(id));
    ctx.repos = {
      list: () => lister().map(normaliser),
      byId: (id) => normaliser(unSeul(id)),
      onRemoved: (h) => f.bus.on('repo.deleted', (p) => h({ id: p.id, project: p.project }), { proprietaire: nom }),
    };
  }

  if (permissions.has('ui.tab')) {
    ctx.ui = ctx.ui || {};
    ctx.ui.registerTab = (tab) => f.registre.registerTab(nom, tab);
    ctx.ui.registerSettingsTab = (tab) => f.registre.registerSettingsTab(nom, tab);
    ctx.ui.setBadge = (tabId, value) => f.registre.setBadge(nom, tabId, value);
  }
  if (permissions.has('ui.actions')) {
    ctx.ui = ctx.ui || {};
    ctx.ui.registerAction = (a) => f.registre.registerAction(nom, a);
    ctx.ui.registerDecorator = (d) => f.registre.registerDecorator(nom, d);
    ctx.ui.registerBriefSection = (s) => f.registre.registerBriefSection(nom, s);
    ctx.ui.registerLinkKind = (k) => f.registre.registerLinkKind(nom, k);
  }
  if (permissions.has('ui.palette')) {
    ctx.ui = ctx.ui || {};
    ctx.ui.registerPaletteProvider = (fn) => f.registre.registerPaletteProvider(nom, fn);
  }

  if (permissions.has('notify')) {
    ctx.notify = {
      registerKind: (k) => f.registre.registerNotifKind(nom, k),
      push: (type, data) => {
        if (!f.registre.notifKindDeclare(nom, type)) throw new Error(`${nom} : notify.push('${type}') — genre non déclaré (notify.registerKind)`);
        f.notify.push(type, data || {});
      },
    };
  }

  if (permissions.has('demo')) {
    ctx.demo = {
      isDemo,
      seed: (fn2) => { if (typeof fn2 !== 'function') throw new Error(`${nom} : demo.seed(fn)`); sortie.seeds.push(fn2); },
    };
  }

  if (permissions.has('env')) {
    const prefixe = `${NOM_ENV(nom)}_`;
    ctx.env = {
      get: (name) => {
        const n = String(name);
        if (!n.startsWith(prefixe)) throw new Error(`${nom} : env.get('${n}') — seules les variables ${prefixe}* sont lisibles`);
        return env[n];
      },
    };
  }

  if (permissions.has('services')) {
    ctx.services = {
      register: (n, fn2) => f.registre.registerService(nom, n, fn2),
      call: (n, payload) => f.registre.callService(n, payload),
      has: (n) => f.registre.hasService(n),
    };
  }

  return Object.freeze(ctx);
}

/** Les primitives (clés à plat, « a.b ») effectivement présentes sur un ctx — pour les tests et l'écran. */
function primitivesDe(ctx) {
  const out = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'function') out.push(k);
    else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'function' || (v2 && typeof v2 === 'object')) out.push(`${k}.${k2}`);
  }
  return out.sort();
}

/** Les tables du socle qu'un ctx attend dans sa base (le SDK de test les crée en mémoire). */
const SQL_SOCLE = `
CREATE TABLE IF NOT EXISTS plugin_setting (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT, PRIMARY KEY (plugin, key));
CREATE TABLE IF NOT EXISTS plugin_secret (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (plugin, key));
CREATE TABLE IF NOT EXISTS plugin_migration (plugin TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (plugin, version));
`;

module.exports = { creerContexte, primitivesDe, SQL_SOCLE, NOM_ENV };
