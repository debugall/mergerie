'use strict';
/* MENU NOTES → AUJOURD'HUI : les sections qui viennent d'AILLEURS que la base.
 *
 * Une section du brief ne se remplit qu'avec un autre écran : « À nettoyer » — le nombre de branches de MR mergées, lu par l'onglet Git.
 * Et deux saveurs de session qui attendent une réponse sans avoir de dépôt : hors dépôt et
 * question libre. Chacune mène à son écran, et c'est ce que ce fichier éprouve par l'écran.
 *
 * (« Conteneurs tombés » est la section du plugin Docker, « CI rouge sur mes branches » celle du plugin Jenkins : elles sont éprouvées chez eux.)
 *
 * Un seul `startApp()` ; `src/` n'est chargé qu'APRÈS lui (voir e2e-veille). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Notes · Aujourd’hui — Git et sessions sans dépôt', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];
  const s = {};

  before(async () => {
    app = await startApp();
    await app.configure();

    app.state.mrs['grp/app'] = [{
      iid: 41, title: 'Le panier en trois fois', state: 'opened',
      source_branch: 'feature/panier', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/41', sha: 'sha41',
      created_at: '2026-03-01T10:00:00.000Z', author: { name: 'Alice' },
      diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'sha41' },
    }];
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', project: 'grp/app' });
    await app.api('POST', '/api/discover');
    const repoId = app.db.prepare("SELECT id FROM repo WHERE project = 'grp/app'").get().id;
    s.mr41 = app.db.prepare('SELECT id FROM mr WHERE iid = 41').get().id;

    // Dix merge requests mergées, dix branches mortes : le seuil du brief.
    for (let i = 0; i < 10; i += 1) {
      app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, closed_seen, updated_at)
        VALUES (?, ?, ?, ?, 'main', 'done', 1, datetime('now'))`).run(repoId, 500 + i, `mergée ${i}`, `feature/morte-${i}`);
    }

    // Deux sessions sans dépôt arrêtées sur une question.
    const now = new Date().toISOString();
    s.local = app.db.prepare(`INSERT INTO local_task (prompt, status, created_at, updated_at)
      VALUES ('Ranger mes scripts', 'needs_input', ?, ?)`).run(now, now).lastInsertRowid;
    s.ask = app.db.prepare(`INSERT INTO question (prompt, status, created_at, updated_at)
      VALUES ('Pourquoi le cache expire ?', 'needs_input', ?, ?)`).run(now, now).lastInsertRowid;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    // L'application s'ouvre sur Reviews : la file (et ses branches) est chargée.
    await page.waitForSelector(`#toReviewList .card[data-id="${s.mr41}"]`);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const allerBrief = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
    await page.waitForSelector('#notesSubToday:not([hidden]) #briefBox .brief-head');
  };
  const section = (titre) => page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: titre }) });

  test('dix branches mergées à nettoyer : le brief le dit une fois l’onglet Git vu, et « Nettoyer » prépare le lot', async () => {
    // Le nombre est lu par l'onglet Git : on y passe, comme au quotidien.
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gitMergedBar:not([hidden])');
    await allerBrief();
    const sec = section('À nettoyer');
    await sec.waitFor();
    assert.match(await sec.innerText(), /10 branches de merge requests mergées à nettoyer/);
    await sec.locator('[data-brief-branches]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gsub-actions.active');
    await page.waitForFunction(() => document.querySelector('#gitAction').value === 'delete_branch');
  });

  test('une session hors dépôt et une question libre en attente mènent chacune à leur carte', async () => {
    await allerBrief();
    const sec = section('Sessions en attente de réponse');
    await sec.waitFor();
    assert.match(await sec.innerText(), /Ranger mes scripts/);
    assert.match(await sec.innerText(), /Pourquoi le cache expire/);

    await sec.locator(`[data-brief-session="${s.local}"][data-brief-kind="local"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/local/${t}`, s.local);

    await allerBrief();
    await section('Sessions en attente de réponse').locator(`[data-brief-session="${s.ask}"][data-brief-kind="ask"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/ask/${t}`, s.ask);
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
