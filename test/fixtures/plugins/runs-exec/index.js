'use strict';
const path = require('path');

const SCRIPT = path.join(__dirname, 'echo.js');

async function activate(ctx) {
  ctx.http.router.get('/run', async () => {
    const r = await ctx.exec(process.execPath, [SCRIPT, '--message=a; touch PWN | $(touch PWN2) `id` "q"'], { allowlist: [SCRIPT], timeoutMs: 15000, env: { RUNS_EXEC_X: 'transmis' } });
    return { code: r.code, out: JSON.parse(r.stdout) };
  });
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
