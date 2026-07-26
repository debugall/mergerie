'use strict';
/* Parité GitHub, de bout en bout.

   Même exigence que pour GitLab : on parle au VRAI client (src/github.js) via un faux
   serveur GitHub, sur de VRAIS dépôts git locaux. Ce fichier est le filet qui garantit
   qu'une refonte du dispatch de forge (src/forge.js) ne casse aucune fonctionnalité :
   configuration, ajout en masse, découverte, review, commentaires, merge, session de
   dev jusqu'à la PR, onglet Git — et la cohabitation des deux forges. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

const PROJECT = 'acme/webapp';

describe('GitHub de bout en bout', () => {
  let app; let repo; let repoId; let mrId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gh-')));

    // Dépôt GitHub côté faux serveur : la PR pointe sur les vraies branches locales.
    app.ghState.repos = [
      { id: 1, full_name: PROJECT, clone_url: repo.url, ssh_url: repo.url, default_branch: 'main' },
      { id: 2, full_name: 'acme/tools', clone_url: 'https://github.test/acme/tools.git', ssh_url: '', default_branch: 'main' },
    ];
    app.ghState.branches[PROJECT] = [
      { name: 'main', protected: true, commit: { sha: repo.mainSha, commit: { committer: { date: '2026-01-01T00:00:00Z' }, author: { name: 'Testeur' } } } },
      { name: repo.branch, protected: false, commit: { sha: repo.branchSha, commit: { committer: { date: '2026-02-01T00:00:00Z' }, author: { name: 'Testeur' } } } },
    ];
    app.ghState.pulls[PROJECT] = [{
      number: 42, title: 'Ajout de b [PROJ-100]', state: 'open', merged: false, merged_at: null,
      head: { ref: repo.branch, sha: repo.branchSha },
      base: { ref: 'main', sha: repo.mainSha },
      html_url: `https://github.test/${PROJECT}/pull/42`,
      created_at: new Date().toISOString(), user: { login: 'alice' },
    }];
    app.ghState.files[`${PROJECT}#42`] = [
      { filename: 'src/app.js' }, { filename: 'db/migration.sql' },
    ];
    app.ghState.commits[PROJECT] = [{
      sha: repo.branchSha,
      commit: { message: 'feat: ajoute b\n\ndétail', author: { name: 'Testeur' }, committer: { date: '2026-02-01T00:00:00Z' } },
      html_url: `https://github.test/${PROJECT}/commit/${repo.branchSha}`,
    }];

    await app.configure();          // GitLab (dépôt mixte du dernier test)
    await app.configureGithub();    // GitHub
  });

  after(async () => { await app.stop(); });

  /* ---------- Configuration ---------- */

  test('le token GitHub est masqué en lecture et jamais écrasé par le masque', async () => {
    const read = await app.api('GET', '/api/config');
    assert.equal(read.body.github_token, '***', 'jamais renvoyé en clair');
    assert.equal(read.body.github_url, app.githubUrl);

    // Renvoyer le masque (cas nominal du formulaire) ne doit RIEN écraser.
    await app.api('PUT', '/api/config', { github_token: '***', github_url: app.githubUrl });
    const after = await app.api('POST', '/api/github/test', {});
    assert.equal(after.status, 200);
    assert.equal(after.body.login, 'testeur', 'le token en base est toujours valide');
  });

  test('URL et token GitHub survivent à un aller-retour complet du formulaire', async () => {
    // Régression : les champs du formulaire de réglages sont enregistrés via une liste
    // blanche (CONFIG_FIELDS côté front). Un champ oublié s'affiche, se saisit… et n'est
    // jamais persisté. On rejoue donc ce que fait le formulaire : PUT de TOUS les champs
    // (secrets masqués compris), puis relecture.
    const before = (await app.api('GET', '/api/config')).body;
    await app.api('PUT', '/api/config', {
      ...before,                       // le front renvoie l'ensemble du formulaire
      github_url: 'https://github.mon-entreprise.fr',
      github_token: 'ghp_nouveau_token',
      access_token: '***',             // masques non touchés : ne doivent rien écraser
      jira_token: '***',
    });
    const after = (await app.api('GET', '/api/config')).body;
    assert.equal(after.github_url, 'https://github.mon-entreprise.fr', 'URL GitHub persistée');
    assert.equal(after.github_token, '***', 'token persisté (et masqué en lecture)');
    assert.equal(after.gitlab_url, before.gitlab_url, 'les autres réglages sont intacts');

    // Le token réellement stocké est bien le nouveau : un test avec le masque l'utilise.
    const withNew = await app.api('POST', '/api/github/test', {});
    assert.equal(withNew.status, 400, 'le nouveau token (factice) est refusé par la forge');

    // On remet la vraie connexion de test pour la suite du fichier.
    await app.configureGithub();
    assert.equal((await app.api('POST', '/api/github/test', {})).body.login, 'testeur');
  });

  test('POST /api/github/test valide la connexion et remonte une erreur claire', async () => {
    const ok = await app.api('POST', '/api/github/test', { github_token: app.ghState.token });
    assert.equal(ok.body.login, 'testeur');

    const bad = await app.api('POST', '/api/github/test', { github_token: 'mauvais-token' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /401/, 'le statut HTTP est remonté à l’utilisateur');
  });

  test('GET /api/status expose githubConfigured (pilote l’UI)', async () => {
    const { body } = await app.api('GET', '/api/status');
    assert.equal(body.githubConfigured, true);
  });

  /* ---------- Ajout en masse ---------- */

  test('GET /api/github/projects suit la pagination par header Link', async () => {
    // Le mock sert 1 dépôt par page : sans suivi du header Link, on n'en verrait qu'un.
    assert.equal(app.ghState.perPage, 1, 'le mock force la pagination');
    const { body } = await app.api('GET', '/api/github/projects');
    assert.deepEqual(body.map((p) => p.project).sort(), ['acme/tools', PROJECT]);
    assert.ok(app.ghState.sawUserAgent, 'le client envoie un User-Agent (403 sinon)');
  });

  test('POST /api/repos/bulk ajoute des dépôts GitHub et dédoublonne', async () => {
    const first = await app.api('POST', '/api/repos/bulk', {
      forge: 'github', projects: [{ project: PROJECT, url: repo.url }], branch_pattern: '',
    });
    assert.deepEqual(first.body, { added: 1, skipped: 0 });

    const again = await app.api('POST', '/api/repos/bulk', {
      forge: 'github', projects: [{ project: PROJECT, url: repo.url }],
    });
    assert.deepEqual(again.body, { added: 0, skipped: 1 }, 'doublon ignoré');

    const rows = (await app.api('GET', '/api/repos')).body;
    const gh = rows.find((r) => r.project === PROJECT);
    repoId = gh.id;
    assert.equal(gh.forge, 'github', 'la forge est persistée et exposée');
  });

  test('un dépôt homonyme sur GitLab coexiste avec celui de GitHub', async () => {
    const r = await app.api('POST', '/api/repos/bulk', {
      forge: 'gitlab', projects: [{ project: PROJECT, url: `https://gitlab.test/${PROJECT}.git` }],
    });
    assert.deepEqual(r.body, { added: 1, skipped: 0 }, 'unicité par couple (forge, projet)');
    const rows = (await app.api('GET', '/api/repos')).body.filter((x) => x.project === PROJECT);
    assert.deepEqual(rows.map((x) => x.forge).sort(), ['github', 'gitlab']);
    // On retire le doublon GitLab : la suite ne teste que le dépôt GitHub.
    await app.api('DELETE', `/api/repos/${rows.find((x) => x.forge === 'gitlab').id}`);
  });

  test('un bulk SANS champ forge reste du GitLab (contrat inchangé)', async () => {
    const r = await app.api('POST', '/api/repos/bulk', {
      projects: [{ project: 'grp/legacy', url: 'https://gitlab.test/grp/legacy.git' }],
    });
    assert.deepEqual(r.body, { added: 1, skipped: 0 });
    const row = (await app.api('GET', '/api/repos')).body.find((x) => x.project === 'grp/legacy');
    assert.equal(row.forge, 'gitlab');
    await app.api('DELETE', `/api/repos/${row.id}`);
  });

  /* ---------- Découverte et review ---------- */

  test('POST /api/discover récupère les PR GitHub comme des MR', async () => {
    const { body } = await app.api('POST', '/api/discover');
    assert.equal(body.errors.length, 0, JSON.stringify(body.errors));
    const mrs = (await app.api('GET', '/api/mrs')).body.filter((m) => m.project === PROJECT);
    assert.equal(mrs.length, 1);
    mrId = mrs[0].id;
    assert.equal(mrs[0].iid, 42, 'le numéro de PR devient l’iid');
    assert.equal(mrs[0].source_branch, repo.branch, 'head.ref → source_branch');
    assert.equal(mrs[0].target_branch, 'main', 'base.ref → target_branch');
    assert.equal(mrs[0].author, 'alice');
  });

  test('les chemins modifiés d’une PR alimentent le badge « risque »', async () => {
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.ok(String(mr.changed_paths || '').includes('db/migration.sql'));
  });

  test('review complète d’une PR : clone, diff, rapport noté', async () => {
    const job = await app.api('POST', `/api/mrs/${mrId}/review`, { explain: false });
    assert.equal(job.body.kind, 'review');
    await waitForJobs(app.api);
    const { mr, review } = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(mr.status, 'reviewed', mr.last_error || '');
    assert.ok(review && review.md, 'un rapport a été écrit');
    // La note extraite du rapport est portée par la liste (comme pour GitLab).
    const listed = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.ok(listed.note != null, 'une note a été extraite du rapport');
    assert.equal(listed.has_review, true);
  });

  /* ---------- Commentaires ---------- */

  test('commentaire général : posté puis relu dans le fil', async () => {
    const r = await app.api('POST', `/api/mrs/${mrId}/comment`, { body: 'Merci !' });
    assert.equal(r.status, 200);
    const { body } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const general = body.discussions.filter((d) => !d.notes[0].position);
    assert.equal(general.length, 1);
    assert.equal(general[0].notes[0].body, 'Merci !');
    assert.equal(general[0].notes[0].author, 'testeur');
  });

  test('commentaire inline : position GitLab → GitHub, et retour', async () => {
    const r = await app.api('POST', `/api/mrs/${mrId}/discussion`, {
      body: 'à revoir', new_path: 'src/app.js', new_line: 2,
    });
    assert.equal(r.status, 200);
    // Côté GitHub, le commentaire porte bien path/line/side et le SHA de tête.
    const posted = app.ghState.reviewComments[`${PROJECT}#42`][0];
    assert.equal(posted.path, 'src/app.js');
    assert.equal(posted.line, 2);
    assert.equal(posted.side, 'RIGHT');
    assert.equal(posted.commit_id, repo.branchSha, 'commit_id = head_sha de la PR');
    // Côté app, il revient avec une position exploitable par le viewer de diff.
    const { body } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const inline = body.discussions.find((d) => d.notes[0].position);
    assert.equal(inline.notes[0].position.new_path, 'src/app.js');
    assert.equal(inline.notes[0].position.new_line, 2);
  });

  test('réponse à un fil inline : rattachée à la même racine', async () => {
    const { body: before } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const thread = before.discussions.find((d) => d.notes[0].position);
    const r = await app.api('POST', `/api/mrs/${mrId}/discussions/${thread.id}/reply`, { body: 'corrigé' });
    assert.equal(r.status, 200);
    const { body: after } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const same = after.discussions.find((d) => d.id === thread.id);
    assert.equal(same.notes.length, 2, 'le fil compte deux notes, pas deux fils');
    assert.equal(same.notes[1].body, 'corrigé');
  });

  /* ---------- Merge ---------- */

  test('merge d’une PR : l’état normalisé passe à « merged »', async () => {
    const r = await app.api('POST', `/api/mrs/${mrId}/merge`);
    assert.equal(r.status, 200);
    assert.equal(r.body.merged, true);
    assert.ok(app.ghState.pulls[PROJECT][0].merged, 'la PR est mergée côté GitHub');
    // Même effet que côté GitLab : la MR est marquée close (elle quitte la file).
    const { mr } = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    assert.equal(mr.closed_seen, 1, 'la MR est marquée mergée/close');
  });

  test('une PR mergée n’est pas confondue avec une PR fermée', async () => {
    // GitHub renvoie state:'closed' pour une PR mergée : sans normalisation, le merge
    // d'une session ne serait jamais confirmé.
    const github = require('../src/github');
    const cfg = { github_url: app.githubUrl, github_token: app.ghState.token };
    const mr = await github.getMergeRequest(cfg, PROJECT, 42);
    assert.equal(mr.state, 'merged');
  });

  /* ---------- Onglet Git ---------- */

  test('GET /api/git/refs liste branches et tags, protection incluse', async () => {
    const { body } = await app.api('GET', `/api/git/refs?repo_id=${repoId}&kind=branches`);
    assert.equal(body.default, 'main');
    const main = body.refs.find((b) => b.name === 'main');
    assert.equal(main.protected, true, 'la branche protégée est signalée AVANT l’aperçu');
    assert.equal(main.default, true);
  });

  test('aperçu puis création d’une branche et d’un tag sur GitHub', async () => {
    const pv = await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'release/1.0', targets: [{ repo_id: repoId, ref: 'main' }],
    });
    assert.equal(pv.body.rows[0].state, 'ok');
    assert.match(pv.body.rows[0].cmd.api, /^POST \/repos\/acme\/webapp\/git\/refs$/, 'chemin d’API de la bonne forge');

    await app.api('POST', '/api/git/execute', {
      action: 'new_branch', name: 'release/1.0', targets: [{ repo_id: repoId, ref: 'main' }],
    });
    await waitForJobs(app.api);
    assert.ok(app.ghState.branches[PROJECT].some((b) => b.name === 'release/1.0'), 'branche créée via l’API GitHub');

    await app.api('POST', '/api/git/execute', {
      action: 'create_tag', name: 'v1.0.0', message: 'release 1.0', targets: [{ repo_id: repoId, ref: 'main' }],
    });
    await waitForJobs(app.api);
    const tag = app.ghState.tags[PROJECT].find((x) => x.name === 'v1.0.0');
    assert.ok(tag, 'tag créé');
    assert.equal(tag.commit.sha, 'tagobj-v1.0.0', 'tag ANNOTÉ : la ref pointe l’objet de tag');
  });

  test('l’aperçu refuse de supprimer une branche protégée ou par défaut', async () => {
    const pv = await app.api('POST', '/api/git/preview', {
      action: 'delete_branch', targets: [{ repo_id: repoId, refs: ['main', 'release/1.0'] }],
    });
    const byRef = Object.fromEntries(pv.body.rows.map((r) => [r.ref, r.state]));
    assert.equal(byRef.main, 'is_default');
    assert.equal(byRef['release/1.0'], 'ok');
  });

  test('suppression puis restauration d’une branche GitHub', async () => {
    await app.api('POST', '/api/git/execute', {
      action: 'delete_branch', targets: [{ repo_id: repoId, refs: ['release/1.0'] }],
    });
    await waitForJobs(app.api);
    assert.ok(!app.ghState.branches[PROJECT].some((b) => b.name === 'release/1.0'), 'branche supprimée');

    const ops = (await app.api('GET', '/api/git/ops')).body;
    const op = ops.find((o) => o.ref_name === 'release/1.0' && o.action === 'delete_branch');
    assert.ok(op.restorable, 'le SHA a été journalisé → restauration possible');
    await app.api('POST', `/api/git/ops/${op.id}/restore`);
    await waitForJobs(app.api);
    const restored = (await app.api('GET', '/api/git/ops')).body.find((o) => o.id === op.id);
    assert.ok(restored.restored_at, 'restauration enregistrée');
  });

  test('GET /api/git/find-ref cherche à travers les dépôts et donne une URL GitHub', async () => {
    const { body } = await app.api('GET', '/api/git/find-ref?name=v1.0.0&type=tag');
    const hit = body.repos.find((r) => r.project === PROJECT);
    assert.ok(hit.matches.length, 'tag trouvé sur le dépôt GitHub');
    assert.match(hit.matches[0].url, /\/acme\/webapp\/releases\/tag\/v1\.0\.0$/, 'URL web GitHub, pas le format GitLab /-/tags/');
  });

  test('le dernier commit alimente le tableau de bord', async () => {
    const { body } = await app.api('GET', '/api/dashboard/commits');
    assert.equal(body.configured, true);
    const c = body.commits.find((x) => x.project === PROJECT);
    assert.equal(c.title, 'feat: ajoute b', 'première ligne du message seulement');
    assert.equal(c.author, 'Testeur');
  });

  /* ---------- Session de dev → PR ---------- */

  test('session de codage sur un dépôt GitHub : commit, push, PR créée', async () => {
    const task = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'ajoute un fichier', commit_message: 'feat: session github',
      auto_push: 1, targets: [{ repo_id: repoId, branch: 'feature/gh-session', base_branch: 'main' }],
    });
    const taskId = task.body.id;
    await app.api('POST', `/api/tasks/${taskId}/run`);
    await waitForJobs(app.api);

    let tg = (await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0];
    assert.equal(tg.status, 'pushed', tg.last_error || '');

    const mr = await app.api('POST', `/api/tasks/${taskId}/targets/${tg.id}/mr`, { title: 'Session GitHub' });
    assert.equal(mr.status, 200);
    const pr = app.ghState.pulls[PROJECT].find((p) => p.head.ref === 'feature/gh-session');
    assert.ok(pr, 'la PR a bien été créée côté GitHub');
    assert.equal(pr.base.ref, 'main', 'cible = branche de départ de la session');

    // Merge depuis l'app : confirmé seulement si la forge dit vraiment « mergée ».
    const merged = await app.api('POST', `/api/tasks/${taskId}/targets/${tg.id}/merge`);
    assert.equal(merged.body.merged, true);
    tg = (await app.api('GET', `/api/tasks/${taskId}`)).body.task.targets[0];
    assert.equal(tg.mr_merged, 1);
  });

  /* ---------- Cohabitation des deux forges ---------- */

  test('un dépôt GitLab et un dépôt GitHub coexistent dans une même découverte', async () => {
    const glRepo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/gl' });
    app.state.mrs['grp/mixte'] = [{
      iid: 7, title: 'MR GitLab', state: 'opened',
      source_branch: 'feature/gl', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/mixte/-/merge_requests/7',
      sha: glRepo.branchSha, created_at: new Date().toISOString(), author: { name: 'Bob' },
    }];
    await app.api('POST', '/api/repos', { url: glRepo.url, project: 'grp/mixte', forge: 'gitlab' });

    const { body } = await app.api('POST', '/api/discover');
    assert.equal(body.errors.length, 0, JSON.stringify(body.errors));

    const mrs = (await app.api('GET', '/api/mrs')).body;
    assert.ok(mrs.some((m) => m.project === 'grp/mixte' && m.forge === 'gitlab'), 'MR GitLab découverte');
    assert.ok(mrs.some((m) => m.project === PROJECT && m.forge === 'github'), 'PR GitHub découverte');
  });
});
