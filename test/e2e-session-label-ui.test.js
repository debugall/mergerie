'use strict';
/* Le libellé d'une session, dans un VRAI navigateur — et surtout : dans les TROIS formulaires.
 *
 * Le contrat de l'API est éprouvé ailleurs. Ce qui se joue ici, c'est le câblage de l'écran, et
 * il s'est révélé incomplet : le chemin « hors dépôt » a son propre envoi et sa propre relecture,
 * distincts de ceux des sessions sur dépôt. Le champ y était visible, l'enregistrement le
 * perdait — un test passant par l'API n'aurait rien vu.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Libellé de session — les trois formulaires', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    const repo = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body;
    // Une session de chaque famille, sans libellé : c'est l'édition qu'on vient éprouver.
    await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'Coder quelque chose', targets: [{ repo_id: repo.id, branch: 'feat/a' }] });
    await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'Où est la config ?', targets: [{ repo_id: repo.id, branch: 'main' }] });
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(racine, 'projet'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    await app.api('POST', '/api/local-tasks', { prompt: 'Ranger les scripts', dirs: [path.join(racine, 'projet')] });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Trois familles, TROIS câblages : les sessions sur dépôt partagent un envoi, le hors dépôt a
     le sien. Éprouver la première et supposer les autres est exactement ce qui a laissé passer
     le défaut. */
  for (const [kind, liste, titre] of [
    ['code', '#taskList', 'codage'],
    ['explore', '#taskList', 'exploration'],
    ['local', '#localList', 'hors dépôt'],
  ]) {
    test(`${titre} : le libellé s’enregistre et se relit`, async () => {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector(`${liste} .card`);
      const attendu = `Libellé ${titre}`;

      await page.locator(`${liste} .card`).first().locator('[data-tedit], [data-ledit]').first().click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.equal(await page.locator('#taskForm [name="label"]').isVisible(), true,
        'le champ existe pour les trois familles');
      await page.locator('#taskForm [name="label"]').fill(attendu);
      await page.locator('#taskSubmit').click();

      await page.waitForFunction((t) => [...document.querySelectorAll('.task-label')]
        .some((e) => e.textContent.trim() === t), attendu);

      // …et il revient dans le champ quand on rouvre : enregistré ne suffit pas, il faut relu.
      await page.locator(`${liste} .card`).first().locator('[data-tedit], [data-ledit]').first().click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), attendu);
      await page.locator('#taskCancel').click();
    });
  }
});
