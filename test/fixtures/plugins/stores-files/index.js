'use strict';
const fs = require('fs');
const path = require('path');

async function activate(ctx) {
  fs.writeFileSync(path.join(ctx.dataDir, 'marque.txt'), 'ici');
  ctx.http.router.get('/dir', () => ({ dir: ctx.dataDir }));
}
async function deactivate() { /* le dossier reste : ce sont ses données */ }
module.exports = { activate, deactivate };
