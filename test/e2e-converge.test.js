'use strict';
/* « Converger » — la boucle de qualité autonome, de bout en bout sur de VRAIS dépôts
   git locaux (agent en dry-run). L'orchestrateur enchaîne review → correction IA
   (commit + push) → re-review INCRÉMENTALE du delta, avec 3 garde-fous v1 :
   seuil atteint · note qui baisse/stagne · plafond de passes. JAMAIS de merge.

   Le mock dry-run note un diff `max(2, 9 - nbFichiers)/10` : un diff complet à 2
   fichiers → 7/10, un delta incrémental à 1 fichier → 8/10. Les chemins sont donc
   déterministes, ce qui rend chaque garde-fou testable. Chaque scénario a SON dépôt/MR
   isolé (la boucle pousse des commits, donc l'état ne doit pas fuiter entre scénarios). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, git } = require('./helpers/app');

describe('Converger — boucle de convergence', () => {
  let app;
  const M = {}; // scénario -> { mrId, repo }

  // Enregistre un projet isolé (dépôt + MR à 2 fichiers → review complète 7/10).
  async function addScenario(key, project) {
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `remote-${key}-`)), { branch: `feature/${key}` });
    app.state.mrs[project] = [{
      iid: 1, title: `MR ${key}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/${project}/-/merge_requests/1`,
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes[`${project}!1`] = [{ new_path: 'src/app.js' }, { new_path: 'db/migration.sql' }];
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project })).body.id;
    await app.api('POST', '/api/discover');
    const mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.project === project).id;
    // review complète initiale → note 7/10 (2 fichiers)
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await waitForJobs(app.api);
    M[key] = { mrId, repo };
  }

  before(async () => {
    app = await startApp();
    await app.configure({ review_explain: '0', converge_threshold: '8', converge_max_passes: '3' });
    await addScenario('good', 'grp/good');   // convergé immédiat (seuil bas)
    await addScenario('loop', 'grp/loop');   // convergé après 1 correction
    await addScenario('cap', 'grp/cap');     // plafond atteint
    await addScenario('reg', 'grp/reg');     // arrêt sur régression/stagnation
  });

  after(async () => { await app.stop(); });

  test('réglages par défaut exposés et bornés', async () => {
    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(c.converge_threshold, '8');
    assert.equal(c.converge_max_passes, '3');
    // bornes : hors [1,10] est ramené dans l'intervalle
    await app.api('PUT', '/api/config', { converge_threshold: '42', converge_max_passes: '0' });
    const c2 = (await app.api('GET', '/api/config')).body;
    assert.equal(c2.converge_threshold, '10');
    assert.equal(c2.converge_max_passes, '1');
    await app.api('PUT', '/api/config', { converge_threshold: '8', converge_max_passes: '3' });
  });

  test('note déjà ≥ seuil → convergé immédiatement, aucune correction poussée', async () => {
    const { mrId, repo } = M.good;
    const headAvant = git(repo.bare, ['rev-parse', repo.branch]).trim();

    await app.api('POST', `/api/mrs/${mrId}/converge`, { threshold: 6 });
    await waitForJobs(app.api);

    const run = (await app.api('GET', `/api/mrs/${mrId}`)).body.convergence;
    assert.equal(run.status, 'converged');
    assert.equal(run.passes_done, 0, 'aucune passe de correction');
    assert.equal(run.best_note, 7);

    assert.equal(git(repo.bare, ['rev-parse', repo.branch]).trim(), headAvant, 'la branche distante n’a pas bougé');
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/versions`)).body.length, 1, 'aucune nouvelle version');
  });

  test('sous le seuil → correction IA (commit + push) puis re-review incrémentale → convergé', async () => {
    const { mrId, repo } = M.loop;
    const headAvant = git(repo.bare, ['rev-parse', repo.branch]).trim();

    // seuil 8 : 7/10 < 8 → 1 correction ; le delta incrémental (1 fichier) est noté 8/10 → convergé.
    await app.api('POST', `/api/mrs/${mrId}/converge`, { threshold: 8, maxPasses: 3 });
    await waitForJobs(app.api);

    const detail = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    const run = detail.convergence;
    assert.equal(run.status, 'converged');
    assert.equal(run.passes_done, 1, 'une seule passe a suffi');
    assert.equal(run.start_note, 7);
    assert.equal(run.best_note, 8);

    const headApres = git(repo.bare, ['rev-parse', repo.branch]).trim();
    assert.notEqual(headApres, headAvant, 'un commit de correction a été poussé sur la branche');
    assert.equal(detail.mr.reviewed_sha, headApres, 'reviewed_sha suit la tête après la re-review');

    const versions = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    assert.equal(versions.length, 2, 'la re-review incrémentale a créé une version');
    assert.equal(versions[0].kind, 'review');
    assert.equal(versions[0].note10, 8);
  });

  test('plafond de passes : s’arrête au plafond même sans atteindre le seuil', async () => {
    const { mrId } = M.cap;
    // seuil 9 (inatteignable avec le mock), plafond 1 → une passe puis arrêt « capped ».
    await app.api('POST', `/api/mrs/${mrId}/converge`, { threshold: 9, maxPasses: 1 });
    await waitForJobs(app.api);

    const run = (await app.api('GET', `/api/mrs/${mrId}`)).body.convergence;
    assert.equal(run.status, 'capped');
    assert.equal(run.passes_done, 1, 'exactement le plafond');
    assert.equal(run.max_passes, 1);
    assert.equal(run.best_note, 8, 'meilleure note atteinte conservée');
  });

  test('régression/stagnation : s’arrête dès que la note n’améliore plus', async () => {
    const { mrId } = M.reg;
    // seuil 9, plafond 3 : passe 1 améliore (7→8), passe 2 stagne (8→8) → arrêt « regressed ».
    await app.api('POST', `/api/mrs/${mrId}/converge`, { threshold: 9, maxPasses: 3 });
    await waitForJobs(app.api);

    const run = (await app.api('GET', `/api/mrs/${mrId}`)).body.convergence;
    assert.equal(run.status, 'regressed');
    assert.equal(run.passes_done, 2, 'arrêt à la passe qui stagne, avant le plafond');
    assert.equal(run.best_note, 8);
  });

  test('une MR marquée « traitée » ne peut pas être convergée', async () => {
    const { mrId } = M.good;
    await app.api('POST', `/api/mrs/${mrId}/done`);
    const res = await app.api('POST', `/api/mrs/${mrId}/converge`, { threshold: 8 });
    assert.equal(res.status, 400);
    await app.api('POST', `/api/mrs/${mrId}/reopen`);
  });
});
