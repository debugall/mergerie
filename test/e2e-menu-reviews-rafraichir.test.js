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
const { execFileSync } = require('node:child_process');
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
    app.state.mrs['grp/app'] = [31, 32, 33, 34].map((iid) => ({
      iid, title: `Travail ${iid}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
      sha: repo.branchSha, created_at: `2026-04-0${iid - 30}T10:00:00.000Z`, author: { name: 'Alice', username: 'alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (const iid of [31, 32, 33, 34]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
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

  /* LA FORGE A MERGÉ : la branche est dans `main`, supprimée du remote, et la forge garde la tête
     sous `refs/merge-requests/<iid>/head` avec les SHA du détail (`diff_refs`, `merge_commit_sha`). */
  const git = (...a) => execFileSync('git', a, { cwd: repo.work, stdio: 'pipe' }).toString().trim();
  function mergerSurLaForge(iid) {
    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '-q', '-m', `Merge !${iid}`, repo.branch);
    git('push', '-q', 'origin', 'main');
    const mergeSha = git('rev-parse', 'HEAD');
    execFileSync('git', ['update-ref', `refs/merge-requests/${iid}/head`, repo.branchSha], { cwd: repo.bare, stdio: 'pipe' });
    git('push', '-q', 'origin', '--delete', repo.branch);
    Object.assign(mrs().find((m) => m.iid === iid), {
      state: 'merged', merged_at: '2026-04-10T09:00:00.000Z', merge_commit_sha: mergeSha, sha: repo.branchSha,
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    });
  }
  const diffDe = async (iid) => String((await app.api('GET', `/api/mrs/${id[iid]}/diff`)).body.diff || '');

  test('mergée sur la forge depuis la dernière découverte : la carte porte « mergée », et « Ouvrir le code » a son diff', async () => {
    // Le clone existe déjà (« Voir le diff » l'a créé) : c'est le cas où le bouton peut le réchauffer.
    const vue = (await app.api('GET', `/api/mrs/${id[32]}/diffview`)).body;
    assert.match(String(vue.diff || ''), /const b = 2/, 'le diff d’une MR ouverte, par le clone');
    mergerSurLaForge(33);
    const toast = await mettreAJour(33);
    assert.match(toast, /Mergée|Merged/, `vu : ${toast}`);
    await attendreServeur(async () => (await enBase(33)).closed_seen === 1, 'closed_seen posé en base');
    const m = await enBase(33);
    assert.equal(m.merged_at, '2026-04-10T09:00:00.000Z', 'la date de merge est celle de la forge');
    assert.equal(m.head_sha, repo.branchSha, 'la tête relue est écrite');
    assert.equal(m.base_sha, repo.mainSha, 'le merge-base d’alors est écrit');
    /* LE DIFF N'EST PLUS VIDE. Sans les SHA, une MR mergée dont la branche a disparu n'avait rien
       à montrer dans « Ouvrir le code » : trois points vides par construction, branche absente. */
    assert.match(await diffDe(33), /const b = 2/, 'le diff relu par base_sha..head_sha');
    const arbre = (await app.api('GET', `/api/mrs/${id[33]}/tree`)).body;
    assert.ok(arbre.files.some((f) => f.path === 'src/app.js' && f.changed), `src/app.js marqué changé — vu : ${JSON.stringify(arbre.files)}`);
    assert.ok(arbre.files.some((f) => f.path === 'db/migration.sql' && f.changed), 'le fichier ajouté par la branche est dans l’arbre');
    /* La découverte laisse une MR mergée dans « à traiter » avec son badge, et sans « Merger »
       dans son menu : le rafraîchissement d'une seule MR fait exactement pareil. */
    await page.locator(`#toReviewList .card[data-id="${id[33]}"] .tag.merged`).waitFor({ state: 'visible' });
    assert.equal(await page.locator(`#toReviewList [data-merge="${id[33]}"]`).count(), 0, 'plus rien à merger');
    // Les deux autres n'ont pas bougé : rien n'a été balayé.
    assert.equal(await page.locator(`#toReviewList .card[data-id="${id[31]}"] .tag.merged`).count(), 0);
    assert.equal(await page.locator(`#toReviewList .card[data-id="${id[32]}"] .tag.merged`).count(), 0);
  });

  test('la découverte, elle aussi, écrit les SHA d’une MR qui vient d’être mergée : son diff se relit', async () => {
    // !34 disparaît de la liste des ouvertes (même branche, déjà mergée) : la découverte la voit partir.
    Object.assign(mrs().find((m) => m.iid === 34), {
      state: 'merged', merged_at: '2026-04-11T09:00:00.000Z', sha: repo.branchSha,
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    });
    execFileSync('git', ['update-ref', 'refs/merge-requests/34/head', repo.branchSha], { cwd: repo.bare, stdio: 'pipe' });
    await app.api('POST', '/api/discover');
    const m = await enBase(34);
    assert.equal(m.closed_seen, 1);
    assert.equal(m.head_sha, repo.branchSha);
    assert.equal(m.base_sha, repo.mainSha);
    assert.match(await diffDe(34), /const b = 2/);
  });

  test('aucune erreur JavaScript pendant ces gestes', () => {
    assert.deepEqual(erreurs, []);
  });
});
