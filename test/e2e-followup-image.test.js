'use strict';
/* COLLER UNE CAPTURE DANS UNE DEMANDE DE SUIVI.
 *
 * « Le bouton déborde, voir la capture » : une image vaut dix lignes de description, et c'est
 * au moment du suivi qu'on l'a sous la main. Le formulaire de création savait déjà recevoir des
 * captures ; celui du suivi, non.
 *
 * Ce qui se joue ici n'est pas l'upload — c'est CE QUI ARRIVE DANS LE PROMPT :
 *
 *   1. la capture du suivi accompagne la demande, avec celles de la consigne initiale ;
 *   2. celle d'un suivi PASSÉ ne repart pas : elle illustrait une autre demande, et un prompt
 *      qui annonce « voici les captures » en montrant autre chose induit l'agent en erreur ;
 *   3. chaque saveur a sa propre route et sa propre table : la prouver sur une seule et
 *      supposer les autres est exactement ce qui laisse passer une image perdue en silence.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

// 4×4 px : le contenu n'a pas d'importance, le chemin qu'elle suit, si.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

describe('Captures jointes à une demande de suivi', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    await app.configure();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  // Captures ET documents vivent dans la même table depuis qu'une session accepte les deux.
  const captures = (taskId) => app.db
    .prepare("SELECT id, path, name, followup FROM piece_jointe WHERE scope = 'task' AND owner_id = ? ORDER BY id").all(taskId);
  // Le prompt réellement envoyé à l'agent, archivé avec la passe.
  const promptDeLaPasse = async (taskId, unitId) => {
    const { body } = await app.api('GET', `/api/tasks/${taskId}/targets/${unitId}/passes`);
    return body.current.prompt || '';
  };

  test('codage : la capture du suivi part avec la demande, celle d’un suivi passé non', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un bouton', images: [PNG],
      targets: [{ repo_id: repoId, branch: 'feat/bouton', base_branch: 'main' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    assert.deepEqual(captures(t.id).map((i) => i.followup), [0], 'la capture de création n’est pas marquée « suivi »');

    // 1er suivi, avec sa capture.
    const r1 = await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Le bouton déborde', images: [PNG] });
    assert.equal(r1.status, 200);
    await waitForJobs(app.api);
    const apres1 = captures(t.id);
    assert.equal(apres1.length, 2, 'la capture du suivi est enregistrée sur la session');
    assert.equal(apres1[1].followup, 1, 'et marquée comme appartenant à un suivi');
    assert.ok(fs.existsSync(apres1[1].path), 'le fichier est bien écrit sur disque');

    const tg = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.targets[0];
    const p1 = await promptDeLaPasse(t.id, tg.id);
    assert.match(p1, /pièces jointes sont fournies/,
      `le prompt du suivi annonce les captures : ${p1.slice(-300)}`);
    assert.equal((p1.match(/^- `/gm) || []).length, 2,
      'celle de la consigne initiale ET celle du suivi');

    // 2e suivi, avec SA capture : celle du premier suivi n'a plus rien à faire là.
    await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Et le libellé est faux', images: [PNG] });
    await waitForJobs(app.api);
    assert.equal(captures(t.id).length, 3);
    const p2 = await promptDeLaPasse(t.id, tg.id);
    assert.match(p2, /libellé est faux/, 'on lit bien la passe du 2e suivi');
    assert.equal((p2.match(/^- `/gm) || []).length, 2,
      'la capture du suivi PRÉCÉDENT ne repart pas — elle illustrait une autre demande');
  });

  test('exploration : même geste, même route', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est la config ?',
      targets: [{ repo_id: repoId, branch: 'main' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);

    const r = await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Et ce écran-là ?', images: [PNG] });
    assert.equal(r.status, 200);
    await waitForJobs(app.api);

    const imgs = captures(t.id);
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].followup, 1);
    /* Une exploration archive sa QUESTION, pas le prompt complet : c'est le journal du job qui
       dit ce que l'agent a reçu. Sans cette ligne, l'image serait enregistrée en base et
       n'atteindrait jamais l'agent — l'écran dirait pourtant « envoyé ». */
    const { body: log } = await app.api('GET', '/api/jobs/current/log');
    assert.ok(log.lines.some((l) => /1 capture jointe/.test(l.text)),
      `le journal atteste la pièce jointe : ${log.lines.slice(-6).map((l) => l.text).join(' | ')}`);
  });

  /* Le hors dépôt a SA table et SA route : le prouver ailleurs ne prouve rien ici. */
  test('hors dépôt : la capture suit aussi', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports', dirs: [dossier] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);

    await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Vois la capture', images: [PNG] });
    await waitForJobs(app.api);

    const imgs = app.db.prepare("SELECT followup FROM piece_jointe WHERE scope = 'local' AND owner_id = ?").all(lt.id);
    assert.deepEqual(imgs.map((i) => i.followup), [1]);
    const dir = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task.dirs[0];
    const { body } = await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${dir.id}/passes`);
    assert.match(body.current.prompt, /pièces jointes sont fournies/);
  });

  /* Une image invalide ne doit pas partir en silence NI casser la demande à moitié : on la
     refuse avant de lancer quoi que ce soit. */
  test('une image invalide est refusée avant le lancement', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'x', targets: [{ repo_id: repoId, branch: 'feat/x', base_branch: 'main' }],
    });
    const r = await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'y', images: ['pas-une-image'] });
    assert.equal(r.status, 400);
    assert.equal(captures(t.id).length, 0, 'rien n’est enregistré à moitié');
    const { body: st } = await app.api('GET', '/api/status');
    assert.ok(!st.running && !st.queued, 'et aucun job n’a été lancé');
  });

  describe('l’écran', { skip: navigateurDispo().dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.waitForSelector('#taskList .card');
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    /* Le collage est le geste attendu : on capture, on colle, on envoie. C'est du câblage
       d'écran — l'API a beau accepter les images, un Ctrl+V qui ne mène nulle part ne sert
       à rien. */
    test('coller une capture dans le formulaire l’envoie avec le suivi', async () => {
      const { body: t } = await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'Session pour le collage',
        targets: [{ repo_id: repoId, branch: 'feat/collage', base_branch: 'main' }],
      });
      // « Demander une correction » n'apparaît qu'une fois la session passée : on la fait tourner.
      await app.api('POST', `/api/tasks/${t.id}/run`);
      await waitForJobs(app.api);
      await page.reload();
      await page.locator('nav button[data-tab="task"]').click();
      const carte = page.locator(`#taskList .card[data-task="${t.id}"]`);
      await carte.locator('[data-tfollow]').click();
      const form = page.locator(`#taskList .followup[data-followform="${t.id}"]`);
      await form.locator('.followup-text').fill('Le bouton déborde, voir la capture.');
      await form.locator('.followup-text').click();

      await page.evaluate((dataUrl) => {
        const bin = atob(dataUrl.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([arr], 'capture.png', { type: 'image/png' }));
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, PNG);
      await form.locator('.followup-prev img').first().waitFor({ state: 'visible' });
      assert.equal(await form.locator('.followup-prev img').count(), 1, 'la vignette confirme ce qui partira');

      await form.locator('[data-followsubmit]').click();
      await page.waitForSelector(`#taskList .followup[data-followform="${t.id}"][hidden]`, { state: 'attached' });
      await waitForJobs(app.api);

      const imgs = captures(t.id);
      assert.equal(imgs.length, 1, 'la capture collée est bien arrivée au serveur');
      assert.equal(imgs[0].followup, 1);
      assert.deepEqual(erreurs, []);
    });
  });
});
