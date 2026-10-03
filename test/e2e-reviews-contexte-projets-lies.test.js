'use strict';
/* « CONTEXTE » d'une merge request : les PROJETS LIÉS qu'on ajoute et qu'on enregistre doivent être là quand on rouvre la modale.
 *
 * Régression : le gabarit d'une ligne de projet lié avait été renommé `link-grid-row` (un renommage de l'écran Liens, qui a une
 * classe de ce nom) alors que le code lisait `.link-row`. Les lignes s'affichaient, mais la lecture du formulaire n'en trouvait AUCUNE :
 * « Enregistrer » envoyait une liste vide, et la réouverture ne montrait rien. Le test fait le geste en entier, dans un vrai navigateur,
 * et relit ce que le SERVEUR a gardé. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Contexte d’une MR — projets liés', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let mrId; let libId; let appId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const depots = {
      app: makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-app-')), { branch: 'feature/PROJ-1-ajout' }),
      lib: makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-lib-')), { branch: 'feature/PROJ-1-client' }),
    };
    const d = depots.app;
    app.state.mrs['grp/app'] = [{
      iid: 1, title: 'Ajout', state: 'opened', source_branch: d.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/1', sha: d.branchSha, created_at: '2026-01-01T10:00:00.000Z',
      author: { name: 'Alice' }, reviewers: [], diff_refs: { base_sha: d.mainSha, start_sha: d.mainSha, head_sha: d.branchSha },
    }];
    app.state.changes['grp/app!1'] = [{ new_path: 'src/app.js', diff: '@@ -1 +1 @@\n-a\n+b\n' }];
    await app.configure();
    appId = (await app.api('POST', '/api/repos', { url: depots.app.url, project: 'grp/app' })).body.id;
    libId = (await app.api('POST', '/api/repos', { url: depots.lib.url, project: 'grp/lib' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    // La file est vide tant qu'on n'a pas cherché : c'est le geste de l'écran, comme pour la personne.
    await page.locator('#btnDiscover').click();
    await page.waitForFunction(() => /1 MR/.test(document.querySelector('#discoverInfo').textContent), null, { timeout: 60000 });
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 1).id;
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  const liensServeur = async () => (await app.api('GET', `/api/mrs/${mrId}`)).body.links || [];
  const ouvrirContexte = async () => {
    const bouton = page.locator(`#toReviewList .card[data-id="${mrId}"] [data-ticket]`);
    await bouton.waitFor({ timeout: ATTENTE });
    await bouton.click();
    await page.waitForSelector('#ticketModal:not([hidden])', { timeout: ATTENTE });
  };

  test('on ajoute un projet lié et on enregistre : le serveur le garde, et la modale le montre à la réouverture', async () => {
    await ouvrirContexte();
    assert.equal(await page.locator('#linkRows .link-row').count(), 0, 'aucun projet lié au départ');
    await page.click('#linkAdd');
    const ligne = page.locator('#linkRows .link-row').first();
    await ligne.waitFor();
    // Le dépôt se choisit dans le combo avec recherche, comme partout.
    await ligne.locator('.rc-search').click();
    await ligne.locator(`.combo-opt[data-r="${libId}"]`).waitFor({ timeout: ATTENTE });
    await ligne.locator(`.combo-opt[data-r="${libId}"]`).dispatchEvent('mousedown');
    await page.waitForFunction((id) => document.querySelector('#linkRows .link-row .link-repo').value === String(id), libId);
    await page.fill('#linkRows .link-row .link-branch', 'feature/PROJ-1-client');
    await page.click('#ticketSave');
    await page.waitForSelector('#ticketModal', { state: 'hidden', timeout: ATTENTE });

    // Ce que le SERVEUR a gardé — pas ce que l'écran affiche.
    await attendreServeur(async () => (await liensServeur()).length === 1, 'le lien est enregistré');
    assert.deepEqual((await liensServeur()).map((l) => [l.repo_id, l.branch]), [[libId, 'feature/PROJ-1-client']]);

    // Et la réouverture le montre.
    await ouvrirContexte();
    await page.waitForFunction(() => document.querySelectorAll('#linkRows .link-row').length === 1, null, { timeout: ATTENTE });
    assert.equal(await page.locator('#linkRows .link-row .link-repo').inputValue(), String(libId));
    assert.equal(await page.locator('#linkRows .link-row .link-branch').inputValue(), 'feature/PROJ-1-client');
  });

  test('on peut aussi retirer une ligne, et l’enregistrement retire le lien côté serveur', async () => {
    await page.click('#linkRows [data-rmlink]');
    assert.equal(await page.locator('#linkRows .link-row').count(), 0, 'la ligne disparaît');
    await page.click('#ticketSave');
    await page.waitForSelector('#ticketModal', { state: 'hidden', timeout: ATTENTE });
    await attendreServeur(async () => (await liensServeur()).length === 0, 'le lien est retiré');
    assert.ok(appId);
  });

  test('aucune erreur JavaScript', () => { assert.deepEqual(erreurs, []); });
});
