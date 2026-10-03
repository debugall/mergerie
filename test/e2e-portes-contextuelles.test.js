'use strict';
/* LES MENUS REPLIÉS SE DÉCOUVRENT PAR L'USAGE.
 *
 * Git, Jenkins et Liens démarrent repliés, et l'outil y mène de partout : « Résoudre
 * dans Git → Merge » sur une merge request en conflit, un sous-onglet des Réglages (et, pour le
 * plugin Docker, un dépôt qui porte un compose : voir son propre dépôt). Ce fichier prouve qu'une de ces portes DÉPLIE le menu pour de bon —
 * comme si la case des Réglages avait été cochée — et que les Réglages suivent le menu : le
 * sous-onglet Jenkins n'existe que si le menu Jenkins est visible.
 *
 * Et la modale de session : le champ Jira propose mes tickets, en choisir un remplit la clé et
 * récupère le ticket, comme le bouton.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Portes contextuelles vers les menus repliés', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repo;
  const erreurs = [];
  const nav$ = (tab) => page.locator(`nav button[data-tab="${tab}"]`);
  const masques = () => page.evaluate(() => JSON.parse(localStorage.getItem('mergerie_nav') || '{"masques":[]}').masques);

  before(async () => {
    app = await startApp();
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r.mainSha } }];
    app.state.jiraIssues['PROJ-7'] = {
      key: 'PROJ-7',
      fields: { summary: 'Mettre les paniers en cache', status: { name: 'À faire', statusCategory: { key: 'new' } }, description: 'Le panier se recharge.', issuetype: { name: 'Tâche' }, assignee: { accountId: 'me-test' } },
    };
    app.state.jiraIssues['PROJ-8'] = {
      key: 'PROJ-8',
      fields: { summary: 'Corriger le total', status: { name: 'À faire', statusCategory: { key: 'new' } }, description: 'Le total est faux.', issuetype: { name: 'Bug' }, assignee: { accountId: 'me-test' } },
    };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    repo = (await app.api('POST', '/api/repos', { url: r.url, project: 'grp/app' })).body;
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  test('d’office, Git, Jenkins et Liens sont repliés, et le sous-onglet Jenkins des Réglages avec eux', async () => {
    for (const t of ['git', 'jenkins', 'links']) assert.ok(await nav$(t).isHidden(), `${t} replié`);
    await nav$('admin').click();
    await page.waitForSelector('#tab-admin.active');
    assert.ok(await page.locator('#tab-admin .subnav [data-sub="jenkinscfg"]').isHidden(), 'pas de réglages Jenkins sans menu Jenkins');
    assert.ok(await page.locator('#tab-admin .subnav [data-sub="jiracfg"]').isVisible(), 'les autres sous-onglets restent');
  });

  test('une porte vers un menu replié le déplie, et il reste déplié au rechargement', async () => {
    await page.evaluate(() => navTab('git'));
    await page.waitForSelector('#tab-git.active');
    assert.ok(await nav$('git').isVisible(), 'le menu Git est dans la barre');
    assert.ok(!(await masques()).includes('git'), 'la préférence a suivi');
    await page.reload();
    await page.waitForSelector('nav button[data-tab="git"]:not([hidden])');
    assert.ok(await nav$('links').isHidden(), 'les autres restent repliés');
  });

  test('le sous-onglet Jenkins suit son menu : demandé nommément, il déplie Jenkins ; masqué, il repart', async () => {
    await nav$('admin').click();
    await page.evaluate(() => showAdminSub('jenkinscfg'));
    await page.waitForSelector('#sub-jenkinscfg.active');
    assert.ok(await nav$('jenkins').isVisible(), 'demander les réglages Jenkins déplie le menu');
    assert.ok(await page.locator('#tab-admin .subnav [data-sub="jenkinscfg"]').isVisible());
    // On replie Jenkins par la préférence : le sous-onglet disparaît et l'écran revient sur Git.
    await page.evaluate(() => enregistrerNav([], ['jenkins', 'links']));
    await page.waitForSelector('#tab-admin .subnav [data-sub="jenkinscfg"][hidden]', { state: 'attached' });
    await page.waitForSelector('#sub-gitcfg.active');
  });

  test('la modale de session propose mes tickets Jira, et en choisir un récupère le ticket', async () => {
    await nav$('task').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForSelector('#taskJiraRow:not([hidden])');
    await page.locator('#taskJiraKey').click();
    await page.waitForSelector('#taskJiraOptions:not([hidden]) .combo-opt[data-v="PROJ-8"]');
    assert.equal(await page.locator('#taskJiraOptions .combo-opt[data-v]').count(), 2, 'les deux tickets sont proposés');
    await page.locator('#taskJiraKey').fill('total');
    await page.waitForFunction(() => document.querySelectorAll('#taskJiraOptions .combo-opt[data-v]').length === 1);
    await page.locator('#taskJiraOptions .combo-opt[data-v="PROJ-8"]').dispatchEvent('mousedown');
    await page.waitForFunction(() => /PROJ-8/.test(document.querySelector('#taskJiraStatus').textContent));
    assert.equal(await page.locator('#taskJiraKey').inputValue(), 'PROJ-8');
    assert.match(await page.locator('#taskPrompt').inputValue(), /Le total est faux/);
    assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), 'PROJ-8 Corriger le total');
    assert.ok(await page.locator('#taskJiraOptions').isHidden(), 'la liste se referme');
  });

  test('aucune erreur de page', () => { assert.deepEqual(erreurs, []); });
});
