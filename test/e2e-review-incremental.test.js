'use strict';
/* Re-review INCRÉMENTALE : ne diffuser que le DELTA depuis le dernier SHA reviewé
   (`git diff reviewed_sha..current_sha`) au lieu du diff complet `target...source`,
   avec repli automatique quand il n'y a pas de delta exploitable.

   La sortie de l'agent est un mock (dry-run), donc on ne teste pas la QUALITÉ du
   rapport mais le PLUMBING, de façon déterministe : le diff RÉELLEMENT stocké
   (endpoint /diff) prouve quel périmètre a été diffusé à l'IA. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, pushChange, waitForJobs } = require('./helpers/app');

describe('Re-review incrémentale (delta)', () => {
  let app; let repo; let mrId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));

    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajout [PROJ-100]', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }, { new_path: 'db/migration.sql' }];

    await app.configure({ review_explain: '0' }); // review seule : pas de 2e appel IA, tests plus rapides
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;

    // 1re review COMPLÈTE : reviewed_sha = SHA1 (branchSha), 2 fichiers dans le diff.
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await waitForJobs(app.api);
  });

  after(async () => { await app.stop(); });

  test('review initiale complète à SHA1 (le diff couvre toute la MR)', async () => {
    const detail = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(detail.mr.status, 'reviewed');
    assert.equal(detail.mr.reviewed_sha, repo.branchSha);

    const diff = (await app.api('GET', `/api/mrs/${mrId}/diff`)).body.diff;
    assert.match(diff, /src\/app\.js/);
    assert.match(diff, /db\/migration\.sql/);
  });

  test('rereview INCRÉMENTALE : ne diffuse QUE le delta depuis reviewed_sha', async () => {
    // On ajoute UNIQUEMENT un nouveau fichier : le delta reviewed_sha..current s'y limite.
    const sha2 = pushChange(repo, 'src/delta.js', 'export const d = 42;\n', 'feat: delta');
    app.state.mrs['grp/app'][0].sha = sha2;
    await app.api('POST', '/api/discover');
    assert.equal((await app.api('GET', '/api/mrs')).body[0].stale, true, 'branche bougée → rapport périmé');

    const job = await app.api('POST', `/api/mrs/${mrId}/rereview`, { incremental: true });
    assert.equal(job.body.kind, 'rereview');
    await waitForJobs(app.api);

    /* CE QUE L'IA A REÇU, c'est le delta — le journal du job le dit : `git diff sha1..sha2`,
       pas `target...source`. CE QUE L'EXPLORATEUR VOIT, c'est toute la merge request : le diff
       rangé à côté du rapport couvre les fichiers déjà reviewés comme le nouveau. Ranger le delta
       faisait disparaître de « Ouvrir le code » tout ce que les commits précédents touchaient. */
    const journal = JSON.stringify((await app.api('GET', `/api/jobs/${job.body.id}/log`)).body);
    assert.match(journal, new RegExp(`git diff ${repo.branchSha.slice(0, 8)}\\.\\.${sha2.slice(0, 8)}`), 'l’IA ne relit que le delta');
    const diff = (await app.api('GET', `/api/mrs/${mrId}/diff`)).body.diff;
    assert.match(diff, /src\/delta\.js/, 'le diff rangé contient le nouveau fichier');
    assert.match(diff, /src\/app\.js/, '…et les fichiers déjà reviewés : l’explorateur voit toute la MR');
    assert.match(diff, /db\/migration\.sql/);
    const vue = (await app.api('GET', `/api/mrs/${mrId}/diffview`)).body;
    assert.ok(vue.files.some((f) => f.path === 'src/app.js' && f.changed), 'l’arbre marque aussi les fichiers des commits précédents');

    const detail = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(detail.mr.reviewed_sha, sha2, 'reviewed_sha avance jusqu’au SHA courant après la re-review');

    const versions = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    const latest = versions[0];
    assert.equal(latest.version, 2);
    assert.equal(latest.kind, 'review', 'l’incrémentale reste un rapport de review (pas un modify)');
    assert.equal(latest.sha, sha2.slice(0, 8));

    const liste = (await app.api('GET', '/api/mrs')).body[0];
    assert.ok(liste.note && liste.note.value > 0, 'une note globale est extraite du rapport incrémental');
  });

  test('rereview COMPLÈTE : diffuse tout le diff target...source', async () => {
    const sha3 = pushChange(repo, 'src/full.js', 'export const f = 1;\n', 'feat: full');
    app.state.mrs['grp/app'][0].sha = sha3;
    await app.api('POST', '/api/discover');

    // Sans option incremental → review complète.
    await app.api('POST', `/api/mrs/${mrId}/rereview`);
    await waitForJobs(app.api);

    const diff = (await app.api('GET', `/api/mrs/${mrId}/diff`)).body.diff;
    assert.match(diff, /src\/app\.js/, 'la review complète voit TOUS les fichiers de la MR');
    assert.match(diff, /db\/migration\.sql/);
    assert.match(diff, /src\/delta\.js/);
    assert.match(diff, /src\/full\.js/);
  });

  test('fallback : incrémental demandé mais aucun delta (reviewed_sha == current) → diff complet', async () => {
    // La review complète précédente a remis reviewed_sha = current_sha : plus de delta.
    const before2 = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(before2.mr.reviewed_sha, before2.mr.current_sha, 'préalable : aucun changement en attente');

    await app.api('POST', `/api/mrs/${mrId}/rereview`, { incremental: true });
    await waitForJobs(app.api);

    const diff = (await app.api('GET', `/api/mrs/${mrId}/diff`)).body.diff;
    assert.match(diff, /src\/app\.js/, 'repli sur le diff complet, pas un delta vide');
    assert.match(diff, /src\/full\.js/);
  });
});
