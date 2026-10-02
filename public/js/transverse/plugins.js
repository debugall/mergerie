'use strict';
/* LES PLUGINS, CÔTÉ NAVIGATEUR : ce qu'ils ont déclaré au serveur (lu dans le JSON
   `#mergeriePlugins` que la page assemblée porte), ce que leur bundle enregistre ici
   (`mergerie.ui.on…`), et ce que les écrans du cœur leur demandent — les actions d'une carte,
   les sections du brief, l'ouverture d'un lien de todo, une notification, la palette.

   Un écran du cœur ne connaît aucun plugin : il appelle `pluginsHtml('mr', m)` et rend ce qui
   revient. Un plugin ne connaît aucun écran : il enregistre un rendu pour une cible, et un
   geste pour un clic. La cible est le contrat (docs/plugins/UI.md). */

/* Ce que le serveur a assemblé : tabs, settingsTabs, actions, decorators, briefSections,
   linkKinds, notifKinds, badges, settingsSchema — par plugin. */
const PLUGINS_META = (() => {
  try { const el = document.getElementById('mergeriePlugins'); return el ? (JSON.parse(el.textContent || '{}').plugins || {}) : {}; } catch { return {}; }
})();
const pluginsMeta = () => PLUGINS_META;
const pluginsTabs = () => Object.entries(PLUGINS_META).flatMap(([plugin, m]) => (m.tabs || []).map((t) => ({ ...t, plugin })));
const pluginsSettingsTabs = () => Object.entries(PLUGINS_META).flatMap(([plugin, m]) => (m.settingsTabs || []).map((t) => ({ ...t, plugin })));

/* Ce que les bundles enregistrent. */
const PLUGINS_FRONT = {
  tabOpen: new Map(),          // tab → fn
  settingsTab: new Map(),      // sub → fn
  actions: new Map(),          // id → { render, run }
  decorators: new Map(),       // id → render
  brief: new Map(),            // id → render(d)
  linkKinds: new Map(),        // kind → open(ref)
  notifs: new Map(),           // type → (e, prefs) → { title, body, onClick } | null
  palette: new Map(),          // plugin → (nav) → void
  paletteActions: [],          // { label, run }
  settingsListeners: new Map(),// plugin → [fn]
};

/* Un petit bus front : `settings.changed`, `tab.opened`, `brief.rendered`… Les plugins
   s'y abonnent ; le cœur y émet. */
const pluginsEvenements = (() => {
  const abonnes = new Map();
  return {
    on(nom, fn) { const l = abonnes.get(nom) || []; l.push(fn); abonnes.set(nom, l); return () => { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); }; },
    emit(nom, payload) { for (const fn of abonnes.get(nom) || []) { try { fn(payload); } catch (e) { console.error(`[plugins] ${nom} : ${e.message}`); } } },
  };
})();

/* Les pastilles d'un onglet de plugin : `nav-<tab>-err`, `-warn`, `-count`. */
function pluginsSetBadge(tab, value) {
  const v = typeof value === 'number' ? { count: value } : (value || {});
  const poser = (suffixe, n, bulle) => {
    const el = $(`#nav-${tab}-${suffixe}`);
    if (!el) return;
    el.hidden = !n;
    el.textContent = String(n || 0);
    if (bulle) { el.dataset.tip = bulle; el.title = ''; el.setAttribute('aria-label', bulle); }
  };
  poser('err', v.failed || 0, v.failedTip);
  poser('warn', v.warn || 0, v.warnTip);
  poser('count', v.count || 0, v.countTip);
}

/* ---------- Ce que le bundle d'un plugin utilise ---------- */
const pluginsUi = {
  onTabOpen: (tab, fn) => { PLUGINS_FRONT.tabOpen.set(tab, fn); },
  onSettingsTab: (sub, fn) => { PLUGINS_FRONT.settingsTab.set(sub, fn); },
  onAction: (id, { render, run } = {}) => { PLUGINS_FRONT.actions.set(id, { render, run }); },
  onDecorator: (id, render) => { PLUGINS_FRONT.decorators.set(id, render); },
  onBriefSection: (id, render) => { PLUGINS_FRONT.brief.set(id, render); },
  onLinkKind: (kind, open) => { PLUGINS_FRONT.linkKinds.set(kind, open); },
  onNotif: (type, fn) => { PLUGINS_FRONT.notifs.set(type, fn); },
  onPaletteResult: (plugin, fn) => { PLUGINS_FRONT.palette.set(plugin, fn); },
  registerPaletteAction: (a) => { if (a && a.label && typeof a.run === 'function') PLUGINS_FRONT.paletteActions.push(a); },
  setBadge: pluginsSetBadge,
  tabButton: (tab) => $(`nav button[data-tab="${tab}"]`),
  openTab: (tab) => navTab(tab),
  meta: (plugin) => PLUGINS_META[plugin] || null,
  settings: {
    get: (plugin) => api(`/plugins/${plugin}/settings`),
    save: async (plugin, patch) => {
      const s = await api(`/plugins/${plugin}/settings`, { method: 'PUT', body: patch });
      pluginsEvenements.emit('settings.changed', { plugin, settings: s });
      for (const fn of PLUGINS_FRONT.settingsListeners.get(plugin) || []) { try { fn(s); } catch (e) { console.error(e); } }
      return s;
    },
    onChange: (plugin, fn) => { const l = PLUGINS_FRONT.settingsListeners.get(plugin) || []; l.push(fn); PLUGINS_FRONT.settingsListeners.set(plugin, l); },
    /* Le formulaire généré depuis `settingsSchema`, dans un conteneur `[data-plugin-settings-form]`. */
    renderForm: (plugin, conteneur) => pluginsReglagesForm(plugin, conteneur),
  },
  reloadPage: () => window.location.reload(),
};

/* ---------- Ce que les écrans du cœur demandent ---------- */
/* L'ouverture d'un onglet : le plugin charge son écran. */
function pluginsOnglet(tab) {
  const fn = PLUGINS_FRONT.tabOpen.get(tab);
  if (fn) { try { fn(); } catch (e) { console.error(`[plugins] onglet ${tab} : ${e.message}`); } }
  pluginsEvenements.emit('tab.opened', { tab });
}
/* Un sous-onglet de réglages porté par un plugin : vrai si un plugin le connaît. */
function pluginsSousOnglet(sub) {
  const fn = PLUGINS_FRONT.settingsTab.get(sub);
  if (!fn && !pluginsSettingsTabs().some((t) => t.id === sub)) return false;
  // Le formulaire généré, s'il y a un conteneur pour lui dans le panneau du plugin.
  for (const el of $$(`#sub-${sub} [data-plugin-settings-form]`)) pluginsReglagesForm(el.dataset.pluginSettingsForm, el);
  if (fn) { try { fn(); } catch (e) { console.error(`[plugins] reglages ${sub} : ${e.message}`); } }
  return true;
}
const pluginsSousOngletsParMenu = () => Object.fromEntries(pluginsSettingsTabs().filter((t) => t.followsTab).map((t) => [t.id, t.followsTab]));

/* Les objets rendus avec une action à exécuter : gardés le temps du rendu, retrouvés au clic. */
let pluginsObjetSeq = 0;
const pluginsObjets = new Map();
function pluginsHtml(target, obj, ctx = {}) {
  let out = '';
  for (const [plugin, m] of Object.entries(PLUGINS_META)) {
    for (const a of (m.actions || []).filter((x) => x.target === target)) {
      const f = PLUGINS_FRONT.actions.get(a.id);
      if (!f) continue;
      try {
        if (typeof f.render === 'function') { out += f.render(obj, ctx) || ''; continue; }
        if (typeof f.run !== 'function') continue;
        if (pluginsObjets.size > 2000) pluginsObjets.clear();
        pluginsObjetSeq += 1;
        pluginsObjets.set(pluginsObjetSeq, { obj, ctx });
        const label = a.i18n ? tr(a.i18n) : a.label;
        out += `<button type="button" class="btn btn-sm" data-plugin-action="${esc(a.id)}" data-plugin-obj="${pluginsObjetSeq}" title="${esc(label)}">${esc(label)}</button>`;
      } catch (e) { console.error(`[plugins] action ${plugin}/${a.id} : ${e.message}`); }
    }
    for (const d of (m.decorators || []).filter((x) => x.target === target)) {
      const render = PLUGINS_FRONT.decorators.get(d.id);
      if (!render) continue;
      try { out += render(obj, ctx) || ''; } catch (e) { console.error(`[plugins] decorator ${plugin}/${d.id} : ${e.message}`); }
    }
  }
  return out;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-plugin-action]');
  if (!b) return;
  const f = PLUGINS_FRONT.actions.get(b.dataset.pluginAction);
  const o = pluginsObjets.get(Number(b.dataset.pluginObj));
  if (!f || !f.run || !o) return;
  e.preventDefault(); e.stopPropagation();
  try { f.run(o.obj, o.ctx, b); } catch (err) { toast(err.message, true); }
});

/* Les sections du brief, dans l'ordre de déclaration. Une section vide n'est pas rendue. */
function pluginsBriefSections(d) {
  let out = '';
  for (const [plugin, m] of Object.entries(PLUGINS_META)) {
    for (const s of m.briefSections || []) {
      const render = PLUGINS_FRONT.brief.get(s.id);
      if (!render) continue;
      let corps = '';
      try { corps = render(d) || ''; } catch (e) { console.error(`[plugins] brief ${plugin}/${s.id} : ${e.message}`); }
      if (!corps) continue;
      const titre = s.i18n ? tr(s.i18n) : s.label;
      out += `<section class="brief-sec" data-plugin-brief="${esc(s.id)}"><h3><svg class="ico"><use href="#i-${esc(s.icon || 'inbox')}"/></svg>${esc(titre)}</h3>${corps}</section>`;
    }
  }
  return out;
}

/* Un lien de todo d'un genre déclaré par un plugin : rendu, et ouverture. */
function pluginsLienHtml(t) {
  for (const m of Object.values(PLUGINS_META)) {
    const k = (m.linkKinds || []).find((x) => x.kind === t.link_kind);
    if (!k) continue;
    return `<button type="button" class="note-link" data-plugin-link="${esc(k.kind)}" data-plugin-ref="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco(k.icon || 'link')} ${esc(t.link_ref)}</button>`;
  }
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-plugin-link]');
  if (!b) return;
  const open = PLUGINS_FRONT.linkKinds.get(b.dataset.pluginLink);
  if (!open) return;
  e.preventDefault(); e.stopPropagation();
  try { open(b.dataset.pluginRef); } catch (err) { toast(err.message, true); }
});

/* Une notification d'un genre déclaré par un plugin : vrai si prise en charge. */
function pluginsNotif(ev, prefs) {
  const fn = PLUGINS_FRONT.notifs.get(ev.type);
  if (!fn) return false;
  if (!prefs[ev.type]) return true;              // genre connu, décoché : rien à afficher
  try {
    const n = fn(ev, prefs);
    if (n && n.title) showNotif(n.title, n.body || '', n.onClick);
  } catch (e) { console.error(`[plugins] notif ${ev.type} : ${e.message}`); }
  return true;
}
const pluginsNotifKinds = () => Object.entries(PLUGINS_META).flatMap(([plugin, m]) => (m.notifKinds || []).map((k) => ({ ...k, plugin })));
const pluginsNotifDefauts = () => Object.fromEntries(pluginsNotifKinds().map((k) => [k.type, k.default !== false]));

/* La palette : les « aller à » des plugins, et l'ouverture d'un résultat venu d'un fournisseur de plugin. */
const pluginsPaletteActions = () => PLUGINS_FRONT.paletteActions;
function pluginsOuvrirResultatPalette(r) {
  const nav = r && r.nav;
  if (!nav || !nav.plugin) return false;
  const fn = PLUGINS_FRONT.palette.get(nav.plugin);
  if (fn) { try { fn(nav, r); } catch (e) { toast(e.message, true); } }
  return true;
}

/* Les onglets repliés d'office, les champs de recherche de « / », les listes de j/k, l'onboarding. */
const pluginsOngletsReplies = () => pluginsTabs().filter((t) => t.foldedByDefault).map((t) => t.id);
const pluginsChampsRecherche = () => pluginsTabs().map((t) => t.searchField).filter(Boolean);
const pluginsListes = () => pluginsTabs().map((t) => t.list).filter(Boolean);
// Les listes des onglets de plugins rejoignent celles que j/k parcourent (core/theme.js).
LISTES_CLAVIER.push(...pluginsListes());
const pluginsOnboarding = () => pluginsTabs().filter((t) => t.onboarding).map((t) => ({ tab: t.id, label: t.onboarding.i18n ? tr(t.onboarding.i18n) : t.onboarding.label }));
const pluginsLegendesPastilles = () => pluginsTabs().filter((t) => t.badgeLegend).map((t) => [t.i18n && t.i18n.label ? tr(t.i18n.label) : t.label, t.badgeLegend.i18n ? tr(t.badgeLegend.i18n) : t.badgeLegend.text || String(t.badgeLegend)]);

/* ---------- Le formulaire généré depuis settingsSchema ---------- */
function pluginsChampReglage(nom, cle, p, valeur) {
  const id = `plugin-${nom}-${cle}`;
  const libelle = p['x-i18n'] ? tr(`${p['x-i18n']}.label`) : (p.title || cle);
  const tip = p['x-i18n'] ? tr(`${p['x-i18n']}.tip`) : (p.description || '');
  const hint = tip ? ` <button type="button" class="hint" tabindex="-1" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><svg class="ico"><use href="#i-info"/></svg></button>` : '';
  if (p.type === 'boolean') {
    return `<label class="inline-check"><input type="checkbox" id="${id}" name="${esc(cle)}" ${valeur ? 'checked' : ''} /> <span>${esc(libelle)}</span>${hint}</label>`;
  }
  if (Array.isArray(p.enum)) {
    return `<label><span>${esc(libelle)}</span>${hint} <select id="${id}" name="${esc(cle)}">${p.enum.map((v) => `<option value="${esc(v)}" ${String(v) === String(valeur) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  }
  const type = p['x-secret'] ? 'password' : (p.type === 'number' || p.type === 'integer' ? 'number' : (p.format === 'uri' ? 'url' : 'text'));
  const bornes = type === 'number' ? ` ${p.minimum != null ? `min="${p.minimum}"` : ''} ${p.maximum != null ? `max="${p.maximum}"` : ''} step="${p.type === 'integer' ? 1 : 'any'}"` : '';
  const ph = p['x-i18n'] ? tr(`${p['x-i18n']}.ph`) : (p['x-placeholder'] || '');
  return `<label><span class="${p['x-required'] ? 'req' : ''}">${esc(libelle)}</span>${hint} <input type="${type}" id="${id}" name="${esc(cle)}" value="${esc(valeur == null ? '' : valeur)}"${bornes} placeholder="${esc(ph && ph !== `${p['x-i18n']}.ph` ? ph : '')}" autocomplete="off" /></label>`;
}
async function pluginsReglagesForm(nom, conteneur) {
  const m = PLUGINS_META[nom] || (await api('/plugins').then((d) => (d.plugins || []).find((p) => p.name === nom)).catch(() => null));
  const schema = m && m.settingsSchema;
  if (!conteneur || !schema || !schema.properties || !Object.keys(schema.properties).length) { if (conteneur) conteneur.innerHTML = ''; return; }
  let valeurs = {};
  try { valeurs = await api(`/plugins/${nom}/settings`); } catch (e) { conteneur.innerHTML = errorBox(explainError(e.message)); return; }
  conteneur.innerHTML = `<form class="form plugin-settings-form" data-plugin-form="${esc(nom)}" autocomplete="off">
    ${Object.entries(schema.properties).map(([k, p]) => pluginsChampReglage(nom, k, p, valeurs[k])).join('\n')}
    <div class="form-actions"><button class="btn btn-primary" type="submit"><svg class="ico"><use href="#i-save"/></svg><span>${esc(tr('plugins.settings.save'))}</span></button> <span class="muted plugin-settings-info"></span></div>
  </form>`;
  const form = conteneur.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {};
    for (const [k, p] of Object.entries(schema.properties)) {
      const el = form.elements[k];
      if (!el) continue;
      patch[k] = p.type === 'boolean' ? el.checked : el.value;
      if (p['x-secret'] && el.value === '***') delete patch[k];
    }
    const info = form.querySelector('.plugin-settings-info');
    try {
      const s = await busy(form.querySelector('button[type=submit]'), () => pluginsUi.settings.save(nom, patch));
      for (const [k, p] of Object.entries(schema.properties)) { const el = form.elements[k]; if (el && p['x-secret']) el.value = s[k] || ''; }
      if (info) info.textContent = tr('plugins.settings.saved');
    } catch (err) { if (info) info.textContent = ''; toast(explainError(err.message), true); }
  });
}
