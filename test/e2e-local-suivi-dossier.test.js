'use strict';
/* SUIVI D'UN SEUL DOSSIER, hors dépôt — comme « Demander une correction » sur un projet de codage.
   Sur une session à plusieurs dossiers, la remarque vaut presque toujours pour un seul : la passer à
   tous coûtait une passe d'agent par dossier et faisait repasser l'agent sur du travail qu'on ne
   voulait plus voir toucher. On le prouve par l'API, par la ligne du dossier sur la carte, et par la
   vue « Retour de l'IA » ouverte sur un dossier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const dispo = navigateurDispo();

describe('Hors dépôt — suivi d’un seul dossier', () => {
  let app; let navigateur; let page;
  const mkdir = () => fs.mkdtempSync(path.join(app.dataDir, 'lsuivi-'));
  const passes = (taskId, dirId) => app.db
    .prepare("SELECT kind, prompt FROM agent_pass WHERE scope = 'local' AND task_id = ? AND unit_id = ? ORDER BY n").all(taskId, dirId);
  // Une session à deux dossiers, déjà traités tous les deux.
  async function sessionDeux(prompt) {
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt, dirs: [mkdir(), mkdir()] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const dirs = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task.dirs;
    assert.ok(dirs.every((d) => d.status === 'done'), 'les deux dossiers ont tourné');
    return { lt, dirs };
  }

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => {
    if (navigateur) await navigateur.close();
    await app.stop();
  });

  test('par l’API : `dirs` restreint le suivi, sans lui tous les dossiers repassent', async () => {
    const { lt, dirs } = await sessionDeux('Range les imports');
    const r = await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Trie aussi les exports', dirs: [dirs[1].id] });
    assert.equal(r.status, 200);
    await waitForJobs(app.api);
    assert.deepEqual(passes(lt.id, dirs[0].id).map((p) => p.kind), ['run'], 'le premier dossier n’a pas retravaillé');
    assert.deepEqual(passes(lt.id, dirs[1].id).map((p) => p.kind), ['run', 'followup']);
    assert.match(passes(lt.id, dirs[1].id)[1].prompt, /Trie aussi les exports/);

    const inconnu = await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'x', dirs: [999999] });
    assert.equal(inconnu.status, 400, 'un dossier inconnu est refusé, pas un suivi lancé partout');

    await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Partout' });
    await waitForJobs(app.api);
    assert.equal(passes(lt.id, dirs[0].id).length, 2, 'sans `dirs`, le suivi vaut toujours pour tous');
    assert.equal(passes(lt.id, dirs[1].id).length, 3);
  });

  /* « VOIR LE DIFF » D'UN DOSSIER : toute la session, pas la dernière itération — les deux passes
     écrivent ici chacune une ligne `## …` dans le même fichier, le diff doit porter les deux. */
  test('« Voir le diff » d’un dossier : tout ce que la session y a changé, de la première passe à la dernière', async () => {
    const { lt, dirs } = await sessionDeux('Range les imports');
    fs.writeFileSync(path.join(dirs[0].path, 'intact.js'), 'x\n');
    await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Encore', dirs: [dirs[0].id] });
    await waitForJobs(app.api);
    const d0 = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task.dirs[0];
    assert.equal(d0.has_diff, 1);

    const dv = (await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${d0.id}/diffview`)).body;
    assert.equal(dv.project, d0.path);
    const ajouts = dv.diff.split('\n').filter((l) => l.startsWith('+## '));
    assert.equal(ajouts.length, 2, 'les deux passes, pas seulement la dernière');
    assert.ok(dv.files.some((f) => f.path === 'PROJ_LOCAL_DRYRUN.md' && f.changed));
    const f = await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${d0.id}/filediff?path=PROJ_LOCAL_DRYRUN.md`);
    assert.equal(f.status, 200);

    // Jamais lancé : rien à montrer, et la route le dit au lieu d'ouvrir une vue vide.
    const { body: neuf } = await app.api('POST', '/api/local-tasks', { prompt: 'plus tard', dirs: [mkdir()] });
    assert.equal(neuf.dirs[0].has_diff, 0);
    const r = await app.api('GET', `/api/local-tasks/${neuf.id}/dirs/${neuf.dirs[0].id}/diffview`);
    assert.equal(r.status, 400);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    const erreurs = [];
    async function ouvrirListe() {
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-kind="local"]').click();
      await page.waitForSelector('#localList .card');
    }
    async function deplier(carte) {
      if (await carte.locator('.targets').isHidden()) await carte.locator('[data-tfold]').click();
      await carte.locator('.targets').waitFor();
    }
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
    });

    test('« Demander une correction » sur la ligne d’un dossier ne relance que lui', async () => {
      const { lt, dirs } = await sessionDeux('Ajoute un en-tête');
      await ouvrirListe();
      const carte = page.locator(`#localList .card[data-local="${lt.id}"]`);
      await deplier(carte);
      assert.equal(await carte.locator('[data-ldfollow]').count(), 2, 'un bouton par dossier traité');

      await carte.locator(`[data-ldfollow="${dirs[0].id}"]`).click();
      const form = carte.locator(`.followup[data-lfollowform="d${dirs[0].id}"]`);
      await form.waitFor();
      await form.locator('.followup-text').fill('Mets l’année dans l’en-tête');
      await form.locator(`[data-lfollowdir="${dirs[0].id}"]`).click();

      // Le job peut ne pas encore exister au clic : on attend que le serveur tienne la passe.
      for (let i = 0; i < 300 && passes(lt.id, dirs[0].id).length < 2; i += 1) {
        await new Promise((r) => { setTimeout(r, 100); });
      }
      await waitForJobs(app.api);
      assert.deepEqual(passes(lt.id, dirs[0].id).map((p) => p.kind), ['run', 'followup']);
      assert.match(passes(lt.id, dirs[0].id)[1].prompt, /l’année/);
      assert.deepEqual(passes(lt.id, dirs[1].id).map((p) => p.kind), ['run'], 'l’autre dossier n’a pas bougé');
    });

    test('« Voir le diff » sur la ligne d’un dossier ouvre la vue de diff de ce dossier', async () => {
      const { lt, dirs } = await sessionDeux('Ajoute un pied de page');
      await ouvrirListe();
      const carte = page.locator(`#localList .card[data-local="${lt.id}"]`);
      await deplier(carte);
      assert.equal(await carte.locator('[data-lddiff]').count(), 2);
      await carte.locator(`[data-lddiff="${dirs[1].id}"]`).click();
      await page.waitForSelector('#splitView:not([hidden])');
      assert.equal(await page.locator('#splitTitle').innerText(), dirs[1].path, 'pas de « — » sans branche');
      await page.locator('#splitView').getByText('PROJ_LOCAL_DRYRUN.md').first().waitFor();
      await page.locator('#splitClose').click();
    });

    test('un seul dossier : pas de bouton par dossier, le suivi de la carte suffit', async () => {
      const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'Seul', dirs: [mkdir()] });
      await app.api('POST', `/api/local-tasks/${lt.id}/run`);
      await waitForJobs(app.api);
      await ouvrirListe();
      const carte = page.locator(`#localList .card[data-local="${lt.id}"]`);
      await carte.locator('[data-lfollow]').waitFor();
      assert.equal(await carte.locator('[data-ldfollow]').count(), 0);
    });

    test('depuis « Retour de l’IA » ouvert sur un dossier, le suivi ne part que dans ce dossier', async () => {
      const { lt, dirs } = await sessionDeux('Documente les fonctions');
      await ouvrirListe();
      const carte = page.locator(`#localList .card[data-local="${lt.id}"]`);
      await deplier(carte);
      await carte.locator(`[data-ldout="${dirs[1].id}"]`).click();
      await page.waitForSelector('#taskMdView:not([hidden])');
      await page.locator('#taskMdFollowToggle').click();
      await page.locator('#taskMdFollowText').fill('Ajoute des exemples');
      await page.locator('#taskMdFollowSend').click();
      await page.waitForFunction(() => document.querySelector('#taskMdFollow').hidden === true);
      await waitForJobs(app.api);
      assert.deepEqual(passes(lt.id, dirs[1].id).map((p) => p.kind), ['run', 'followup']);
      assert.deepEqual(passes(lt.id, dirs[0].id).map((p) => p.kind), ['run'], 'l’autre dossier n’a pas bougé');
      await page.locator('#taskMdClose').click();
      assert.deepEqual(erreurs, []);
    });
  });
});
