'use strict';
/* JIRA → STATS, LA PARTIE PURE : les comptes (`statsDe`), les noms de type d'un réglage
   (`typesDe`), les filtres de champ traduits en JQL (`clausesFiltres`) — et la lecture PAGINÉE
   contre un faux Jira en HTTP, dans ses deux formes : par jeton (Cloud, `/search/jql`) et par
   `startAt` (Server/DC, `/search`, quand le premier répond 404). Sans base, sans navigateur. */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jirastats = require('../src/integrations/jirastats.js');

const brut = (key, type, status = 'À faire', cat = 'new', extra = {}) => ({
  key, fields: { issuetype: { name: type }, status: { name: status, statusCategory: { key: cat } }, ...extra },
});
const lie = (type) => ({ key: 'X-1', fields: { issuetype: { name: type } } });

describe('typesDe : les noms de type d’un réglage', () => {
  test('minuscules, blancs retirés, dédoublonnés ; vide → le défaut', () => {
    assert.deepEqual([...jirastats.typesDe(' Bug , Anomalie, bug ', 'Bug')], ['bug', 'anomalie']);
    assert.deepEqual([...jirastats.typesDe('', 'Story, User Story')], ['story', 'user story']);
    assert.deepEqual([...jirastats.typesDe(null, 'Bug')], ['bug']);
  });
});

describe('statsDe : les comptes', () => {
  const types = { bugTypes: 'Bug', usTypes: 'Story, User Story' };
  test('total, bugs, US, autres — et le type se lit sans tenir compte de la casse', () => {
    const r = jirastats.statsDe([brut('A-1', 'BUG'), brut('A-2', 'Story'), brut('A-3', 'user story'), brut('A-4', 'Tâche'), brut('A-5', 'Epic'), brut('A-6', 'Tâche')], types);
    assert.equal(r.total, 6); assert.equal(r.bugs, 1); assert.equal(r.us, 2); assert.equal(r.autres, 3);
    assert.deepEqual(r.autresTypes, [{ name: 'Tâche', n: 2 }, { name: 'Epic', n: 1 }], 'les autres types nommés, les plus nombreux d’abord');
  });
  test('une US est « liée à un bug » par un lien entrant, sortant, une sous-tâche ou un parent — un lien vers une tâche ne compte pas', () => {
    const r = jirastats.statsDe([
      brut('A-1', 'Story', 'À faire', 'new', { issuelinks: [{ inwardIssue: lie('Bug') }] }),
      brut('A-2', 'Story', 'À faire', 'new', { issuelinks: [{ outwardIssue: lie('Bug') }] }),
      brut('A-3', 'Story', 'À faire', 'new', { subtasks: [lie('Bug')] }),
      brut('A-4', 'Story', 'À faire', 'new', { parent: lie('Bug') }),
      brut('A-5', 'Story', 'À faire', 'new', { issuelinks: [{ inwardIssue: lie('Tâche') }] }),
      brut('A-6', 'Bug', 'À faire', 'new', { issuelinks: [{ inwardIssue: lie('Bug') }] }),   // un bug lié à un bug n'est pas une US
    ], types);
    assert.equal(r.us, 5); assert.equal(r.usLieesBug, 4); assert.equal(r.bugs, 1);
  });
  test('par statut : nombre et pourcentage à une décimale, les plus nombreux d’abord', () => {
    const r = jirastats.statsDe([brut('A-1', 'Bug', 'En cours', 'indeterminate'), brut('A-2', 'Bug', 'En cours', 'indeterminate'), brut('A-3', 'Story', 'Terminé', 'done')], types);
    assert.deepEqual(r.statuts, [{ name: 'En cours', cat: 'indeterminate', n: 2, pct: 66.7 }, { name: 'Terminé', cat: 'done', n: 1, pct: 33.3 }]);
  });
  test('avec le workflow : ses états dans son ordre, sans les vides, puis les statuts hors workflow par nombre', () => {
    const workflow = [{ name: 'Backlog', cat: 'new' }, { name: 'En cours', cat: 'indeterminate' }, { name: 'Terminé', cat: 'done' }];
    const r = jirastats.statsDe([
      brut('A-1', 'Bug', 'Terminé', 'done', { project: { key: 'A' } }), brut('A-2', 'Bug', 'En cours', 'indeterminate', { project: { key: 'A' } }),
      brut('B-1', 'Bug', 'Recette', 'indeterminate', { project: { key: 'B' } }),
    ], { ...types, workflow });
    assert.deepEqual(r.statuts, [
      { name: 'En cours', cat: 'indeterminate', n: 1, pct: 33.3 },
      { name: 'Terminé', cat: 'done', n: 1, pct: 33.3 }, { name: 'Recette', cat: 'indeterminate', n: 1, pct: 33.3 },
    ]);
    assert.deepEqual(r.projets, ['A', 'B'], 'les projets lus, pour demander leur workflow');
  });
  test('par assigné : nombre et part par personne, les plus chargés d’abord, « non assigné » à part', () => {
    const bob = { accountId: 'b', displayName: 'Bob' }; const ana = { accountId: 'a', displayName: 'Ana' };
    const r = jirastats.statsDe([
      brut('A-1', 'Bug', 'À faire', 'new', { assignee: bob }), brut('A-2', 'Bug', 'À faire', 'new', { assignee: bob }),
      brut('A-3', 'Bug', 'À faire', 'new', { assignee: ana }), brut('A-4', 'Bug', 'À faire', 'new', { assignee: null }),
    ], types);
    assert.deepEqual(r.assignes, [
      { accountId: 'b', name: 'Bob', n: 2, pct: 50 }, { accountId: 'a', name: 'Ana', n: 1, pct: 25 }, { accountId: '', name: '', n: 1, pct: 25 },
    ]);
  });
  test('vide : des zéros, pas une division par zéro', () => {
    const r = jirastats.statsDe([], types);
    assert.deepEqual(r, { total: 0, bugs: 0, us: 0, usLieesBug: 0, autres: 0, autresTypes: [], statuts: [], assignes: [], projets: [] });
  });
});

describe('clausesFiltres : les filtres de champ en JQL', () => {
  test('ET entre champs, OU dedans ; l’epic par sa clé ; un guillemet dans une valeur est écarté', () => {
    const { clauses, ignores } = jirastats.clausesFiltres({
      type: ['Bug', 'Story'], labels: ['panier'], components: ['api'], fixVersions: ['2.4.0'], priority: ['High'],
      epic: ['PROJ-100', 'pas une clé'], project: ['PROJ'],   // le projet est porté par la liste, pas ici
      labels_bidon: ['x'],
    });
    assert.deepEqual(clauses, [
      'issuetype IN ("Bug", "Story")', 'priority IN ("High")', 'labels IN ("panier")', 'component IN ("api")',
      'fixVersion IN ("2.4.0")', 'parent IN ("PROJ-100")',
    ]);
    assert.deepEqual(ignores, []);
    assert.deepEqual(jirastats.clausesFiltres({ labels: ['a"b'] }).clauses, []);
  });
  test('rapporteur et assigné : le nom affiché devient un identifiant de compte, un inconnu est ignoré et dit', () => {
    const people = [{ accountId: 'acc-1', name: 'Bob Leclerc' }];
    const { clauses, ignores } = jirastats.clausesFiltres({ reporter: ['Bob Leclerc', 'Inconnue'], assignee: ['Bob Leclerc'] }, people);
    assert.deepEqual(clauses, ['reporter IN ("acc-1")', 'assignee IN ("acc-1")']);
    assert.deepEqual(ignores, [{ champ: 'reporter', valeur: 'Inconnue' }]);
  });
  test('l’équipe : un champ personnalisé, interrogé par son identifiant ; sans champ connu, ignoré et dit', () => {
    assert.deepEqual(jirastats.clausesFiltres({ team: ['eq-1', 'eq-2'] }, [], { teamField: 'customfield_10030' }).clauses, ['cf[10030] IN ("eq-1", "eq-2")']);
    assert.deepEqual(jirastats.clausesFiltres({ team: ['eq-1'] }, [], {}).ignores, [{ champ: 'team', valeur: 'eq-1' }]);
  });
  test('sans filtre : rien', () => {
    assert.deepEqual(jirastats.clausesFiltres(null), { clauses: [], ignores: [] });
  });
});

describe('le champ équipe : détection et lecture', () => {
  const jira = require('../src/integrations/jira.js');
  test('repéré par son schéma, sinon par son nom (Team / Équipe), jamais un champ standard', () => {
    assert.deepEqual(jira.detectTeamField([{ id: 'customfield_1', name: 'Squad', marqueur: 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team' }]), { id: 'customfield_1', name: 'Squad' });
    assert.deepEqual(jira.detectTeamField([{ id: 'customfield_2', name: 'Équipe', marqueur: 'x' }]), { id: 'customfield_2', name: 'Équipe' });
    assert.equal(jira.detectTeamField([{ id: 'team', name: 'Team', marqueur: '' }]), null);
  });
  test('la valeur : { id, name } récent, { id, title } ancien, ou une chaîne', () => {
    assert.deepEqual(jira.teamDe({ id: 'a1', name: 'Paiement' }), { v: 'a1', l: 'Paiement' });
    assert.deepEqual(jira.teamDe({ id: 7, title: 'Plateforme' }), { v: '7', l: 'Plateforme' });
    assert.deepEqual(jira.teamDe('Tunnel'), { v: 'Tunnel', l: 'Tunnel' });
    assert.equal(jira.teamDe(null), null);
  });
});

describe('clauseMouvement : la plage de dates, facultative', () => {
  test('créé, mis à jour, ou statut / assigné / priorité / résolution changés dans la plage — jours entiers', () => {
    const c = jirastats.clauseMouvement('2026-09-01', '2026-09-30');
    assert.match(c, /^\(\(created >= "2026-09-01 00:00" AND created <= "2026-09-30 23:59"\) OR \(updated >= "2026-09-01 00:00" AND updated <= "2026-09-30 23:59"\)/);
    for (const ch of ['status', 'assignee', 'priority', 'resolution']) assert.match(c, new RegExp(`${ch} CHANGED DURING \\("2026-09-01 00:00", "2026-09-30 23:59"\\)`));
  });
  test('une seule borne suffit ; une date mal formée est ignorée ; rien → pas de clause', () => {
    assert.match(jirastats.clauseMouvement('2026-09-01', ''), /created >= "2026-09-01 00:00" AND created <= "2999-12-31 23:59"/);
    assert.match(jirastats.clauseMouvement('', '2026-09-30'), /created >= "1970-01-01 00:00"/);
    assert.equal(jirastats.clauseMouvement('hier', 'demain'), '');
    assert.equal(jirastats.clauseMouvement(), '');
  });
});

describe('searchAll : toutes les pages, jusqu’au plafond', () => {
  const serveurs = [];
  after(() => serveurs.forEach((s) => s.close()));
  /* Un faux Jira : `cloud` pagine `/search/jql` par jeton ; sinon `/search/jql` répond 404 et
     `/search` pagine par `startAt` avec un `total`. `n` tickets, pages de `maxResults`. */
  function fauxJira({ n, cloud, jetonFantome = false, compte = null }) {
    const appels = [];
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      appels.push(u.pathname + u.search);
      if (u.pathname === '/rest/api/3/search/approximate-count') {
        if (compte == null) { res.writeHead(404); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: compte })); return;
      }
      const max = Number(u.searchParams.get('maxResults'));
      const page = (de) => Array.from({ length: Math.max(0, Math.min(max, n - de)) }, (_, i) => brut(`P-${de + i + 1}`, 'Bug'));
      if (u.pathname === '/rest/api/3/search/jql') {
        if (!cloud) { res.writeHead(404); res.end('{}'); return; }
        const de = Number(u.searchParams.get('nextPageToken') || 0);
        const issues = page(de);
        const dernier = de + issues.length >= n;
        // `jetonFantome` : Jira Cloud tel qu'observé — un jeton rendu AVEC `isLast: true`.
        const suite = !dernier ? String(de + issues.length) : (jetonFantome ? 'fantome' : null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issues, isLast: dernier, ...(suite ? { nextPageToken: suite } : {}) }));
        return;
      }
      if (u.pathname === '/rest/api/3/search') {
        const de = Number(u.searchParams.get('startAt') || 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issues: page(de), total: n, startAt: de }));
        return;
      }
      res.writeHead(500); res.end();
    });
    serveurs.push(srv);
    return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ cfg: { jira_url: `http://127.0.0.1:${srv.address().port}`, jira_email: 'a@b', jira_token: 't' }, appels })));
  }
  test('Cloud : suit le jeton de page jusqu’au bout, et dit le total lu', async () => {
    const { cfg, appels } = await fauxJira({ n: 250, cloud: true });
    const r = await jirastats.searchAll(cfg, 'project = P', 'issuetype', 1000);
    assert.equal(r.issues.length, 250); assert.equal(r.total, 250); assert.equal(r.tronque, false);
    assert.equal(appels.length, 3);
    assert.ok(appels.every((a) => a.startsWith('/rest/api/3/search/jql?')));
  });
  test('Server/DC : repli sur /search et startAt quand /search/jql répond 404', async () => {
    const { cfg, appels } = await fauxJira({ n: 150, cloud: false });
    const r = await jirastats.searchAll(cfg, 'project = P', 'issuetype', 1000);
    assert.equal(r.issues.length, 150); assert.equal(r.total, 150);
    assert.deepEqual(appels.filter((a) => a.startsWith('/rest/api/3/search?')).map((a) => new URL(a, 'http://x').searchParams.get('startAt')), ['0', '100']);
  });
  test('le plafond : on s’arrête, on le dit, et Cloud donne le total par le compte approché', async () => {
    const { cfg, appels } = await fauxJira({ n: 500, cloud: true, compte: 500 });
    const r = await jirastats.searchAll(cfg, 'project = P', 'issuetype', 250);
    assert.equal(r.issues.length, 250); assert.equal(r.tronque, true); assert.equal(r.total, 500);
    assert.ok(appels.some((a) => a.startsWith('/rest/api/3/search/approximate-count')));
  });
  test('le plafond sans compte approché : tronqué, total inconnu', async () => {
    const { cfg } = await fauxJira({ n: 500, cloud: true });
    const r = await jirastats.searchAll(cfg, 'project = P', 'issuetype', 250);
    assert.equal(r.tronque, true); assert.equal(r.total, null);
  });
  test('un jeton rendu avec isLast: true ne relance pas la lecture — ni plafond, ni page fantôme', async () => {
    const { cfg, appels } = await fauxJira({ n: 120, cloud: true, jetonFantome: true });
    const r = await jirastats.searchAll(cfg, 'project = P', 'issuetype', 1000);
    assert.equal(r.issues.length, 120); assert.equal(r.tronque, false); assert.equal(r.total, 120);
    assert.equal(appels.length, 2);
  });
});
