'use strict';
/* « METTRE À JOUR DEPUIS LA FORGE » — le menu ⋯ d'une merge request relit CETTE merge request
 * seule, sans tour de découverte sur tous les dépôts.
 *
 * Trois réponses possibles de la forge, et ce qu'elles font à la carte : un titre et un SHA qui
 * ont bougé (la carte se redessine, le SHA en base est le nouveau), rien de neuf (la carte reste,
 * le message le dit), et une merge request mergée depuis (la
 * carte prend le badge « mergée », la base porte `closed_seen` et la date de merge — ce que la
 * découverte aurait fait au tour suivant). L'effet est relu côté serveur à chaque fois.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Reviews — mettre à jour une merge request depuis la forge', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo;
  const id = {};
  const erreurs = [];
  const mrs = () => app.state.mrs['grp/app'];
  const enBase = async (iid) => (await app.api('GET', `/api/mrs/${id[iid]}`)).body.mr;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [31, 32, 33].map((iid) => ({
      iid, title: `Travail ${iid}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
      sha: repo.branchSha, created_at: `2026-04-0${iid - 30}T10:00:00.000Z`, author: { name: 'Alice', username: 'alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (const iid of [31, 32, 33]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator('[data-seg="to_review"]').click();
    await page.waitForSelector(`#toReviewList .card[data-id="${id[31]}"]`);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Ouvre le menu ⋯ de la carte et clique l'entrée. Le toast est le seul signe que l'appel a
     répondu : on l'attend, puis on relit la base — le message ne prouve rien par lui-même. */
  async function mettreAJour(iid) {
    const carte = page.locator(`#toReviewList .card[data-id="${id[iid]}"]`);
    await carte.locator('[data-more]').click();
    const entree = page.locator(`#toReviewList [data-refresh="${id[iid]}"]`);
    await entree.waitFor({ state: 'visible' });
    // Les toasts précédents sont peut-être encore affichés : on attend celui de CE geste.
    const deja = await page.evaluate(() => document.querySelectorAll('.toast').length);
    await entree.click();
    await page.waitForFunction((n) => document.querySelectorAll('.toast').length > n, deja);
    return page.evaluate(() => [...document.querySelectorAll('.toast')].at(-1).textContent);
  }

  test('le menu ⋯ de la carte porte l’entrée, et elle relit la merge request à la forge', async () => {
    const avant = await enBase(31);
    assert.equal(avant.title, 'Travail 31');
    assert.equal(avant.current_sha, repo.branchSha);
    // La forge a bougé : nouveau titre, nouveau commit, une cible différente.
    Object.assign(mrs().find((m) => m.iid === 31), { title: 'Travail 31 — renommé', sha: 'sha-nouveau-31', target_branch: 'release' });
    const toast = await mettreAJour(31);
    assert.match(toast, /nouveaux commits|périmé/i, `le message dit que le SHA a bougé — vu : ${toast}`);
    await attendreServeur(async () => (await enBase(31)).current_sha === 'sha-nouveau-31', 'le SHA relu en base');
    const apres = await enBase(31);
    assert.equal(apres.title, 'Travail 31 — renommé');
    assert.equal(apres.target_branch, 'release');
    assert.equal(apres.closed_seen, 0, 'toujours ouverte');
    // La carte suit, sans recharger la page.
    await page.waitForFunction((cid) => {
      const c = document.querySelector(`#toReviewList .card[data-id="${cid}"]`);
      return c && /Travail 31 — renommé/.test(c.textContent);
    }, id[31]);
    // Les autres cartes n'ont pas été touchées : un seul appel, pour une seule merge request.
    assert.equal((await enBase(32)).title, 'Travail 32');
  });

  test('rien n’a changé sur la forge : la carte reste et le message le dit', async () => {
    const toast = await mettreAJour(32);
    assert.match(toast, /Rien de nouveau|Nothing new/, `vu : ${toast}`);
    assert.ok(await page.locator(`#toReviewList .card[data-id="${id[32]}"]`).isVisible());
    assert.equal((await enBase(32)).closed_seen, 0);
  });

  test('mergée sur la forge depuis la dernière découverte : la carte porte « mergée », comme après une découverte', async () => {
    Object.assign(mrs().find((m) => m.iid === 33), { state: 'merged', merged_at: '2026-04-10T09:00:00.000Z' });
    const toast = await mettreAJour(33);
    assert.match(toast, /Mergée|Merged/, `vu : ${toast}`);
    await attendreServeur(async () => (await enBase(33)).closed_seen === 1, 'closed_seen posé en base');
    const m = await enBase(33);
    assert.equal(m.merged_at, '2026-04-10T09:00:00.000Z', 'la date de merge est celle de la forge');
    /* La découverte laisse une MR mergée dans « à traiter » avec son badge, et sans « Merger »
       dans son menu : le rafraîchissement d'une seule MR fait exactement pareil. */
    await page.locator(`#toReviewList .card[data-id="${id[33]}"] .tag.merged`).waitFor({ state: 'visible' });
    assert.equal(await page.locator(`#toReviewList [data-merge="${id[33]}"]`).count(), 0, 'plus rien à merger');
    // Les deux autres n'ont pas bougé : rien n'a été balayé.
    assert.equal(await page.locator(`#toReviewList .card[data-id="${id[31]}"] .tag.merged`).count(), 0);
    assert.equal(await page.locator(`#toReviewList .card[data-id="${id[32]}"] .tag.merged`).count(), 0);
  });

  test('aucune erreur JavaScript pendant ces gestes', () => {
    assert.deepEqual(erreurs, []);
  });
});
