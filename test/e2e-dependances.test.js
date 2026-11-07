'use strict';
/* LES DÉPENDANCES AJOUTÉES, DE BOUT EN BOUT — « +2 dépendances · 1 majeur » sur la carte, avant la review.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur : le relevé garde le diff
 * des seuls manifestes SANS un appel de forge de plus que les croisements ; la liste porte les comptes
 * et les lignes ; un manifeste dont seuls les scripts changent ne porte rien ; un diff de manifeste
 * de plus de 200 Ko est refusé et le bouton ⋯ le dit ; un SHA qui bouge invalide puis le relevé
 * suivant ramène ; les motifs se règlent (global, groupe, dépôt), un glob invalide est refusé ; le
 * brief liste les MR qui ajoutent ; la ligne de projet d'une session compte ; décoché, plus rien.
 * Puis à l'écran : le badge accentué, le panneau et ses lignes, le lien vers le réglage, le brief. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const FIX = path.join(__dirname, 'fixtures', 'manifests');
const fixture = (nom) => fs.readFileSync(path.join(FIX, nom), 'utf8');
/* Le diff qu'une forge rend par fichier : les hunks seuls, sans en-tête `diff --git`. */
const hunks = (nom) => fixture(nom).split('\n').filter((l) => !/^(diff --git|--- |\+\+\+ )/.test(l)).join('\n');

describe('Dépendances ajoutées par une merge request', () => {
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
    // !1 : left-pad et vitest entrent, axios passe de ^0.27 à ^1.7 ; src/a.js a aussi un diff, qu'on ne garde PAS.
    app.state.changes[`${GL}!1`] = [
      { new_path: 'package.json', diff: hunks('package-json-added.diff') },
      { new_path: 'src/a.js', diff: '@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n' },
    ];
    // !2 : un package.json dont seuls la description et un script changent.
    app.state.changes[`${GL}!2`] = [{ new_path: 'package.json', diff: hunks('package-json-scripts-only.diff') }, { new_path: 'src/b.js', diff: '+x' }];
    // !3 : un manifeste de 201 Ko — refusé.
    app.state.changes[`${GL}!3`] = [{ new_path: 'pom.xml', diff: `+${'<x/>'.repeat(52 * 1024)}` }];
    // !4 : aucun manifeste.
    app.state.changes[`${GL}!4`] = [{ new_path: 'src/c.js', diff: '+y' }, { new_path: 'package-lock.json', diff: '+z' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    await app.api('POST', '/api/discover');
    for (const m of await lister()) { ids[m.iid] = m.id; repoId = m.repo_id; }
  });

  after(async () => { if (app) await app.stop(); });

  test('la liste porte les dépendances, sans appel de forge supplémentaire, et seul le diff des manifestes est gardé', async () => {
    const n = appels();
    assert.equal(n, 4, 'les quatre listes des croisements, et rien de plus');
    const m1 = await de(1);
    assert.deepEqual([m1.deps.added, m1.deps.changed, m1.deps.removed, m1.deps.major, m1.deps.alert], [2, 1, 0, 1, true]);
    assert.deepEqual(m1.deps.manifests[0].added.map((x) => x.name), ['left-pad', 'vitest']);
    assert.deepEqual(m1.deps.manifests[0].changed[0], { name: 'axios', from: '^0.27.2', to: '^1.7.0', section: 'prod', major: true });
    assert.deepEqual(m1.deps.patterns, { kind: 'default' });
    assert.equal(m1.deps.fetch.sha, '1'.repeat(40));
    assert.equal((await de(2)).deps, null, 'scripts seuls : rien');
    assert.equal((await de(4)).deps, null, 'aucun manifeste : rien — et le lockfile n’en est pas un');
    const m3 = await de(3);
    assert.equal(m3.deps.refused, 'too-large'); assert.equal(m3.deps.added, 0);
    assert.deepEqual(app.db.prepare('SELECT mr_id, path, refused, diff IS NULL AS vide FROM mr_manifest_diff ORDER BY mr_id').all(),
      [{ mr_id: ids[1], path: 'package.json', refused: null, vide: 0 }, { mr_id: ids[2], path: 'package.json', refused: null, vide: 0 }, { mr_id: ids[3], path: 'pom.xml', refused: 'too-large', vide: 1 }],
      'les manifestes seulement, jamais src/a.js — et le trop gros sans son diff');
    assert.equal(appels(), n, 'l’affichage ne fait aucun appel de forge');
    assert.equal((await app.api('GET', `/api/mrs/${ids[1]}`)).body.deps.added, 2, 'le rapport porte le même badge');
  });

  test('un SHA qui bouge invalide le badge ; le relevé suivant le ramène, sous le plafond habituel', async () => {
    app.state.mrs[GL][0].sha = 'f'.repeat(40);
    app.db.prepare("UPDATE mr SET current_sha = ? WHERE id = ?").run('f'.repeat(40), ids[1]);
    assert.equal((await de(1)).deps, null, 'le relevé ne parle plus de la tête');
    const n = appels();
    await app.api('POST', '/api/discover');
    assert.equal(appels(), n + 1, 'une seule liste relevée de nouveau');
    assert.equal((await de(1)).deps.added, 2);
  });

  test('un relevé antérieur à la fonctionnalité (manifests NULL) est repris au tour suivant, et le journal le dit', async () => {
    app.db.prepare('UPDATE mr_file_fetch SET manifests = NULL WHERE mr_id = ?').run(ids[2]);
    app.db.prepare('DELETE FROM mr_manifest_diff WHERE mr_id = ?').run(ids[2]);
    const n = appels();
    const r = await app.api('POST', '/api/discover');
    assert.equal(appels(), n + 1);
    assert.equal(r.body.files.dependances, 1, 'une MR à relever pour les dépendances');
    assert.equal(app.db.prepare('SELECT manifests FROM mr_file_fetch WHERE mr_id = ?').get(ids[2]).manifests, 1);
  });

  test('les motifs se règlent : un glob invalide est refusé avec sa ligne ; global, groupe, dépôt dans cet ordre ; l’aperçu compte', async () => {
    const mauvais = await app.api('PUT', '/api/config', { manifest_patterns: 'package.json\n*.{json}' });
    assert.equal(mauvais.status, 400);
    assert.match(mauvais.body.error || JSON.stringify(mauvais.body), /ligne 2|line 2/);
    assert.equal((await app.api('PUT', '/api/config', { manifest_patterns: 'pom.xml' })).status, 200);
    assert.equal((await de(1)).deps.patterns.kind, 'config', 'le global s’applique sans relevé');
    const g = await app.api('POST', '/api/repo-groups', { name: 'node', repos: [repoId], manifest_patterns: 'package.json' });
    assert.equal(g.status, 200);
    assert.deepEqual([(await de(1)).deps.patterns.kind, (await de(1)).deps.patterns.groups[0].name], ['group', 'node']);
    assert.equal((await app.api('PUT', `/api/repo-groups/${g.body.id}`, { manifest_patterns: 'a b' })).status, 400);
    assert.equal((await app.api('PUT', `/api/repos/${repoId}`, { manifest_patterns: '**/package.json' })).status, 200);
    assert.equal((await de(1)).deps.patterns.kind, 'repo');
    assert.equal((await app.api('PUT', `/api/repos/${repoId}`, { manifest_patterns: '!x' })).status, 400);
    const apercu = await app.api('POST', '/api/dependances/apercu', { repo_id: repoId, manifest_patterns: 'pom.xml' });
    assert.deepEqual([apercu.body.mrs, apercu.body.manifests], [4, 1]);
    assert.equal((await app.api('GET', '/api/dependances/defauts')).body.manifest_patterns.split('\n').length, 10);
    await app.api('PUT', `/api/repos/${repoId}`, { manifest_patterns: '' });
    await app.api('DELETE', `/api/repo-groups/${g.body.id}`);
    await app.api('PUT', '/api/config', { manifest_patterns: '' });
    assert.equal((await de(1)).deps.patterns.kind, 'default');
  });

  test('le brief liste les MR qui ajoutent ; la croix écarte une MR sur un SHA', async () => {
    let b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.new_deps.map((m) => [m.iid, m.added, m.major]), [[1, 2, 1]]);
    assert.equal((await app.api('POST', '/api/brief/hidden', { kind: 'dependance', ref: b.new_deps[0].key })).status, 200);
    b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.new_deps, []);
    await app.api('DELETE', '/api/brief/hidden');
    assert.equal((await app.api('GET', '/api/brief')).body.new_deps.length, 1);
  });

  test('la ligne de projet d’une session compte les dépendances de la branche, dès le commit', async () => {
    const now = new Date().toISOString();
    taskId = Number(app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'Ajouter le calcul', 'feature/x', 'done', ?, ?)`).run(repoId, now, now).lastInsertRowid);
    const diff = path.join(app.dataDir, 'diff-x.patch');
    fs.writeFileSync(diff, fixture('monorepo.diff'));
    const tg = Number(app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, commit_sha, diff_path, updated_at)
      VALUES (?, ?, 'feature/x', 'main', 'committed', 'abc123', ?, ?)`).run(taskId, repoId, diff, now).lastInsertRowid);
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?, ?, 'feature/y', 'main', 'new', ?)`).run(taskId, repoId, now);
    const t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.deepEqual(t.targets.find((x) => x.id === tg).deps, { added: 2, removed: 0, changed: 0, major: 0 });
    assert.equal(t.targets.find((x) => x.id !== tg).deps, null, 'avant le commit, rien');
  });

  test('réglage décoché : aucun badge, aucune section, aucune ligne — et le relevé ne garde plus rien', async () => {
    await app.configure({ deps_enabled: '0' });
    assert.equal((await de(1)).deps, null);
    assert.deepEqual((await app.api('GET', '/api/brief')).body.new_deps, []);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].deps, null);
    app.state.mrs[GL][3].sha = 'e'.repeat(40);
    app.db.prepare("UPDATE mr SET current_sha = ? WHERE id = ?").run('e'.repeat(40), ids[4]);
    await app.api('POST', '/api/discover');
    assert.equal(app.db.prepare('SELECT manifests FROM mr_file_fetch WHERE mr_id = ?').get(ids[4]).manifests, null, 'décoché : pas cherché');
    await app.configure({ deps_enabled: '1' });
    assert.equal((await de(1)).deps.added, 2);
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

    test('la carte porte « +2 dépendances · 1 majeur » accentué ; rien sur les scripts seuls, le refusé ni l’absence de manifeste', async () => {
      const b1 = page.locator(`#toReviewList .card[data-id="${ids[1]}"] .tag.deps`);
      await b1.waitFor({ state: 'visible' });
      assert.match(await b1.innerText(), /\+2 (dépendances|dependencies) · 1 (majeur|major)/);
      assert.ok(await b1.evaluate((el) => el.classList.contains('alert')));
      for (const iid of [2, 3, 4]) assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[iid]}"] .tag.deps`).count(), 0, `!${iid} : rien`);
      assert.match(await page.locator(`#toReviewList .card[data-id="${ids[3]}"] [data-more]`).getAttribute('title'), /trop gros|too large/, 'le bouton ⋯ dit le refus');
    });

    test('le panneau nomme les dépendances, les ajoutées d’abord, et son lien ouvre le réglage des manifestes', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      await carte.locator('.tag.deps').click();
      const panneau = carte.locator('.deps-panel');
      await panneau.waitFor({ state: 'visible' });
      const lignes = await panneau.locator('.deps-rows li').allInnerTexts();
      assert.equal(lignes.length, 3);
      assert.match(lignes[0], /left-pad\s+\^1\.3\.0\s+(ajoutée|added) · prod/);
      assert.match(lignes[1], /vitest\s+\^2\.0\.0\s+(ajoutée|added) · dev/);
      assert.match(lignes[2], /axios\s+\^0\.27\.2 → \^1\.7\.0\s+(majeur|major) · prod/);
      assert.match(await panneau.innerText(), /2 (ajoutée|added)/);
      assert.equal(await panneau.locator('a[href]').count(), 0, 'aucun lien vers un registre');
      await page.keyboard.press('Escape');
      await panneau.waitFor({ state: 'detached' });
      await carte.locator('.tag.deps').click();
      await carte.locator('.deps-panel [data-deps-motifs="config"]').click();
      await page.waitForSelector('#tab-admin.active');
      await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'manifest_patterns');
      await page.waitForFunction(() => (document.querySelector('#sub-mr [name="manifest_patterns"]').placeholder || '').split('\n').length === 10);
      await page.fill('#sub-mr [name="manifest_patterns"]', 'pom.xml');
      await page.waitForFunction(() => /4 MR/.test(document.querySelector('#sub-mr [data-manifests-apercu]').textContent));
      await page.locator('#sub-mr [data-patterns-reset="manifest_patterns"]').click();
      await page.waitForFunction(() => document.querySelector('#sub-mr [name="manifest_patterns"]').value.split('\n').length === 10);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('le brief liste la MR qui ajoute et mène à sa carte ; la ligne de session dit « 2 dépendances ajoutées »', async () => {
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
      const sec = page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: /ajoutent des dépendances|adding dependencies/ }) });
      await sec.waitFor({ state: 'visible' });
      const ligne = sec.locator('[data-brief-deps]').first();
      assert.match(await ligne.innerText(), /!1 — MR 1/);
      assert.match(await ligne.innerText(), /\+2 (dépendances|dependencies)/);
      await ligne.click();
      await page.waitForFunction((sel) => { const c = document.querySelector(sel); return c && c.classList.contains('landed'); }, `#toReviewList .card[data-id="${ids[1]}"]`);

      await page.locator('nav button[data-tab="task"]').click();
      await page.locator(`#taskList .task-row[data-task="${taskId}"] .targets-toggle`).click();
      const tag = page.locator(`#taskList .task-row[data-task="${taskId}"] .target-line .tag.deps`);
      await tag.waitFor({ state: 'visible' });
      assert.match(await tag.innerText(), /2 (dépendances ajoutées|dependencies added)/);
      assert.ok(await tag.evaluate((el) => el.classList.contains('alert')));
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
