'use strict';
/* « PLANIFIER D'ABORD », VU DE LA CARTE. La session a rendu son plan : la ligne du projet dit
 * « plan à approuver », propose de le lire, une remarque, et « Approuver et coder ». Un clic, et
 * la session reprend, code, et la ligne passe en « commité ». Et pendant qu'une session tourne,
 * le formulaire de suivi propose « Stopper et reprendre avec cette consigne » à la place de
 * « Lancer l'itération ».
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, makeRemoteRepo, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Sessions · plan à approuver, sur la carte', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repoId; let taskId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: r.url, project: 'grp/app' })).body.id;
    const c = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un cache sur le panier', plan_first: true, label: 'Cache panier',
      targets: [{ repo_id: repoId, branch: 'feat/plan-ui' }],
    });
    taskId = c.body.id;
    await app.api('POST', `/api/tasks/${taskId}/run`);
    await waitForJobs(app.api);
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  test('la ligne du projet dit « plan à approuver », ouvre le plan, et « Approuver et coder » fait coder la session', async () => {
    const carte = `#taskList [data-task="${taskId}"]`;
    await page.waitForSelector(`${carte} [data-planform]`);
    assert.match(await page.locator(`${carte} .target-line .tag`).first().textContent(), /plan/i);
    // Lire le plan : la vue des itérations s'ouvre sur la passe « plan ».
    await page.locator(`${carte} [data-planform] [data-tgout]`).click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    await page.waitForFunction(() => /Plan/.test(document.querySelector('#taskMdBody').textContent));
    /* ON LIT UN PLAN, PAS UN RETOUR À SUIVRE : « Préparer un suivi » s'efface, le bloc de retours du
       plan est là, ouvert. « Régénérer le plan » est refusé sans texte, puis renvoie les retours et
       referme la vue ; la ligne reste « plan à approuver » avec un plan réécrit, rien n'est codé. */
    assert.equal(await page.locator('#taskMdFollowToggle').isVisible(), false, 'pas de suivi sur un plan');
    assert.equal(await page.locator('#taskMdPlan').isVisible(), true, 'les retours du plan, à la place');
    await page.locator('#taskMdPlanRevise').click();
    await page.waitForSelector('.toast');
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM job WHERE kind = 'task' AND status = 'running'").get().c, 0, 'sans retours, aucun job ne part');
    await page.locator('#taskMdPlanText').fill('garde le cache en mémoire, pas de Redis');
    await page.locator('#taskMdPlanRevise').click();
    await page.waitForFunction(() => document.querySelector('#taskMdView').hidden === true);
    await waitForJobs(app.api);
    await page.waitForFunction((sel) => !!document.querySelector(`${sel} [data-planform]`) && !document.querySelector(`${sel} [data-planform] .plan-remark`).value, carte);
    const passes1 = (await app.api('GET', `/api/tasks/${taskId}/targets/${(await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].id}/passes`)).body;
    assert.equal(passes1.passes.length, 2, 'le plan, puis le plan révisé');
    assert.equal(passes1.passes[1].kind, 'plan');
    assert.match(passes1.passes[1].prompt, /pas de Redis/);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}`)).body.task.status, 'planned', 'toujours à approuver');
    // Une remarque, puis l'approbation.
    await page.locator(`${carte} [data-planform] .plan-remark`).fill('pas de migration');
    await page.locator(`${carte} [data-tgplanok]`).click();
    await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-planform]`), carte);
    await waitForJobs(app.api);
    await page.waitForFunction((sel) => /commit/i.test((document.querySelector(`${sel} .target-line .tag`) || {}).textContent || ''), carte);
    const t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(t.status, 'committed', `la session a codé (${t.last_error || ''})`);
    const passes = (await app.api('GET', `/api/tasks/${taskId}/targets/${t.targets[0].id}/passes`)).body.passes;
    assert.match(passes[passes.length - 1].prompt, /pas de migration/, 'la remarque est partie avec l’approbation');
    // Une fois codé, le retour se relit comme n'importe quel autre : le suivi revient, le plan s'efface.
    await page.locator(`${carte} .target-line [data-tgout]`).first().click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    assert.equal(await page.locator('#taskMdFollowToggle').isVisible(), true);
    assert.equal(await page.locator('#taskMdPlan').isVisible(), false);
    await page.evaluate(() => { document.querySelector('#taskMdView').hidden = true; });
  });

  test('pendant qu’une session tourne, le suivi propose « Stopper et reprendre » — sinon « Lancer l’itération »', async () => {
    const carte = `#taskList [data-task="${taskId}"]`;
    await page.locator(`${carte} [data-tfollow]`).click();
    await page.waitForSelector(`${carte} [data-followform="${taskId}"]:not([hidden])`);
    assert.equal(await page.locator(`${carte} [data-followsubmit="${taskId}"]`).count(), 1, 'à l’arrêt : lancer l’itération');
    assert.equal(await page.locator(`${carte} [data-followstopresume]`).count(), 0);
    // On rend la carte « en cours » comme la liste la verrait pendant un job, et on la redessine.
    await page.evaluate((id) => {
      const t = allTasks.find((x) => x.id === Number(id));
      t.status = 'running';
      renderTasks();
    }, taskId);
    await page.waitForSelector(`${carte} [data-followstopresume]`);
    assert.equal(await page.locator(`${carte} [data-followsubmit="${taskId}"]`).count(), 0, 'en cours : pas de lancement par-dessus');
  });

  test('aucune erreur de page', () => { assert.deepEqual(erreurs, []); });
});
