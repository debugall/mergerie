'use strict';
async function activate(ctx) {
  ctx.ui.registerDecorator({ id: 'porte', target: 'repo-row' });
  ctx.ui.registerDecorator({ id: 'lancement', target: 'verify-launch' });
  ctx.jobs.register('rien', async (job) => { job.log('fait'); });
  ctx.http.router.post('/lancer', () => ctx.jobs.start('rien', null, { label: 'Un job de plugin' }));
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
