'use strict';
/* « Prévenir Jira à la création de la MR » vit dans Réglages → Jira, avec le gabarit du commentaire : la case n'est plus dans « Général »,
   le gabarit s'édite, son aperçu suit la frappe (valeurs d'exemple), et un gabarit sans {url} est refusé à l'enregistrement.
   Chaque geste est jugé sur son EFFET côté serveur, relu par l'API. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Réglages → Jira : prévenir Jira et son gabarit', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  const ouvrir = async (sub) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
    await page.waitForSelector(`#sub-${sub} .scope-badge`);
    await page.waitForLoadState('networkidle');
  };

  test('la case est dans l’onglet Jira, plus dans Général', async () => {
    assert.equal(await page.locator('#sub-jiracfg [name="task_default_notify_jira"]').count(), 1);
    assert.equal(await page.locator('#sub-config [name="task_default_notify_jira"]').count(), 0);
  });

  test('les autres cases d’une nouvelle session sont dans « Sessions IA », plus dans Général', async () => {
    for (const nom of ['task_default_auto_push', 'task_default_ask_questions', 'task_default_converge']) {
      assert.equal(await page.locator(`#sub-aisession [name="${nom}"]`).count(), 1, nom);
      assert.equal(await page.locator(`#sub-config [name="${nom}"]`).count(), 0, nom);
    }
  });

  test('chaque case d’une nouvelle session porte son « i » d’explication, rempli', async () => {
    await ouvrir('aisession');
    for (const nom of ['task_default_auto_push', 'task_default_ask_questions', 'task_default_converge']) {
      const tip = await page.locator(`#sub-aisession label:has([name="${nom}"]) .hint`).getAttribute('data-tip');
      assert.ok(tip && tip.length > 40, `${nom} : une explication, pas un bouton vide`);
    }
  });

  test('l’aperçu montre le message livré, puis le gabarit tapé avec des valeurs d’exemple', async () => {
    await ouvrir('jiracfg');
    await page.waitForFunction(() => document.querySelector('#jiraNotifyPreview').textContent.includes('214'));
    assert.match(await page.locator('#jiraNotifyPreview').innerText(), /groupe\/projet[\s\S]*merge_requests\/214/, 'vide : le message livré');
    await page.fill('#sub-jiracfg [name="jira_notify_template"]', '[{key}] {title} → {url} {inconnue}');
    await page.waitForFunction(() => document.querySelector('#jiraNotifyPreview').textContent.startsWith('[PROJ-42] Ajout du paiement → https://'));
    assert.match(await page.locator('#jiraNotifyPreview').innerText(), /\{inconnue\}$/, 'une variable inconnue reste telle quelle');
  });

  test('enregistrer : le gabarit et la case sont retenus par le serveur ; sans {url}, refusé', async () => {
    await ouvrir('jiracfg');
    await page.check('#sub-jiracfg [name="task_default_notify_jira"]');
    await page.fill('#sub-jiracfg [name="jira_notify_template"]', 'MR !{iid} : {url}');
    await page.locator('#sub-jiracfg button[type="submit"]').click();
    await attendreServeur(async () => {
      const c = (await app.api('GET', '/api/config')).body;
      return c.jira_notify_template === 'MR !{iid} : {url}' && String(c.task_default_notify_jira) === '1';
    }, 'le gabarit et la case sont enregistrés');

    await page.fill('#sub-jiracfg [name="jira_notify_template"]', 'sans lien');
    await page.locator('#sub-jiracfg button[type="submit"]').click();
    await page.waitForSelector('#toasts .toast.err');
    assert.equal((await app.api('GET', '/api/config')).body.jira_notify_template, 'MR !{iid} : {url}', 'la valeur valide est conservée');
  });

  /* PRÉVENIR JIRA À LA FUSION : sa case et son gabarit, dans le même onglet, avec le même aperçu. */
  test('à la fusion : la case et le gabarit sont là, l’aperçu suit la frappe, le serveur retient les deux', async () => {
    await ouvrir('jiracfg');
    // Le test précédent a laissé « sans lien » dans le gabarit « à la création » : l'enregistrement du formulaire entier serait refusé pour lui.
    await page.fill('#sub-jiracfg [name="jira_notify_template"]', 'MR !{iid} : {url}');
    assert.equal(await page.locator('#sub-jiracfg [name="jira_notify_merge"]').count(), 1);
    const tip = await page.locator('#sub-jiracfg label:has([name="jira_notify_merge"]) .hint').getAttribute('data-tip');
    assert.ok(tip && tip.length > 40, 'la case explique ce qui part, et quand');
    await page.waitForFunction(() => document.querySelector('#jiraMergePreview').textContent.includes('214'));
    assert.match(await page.locator('#jiraMergePreview').innerText(), /merge_requests\/214/, 'vide : le message livré');
    await page.fill('#sub-jiracfg [name="jira_merge_template"]', '[{key}] {title} mergée → {url}');
    await page.waitForFunction(() => document.querySelector('#jiraMergePreview').textContent.startsWith('[PROJ-42] Ajout du paiement mergée → https://'));
    assert.equal(await page.locator('#sub-jiracfg [name="jira_notify_merge"]').isChecked(), false, 'décochée par défaut : écrire sur le ticket se décide');
    await page.check('#sub-jiracfg [name="jira_notify_merge"]');
    await page.locator('#sub-jiracfg button[type="submit"]').click();
    await attendreServeur(async () => {
      const c = (await app.api('GET', '/api/config')).body;
      return c.jira_merge_template === '[{key}] {title} mergée → {url}' && String(c.jira_notify_merge) === '1';
    }, 'la case et le gabarit « à la fusion » sont enregistrés');
    // Rechargé, l'écran relit les deux.
    await ouvrir('config'); await ouvrir('jiracfg');
    await page.waitForFunction(() => document.querySelector('#sub-jiracfg [name="jira_notify_merge"]').checked);
    assert.equal(await page.locator('#sub-jiracfg [name="jira_merge_template"]').inputValue(), '[{key}] {title} mergée → {url}');

    await page.fill('#sub-jiracfg [name="jira_merge_template"]', 'sans lien');
    await page.locator('#sub-jiracfg button[type="submit"]').click();
    await page.waitForSelector('#toasts .toast.err');
    assert.equal((await app.api('GET', '/api/config')).body.jira_merge_template, '[{key}] {title} mergée → {url}', 'sans {url} : refusé, la valeur valide est conservée');
  });
});
