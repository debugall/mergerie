'use strict';
/* « METTRE À JOUR AVEC L'IA » SUR UNE MERGE REQUEST EN CONFLIT.
 *
 * Le badge « en conflit » d'une carte offrait une voie : résoudre soi-même dans Git → Merge.
 * L'autre voie est de confier la mise à jour à l'agent : rejouer les changements de la branche
 * par-dessus la cible, résoudre en comprenant ce que la branche voulait, commiter — et NE PAS
 * pousser, pour relire. Le bouton ouvre la modale de session pré-remplie (dépôt, branche de la
 * MR, base = sa cible, consigne, push automatique décoché) ; la session créée est marquée
 * « push forcé », l'historique allant être réécrit. Rien n'est lancé sans le clic suivant.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Merge request en conflit → « Mettre à jour avec l’IA »', () => {
  let app; let repoId; let mrId; let mrRetardId; let mrAJourId; let navigateur; let page;
  const erreurs = [];
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

  before(async () => {
    app = await startApp();
    const distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    git(distant, 'init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'ligne 1\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
    mrId = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, has_conflicts, web_url, updated_at)
      VALUES (?, 77, 'Paiement 3×', 'feat/paiement', 'main', 'to_review', 1, 'https://gitlab.test/grp/app/-/merge_requests/77', ?)`)
      .run(repoId, new Date().toISOString()).lastInsertRowid;
    /* EN RETARD SANS CONFLIT : la cible a avancé de trois commits que la branche n'a pas. Ça se
       merge, mais le même bouton s'impose. Et une merge request À JOUR, qui ne porte rien. */
    const ins = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, has_conflicts, behind_by, web_url, updated_at)
      VALUES (?, ?, ?, ?, 'main', 'to_review', ?, ?, ?, ?)`);
    mrRetardId = ins.run(repoId, 78, 'Export CSV', 'feat/export', 0, 3, 'https://gitlab.test/grp/app/-/merge_requests/78', new Date().toISOString()).lastInsertRowid;
    mrAJourId = ins.run(repoId, 79, 'Typo', 'fix/typo', 0, 0, 'https://gitlab.test/grp/app/-/merge_requests/79', new Date().toISOString()).lastInsertRowid;
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    await app.stop();
  });

  test('l’API marque la cible « push forcé » à la création quand on le demande — en codage seulement', async () => {
    const avec = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'p', force_push: true, targets: [{ repo_id: repoId, branch: 'feat/paiement', base_branch: 'main' }] })).body.id;
    const sans = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'feat/autre' }] })).body.id;
    const explo = (await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'p', force_push: true, targets: [{ repo_id: repoId }] })).body.id;
    const force = (id) => app.db.prepare('SELECT force_push FROM task_target WHERE task_id = ?').get(id).force_push;
    assert.equal(force(avec), 1);
    assert.equal(force(sans), 0);
    assert.equal(force(explo), 0, 'une exploration ne pousse rien : le drapeau est ignoré');
  });

  describe('le bouton, sur la carte', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
      await page.waitForSelector(`[data-mr-rebase="${mrId}"]`, { state: 'visible' });
    });

    test('il ouvre la modale de session pré-remplie : branche de la MR, sa cible, la consigne, sans push automatique', async () => {
      await page.locator(`[data-mr-rebase="${mrId}"]`).click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.match(await page.locator('#taskModalTitle').innerText(), /feat\/paiement[\s\S]*main/);
      const prompt = await page.locator('#taskForm [name="prompt"]').inputValue();
      assert.match(prompt, /!77/);
      assert.match(prompt, /git rebase origin\/main/);
      assert.match(prompt, /NE POUSSE PAS/);
      assert.equal(await page.locator('#taskForm [name="auto_push"]').isChecked(), false, 'on relit avant de pousser');
      assert.match(await page.locator('#taskExistingImgs').innerText(), /force-with-lease/);
      assert.match(await page.locator('#taskForm [name="commit_message"]').inputValue(), /feat\/paiement[\s\S]*main/);
    });

    test('créer sans lancer : la session vise la branche de la MR depuis sa cible, et poussera en forçant', async () => {
      const avant = app.db.prepare('SELECT COUNT(*) n FROM task').get().n;
      await page.locator('#taskSubmitOnly').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      // La modale se ferme quand le serveur a répondu : on relit la base, pas l'écran.
      for (let i = 0; i < 100 && app.db.prepare('SELECT COUNT(*) n FROM task').get().n === avant; i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.equal(app.db.prepare('SELECT COUNT(*) n FROM task').get().n, avant + 1);
      const task = app.db.prepare('SELECT * FROM task ORDER BY id DESC LIMIT 1').get();
      assert.equal(task.status, 'new', 'rien n’est lancé sans le clic suivant');
      assert.equal(task.auto_push, 0);
      assert.match(task.prompt, /git rebase origin\/main/);
      const tg = app.db.prepare('SELECT * FROM task_target WHERE task_id = ?').get(task.id);
      assert.equal(tg.repo_id, repoId);
      assert.equal(tg.branch, 'feat/paiement');
      assert.equal(tg.base_branch, 'main');
      assert.equal(tg.force_push, 1, 'l’historique sera réécrit : « Pousser » forcera');
    });

    test('en retard sans conflit : le badge dit le retard, et le même bouton est là ; à jour : rien', async () => {
      const retard = page.locator(`#mrList .tag.retard[data-mr-conflit="${mrRetardId}"], .tag.retard[data-mr-conflit="${mrRetardId}"]`).first();
      await retard.waitFor({ state: 'visible' });
      assert.match(await retard.innerText(), /3 commit/);
      assert.equal(await page.locator(`[data-mr-rebase="${mrRetardId}"]`).count(), 1, 'le bouton IA, comme pour un conflit');
      assert.equal(await page.locator(`.tag.conflit[data-mr-conflit="${mrRetardId}"]`).count(), 0, 'pas de badge « en conflit » pour un simple retard');
      assert.equal(await page.locator(`[data-mr-rebase="${mrAJourId}"]`).count(), 0, 'une branche à jour n’a rien à mettre à jour');
      assert.equal(await page.locator(`[data-mr-conflit="${mrAJourId}"]`).count(), 0);
    });

    test('en retard : la consigne dit le retard, pas un conflit, et rebase quand même', async () => {
      await page.locator(`[data-mr-rebase="${mrRetardId}"]`).click();
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.waitForFunction(() => /!78/.test(document.querySelector('#taskForm [name="prompt"]').value));
      const prompt = await page.locator('#taskForm [name="prompt"]').inputValue();
      assert.match(prompt, /3 commit\(s\) de retard sur main/);
      assert.doesNotMatch(prompt, /est en conflit/);
      assert.match(prompt, /git rebase origin\/main/);
      assert.match(prompt, /NE POUSSE PAS/);
      assert.equal(await page.locator('#taskForm [name="auto_push"]').isChecked(), false);
      await page.locator("#taskCancel").click();
    });

    test('aucune erreur JavaScript pendant ce parcours', () => {
      assert.deepEqual(erreurs, []);
    });
  });
});
