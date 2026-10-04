'use strict';
/* La palette Ctrl+K : ses résultats et la note d'usage d'un résultat ouvert. Les entrées des plugins s'y joignent
   (`plugins.palette`), et le seul lien qui reste entre le cœur et les liens de travail — « quel service est lié à ce
   dossier ? » — passe par un service nommé que le plugin `links` expose, absent quand il n'est pas installé. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const jira = require('../../integrations/jira');
const palette = require('../../notes/palette');
const demoMode = require('../../demo/mode');
const plugins = require('../../plugins');
const db = require('../../db');
const verifyLib = require('../../verify/verify');
const { origineDuDossier } = require('../../git/origine-dossier');
const { wrap } = require('../http');

/* Les actions de navigation viennent du CLIENT : lui seul sait ce qu'il sait faire, et les lister côté serveur aurait
   fait deux endroits à tenir d'accord. */
app.post('/api/launcher', wrap(async (req, res) => {
  const body = req.body || {};
  /* Les entrées des plugins actifs (calculées sans réseau) — sur une REQUÊTE seulement : à vide, la palette montre ses
     trois sections (actions, merge requests, sessions récentes), rien d'autre. */
  const desPlugins = String(body.q || '').trim() ? await plugins.palette(body.q, 30) : [];
  const results = palette.launcher(body.q, {
    jiraConfigure: demoMode.isDemo() || jira.isConfigured(getConfig()),
    actions: Array.isArray(body.actions) ? body.actions.slice(0, 60) : [],
    // Les libellés d'agent sont traduits ICI : `palette.js` ne charge pas le dictionnaire.
    agentsMsgs: { ask: t('agents.palette.ask', { name: '{name}' }), investigate: t('agents.palette.investigate') },
    msgs: {
      verify: t('palette.act.verify', { name: '{name}' }),
      gitcmd: t('palette.act.gitcmd', { label: '{label}' }),
    },
  });
  /* Une entrée de plugin qui nomme son groupe (`links`) ouvre la liste, comme les liens le faisaient ; les autres rejoignent
     la section « actions » du cœur, à sa suite — pas une section de plus en fin de liste : l'écran titre chaque groupe contigu. */
  const nommees = desPlugins.filter((e) => e.group !== 'actions');
  const actions = desPlugins.filter((e) => e.group === 'actions');
  const dernier = results.map((r) => r.group).lastIndexOf('actions');
  if (dernier === -1) results.push(...actions); else results.splice(dernier + 1, 0, ...actions);
  results.unshift(...nommees);
  res.json({ results });
}));
app.post('/api/launcher/used', wrap((req, res) => {
  const b = req.body || {};
  res.json(palette.noterUsage(b.kind, b.ref));
}));

/* LA CASE « LOCAL » QUE LE COMPOSE CONNAÎT DÉJÀ. Le plugin Docker affiche un projet compose et sait quels ports il publie ;
   le plugin Liens sait où l'on a rangé le service dans sa grille. Ce qui les relie est du cœur : le dossier a un remote lu
   dans `.git/config`, le remote est un dépôt connu. Rien n'est écrit sans clic — on PROPOSE. */
app.get('/api/links/local-suggestion', wrap(async (req, res) => {
  const vide = { service: null, ports: [] };
  const dir = String(req.query.dir || '').trim();
  if (!dir || !plugins.services.has('links.localSuggestion')) return res.json(vide);
  const remote = origineDuDossier(dir);
  if (!remote) return res.json(vide);
  const cible = db.prepare('SELECT id, project, url FROM repo').all().find((r) => verifyLib.memeDepot(r.url, remote));
  if (!cible) return res.json(vide);
  return res.json(await plugins.services.call('links.localSuggestion', { repo_id: cible.id, project: cible.project }));
}));
