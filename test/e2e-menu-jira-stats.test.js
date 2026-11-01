'use strict';
/* MENU « JIRA » → « STATS » — LES COMPTES D'UN ENSEMBLE DE TICKETS, DANS UN NAVIGATEUR.
 *
 * Ce que l'écran compte et ce que chaque filtre y change : bugs, US, US liées à un bug (par un
 * lien, une sous-tâche ou un parent), la répartition par statut avec son pourcentage ; les
 * filtres — assignés, terminés, filtre de champ — appliqués PAR Jira (on relit la JQL que
 * l'application lui a réellement envoyée), indépendants de ceux de « Mes tickets » ; et les
 * types comptés comme « bug » / « US », réglés dans Réglages → Jira.
 *
 * Le faux Jira est celui de `helpers/mock-gitlab`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const BOB = { accountId: 'bob-1', displayName: 'Bob Leclerc' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const lie = (key, type) => ({ key, fields: { issuetype: { name: type } } });

describe('Menu Jira — Stats : comptes et filtres', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  // La dernière recherche de STATS envoyée à Jira : celle qui demande les liens (`issuelinks`).
  const derniereJqlStats = () => app.state.calls
    .filter((c) => /^\/rest\/api\/3\/search/.test(c.path) && /issuelinks/.test(c.path))
    .map((c) => new URL(c.path, 'http://x').searchParams.get('jql') || '').at(-1) || '';
  const tuile = async (cle) => (await page.locator(`#jiraStatsCorps .stat-tile[data-stats="${cle}"] .stat-val`).innerText()).trim();
  const attendreTotal = (n) => page.waitForFunction((x) => (document.querySelector('#jiraStatsCorps .jira-stats-tuiles') || {}).dataset?.statsTotal === String(x), n);

  async function ouvrirStats() {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('aidevtools_jira') || k === 'aidevtools_tab') localStorage.removeItem(k); });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira [data-jsub="stats"]').click();
  }

  before(async () => {
    app = await startApp();
    app.state.jiraProjectStatuses.PROJ = [{ id: '1', name: 'Tâche', statuses: [
      etat('À faire', 'new'), etat('En cours', 'indeterminate'), etat('Terminé', 'done'),
    ] }];
    const ticket = (key, f) => { app.state.jiraIssues[key] = { key, fields: { issuetype: { name: 'Tâche' }, updated: '2026-09-10T10:00:00.000+0000', assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, status: etat('À faire', 'new'), ...f } }; };
    ticket('PROJ-1', { summary: 'Un bug', issuetype: { name: 'Bug' }, labels: ['facturation'], updated: '2026-08-02T10:00:00.000+0000' });
    ticket('PROJ-2', { summary: 'Une US liée au bug', issuetype: { name: 'Story' }, status: etat('En cours', 'indeterminate'), issuelinks: [{ type: { name: 'Relates' }, inwardIssue: lie('PROJ-1', 'Bug') }] });
    ticket('PROJ-3', { summary: 'Une US avec un bug en sous-tâche', issuetype: { name: 'User Story' }, subtasks: [lie('PROJ-9', 'Bug')] });
    ticket('PROJ-4', { summary: 'Une US sans bug', issuetype: { name: 'Story' }, issuelinks: [{ type: { name: 'Relates' }, outwardIssue: lie('PROJ-5', 'Tâche') }] });
    ticket('PROJ-5', { summary: 'Une tâche', status: etat('En cours', 'indeterminate'), updated: '2026-07-20T10:00:00.000+0000', created: '2026-07-01T10:00:00.000+0000' });
    // Mis à jour hors de la plage d'août, mais son statut a changé dedans : le mouvement compte.
    app.state.jiraStatusChanged['PROJ-5'] = '2026-08-20T10:00:00.000+0000';
    ticket('PROJ-6', { summary: 'Un bug terminé', issuetype: { name: 'Bug' }, status: etat('Terminé', 'done') });
    ticket('PROJ-7', { summary: 'Le bug de Bob', issuetype: { name: 'Bug' }, assignee: BOB });
    // Un compte parti (désactivé) sur un ticket récent, et un collègue assignable sans ticket récent.
    ticket('PROJ-8', { summary: 'Le vieux ticket', issuetype: { name: 'Bug' }, assignee: { accountId: 'old-1', displayName: 'Ancien Parti', active: false } });
    app.state.jiraAssignable = [{ accountId: 'carl-1', displayName: 'Carl Nouveau', active: true }, { accountId: 'old-1', displayName: 'Ancien Parti', active: false }, { accountId: 'app-1', displayName: 'Automation for Jira', accountType: 'app', active: true }];
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('par défaut : mes tickets non terminés — bugs, US, US liées à un bug, et la part de chaque statut', async () => {
    await ouvrirStats();
    await attendreTotal(5);
    const jql = derniereJqlStats();
    assert.match(jql, /assignee IN \("me-test"\)/, 'moi seul, par défaut');
    assert.match(jql, /statusCategory != Done/, 'les terminés sont écartés par Jira');
    assert.equal(await tuile('total'), '5');
    assert.equal(await tuile('bugs'), '1');
    assert.equal(await tuile('us'), '3');
    assert.equal(await tuile('us-linked'), '2', 'un lien entrant et une sous-tâche ; un lien vers une tâche ne compte pas');
    assert.equal(await tuile('others'), '1');
    assert.equal(await page.locator('#jiraStatsCorps .stat-tile[data-stats="others"]').getAttribute('title'), 'Tâche (1)', 'le survol de « Autres types » nomme ces types');
    assert.match(await page.locator('#jiraStatsInfo').innerText(), /5 tickets comptés/);
    // Dans l'ordre du WORKFLOW ; « Terminé », vide, n'a pas de ligne.
    const lignes = await page.locator('#jiraStatsCorps tr[data-stats-status]').allInnerTexts();
    assert.equal(lignes.length, 2);
    assert.match(lignes[0], /À faire\s+3\s+60 %/i);
    assert.match(lignes[1], /En cours\s+2\s+40 %/i);
  });

  test('« Inclure les terminés » : la contrainte part de la JQL, le bug terminé entre dans les comptes', async () => {
    await page.locator('#jiraStatsIncludeDone').check();
    await attendreTotal(6);
    assert.doesNotMatch(derniereJqlStats(), /statusCategory != Done/);
    assert.equal(await tuile('bugs'), '2');
    assert.match((await page.locator('#jiraStatsCorps tr[data-stats-status]').allInnerTexts()).join('\n'), /Terminé\s+1\s+16\.7 %/i);
    await page.locator('#jiraStatsIncludeDone').uncheck();
    await attendreTotal(5);
  });

  test('un filtre de champ (type = Bug) part en JQL, et ne touche pas « Mes tickets »', async () => {
    await page.locator('#jiraStatsFieldFilter > summary').click();
    await page.locator('#jiraStatsFieldFilterPick .cb-search').click();
    await page.locator('#jiraStatsFieldFilterPick .combo-opt[data-v="type"]').click();
    await page.waitForSelector('#jiraStatsFieldFilterBody [data-jscrit="type"]');
    await page.locator('#jiraStatsFieldFilterBody [data-jsval="type"][value="Bug"]').check();
    await attendreTotal(1);
    assert.match(derniereJqlStats(), /issuetype IN \("Bug"\)/);
    assert.equal(await tuile('bugs'), '1');
    assert.equal(await page.locator('#jiraStatsCorps .stat-tile[data-stats="others"]').count(), 0, 'pas de tuile « autres » quand il n’y en a aucun');
    // Indépendance : le filtre de la liste est resté vierge.
    assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_jira_filtres')), null);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('aidevtools_jira_stats_filtres'))), { type: ['Bug'] });
    // La croix du critère le retire, et les comptes reviennent.
    await page.locator('#jiraStatsFieldFilterBody [data-jsdel="type"]').click();
    await attendreTotal(5);
  });

  test('le filtre Assignés : les assignables des projets (comptes actifs), sans les comptes partis ni les applications', async () => {
    await page.locator('#jiraStatsAssigneeFilter > summary').click();
    const noms = await page.locator('#jiraStatsAssigneeFilterBody .jira-sf-item').allInnerTexts();
    assert.ok(noms.some((n) => /Carl Nouveau/.test(n)), 'un collègue assignable sans ticket récent est proposé');
    assert.ok(noms.some((n) => /Bob Leclerc/.test(n)), 'un assigné récent reste proposé');
    assert.ok(!noms.some((n) => /Ancien Parti/.test(n)), 'un compte désactivé n’est pas proposé, même sur un ticket récent');
    assert.ok(!noms.some((n) => /Automation for Jira/.test(n)), 'une application n’est pas une personne');
    assert.match(await page.locator('#jiraStatsAssigneeFilterCount').innerText(), /1\/3/);
    await page.locator('#jiraStatsAssigneeFilter > summary').click();
  });

  test('cocher Bob dans les assignés : sa clé part dans la JQL, son bug est compté', async () => {
    await page.locator('#jiraStatsAssigneeFilter > summary').click();
    await page.locator('#jiraStatsAssigneeFilterBody input[value="bob-1"]').check();
    await attendreTotal(6);
    assert.match(derniereJqlStats(), /assignee IN \("me-test", "bob-1"\)|assignee IN \("bob-1", "me-test"\)/);
    assert.equal(await tuile('bugs'), '2');
    // Par assigné : moi (5), Bob (1), les plus chargés d'abord.
    const parAssigne = await page.locator('#jiraStatsCorps tr[data-stats-assignee]').allInnerTexts();
    assert.equal(parAssigne.length, 2);
    assert.match(parAssigne[0], /Testeur courant.*5\s+83\.3 %/s);
    assert.match(parAssigne[1], /Bob Leclerc.*1\s+16\.7 %/s);
    assert.match(await page.locator('#jiraStatsAssigneeFilterCount').innerText(), /2\/3/);
  });

  test('au premier passage, Stats hérite des filtres de « Mes tickets » — puis chacun vit sa vie', async () => {
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('aidevtools_jira')) localStorage.removeItem(k);
      localStorage.setItem('aidevtools_jira_assignees', JSON.stringify(['bob-1']));
    });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira [data-jsub="stats"]').click();
    await attendreTotal(1);
    assert.match(derniereJqlStats(), /assignee IN \("bob-1"\)/, 'le choix de la liste est repris');
    assert.equal(await tuile('bugs'), '1');
  });

  test('les types comptés se règlent (Réglages → Jira) et l’écran les suit', async () => {
    const r = await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0', jira_stats_bug_types: 'Bug, Tâche', jira_stats_us_types: 'Story' });
    assert.equal(r.status, 200);
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.jira_stats_bug_types === 'Bug, Tâche', 'les types sont enregistrés');
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('aidevtools_jira')) localStorage.removeItem(k); });
    await page.locator('#jiraStatsRefresh').click();
    await page.waitForFunction(() => /Bug, Tâche/.test((document.querySelector('#jiraStatsCorps .jira-stats-types') || {}).textContent || ''));
    assert.equal(await tuile('bugs'), '2', 'la tâche compte désormais comme un bug');
    assert.equal(await tuile('us'), '2', '« User Story » ne compte plus comme une US');
    assert.equal(await tuile('others'), '1');
    // Le formulaire des réglages montre les deux champs, remplis.
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin [data-sub="jiracfg"]').click();
    await page.waitForFunction(() => (document.querySelector('#sub-jiracfg [name="jira_stats_bug_types"]') || {}).value === 'Bug, Tâche');
    assert.equal(await page.locator('#sub-jiracfg [name="jira_stats_us_types"]').inputValue(), 'Story');
  });

  test('la plage de mouvement, facultative : créé, mis à jour ou changé dedans — et elle part en JQL', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0', jira_stats_bug_types: 'Bug', jira_stats_us_types: 'Story, User Story' });
    await ouvrirStats();   // le test précédent a laissé l'écran sur les Réglages
    await attendreTotal(5);
    assert.equal(await page.locator('#jiraStatsDatesClear').isHidden(), true, 'pas de croix sans plage');
    await page.locator('#jiraStatsDepuis').fill('2026-08-01');
    await page.locator('#jiraStatsJusqua').fill('2026-08-31');
    // PROJ-1 mis à jour en août, PROJ-5 changé d'état en août ; les autres (septembre) sortent.
    await attendreTotal(2);
    const jql = derniereJqlStats();
    assert.match(jql, /created >= "2026-08-01 00:00" AND created <= "2026-08-31 23:59"/);
    assert.match(jql, /updated >= "2026-08-01 00:00"/);
    for (const ch of ['status', 'assignee', 'priority', 'resolution']) assert.match(jql, new RegExp(`${ch} CHANGED DURING \\("2026-08-01 00:00", "2026-08-31 23:59"\\)`));
    assert.equal(await tuile('bugs'), '1'); assert.equal(await tuile('others'), '1');
    assert.match(await page.locator('#jiraStatsInfo').innerText(), /2 tickets comptés · mouvement du/);
    assert.equal(await page.locator('#jiraStatsDatesClear').isHidden(), false);
    // La plage survit à un rechargement de l'onglet, et la croix la retire.
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira [data-jsub="stats"]').click();
    await attendreTotal(2);
    assert.equal(await page.locator('#jiraStatsDepuis').inputValue(), '2026-08-01');
    await page.locator('#jiraStatsDatesClear').click();
    await attendreTotal(5);
    assert.doesNotMatch(derniereJqlStats(), /CHANGED DURING/);
    assert.equal(await page.locator('#jiraStatsDepuis').inputValue(), '');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
