'use strict';
/* MENU JIRA — LA PRÉCISION TECHNIQUE D'UN TICKET, À L'ÉCRAN.
 *
 * Depuis le détail d'un ticket : choisir des dépôts (un filtre qui masque sans décocher),
 * joindre une page Confluence, un complément, lancer ; la proposition arrive sans recharger ;
 * un suivi la réécrit, une édition à la main l'ajuste ; poster demande confirmation et met à
 * jour le MÊME commentaire la fois d'après. Dans Dev IA, la session d'analyse porte la clé du
 * ticket et se masque d'une pastille — qui survit au rechargement. Une epic lance un lot. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const adf = (texte) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texte }] }] });

describe('Menu Jira — précision technique d’un ticket', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];
  const appels = (motif, methode = null) => app.state.calls.filter((c) => motif.test(c.path) && (!methode || c.method === methode));

  async function ouvrirJira() {
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('aidevtools_jira') || k === 'aidevtools_tab') localStorage.removeItem(k);
    });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.waitForSelector('#jiraList .jira-item');
    await page.waitForSelector('#jiraDetail .jira-detail-inner');
  }
  async function ouvrirTicket(cle, titre) {
    await page.locator(`#jiraList [data-jira="${cle}"]`).click();
    await page.waitForFunction(([k, t]) => document.querySelector('#jiraDetail .jira-key-copy')?.textContent === k
      && (document.querySelector('#jiraDetail .jira-title')?.textContent || '').includes(t), [cle, titre]);
  }
  const boite = () => page.locator('#jiraDetail [data-spec-box="PROJ-20"]');
  const attendreStatut = (st) => page.waitForSelector(`#jiraDetail [data-spec-box="PROJ-20"] .jira-spec-status.is-${st}`, { timeout: 90000 });

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'specui-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    const commun = { assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, updated: '2026-09-10T10:00:00.000+0000', status: etat('À faire', 'new'), issuetype: { name: 'Story' } };
    const epic = { key: 'PROJ-200', fields: { summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
    app.state.jiraIssues['PROJ-200'] = { key: 'PROJ-200', fields: { ...commun, summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
    app.state.jiraIssues['PROJ-20'] = { key: 'PROJ-20', fields: { ...commun, summary: 'Paiement en trois fois', parent: epic, description: adf('Le client peut payer en trois fois.') }, comments: [] };
    app.state.jiraIssues['PROJ-21'] = { key: 'PROJ-21', fields: { ...commun, summary: 'Avoir sur facture', parent: epic, description: adf('Émettre un avoir.') }, comments: [] };
    app.state.confluencePages['4242'] = { title: 'Règles TVA', storage: '<p>Le taux <strong>réduit</strong>.</p>' };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('choisir, lancer, voir la proposition arriver — et la pastille sur la carte', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-20', 'Paiement en trois fois');
    const b = boite();
    await b.waitFor({ state: 'visible' });
    await page.locator('#jiraDetail [data-spec-goto="PROJ-20"]').click();
    const form = b.locator('[data-spec-form="PROJ-20"]');
    await form.waitFor({ state: 'visible' });
    // Le filtre des dépôts masque sans décocher.
    await form.locator('[data-spec-repo]').first().check();
    await form.locator('[data-spec-filtre]').fill('zzz');
    assert.equal(await form.locator('.jira-spec-repo:visible').count(), 0, 'la ligne est masquée');
    await form.locator('[data-spec-filtre]').fill('');
    assert.equal(await form.locator('[data-spec-repo]:checked').count(), 1, '…mais reste cochée');
    // Une page Confluence, un complément, pas de questions (le dry-run répond d'un coup).
    await form.locator('[data-spec-page-url]').fill(`${app.gitlabUrl}/wiki/spaces/DEV/pages/4242/Regles-TVA`);
    await form.locator('[data-spec-page-add]').click();
    await b.locator('.jira-spec-pages li').waitFor({ state: 'visible' });
    const form2 = b.locator('[data-spec-form="PROJ-20"]');
    await form2.locator('[data-spec-complement]').fill('C’est le service billing.');
    await form2.locator('[data-spec-ask]').uncheck();
    await form2.locator('button[type="submit"]').click();
    await attendreStatut('running').catch(() => null); // peut déjà être passée en dry-run
    await attendreStatut('proposed');
    assert.equal(await b.locator('.jira-spec-md h2').count(), 6, 'les six sections, rendues');
    assert.match(await b.locator('.jira-spec-lues').innerText(), /Règles TVA/, 'la page lue est nommée');
    await page.waitForFunction(() => /propos/.test(document.querySelector('#jiraList [data-spec-chip="PROJ-20"]')?.textContent || ''), null, { timeout: 15000 });
    assert.equal(await form2.count(), 0, 'le formulaire se replie une fois lancé');
  });

  test('un suivi réécrit, une édition ajuste', async () => {
    const b = boite();
    await b.locator('[data-spec-followup]').fill('Plus court.');
    await b.locator('[data-spec-followup-send]').click();
    await attendreStatut('running').catch(() => null);
    await attendreStatut('proposed');
    await page.waitForFunction(() => /v2/.test(document.querySelector('#jiraDetail [data-spec-box="PROJ-20"] .jira-spec-head')?.textContent || ''), null, { timeout: 30000 });
    await b.locator('[data-spec-edit]').click();
    const ta = b.locator('[data-spec-editor]');
    await ta.waitFor({ state: 'visible' });
    await ta.fill(`${await ta.inputValue()}\n\n## Note du dev\nOn garde l’ancien endpoint.`);
    await b.locator('[data-spec-save]').click();
    await attendreStatut('edited');
    assert.match(await b.locator('.jira-spec-md').innerText(), /Note du dev/);
    assert.match(await b.locator('.jira-spec-head').innerText(), /v3/);
  });

  test('poster demande confirmation, puis met à jour le même commentaire', async () => {
    const b = boite();
    await b.locator('[data-spec-post]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmBody').innerText(), /Note du dev/, 'ce qui part est montré');
    await page.locator('#confirmOk').click();
    await attendreStatut('posted');
    assert.equal(appels(/\/issue\/PROJ-20\/comment/, 'POST').length, 1);
    assert.equal(app.state.jiraIssues['PROJ-20'].comments.length, 1, 'un commentaire sur le ticket');
    assert.match(await b.locator('.jira-spec-head').innerText(), /v3/);
    // Le fil des commentaires du ticket, à l'écran, le montre déjà.
    await page.waitForFunction(() => /Précision technique — Mergerie v3/.test(document.querySelector('#jiraDetail')?.textContent || ''));
    // Une retouche, et on reposte : « Mettre à jour », un PUT, toujours un seul commentaire.
    await b.locator('[data-spec-edit]').click();
    const ta = b.locator('[data-spec-editor]');
    await ta.fill(`${await ta.inputValue()}\nRelu.`);
    await b.locator('[data-spec-save]').click();
    await attendreStatut('edited');
    assert.match(await b.locator('[data-spec-post]').innerText(), /Mettre à jour/);
    await b.locator('[data-spec-post]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreStatut('posted');
    await attendreServeur(() => appels(/\/issue\/PROJ-20\/comment\/\d+$/, 'PUT').length === 1, 'le PUT du commentaire');
    assert.equal(appels(/\/issue\/PROJ-20\/comment/, 'POST').length, 1, 'aucun second commentaire');
    assert.equal(app.state.jiraIssues['PROJ-20'].comments.length, 1);
  });

  test('Dev IA : la session porte la clé du ticket, et une pastille la masque — mémorisée', async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    const carte = page.locator('#taskList .card .task-spec');
    await carte.first().waitFor({ state: 'visible' });
    assert.match(await carte.first().innerText(), /PROJ-20/);
    const chips = page.locator('#taskSpecFiltre');
    await chips.waitFor({ state: 'visible' });
    await chips.locator('[data-task-spec="sans"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card .task-spec').length === 0);
    await chips.locator('[data-task-spec="seulement"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card .task-spec').length >= 1);
    assert.equal(await page.locator('#taskList .card').count(), await page.locator('#taskList .card .task-spec').count(), 'seulement les analyses');
    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    await page.waitForSelector('#taskSpecFiltre [data-task-spec="seulement"].active');
    // La pastille de la carte ramène au ticket.
    await page.locator('#taskList .card .task-spec').first().click();
    await page.waitForFunction(() => document.querySelector('#jiraDetail .jira-key-copy')?.textContent === 'PROJ-20');
    await page.evaluate(() => localStorage.removeItem('mergerie_task_spec'));
  });

  test('une epic : les tickets cochables, un lot lancé', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-20', 'Paiement en trois fois');
    const b = boite();
    await b.locator('[data-spec-form-open]').click();
    const form = b.locator('[data-spec-form="PROJ-20"]');
    await form.waitFor({ state: 'visible' });
    await form.locator('[data-spec-epic-lot="PROJ-200"]').click();
    await page.waitForSelector('#confirmModal:not([hidden]) [data-lot-key]');
    assert.equal(await page.locator('#confirmBody [data-lot-key="PROJ-21"]').isChecked(), true);
    assert.equal(await page.locator('#confirmBody [data-lot-key="PROJ-20"]').isChecked(), false, 'déjà précisé : décoché d’office');
    await page.locator('#confirmBody [data-lot-filtre]').fill('avoir');
    assert.equal(await page.locator('#confirmBody .jira-spec-lot .jira-spec-repo:visible').count(), 1, 'le filtre masque sans décocher');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await app.api('GET', '/api/jira/spec/PROJ-21')).body.spec?.status === 'proposed', 'la spec de PROJ-21', 90000);
    const s21 = (await app.api('GET', '/api/jira/spec/PROJ-21')).body.spec;
    assert.equal(s21.epic_key, 'PROJ-200');
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-20')).body.spec.version, 4, 'le ticket décoché n’a pas été relancé');
    assert.deepEqual(erreurs, [], 'aucune erreur de page');
  });
});
