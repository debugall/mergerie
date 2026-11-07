'use strict';
/* LES TESTS TOUCHÉS, DE BOUT EN BOUT — « 14 fichiers · 0 test » sur la carte, avant la review.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur : la liste porte les
 * trois nombres et l'alerte sans un appel de forge de plus que les croisements ; les motifs se
 * règlent (global, groupe, dépôt), un glob invalide est refusé avec sa ligne, l'aperçu classe ;
 * le brief liste les MR sans test, une croix écarte UNE merge request sur UN SHA ; la ligne de
 * projet d'une session dit « 0 test modifié » ; décoché, plus rien. Puis à l'écran : le badge
 * accentué, le panneau et son lien vers le réglage, la section du brief, la ligne de session. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Tests touchés par une merge request', () => {
  let app; let gl; let repoId; let taskId;
  const GL = 'grp/app';
  const ids = {};

  const mrGl = (iid, extra) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
    web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: `${iid}`.repeat(40).slice(0, 40),
    created_at: `2026-01-0${iid}T10:00:00.000Z`, updated_at: `2026-02-0${iid}T10:00:00.000Z`,
    author: { name: 'Alice', username: 'alice' },
    ...extra,
  });
  const appels = () => app.state.calls.filter((c) => /\/merge_requests\/\d+\/changes/.test(c.path)).length;
  const lister = async () => (await app.api('GET', '/api/mrs')).body;
  const de = async (iid) => (await lister()).find((m) => m.iid === iid);

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/1' });
    app.state.mrs[GL] = [mrGl(1), mrGl(2), mrGl(3), mrGl(4)];
    app.state.changes[`${GL}!1`] = [{ new_path: 'src/a.js' }, { new_path: 'src/b.js' }, { new_path: 'src/c.js' }, { new_path: 'README.md' }];
    app.state.changes[`${GL}!2`] = [{ new_path: 'src/a.js' }, { new_path: 'src/d.js' }, { new_path: 'src/a.test.js' }];
    app.state.changes[`${GL}!3`] = [{ new_path: 'src/e.js' }, { new_path: 'src/f.js' }];
    app.state.changes[`${GL}!4`] = [{ new_path: 'README.md' }, { new_path: 'docs/x.md' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    await app.api('POST', '/api/discover');
    for (const m of await lister()) { ids[m.iid] = m.id; repoId = m.repo_id; }
  });

  after(async () => { if (app) await app.stop(); });

  test('la liste porte code / tests / neutres et l’alerte, sans appel de forge supplémentaire', async () => {
    const n = appels();
    assert.equal(n, 4, 'les quatre listes des croisements, et rien de plus');
    const m1 = await de(1);
    assert.deepEqual([m1.tests.code, m1.tests.tests, m1.tests.neutral, m1.tests.alert], [3, 0, 1, true]);
    assert.deepEqual(m1.tests.patterns, { tests: { kind: 'default' }, neutres: { kind: 'default' } });
    assert.equal(m1.tests.fetch.sha, '1'.repeat(40));
    const m2 = await de(2);
    assert.deepEqual([m2.tests.code, m2.tests.tests, m2.tests.alert], [2, 1, false]);
    assert.deepEqual(m2.tests.test_paths, ['src/a.test.js']);
    const m3 = await de(3);
    assert.deepEqual([m3.tests.code, m3.tests.tests, m3.tests.alert], [2, 0, false], 'sous le seuil : pas d’alerte');
    const m4 = await de(4);
    assert.deepEqual([m4.tests.code, m4.tests.neutral], [0, 2], 'que des neutres');
    assert.equal(appels(), n, 'l’affichage ne fait aucun appel de forge');
    assert.equal((await app.api('GET', `/api/mrs/${ids[1]}`)).body.tests.alert, true, 'le rapport porte le même badge');
  });

  test('les motifs se règlent : un glob invalide est refusé avec sa ligne ; global, groupe, dépôt dans cet ordre', async () => {
    const mauvais = await app.api('PUT', '/api/config', { test_patterns: '**/*.spec.js\n**/*.{js,ts}' });
    assert.equal(mauvais.status, 400);
    assert.match(mauvais.body.error || JSON.stringify(mauvais.body), /ligne 2|line 2/);
    assert.equal((await app.api('GET', '/api/config')).body.test_patterns, '', 'rien n’a été enregistré');

    assert.equal((await app.api('PUT', '/api/config', { test_patterns: 'src/c.js', tests_touched_min_code: '2' })).status, 200);
    let m1 = await de(1);
    assert.deepEqual([m1.tests.tests, m1.tests.alert, m1.tests.patterns.tests.kind], [1, false, 'config'], 'le global s’applique sans relevé');
    assert.equal((await de(3)).tests.alert, true, 'le seuil 2 accentue !3');

    const g = await app.api('POST', '/api/repo-groups', { name: 'paiement', repos: [repoId], test_patterns: 'src/b.js' });
    assert.equal(g.status, 200);
    m1 = await de(1);
    assert.deepEqual([m1.tests.tests, m1.tests.patterns.tests.kind, m1.tests.patterns.tests.groups[0].name], [1, 'group', 'paiement']);
    assert.equal((await app.api('PUT', `/api/repo-groups/${g.body.id}`, { test_patterns: 'a b' })).status, 400, 'un groupe aussi refuse un motif invalide');

    assert.equal((await app.api('PUT', `/api/repos/${repoId}`, { test_patterns: 'src/a.js\nsrc/b.js' })).status, 200);
    m1 = await de(1);
    assert.deepEqual([m1.tests.tests, m1.tests.patterns.tests.kind], [2, 'repo'], 'le dépôt remplace le groupe');
    assert.equal((await app.api('PUT', `/api/repos/${repoId}`, { test_patterns: '!x' })).status, 400);

    const apercu = await app.api('POST', '/api/tests-touches/apercu', { repo_id: repoId, test_patterns: '**/*.js' });
    assert.deepEqual([apercu.body.mrs, apercu.body.code], [4, 0], 'l’aperçu classe avec les motifs proposés');
    assert.equal((await app.api('GET', '/api/tests-touches/defauts')).body.test_patterns.split('\n').length, 13);

    // Retour aux défauts.
    await app.api('PUT', `/api/repos/${repoId}`, { test_patterns: '' });
    await app.api('DELETE', `/api/repo-groups/${g.body.id}`);
    await app.api('PUT', '/api/config', { test_patterns: '', tests_touched_min_code: '3' });
    assert.deepEqual([(await de(1)).tests.tests, (await de(1)).tests.alert], [0, true]);
  });

  test('le brief liste les MR sans test ; la croix écarte une MR sur un SHA ; un nouveau relevé la ramène', async () => {
    let b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.no_tests.map((m) => m.iid), [1]);
    assert.equal(b.no_tests[0].code, 3);
    assert.equal((await app.api('POST', '/api/brief/hidden', { kind: 'sanstest', ref: b.no_tests[0].key })).status, 200);
    b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.no_tests, []);
    app.state.mrs[GL][0].sha = 'f'.repeat(40);
    await app.api('POST', '/api/discover');
    b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.no_tests.map((m) => m.iid), [1], 'relevée sur un autre SHA : elle reparaît');
    await app.api('DELETE', '/api/brief/hidden');
  });

  test('la ligne de projet d’une session dit combien de tests la branche modifie, dès le commit', async () => {
    const now = new Date().toISOString();
    taskId = Number(app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'Ajouter le calcul', 'feature/x', 'done', ?, ?)`).run(repoId, now, now).lastInsertRowid);
    const diff = path.join(app.dataDir, 'diff-x.patch');
    fs.writeFileSync(diff, 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\ndiff --git a/src/y.js b/src/y.js\n+++ b/src/y.js\n');
    const tg = Number(app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, commit_sha, diff_path, updated_at)
      VALUES (?, ?, 'feature/x', 'main', 'committed', 'abc123', ?, ?)`).run(taskId, repoId, diff, now).lastInsertRowid);
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?, ?, 'feature/y', 'main', 'new', ?)`).run(taskId, repoId, now);
    const t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    const cible = t.targets.find((x) => x.id === tg);
    assert.deepEqual(cible.tests_touched, { code: 2, tests: 0, neutral: 0 });
    assert.equal(t.targets.find((x) => x.id !== tg).tests_touched, null, 'avant le commit, rien');
  });

  test('réglage décoché : aucun badge, aucune section', async () => {
    await app.configure({ tests_touched_enabled: '0' });
    assert.equal((await de(1)).tests, null);
    assert.deepEqual((await app.api('GET', '/api/brief')).body.no_tests, []);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].tests_touched, null);
    await app.configure({ tests_touched_enabled: '1' });
    assert.ok((await de(1)).tests);
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

    test('la carte porte « 3 fichiers · 0 test » accentué, « 2 fichiers · 1 test » discret, rien sous le seuil ni sur du neutre', async () => {
      const b1 = page.locator(`#toReviewList .card[data-id="${ids[1]}"] .tag.tests`);
      await b1.waitFor({ state: 'visible' });
      assert.match(await b1.innerText(), /3 (fichiers|files) · 0 test/);
      assert.ok(await b1.evaluate((el) => el.classList.contains('alert')));
      const b2 = page.locator(`#toReviewList .card[data-id="${ids[2]}"] .tag.tests`);
      assert.match(await b2.innerText(), /2 (fichiers|files) · 1 test/);
      assert.equal(await b2.evaluate((el) => el.classList.contains('alert')), false);
      assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[3]}"] .tag.tests`).count(), 0, 'sous le seuil : rien');
      assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[4]}"] .tag.tests`).count(), 0, 'que des neutres : rien');
    });

    test('le panneau dit « aucun fichier de test », nomme les motifs, et son lien ouvre le réglage', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      await carte.locator('.tag.tests').click();
      const panneau = carte.locator('.croise-panel');
      await panneau.waitFor({ state: 'visible' });
      assert.match(await panneau.innerText(), /Aucun fichier de test|No test file/);
      assert.match(await panneau.innerText(), /3 fichier|3 code file/);
      await page.keyboard.press('Escape');
      await panneau.waitFor({ state: 'detached' });
      await carte.locator('.tag.tests').click();
      await carte.locator('.croise-panel [data-tests-motifs="config"]').click();
      await page.waitForSelector('#tab-admin.active');
      await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'test_patterns');
      // Les défauts livrés arrivent par un appel à part : on attend l'invite, on ne la lit pas au vol.
      await page.waitForFunction(() => (document.querySelector('#sub-mr [name="test_patterns"]').placeholder || '').split('\n').length === 13);
      // L'aperçu suit la frappe, et un motif invalide est dit avec sa ligne, avant l'enregistrement.
      await page.fill('#sub-mr [name="test_patterns"]', '**/*.js');
      await page.waitForFunction(() => /4 MR/.test(document.querySelector('#sub-mr [data-patterns-apercu]').textContent));
      await page.fill('#sub-mr [name="test_patterns"]', 'x\n**/*.{js}');
      await page.waitForFunction(() => /ligne 2|line 2/.test(document.querySelector('#sub-mr [data-patterns-apercu]').textContent));
      await page.locator('#sub-mr [data-patterns-reset="test_patterns"]').click();
      await page.waitForFunction(() => document.querySelector('#sub-mr [name="test_patterns"]').value.split('\n').length === 13);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('le brief liste la MR sans test et mène à sa carte ; la ligne de session dit « 0 test modifié »', async () => {
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
      const sec = page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: /sans test|without tests/ }) });
      await sec.waitFor({ state: 'visible' });
      const ligne = sec.locator('[data-brief-notest]').first();
      assert.match(await ligne.innerText(), /!1 — MR 1/);
      assert.match(await ligne.innerText(), /0 test/);
      await ligne.click();
      await page.waitForFunction((sel) => { const c = document.querySelector(sel); return c && c.classList.contains('just-landed'); }, `#toReviewList .card[data-id="${ids[1]}"]`);

      await page.locator('nav button[data-tab="task"]').click();
      // Deux projets : la carte les replie par défaut, on la déplie avant de lire la pastille.
      await page.locator(`#taskList .task-row[data-task="${taskId}"] .targets-toggle`).click();
      const tag = page.locator(`#taskList .task-row[data-task="${taskId}"] .target-line .tag.tests`);
      await tag.waitFor({ state: 'visible' });
      assert.match(await tag.innerText(), /0 test modifié|0 tests modified/);
      assert.ok(await tag.evaluate((el) => el.classList.contains('alert')));
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
