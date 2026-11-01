'use strict';
/* Jira → Stats : les comptes d'un ensemble de tickets (bugs, US, US liées à un bug, par statut).
   HTTP et rien d'autre : les contraintes sont celles de `/api/jira/tickets`, plus les filtres de
   champ ; la lecture paginée et les comptes vivent dans `integrations/jirastats.js`. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const jira = require('../../integrations/jira');
const jirastats = require('../../integrations/jirastats');
const demoMode = require('../../demo/mode');
const demoJira = require('../../demo/jira');
const { wrap } = require('../http');
const { personnesAssignables, statutsDesProjets, teamFieldId } = require('../lib/jira');

const liste = (v, sep = ',') => String(v || '').split(sep).map((x) => x.trim()).filter(Boolean);

app.get('/api/jira/stats', wrap(async (req, res) => {
  const q = req.query || {};
  const contraintes = {
    accountIds: liste(q.assignees),
    includeDone: q.includeDone === '1',
    projects: liste(q.projects),
    sprints: liste(q.sprints),
    // Séparateur « unité » (U+001F), comme la liste : un nom de statut peut contenir une virgule.
    hideStatuses: liste(q.hideStatuses, '\u001f'),
  };
  // La plage de mouvement, facultative : deux jours « AAAA-MM-JJ », l'un ou l'autre peut manquer.
  const jour = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const plage = { depuis: jour(q.depuis), jusqua: jour(q.jusqua) };
  let filtres = {};
  try { const v = JSON.parse(String(q.filtres || '{}')); if (v && typeof v === 'object' && !Array.isArray(v)) filtres = v; } catch { /* illisible : sans filtre de champ */ }
  const cfg = getConfig();
  const types = { bugTypes: jirastats.typesDe(cfg.jira_stats_bug_types, 'Bug'), usTypes: jirastats.typesDe(cfg.jira_stats_us_types, 'Story, User Story') };
  // Tels que réglés, pour l'écran ; les ensembles en minuscules servent au comptage.
  const nommes = { bug: String(cfg.jira_stats_bug_types || '').trim() || 'Bug', us: String(cfg.jira_stats_us_types || '').trim() || 'Story, User Story' };
  if (demoMode.isDemo()) {
    const lus = demoJira.statsIssues(contraintes, filtres, plage);
    const cles = contraintes.projects.length ? contraintes.projects : jirastats.statsDe(lus, types).projets;
    return res.json({ configured: true, types: nommes, ...jirastats.statsDe(lus, { ...types, workflow: demoJira.projectStatuses(cles) }), lus: lus.length, total: lus.length, tronque: false, plafond: jirastats.PLAFOND, ignores: [] });
  }
  if (!jira.isConfigured(cfg)) return res.json({ configured: false });
  /* Les personnes ne servent qu'à traduire un filtre « rapporteur » ou « assigné » (nom → compte) :
     on ne paie l'appel que si un tel filtre est posé. */
  const besoinPersonnes = ['reporter', 'assignee'].some((k) => Array.isArray(filtres[k]) && filtres[k].length);
  const people = besoinPersonnes ? ((await personnesAssignables(cfg, contraintes.projects)).people || []) : [];
  // Les bornes de la plage s'écrivent dans le fuseau du compte Jira — lu seulement si une plage est posée.
  const tz = (plage.depuis || plage.jusqua) ? await jira.jiraGet(cfg, '/rest/api/3/myself').then((me) => (me && me.timeZone) || null).catch(() => null) : null;
  res.json({ configured: true, types: nommes, ...(await jirastats.stats(cfg, { ...contraintes, filtres, people, ...types, ...plage, tz, workflowDe: (cles) => statutsDesProjets(cfg, cles), teamField: await teamFieldId(cfg) })) });
}));
