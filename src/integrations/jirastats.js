'use strict';
/* STATISTIQUES D'UN ENSEMBLE DE TICKETS JIRA (Jira → Stats). Les mêmes contraintes que
   « Mes tickets » (assignés, projets, sprints, statuts masqués, terminés) PLUS les filtres de
   champ traduits en JQL — et surtout l'ensemble ENTIER : la liste s'arrête à cent tickets,
   une statistique sur un extrait trié par date de mise à jour ne dirait rien du backlog.
   On pagine donc jusqu'à un plafond, et on le dit quand il est atteint. */
const jira = require('./jira');

const PLAFOND = jira.PLAFOND_PAGES;   // tickets lus au plus : dix pages Jira, quelques secondes
const CHAMPS = 'issuetype,status,issuelinks,parent,subtasks,assignee,project';

/* Les noms de type d'un réglage (« Story, User Story ») : minuscules, sans blancs, dédoublonnés ;
   vide → le défaut. Le nom d'un type est libre d'une instance à l'autre (Bug / Anomalie / Récit). */
function typesDe(texte, defaut) {
  const brut = String(texte || '').trim() || defaut;
  return new Set(brut.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}

/* Les filtres de champ de « Mes tickets », en clauses JQL. ET entre champs, OU dedans : la même
   sémantique que l'écran. Une personne est cochée par son NOM affiché, or Jira Cloud ne filtre
   que par identifiant de compte : on traduit par la liste des assignés connus, et un nom qu'on
   ne sait pas traduire est IGNORÉ et rendu dans `ignores` — l'écran le dit, plutôt que de
   compter en silence sur un périmètre plus large que celui demandé. */
const CLE_TICKET = /^[A-Z][A-Z0-9]{0,20}-[1-9][0-9]{0,9}$/;
const CHAMP_JQL = { type: 'issuetype', priority: 'priority', labels: 'labels', components: 'component', fixVersions: 'fixVersion' };
function clausesFiltres(filtres, people = [], { teamField = '' } = {}) {
  const f = filtres && typeof filtres === 'object' ? filtres : {};
  const clauses = []; const ignores = [];
  const quote = (l) => l.map((x) => `"${x}"`).join(', ');
  /* L'équipe est un champ personnalisé : JQL l'interroge par son identifiant (`cf[10030]`), par la
     valeur (l'identifiant d'équipe). Sans champ connu de l'instance, le critère est ignoré et dit. */
  const equipes = jira.valeursJql(f.team);
  if (equipes.length) {
    const m = /^customfield_(\d+)$/.exec(String(teamField || ''));
    if (m) clauses.push(`cf[${m[1]}] IN (${quote(equipes)})`);
    else for (const v of equipes) ignores.push({ champ: 'team', valeur: v });
  }
  for (const [cle, champ] of Object.entries(CHAMP_JQL)) {
    const vals = jira.valeursJql(f[cle]);
    if (vals.length) clauses.push(`${champ} IN (${quote(vals)})`);
  }
  const epics = [...new Set((f.epic || []).map((x) => String(x).trim().toUpperCase()).filter((x) => CLE_TICKET.test(x)))];
  if (epics.length) clauses.push(`parent IN (${quote(epics)})`);
  for (const cle of ['reporter', 'assignee']) {
    const noms = jira.valeursJql(f[cle]);
    if (!noms.length) continue;
    const ids = []; const perdus = [];
    for (const nom of noms) {
      const p = (people || []).find((x) => x && x.name === nom && /^[A-Za-z0-9:._@|-]{1,128}$/.test(String(x.accountId || '')));
      if (p) ids.push(p.accountId); else perdus.push(nom);
    }
    if (ids.length) clauses.push(`${cle} IN (${quote(ids)})`);
    for (const nom of perdus) ignores.push({ champ: cle, valeur: nom });
  }
  return { clauses, ignores };
}

/* Les comptes, à partir des tickets bruts de Jira (`{ key, fields }`). Pure : testable sans Jira.
   Une US « liée à un bug » : n'importe quel lien, dans les deux sens, une sous-tâche bug, ou un
   parent bug — tout ce que Jira sait relier, sans distinguer le type de lien. */
const nomType = (f) => String((f && f.issuetype && f.issuetype.name) || '').trim().toLowerCase();
function typesLies(f) {
  const out = [];
  for (const l of (f.issuelinks || [])) {
    const autre = (l && (l.inwardIssue || l.outwardIssue)) || null;
    if (autre) out.push(nomType(autre.fields));
  }
  for (const st of (f.subtasks || [])) out.push(nomType(st.fields));
  if (f.parent) out.push(nomType(f.parent.fields));
  return out;
}
/* `workflow` : les états du workflow des projets concernés (`[{ name, cat }]`, dans l'ordre de
   Jira). Donné, le tableau par statut suit CET ordre — Backlog, puis En cours, puis Terminé, comme
   le workflow se lit — sans les états vides ; un statut porté par un ticket mais absent du
   workflow (autre projet) suit, par nombre décroissant. */
function statsDe(issues, { bugTypes, usTypes, workflow = null }) {
  const bugs = bugTypes instanceof Set ? bugTypes : typesDe(bugTypes, 'Bug');
  const us = usTypes instanceof Set ? usTypes : typesDe(usTypes, 'Story, User Story');
  const r = { total: 0, bugs: 0, us: 0, usLieesBug: 0, autres: 0, autresTypes: [], statuts: [], assignes: [], projets: [] };
  const projets = new Set();
  const parStatut = new Map(); const parAssigne = new Map(); const parAutre = new Map();
  for (const i of (issues || [])) {
    const f = (i && i.fields) || {};
    const type = nomType(f);
    r.total += 1;
    if (bugs.has(type)) r.bugs += 1;
    else if (us.has(type)) {
      r.us += 1;
      if (typesLies(f).some((x) => bugs.has(x))) r.usLieesBug += 1;
    } else {
      r.autres += 1;
      // Les « autres » nommés : le nom tel que Jira l'affiche (pas en minuscules), pour le survol de la tuile.
      const nom = String((f.issuetype && f.issuetype.name) || '').trim() || '—';
      parAutre.set(type, { name: nom, n: ((parAutre.get(type) || {}).n || 0) + 1 });
    }
    if (f.project && f.project.key) projets.add(String(f.project.key));
    const nom = (f.status && f.status.name) || '—';
    const cat = (f.status && f.status.statusCategory && f.status.statusCategory.key) || '';
    const e = parStatut.get(nom) || { name: nom, cat, n: 0 };
    e.n += 1; parStatut.set(nom, e);
    // Par personne : l'identifiant de compte fait la clé, le nom affiché l'étiquette ; sans assigné, une ligne à part.
    const a = f.assignee || null;
    const id = a ? String(a.accountId || a.name || a.key || a.displayName || '') : '';
    const pa = parAssigne.get(id) || { accountId: id, name: a ? (a.displayName || a.name || id) : '', n: 0 };
    pa.n += 1; parAssigne.set(id, pa);
  }
  const part = (n) => (r.total ? Math.round((n / r.total) * 1000) / 10 : 0);
  const restants = [...parStatut.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const ordonnes = [];
  for (const st of (Array.isArray(workflow) ? workflow : [])) {
    if (!st || !st.name || ordonnes.some((x) => x.name === st.name)) continue;
    const i = restants.findIndex((x) => x.name === st.name);
    if (i >= 0) ordonnes.push(restants.splice(i, 1)[0]);   // un état sans ticket n'a pas de ligne
  }
  r.statuts = ordonnes.concat(restants).map((s) => ({ ...s, pct: part(s.n) }));
  r.projets = [...projets].sort();
  r.autresTypes = [...parAutre.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  // Les plus chargés d'abord ; « non assigné » en dernier à nombre égal.
  r.assignes = [...parAssigne.values()]
    .sort((a, b) => b.n - a.n || (a.accountId ? 0 : 1) - (b.accountId ? 0 : 1) || a.name.localeCompare(b.name))
    .map((x) => ({ ...x, pct: part(x.n) }));
  return r;
}

/* UNE PLAGE DE DATES, FACULTATIVE : ne garder que les tickets qui ont BOUGÉ dedans, quel que soit
   le mouvement. JQL n'a pas de « quelque chose a changé pendant » : on réunit ce qu'il sait dire —
   créé dans la plage, dernière mise à jour dans la plage (commentaire, édition, pièce jointe…), et
   les champs historisés que `CHANGED DURING` accepte (statut, assigné, priorité, résolution). Un
   ticket modifié dans la plage PUIS encore après n'a plus son `updated` dedans : c'est ce que les
   `CHANGED DURING` rattrapent. Les bornes sont des jours entiers, dans le fuseau du compte Jira. */
const JOUR = /^\d{4}-\d{2}-\d{2}$/;
function clauseMouvement(depuis, jusqua, tz = null) {
  const a = JOUR.test(String(depuis || '')) ? depuis : null;
  const b = JOUR.test(String(jusqua || '')) ? jusqua : null;
  if (!a && !b) return '';
  const deb = jira.dateJql(`${a || '1970-01-01'}T00:00:00`, tz);
  const fin = jira.dateJql(`${b || '2999-12-31'}T23:59:00`, tz);
  const champs = ['status', 'assignee', 'priority', 'resolution'].map((c) => `${c} CHANGED DURING ("${deb}", "${fin}")`);
  return `((created >= "${deb}" AND created <= "${fin}") OR (updated >= "${deb}" AND updated <= "${fin}") OR ${champs.join(' OR ')})`;
}

/* Le tout : contraintes de la liste + filtres de champ + plage → JQL → toutes les pages → comptes. */
async function stats(cfg, { accountIds, includeDone, projects, sprints, hideStatuses, filtres, people, bugTypes, usTypes, depuis, jusqua, tz, workflowDe = null, teamField = '' } = {}) {
  const clauses = jira.jqlDe({ accountIds, includeDone, projects, sprints, hideStatuses });
  const { clauses: cf, ignores } = clausesFiltres(filtres, people, { teamField });
  const plage = clauseMouvement(depuis, jusqua, tz);
  const toutes = [...clauses, ...cf, ...(plage ? [plage] : [])];
  if (!toutes.length) toutes.push('updated >= -365d');   // Jira refuse une recherche sans borne
  const jql = `${toutes.join(' AND ')} ORDER BY updated DESC`;
  const lu = await jira.searchAll(cfg, jql, CHAMPS, PLAFOND);
  /* Le workflow des projets concernés : ceux du filtre, sinon ceux des tickets lus. Demandé à
     l'appelant (il tient le cache) ; sans lui, le tableau ne montre que ce qui porte un ticket. */
  const premier = statsDe(lu.issues, { bugTypes, usTypes });
  const cles = (projects || []).length ? projects : premier.projets;
  let workflow = null;
  if (workflowDe && cles.length) { try { workflow = await workflowDe(cles); } catch { workflow = null; } }
  return { ...(workflow ? statsDe(lu.issues, { bugTypes, usTypes, workflow }) : premier), lus: lu.issues.length, total: lu.total, tronque: lu.tronque, plafond: PLAFOND, ignores, jql };
}

module.exports = { PLAFOND, CHAMPS, typesDe, clausesFiltres, clauseMouvement, searchAll: jira.searchAll, statsDe, stats };
