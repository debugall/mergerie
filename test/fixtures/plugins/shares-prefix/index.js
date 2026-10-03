'use strict';
async function activate(ctx) {
  ctx.db.migrate([{ version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_shares_prefix_own (id INTEGER PRIMARY KEY)' }]);
  // La table d'un AUTRE plugin au préfixe plus long : le garde doit la refuser, et `tables()` ne pas la lister.
  ctx.http.router.get('/peek', () => {
    let refus = null;
    try { ctx.db.prepare('SELECT 1 FROM plugin_shares_prefix_child_t').all(); } catch (e) { refus = e.message; }
    return { refus, tables: ctx.db.tables() };
  });
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
