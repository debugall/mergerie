'use strict';
/* CE QUE LES PLUGINS ONT DÉCLARÉ : onglets, sous-onglets de réglages, pastilles, actions,
   décorations, sections du brief, genres de liens, fournisseurs de palette, genres de
   notification, services. Un registre en mémoire, par plugin, vidé à la désactivation.

   Rien ici n'exécute quoi que ce soit : ce sont des DONNÉES, que la page assemblée et l'API
   `/api/plugins/ui` donnent au navigateur, où le code du plugin fait le reste. Un worker les
   déclare par RPC exactement comme un plugin en processus. Instanciable : le cœur en tient un,
   chaque contexte de test le sien. */
const contrat = require('../contract');

const exiger = (cond, message) => { if (!cond) throw new Error(message); };
const ID = /^[a-z][a-z0-9-]*$/;

/* Les groupes que l'entrée d'un plugin peut NOMMER dans la palette (ceux dont l'écran a le libellé `palette.group.<groupe>`) ; tout autre tombe dans « actions ». */
const GROUPES_PALETTE = new Set(['links']);

function creer() {
  const parPlugin = new Map();
  const services = new Map();
  const vierge = () => ({ tabs: [], settingsTabs: [], badges: {}, actions: [], decorators: [], briefSections: [], linkKinds: [], paletteProviders: [], notifKinds: [] });
  const de = (plugin) => { if (!parPlugin.has(plugin)) parPlugin.set(plugin, vierge()); return parPlugin.get(plugin); };

  function registerTab(plugin, tab) {
    exiger(tab && typeof tab === 'object', `${plugin} : registerTab({ id, label, icon }) attendu`);
    exiger(ID.test(String(tab.id || '')), `${plugin} : registerTab — id en kebab-case requis`);
    exiger(tab.label && typeof tab.label === 'string', `${plugin} : registerTab — label requis`);
    const r = de(plugin);
    exiger(!r.tabs.some((t) => t.id === tab.id), `${plugin} : onglet « ${tab.id} » déjà déclaré`);
    r.tabs.push({
      id: String(tab.id), label: String(tab.label), title: String(tab.title || tab.label), icon: String(tab.icon || 'i-plug'),
      position: tab.position == null ? 'end' : String(tab.position),
      foldedByDefault: tab.foldedByDefault !== false, shortcut: tab.shortcut || null,
      searchField: tab.searchField || null, list: tab.list || null,
      onboarding: tab.onboarding ? { label: String(tab.onboarding.label || tab.label), i18n: tab.onboarding.i18n || null } : null,
      badgeLegend: tab.badgeLegend || null, i18n: tab.i18n || null,
    });
  }
  function registerSettingsTab(plugin, tab) {
    exiger(tab && ID.test(String(tab.id || '')), `${plugin} : registerSettingsTab — id en kebab-case requis`);
    exiger(tab.label && typeof tab.label === 'string', `${plugin} : registerSettingsTab — label requis`);
    const r = de(plugin);
    exiger(!r.settingsTabs.some((t) => t.id === tab.id), `${plugin} : sous-onglet « ${tab.id} » déjà déclaré`);
    r.settingsTabs.push({ id: String(tab.id), label: String(tab.label), title: String(tab.title || tab.label), followsTab: tab.followsTab || null, schemaForm: tab.schemaForm !== false, i18n: tab.i18n || null });
  }
  function setBadge(plugin, tabId, value) {
    const r = de(plugin);
    if (value == null) { delete r.badges[tabId]; return; }
    r.badges[tabId] = typeof value === 'number' ? { count: value } : { count: Number(value.count) || 0, failed: Number(value.failed) || 0, warn: Number(value.warn) || 0 };
  }
  function registerAction(plugin, a) {
    exiger(a && ID.test(String(a.id || '')), `${plugin} : registerAction — id en kebab-case requis`);
    exiger(contrat.CIBLES_UI.includes(a.target), `${plugin} : registerAction — target hors de ${contrat.CIBLES_UI.join(', ')}`);
    exiger(a.label && typeof a.label === 'string', `${plugin} : registerAction — label requis`);
    const r = de(plugin);
    exiger(!r.actions.some((x) => x.id === a.id), `${plugin} : action « ${a.id} » déjà déclarée`);
    r.actions.push({ id: String(a.id), target: a.target, label: String(a.label), i18n: a.i18n || null });
  }
  function registerDecorator(plugin, d) {
    exiger(d && ID.test(String(d.id || '')), `${plugin} : registerDecorator — id en kebab-case requis`);
    exiger(contrat.CIBLES_UI.includes(d.target), `${plugin} : registerDecorator — target hors de ${contrat.CIBLES_UI.join(', ')}`);
    const r = de(plugin);
    exiger(!r.decorators.some((x) => x.id === d.id), `${plugin} : décoration « ${d.id} » déjà déclarée`);
    r.decorators.push({ id: String(d.id), target: d.target });
  }
  function registerBriefSection(plugin, s) {
    exiger(s && ID.test(String(s.id || '')), `${plugin} : registerBriefSection — id en kebab-case requis`);
    exiger(s.label && typeof s.label === 'string', `${plugin} : registerBriefSection — label requis`);
    de(plugin).briefSections.push({ id: String(s.id), label: String(s.label), icon: s.icon || 'inbox', i18n: s.i18n || null });
  }
  function registerLinkKind(plugin, k) {
    exiger(k && /^[a-z][a-z0-9_-]*$/.test(String(k.kind || '')), `${plugin} : registerLinkKind — kind requis`);
    de(plugin).linkKinds.push({ kind: String(k.kind), label: String(k.label || k.kind), icon: k.icon || 'link' });
  }
  function registerPaletteProvider(plugin, fn) {
    exiger(typeof fn === 'function', `${plugin} : registerPaletteProvider(fn) attendu`);
    de(plugin).paletteProviders.push(fn);
  }
  function registerNotifKind(plugin, k) {
    exiger(k && /^[a-z][a-z0-9_]*$/.test(String(k.type || '')), `${plugin} : registerNotifKind — type en snake_case requis`);
    exiger(k.label && typeof k.label === 'string', `${plugin} : registerNotifKind — label requis`);
    de(plugin).notifKinds.push({ type: String(k.type), label: String(k.label), default: k.default !== false, i18n: k.i18n || null });
  }
  const notifKindDeclare = (plugin, type) => de(plugin).notifKinds.some((k) => k.type === type);

  function registerService(plugin, nom, fn) {
    exiger(typeof fn === 'function', `${plugin} : services.register(nom, fn) attendu`);
    const complet = plugin === 'coeur' ? String(nom) : `${plugin}.${nom}`;
    exiger(!services.has(complet), `service « ${complet} » déjà exposé`);
    services.set(complet, { plugin, fn });
  }
  async function callService(nom, payload) {
    const s = services.get(String(nom));
    if (!s) throw Object.assign(new Error(`service inconnu : ${nom}`), { code: 'SERVICE_UNKNOWN' });
    return s.fn(payload);
  }
  const hasService = (nom) => services.has(String(nom));

  function oublier(plugin) {
    parPlugin.delete(plugin);
    for (const [nom, s] of [...services]) if (s.plugin === plugin) services.delete(nom);
  }
  function declarations(plugin) { return plugin ? (parPlugin.get(plugin) || vierge()) : Object.fromEntries(parPlugin); }

  async function palette(requete, limite = 30) {
    const out = [];
    for (const [plugin, r] of parPlugin) {
      for (const fn of r.paletteProviders) {
        try {
          const entrees = await fn(String(requete || ''), limite);
          for (const e of (Array.isArray(entrees) ? entrees : []).slice(0, limite)) {
            if (!e || !e.label) continue;
            out.push({ kind: `plugin:${plugin}`, ref: String(e.ref || ''), group: GROUPES_PALETTE.has(e.group) ? e.group : 'actions', label: String(e.label), detail: String(e.detail || ''), nav: { plugin, ...(e.nav && typeof e.nav === 'object' ? e.nav : {}) }, texte: String(e.text || e.label) });
          }
        } catch (err) { console.error(`[plugins] palette ${plugin} : ${err.message}`); }
      }
    }
    return out;
  }
  function reset() { parPlugin.clear(); services.clear(); }

  return {
    registerTab, registerSettingsTab, setBadge, registerAction, registerDecorator, registerBriefSection, registerLinkKind,
    registerPaletteProvider, registerNotifKind, notifKindDeclare, registerService, callService, hasService,
    oublier, declarations, palette, reset,
  };
}

module.exports = { creer };
