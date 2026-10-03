'use strict';
/* La doublure du plugin Liens : les adresses par environnement d'un dépôt, posées par le test, rendues par `links.forRepo` — la porte que Jenkins (build-links)
   emprunte. Prouve que le cœur et Jenkins ne dépendent que du SERVICE NOMMÉ, pas du plugin lui-même. */
async function activate(ctx) {
  const parDepot = new Map();
  ctx.services.register('forRepo', ({ repo_id }) => ({ envs: parDepot.get(Number(repo_id)) || [] }));
  ctx.http.router.post('/set', (req) => { parDepot.set(Number(req.body.repo_id), req.body.envs || []); return { ok: true }; });
  // Ce que le cœur écrit dans le contexte d'un agent, et la case « local » qu'il propose au compose : des réponses posées par le test, ET ce que le cœur leur a demandé.
  const vus = [];
  ctx.services.register('servicesOf', ({ repo_id }) => { vus.push(['servicesOf', Number(repo_id)]); return { services: [{ name: 'api', urls: [{ env: 'recette', url: 'https://api.recette.test/' }] }].filter(() => parDepot.has(Number(repo_id))) }; });
  ctx.services.register('localSuggestion', ({ repo_id, project }) => { vus.push(['localSuggestion', Number(repo_id), project]); return { service: { id: 5, name: 'api', project }, environment: { id: 1, name: 'local' }, filled: false }; });
  ctx.http.router.get('/vus', () => ({ vus }));
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
