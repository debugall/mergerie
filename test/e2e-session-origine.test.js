'use strict';
/* REJOINDRE LA SESSION DE CODAGE QUI A PRODUIT UNE MERGE REQUEST, depuis Reviews.
 *
 * La puce « Session #N » n'existait que dans l'en-tête du rapport : depuis la file, il fallait
 * ouvrir le rapport — ou retrouver la carte dans Dev IA à la main. Ce que le test prouve : la
 * liste porte la session d'origine (dépôt + branche, la plus récente), la carte « à traiter » et
 * le menu ⋯ la proposent, et le clic atterrit sur la carte de la session dans Dev IA — même
 * RANGÉE : la liste la révèle au lieu de ne mener nulle part — et la carte reste MARQUÉE, nommée
 * par un bandeau, jusqu'à ce qu'on clique ailleurs. Une branche sans session ne porte rien. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('La session d’origine d’une merge request, depuis Reviews', () => {
  let app; let gl; let repoId; let taskId;
  const GL = 'grp/app';
  const ids = {};

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/1' });
    const mrGl = (iid) => ({
      iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
      web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: `${iid}`.repeat(40).slice(0, 40),
      created_at: `2026-01-0${iid}T10:00:00.000Z`, author: { name: 'Alice', username: 'alice' },
    });
    app.state.mrs[GL] = [mrGl(1), mrGl(2)];
    await app.configure();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) { ids[m.iid] = m.id; repoId = m.repo_id; }
    const now = new Date().toISOString();
    // Deux sessions ont travaillé sur feature/1 : la plus récente est celle qu'on rejoint. Elle est RANGÉE.
    const ancienne = Number(app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'Première passe', 'feature/1', 'done', ?, ?)`).run(repoId, now, now).lastInsertRowid);
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?, ?, 'feature/1', 'main', 'pushed', ?)`).run(ancienne, repoId, now);
    taskId = Number(app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, label, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'Ajouter le calcul de TVA', 'TVA annuelle', 'feature/1', 'done', ?, ?)`).run(repoId, now, now).lastInsertRowid);
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?, ?, 'feature/1', 'main', 'pushed', ?)`).run(taskId, repoId, now);
    // Rangée comme l'écran le fait : une préférence de CE poste, posée par la route, pas une colonne.
    assert.equal((await app.api('POST', `/api/tasks/${taskId}/hidden`, { hidden: true })).status, 200);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}`)).body.task.hidden, 1);
  });

  after(async () => { if (app) await app.stop(); });

  test('la liste porte la session d’origine de chaque merge request — la plus récente sur la branche, rien sans session', async () => {
    const liste = (await app.api('GET', '/api/mrs')).body;
    const m1 = liste.find((m) => m.iid === 1);
    assert.deepEqual(m1.origin_task, { id: taskId, status: 'done', kind: 'code', label: 'TVA annuelle' });
    assert.equal(liste.find((m) => m.iid === 2).origin_task, null);
    assert.equal((await app.api('GET', `/api/mrs/${ids[1]}`)).body.origin_task.id, taskId, 'le rapport dit la même session');
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];

    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
      await page.locator(`#toReviewList .card[data-id="${ids[1]}"]`).waitFor({ state: 'visible' });
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('la carte porte la puce de session et le menu ⋯ la propose ; la branche sans session n’a rien', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      const puce = carte.locator('.card-tags [data-go-session]');
      await puce.waitFor({ state: 'visible' });
      assert.match(await puce.innerText(), new RegExp(`#${taskId}`));
      assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[2]}"] [data-go-session]`).count(), 0);
      await carte.locator('[data-more]').click();
      const item = carte.locator(`.split-menu [data-go-session="${taskId}"]`);
      await item.waitFor({ state: 'visible' });
      assert.match(await item.innerText(), /session de codage|coding session/);
      await page.keyboard.press('Escape');
    });

    test('le clic atterrit sur la carte de la session dans Dev IA, même rangée — marquée et nommée tant qu’on n’a pas cliqué ailleurs', async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_show_hidden')), null, 'les sessions rangées sont cachées au départ');
      await page.locator(`#toReviewList .card[data-id="${ids[1]}"] .card-tags [data-go-session]`).click();
      await page.waitForSelector('#tab-task.active');
      const sel = `#taskList .task-row[data-task="${taskId}"]`;
      // Le contour tient ; le balayage, lui, ne part qu'une fois le défilement fini.
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && c.classList.contains('landed'); }, sel);
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && c.classList.contains('just-landed'); }, sel);
      assert.ok(await page.locator('#taskShowHidden').isChecked(), 'la case « sessions masquées » a été cochée pour la révéler');
      assert.match(await page.locator(sel).innerText(), /TVA annuelle/);
      // Le bandeau dit laquelle, d'où, et que des filtres ont été levés.
      const bandeau = page.locator('#taskLanded');
      await bandeau.waitFor({ state: 'visible' });
      const texte = await bandeau.innerText();
      assert.match(texte, new RegExp(`#${taskId}`));
      assert.match(texte, /!1/); assert.match(texte, /grp\/app/); assert.match(texte, /feature\/1/);
      assert.match(texte, /masquées|hidden sessions/, 'on dit que la liste a dû lever le rangement');
      // Un re-rendu de la liste (toutes les 1,5 s en vrai) ne retire pas le contour.
      await page.evaluate(() => renderTasks());
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && c.classList.contains('landed'); }, sel);
      // Un clic DANS la carte ne lève rien ; Échap, si.
      await page.locator(sel).click({ position: { x: 4, y: 4 } });
      assert.ok(await page.locator(sel).evaluate((c) => c.classList.contains('landed')));
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && !c.classList.contains('landed'); }, sel);
      assert.ok(await bandeau.isHidden(), 'le bandeau part avec le contour');
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('un clic ailleurs lève le marquage ; « Voir la carte » y ramène', async () => {
      await page.locator(`nav button[data-tab="review"]`).click();
      await page.locator(`#toReviewList .card[data-id="${ids[1]}"] .card-tags [data-go-session]`).click();
      const sel = `#taskList .task-row[data-task="${taskId}"]`;
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && c.classList.contains('landed'); }, sel);
      await page.locator('#taskLanded [data-landed-show]').click();
      assert.ok(await page.locator(sel).evaluate((c) => c.classList.contains('landed')), 'le bouton du bandeau ne lève pas le marquage');
      await page.locator('#taskSearch').click();
      await page.waitForFunction((s) => { const c = document.querySelector(s); return c && !c.classList.contains('landed'); }, sel);
      assert.ok(await page.locator('#taskLanded').isHidden());
    });
  });
});
