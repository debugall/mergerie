'use strict';
/* MENU JIRA — LA BRANCHE LUE POUR CHAQUE DÉPÔT, L'ONGLET « ANALYSÉS », LE FILTRE « ANALYSE ».
 *
 * La précision technique d'un ticket lit des dépôts : pour chacun, on choisit AUSSI la branche (une release, une branche de fonctionnalité — le code
 * décrit n'est pas toujours sur la branche par défaut). Les tickets déjà analysés ont leur onglet, et « Mes tickets » se filtre sur eux. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const adf = (texte) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texte }] }] });

describe('Menu Jira — branches lues, onglet Analysés, filtre Analyse', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId;
  const erreurs = [];

  const cartes = () => page.locator('#jiraList [data-jira]').evaluateAll((l) => l.map((x) => x.dataset.jira).sort());
  async function ouvrirJira({ garderFiltre = false } = {}) {
    await page.evaluate((garder) => {
      for (const k of Object.keys(localStorage)) if ((k.startsWith('aidevtools_jira') && !(garder && k === 'aidevtools_jira_specfilter')) || k === 'aidevtools_tab') localStorage.removeItem(k);
    }, garderFiltre);
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
  const choisirAnalyse = async (valeur) => {
    await page.locator('#jiraSpecFilterBox > summary').click();
    await page.locator(`#jiraSpecFilterBox input[value="${valeur}"]`).check();
  };
  const boite = (cle) => page.locator(`#jiraDetail [data-spec-box="${cle}"]`);
  const attendreStatut = (cle, st) => page.waitForSelector(`#jiraDetail [data-spec-box="${cle}"] .jira-spec-status.is-${st}`, { timeout: 90000 });
  const specDe = async (cle) => (await app.api('GET', `/api/jira/spec/${cle}`)).body.spec;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'specbr-')), { branch: 'release/2.4' });
    // Une troisième branche, qui existe VRAIMENT sur le dépôt distant : l'exploration la lit.
    for (const args of [['checkout', '-q', '-b', 'feature/autre', 'main'], ['push', '-q', 'origin', 'feature/autre'], ['checkout', '-q', 'main']]) execFileSync('git', args, { cwd: repo.work });
    app.state.branches['grp/app'] = [
      { name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } },
      { name: 'release/2.4', default: false, protected: false, merged: false, commit: { id: repo.branchSha } },
      { name: 'feature/autre', default: false, protected: false, merged: false, commit: { id: repo.mainSha } },
    ];
    const commun = { assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, updated: '2026-09-10T10:00:00.000+0000', status: etat('À faire', 'new'), issuetype: { name: 'Story' } };
    for (const [cle, titre, texte] of [['PROJ-20', 'Paiement en trois fois', 'Payer en trois fois.'], ['PROJ-21', 'Avoir sur facture', 'Émettre un avoir.'], ['PROJ-22', 'Rapport mensuel', 'Un rapport chaque mois.']]) {
      app.state.jiraIssues[cle] = { key: cle, fields: { ...commun, summary: titre, description: adf(texte) }, comments: [] };
    }
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('cocher un dépôt fait apparaître sa branche (recherche dans la liste) ; la branche choisie part, se relit et sert à l’analyse', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-20', 'Paiement en trois fois');
    await page.locator('#jiraDetail [data-spec-goto="PROJ-20"]').click();
    const form = boite('PROJ-20').locator('[data-spec-form="PROJ-20"]');
    await form.waitFor({ state: 'visible' });
    const ligne = form.locator(`[data-spec-row="${repoId}"]`);
    assert.equal(await ligne.locator('.jira-spec-branch').count(), 0, 'pas de branche tant que le dépôt n’est pas coché');
    await ligne.locator('[data-spec-repo]').check();
    await ligne.locator('.jira-spec-branch .cb-search').waitFor({ state: 'visible' });
    await ligne.locator('[data-spec-repo]').uncheck();
    assert.equal(await ligne.locator('.jira-spec-branch').count(), 0, 'décoché : la branche disparaît');
    await ligne.locator('[data-spec-repo]').check();
    // La liste : la branche par défaut (nommée), les autres — et une recherche pour filtrer (un dépôt actif en a des centaines).
    await ligne.locator('.jira-spec-branch .cb-search').click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v="release/2.4"]');
    assert.match(await page.locator('.combo-options:not([hidden]) .combo-opt[data-v=""]').innerText(), /main/, 'l’entrée « par défaut » dit laquelle');
    await ligne.locator('.jira-spec-branch .cb-search').fill('rel');
    await page.waitForFunction(() => document.querySelectorAll('.combo-options:not([hidden]) .combo-opt[data-v]').length === 1);
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-v="release/2.4"]').click();
    assert.equal(await ligne.locator('.jira-spec-branch .spec-branch').inputValue(), 'release/2.4');
    await form.locator('[data-spec-ask]').uncheck();
    await form.locator('button[type="submit"]').click();
    await attendreStatut('PROJ-20', 'proposed');

    const spec = await specDe('PROJ-20');
    assert.deepEqual(spec.repo_branches, { [repoId]: 'release/2.4' });
    // L'exploration lit CETTE branche, pas la branche par défaut.
    const tache = (await app.api('GET', `/api/tasks/${spec.task_id}`)).body.task;
    assert.equal(tache.targets[0].branch, 'release/2.4');
    assert.match(await boite('PROJ-20').locator('.jira-spec-lus').innerText(), /grp\/app \(release\/2\.4\)/, 'la proposition dit quelle branche a été lue');
  });

  test('la branche se relit au rechargement ; décocher le dépôt ne la garde pas ; vide = la branche par défaut', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-20', 'Paiement en trois fois');
    await boite('PROJ-20').locator('[data-spec-form-open]').click();
    const form = boite('PROJ-20').locator('[data-spec-form="PROJ-20"]');
    await form.waitFor({ state: 'visible' });
    const ligne = form.locator(`[data-spec-row="${repoId}"]`);
    assert.equal(await ligne.locator('.spec-branch').inputValue(), 'release/2.4', 'la branche enregistrée est celle du formulaire');
    // Choisir « par défaut » la vide.
    await ligne.locator('.jira-spec-branch .cb-search').click();
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-v=""]').click();
    await form.locator('[data-spec-ask]').uncheck();
    await form.locator('button[type="submit"]').click();
    await attendreServeur(async () => JSON.stringify((await specDe('PROJ-20')).repo_branches) === '{}', 'la branche est vidée');
    await attendreStatut('PROJ-20', 'proposed');
    const tache = (await app.api('GET', `/api/tasks/${(await specDe('PROJ-20')).task_id}`)).body.task;
    assert.ok(!tache.targets[0].branch, 'sans branche choisie, la branche par défaut');
    assert.match(await boite('PROJ-20').locator('.jira-spec-lus').innerText(), /grp\/app \((branche par défaut|default branch)\)/);
  });

  test('une branche invalide est refusée par le serveur ; la prefill de la session de code part de la branche lue', async () => {
    const mauvais = await app.api('POST', '/api/jira/spec', { key: 'PROJ-21', repo_ids: [repoId], repo_branches: { [repoId]: 'bad branch..name' }, ask_questions: false });
    assert.equal(mauvais.status, 400);
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-21')).body.spec, null, 'rien n’est créé');
    const ok = await app.api('POST', '/api/jira/spec', { key: 'PROJ-21', repo_ids: [repoId], repo_branches: { [repoId]: 'feature/autre', 999: 'x' }, ask_questions: false });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.spec.repo_branches, { [repoId]: 'feature/autre' }, 'seules les branches des dépôts retenus sont gardées');
    await attendreServeur(async () => (await specDe('PROJ-21')).status === 'proposed', 'la spec de PROJ-21', 90000);
    const pre = (await app.api('GET', `/api/jira/spec/${(await specDe('PROJ-21')).id}/prefill`)).body;
    assert.equal(pre.repos[0].base_branch, 'feature/autre');
  });

  test('l’onglet « Analysés » liste les tickets précisés, avec dépôts et branches, et ouvre leur détail', async () => {
    await ouvrirJira();
    await page.locator('#tab-jira .subnav [data-jsub="analysed"]').click();
    await page.waitForSelector('#jiraAnaList [data-jiraanaopen]');
    const cles = await page.locator('#jiraAnaList [data-jiraanaopen]').evaluateAll((l) => l.map((x) => x.dataset.jiraanaopen).sort());
    assert.deepEqual(cles, ['PROJ-20', 'PROJ-21'], 'PROJ-22 n’a pas été analysé');
    const carte21 = page.locator('#jiraAnaList [data-jiraanaopen="PROJ-21"]');
    assert.match(await carte21.innerText(), /Avoir sur facture/, 'le titre vient de la photo prise à l’analyse');
    assert.match(await carte21.innerText(), /grp\/app[\s\S]*feature\/autre/);
    assert.match(await carte21.innerText(), /propos|propos/i);
    assert.equal(await page.locator('#jiraAnalysedCount').innerText(), '2', 'la pastille compte les tickets analysés');
    await page.locator('#jiraAnaSearch').fill('avoir');
    assert.equal(await page.locator('#jiraAnaList [data-jiraanaopen]').count(), 1, 'la recherche filtre');
    await page.locator('#jiraAnaSearch').fill('');
    await page.locator('#jiraAnaList [data-jiraanaopen="PROJ-20"]').click();
    await page.waitForFunction(() => document.querySelector('#jiraAnalysedDetail .jira-key-copy')?.textContent === 'PROJ-20');
    await page.waitForSelector('#jiraAnalysedDetail [data-spec-box="PROJ-20"] .jira-spec-status.is-proposed');
    assert.equal(await page.locator('#jiraAnalysedDetail [data-spec-box]').count(), 1, 'le détail s’ouvre dans SON panneau (« Mes tickets » garde le sien)');
  });

  test('« Mes tickets » : le filtre Analyse montre les tickets déjà analysés, ou les autres — et se souvient', async () => {
    await ouvrirJira();
    assert.deepEqual(await cartes(), ['PROJ-20', 'PROJ-21', 'PROJ-22']);
    await choisirAnalyse('done');
    await page.waitForFunction(() => document.querySelectorAll('#jiraList [data-jira]').length === 2);
    assert.deepEqual(await cartes(), ['PROJ-20', 'PROJ-21']);
    await choisirAnalyse('todo');
    await page.waitForFunction(() => document.querySelectorAll('#jiraList [data-jira]').length === 1);
    assert.deepEqual(await cartes(), ['PROJ-22']);
    await ouvrirJira({ garderFiltre: true });
    assert.equal(await page.locator('input[name="jiraSpecFilter"]:checked').getAttribute('value'), 'todo', 'le choix survit au rechargement');
    assert.match(await page.locator('#jiraSpecFilterCount').innerText(), /Pas encore analysés|Not analysed yet/, 'le résumé du menu dit le choix en cours');
    assert.deepEqual(await cartes(), ['PROJ-22']);
  });

  test('analyser un ticket « pas encore analysé » le fait sortir de ce filtre, sans recharger', async () => {
    await ouvrirTicket('PROJ-22', 'Rapport mensuel');
    await page.locator('#jiraDetail [data-spec-goto="PROJ-22"]').click();
    const form = boite('PROJ-22').locator('[data-spec-form="PROJ-22"]');
    await form.waitFor({ state: 'visible' });
    await form.locator('[data-spec-repo]').first().check();
    await form.locator('[data-spec-ask]').uncheck();
    await form.locator('button[type="submit"]').click();
    await attendreStatut('PROJ-22', 'proposed');
    await page.waitForFunction(() => document.querySelectorAll('#jiraList [data-jira]').length === 0, null, { timeout: 30000 });
    await choisirAnalyse('done');
    await page.waitForFunction(() => document.querySelectorAll('#jiraList [data-jira]').length === 3);
    await page.locator('#tab-jira .subnav [data-jsub="analysed"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#jiraAnaList [data-jiraanaopen]').length === 3);
  });

  test('aucune erreur de page', () => { assert.deepEqual(erreurs, []); });
});
