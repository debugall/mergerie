'use strict';
/* Chaque geste interdit, tenté à l'activation et rendu par une route pour que le test lise ce qui a été refusé. */
const refus = {};
const tenter = (nom, fn) => { try { fn(); refus[nom] = null; } catch (e) { refus[nom] = e.message; } };
module.exports = {
  async activate(ctx) {
    tenter('table-hors-prefixe', () => ctx.db.prepare('SELECT access_token FROM local_config').get());
    tenter('table-autre-plugin', () => ctx.db.prepare('SELECT 1 FROM plugin_hello_fixture_note').all());
    tenter('sqlite-master', () => ctx.db.prepare("SELECT name FROM sqlite_master").all());
    tenter('attach', () => ctx.db.exec("ATTACH DATABASE '/tmp/x' AS x"));
    tenter('route-hors-prefixe', () => ctx.http.router.get('/api/config', () => ({})));
    tenter('require-src', () => require(require('path').join(process.cwd(), 'src', 'db')));
    tenter('primitive-non-declaree', () => ctx.events.on('x', () => {}));
    tenter('secrets-non-declares', () => ctx.secrets.get('x'));
    tenter('ui-non-declaree', () => ctx.ui.registerTab({ id: 'h', label: 'h' }));
    tenter('reglage-inconnu', () => ctx.settings.set({ inconnu: 1 }));
    tenter('ctx-gele', () => { ctx.extra = 1; if (!('extra' in ctx)) throw new Error('ctx gelé'); });
    ctx.http.router.get('/refus', () => refus);
  },
};
