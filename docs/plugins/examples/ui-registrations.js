'use strict';
/* Un onglet, un sous-onglet de réglages, une action sur une merge request, une entrée de palette.
   Le RENDU de l'action et de l'onglet est écrit côté navigateur (docs/plugins/UI.md) ; ici, les déclarations. */
const manifest = {
  name: 'exemple-ui', version: '1.0.0', apiVersion: '1', displayName: 'Exemple UI', description: 'déclarations d’écran', main: 'index.js',
  permissions: ['ui.tab', 'ui.actions', 'ui.palette', 'db'],
  ui: { scripts: ['ui/main.js'], html: { tabs: ['ui/html/onglet.html'] } },
};

async function activate(ctx) {
  ctx.ui.registerTab({ id: 'exemple-ui', label: 'Exemple', icon: 'i-plug', foldedByDefault: true, searchField: '#exempleSearch' });
  ctx.ui.registerSettingsTab({ id: 'exemplecfg', label: 'Exemple', followsTab: 'exemple-ui' });
  // Côté navigateur : ui.onAction('dire-bonjour', { render: (mr) => `<button …>…</button>` })
  ctx.ui.registerAction({ id: 'dire-bonjour', target: 'mr', label: 'Dire bonjour' });
  ctx.ui.registerDecorator({ id: 'badge-exemple', target: 'mr-badge' });
  // La palette Ctrl+K : des entrées calculées SANS réseau, depuis ce que le plugin sait déjà.
  ctx.ui.registerPaletteProvider((q) => (q.includes('exemple') ? [{ label: 'Exemple : ouvrir', ref: 'x', nav: { ouvrir: 1 } }] : []));
}

module.exports = { manifest, activate };
