'use strict';
/* LE CHARGEUR. Il découvre les plugins (`plugins/` du dépôt, puis `<dataDir>/plugins/`), lit
   leurs manifestes, tient leur état (activé ou non, version, erreur) en base, et les active
   ou les désactive À CHAUD — sans redémarrer Mergerie.

   Deux chemins, UNE API : un plugin embarqué tourne dans le processus du serveur, un plugin
   tiers dans un worker_thread où le ctx lui parvient par RPC (`hote-worker.js`). Le ctx est
   construit par `contexte.js` dans les deux cas, depuis les mêmes permissions ; le worker
   n'ajoute qu'une frontière, jamais une primitive.

   Désactiver = `deactivate()` du plugin, puis tout ce qu'il avait posé est retiré :
   abonnements au bus, tâches périodiques, routes, déclarations d'écran, dictionnaires,
   services. Ses tables restent. Réactiver refait `activate(ctx)`. Un plugin qui lève au
   `activate()` est marqué « en erreur », avec le message ; le serveur démarre quand même.

   `requires` : un plugin dont une dépendance est inactive s'affiche inactif, avec la raison,
   et n'est pas chargé. */
const fs = require('fs');
const path = require('path');

const manifesteMod = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'manifeste.js'));
const { creerContexte, retirerDicts } = require('./contexte');
const registre = require('./registre');
const horloge = require('./horloge');
const events = require('../core/events');
const garde = require('./garde-require');
const pageplugins = require('./pageplugins');

const RACINE = path.join(__dirname, '..', '..');
/* Le dossier des plugins embarqués : celui du dépôt — ou, pour les tests d'extériorité, un autre
   (`MERGERIE_BUILTIN_PLUGINS_DIR`, par exemple un dossier vide : le plugin embarqué est alors
   installé comme un tiers, et doit se comporter pareil). */
const EMBARQUES = process.env.MERGERIE_BUILTIN_PLUGINS_DIR ? path.resolve(process.env.MERGERIE_BUILTIN_PLUGINS_DIR) : path.join(RACINE, 'plugins');

/** @type {Map<string, any>} nom → fiche { manifeste, dir, origin, erreurs, enabled, actif, error, instance, ctx, sortie, hote }  */
const fiches = new Map();
let journal = (m) => console.log(m);
let dossierUtilisateur = null;

const db = () => require('../db');

function lireEtat(nom) { return db().prepare('SELECT * FROM plugin_state WHERE name = ?').get(nom) || null; }
function ecrireEtat(nom, patch) {
  const cur = lireEtat(nom) || { name: nom, enabled: 0, version: '', origin: 'user', error: null };
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  db().prepare(`INSERT INTO plugin_state (name, enabled, version, origin, error, updated_at) VALUES (@name, @enabled, @version, @origin, @error, @updated_at)
    ON CONFLICT(name) DO UPDATE SET enabled = @enabled, version = @version, origin = @origin, error = @error, updated_at = @updated_at`)
    .run({ name: nom, enabled: next.enabled ? 1 : 0, version: String(next.version || ''), origin: next.origin || 'user', error: next.error || null, updated_at: next.updated_at });
}

/** Le dossier des plugins de l'utilisateur, sous le dossier de données. */
function dossierUser() {
  if (dossierUtilisateur) return dossierUtilisateur;
  const { DATA_DIR } = require('../core/paths');
  dossierUtilisateur = path.join(DATA_DIR, 'plugins');
  return dossierUtilisateur;
}

/* ---------- Découverte ---------- */
function scanner(dir, origin) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ ...manifesteMod.lire(path.join(dir, e.name)), origin, dossierNom: e.name }));
}

/** (Re)lit les dossiers. Un plugin déjà actif dont la version a changé est signalé (`updateAvailable`). */
function decouvrir() {
  const trouves = [...scanner(EMBARQUES, 'builtin'), ...scanner(dossierUser(), 'user')];
  const vus = new Set();
  for (const t of trouves) {
    const nom = (t.manifeste && t.manifeste.name) || t.dossierNom;
    if (vus.has(nom)) { journal(`[plugins] ${nom} : déjà vu dans un autre dossier — le premier (${fiches.get(nom).dir}) l'emporte`); continue; }
    vus.add(nom);
    if (t.manifeste && t.manifeste.name && t.manifeste.name !== t.dossierNom) t.erreurs.push(`le dossier s'appelle « ${t.dossierNom} », le plugin « ${t.manifeste.name} » : ils doivent coïncider`);
    const existante = fiches.get(nom);
    const fiche = existante || { nom, actif: false, instance: null, ctx: null, sortie: null, hote: null, error: null };
    fiche.manifeste = t.manifeste; fiche.dir = t.dir; fiche.origin = t.origin; fiche.erreurs = t.erreurs; fiche.valide = t.ok;
    const etat = lireEtat(nom);
    if (!etat) {
      // Un embarqué est activé d'office SEULEMENT s'il le dit (`enabledByDefault: true`) ; sinon, comme un tiers, il attend qu'on l'active.
      // Les embarqués du dépôt sont tous désactivés sur une première installation ; un poste qui monte de version garde Jenkins
      // grâce à l'état que `db/schema/18-plugins.js` pose avant ce passage.
      const dOffice = t.origin === 'builtin' && !!(t.manifeste && t.manifeste.enabledByDefault === true);
      ecrireEtat(nom, { enabled: dOffice ? 1 : 0, version: (t.manifeste && t.manifeste.version) || '', origin: t.origin });
    }
    const e = lireEtat(nom);
    fiche.enabled = !!e.enabled;
    fiche.versionEnregistree = e.version || '';
    fiche.updateAvailable = !!(fiche.actif && t.manifeste && t.manifeste.version !== fiche.versionActive);
    if (!existante) fiches.set(nom, fiche);
  }
  for (const [nom, f] of [...fiches]) if (!vus.has(nom)) { if (f.actif) desactiver(nom, { raison: 'dossier disparu' }); fiches.delete(nom); }
  return liste();
}

/* ---------- Activation ---------- */
function dependancesManquantes(f) {
  const req = Array.isArray(f.manifeste && f.manifeste.requires) ? f.manifeste.requires : [];
  return req.filter((r) => { const d = fiches.get(r); return !d || !d.actif; });
}

async function activer(nom, { persister = true } = {}) {
  const f = fiches.get(nom);
  if (!f) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  if (f.actif) return f;
  if (!f.valide) { f.error = f.erreurs.join(' ; '); if (persister) ecrireEtat(nom, { enabled: 1, error: f.error }); f.enabled = true; return f; }
  const manquantes = dependancesManquantes(f);
  if (manquantes.length) {
    f.error = `dépend de ${manquantes.join(', ')} (inactif)`;
    if (persister) ecrireEtat(nom, { enabled: 1, error: f.error });
    f.enabled = true;
    return f;
  }
  garde.surveiller(f.dir);
  const sortie = {};
  const log = (m) => journal(`[${nom}] ${m}`);
  try {
    if (f.origin === 'builtin') {
      const ctx = creerContexte(f.manifeste, { log, sortie });
      // Un plugin rechargé après désactivation repart d'un module frais : son état précédent s'en va avec lui.
      const principal = path.join(f.dir, f.manifeste.main);
      for (const k of Object.keys(require.cache)) if (k.startsWith(f.dir + path.sep)) delete require.cache[k];
      const instance = require(principal);
      if (typeof instance.activate !== 'function') throw new Error('index.js n’exporte pas activate(ctx)');
      await avecDelai(instance.activate(ctx), 10_000, `activate() de ${nom} n'a pas répondu en 10 s`);
      f.instance = instance; f.ctx = ctx; f.sortie = sortie; f.hote = null;
    } else {
      const { HoteWorker } = require('./hote-worker');
      const hote = new HoteWorker(f, { log, sortie });
      await hote.activer();
      f.instance = null; f.ctx = hote.ctx; f.sortie = sortie; f.hote = hote;
    }
    f.actif = true; f.error = null; f.versionActive = f.manifeste.version; f.updateAvailable = false;
    if (persister) ecrireEtat(nom, { enabled: 1, version: f.manifeste.version, error: null, origin: f.origin });
    f.enabled = true;
    log(`activé (v${f.manifeste.version}${f.origin === 'builtin' ? ', embarqué' : ', worker'})`);
    for (const [autre, g] of fiches) if (!g.actif && g.enabled && g.valide && !dependancesManquantes(g).length && g.error && /dépend de/.test(g.error)) await activer(autre, { persister }).catch(() => {});
  } catch (e) {
    f.error = (e && e.message) || String(e);
    nettoyer(nom, f);
    if (persister) ecrireEtat(nom, { enabled: 1, error: f.error });
    f.enabled = true; f.actif = false;
    log(`en erreur : ${f.error}`);
  }
  return f;
}

function avecDelai(promesse, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promesse).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Retire tout ce qu'un plugin a posé. Les tables restent. */
function nettoyer(nom, f) {
  events.offAll(nom);
  horloge.arreterTout(nom);
  registre.oublier(nom);
  retirerDicts(nom);
  if (f.hote) { try { f.hote.terminer(); } catch { /* déjà parti */ } }
  f.hote = null; f.instance = null; f.ctx = null; f.sortie = null;
  for (const k of Object.keys(require.cache)) if (f.dir && k.startsWith(f.dir + path.sep)) delete require.cache[k];
}

async function desactiver(nom, { persister = true, raison = '' } = {}) {
  const f = fiches.get(nom);
  if (!f) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  if (f.actif) {
    try {
      if (f.hote) await avecDelai(f.hote.desactiver(), 5_000, 'deactivate() n’a pas répondu');
      else if (f.instance && typeof f.instance.deactivate === 'function') await avecDelai(f.instance.deactivate(), 5_000, 'deactivate() n’a pas répondu');
    } catch (e) { journal(`[${nom}] deactivate : ${e.message}`); }
  }
  nettoyer(nom, f);
  f.actif = false; f.error = null;
  if (persister) ecrireEtat(nom, { enabled: 0, error: null });
  f.enabled = false;
  journal(`[${nom}] désactivé${raison ? ` (${raison})` : ''}`);
  // Ceux qui en dépendent s'arrêtent, et le disent.
  for (const [autre, g] of fiches) {
    if (g.actif && Array.isArray(g.manifeste && g.manifeste.requires) && g.manifeste.requires.includes(nom)) {
      await desactiver(autre, { persister: false, raison: `dépend de ${nom}` });
      g.enabled = true; g.error = `dépend de ${nom} (inactif)`;
    }
  }
  return f;
}

/** Au démarrage : découverte, puis activation de ce qui est activé — dans l'ordre des dépendances. */
async function demarrer({ log } = {}) {
  if (log) journal = log;
  decouvrir();
  const aActiver = [...fiches.values()].filter((f) => f.enabled);
  const faits = new Set();
  let tour = 0;
  while (faits.size < aActiver.length && tour < 10) {
    tour += 1;
    for (const f of aActiver) {
      if (faits.has(f.nom)) continue;
      const req = Array.isArray(f.manifeste && f.manifeste.requires) ? f.manifeste.requires : [];
      if (req.every((r) => faits.has(r) || !aActiver.some((g) => g.nom === r))) { await activer(f.nom, { persister: false }); faits.add(f.nom); }
    }
  }
  horloge.demarrer({ demo: process.env.MERGERIE_DEMO === '1' });
  return liste();
}

/** À l'arrêt : deactivate() partout, sans toucher à l'état persisté. */
async function arreter() {
  for (const [nom, f] of fiches) if (f.actif) await desactiver(nom, { persister: false, raison: 'arrêt' }).catch(() => {});
  horloge.arreter();
}

/* ---------- Installation ---------- */
function copierDossier(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copierDossier(s, d); else fs.copyFileSync(s, d);
  }
}

/** Installe depuis un dossier local : manifeste vérifié AVANT copie. Désactivé par défaut. */
function installerDepuisDossier(source) {
  const src = path.resolve(String(source || ''));
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw Object.assign(new Error('dossier introuvable'), { status: 400 });
  const lu = manifesteMod.lire(src);
  if (!lu.ok) throw Object.assign(new Error(`plugin refusé : ${lu.erreurs.join(' ; ')}`), { status: 400 });
  const nom = lu.manifeste.name;
  if (fiches.has(nom) && fiches.get(nom).origin === 'builtin') throw Object.assign(new Error(`« ${nom} » est un plugin embarqué`), { status: 409 });
  const dst = path.join(dossierUser(), nom);
  if (path.resolve(src) === path.resolve(dst)) { decouvrir(); return fiches.get(nom); }
  const existait = fs.existsSync(dst);
  if (existait) {
    if (fiches.get(nom) && fiches.get(nom).actif) throw Object.assign(new Error(`« ${nom} » est actif : désactive-le avant de le remplacer`), { status: 409 });
    fs.rmSync(dst, { recursive: true, force: true });
  }
  copierDossier(src, dst);
  decouvrir();
  return fiches.get(nom);
}

/** Installe depuis une URL git : clone SANS shell dans un dossier temporaire, manifeste vérifié, puis copie. */
async function installerDepuisGit(url, ref) {
  const u = String(url || '').trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(u)) throw Object.assign(new Error('adresse git attendue (https://, ssh://, git@ ou chemin local)'), { status: 400 });
  const os = require('os');
  const git = require('../git/git');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-plugin-'));
  try {
    const args = ['clone', '--depth', '1', '--no-local', '--', u, tmp];
    if (ref) args.splice(1, 0, '--branch', String(ref));
    await git.run('git', args, { cwd: os.tmpdir() });
    // Le plugin peut vivre à la racine du dépôt, ou dans un sous-dossier `plugin/`.
    const racine = fs.existsSync(path.join(tmp, 'plugin.json')) ? tmp : path.join(tmp, 'plugin');
    return installerDepuisDossier(racine);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Désinstalle un plugin utilisateur. `garderDonnees` : ses tables, réglages et secrets restent. */
async function desinstaller(nom, { garderDonnees = true } = {}) {
  const f = fiches.get(nom);
  if (!f) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  if (f.origin === 'builtin') throw Object.assign(new Error('un plugin embarqué ne se désinstalle pas : désactive-le'), { status: 409 });
  if (f.actif) await desactiver(nom);
  fs.rmSync(f.dir, { recursive: true, force: true });
  fiches.delete(nom);
  const d = db();
  d.prepare('DELETE FROM plugin_state WHERE name = ?').run(nom);
  if (!garderDonnees) {
    const prefixe = `plugin_${nom.replace(/-/g, '_')}_`;
    for (const t of d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?").all(`${prefixe}%`)) d.exec(`DROP TABLE IF EXISTS ${t.name}`);
    d.prepare('DELETE FROM plugin_setting WHERE plugin = ?').run(nom);
    d.prepare('DELETE FROM plugin_secret WHERE plugin = ?').run(nom);
    d.prepare('DELETE FROM plugin_migration WHERE plugin = ?').run(nom);
    require('./donnees').effacer(nom);
  }
  return { ok: true, dataKept: garderDonnees };
}

/* ---------- Lecture ---------- */
function fiche(nom) { return fiches.get(nom) || null; }
function liste() {
  return [...fiches.values()].map((f) => {
    const m = f.manifeste || {};
    const d = f.actif ? registre.declarations(f.nom) : null;
    return {
      name: f.nom, displayName: m.displayName || f.nom, description: m.description || '', version: m.version || '', apiVersion: m.apiVersion || '',
      author: m.author || '', homepage: m.homepage || '', license: m.license || '',
      origin: f.origin, dir: f.dir, builtin: f.origin === 'builtin',
      enabled: !!f.enabled, active: !!f.actif,
      state: f.actif ? 'active' : (!f.valide ? 'incompatible' : (f.error ? 'error' : (f.enabled ? 'error' : 'inactive'))),
      error: f.error || (f.valide ? null : f.erreurs.join(' ; ')),
      errors: f.erreurs || [],
      requires: Array.isArray(m.requires) ? m.requires : [],
      missing: f.valide ? dependancesManquantes(f) : [],
      permissions: manifesteMod.permissionsDe(m),
      events: { listens: f.actif ? events.ecoutesPar(f.nom) : (m.events && m.events.listens) || [], emits: (m.events && m.events.emits) || [] },
      settingsSchema: m.settingsSchema || null,
      updateAvailable: !!f.updateAvailable,
      ui: d ? { tabs: d.tabs.map((t) => t.id), settingsTabs: d.settingsTabs.map((t) => t.id), actions: d.actions.length, decorators: d.decorators.length } : null,
      schedules: f.actif ? horloge.tachesDe(f.nom).length : 0,
    };
  });
}

/** Les plugins actifs, pour l'assemblage de page. */
function actifsPourPage() {
  return [...fiches.values()].filter((f) => f.actif).map((f) => ({ manifeste: f.manifeste, dir: f.dir, declarations: registre.declarations(f.nom) }));
}

/** Le dispatch HTTP d'un plugin actif : ses routes, à plat. `null` si inactif. */
function routesDe(nom) {
  const f = fiches.get(nom);
  if (!f || !f.actif || !f.sortie) return null;
  return { routes: f.sortie.routes || [], sse: f.sortie.sse || [] };
}

/** Sème la démo de chaque plugin actif. */
async function semerDemo() {
  const comptes = {};
  for (const [nom, f] of fiches) {
    if (!f.actif || !f.sortie) continue;
    for (const seed of f.sortie.seeds || []) {
      try { await seed(f.ctx); comptes[nom] = (comptes[nom] || 0) + 1; }
      catch (e) { journal(`[${nom}] demo.seed : ${e.message}`); }
    }
    if (f.hote) { try { comptes[nom] = (comptes[nom] || 0) + await f.hote.semer(); } catch (e) { journal(`[${nom}] demo.seed : ${e.message}`); } }
  }
  return comptes;
}

/** Réglages d'un plugin, masqués (`***`) pour l'écran. */
function reglagesPourEcran(nom) {
  const f = fiches.get(nom);
  if (!f || !f.manifeste) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  const schema = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'schema.js'));
  const s = f.manifeste.settingsSchema || { type: 'object', properties: {} };
  const d = schema.defauts(s);
  const secrets = new Set(schema.secrets(s));
  const base = db();
  for (const r of base.prepare('SELECT key, value FROM plugin_setting WHERE plugin = ?').all(nom)) {
    if (!Object.prototype.hasOwnProperty.call(s.properties, r.key) || secrets.has(r.key)) continue;
    try { d[r.key] = JSON.parse(r.value); } catch { d[r.key] = r.value; }
  }
  for (const k of secrets) d[k] = base.prepare('SELECT 1 FROM plugin_secret WHERE plugin = ? AND key = ?').get(nom, k) ? '***' : '';
  return d;
}
/** La valeur d'un secret de plugin, pour le bouton « copier » — et seulement si le schéma du plugin le déclare `x-secret`. */
function lireSecretPourCopie(nom, cle) {
  const f = fiches.get(nom);
  if (!f || !f.manifeste) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  const schema = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'schema.js'));
  if (!schema.secrets(f.manifeste.settingsSchema || { properties: {} }).includes(String(cle))) throw Object.assign(new Error(`« ${cle} » n'est pas un secret de ce plugin`), { status: 400 });
  const r = db().prepare('SELECT value FROM plugin_secret WHERE plugin = ? AND key = ?').get(nom, String(cle));
  return r ? String(r.value) : '';
}
function ecrireReglages(nom, patch) {
  const f = fiches.get(nom);
  if (!f || !f.manifeste) throw Object.assign(new Error(`plugin inconnu : ${nom}`), { status: 404 });
  // Actif : par SON ctx, pour que ses abonnés `onChange` soient prévenus. Inactif : la même écriture, sans abonnés.
  if (f.actif && f.ctx && f.ctx.settings) f.ctx.settings.set(patch);
  else {
    const sortie = {};
    const ctx = creerContexte({ ...f.manifeste, permissions: ['settings'] }, { sortie, log: () => {} });
    ctx.settings.set(patch);
  }
  return reglagesPourEcran(nom);
}

function reset() { fiches.clear(); dossierUtilisateur = null; }

module.exports = {
  decouvrir, activer, desactiver, demarrer, arreter, installerDepuisDossier, installerDepuisGit, desinstaller,
  fiche, liste, actifsPourPage, routesDe, semerDemo, reglagesPourEcran, lireSecretPourCopie, ecrireReglages, dossierUser, reset,
  EMBARQUES, pageplugins,
};
