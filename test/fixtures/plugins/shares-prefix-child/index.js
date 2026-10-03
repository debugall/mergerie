'use strict';
async function activate(ctx) {
  ctx.db.migrate([{ version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_shares_prefix_child_t (id INTEGER PRIMARY KEY)' }]);
  ctx.http.router.get('/own', () => ({ tables: ctx.db.tables() }));
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
