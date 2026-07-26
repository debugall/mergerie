'use strict';
/* Onglet Git : aperçu, exécution et restauration des opérations multi-dépôts.
   L'aperçu est ce qui protège l'utilisateur (rien n'est exécuté avant confirmation,
   les refs protégées / par défaut sont bloquées) : il est testé cas par cas. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

describe('Opérations Git de bout en bout', () => {
  let app; let repo; let repoId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.branches['grp/app'] = [
      { name: 'main', default: true, protected: true, merged: false, commit: { id: repo.mainSha, committed_date: '2026-01-01T00:00:00Z', author_name: 'Alice' } },
      { name: repo.branch, default: false, protected: false, merged: false, commit: { id: repo.branchSha, committed_date: '2026-02-01T00:00:00Z', author_name: 'Bob' } },
      { name: 'release/1.0', default: false, protected: true, merged: true, commit: { id: repo.mainSha, committed_date: '2026-01-15T00:00:00Z', author_name: 'Alice' } },
    ];
    app.state.protectedBranches['grp/app'] = ['main', 'release/1.0'];
    app.state.tags['grp/app'] = [{ name: 'v1.0.0', target: 'tagobj', message: 'release', commit: { id: repo.mainSha, committed_date: '2026-01-10T00:00:00Z', author_name: 'Alice' } }];
    app.state.protectedTags['grp/app'] = ['v1.0.0'];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
  });

  after(async () => { await app.stop(); });

  test('GET /api/git/tag-author lit le tagger d’un tag annoté (clone local)', async () => {
    const { execFileSync } = require('node:child_process');
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Release Bot', GIT_AUTHOR_EMAIL: 'bot@x.co',
      GIT_COMMITTER_NAME: 'Release Bot', GIT_COMMITTER_EMAIL: 'bot@x.co',
    };
    const g = (...args) => execFileSync('git', args, { cwd: repo.work, env, encoding: 'utf8' });
    g('checkout', 'main');
    g('tag', '-a', 'v-annot', '-m', 'release annotée'); // annoté → tagger = Release Bot
    g('tag', 'v-light');                                 // léger → auteur du commit
    g('push', 'origin', '--tags');

    const annot = (await app.api('GET', `/api/git/tag-author?repo_id=${repoId}&tag=v-annot`)).body;
    assert.equal(annot.found, true);
    assert.equal(annot.annotated, true);
    assert.equal(annot.author, 'Release Bot', 'le tagger du tag annoté');
    assert.ok(annot.date);

    const light = (await app.api('GET', `/api/git/tag-author?repo_id=${repoId}&tag=v-light`)).body;
    assert.equal(light.annotated, false);
    assert.ok(light.author, 'auteur du commit pour un tag léger');

    const none = (await app.api('GET', `/api/git/tag-author?repo_id=${repoId}&tag=v-nexiste-pas`)).body;
    assert.equal(none.found, false);

    // nom de tag invalide → 400 (garde anti injection d'argument)
    assert.equal((await app.api('GET', `/api/git/tag-author?repo_id=${repoId}&tag=${encodeURIComponent('bad tag')}`)).status, 400);
  });

  test('GET /api/git/find-ref cherche un tag/branche dans tous les dépôts', async () => {
    // Un 2e dépôt actif : même branche que grp/app, mais SANS le tag v1.0.0.
    app.state.projects.push({ id: 2, path_with_namespace: 'grp/lib2', name_with_namespace: 'Grp / Lib2', http_url_to_repo: 'https://gitlab.test/grp/lib2.git', ssh_url_to_repo: 'git@gitlab.test:grp/lib2.git' });
    app.state.branches['grp/lib2'] = [
      { name: 'main', default: true, protected: true, commit: { id: 'x1', committed_date: '2026-03-01T00:00:00Z', author_name: 'Zoe' } },
      { name: repo.branch, default: false, protected: false, commit: { id: 'x2', committed_date: '2026-03-02T00:00:00Z', author_name: 'Zoe' } },
    ];
    app.state.tags['grp/lib2'] = [];
    const r2 = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/lib2.git', project: 'grp/lib2' })).body;

    // Le tag v1.0.0 n'existe que dans grp/app.
    const tag = (await app.api('GET', '/api/git/find-ref?name=v1.0.0&type=tag')).body;
    const withTag = tag.repos.filter((x) => x.matches.length);
    assert.equal(withTag.length, 1);
    assert.equal(withTag[0].project, 'grp/app');
    assert.equal(withTag[0].matches[0].kind, 'tag');
    assert.match(withTag[0].matches[0].url, /\/-\/tags\/v1\.0\.0$/);
    const mainB = withTag[0].matches[0].branches.find((b) => b.name === 'main');
    assert.ok(mainB, 'la branche portant le tag est renseignée');
    assert.ok(mainB.tipDate, 'la date du dernier commit de la branche est renseignée');
    assert.equal(mainB.isTip, true, 'le tag pointe bien le dernier commit de main');

    // La branche de travail existe dans les DEUX dépôts.
    const br = (await app.api('GET', `/api/git/find-ref?name=${encodeURIComponent(repo.branch)}&type=branch`)).body;
    assert.equal(br.repos.filter((x) => x.matches.length).length, 2);
    assert.match(br.repos.find((x) => x.matches.length).matches[0].url, /\/-\/tree\//);

    // Ref inexistante → aucun match. Nom vide → 400.
    assert.equal((await app.api('GET', '/api/git/find-ref?name=zzz-nexiste-pas')).body.repos.filter((x) => x.matches.length).length, 0);
    assert.equal((await app.api('GET', '/api/git/find-ref?name=')).status, 400);

    await app.api('DELETE', `/api/repos/${r2.id}`); // ne pas polluer les tests suivants
  });

  test('GET /api/git/refs marque la branche par défaut et les refs protégées', async () => {
    const branches = await app.api('GET', `/api/git/refs?repo_id=${repoId}`);
    assert.equal(branches.body.kind, 'branches');
    assert.equal(branches.body.default, 'main');
    assert.equal(branches.body.refs.find((r) => r.name === 'main').protected, true);
    assert.equal(branches.body.refs.find((r) => r.name === repo.branch).protected, false);

    const tags = await app.api('GET', `/api/git/refs?repo_id=${repoId}&kind=tags`);
    assert.equal(tags.body.kind, 'tags');
    assert.equal(tags.body.refs[0].name, 'v1.0.0');
    assert.equal(tags.body.refs[0].protected, true);

    assert.equal((await app.api('GET', '/api/git/refs?repo_id=99999')).status, 400);
  });

  test('L’aperçu refuse les saisies invalides', async () => {
    assert.equal((await app.api('POST', '/api/git/preview', { action: 'rm -rf', targets: [] })).status, 400);
    assert.equal((await app.api('POST', '/api/git/preview', { action: 'new_branch', name: '-mauvais', targets: [{ repo_id: repoId, ref: 'main' }] })).status, 400);
    assert.equal((await app.api('POST', '/api/git/preview', { action: 'new_branch', name: 'ok', targets: [] })).status, 400);
  });

  test('L’aperçu qualifie chaque ligne (ok, existe, protégée, par défaut, absente)', async () => {
    const creation = await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'hotfix/1', targets: [{ repo_id: repoId, ref: 'main' }],
    });
    assert.equal(creation.body.rows[0].state, 'ok');
    assert.equal(creation.body.rows[0].sha, repo.mainSha);
    assert.match(creation.body.rows[0].cmd.equiv, /git push origin main:refs\/heads\/hotfix\/1/);
    assert.deepEqual(creation.body.counts, { ok: 1, skipped: 0, blocked: 0 });

    const existe = await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'main', targets: [{ repo_id: repoId, ref: 'main' }],
    });
    assert.equal(existe.body.rows[0].state, 'exists');

    const sourceAbsente = await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'x', targets: [{ repo_id: repoId, ref: 'inexistante' }],
    });
    assert.equal(sourceAbsente.body.rows[0].state, 'missing_source');

    const suppression = await app.api('POST', '/api/git/preview', {
      action: 'delete_branch',
      targets: [{ repo_id: repoId, refs: ['main', 'release/1.0', 'inconnue', repo.branch] }],
    });
    const etats = Object.fromEntries(suppression.body.rows.map((r) => [r.ref, r.state]));
    assert.equal(etats.main, 'is_default', 'la branche par défaut ne se supprime pas');
    assert.equal(etats['release/1.0'], 'protected');
    assert.equal(etats.inconnue, 'missing');
    assert.equal(etats[repo.branch], 'ok');
    assert.equal(suppression.body.counts.blocked, 3);

    const rienDeSelectionne = await app.api('POST', '/api/git/preview', {
      action: 'delete_tag', targets: [{ repo_id: repoId, refs: [] }],
    });
    assert.equal(rienDeSelectionne.body.rows[0].state, 'nothing_selected');
  });

  test('Créer une branche puis un tag, via la file de jobs', async () => {
    await app.api('POST', '/api/git/execute', { action: 'new_branch', name: 'hotfix/1', targets: [{ repo_id: repoId, ref: 'main' }] });
    await waitForJobs(app.api);
    assert.ok(app.state.branches['grp/app'].some((b) => b.name === 'hotfix/1'), 'la branche existe côté GitLab');

    await app.api('POST', '/api/git/execute', { action: 'create_tag', name: 'v1.1.0', message: 'livraison', targets: [{ repo_id: repoId, ref: 'main' }] });
    await waitForJobs(app.api);
    const tag = app.state.tags['grp/app'].find((x) => x.name === 'v1.1.0');
    assert.equal(tag.message, 'livraison', 'un message produit un tag annoté');

    const ops = await app.api('GET', '/api/git/ops');
    assert.equal(ops.body.length, 2);
    assert.ok(ops.body.every((o) => o.status === 'done'));
    assert.ok(ops.body.every((o) => o.restorable === false), 'une création n’est pas « restaurable »');
  });

  /* Un nom par projet. Le lot n'impose plus une ref unique : chaque cible peut
     porter le sien (`targets[i].name`), le nom global ne servant que de défaut.
     Cas d'usage réel : deux dépôts, deux conventions de version — on ne veut pas
     lancer un lot par dépôt pour autant. */
  test('Créer un tag DIFFÉRENT par projet dans un même lot', async () => {
    app.state.projects.push({ id: 3, path_with_namespace: 'grp/lib3', name_with_namespace: 'Grp / Lib3', http_url_to_repo: 'https://gitlab.test/grp/lib3.git', ssh_url_to_repo: 'git@gitlab.test:grp/lib3.git' });
    app.state.branches['grp/lib3'] = [
      { name: 'main', default: true, protected: false, commit: { id: 'sha-lib3', committed_date: '2026-04-01T00:00:00Z', author_name: 'Zoe' } },
    ];
    app.state.tags['grp/lib3'] = [];
    const repo3Id = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/lib3.git', project: 'grp/lib3' })).body.id;

    const cibles = [
      { repo_id: repoId, ref: 'main', name: 'v2.3.0' },
      { repo_id: repo3Id, ref: 'main', name: 'api-2026.07' },
    ];

    // 1. L'aperçu qualifie chaque ligne avec SON nom, et la commande équivalente
    //    montre bien le tag propre au dépôt (c'est ce qu'on relit avant d'exécuter).
    const pv = (await app.api('POST', '/api/git/preview', { action: 'create_tag', targets: cibles })).body;
    assert.equal(pv.rows.length, 2);
    assert.deepEqual(pv.rows.map((r) => r.target), ['v2.3.0', 'api-2026.07']);
    assert.ok(pv.rows.every((r) => r.state === 'ok'));
    assert.match(pv.rows[0].cmd.equiv, /refs\/tags\/v2\.3\.0$/);
    assert.match(pv.rows[1].cmd.equiv, /refs\/tags\/api-2026\.07$/);
    assert.equal(pv.name, null, 'aucun nom global quand chaque projet a le sien');

    // 2. Un nom invalide sur UNE SEULE ligne bloque tout le lot, avant écriture,
    //    et l'erreur NOMME le projet fautif (dix lignes, dix champs : sans ça on
    //    relit ses dix saisies).
    const invalide = await app.api('POST', '/api/git/preview', {
      action: 'create_tag',
      targets: [{ repo_id: repoId, ref: 'main', name: 'v2.3.0' }, { repo_id: repo3Id, ref: 'main', name: 'mauvais nom' }],
    });
    assert.equal(invalide.status, 400);
    assert.match(invalide.body.error, /grp\/lib3/, 'le projet fautif est nommé');
    assert.match(invalide.body.error, /mauvais nom/, 'le nom refusé est cité');

    // 3. Exécution : chaque dépôt reçoit SON tag, et l'historique le journalise tel quel.
    await app.api('POST', '/api/git/execute', { action: 'create_tag', message: 'livraison juillet', targets: cibles });
    await waitForJobs(app.api);
    assert.ok(app.state.tags['grp/app'].some((x) => x.name === 'v2.3.0'), 'le tag du 1er dépôt');
    assert.ok(app.state.tags['grp/lib3'].some((x) => x.name === 'api-2026.07'), 'le tag du 2e dépôt');
    assert.ok(!app.state.tags['grp/lib3'].some((x) => x.name === 'v2.3.0'), 'aucun nom ne déborde sur l’autre dépôt');

    const ops = (await app.api('GET', '/api/git/ops')).body.filter((o) => o.action === 'create_tag');
    const noms = ops.map((o) => o.ref_name);
    assert.ok(noms.includes('v2.3.0') && noms.includes('api-2026.07'), 'l’historique garde le nom réellement créé');

    await app.api('DELETE', `/api/repos/${repo3Id}`);   // ne pas polluer les tests suivants
  });

  /* Le nom global reste le cas courant : renseigné une fois, il s'applique à tous
     les projets qui n'en donnent pas. Les deux formes doivent pouvoir cohabiter. */
  test('Le nom global s’applique aux projets qui n’en fournissent pas', async () => {
    const pv = (await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'release/global',
      targets: [{ repo_id: repoId, ref: 'main' }, { repo_id: repoId, ref: 'main', name: 'release/specifique' }],
    })).body;
    assert.deepEqual(pv.rows.map((r) => r.target), ['release/global', 'release/specifique']);
    assert.equal(pv.counts.ok, 2, 'deux lignes distinctes sur le même dépôt');

    await app.api('POST', '/api/git/execute', {
      action: 'new_branch', name: 'release/global',
      targets: [{ repo_id: repoId, ref: 'main' }, { repo_id: repoId, ref: 'main', name: 'release/specifique' }],
    });
    await waitForJobs(app.api);
    const noms = app.state.branches['grp/app'].map((b) => b.name);
    assert.ok(noms.includes('release/global') && noms.includes('release/specifique'));
  });

  /* Le doublon INTERNE au lot. L'existence se vérifie contre le dépôt distant, qui
     ignore les lignes précédentes du même lot : sans mémoire des noms déjà prévus,
     deux lignes identiques passaient toutes deux au vert et la seconde échouait à
     l'écriture — précisément ce que l'aperçu est censé éviter. */
  test('Deux lignes du même lot visant le même nom : la 2e est bloquée à l’aperçu', async () => {
    const memeNom = [
      { repo_id: repoId, ref: 'main', name: 'v-collision' },
      { repo_id: repoId, ref: 'main', name: 'v-collision' },
    ];
    const pv = (await app.api('POST', '/api/git/preview', { action: 'create_tag', targets: memeNom })).body;
    assert.deepEqual(pv.rows.map((r) => r.state), ['ok', 'duplicate']);
    assert.equal(pv.counts.ok, 1);
    assert.equal(pv.counts.blocked, 1, 'le doublon est compté comme bloqué, pas comme exécutable');
    assert.equal(pv.rows[1].cmd, undefined, 'aucune commande sur une ligne qui ne s’exécutera pas');

    // Un même nom sur DEUX dépôts différents n'est pas un doublon : c'est le cas courant.
    const pv2 = (await app.api('POST', '/api/git/preview', {
      action: 'new_branch', name: 'release/commune',
      targets: [{ repo_id: repoId, ref: 'main' }, { repo_id: repoId, ref: repo.branch }],
    })).body;
    assert.deepEqual(pv2.rows.map((r) => r.state), ['ok', 'duplicate'],
      'même dépôt + même nom = doublon, quelle que soit la ref source');

    // À l'exécution, seule la 1re ligne écrit ; la 2e reste « en double » dans le
    // résultat (elle ne disparaît pas et ne se journalise pas en erreur GitLab).
    await app.api('POST', '/api/git/execute', { action: 'create_tag', targets: memeNom });
    await waitForJobs(app.api);
    assert.equal(app.state.tags['grp/app'].filter((x) => x.name === 'v-collision').length, 1);
    const ops = (await app.api('GET', '/api/git/ops')).body.filter((o) => o.ref_name === 'v-collision');
    assert.equal(ops.length, 1, 'une seule opération journalisée');
    assert.equal(ops[0].status, 'done', 'et aucune erreur GitLab « Tag already exists »');
  });

  /* Le même dépôt sur plusieurs lignes est devenu un cas normal (plusieurs tags de
     composants d'un monorepo). Chaque ligne relistait branches, tags et refs
     protégées — quatre listings PAGINÉS de plus par ligne, pour des données
     rigoureusement identiques. Les listings sont donc mémoïsés par projet, le temps
     de l'aperçu. */
  test('L’aperçu ne reliste GitLab qu’une fois par dépôt, quel que soit le nombre de lignes', async () => {
    const listings = () => app.state.calls.filter((c) => c.method === 'GET'
      && /grp%2Fapp\/repository\/(branches|tags)|grp%2Fapp\/protected_/.test(c.path)).length;

    app.state.calls.length = 0;
    await app.api('POST', '/api/git/preview', {
      action: 'create_tag', targets: [{ repo_id: repoId, ref: 'main', name: 'v-memo-1' }],
    });
    const uneLigne = listings();
    assert.ok(uneLigne > 0, 'l’aperçu interroge bien GitLab');

    app.state.calls.length = 0;
    await app.api('POST', '/api/git/preview', {
      action: 'create_tag',
      targets: [
        { repo_id: repoId, ref: 'main', name: 'v-memo-1' },
        { repo_id: repoId, ref: 'main', name: 'v-memo-2' },
        { repo_id: repoId, ref: 'main', name: 'v-memo-3' },
      ],
    });
    assert.equal(listings(), uneLigne, 'trois lignes sur le même dépôt = un seul jeu de listings');
  });

  test('Supprimer une branche, puis la restaurer depuis le clone local', async () => {
    await app.api('POST', '/api/git/execute', { action: 'delete_branch', targets: [{ repo_id: repoId, refs: ['hotfix/1'] }] });
    await waitForJobs(app.api);
    assert.ok(!app.state.branches['grp/app'].some((b) => b.name === 'hotfix/1'));

    const ops = (await app.api('GET', '/api/git/ops')).body;
    const suppression = ops.find((o) => o.action === 'delete_branch');
    assert.equal(suppression.status, 'done');
    assert.equal(suppression.fetched, 1, 'un fetch de sécurité précède toute suppression');
    assert.equal(suppression.restorable, true);
    assert.equal(suppression.ref_sha, repo.mainSha);

    await app.api('POST', `/api/git/ops/${suppression.id}/restore`);
    await waitForJobs(app.api);
    const apres = (await app.api('GET', '/api/git/ops')).body.find((o) => o.id === suppression.id);
    assert.ok(apres.restored_at, 'la restauration est datée');
    assert.equal(apres.restorable, false, 'on ne restaure pas deux fois');
  });

  test('Une opération en échec est journalisée sans interrompre le lot', async () => {
    app.state.fail = { '/repository/tags/' : { status: 403, body: { message: 'protected tag' } } };
    await app.api('POST', '/api/git/execute', { action: 'delete_tag', targets: [{ repo_id: repoId, refs: ['v1.1.0'] }] });
    await waitForJobs(app.api);
    app.state.fail = {};

    const op = (await app.api('GET', '/api/git/ops')).body[0];
    assert.equal(op.action, 'delete_tag');
    assert.equal(op.status, 'error');
    assert.match(op.error, /403/);
    assert.equal(op.restorable, false, 'un échec n’est pas restaurable');
  });

  test('L’explorateur de branches analyse le graphe du clone local', async () => {
    const { status, body } = await app.api('GET', `/api/git/branches?repo_id=${repoId}`);
    assert.equal(status, 200);
    assert.equal(body.default, 'main');
    assert.equal(body.project, 'grp/app');
    const b = body.branches.find((x) => x.name === repo.branch);
    assert.ok(b, 'la branche de travail est listée');
    assert.ok(Array.isArray(body.tags));
    const v1 = body.tags.find((x) => x.name === 'v1.0.0');
    assert.equal(v1.author, 'Alice', 'l’auteur du tag est exposé');
    assert.ok(Array.isArray(v1.branches), 'les branches portant le tag sont exposées');
    assert.ok(v1.branches.includes('main'), 'le commit du tag est sur main');
    assert.equal(v1.branches[0], 'main', 'la branche par défaut est en tête');
    assert.equal((await app.api('GET', '/api/git/branches?repo_id=99999')).status, 400);
  });

  test('Création d’une MR depuis l’explorateur', async () => {
    assert.equal((await app.api('POST', '/api/git/mr', { repo_id: repoId, source: '', target: 'main' })).status, 400);
    assert.equal((await app.api('POST', '/api/git/mr', { repo_id: repoId, source: 'main', target: 'main' })).status, 400);
    assert.equal((await app.api('POST', '/api/git/mr', { repo_id: 99999, source: 'a', target: 'b' })).status, 400);

    const { body } = await app.api('POST', '/api/git/mr', { repo_id: repoId, source: repo.branch, target: 'main' });
    assert.ok(body.iid);
    const mr = app.state.mrs['grp/app'].find((m) => m.iid === body.iid);
    assert.equal(mr.title, repo.branch, 'sans titre, la branche source fait office de titre');
  });

  test('Le job en cours peut être arrêté', async () => {
    await app.api('POST', '/api/git/execute', { action: 'new_branch', name: 'a-arreter', targets: [{ repo_id: repoId, ref: 'main' }] });
    const stop = await app.api('POST', '/api/jobs/stop');
    assert.equal(stop.status, 200);
    assert.equal(stop.body.ok, true);
    await waitForJobs(app.api);
  });

  // Régression : un tag supprimé puis recréé sur un AUTRE commit faisait échouer tout le
  // fetch de l'explorateur (« would clobber existing tag », code 1). Le fetch force donc
  // la mise à jour des tags. Ici on rejoue exactement ce scénario de bout en bout.
  test('Un tag recréé sur un autre SHA ne casse pas l’explorateur (fetch --force)', async () => {
    const { execFileSync } = require('node:child_process');
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Rel', GIT_AUTHOR_EMAIL: 'r@x.co', GIT_COMMITTER_NAME: 'Rel', GIT_COMMITTER_EMAIL: 'r@x.co',
    };
    const g = (...args) => execFileSync('git', args, { cwd: repo.work, env, encoding: 'utf8' });
    g('checkout', 'main');
    g('tag', 'pilot-adp');            // 1) tag posé sur le commit courant de main
    g('push', 'origin', '--tags');

    // 2) l'app rapatrie ce tag dans SON clone (via l'explorateur).
    assert.equal((await app.api('GET', `/api/git/branches?repo_id=${repoId}`)).status, 200);

    // 3) on le supprime et on le recrée sur un NOUVEAU commit, côté origin.
    fs.writeFileSync(path.join(repo.work, 'bump.txt'), 'x');
    g('add', '-A'); g('commit', '-m', 'bump');
    g('push', 'origin', 'HEAD:main');
    g('push', 'origin', ':refs/tags/pilot-adp'); // suppression sur origin
    g('tag', '-f', 'pilot-adp');                 // recréation locale sur le nouveau HEAD
    g('push', 'origin', '-f', '--tags');

    // 4) sans --force, ce 2e fetch renverrait « would clobber existing tag » → 500.
    assert.equal((await app.api('GET', `/api/git/branches?repo_id=${repoId}`)).status, 200);
  });
});
