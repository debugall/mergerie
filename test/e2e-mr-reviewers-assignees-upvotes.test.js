'use strict';
/* CE QUE LA FORGE SAIT DE QUI PORTE UNE MERGE REQUEST — reviewers demandés, assignés, 👍 —
 * relevé à la découverte sur les DEUX forges et posé sur la carte.
 *
 * GitLab donne les trois dans la liste des merge requests. GitHub donne reviewers et assignés
 * dans `/pulls`, mais les 👍 vivent sur l'« issue » de la pull request (`reactions.+1`) : un
 * appel de plus par dépôt, et un échec de cet appel ne doit pas empêcher la découverte.
 *
 * Ce que le test prouve : l'API porte les trois champs après la découverte, une redécouverte
 * les met à jour (un 👍 de plus, un reviewer retiré), et la carte « à traiter » les affiche —
 * rien quand personne n'est désigné et que le compte est à zéro.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Reviewers, assignés et 👍 relevés sur la forge', () => {
  let app; let gl; let gh;
  const GL = 'grp/app';
  const GH = 'acme/web';
  const ids = {}; // 'gl:1' | 'gh:42' → id interne

  before(async () => {
    app = await startApp();
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/PROJ-42-ajout' });
    gh = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gh-')), { branch: 'feature/PROJ-43-web' });

    const mrGl = (iid, extra) => ({
      iid, title: `MR ${iid}`, state: 'opened', source_branch: gl.branch, target_branch: 'main',
      web_url: `https://gitlab.test/${GL}/-/merge_requests/${iid}`, sha: gl.branchSha,
      created_at: `2026-01-0${iid}T10:00:00.000Z`, author: { name: 'Alice', username: 'alice' },
      diff_refs: { base_sha: gl.mainSha, start_sha: gl.mainSha, head_sha: gl.branchSha },
      ...extra,
    });
    app.state.mrs[GL] = [
      // !1 : deux reviewers, un assigné, trois pouces.
      mrGl(1, {
        reviewers: [{ username: 'bob', name: 'Bob' }, { username: 'carole', name: 'Carole' }],
        assignees: [{ username: 'alice', name: 'Alice' }],
        upvotes: 3, downvotes: 1,
      }),
      // !2 : personne, rien — la carte ne doit porter aucune de ces pastilles.
      mrGl(2, { reviewers: [], assignees: [], upvotes: 0 }),
      // !3 : la forge ne renvoie pas les champs du tout (vieille version) : zéro, pas une erreur.
      mrGl(3, {}),
    ];

    app.ghState.repos = [{ id: 1, full_name: GH, clone_url: gh.url, ssh_url: gh.url, default_branch: 'main' }];
    app.ghState.branches[GH] = [
      { name: 'main', protected: true, commit: { sha: gh.mainSha, commit: { committer: { date: '2026-01-01T00:00:00Z' }, author: { name: 'Testeur' } } } },
      { name: gh.branch, protected: false, commit: { sha: gh.branchSha, commit: { committer: { date: '2026-02-01T00:00:00Z' }, author: { name: 'Testeur' } } } },
    ];
    app.ghState.pulls[GH] = [{
      number: 42, title: 'Web : ajout', state: 'open', merged: false, merged_at: null,
      head: { ref: gh.branch, sha: gh.branchSha, repo: { full_name: GH } },
      base: { ref: 'main', sha: gh.mainSha, repo: { full_name: GH } },
      html_url: `https://github.test/${GH}/pull/42`, created_at: '2026-02-01T00:00:00Z',
      user: { login: 'alice' },
      requested_reviewers: [{ login: 'dan' }],
      assignees: [{ login: 'alice' }, { login: 'erin' }],
    }];
    app.ghState.reactions[`${GH}#42`] = { '+1': 2 };

    await app.configure();
    await app.configureGithub();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    await app.api('POST', '/api/repos', { url: gh.url, project: GH, forge: 'github' });
  });

  after(async () => { if (app) await app.stop(); });

  const trouver = async (projet, iid) => (await app.api('GET', '/api/mrs')).body.find((m) => m.project === projet && m.iid === iid);

  test('la découverte relève reviewers, assignés et 👍 sur GitLab', async () => {
    const r = await app.api('POST', '/api/discover');
    assert.equal(r.status, 200);
    const m1 = await trouver(GL, 1);
    assert.ok(m1, 'la MR !1 est découverte');
    ids['gl:1'] = m1.id;
    assert.equal(m1.reviewers, 'bob,carole');
    assert.equal(m1.assignees, 'alice');
    assert.equal(m1.upvotes, 3, 'les 👍, pas les 👎');

    const m2 = await trouver(GL, 2);
    ids['gl:2'] = m2.id;
    assert.equal(m2.reviewers, '');
    assert.equal(m2.assignees, '');
    assert.equal(m2.upvotes, 0);

    const m3 = await trouver(GL, 3);
    assert.equal(m3.assignees, '', 'champ absent de la forge : vide');
    assert.equal(m3.upvotes, 0, 'champ absent de la forge : zéro');
  });

  test('sur GitHub, les 👍 viennent de la liste des issues et les assignés de la pull request', async () => {
    const pr = await trouver(GH, 42);
    assert.ok(pr, 'la PR #42 est découverte');
    ids['gh:42'] = pr.id;
    assert.equal(pr.reviewers, 'dan');
    assert.equal(pr.assignees, 'alice,erin');
    assert.equal(pr.upvotes, 2);
    assert.ok(app.ghState.calls.some((c) => c.method === 'GET' && /\/repos\/acme\/web\/issues\?/.test(c.path)),
      'un appel à la liste des issues, pour les réactions');
  });

  test('une redécouverte met les trois à jour, et un échec des réactions GitHub laisse zéro sans bloquer', async () => {
    app.state.mrs[GL][0].reviewers = [{ username: 'carole', name: 'Carole' }];
    app.state.mrs[GL][0].assignees = [];
    app.state.mrs[GL][0].upvotes = 4;
    app.ghState.fail['/issues'] = { status: 500, body: { message: 'boom' } };
    try {
      const r = await app.api('POST', '/api/discover');
      assert.equal(r.status, 200);
      assert.equal(r.body.errors.length, 0, 'les réactions en panne ne sont pas une erreur de découverte');
    } finally {
      delete app.ghState.fail['/issues'];
    }
    const m1 = await trouver(GL, 1);
    assert.equal(m1.reviewers, 'carole');
    assert.equal(m1.assignees, '');
    assert.equal(m1.upvotes, 4);
    const pr = await trouver(GH, 42);
    assert.equal(pr.assignees, 'alice,erin', 'la pull request elle-même a bien été relue');
    assert.equal(pr.upvotes, 0, 'sans réponse de /issues, le compte retombe à zéro plutôt que de mentir');
  });

  describe('la carte « à traiter »', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];

    before(async () => {
      // Remet les 👍 GitHub pour la lecture à l'écran.
      await app.api('POST', '/api/discover');
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
      await page.locator(`#toReviewList .card[data-id="${ids['gl:1']}"]`).waitFor({ state: 'visible' });
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('porte les reviewers, les assignés et les 👍 de la forge, chacun dans sa pastille', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids['gl:1']}"]`);
      const gens = carte.locator('.tag.people');
      await gens.first().waitFor({ state: 'visible' });
      assert.equal(await gens.count(), 1, 'un seul reviewer et aucun assigné après la redécouverte');
      assert.match(await gens.first().innerText(), /carole/);
      assert.match(await gens.first().getAttribute('title'), /carole/);
      const pouces = carte.locator('.tag.upvotes');
      assert.match(await pouces.innerText(), /4/);

      const pr = page.locator(`#toReviewList .card[data-id="${ids['gh:42']}"]`);
      await pr.locator('.tag.people').first().waitFor({ state: 'visible' });
      const textes = await pr.locator('.tag.people').allInnerTexts();
      assert.equal(textes.length, 2, 'reviewer demandé ET assignés : deux pastilles');
      assert.match(textes[0], /dan/);
      assert.match(textes[1], /alice, erin/);
      assert.match(await pr.locator('.tag.upvotes').innerText(), /2/);
    });

    test('ne porte rien quand personne n’est désigné et que le compte est à zéro', async () => {
      const carte = page.locator(`#toReviewList .card[data-id="${ids['gl:2']}"]`);
      await carte.waitFor({ state: 'visible' });
      assert.equal(await carte.locator('.tag.people').count(), 0);
      assert.equal(await carte.locator('.tag.upvotes').count(), 0);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
