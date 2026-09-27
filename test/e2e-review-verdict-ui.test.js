'use strict';
/* LE VERDICT QUE LA FORGE LIT, DEPUIS L'ÉCRAN.
 *
 * Le rapport se publiait déjà en commentaire ; l'écran gagne trois choses, éprouvées ici au
 * navigateur (l'API l'est dans e2e-review-publish et e2e-github) :
 *   - « Approuver » dans les actions du rapport : une confirmation qui dit la note face au seuil
 *     et le verdict de vérification, puis le bouton passe à « Approuvé ✓ » — l'état relu, pas
 *     réécrit à la main —, et « retirer » le rend ;
 *   - « Résoudre » sur un fil de discussion, qui pose le badge « résolu » et devient « Rouvrir » ;
 *   - le badge CI de la forge sur la carte, avec le lien vers le pipeline.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Reviews — approuver, résoudre un fil, la CI de la forge', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo; let mrId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 31, title: 'Ajoute la colonne c', state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/31', sha: repo.branchSha,
      created_at: '2026-03-01T10:00:00.000Z', author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!31'] = [{ new_path: 'src/app.js' }];
    app.state.discussions['grp/app!31'] = [{
      id: 'disc-general', notes: [{ id: 650, body: 'Déjà relu par l’équipe produit.', system: false, resolved: false,
        author: { name: 'Claire', username: 'claire' }, position: null }],
    }];
    app.state.pipelines['grp/app!31'] = [{ id: 77, status: 'success', web_url: 'https://gitlab.test/grp/app/-/pipelines/77' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 31).id;
    await app.api('POST', `/api/mrs/${mrId}/review`, { explain: false });
    await waitForJobs(app.api);
    await attendreServeur(async () => { const { body } = await app.api('GET', '/api/status'); return body && !body.running && !body.queued; }, 'file vide', 60000);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator('[data-seg="reviewed"]').click();
    await page.waitForSelector(`#reportList .card[data-id="${mrId}"]`);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('la carte porte le badge CI de la forge, avec le lien du pipeline', async () => {
    /* Le badge arrive APRÈS la carte (un appel groupé) : on attend l'effet, jamais un délai. */
    await page.waitForSelector(`#reportList .card[data-id="${mrId}"] [data-ci-forge]`);
    const badge = page.locator(`#reportList .card[data-id="${mrId}"] [data-ci-forge]`);
    assert.match(await badge.textContent(), /CI\s*✓/);
    assert.equal(await badge.locator('..').getAttribute('href'), 'https://gitlab.test/grp/app/-/pipelines/77');
  });

  test('« Approuver » demande, dit la note et le verdict, puis passe à « Approuvé ✓ » — et se retire', async () => {
    await page.locator(`#reportList .card[data-id="${mrId}"]`).click();
    await page.waitForSelector('#aApprove', { state: 'attached' });
    /* Dans le menu « ⋯ », au-dessus de « Publier » : la barre garde ses trois actions. */
    await page.locator('#aMore').click();
    await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
    await page.locator('#aApprove').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    const detail = await page.locator('#confirmModal').textContent();
    assert.match(detail, /note|score/i, 'la confirmation dit où en est la note');
    assert.match(detail, /vérification|verification/i, 'et le verdict de vérification');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => document.querySelector('#aApprove') && document.querySelector('#aApprove').dataset.mine === '1');
    assert.match(await page.locator('#aApprove').textContent(), /Approuvé|Approved/);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/approvals`)).body.byMe, true, 'lu depuis la forge');
    await page.locator('#aMore').click();
    await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
    await page.locator('#aApprove').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => document.querySelector('#aApprove') && document.querySelector('#aApprove').dataset.mine === '0');
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/approvals`)).body.byMe, false);
  });

  test('« Résoudre » sur un fil pose le badge « résolu » et devient « Rouvrir »', async () => {
    await page.waitForSelector('#mrComments .cmt-thread[data-disc="disc-general"] .cmt-resolve-btn');
    const btn = page.locator('#mrComments .cmt-thread[data-disc="disc-general"] .cmt-resolve-btn');
    await btn.click();
    await page.waitForFunction(() => {
      const b = document.querySelector('#mrComments .cmt-thread[data-disc="disc-general"] .cmt-resolve-btn');
      return b && b.dataset.resolved === '1';
    });
    assert.equal(await page.locator('#mrComments .cmt-thread[data-disc="disc-general"] .tag.done').count(), 1);
    assert.match(await btn.textContent(), /Rouvrir|Reopen/);
    assert.equal(app.state.discussions['grp/app!31'][0].notes[0].resolved, true, 'la forge a bien reçu le geste');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
