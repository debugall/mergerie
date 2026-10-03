'use strict';
/* CE QU'UN PLUGIN AJOUTE À LA PAGE — assemblé côté serveur, sans build ni chargement dynamique.

   Le front de Mergerie est une seule portée globale, décrite par le manifeste d'`index.html` :
   un plugin ne peut pas y « charger un bundle » après coup sans échapper à tout ce que
   `scripts/check-front.js` garantit. Il DÉCLARE donc ses fichiers dans `plugin.json` (`ui`), et
   la page servie les porte comme s'ils étaient ceux du cœur : ses feuilles de style dans le
   `<head>`, ses dictionnaires avant le moteur de traduction, ses morceaux de HTML (onglet,
   modales, sous-onglet de réglages, symboles du sprite) à leur place, et ses scripts en UN
   bundle par plugin — `/plugins/<nom>/bundle.js`, servi par le cœur, qui enveloppe les fichiers
   dans une fonction recevant le kit (`window.mergerie`) : les noms du kit y sont en portée, rien
   d'autre du cœur, et rien du plugin ne fuit dans la portée globale.

   PUR : `fs` et le manifeste. `page.js` reçoit ce que ce module rend ; `test/helpers/front.js`
   et `check-front` l'appellent sans base ni dossier de données. */
const fs = require('fs');
const path = require('path');

const manifeste = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'manifeste.js'));

const RACINE = path.join(__dirname, '..', '..');
const PUBLIC = path.join(RACINE, 'public');
const PLUGINS_EMBARQUES = path.join(RACINE, 'plugins');

/** Les noms du kit : les clés de premier niveau de `window.mergerie = { … }` dans kit.js. */
function clesDuKit(texte = fs.readFileSync(path.join(PUBLIC, 'js', 'transverse', 'kit.js'), 'utf8')) {
  const bloc = (texte.match(/window\.mergerie = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const cles = [];
  for (const l of bloc.split('\n')) {
    const m = l.match(/^  ([A-Za-z_$][\w$]*)\s*[,:]/);
    if (m) cles.push(m[1]);
  }
  return cles;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lireMorceau = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\n$/, '');

/** Les plugins embarqués du dépôt (manifestes lus, valides ou non). */
function embarques() {
  if (!fs.existsSync(PLUGINS_EMBARQUES)) return [];
  return fs.readdirSync(PLUGINS_EMBARQUES, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ ...manifeste.lire(path.join(PLUGINS_EMBARQUES, e.name)), origin: 'builtin', enabled: true }));
}

/* Un bouton d'onglet, comme ceux de `html/sidebar.html` : `data-tab`, l'icône, le libellé
   traduit (`data-i18n`), deux pastilles (`err`, `count`). */
function boutonNav(tab) {
  const cle = tab.i18n && tab.i18n.label;
  const cleTitre = tab.i18n && tab.i18n.title;
  return `        <button data-tab="${esc(tab.id)}" data-plugin-tab="${esc(tab.plugin)}" title="${esc(tab.title)}"${cleTitre ? ` data-i18n-title="${esc(cleTitre)}"` : ''}>`
    + `<svg class="ico"><use href="#${esc(tab.icon)}"/></svg><span${cle ? ` data-i18n="${esc(cle)}"` : ''}>${esc(tab.label)}</span>`
    + `<span class="nav-health err" id="nav-${esc(tab.id)}-err" hidden>0</span><span class="nav-health warn" id="nav-${esc(tab.id)}-warn" hidden>0</span><span class="nav-count" id="nav-${esc(tab.id)}-count" hidden>0</span></button>`;
}
function boutonSousOnglet(t) {
  const cle = t.i18n && t.i18n.label;
  const cleTitre = t.i18n && t.i18n.title;
  return `            <button data-sub="${esc(t.id)}" data-plugin-sub="${esc(t.plugin)}" role="tab" title="${esc(t.title)}"${cleTitre ? ` data-i18n-title="${esc(cleTitre)}"` : ''}${cle ? ` data-i18n="${esc(cle)}"` : ''}>${esc(t.label)}</button>`;
}

/**
 * Les fragments de page pour une liste de plugins ACTIFS, chacun `{ manifeste, dir, declarations }`
 * (`declarations` = ce que `registre.declarations(nom)` rend : tabs, settingsTabs…).
 * Rend un objet { styles, i18n, scripts, sprite, nav: { 'before:x': [...], end: [...] }, tabs, modals, settingsNav, settingsPanels, meta }.
 */
function fragments(plugins, { versions = {} } = {}) {
  const out = { styles: [], i18n: [], scripts: [], sprite: [], nav: {}, tabs: [], modals: [], settingsNav: [], settingsPanels: [], meta: { plugins: {} } };
  for (const p of plugins) {
    const m = p.manifeste;
    if (!m || !m.name) continue;
    const nom = m.name;
    const ui = m.ui || {};
    const v = encodeURIComponent(versions[nom] || m.version || '0');
    for (const f of ui.styles || []) out.styles.push(`    <link rel="stylesheet" href="/plugins/${nom}/ui/${f.replace(/^ui\//, '')}?v=${v}" />`);
    for (const f of ui.i18n || []) out.i18n.push(`<script src="/plugins/${nom}/ui/${f.replace(/^ui\//, '')}?v=${v}"></script>`);
    if ((ui.scripts || []).length) out.scripts.push(`<script src="/plugins/${nom}/bundle.js?v=${v}"></script>`);
    const html = ui.html || {};
    for (const f of html.sprite || []) out.sprite.push(lireMorceau(p.dir, f));
    for (const f of html.tabs || []) out.tabs.push(`    <!--@plugin ${nom}/${f}-->\n${lireMorceau(p.dir, f)}`);
    for (const f of html.modals || []) out.modals.push(`<!--@plugin ${nom}/${f}-->\n${lireMorceau(p.dir, f)}`);
    for (const f of html.settings || []) out.settingsPanels.push(`        <!--@plugin ${nom}/${f}-->\n${lireMorceau(p.dir, f)}`);
    const d = p.declarations || {};
    for (const tab of d.tabs || []) {
      const pos = tab.position && tab.position !== 'end' ? tab.position : 'end';
      (out.nav[pos] = out.nav[pos] || []).push(boutonNav({ ...tab, plugin: nom }));
    }
    for (const t of d.settingsTabs || []) out.settingsNav.push(boutonSousOnglet({ ...t, plugin: nom }));
    out.meta.plugins[nom] = {
      version: m.version, displayName: m.displayName,
      tabs: (d.tabs || []).map((t) => ({ id: t.id, label: t.label, foldedByDefault: t.foldedByDefault, shortcut: t.shortcut, searchField: t.searchField, list: t.list, onboarding: t.onboarding, badgeLegend: t.badgeLegend, i18n: t.i18n })),
      settingsTabs: (d.settingsTabs || []).map((t) => ({ id: t.id, label: t.label, followsTab: t.followsTab, schemaForm: t.schemaForm })),
      actions: d.actions || [], decorators: d.decorators || [], briefSections: d.briefSections || [], linkKinds: d.linkKinds || [],
      notifKinds: d.notifKinds || [], badges: d.badges || {},
      settingsSchema: m.settingsSchema || null,
    };
  }
  return out;
}

/** Les fragments sous forme de texte, prêts pour `page.assemblerPage` (marqueurs `<!--@plugins:x-->`). */
function texteDesFragments(fr) {
  const nav = Object.entries(fr.nav).map(([pos, lignes]) => [pos, lignes.join('\n')]);
  return {
    styles: fr.styles.join('\n'),
    i18n: fr.i18n.join('\n'),
    scripts: fr.scripts.join('\n'),
    sprite: fr.sprite.join('\n'),
    nav: nav.filter(([p]) => p === 'end').map(([, l]) => l).join('\n'),
    navPositions: Object.fromEntries(nav.filter(([p]) => p !== 'end')),
    tabs: fr.tabs.join('\n\n'),
    modals: fr.modals.join('\n\n'),
    'settings-nav': fr.settingsNav.join('\n'),
    'settings-panels': fr.settingsPanels.join('\n\n'),
    meta: `<script type="application/json" id="mergeriePlugins">${JSON.stringify(fr.meta).replace(/</g, '\\u003c')}</script>`,
  };
}

/** Le bundle d'un plugin : ses scripts, enveloppés avec le kit en portée. */
function bundle(plugin, cles = clesDuKit()) {
  const m = plugin.manifeste;
  const parties = (m.ui && m.ui.scripts) || [];
  const corps = parties.map((f) => `//// ${m.name}/${f}\n${fs.readFileSync(path.join(plugin.dir, f), 'utf8')}`).join('\n');
  return `(function (mergerie) {\n'use strict';\nconst { ${cles.join(', ')} } = mergerie;\nconst PLUGIN = ${JSON.stringify(m.name)};\n${corps}\n})(window.mergerie);\n`;
}

module.exports = { clesDuKit, embarques, fragments, texteDesFragments, bundle, PLUGINS_EMBARQUES, PUBLIC };
