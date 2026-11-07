'use strict';
/* LES CROISEMENTS DE MERGE REQUESTS, DE BOUT EN BOUT — deux MR ouvertes du même dépôt qui modifient
 * les mêmes fichiers, dit avant que la forge ne parle de conflit.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur : la découverte relève
 * les listes de fichiers sous plafond (les plus actives d'abord, le reste au tour suivant, et la
 * réponse de la découverte le dit) ; la liste des MR porte les croisements et le relevé, sans
 * aucun appel de forge à l'affichage ; le brief liste les paires, une croix écarte UNE paire et
 * une paire nouvelle reparaît ; la modale de session compte les MR ouvertes du dépôt ; décoché,
 * le réglage retire tout. Puis à l'écran : le badge sur la carte, le panneau ancré (chemins,
 * relevé), Échap, et la section du brief qui ouvre Reviews filtré sur le dépôt.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Croisements de merge requests', () => {
  let app; let gl;
  const GL = 'grp/app';
  const ids = {};     // iid → id interne

  const mrGl = (iid, extra) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
    web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: `${iid}`.repeat(40).slice(0, 40),
    created_at: `2026-01-0${iid}T10:00:00.000Z`, updated_at: `2026-02-0${iid}T10:00:00.000Z`,
    author: { name: 'Alice', username: 'alice' },
    ...extra,
  });
  const appels = () => app.state.calls.filter((c) => /\/merge_requests\/\d+\/changes/.test(c.path)).length;
  const lister = async () => (await app.api('GET', '/api/mrs')).body;

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/1' });
    /* Cinq merge requests : !1 et !2 touchent `src/tva.js`, !5 touche `src/tva.js` ET
       `src/a.js` ; !3 et !4 ne croisent rien. Les plus récemment actives sont !5, !4, !3… */
    app.state.mrs[GL] = [mrGl(1), mrGl(2), mrGl(3), mrGl(4), mrGl(5)];
    app.state.changes[`${GL}!1`] = [{ new_path: 'src/tva.js' }, { new_path: 'src/a.js' }];
    app.state.changes[`${GL}!2`] = [{ new_path: 'src/tva.js' }, { new_path: 'src/b.js' }];
    app.state.changes[`${GL}!3`] = [{ new_path: 'docs/c.md' }];
    app.state.changes[`${GL}!4`] = [{ new_path: 'docs/d.md' }];
    app.state.changes[`${GL}!5`] = [{ old_path: 'src/ancien.js', new_path: 'src/tva.js', renamed_file: true }, { new_path: 'src/a.js' }];
    await app.configure({ mr_files_max: '2' });
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
  });

  after(async () => { if (app) await app.stop(); });

  test('la découverte relève les listes sous plafond, les plus actives d’abord, et le dit', async () => {
    const r1 = await app.api('POST', '/api/discover');
    assert.equal(r1.status, 200);
    assert.equal(r1.body.files.releves, 2);
    assert.equal(r1.body.files.restants, 3, 'trois listes attendent le tour suivant');
    assert.equal(appels(), 2, 'deux appels forge, pas un de plus');
    for (const m of await lister()) ids[m.iid] = m.id;
    const avant = await lister();
    assert.ok(avant.find((m) => m.iid === 5).files_fetch, '!5, la plus active, est relevée');
    assert.equal(avant.find((m) => m.iid === 1).files_fetch, null, '!1 attend : elle n’affiche rien, pas un faux « aucun croisement »');
    assert.deepEqual(avant.find((m) => m.iid === 1).overlaps, []);

    const r2 = await app.api('POST', '/api/discover');
    assert.equal(r2.body.files.releves, 2); assert.equal(r2.body.files.restants, 1);
    const r3 = await app.api('POST', '/api/discover');
    assert.equal(r3.body.files.releves, 1); assert.equal(r3.body.files.restants, 0);
    assert.equal(appels(), 5);
    const r4 = await app.api('POST', '/api/discover');
    assert.equal(r4.body.files.releves, 0);
    assert.equal(appels(), 5, 'tout est relevé : plus aucun appel tant que les SHA ne bougent pas');
  });

  test('la liste porte les croisements, symétriques, avec les chemins communs et le relevé — sans appel de forge', async () => {
    const n = appels();
    const liste = await lister();
    const m1 = liste.find((m) => m.iid === 1);
    assert.deepEqual(m1.overlaps.map((o) => o.iid).sort(), [2, 5]);
    const avec5 = m1.overlaps.find((o) => o.iid === 5);
    assert.equal(avec5.shared, 2);
    assert.deepEqual(avec5.paths, ['src/a.js', 'src/tva.js']);
    assert.equal(avec5.title, 'MR 5');
    assert.equal(avec5.author, 'Alice');
    assert.equal(m1.files_fetch.sha, '1'.repeat(40));
    assert.equal(m1.files_fetch.refused, null);
    const m5 = liste.find((m) => m.iid === 5);
    assert.deepEqual(m5.overlaps.map((o) => o.iid).sort(), [1, 2]);
    assert.ok(m5.files_fetch, 'le renommage a été relevé');
    assert.deepEqual(liste.find((m) => m.iid === 3).overlaps, [], 'rien en commun : aucun croisement');
    assert.equal(appels(), n, 'l’affichage ne fait aucun appel de forge');
    const detail = (await app.api('GET', `/api/mrs/${ids[1]}`)).body;
    assert.deepEqual(detail.overlaps.map((o) => o.iid).sort(), [2, 5], 'le rapport porte le même badge');
  });

  test('un renommage compte pour les deux chemins', async () => {
    const paths = app.db.prepare('SELECT path FROM mr_files WHERE mr_id = ? ORDER BY path').all(ids[5]).map((r) => r.path);
    assert.deepEqual(paths, ['src/a.js', 'src/ancien.js', 'src/tva.js']);
  });

  test('le SHA de tête bouge : la liste est invalidée, le badge disparaît, le tour suivant la relève', async () => {
    app.state.mrs[GL][1].sha = 'f'.repeat(40);
    app.state.changes[`${GL}!2`] = [{ new_path: 'src/b.js' }];        // !2 ne touche plus tva.js
    const n = appels();
    const r = await app.api('POST', '/api/discover');
    assert.equal(r.body.files.releves, 1);
    assert.equal(appels(), n + 1);
    const m1 = (await lister()).find((m) => m.iid === 1);
    assert.deepEqual(m1.overlaps.map((o) => o.iid), [5], '!2 ne croise plus !1');
  });

  test('le brief liste les paires, une croix écarte UNE paire, une paire nouvelle reparaît', async () => {
    let b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.overlaps.map((p) => [p.a_iid, p.b_iid]), [[1, 5]]);
    assert.equal(b.overlaps[0].shared, 2);
    assert.equal(b.overlaps[0].project, GL);
    const cle = b.overlaps[0].key;
    const e = await app.api('POST', '/api/brief/hidden', { kind: 'croisement', ref: cle });
    assert.equal(e.status, 200);
    b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.overlaps, [], 'la paire écartée ne revient pas');
    // !3 se met à toucher src/a.js : une paire NOUVELLE (!1 ↔ !3) reparaît, l'écartée reste écartée.
    app.state.mrs[GL][2].sha = 'e'.repeat(40);
    app.state.changes[`${GL}!3`] = [{ new_path: 'docs/c.md' }, { new_path: 'src/a.js' }];
    await app.api('POST', '/api/discover');
    b = (await app.api('GET', '/api/brief')).body;
    assert.deepEqual(b.overlaps.map((p) => [p.a_iid, p.b_iid].sort()), [[1, 3], [3, 5]]);
    await app.api('DELETE', '/api/brief/hidden');
    b = (await app.api('GET', '/api/brief')).body;
    assert.equal(b.overlaps.length, 3);
  });

  test('une MR mergée ne croise plus rien, tout de suite', async () => {
    app.state.mrs[GL] = app.state.mrs[GL].filter((m) => m.iid !== 5);
    await app.api('POST', '/api/discover');
    const m1 = (await lister()).find((m) => m.iid === 1);
    assert.deepEqual(m1.overlaps.map((o) => o.iid), [3]);
  });

  test('la modale de session compte les MR ouvertes du dépôt et nomme les croisements de la branche', async () => {
    const r = await app.api('POST', '/api/croisements/session', { targets: [{ repo_id: (await lister())[0].repo_id, branch: 'feature/1' }], text: 'Nettoyer le module' });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    const c = r.body.targets[0];
    assert.equal(c.open, 4);
    assert.equal(c.mr.iid, 1);
    assert.deepEqual(c.overlaps.map((o) => o.iid), [3]);
    assert.deepEqual(c.paths, [], 'aucun clone : aucun chemin détecté, et rien d’inventé');
  });

  test('réglage décoché : aucun badge, aucun appel supplémentaire, aucune paire dans le brief', async () => {
    await app.configure({ mr_files_enabled: '0', mr_files_max: '2' });
    const n = appels();
    const r = await app.api('POST', '/api/discover');
    assert.equal(r.body.files.releves, 0);
    assert.equal(appels(), n);
    assert.deepEqual((await lister()).find((m) => m.iid === 1).overlaps, []);
    assert.deepEqual((await app.api('GET', '/api/brief')).body.overlaps, []);
    assert.equal((await app.api('POST', '/api/croisements/session', { targets: [{ repo_id: 1 }] })).body.enabled, false);
    await app.configure({ mr_files_enabled: '1', mr_files_max: '2' });
    assert.deepEqual((await lister()).find((m) => m.iid === 1).overlaps.map((o) => o.iid), [3], 'recoché : les listes relevées sont toujours là');
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

    test('la carte porte le badge « croise », le panneau s’ouvre ancré sur la carte et se ferme à Échap', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      const badge = carte.locator('.tag.croise');
      await badge.waitFor({ state: 'visible' });
      assert.match(await badge.innerText(), /!3/);
      assert.match(await badge.innerText(), /1 (fichier|file)/);
      assert.equal(await page.locator(`#toReviewList .card[data-id="${ids[4]}"] .tag.croise`).count(), 0, 'pas de badge « 0 croisement »');
      await badge.click();
      const panneau = carte.locator('.croise-panel');
      await panneau.waitFor({ state: 'visible' });
      assert.match(await panneau.locator('.croise-head').innerText(), /1 merge request/);
      assert.match(await panneau.locator('.croise-go').innerText(), /!3 — MR 3 · Alice/);
      assert.deepEqual(await panneau.locator('.croise-paths code').allInnerTexts(), ['src/a.js']);
      assert.match(await panneau.locator('.croise-foot').innerText(), /1111111/);
      await page.keyboard.press('Escape');
      await panneau.waitFor({ state: 'detached' });
      assert.equal(await badge.getAttribute('aria-expanded'), 'false');
    });

    test('une ligne du panneau mène à l’autre merge request', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids[1]}"]`);
      await carte.locator('.tag.croise').click();
      await carte.locator('.croise-panel .croise-go').click();
      const cible = page.locator(`#toReviewList .card[data-id="${ids[3]}"]`);
      await page.waitForFunction((sel) => { const c = document.querySelector(sel); return c && c.classList.contains('just-landed'); }, `#toReviewList .card[data-id="${ids[3]}"]`);
      assert.equal(await cible.locator('.croise-panel').count(), 0, 'le panneau est refermé');
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('le brief liste la paire et l’ouvre dans Reviews, filtré sur le dépôt, les deux MR en tête', async () => {
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
      const sec = page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: /croisent|Overlapping/ }) });
      await sec.waitFor({ state: 'visible' });
      const ligne = sec.locator('[data-brief-croise]').first();
      assert.match(await ligne.innerText(), /!1 ↔ !3/);
      assert.ok(await ligne.locator('[data-brief-hide^="croisement:"]').count() === 1, 'la croix écarte la paire');
      await ligne.click();
      await page.waitForSelector('#tab-review.active');
      await page.waitForFunction((n) => {
        const cartes = [...document.querySelectorAll('#toReviewList .card[data-id]')];
        return cartes.length >= 2 && cartes.slice(0, 2).every((c) => n.includes(Number(c.dataset.id)));
      }, [ids[1], ids[3]]);
      assert.equal(await page.locator('#searchReview').inputValue(), GL);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
