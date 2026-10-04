'use strict';
/* LES CASES D'UNE NOUVELLE SESSION ET LE GABARIT JIRA, dans un vrai navigateur : affichées (libellés traduits, « i » rempli, placeholder = le message livré, en
   français puis en anglais), éditées (cochées, décochées, relues après rechargement, gabarit multi-ligne), indépendantes l'une de l'autre, et — surtout — EFFICACES :
   ce qu'on règle ici est ce que la fenêtre de nouvelle session coche d'office. Chaque geste est jugé sur son EFFET (l'API, la case de la fenêtre), pas sur un libellé. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const CASES = ['task_default_auto_push', 'task_default_ask_questions', 'task_default_converge'];
const MODALE = { task_default_auto_push: 'auto_push', task_default_ask_questions: 'ask_questions', task_default_converge: 'converge_after', task_default_notify_jira: 'notify_jira' };

describe('Réglages — cases d’une nouvelle session et gabarit Jira : affichage et édition', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure({ jira_url: 'https://jira.defauts.test', jira_email: 'moi@defauts.test', jira_token: 'jt-defauts' });
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  const config = async () => (await app.api('GET', '/api/config')).body;
  const ouvrir = async (sub) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
    await page.waitForSelector(`#sub-${sub} .scope-badge`);
    await page.waitForLoadState('networkidle');
  };
  const recharger = async (sub) => { await page.reload(); await page.waitForSelector('nav button[data-tab="admin"]'); await ouvrir(sub); };
  const enregistrer = async (sub) => { await page.locator(`#sub-${sub} button[type="submit"][form="configForm"]`).first().click(); };
  const coche = (sub, nom) => page.locator(`#sub-${sub} [name="${nom}"]`);

  test('affichage (français) : le titre, trois cases libellées, chacune avec son « i » rempli', async () => {
    await ouvrir('aisession');
    assert.match(await page.locator('#sub-aisession h2[data-i18n="settings.task-defaults.title"]').innerText(), /cases cochées d’office|cases cochées d'office/);
    for (const nom of CASES) {
      const rang = page.locator(`#sub-aisession label:has([name="${nom}"])`);
      assert.equal(await rang.isVisible(), true, `${nom} est affichée`);
      const libelle = (await rang.locator('span').first().innerText()).trim();
      assert.ok(libelle.length > 3 && !/^settings\./.test(libelle), `${nom} : un libellé traduit, pas une clé (« ${libelle} »)`);
      assert.equal(await rang.locator('.hint').isVisible(), true, `${nom} : son « i » est visible`);
      assert.ok(((await rang.locator('.hint').getAttribute('data-tip')) || '').length > 40, `${nom} : l’explication est remplie`);
    }
  });

  test('affichage (français) : « Prévenir Jira », son « i », le gabarit avec le message livré en grisé, les variables et l’aperçu', async () => {
    await ouvrir('jiracfg');
    const rang = page.locator('#sub-jiracfg label:has([name="task_default_notify_jira"])');
    assert.equal(await rang.isVisible(), true);
    assert.ok(((await rang.locator('.hint').getAttribute('data-tip')) || '').length > 40);
    const champ = coche('jiracfg', 'jira_notify_template');
    assert.equal(await champ.isVisible(), true);
    assert.equal(await champ.inputValue(), '', 'vide au départ : c’est le message livré qui partira');
    assert.match(await champ.getAttribute('placeholder'), /Merge request ouverte : !214 sur groupe\/projet/, 'le placeholder montre EXACTEMENT ce message');
    const variables = await page.locator('#sub-jiracfg .template-vars').innerText();
    for (const v of ['{url}', '{iid}', '{project}', '{title}', '{branch}', '{target}', '{key}']) assert.ok(variables.includes(v), `la variable ${v} est expliquée`);
    assert.match(await page.locator('#jiraNotifyPreview').innerText(), /merge_requests\/214/, 'l’aperçu montre le message livré');
  });

  test('affichage (anglais) : mêmes champs, libellés et placeholder traduits, aucune clé brute', async () => {
    await page.evaluate(() => { localStorage.setItem('aidevtools_lang', 'en'); });   // la langue de l'écran est celle du navigateur
    await recharger('aisession');
    const libelles = await page.locator('#sub-aisession label.inline-check span').allInnerTexts();
    assert.ok(libelles.some((l) => /Auto-push/.test(l)) && libelles.some((l) => /ask questions/i.test(l)), JSON.stringify(libelles));
    assert.ok(!libelles.some((l) => /^settings\./.test(l)), 'aucune clé de traduction brute');
    await ouvrir('jiracfg');
    assert.match(await coche('jiracfg', 'jira_notify_template').getAttribute('placeholder'), /Merge request opened: !214 on groupe\/projet/);
    assert.ok(((await page.locator('#sub-jiracfg label:has([name="task_default_notify_jira"]) .hint').getAttribute('data-tip')) || '').includes('Jira'));
    await page.evaluate(() => { localStorage.setItem('aidevtools_lang', 'fr'); });
    await recharger('jiracfg');
  });

  test('édition : chaque case se coche, s’enregistre par le bouton de SON onglet, se relit après rechargement, puis se décoche', async () => {
    const parOnglet = [['aisession', CASES], ['jiracfg', ['task_default_notify_jira']]];
    for (const [sub, noms] of parOnglet) {
      await ouvrir(sub);
      for (const nom of noms) await coche(sub, nom).setChecked(true);
      await enregistrer(sub);
      await attendreServeur(async () => { const c = await config(); return noms.every((n) => String(c[n]) === '1'); }, `${sub} : les cases cochées sont en base`);
      await recharger(sub);
      for (const nom of noms) assert.equal(await coche(sub, nom).isChecked(), true, `${nom} reste cochée après rechargement`);
      for (const nom of noms) await coche(sub, nom).setChecked(false);
      await enregistrer(sub);
      await attendreServeur(async () => { const c = await config(); return noms.every((n) => String(c[n]) === '0'); }, `${sub} : décochées, ce sont des « 0 »`);
      await recharger(sub);
      for (const nom of noms) assert.equal(await coche(sub, nom).isChecked(), false, `${nom} reste décochée après rechargement`);
    }
  });

  test('édition du gabarit : multi-ligne enregistré tel quel, relu après rechargement, aperçu mis à jour, puis vidé', async () => {
    const gabarit = 'MR !{iid} « {title} » ouverte sur {project}\n→ {url}\nBranche : {branch} vers {target}';
    await ouvrir('jiracfg');
    await coche('jiracfg', 'jira_notify_template').fill(gabarit);
    await page.waitForFunction(() => document.querySelector('#jiraNotifyPreview').textContent.includes('MR !214 « Ajout du paiement »'));
    await enregistrer('jiracfg');
    await attendreServeur(async () => (await config()).jira_notify_template === gabarit, 'le gabarit est enregistré, retours à la ligne compris');
    await recharger('jiracfg');
    assert.equal(await coche('jiracfg', 'jira_notify_template').inputValue(), gabarit);
    assert.match(await page.locator('#jiraNotifyPreview').innerText(), /Branche : feature\/PROJ-42-paiement vers main/);

    await coche('jiracfg', 'jira_notify_template').fill('');
    await enregistrer('jiracfg');
    await attendreServeur(async () => (await config()).jira_notify_template === '', 'vidé : on retrouve le message livré');
    await recharger('jiracfg');
    assert.equal(await coche('jiracfg', 'jira_notify_template').inputValue(), '');
    assert.match(await page.locator('#jiraNotifyPreview').innerText(), /merge_requests\/214/);
  });

  test('indépendance : enregistrer les cases de Sessions IA ne touche pas au gabarit Jira, ni l’inverse', async () => {
    await ouvrir('jiracfg');
    await coche('jiracfg', 'jira_notify_template').fill('Gabarit stable : {url}');
    await enregistrer('jiracfg');
    await attendreServeur(async () => (await config()).jira_notify_template === 'Gabarit stable : {url}', 'gabarit posé');
    await ouvrir('aisession');
    await coche('aisession', 'task_default_auto_push').setChecked(true);
    await enregistrer('aisession');
    await attendreServeur(async () => String((await config()).task_default_auto_push) === '1', 'case cochée');
    assert.equal((await config()).jira_notify_template, 'Gabarit stable : {url}', 'le gabarit est intact');
    await ouvrir('jiracfg');
    await coche('jiracfg', 'jira_notify_template').fill('Autre : {url}');
    await enregistrer('jiracfg');
    await attendreServeur(async () => (await config()).jira_notify_template === 'Autre : {url}', 'gabarit changé');
    assert.equal(String((await config()).task_default_auto_push), '1', 'la case de Sessions IA est intacte');
  });

  /* L'EFFET : ce qu'on règle ici, la fenêtre « Nouvelle session » le coche d'office. */
  const ouvrirNouvelleSession = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    const etat = {};
    for (const [reglage, nom] of Object.entries(MODALE)) etat[reglage] = await page.locator(`#taskForm [name="${nom}"]`).evaluate((e) => e.checked);
    const jiraVisible = await page.locator('#taskNotifyJiraRow').isVisible();
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    return { etat, jiraVisible };
  };

  test('effet : cases cochées dans les réglages → cochées d’office dans la fenêtre de nouvelle session (Jira compris, Jira étant configuré)', async () => {
    assert.equal((await app.api('PUT', '/api/config', { task_default_auto_push: 1, task_default_ask_questions: 1, task_default_converge: 1, task_default_notify_jira: 1 })).status, 200);
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
    const { etat, jiraVisible } = await ouvrirNouvelleSession();
    assert.deepEqual(etat, { task_default_auto_push: true, task_default_ask_questions: true, task_default_converge: true, task_default_notify_jira: true });
    assert.equal(jiraVisible, true, 'Jira est configuré : la ligne « Prévenir Jira » est offerte');
  });

  test('effet : cases décochées → décochées dans la fenêtre', async () => {
    assert.equal((await app.api('PUT', '/api/config', { task_default_auto_push: 0, task_default_ask_questions: 0, task_default_converge: 0, task_default_notify_jira: 0 })).status, 200);
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
    const { etat } = await ouvrirNouvelleSession();
    assert.deepEqual(etat, { task_default_auto_push: false, task_default_ask_questions: false, task_default_converge: false, task_default_notify_jira: false });
  });

  test('aucune erreur de page pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
