'use strict';
/* LE CONTRÔLE AU REGISTRE, DE BOUT EN BOUT — « +2 dépendances · 1 inconnue » sur la carte.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur et de FAUX registres locaux :
 * réglage décoché (le défaut), un tour de découverte complet n'émet AUCUNE requête vers un registre et
 * la liste dit « désactivé » ; coché, le tour contrôle les seules dépendances ajoutées (un nom privé par
 * motif ne part pas), la liste porte « 1 inconnue » et la réponse du registre sur chaque ligne, le
 * rapport et le brief aussi ; la ligne de projet d'une session se complète au rendu suivant ; les URL de
 * registre se valident ; la réponse de la découverte compte les appels. Puis à l'écran : le badge, le
 * panneau et ses lignes en clair, le pied « Registres contactés », le lien vers les motifs privés, la
 * ligne de session, le brief — et, décoché, le pied « désactivé ». */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const registres = require('./helpers/mock-registres');

const { dispo } = navigateurDispo();
const FIX = path.join(__dirname, 'fixtures', 'manifests');
const fixture = (nom) => fs.readFileSync(path.join(FIX, nom), 'utf8');
const hunks = (nom) => fixture(nom).split('\n').filter((l) => !/^(diff --git|--- |\+\+\+ )/.test(l)).join('\n');

describe('Contrôle au registre des dépendances ajoutées', () => {
  let app; let gl; let faux; let repoId; let taskId;
  const GL = 'grp/app';
  const ids = {};

  const mrGl = (iid, extra) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
    web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: `${iid}`.repeat(40).slice(0, 40),
    created_at: `2026-01-0${iid}T10:00:00.000Z`, updated_at: `2026-02-0${iid}T10:00:00.000Z`,
    author: { name: 'Alice', username: 'alice' },
    ...extra,
  });
  const lister = async () => (await app.api('GET', '/api/mrs')).body;
  const de = async (iid) => (await lister()).find((m) => m.iid === iid);

  before(async () => {
    faux = await registres.start();
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/1' });
    app.state.mrs[GL] = [mrGl(1), mrGl(2)];
    // !1 : left-pad (inconnu du faux npm) et vitest (connu) entrent, axios change de majeur.
    app.state.changes[`${GL}!1`] = [{ new_path: 'package.json', diff: hunks('package-json-added.diff') }, { new_path: 'src/a.js', diff: '+a' }];
    // !2 : un paquet d'entreprise @acme/ui, que le faux npm ne connaît pas non plus — mais un motif privé le couvre.
    app.state.changes[`${GL}!2`] = [{ new_path: 'package.json', diff: '@@ -1,4 +1,5 @@\n {\n   "dependencies": {\n+    "@acme/ui": "^3.1.0",\n     "express": "^4.18.2"\n   }\n' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
  });

  after(async () => { if (app) await app.stop(); if (faux) await faux.stop(); });

  test('décoché (le défaut) : un tour complet n’émet aucune requête vers un registre, et la liste dit « désactivé »', async () => {
    const r = (await app.api('POST', '/api/discover')).body;
    for (const m of await lister()) { ids[m.iid] = m.id; repoId = m.repo_id; }
    assert.equal(faux.state.hits.length, 0, 'zéro requête sortante');
    assert.equal(r.files.registry, null);
    const m1 = await de(1);
    assert.deepEqual([m1.deps.added, m1.deps.unknown, m1.deps.recent, m1.deps.registry], [2, 0, 0, { enabled: false }]);
    assert.equal(m1.deps.manifests[0].added[0].registry, undefined);
    assert.equal((await app.api('GET', '/api/config')).body.registry_enabled, '0');
  });

  test('coché : le tour contrôle les ajoutées seules (le nom privé ne part pas), la liste porte « 1 inconnue » et la réponse du registre par ligne ; rapport et brief suivent', async () => {
    const mauvais = await app.api('PUT', '/api/config', { registry_urls: 'bidule=https://x' });
    assert.ok(mauvais.status >= 400, 'un écosystème inconnu est refusé');
    await app.configure({ registry_enabled: '1', registry_urls: faux.urls, private_patterns: '@acme/*' });
    const c = (await app.api('GET', '/api/config')).body;
    assert.deepEqual([c.registry_enabled, c.registry_urls, c.private_patterns, String(c.registry_max), String(c.registry_recent_days)], ['1', faux.urls, '@acme/*', '30', '30']);
    const r = (await app.api('POST', '/api/discover')).body;
    assert.deepEqual([r.files.registry.controles, r.files.registry.appels, r.files.registry.inconnus, r.files.registry.par_registre], [2, 2, 1, { npm: 2 }]);
    assert.deepEqual(faux.state.hits.map((h) => h.path).sort(), ['/left-pad', '/vitest'], 'les deux noms ajoutés de !1, et rien d’autre — ni @acme/ui (privé), ni axios (changée)');
    for (const h of faux.state.hits) assert.ok(!h.headers.authorization && !h.headers.cookie && !h.headers['private-token'], 'aucun en-tête d’identification');
    const m1 = await de(1);
    assert.deepEqual([m1.deps.added, m1.deps.unknown, m1.deps.recent, m1.deps.registry.enabled], [2, 1, 0, true]);
    assert.deepEqual(Object.keys(m1.deps.registry.contacted), ['npm']);
    assert.deepEqual(m1.deps.manifests[0].added.map((e) => [e.name, e.registry.status, e.registry.reason, e.registry.label]), [['left-pad', 'unknown', '404', 'npm'], ['vitest', 'known', null, 'npm']]);
    assert.equal(m1.deps.manifests[0].changed[0].registry, undefined, 'une changée n’est pas contrôlée');
    const m2 = await de(2);
    assert.deepEqual([m2.deps.added, m2.deps.unknown], [1, 0]);
    assert.deepEqual([m2.deps.manifests[0].added[0].registry.status, m2.deps.manifests[0].added[0].registry.reason], ['skipped', 'private-pattern']);
    assert.equal((await app.api('GET', `/api/mrs/${ids[1]}`)).body.deps.unknown, 1, 'le rapport porte le même badge');
    const b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.new_deps.map((m) => [m.iid, m.added, m.unknown, m.recent]), [[1, 2, 1, 0], [2, 1, 0, 0]]);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM registry_lookup').get().n, 2, 'le cache : un nom, une ligne');
    faux.reset();
    await app.api('POST', '/api/discover');
    assert.equal(faux.state.hits.length, 0, 'le tour suivant ne redemande rien : le cache est frais');
    assert.equal((await lister()).length, 2, 'l’affichage ne fait aucun appel');
  });

  test('la ligne de projet d’une session se complète au rendu suivant : « 2 dépendances ajoutées · 1 inconnue »', async () => {
    const now = new Date().toISOString();
    taskId = Number(app.db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at)
      VALUES (?, 'code', 'Ajouter le calcul', 'feature/x', 'done', ?, ?)`).run(repoId, now, now).lastInsertRowid);
    const diff = path.join(app.dataDir, 'diff-x.patch');
    fs.writeFileSync(diff, fixture('monorepo.diff'));
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, commit_sha, diff_path, updated_at)
      VALUES (?, ?, 'feature/x', 'main', 'committed', 'abc123', ?, ?)`).run(taskId, repoId, diff, now);
    app.db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, updated_at) VALUES (?, ?, 'feature/y', 'main', 'new', ?)`).run(taskId, repoId, now);
    faux.reset();
    let t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(t.targets[0].deps.added, 2);
    // Le contrôle part en arrière-plan ; le rendu suivant le montre.
    for (let i = 0; i < 100 && (await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].deps.unknown + (await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].deps.recent === 0 && faux.state.hits.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100; i += 1) {
      t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
      if (t.targets[0].deps.unknown + t.targets[0].deps.recent > 0 || app.db.prepare("SELECT COUNT(*) n FROM registry_lookup WHERE name IN ('left-pad', 'dayjs')").get().n === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    t = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.deepEqual([t.targets[0].deps.added, t.targets[0].deps.unknown], [2, 1], 'left-pad inconnu ; dayjs connu');
    assert.deepEqual(faux.state.hits.map((h) => h.path).sort(), ['/dayjs'], 'left-pad était déjà au cache : un seul appel');
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

    test('la carte dit « +2 dépendances · 1 inconnue · 1 majeur » ; le panneau nomme ce que le registre a répondu, et son pied les registres contactés', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      const b1 = carte.locator('.tag.deps');
      await b1.waitFor({ state: 'visible' });
      assert.match(await b1.innerText(), /\+2 (dépendances|dependencies) · 1 (inconnue|unknown) · 1 (majeur|major)/);
      assert.doesNotMatch(await page.locator(`#toReviewList .card[data-id="${ids[2]}"] .tag.deps`).innerText(), /inconnue|unknown/, 'le paquet privé n’est pas une alerte');
      await b1.click();
      const panneau = carte.locator('.deps-panel');
      await panneau.waitFor({ state: 'visible' });
      const lignes = await panneau.locator('.deps-rows li').allInnerTexts();
      assert.match(lignes[0], /left-pad\s+\^1\.3\.0\s+(ajoutée|added) · prod · (inconnu du registre public npm|unknown to the public registry npm)/);
      assert.match(lignes[1], /vitest\s+\^2\.0\.0\s+(ajoutée|added) · dev · (publié depuis \d{4} \(npm\)|published since \d{4} \(npm\))/);
      assert.doesNotMatch(lignes[2], /npm/, 'la changée ne porte rien du registre');
      const pied = panneau.locator('[data-deps-registre="on"]');
      assert.match(await pied.innerText(), /(Registres contactés|Registries contacted)\s*:\s*npm/);
      assert.equal(await panneau.locator('a[href]').count(), 0, 'aucun lien vers la page du paquet');
      // Un faux « inconnu » sur un paquet privé se corrige depuis le panneau : le lien mène aux motifs privés.
      await pied.locator('[data-deps-champ="private_patterns"]').click();
      await page.waitForSelector('#tab-admin.active');
      await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'private_patterns');
      /* Le formulaire se remplit APRÈS l'ouverture de l'onglet (`loadConfig` est asynchrone) : on attend la
         valeur, on ne la lit pas au vol — sur un runneur à deux cœurs, le focus arrive avant la réponse. */
      await page.waitForFunction(() => document.querySelector('#sub-mr [name="private_patterns"]').value === '@acme/*');
      await page.waitForFunction(() => document.querySelector('#sub-mr [name="registry_enabled"]').checked);
      await page.waitForFunction(() => /^npm=http:\/\/127\.0\.0\.1:\d+/.test(document.querySelector('#sub-mr [name="registry_urls"]').value));
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('le panneau de !2 dit « paquet privé » ; le brief et la ligne de session portent « 1 inconnue »', async () => {
      await page.locator('nav button[data-tab="review"]').click();
      const carte = page.locator(`#toReviewList .card[data-id="${ids[2]}"]`);
      await carte.locator('.tag.deps').click();
      const panneau = carte.locator('.deps-panel');
      await panneau.waitFor({ state: 'visible' });
      assert.match((await panneau.locator('.deps-rows li').allInnerTexts())[0], /@acme\/ui.*(non contrôlé · paquet privé|not checked · private package)/);
      await page.keyboard.press('Escape');
      await panneau.waitFor({ state: 'detached' });

      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
      const ligne = page.locator('#briefBox [data-brief-deps]').first();
      await ligne.waitFor({ state: 'visible' });
      assert.match(await ligne.innerText(), /\+2 (dépendances|dependencies) · 1 (inconnue|unknown)/);

      await page.locator('nav button[data-tab="task"]').click();
      await page.locator(`#taskList .task-row[data-task="${taskId}"] .targets-toggle`).click();
      const tag = page.locator(`#taskList .task-row[data-task="${taskId}"] .target-line .tag.deps`);
      await tag.waitFor({ state: 'visible' });
      assert.match(await tag.innerText(), /2 (dépendances ajoutées|dependencies added) · 1 (inconnue|unknown)/);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('décoché : plus de complément sur la carte, et le pied du panneau dit « désactivé » avec son lien vers le réglage', async () => {
      await app.configure({ registry_enabled: '0' });
      await page.locator('nav button[data-tab="review"]').click();
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && !/inconnue|unknown/.test(b.textContent); }, `#toReviewList .card[data-id="${ids[1]}"] .tag.deps`);
      await carte.locator('.tag.deps').click();
      const panneau = carte.locator('.deps-panel');
      await panneau.waitFor({ state: 'visible' });
      const pied = panneau.locator('[data-deps-registre="off"]');
      assert.match(await pied.innerText(), /(Contrôle au registre désactivé|Registry check disabled)/);
      await pied.locator('[data-deps-champ="registry_enabled"]').click();
      await page.waitForSelector('#tab-admin.active');
      await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'registry_enabled');
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });

  test('décoché à nouveau : un tour complet, zéro requête — y compris pour un SHA qui a bougé', async () => {
    await app.configure({ registry_enabled: '0' });
    faux.reset();
    app.state.mrs[GL][0].sha = 'f'.repeat(40);
    app.db.prepare('UPDATE mr SET current_sha = ? WHERE id = ?').run('f'.repeat(40), ids[1]);
    app.db.prepare('DELETE FROM registry_lookup').run();
    const r = (await app.api('POST', '/api/discover')).body;
    assert.equal(r.files.registry, null);
    assert.equal(faux.state.hits.length, 0);
    assert.deepEqual((await de(1)).deps.registry, { enabled: false });
    assert.equal((await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0].deps.unknown, 0);
  });
});
