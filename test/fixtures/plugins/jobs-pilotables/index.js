'use strict';
async function activate(ctx) {
  ctx.jobs.register('make', async (job, { dir, target }) => {
    job.log(`$ make ${target}`);
    const r = await job.exec('make', [target], { cwd: dir, allowlist: [target] });
    if (job.isCancelled()) throw new Error('arrêté');
    if (r.code !== 0) throw new Error(`make ${target} a échoué (code ${r.code})`);
  });
  ctx.http.router.post('/lancer', (req) => ctx.jobs.start('make', { dir: String(req.body.dir), target: String(req.body.target) }, { label: `make ${req.body.target}` }));
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
