'use strict';
/* LES MERGE REQUESTS EMPILÉES, DE BOUT EN BOUT — « contient !214 » sur la contenante, « contenue dans
 * !219 » sur la contenue, dit avant qu'on ne relise deux fois le même code.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur : la découverte relève les
 * commits dans le même tour que les fichiers (un appel par merge request, pas un de plus, 501 commits
 * refusés) ; la liste porte l'inclusion, symétrique, la chaîne, « basée sur », le relevé — sans aucun
 * appel de forge à l'affichage ; le diff propre se calcule à l'ouverture ; la modale de session dit
 * « la branche créée contiendra !1 » ; la review d'une contenante reçoit la phrase de fait et le
 * rapport la montre ; une contenue mergée laisse une ligne d'historique ; décoché, le réglage retire
 * tout. Puis à l'écran : le badge, le panneau et son diff propre, Échap, la modale Contexte, la ligne
 * de la modale de session. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, waitForJobs,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Merge requests empilées', () => {
  let app; let gl; let repoId;
  const GL = 'grp/app';
  const ids = {};
  const sha = (n) => String(n).repeat(40).slice(0, 40);
  const mrGl = (iid, extra) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
    web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: sha(iid),
    created_at: `2026-01-0${iid}T10:00:00.000Z`, updated_at: `2026-02-0${iid}T10:00:00.000Z`,
    author: { name: 'Alice', username: 'alice' },
    ...extra,
  });
  const commitsGl = (shas) => [...shas].reverse().map((id) => ({ id }));   // GitLab : le plus récent d'abord
  const appelsCommits = () => app.state.calls.filter((c) => /\/merge_requests\/\d+\/commits/.test(c.path)).length;
  const appelsFichiers = () => app.state.calls.filter((c) => /\/merge_requests\/\d+\/changes/.test(c.path)).length;
  const lister = async () => (await app.api('GET', '/api/mrs')).body;
  const iids = (l) => (l || []).map((x) => x.iid);

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/2' });
    /* !1 = A (c1, c2) sur `feature/1` ; !2 = B (c1, c2, c3) sur `feature/2` — la vraie branche du dépôt
       de test, pour que la review tourne ; !3 = C (c1…c5) : la chaîne ; !4 vise `feature/1` : basée sur
       !1 ; !5 : 501 commits, refusée. */
    app.state.mrs[GL] = [mrGl(1), mrGl(2), mrGl(3), mrGl(4, { target_branch: 'feature/1' }), mrGl(5)];
    app.state.mrCommits[`${GL}!1`] = commitsGl(['c1', 'c2']);
    app.state.mrCommits[`${GL}!2`] = commitsGl(['c1', 'c2', 'c3']);
    app.state.mrCommits[`${GL}!3`] = commitsGl(['c1', 'c2', 'c3', 'c4', 'c5']);
    app.state.mrCommits[`${GL}!4`] = commitsGl(['x1']);
    app.state.mrCommits[`${GL}!5`] = commitsGl(Array.from({ length: 501 }, (x, i) => `t${i}`));
    app.state.changes[`${GL}!1`] = [{ new_path: 'src/a.js' }, { new_path: 'src/b.js' }];
    app.state.changes[`${GL}!2`] = [{ new_path: 'src/a.js' }, { new_path: 'src/b.js' }, { new_path: 'src/c.js' }, { new_path: 'src/d.js' }];
    app.state.changes[`${GL}!3`] = [{ new_path: 'src/a.js' }, { new_path: 'src/b.js' }, { new_path: 'src/c.js' }, { new_path: 'src/d.js' }, { new_path: 'src/e.js' }];
    app.state.changes[`${GL}!4`] = [{ new_path: 'docs/x.md' }];
    app.state.changes[`${GL}!5`] = [{ new_path: 'docs/t.md' }];
    await app.configure({});   // la connexion GitLab (faux serveur)
    const r = await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    repoId = r.body.id || (await app.api('GET', '/api/repos')).body.find((x) => x.project === GL).id;
  });

  after(async () => { if (app) await app.stop(); });

  test('la découverte relève les commits dans le même tour que les fichiers — un appel par MR, 501 commits refusés', async () => {
    const r1 = await app.api('POST', '/api/discover');
    assert.equal(r1.status, 200);
    assert.equal(r1.body.files.releves, 5);
    assert.equal(r1.body.files.commits.releves, 4);
    assert.equal(r1.body.files.commits.refuses, 1, '!5 : 501 commits, liste non relevée');
    assert.equal(appelsCommits(), 5); assert.equal(appelsFichiers(), 5);
    for (const m of await lister()) ids[m.iid] = m.id;
    const r2 = await app.api('POST', '/api/discover');
    assert.equal(r2.body.files.releves + r2.body.files.commits.releves, 0, 'tout est relevé');
    assert.equal(appelsCommits(), 5, 'plus aucun appel tant que les SHA ne bougent pas — la liste refusée non plus');
  });

  test('la liste porte l’inclusion, symétrique, la chaîne, « basée sur » et le relevé — sans appel de forge', async () => {
    const n = appelsCommits();
    const liste = await lister();
    const m = Object.fromEntries(liste.map((x) => [x.iid, x]));
    assert.deepEqual(iids(m[2].stack.contains), [1]);
    assert.equal(m[2].stack.contains[0].shared, 2); assert.equal(m[2].stack.contains[0].extra, 1);
    assert.equal(m[2].stack.contains[0].title, 'MR 1'); assert.equal(m[2].stack.contains[0].files, 2);
    assert.deepEqual(iids(m[1].stack.containedIn), [2, 3], 'contenue dans !2 et !3, la plus proche d’abord');
    assert.deepEqual(iids(m[3].stack.contains), [1, 2], 'la chaîne : la plus profonde d’abord');
    assert.deepEqual(iids(m[2].stack.containedIn), [3]);
    assert.equal(m[4].stack.basedOn.iid, 1);
    assert.deepEqual(m[4].stack.contains, []);
    assert.equal(m[5].stack.fetch.refused, 'too-many-commits');
    assert.deepEqual(m[5].stack.contains, []); assert.deepEqual(m[5].stack.twins, []);
    assert.equal(m[2].stack.fetch.sha, sha(2)); assert.equal(m[2].stack.fetch.count, 3);
    assert.equal(appelsCommits(), n, 'l’affichage ne fait aucun appel de forge');
    const detail = (await app.api('GET', `/api/mrs/${ids[2]}`)).body;
    assert.deepEqual(iids(detail.stack.contains), [1], 'le rapport porte le même badge');
    assert.equal(detail.stack_facts.length, 1);
    assert.match(detail.stack_facts[0], /!1 /); assert.match(detail.stack_facts[0], /2 commits/);
    assert.deepEqual((await app.api('GET', `/api/mrs/${ids[1]}`)).body.stack_facts, [], 'la contenue ne reçoit pas de phrase');
  });

  test('le diff propre se calcule à l’ouverture du panneau : B − A, puis C − (A ∪ B)', async () => {
    assert.deepEqual((await app.api('GET', `/api/empilees/${ids[2]}/propre`)).body, { computed: true, count: 2, paths: ['src/c.js', 'src/d.js'] });
    assert.deepEqual((await app.api('GET', `/api/empilees/${ids[3]}/propre`)).body, { computed: true, count: 1, paths: ['src/e.js'] });
    assert.equal((await app.api('GET', `/api/empilees/${ids[1]}/propre`)).body.computed, false, 'A ne contient rien');
  });

  test('la modale de session : repartir de la branche de !1, c’est contenir !1', async () => {
    const r = await app.api('POST', '/api/croisements/session', { targets: [{ repo_id: repoId, branch: 'feature/1' }, { repo_id: repoId, branch: 'ai/neuve' }], text: '' });
    assert.equal(r.body.targets[0].stack.iid, 1);
    assert.equal(r.body.targets[0].stack.status, 'to_review');
    assert.equal(r.body.targets[1].stack, null);
  });

  test('la review d’une contenante reçoit la phrase de fait, et le journal le dit', async () => {
    const r = await app.api('POST', `/api/mrs/${ids[2]}/review`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForJobs(app.api);
    const lignes = app.db.prepare('SELECT text FROM job_log WHERE mr_id = ? ORDER BY id').all(ids[2]).map((l) => l.text);
    assert.ok(lignes.some((l) => /MR empilées|Stacked MRs/.test(l)), lignes.join('\n'));
    const detail = (await app.api('GET', `/api/mrs/${ids[2]}`)).body;
    assert.ok(detail.report || detail.review || detail.md, 'un rapport existe');
  });

  test('!1 mergée → plus contenue au tour suivant ; le panneau de !2 garde « contenait !1 »', async () => {
    app.state.mrs[GL][0].state = 'merged';
    app.state.mrs[GL][0].merged_at = new Date().toISOString();
    await app.api('POST', '/api/discover');
    const m = Object.fromEntries((await lister()).map((x) => [x.iid, x]));
    assert.deepEqual(m[2].stack.contains, [], 'le badge a disparu');
    assert.deepEqual(iids(m[2].stack.history), [1]);
    assert.ok(m[2].stack.history[0].merged_at);
    assert.deepEqual(iids(m[3].stack.contains), [2], 'la chaîne se raccourcit');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM mr_commits WHERE mr_id = ?').get(ids[1]).n, 0, 'la liste de la mergée est purgée');
    // Pour l'écran : !1 revient ouverte, et sa liste avec elle.
    app.state.mrs[GL][0].state = 'opened'; delete app.state.mrs[GL][0].merged_at;
    app.db.prepare('UPDATE mr SET merged_at = NULL WHERE id = ?').run(ids[1]);
    app.db.prepare('DELETE FROM mr_contained_history').run();
    await app.api('POST', '/api/discover');
    assert.deepEqual(iids(Object.fromEntries((await lister()).map((x) => [x.iid, x]))[2].stack.contains), [1]);
  });

  test('réglage décoché : aucun badge, aucun appel de plus', async () => {
    await app.configure({ mr_commits_enabled: '0' });
    const n = appelsCommits();
    app.state.mrs[GL][3].sha = sha(9);
    await app.api('POST', '/api/discover');
    assert.equal(appelsCommits(), n, 'la tête de !4 a bougé : fichiers relus, commits non');
    assert.equal((await lister()).find((x) => x.iid === 2).stack, null);
    await app.configure({ mr_commits_enabled: '1' });
    await app.api('POST', '/api/discover');
    assert.equal(appelsCommits(), n + 1);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage();
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
      await page.locator(`#toReviewList .card[data-id="${ids[1]}"]`).waitFor({ state: 'visible' });
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    /* !2 a été reviewée plus haut : elle est dans « reviewées ». Les cartes « à traiter » montrent !3 (la
       chaîne), !1 (contenue), !4 (basée sur) et !5 (refusée). */
    test('le badge « contient 2 MR » sur la carte, « contenue dans !2 » sur l’autre, « basée sur !1 », rien sur la refusée', async () => {
      assert.match(await page.locator(`#toReviewList .card[data-id="${ids[3]}"] .tag.stack`).innerText(), /contient 2 MR|contains 2 MRs/);
      assert.match(await page.locator(`#toReviewList .card[data-id="${ids[1]}"] .tag.stack`).innerText(), /contenue dans !2|contained in !2/);
      assert.match(await page.locator(`#toReviewList .card[data-id="${ids[4]}"] .tag.stack`).innerText(), /basée sur !1|based on !1/);
      assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[5]}"] .tag.stack`).count(), 0, 'liste refusée : rien, jamais « indépendante »');
      // L'empilement passe devant « croise » dans la rangée.
      const ordre = await page.locator(`#toReviewList .card[data-id="${ids[3]}"] .card-tags .tag`).evaluateAll((els) => els.map((e) => e.className));
      assert.ok(ordre.findIndex((c) => /\bstack\b/.test(c)) < ordre.findIndex((c) => /\bcroise\b/.test(c)), ordre.join(' | '));
    });

    test('la recherche retrouve une merge request par son numéro — « !3 », tel que le badge et la page Équipe la nomment', async () => {
      await page.fill('#searchReview', '!3');
      await page.waitForFunction((id) => { const c = document.querySelectorAll('#toReviewList .card[data-id]'); return c.length === 1 && Number(c[0].dataset.id) === id; }, ids[3]);
      await page.fill('#searchReview', '');
      await page.locator(`#toReviewList .card[data-id="${ids[1]}"]`).waitFor({ state: 'visible' });
    });

    test('le panneau : les MR liées, la plus profonde d’abord, les commits, le diff propre calculé à l’ouverture ; Échap ferme', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[3]}"]`);
      await carte.locator('.tag.stack').click();
      const panneau = carte.locator('.stack-panel');
      await panneau.waitFor({ state: 'visible' });
      assert.match(await panneau.locator('.croise-head strong').innerText(), /Contient 2 merge requests|Contains 2 merge requests/);
      assert.deepEqual((await panneau.locator('.stack-sec .croise-go').allInnerTexts()).map((x) => x.slice(0, 11)), ['!1 — MR 1 ·', '!2 — MR 2 ·'], 'A puis B');
      assert.match(await panneau.locator('.stack-counts').first().innerText(), /2 commits communs · 3 commits propres|2 shared commits · 3 own commits/);
      await panneau.locator('.stack-propre').filter({ hasText: /Diff propre : 1 fichier|Own diff: 1 file/ }).waitFor({ state: 'visible' });
      assert.deepEqual(await panneau.locator('.stack-propre code').allInnerTexts(), ['src/e.js']);
      assert.match(await panneau.locator('.croise-foot').innerText(), new RegExp(sha(3).slice(0, 8)));
      await page.keyboard.press('Escape');
      await carte.locator('.stack-panel').waitFor({ state: 'detached' });
      assert.equal(await carte.locator('.tag.stack').getAttribute('aria-expanded'), 'false');
    });

    test('la modale Contexte du rapport montre la phrase de fait telle que l’IA l’a reçue', async () => {
      await page.locator('[data-seg="reviewed"]').click();
      await page.locator(`#reportList .card[data-id="${ids[2]}"]`).click();
      await page.waitForFunction((n) => { const t = document.querySelector('#reportDetail .title'); return t && t.textContent.includes(`!${n}`) && document.querySelector('#aMore'); }, 2);
      assert.match(await page.locator('#reportDetail .tag.stack').innerText(), /contient !1|contains !1/, 'le badge est repris dans l’en-tête du rapport');
      await page.locator('#aMore').click();
      await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
      await page.locator('#aTicket').click();
      await page.waitForSelector('#ticketModal:not([hidden])');
      await page.waitForSelector('#ticketStack:not([hidden])');
      assert.match(await page.locator('#ticketStackBody').innerText(), /!1 .*2 commits/);
      await page.locator('#ticketCancel').click();
      await page.waitForSelector('#ticketModal', { state: 'hidden' });
    });

    test('la modale de session : la branche de !1 → « La branche créée contiendra !1 »', async () => {
      await page.click('nav button[data-tab="task"]');
      await page.click('#tab-task .subnav [data-kind="code"]');
      await page.click('#btnNewTask');
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.fill('#targetRows .target-row input.t-branch', 'feature/1');
      await page.locator('#taskCroisements').filter({ hasText: /contiendra !1|will contain !1/ }).waitFor({ state: 'visible' });
      await page.click('#taskCancel');
      await page.waitForFunction(() => document.querySelector('#taskModal').hidden);
    });
  });
});
