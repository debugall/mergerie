'use strict';
const path = require('path');

const SCRIPT = path.join(__dirname, 'lines.js');

async function activate(ctx) {
  ctx.jobs.register('copie', async (job, payload) => {
    job.message('début');
    job.log(`charge : ${JSON.stringify(payload)}`);
    job.progress(1, 2);
    const r = await job.exec(process.execPath, [SCRIPT, ...(payload && payload.wait ? ['--wait'] : [])], { allowlist: [SCRIPT] });
    if (job.isCancelled()) throw new Error('arrêté');
    if (r.code !== 0) throw new Error(`code ${r.code}`);
    if (payload && payload.fail) throw new Error('échec voulu');
  });
  ctx.http.router.post('/lancer', (req) => ctx.jobs.start('copie', req.body, { label: 'Copie de test' }));
  ctx.http.router.get('/racines', () => ({ roots: ctx.repos.localRoots() }));
  ctx.http.sse('/flux', (req, send, close) => {
    const h = ctx.execStream(process.execPath, [SCRIPT, '--wait'], { allowlist: [SCRIPT] }, (flux, ligne) => send('ligne', { flux, ligne }), (r) => { send('fin', r); });
    return () => h.close();
  });
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
