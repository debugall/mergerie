'use strict';
/* Le squelette : un réglage, une route, une ligne de journal. Exécuté par la CI sur un ctx de test
   (test/unit-plugins-docs.test.js) : si cet exemple cesse de marcher, la documentation le dit. */
const manifest = {
  name: 'exemple-minimal', version: '1.0.0', apiVersion: '1', displayName: 'Exemple', description: 'le squelette', main: 'index.js',
  permissions: ['settings', 'http'],
  settingsSchema: { type: 'object', properties: { greeting: { type: 'string', default: 'bonjour', maxLength: 40 } } },
};

async function activate(ctx) {
  ctx.log('activé');
  // GET /api/plugins/exemple-minimal/ping → { ok: true, greeting: "bonjour" }
  ctx.http.router.get('/ping', () => ({ ok: true, greeting: ctx.settings.get('greeting') }));
  // PUT /api/plugins/exemple-minimal/greeting { value } : écrit un réglage (validé par le schéma)
  ctx.http.router.put('/greeting', (req) => ctx.settings.set({ greeting: req.body.value }));
}

async function deactivate() { /* rien à rendre : le chargeur retire routes et abonnements */ }

module.exports = { manifest, activate, deactivate };
