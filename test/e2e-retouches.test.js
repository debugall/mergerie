'use strict';
/* LES RETOUCHES APRÈS MERGE, DE BOUT EN BOUT — « retouchée par !2 · 3 j · 4 lignes » sur la carte
 * d'une merge request mergée au vert dont une autre a réécrit le code, le miroir « retouche !1 »
 * sur la carte de la retouche, et la table « Note contre retouche » dans Stats.
 *
 * Ce que le test prouve, avec le VRAI client GitLab contre le faux serveur et un VRAI dépôt git :
 * la découverte voit A puis B passer à `merged`, lit leurs SHA de squash, et le tour des retouches
 * (sur le clone, `git blame`, sans aucun appel de forge de plus) relie B à A — 4 lignes, 3 jours ;
 * la liste et le détail portent le lien des deux côtés ; « Pas un correctif » le requalifie avec son
 * auteur et le sort du chiffre ; Stats dit sa fenêtre, son plancher, la tranche de note ; les quatre
 * réglages s'enregistrent et se relisent. Puis à l'écran : le badge, le panneau et ses plages de
 * lignes, le geste, la carte Stats, les champs de Réglages. Un seul `startApp()`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, git, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const JOUR = 24 * 3600 * 1000;
const il_y_a = (jours) => new Date(Date.now() - jours * JOUR).toISOString();

describe('Retouches après merge', () => {
  let app; let gl; let repoId;
  const GL = 'grp/app';
  const ids = {};
  const shas = {};
  const lignes = (n, prefixe) => Array.from({ length: n }, (x, i) => `${prefixe} ${i + 1}`).join('\n');
  const mrGl = (iid, extra) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: `feature/${iid}`, target_branch: 'main',
    web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: shas[`head${iid}`],
    created_at: il_y_a(12), updated_at: il_y_a(0.5), author: { name: 'Alice', username: 'alice' },
    diff_refs: { base_sha: shas[`base${iid}`], head_sha: shas[`head${iid}`] },
    ...extra,
  });
  const lister = async () => (await app.api('GET', '/api/mrs')).body;
  const appelsForge = () => app.state.calls.length;

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/9' });
    const w = gl.work;
    const ecrire = (f, c) => fs.writeFileSync(path.join(w, f), `${c}\n`);
    const commit = (m) => { git(w, ['add', '-A']); git(w, ['commit', '-q', '-m', m]); return git(w, ['rev-parse', 'HEAD']).trim(); };
    /* A (!1) : dix lignes dans `src/tva.js`, squashée sur `main` ; B (!2) : en retire quatre, squashée
       trois jours plus tard. Les dates viennent de la forge, les SHA du dépôt. */
    git(w, ['checkout', '-q', 'main']);
    ecrire('src/tva.js', lignes(10, 'base')); commit('base tva');
    shas.base1 = git(w, ['rev-parse', 'HEAD']).trim();
    git(w, ['checkout', '-q', '-b', 'feature/1']);
    ecrire('src/tva.js', `${lignes(10, 'base')}\n${lignes(10, 'tva')}`); shas.head1 = commit('feat: tva');
    git(w, ['checkout', '-q', 'main']); git(w, ['merge', '--squash', '-q', 'feature/1']); shas.squash1 = commit('feat: tva (squash)');
    shas.base2 = shas.squash1;
    git(w, ['checkout', '-q', '-b', 'feature/2']);
    ecrire('src/tva.js', `${lignes(10, 'base')}\n${lignes(6, 'tva')}`); shas.head2 = commit('fix: quatre lignes de trop');
    git(w, ['checkout', '-q', 'main']); git(w, ['merge', '--squash', '-q', 'feature/2']); shas.squash2 = commit('fix: quatre lignes de trop (squash)');
    git(w, ['push', '-q', 'origin', 'main', 'feature/1', 'feature/2']);
    app.state.mrs[GL] = [mrGl(1), mrGl(2)];
    await app.configure({ fix_window_days: 5 });   // A mergée il y a 10 jours : son bilan est connu sous une fenêtre de 5
    const r = await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    repoId = r.body.id || (await app.api('GET', '/api/repos')).body.find((x) => x.project === GL).id;
  });

  after(async () => { if (app) await app.stop(); });

  test('la découverte voit A puis B mergées, et le tour des retouches relie B à A — 4 lignes, 3 jours, sans appel de forge de plus', async () => {
    const r1 = await app.api('POST', '/api/discover');
    assert.equal(r1.status, 200);
    for (const m of await lister()) ids[m.iid] = m.id;
    assert.ok(ids[1] && ids[2]);
    assert.equal(r1.body.fix_links.analysees, 0, 'rien n’est mergé : rien à analyser');
    // La forge dit maintenant : mergées, avec leurs SHA de squash.
    app.state.mrs[GL] = [
      mrGl(1, { state: 'merged', merged_at: il_y_a(10), squash_commit_sha: shas.squash1 }),
      mrGl(2, { state: 'merged', merged_at: il_y_a(7), squash_commit_sha: shas.squash2 }),
    ];
    const avant = appelsForge();
    const r2 = await app.api('POST', '/api/discover');
    assert.equal(r2.status, 200);
    assert.equal(r2.body.fix_links.analysees, 2, 'les deux MR mergées sont analysées (B puis A, qui n’a pas de candidat)');
    assert.equal(r2.body.fix_links.liens, 1);
    const appels = app.state.calls.slice(avant).map((c) => c.path);
    assert.ok(!appels.some((p) => /\/compare|\/diffs|\/commits|\/changes/.test(p)), `aucun appel de forge pour les retouches : ${appels.join(' ')}`);
    const liste = await lister();
    const a = liste.find((m) => m.iid === 1); const b = liste.find((m) => m.iid === 2);
    assert.ok(a.merged_at && b.merged_at);
    assert.equal(a.fix.touched_by.length, 1);
    const p = a.fix.touched_by[0];
    assert.equal(p.fix.iid, 2); assert.equal(p.kind, 'rewrites'); assert.equal(p.lines, 4); assert.equal(p.files, 1);
    assert.ok(Math.abs(p.days - 3) < 0.2);
    assert.deepEqual(p.ranges, { 'src/tva.js': [[17, 20]] });
    assert.equal(p.status, 'auto'); assert.equal(p.counted, true);
    assert.equal(p.bug_qualified, true, 'le commit `fix:` de B qualifie la retouche');
    assert.equal(a.fix.window, 5);
    assert.equal(b.fix.touches[0].origin.iid, 1, 'le miroir');
    assert.equal(b.fix.touched_by.length, 0);
    const d = await app.api('GET', `/api/mrs/${ids[1]}`);
    assert.equal(d.body.fix.touched_by[0].fix.iid, 2, 'le détail porte le lien');
    assert.equal((await app.api('GET', `/api/retouches/${ids[1]}`)).body.touched_by.length, 1);
    const r3 = await app.api('POST', '/api/discover');
    assert.equal(r3.body.fix_links.analysees, 0, 'analysée une fois, jamais deux');
  });

  test('Stats : la phrase, la fenêtre, la tranche de note, le dénominateur — et aucune clé d’auteur', async () => {
    // A a un rapport à 8,4 : elle se range dans la tranche « 8+ ».
    app.db.prepare("INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at) VALUES (?, '/nope.md', 0.84, ?, ?)").run(ids[1], il_y_a(11), il_y_a(11));
    app.db.prepare("UPDATE mr SET status = 'reviewed', status_at = ? WHERE id = ?").run(il_y_a(11), ids[1]);
    const s = (await app.api('GET', '/api/stats')).body.fixLinks;
    assert.equal(s.enabled, true); assert.equal(s.window, 5);
    assert.equal(s.merged, 2, 'A et B, mergées depuis plus de 5 jours');
    assert.equal(s.touched, 1); assert.equal(s.bug, 1); assert.equal(s.share, 50);
    assert.equal(s.pending, 0);
    const t8 = s.tranches.find((t) => t.tranche === '8+');
    assert.equal(t8.merged, 1); assert.equal(t8.touched, 1); assert.equal(t8.median_days, 3); assert.equal(t8.median_lines, 4);
    assert.equal(s.tranches.find((t) => t.tranche === 'none').merged, 1, 'B, sans rapport');
    assert.equal(s.repos[0].project, GL);
    assert.equal(s.links.length, 1); assert.equal(s.links[0].origin.iid, 1);
    assert.ok(!/"author/.test(JSON.stringify(s)));
    const s7 = (await app.api('GET', '/api/stats?days=7')).body.fixLinks;
    assert.equal(s7.merged, 0, 'une période de 7 jours : A (10 j) et B (7 j) n’y sont pas');
  });

  test('« Pas un correctif » requalifie le lien, le sort du chiffre, et un tour suivant ne le réécrit pas', async () => {
    const r = await app.api('POST', `/api/retouches/${ids[1]}/statut`, { fix_mr_id: ids[2], status: 'dismissed' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.link.status, 'dismissed'); assert.equal(r.body.link.counted, false);
    assert.ok(r.body.link.status_at);
    assert.equal((await app.api('GET', '/api/stats')).body.fixLinks.touched, 0);
    // Un recalcul forcé (le repère effacé) garde l'arbitrage.
    app.db.prepare('DELETE FROM mr_fix_scan').run();
    await app.api('POST', '/api/discover');
    const l = app.db.prepare('SELECT status, lines FROM mr_fix_link WHERE origin_mr_id = ? AND fix_mr_id = ?').get(ids[1], ids[2]);
    assert.equal(l.status, 'dismissed'); assert.equal(l.lines, 4);
    const mauvais = await app.api('POST', `/api/retouches/${ids[1]}/statut`, { fix_mr_id: ids[1], status: 'dismissed' });
    assert.equal(mauvais.status, 400);
    const defaire = await app.api('POST', `/api/retouches/${ids[1]}/statut`, { fix_mr_id: ids[2], status: 'auto' });
    assert.equal(defaire.body.link.status, 'auto');
  });

  test('les quatre réglages s’enregistrent et se relisent ; décoché, la liste ne porte plus rien', async () => {
    const r = await app.api('PUT', '/api/config', { fix_window_days: 30, fix_min_lines: 0, fix_links_max: 0 });
    assert.equal(r.status, 200, r.text);
    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(Number(c.fix_window_days), 30); assert.equal(Number(c.fix_min_lines), 0); assert.equal(Number(c.fix_links_max), 0);
    assert.equal(String(c.fix_links_enabled), '1');
    await app.api('PUT', '/api/config', { fix_links_enabled: '0' });
    assert.equal((await lister()).find((m) => m.iid === 1).fix, null);
    assert.equal((await app.api('GET', '/api/stats')).body.fixLinks.enabled, false);
    await app.api('PUT', '/api/config', { fix_links_enabled: '1', fix_window_days: 5, fix_min_lines: 3, fix_links_max: 10 });
    assert.ok((await lister()).find((m) => m.iid === 1).fix);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('la carte de A dit « retouchée par !2 · 3 j · 4 lignes », le panneau donne les plages, le geste requalifie', async () => {
      await page.locator('[data-seg="reviewed"]').click();
      const carte = page.locator(`#reportList .card[data-id="${ids[1]}"]`);
      await carte.locator('.tag.fix').waitFor();
      assert.match(await carte.locator('.tag.fix').innerText(), /retouchée par !2 · 3 j · 4 lignes|touched up by !2 · 3 d · 4 lines/);
      await carte.locator('.tag.fix').click();
      const panneau = carte.locator('.fix-panel');
      await panneau.waitFor();
      const texte = await panneau.innerText();
      assert.match(texte, /!2 — MR 2/);
      assert.match(texte, /src\/tva\.js : 17–20/, 'les plages de lignes, vérifiables avec git blame -L');
      assert.match(texte, /lignes réécrites|rewritten lines/);
      assert.match(texte, /qualifiée bug : commit fix:|qualified bug: fix: commit/);
      assert.match(texte, /Fenêtre : 5 j|Window: 5 d/);
      assert.ok(!/défaut|erreur du rapport/i.test(texte.replace(/par défaut/g, '')), 'jamais « défaut » ni « erreur du rapport »');
      await panneau.locator('[data-fix-status="dismissed"]').click();
      await page.waitForFunction((id) => { const t = document.querySelector(`#reportList .card[data-id="${id}"] .tag.fix`); return t && /évolution|followed/.test(t.textContent); }, ids[1]);
      const l = app.db.prepare('SELECT status FROM mr_fix_link WHERE origin_mr_id = ? AND fix_mr_id = ?').get(ids[1], ids[2]);
      assert.equal(l.status, 'dismissed');
      assert.equal((await app.api('GET', '/api/stats')).body.fixLinks.touched, 0);
      // Et le panneau dit « requalifié par … », avec le geste pour défaire.
      await carte.locator('.tag.fix').click();
      await carte.locator('.fix-panel').waitFor();
      assert.match(await carte.locator('.fix-panel').innerText(), /requalifié par|requalified by/);
      await carte.locator('.fix-panel [data-fix-status="auto"]').click();
      await page.waitForFunction((id) => { const t = document.querySelector(`#reportList .card[data-id="${id}"] .tag.fix`); return t && /retouchée par|touched up by/.test(t.textContent); }, ids[1]);
      assert.deepEqual(erreurs, []);
    });

    test('la carte de B porte le miroir « retouche !1 (8,4/10) », et l’en-tête de son rapport aussi', async () => {
      await page.locator('[data-seg="to_review"]').click();
      const carte = page.locator(`#toReviewList .card[data-id="${ids[2]}"]`);
      await carte.locator('.tag.fix').waitFor();
      assert.match(await carte.locator('.tag.fix').innerText(), /retouche !1 \(8,4\/10\)|touches up !1 \(8\.4\/10\)/);
    });

    test('Stats : la carte « Retouches », sa phrase avec la fenêtre et le plancher, la table par tranche', async () => {
      await page.locator('nav button[data-tab="dashboard"]').click();
      await page.waitForSelector('#dashFix .stats-fix-table tbody tr');
      const texte = await page.locator('#dashFix').innerText();
      assert.match(texte, /Sur 2 MR mergées.*1 ont été retouchées dans les 5 jours \(50 %\), dont 1 qualifiées bug/);
      assert.match(texte, /Chiffres planchers|Floor figures/);
      const lignesT = await page.$$eval('#dashFix .stats-fix-table tbody tr', (trs) => trs.map((t) => [...t.querySelectorAll('td')].map((c) => c.textContent.trim())));
      assert.equal(lignesT.length, 4);
      assert.deepEqual(lignesT[0].slice(0, 5), ['8 et plus', '1', '1', '1', '100 %']);
      assert.deepEqual(lignesT[3].slice(0, 4), ['sans rapport', '1', '0', '0']);
      assert.match(await page.locator('#dashFix .stats-fix-list').innerText(), /!1 .*MR 1/);
      const entetes = await page.$$eval('#dashFix th', (ths) => ths.map((t) => t.textContent.trim()));
      assert.ok(entetes.length >= 7 && !entetes.some((h) => /auteur|author/i.test(h)), `jamais une colonne par auteur : ${entetes.join(', ')}`);
      assert.deepEqual(erreurs, []);
    });

    test('Réglages → Merge Request : les quatre réglages, relus avec leurs valeurs', async () => {
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('[data-sub="mr"]').click();
      await page.waitForSelector('#sub-mr [name="fix_links_enabled"]');
      assert.equal(await page.locator('#sub-mr [name="fix_links_enabled"]').isChecked(), true);
      assert.equal(await page.locator('#sub-mr [name="fix_window_days"]').inputValue(), '5');
      assert.equal(await page.locator('#sub-mr [name="fix_min_lines"]').inputValue(), '3');
      assert.equal(await page.locator('#sub-mr [name="fix_links_max"]').inputValue(), '10');
    });
  });
});
