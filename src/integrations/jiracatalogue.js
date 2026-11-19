'use strict';
/* LES VALEURS QUE LES FILTRES PROPOSENT, LUES DANS LES CATALOGUES DE JIRA.

   Un filtre ne se choisit pas sur un extrait : les sprints, types, composants, versions, labels,
   priorités, epics et projets proposés par Jira → Stats viennent de ce que Jira déclare, pas des cent
   tickets les plus récemment modifiés — un sprint clos, un composant que personne n'a touché ce mois-ci
   restent cochables. Chaque morceau est un appel (ou quelques pages) borné ; c'est à l'appelant de les
   mémoriser (`app/lib/jira.js`, trente minutes), et un morceau qui échoue n'empêche pas les autres.

   Le reste de ce module est PUR : la mise en forme de ce que Jira rend, testable sans Jira. */
const jira = require('./jira');

const CLE_PROJET = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const PAGES_PROJETS = 5;          // 250 projets
const PAGES_LABELS = 3;           // 3 000 labels
const TABLEAUX_PAR_PROJET = 5;
const PAGES_SPRINTS_CLOS = 10;    // 500 sprints clos lus au plus par tableau…
const SPRINTS_CLOS_GARDES = 200;  // …dont on garde les plus récents

const parNom = (a, b) => a.l.localeCompare(b.l, undefined, { numeric: true });
const valeursNommees = (liste) => [...new Map((liste || []).filter((x) => x && x.name)
  .map((x) => [String(x.name), { v: String(x.name), l: String(x.name) }])).values()].sort(parNom);

/** Le détail d'un projet (`/project/{clé}`) → ses types de ticket, composants et versions. */
function metaDeProjet(p) {
  const d = p || {};
  return {
    type: valeursNommees(d.issueTypes),
    components: valeursNommees(d.components),
    // Les versions archivées n'ont plus rien à filtrer : une version livrée, si.
    fixVersions: valeursNommees((d.versions || []).filter((v) => !v.archived)),
  };
}
/** Les sprints d'un tableau, dédoublonnés : en cours et à venir, puis les clos les plus récents. */
function sprintsDeTableaux(listes) {
  const par = new Map();
  for (const s of jira.sprintsDe((listes || []).flat())) par.set(s.v, s);
  const tous = [...par.values()];
  const clos = tous.filter((s) => s.etat === 'closed')
    .sort((a, b) => (a.d && b.d && a.d !== b.d ? (a.d < b.d ? 1 : -1) : Number(b.v) - Number(a.v)))
    .slice(0, SPRINTS_CLOS_GARDES);
  return tous.filter((s) => s.etat !== 'closed').concat(clos);
}

/* ---------- Les appels ---------- */
async function projets(cfg) {
  const out = [];
  for (let page = 0, debut = 0; page < PAGES_PROJETS; page += 1) {
    const d = await jira.jiraGet(cfg, `/rest/api/3/project/search?startAt=${debut}&maxResults=50&orderBy=key`);
    const vals = Array.isArray(d) ? d : (d.values || []);
    for (const p of vals) if (p && p.key) out.push({ v: String(p.key), l: String(p.name || p.key) });
    if (Array.isArray(d) || d.isLast || !vals.length) break;
    debut += vals.length;
  }
  return out;
}
async function priorites(cfg) {
  const d = await jira.jiraGet(cfg, '/rest/api/3/priority');
  return (Array.isArray(d) ? d : (d.values || [])).filter((p) => p && p.name).map((p) => ({ v: String(p.name), l: String(p.name) }));
}
async function labels(cfg) {
  const out = [];
  for (let page = 0, debut = 0; page < PAGES_LABELS; page += 1) {
    const d = await jira.jiraGet(cfg, `/rest/api/3/label?startAt=${debut}&maxResults=1000`);
    const vals = d.values || [];
    for (const l of vals) out.push({ v: String(l), l: String(l) });
    if (d.isLast !== false || !vals.length) break;
    debut += vals.length;
  }
  return out.sort(parNom);
}
async function metaProjet(cfg, cle) {
  if (!CLE_PROJET.test(String(cle || ''))) return metaDeProjet(null);
  return metaDeProjet(await jira.jiraGet(cfg, `/rest/api/3/project/${encodeURIComponent(cle)}`));
}
/* Les sprints d'un projet : ses tableaux (Agile), puis les sprints de chaque tableau scrum. Un tableau
   kanban n'en a pas — Jira répond 400, on passe. */
async function sprintsProjet(cfg, cle) {
  if (!CLE_PROJET.test(String(cle || ''))) return [];
  const t = await jira.jiraGet(cfg, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(cle)}&type=scrum&maxResults=${TABLEAUX_PAR_PROJET}`);
  const listes = [];
  for (const b of (t.values || []).slice(0, TABLEAUX_PAR_PROJET)) {
    try {
      const ouverts = await jira.jiraGet(cfg, `/rest/agile/1.0/board/${encodeURIComponent(b.id)}/sprint?state=active,future&maxResults=50`);
      listes.push(ouverts.values || []);
      for (let page = 0, debut = 0; page < PAGES_SPRINTS_CLOS; page += 1) {
        const d = await jira.jiraGet(cfg, `/rest/agile/1.0/board/${encodeURIComponent(b.id)}/sprint?state=closed&startAt=${debut}&maxResults=50`);
        listes.push(d.values || []);
        if (d.isLast !== false || !(d.values || []).length) break;
        debut += d.values.length;
      }
    } catch { /* tableau sans sprints, ou inaccessible : les autres suffisent */ }
  }
  return sprintsDeTableaux(listes);
}
/** Les epics des projets : une page, les plus récemment touchés d'abord. */
async function epics(cfg, cles) {
  const ok = (cles || []).filter((c) => CLE_PROJET.test(String(c)));
  if (!ok.length) return [];
  const jql = `project IN (${ok.map((c) => `"${c}"`).join(', ')}) AND issuetype = Epic ORDER BY updated DESC`;
  const lu = await jira.searchAll(cfg, jql, 'summary', 100);
  return lu.issues.map((i) => ({ v: i.key, l: `${i.key} — ${(i.fields && i.fields.summary) || ''}` }));
}

module.exports = { metaDeProjet, sprintsDeTableaux, projets, priorites, labels, metaProjet, sprintsProjet, epics, SPRINTS_CLOS_GARDES };
