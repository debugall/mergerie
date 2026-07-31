'use strict';
/* Chaîne complète de review sur de VRAIS dépôts git locaux : clone, diff ciblé,
   rapport (agent en dry-run), historisation des versions, suivi de résolution,
   explication à la demande, modification, suppression du rapport.

   C'est le cœur métier de l'application : le tester de bout en bout permet de
   refactorer reviewer.js / git.js / resolution.js sans crainte de régression. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, pushChange, waitForJobs } = require('./helpers/app');

describe('Review de bout en bout', () => {
  let app; let repo; let repoId; let mrId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));

    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajout de b [PROJ-100]', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }, { new_path: 'db/migration.sql' }];

    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
  });

  after(async () => { await app.stop(); });

  test('la découverte a rempli les chemins modifiés', async () => {
    const mr = (await app.api('GET', '/api/mrs')).body[0];
    assert.equal(mr.iid, 7);
    assert.equal(mr.stale, null, 'jamais reviewée : pas de rapport périmé');
    assert.equal(mr.has_review, false);
  });

  test('GET /api/mrs/:id/diffview calcule le diff sans dépenser d’appel IA', async () => {
    const { status, body } = await app.api('GET', `/api/mrs/${mrId}/diffview`);
    assert.equal(status, 200);
    assert.equal(body.source, repo.branch);
    assert.equal(body.target, 'main');
    assert.match(body.diff, /diff --git a\/src\/app\.js/);
    assert.equal(body.stats.files, 2, 'src/app.js et db/migration.sql');
    assert.ok(body.stats.added > 0);
    const modifies = body.files.filter((f) => f.changed).map((f) => f.path).sort();
    assert.deepEqual(modifies, ['db/migration.sql', 'src/app.js']);
  });

  test('POST /api/mrs/:id/review produit un rapport, une note et des constats', async () => {
    const job = await app.api('POST', `/api/mrs/${mrId}/review`, { explain: true });
    assert.equal(job.body.kind, 'review');
    await waitForJobs(app.api);

    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(detail.body.mr.status, 'reviewed');
    assert.equal(detail.body.mr.reviewed_sha, repo.branchSha);
    assert.match(detail.body.review.md, /Rapport de revue/);
    assert.ok(!detail.body.review.md.includes('<<<FINDINGS'), 'le bloc de constats ne pollue pas le rapport lu');
    assert.match(detail.body.review.explanation, /Explication/, 'explain:true force la 2e passe IA');

    const liste = (await app.api('GET', '/api/mrs')).body[0];
    assert.equal(liste.has_review, true);
    assert.ok(liste.note && liste.note.value > 0, 'la note globale est extraite du rapport');

    const versions = await app.api('GET', `/api/mrs/${mrId}/versions`);
    assert.equal(versions.body.length, 1);
    assert.equal(versions.body[0].version, 1);
    assert.equal(versions.body[0].kind, 'review');
    assert.equal(versions.body[0].resolution, null, 'pas de delta à la 1re passe');

    const findings = await app.api('GET', `/api/mrs/${mrId}/findings`);
    assert.equal(findings.body.version, 1);
    assert.equal(findings.body.findings.length, 2, 'un constat par fichier modifié (rapport mock)');
    assert.ok(findings.body.findings.every((f) => f.status === 'new'));

    const contenu = await app.api('GET', `/api/mrs/${mrId}/versions/1`);
    assert.match(contenu.body.md, /Rapport de revue/);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/versions/99`)).status, 400);
  });

  test('le log du job est consultable après coup, avec ses horodatages', async () => {
    const { body } = await app.api('GET', '/api/jobs/current/log');
    assert.ok(body.lines.length > 0);
    assert.ok(body.lines.some((l) => /review terminée/.test(l.text)));
    /* Le panneau de logs affiche le temps écoulé à partir de CES dates : il ne compte pas
       les secondes depuis l'ouverture de la page, sinon un onglet ouvert en cours de job
       montrerait un temps faux. Sans elles, le compteur ne peut pas exister. */
    assert.ok(body.started_at, 'started_at est exposé');
    assert.ok(body.finished_at, 'finished_at est exposé une fois le job terminé');
    assert.ok(Date.parse(body.finished_at) >= Date.parse(body.started_at), 'la fin ne précède pas le début');
  });

  test('GET /api/mrs/:id/diff, /tree, /file et /filediff exposent le code reviewé', async () => {
    const diff = await app.api('GET', `/api/mrs/${mrId}/diff`);
    assert.match(diff.body.diff, /\+const b = 2;/);

    const tree = await app.api('GET', `/api/mrs/${mrId}/tree`);
    assert.equal(tree.body.ref, repo.branchSha);
    const app_js = tree.body.files.find((f) => f.path === 'src/app.js');
    assert.equal(app_js.changed, true);
    assert.equal(tree.body.files.find((f) => f.path === 'README.md').changed, false);

    const fichier = await app.api('GET', `/api/mrs/${mrId}/file?path=src/app.js`);
    assert.match(fichier.body.content, /const b = 2;/);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/file`)).status, 400, 'chemin requis');
    const horsArbo = await app.api('GET', `/api/mrs/${mrId}/file?path=../../etc/passwd`);
    assert.equal(horsArbo.status, 400, 'un chemin hors arborescence est refusé');

    const fd = await app.api('GET', `/api/mrs/${mrId}/filediff?path=src/app.js`);
    assert.match(fd.body.diff, /const b = 2;/);
  });

  test('2e passe : suivi de résolution vérifié par git', async () => {
    // La migration disparaît du diff (fichier supprimé) et app.js continue de changer.
    const sha2 = pushChange(repo, 'src/app.js', 'const a = 1;\nconst b = 3;\nmodule.exports = { a, b };\n',
      'fix: b = 3', ['db/migration.sql']);
    app.state.mrs['grp/app'][0].sha = sha2;
    await app.api('POST', '/api/discover');

    const stale = (await app.api('GET', '/api/mrs')).body[0];
    assert.equal(stale.stale, true, 'le rapport est signalé périmé quand la branche bouge');

    await app.api('POST', `/api/mrs/${mrId}/rereview`);
    await waitForJobs(app.api);

    const versions = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    assert.equal(versions.length, 2);
    const v2 = versions.find((v) => v.version === 2);
    assert.equal(v2.sha, sha2.slice(0, 8));
    assert.ok(v2.resolution, 'le delta est calculé dès la 2e passe');
    assert.equal(v2.resolution.persistent, 1, 'src/app.js est toujours signalé');
    assert.equal(v2.resolution.resolved, 1, 'la migration a disparu ET son code a changé → résolu (vérifié)');

    const findings = (await app.api('GET', `/api/mrs/${mrId}/findings`)).body;
    assert.equal(findings.version, 2);
    const parStatut = Object.fromEntries(findings.findings.map((f) => [f.status, f.file]));
    assert.equal(parStatut.persistent, 'src/app.js');
    assert.equal(parStatut.resolved, 'db/migration.sql');

    const stats = await app.api('GET', '/api/stats');
    assert.ok(stats.body.resolution, 'le taux de résolution remonte dans les statistiques');
    assert.equal(stats.body.resolution.resolved, 1);
  });

  test('review seule puis explication générée à la demande', async () => {
    await app.api('PUT', '/api/config', { review_explain: '0' });
    await app.api('POST', `/api/mrs/${mrId}/rereview`);
    await waitForJobs(app.api);

    let detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(detail.body.review.explanation, null, 'review seule : pas de 2e appel IA');

    const job = await app.api('POST', `/api/mrs/${mrId}/explain`);
    assert.equal(job.body.kind, 'explain');
    await waitForJobs(app.api);

    detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.match(detail.body.review.explanation, /Explication/);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/versions`)).body.length, 3, 'l’explication ne crée pas de version');
    await app.api('PUT', '/api/config', { review_explain: '1' });
  });

  test('POST /api/mrs/:id/modify régénère le rapport dans une nouvelle version', async () => {
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/modify`, { instruction: ' ' })).status, 400);

    await app.api('POST', `/api/mrs/${mrId}/modify`, { instruction: 'Insiste sur la sécurité' });
    await waitForJobs(app.api);

    const versions = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    assert.equal(versions[0].version, 4);
    assert.equal(versions[0].kind, 'modify');
    // La DEMANDE est conservée avec la version qu'elle a produite : sans elle, l'historique
    // ne dit pas ce qui avait été demandé pour arriver à ce rapport.
    assert.equal(versions[0].instruction, 'Insiste sur la sécurité');
    assert.equal(versions[0].created_at != null, true);

    // Une seconde demande empile une nouvelle entrée, sans écraser la première.
    await app.api('POST', `/api/mrs/${mrId}/modify`, { instruction: 'Ajoute les risques de perf' });
    await waitForJobs(app.api);
    const v2 = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    const asked = v2.filter((v) => v.kind === 'modify' && v.instruction).map((v) => v.instruction);
    assert.deepEqual(asked, ['Ajoute les risques de perf', 'Insiste sur la sécurité'], 'les deux demandes, plus récente d’abord');
    // Les versions issues d'une review (non-modify) n'ont pas d'instruction.
    assert.equal(v2.find((v) => v.kind === 'review').instruction, null);
  });

  test('POST /api/mrs/:id/fix-review ouvre une session de dev sur la branche de la MR', async () => {
    const { body } = await app.api('POST', `/api/mrs/${mrId}/fix-review`);
    assert.equal(body.ok, true);
    await waitForJobs(app.api);

    const task = (await app.api('GET', `/api/tasks/${body.task_id}`)).body.task;
    assert.equal(task.kind, 'code');
    assert.equal(task.branch, repo.branch);
    assert.equal(task.status, 'committed', 'la session s’exécute et commite (agent en dry-run)');
    assert.match(task.prompt, /RAPPORT DE REVUE/);

    const diff = await app.api('GET', `/api/tasks/${body.task_id}/targets/${task.targets[0].id}/diff`);
    assert.match(diff.body.diff, /PROJ_TASK_DRYRUN/);
  });

  test('POST /api/mrs/:id/delete-review efface le rapport et remet la MR à reviewer', async () => {
    const avant = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    const mdPath = avant.review.md;
    assert.ok(mdPath);

    const { body } = await app.api('POST', `/api/mrs/${mrId}/delete-review`);
    assert.equal(body.ok, true);

    const apres = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(apres.review, null);
    assert.equal(apres.mr.status, 'to_review');
    assert.equal(apres.mr.reviewed_sha, null);
  });

  test('POST /api/reports/reset supprime les rapports sur disque', async () => {
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await waitForJobs(app.api);
    const reviewsDir = path.join(app.dataDir, 'reviews');
    assert.ok(fs.existsSync(reviewsDir));

    const { body } = await app.api('POST', '/api/reports/reset');
    assert.equal(body.deleted, 1);
    assert.equal(fs.readdirSync(reviewsDir).length, 0);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}`)).body.review, null);
  });

  test('un job qui échoue enregistre l’erreur sur la MR sans arrêter le serveur', async () => {
    // Dépôt injoignable : le clone git échoue franchement.
    await app.api('PUT', `/api/repos/${repoId}`, { url: '/chemin/inexistant/depot.git' });
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await waitForJobs(app.api);

    const mr = (await app.api('GET', '/api/mrs')).body[0];
    assert.ok(mr.last_error, 'l’erreur complète est persistée pour être affichée/copiée');
    assert.equal(mr.status, 'to_review', 'une review en échec ne fait pas passer la MR à « reviewée »');

    await app.api('POST', `/api/mrs/${mrId}/clear-error`);
    assert.equal((await app.api('GET', '/api/mrs')).body[0].last_error, null);
    await app.api('PUT', `/api/repos/${repoId}`, { url: repo.url, project: 'grp/app' });
  });
});
