'use strict';
/* RELANCER N'EST PAS CONTINUER, et le bouton ne le dit pas.
 *
 * Une relance renvoie le PROMPT INITIAL : les suivis envoyés depuis ne sont pas rejoués, et
 * l'agent repart du début sur du travail déjà fait. Le bouton voisine avec ceux dont on se sert
 * tout le temps ; le clic de trop coûte une session d'IA entière. D'où une confirmation — mais
 * SEULEMENT quand quelque chose a déjà tourné : faire barrage à la première mise en route
 * ajouterait un clic à chaque session pour ne protéger de rien.
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

describe('Relancer une session — confirmation', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  const ids = {};

  const aller = async (kind, liste) => {
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForSelector(`${liste} .card`);
  };
  const relance = (liste) => page.locator(`${liste} [data-trun], ${liste} [data-lrun]`).first();
  // Le témoin d'un lancement : une ligne de plus dans la file de jobs, lue côté serveur.
  const jobs = () => app.db.prepare('SELECT COUNT(*) c FROM job').get().c;
  const attendreJob = async (avant, message) => {
    for (let i = 0; i < 60; i += 1) {
      if (jobs() > avant) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(message);
  };

  before(async () => {
    app = await startApp();
    await app.configure();
    const repo = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body;
    ids.code = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Coder quelque chose', targets: [{ repo_id: repo.id, branch: 'feat/a' }],
    })).body.id;
    ids.explore = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est la config ?', targets: [{ repo_id: repo.id, branch: 'main' }],
    })).body.id;
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(racine, 'projet'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    ids.local = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Ranger les scripts', dirs: [path.join(racine, 'projet')],
    })).body.id;

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Jamais lancée : le bouton part au premier clic. Le prouver AVANT d'éprouver la confirmation
     évite de croire à un garde-fou qui ne serait qu'un bouton cassé. */
  test('une session jamais lancée part sans rien demander', async () => {
    await aller('code', '#taskList');
    const avant = jobs();
    await relance('#taskList').click();
    await attendreJob(avant, 'le premier lancement doit partir au clic, sans détour');
    assert.equal(await page.locator('#confirmModal').isHidden(), true,
      'rien n’a encore tourné : il n’y a rien à protéger, et un clic de plus par session ne protège de rien');
  });

  for (const [kind, liste, statut] of [
    ['code', '#taskList', 'committed'],
    ['explore', '#taskList', 'done'],
    ['local', '#localList', 'done'],
  ]) {
    test(`${kind} : une session déjà lancée demande confirmation`, async () => {
      const table = kind === 'local' ? 'local_task' : 'task';
      app.db.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).run(statut, ids[kind]);
      await aller(kind, liste);
      await page.evaluate(() => window.loadTasks());
      await page.waitForFunction((sel) => !!document.querySelector(sel), `${liste} [data-trun], ${liste} [data-lrun]`);

      await relance(liste).click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      assert.match(await page.locator('#confirmText').textContent(), /prompt initial/,
        'la modale doit dire CE QUI se passe, pas seulement demander « es-tu sûr ? »');

      // Annuler ne lance rien : c'est tout l'intérêt.
      await page.locator('#confirmCancel').click();
      await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
      const avant = jobs();
      await relance(liste).click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      await page.locator('#confirmOk').click();
      await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
      await attendreJob(avant, 'confirmer doit lancer : un garde-fou qui bloque tout est un bouton cassé');
    });
  }
});
