'use strict';
/* Le suivi en attente, dans un VRAI navigateur — et dans les DEUX câblages.
 *
 * Le contrat de l'API est éprouvé ailleurs. Ce qui se joue ici : le geste. On écrit la remarque
 * PENDANT que la session tourne, donc sur une carte qui se re-rend toutes les secondes et demie ;
 * on l'enregistre ; on la relit ; on la corrige ; et le bouton d'envoi reste hors de portée tant
 * que la session n'est pas finie. La liste hors dépôt a son propre rendu et son propre câblage :
 * l'éprouver séparément est le seul moyen de savoir qu'elle marche aussi.
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

describe('Suivi en attente — l’écran', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let taskId;
  let localId;

  before(async () => {
    app = await startApp();
    await app.configure();
    const repo = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body;
    taskId = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Coder quelque chose', targets: [{ repo_id: repo.id, branch: 'feat/a' }],
    })).body.id;
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(racine, 'projet'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    localId = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Ranger les scripts', dirs: [path.join(racine, 'projet')],
    })).body.id;

    /* « En cours » sans faire tourner d'agent : c'est l'ÉTAT qui décide de ce que la carte
       propose, et le reproduire à la main rend le test instantané et déterministe. */
    app.db.prepare("UPDATE task SET status = 'running' WHERE id = ?").run(taskId);
    app.db.prepare("UPDATE local_task SET status = 'running' WHERE id = ?").run(localId);

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Les deux familles, leurs deux câblages, les mêmes gestes.
  for (const [kind, liste, ouvrir, enregistrer] of [
    ['code', '#taskList', '[data-tfollow]', '[data-followsave]'],
    ['local', '#localList', '[data-lfollow]', '[data-lfollowsave]'],
  ]) {
    test(`${kind} : on prépare un suivi pendant que la session tourne`, async () => {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector(`${liste} .card`);

      const bouton = page.locator(`${liste} ${ouvrir}`).first();
      assert.match(await bouton.textContent(), /Préparer un suivi/,
        'sur une session qui tourne, on ne « demande pas une correction » : on prépare');
      await bouton.click();

      const form = page.locator(`${liste} .followup`).first();
      await form.waitFor({ state: 'visible' });
      assert.equal(await form.locator('[data-followsubmit], [data-lfollowsubmit]').count(), 0,
        'rien à lancer tant que la session tourne — le bouton n’existe pas, il ne trompe personne');

      await form.locator('.followup-text').fill('Pense aux tests');
      await form.locator(enregistrer).click();

      const bloc = page.locator(`${liste} .followup-draft`).first();
      await bloc.waitFor({ state: 'visible' });
      assert.match(await bloc.textContent(), /Pense aux tests/, 'le suivi reste sous les yeux');
      assert.equal(await bloc.locator('button[data-followsend], button[data-lfollowsend]').isDisabled(), true,
        'la session tourne encore : le bouton est là, visible, mais hors de portée');
    });

    test(`${kind} : on le corrige tant qu’il n’est pas parti`, async () => {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector(`${liste} .followup-draft`);
      await page.locator(`${liste} [data-followedit], ${liste} [data-lfollowedit]`).first().click();

      const form = page.locator(`${liste} .followup`).first();
      await form.waitFor({ state: 'visible' });
      assert.equal(await form.locator('.followup-text').inputValue(), 'Pense aux tests',
        'le formulaire rouvre AVEC le texte : on corrige, on ne réécrit pas');

      await form.locator('.followup-text').fill('Pense aux tests ET au README');
      await form.locator(enregistrer).click();
      await page.waitForFunction(
        (sel) => /README/.test((document.querySelector(sel) || {}).textContent || ''),
        `${liste} .followup-draft`,
      );
    });

    /* Une session qui tourne recharge sa liste sans arrêt. Un suivi à moitié écrit doit y
       survivre : sinon il disparaît sous les doigts, et on ne le retape pas deux fois. */
    test(`${kind} : le texte en cours de frappe survit à un rafraîchissement`, async () => {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector(`${liste} .followup-draft`);
      await page.locator(`${liste} [data-followedit], ${liste} [data-lfollowedit]`).first().click();
      const form = page.locator(`${liste} .followup`).first();
      await form.locator('.followup-text').fill('phrase à moitié tapée');

      await form.locator('.followup-auto').check();
      /* On force le re-rendu et on attend qu'il ait EU LIEU — la carte est reconstruite, donc
         on guette le remplacement du nœud plutôt qu'un délai : mesurer trop tôt lirait l'ancien
         formulaire et le test passerait sans rien prouver. */
      await page.evaluate(() => {
        document.querySelector('#taskList').dataset.rendu = '';
        const fin = window.loadTasks();
        Promise.resolve(fin).then(() => { document.querySelector('#taskList').dataset.rendu = '1'; });
      });
      await page.waitForFunction(() => document.querySelector('#taskList').dataset.rendu === '1');
      assert.equal(await form.locator('.followup-text').inputValue(), 'phrase à moitié tapée',
        'le rendu suivant ne doit pas manger la saisie en cours');
      assert.equal(await form.locator('.followup-auto').isChecked(), true,
        'la case cochée fait partie de la saisie : la perdre en silence enverrait le suivi à la main sans le savoir');
    });

    /* Armer, c'est décider. La carte doit le DIRE — sinon on croit avoir un suivi qui attend
       alors qu'il partira tout seul, ou l'inverse. */
    test(`${kind} : la case « automatique » est retenue et annoncée`, async () => {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector(`${liste} .followup-draft`);
      await page.locator(`${liste} [data-followedit], ${liste} [data-lfollowedit]`).first().click();
      const form = page.locator(`${liste} .followup`).first();
      await form.locator('.followup-text').fill('Pense aux tests');
      await form.locator('.followup-auto').check();
      await form.locator(enregistrer).click();

      const bloc = page.locator(`${liste} .followup-draft.is-auto`).first();
      await bloc.waitFor({ state: 'visible' });
      assert.match(await bloc.textContent(), /Suivi armé/, 'la carte annonce qu’il partira seul');

      await page.locator(`${liste} [data-followedit], ${liste} [data-lfollowedit]`).first().click();
      assert.equal(await form.locator('.followup-auto').isChecked(), true,
        'rouvrir le suivi doit montrer l’état réel : une case qui se décoche à la relecture ment');
    });
  }

  test('la session finie, le suivi peut enfin partir', async () => {
    app.db.prepare("UPDATE task SET status = 'committed' WHERE id = ?").run(taskId);
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.evaluate(() => window.loadTasks());
    await page.waitForFunction(() => {
      const b = document.querySelector('#taskList [data-followsend]');
      return b && !b.disabled;
    });

    await page.locator('#taskList [data-followsend]').first().click();
    // Parti = consommé : le bloc disparaît, il n'y a plus rien en attente.
    await page.waitForSelector('#taskList .followup-draft', { state: 'detached' });
    const t = (await app.api('GET', '/api/tasks')).body.find((x) => x.id === taskId);
    assert.equal(t.followup_draft, null);
  });
});
