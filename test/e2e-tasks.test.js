'use strict';
/* Sessions de dev (onglet « Dev IA ») de bout en bout : création multi-projets,
   validation des saisies, exécution sur un vrai dépôt git, itération, push,
   création puis merge de la MR, et exploration en lecture seule. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, git } = require('./helpers/app');

const PNG = 'data:image/png;base64,aGVsbG8=';

describe('Sessions de dev de bout en bout', () => {
  let app; let repo; let repo2; let repoId; let repo2Id;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'r1-')));
    repo2 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'r2-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    repo2Id = (await app.api('POST', '/api/repos', { url: repo2.url, project: 'grp/lib' })).body.id;
  });

  after(async () => { await app.stop(); });

  /* Une session inexistante doit répondre « Session introuvable » — et pas la trace d'un
     bug interne. Ces routes nomment leur variable locale `t` comme la fonction de
     traduction : la moindre inattention y renvoie « t is not a function », message
     rigoureusement inutile pour qui le lit, et sur toutes les routes à la fois. */
  test('une session inexistante donne un message lisible, pas une erreur technique', async () => {
    for (const [m, url, body] of [
      ['GET', '/api/tasks/99999', null],
      ['PUT', '/api/tasks/99999', { prompt: 'x' }],
      ['GET', '/api/tasks/99999/md', null],
      ['POST', '/api/tasks/99999/run', null],
      ['POST', '/api/tasks/99999/followup', { instruction: 'x' }],
    ]) {
      const r = body ? await app.api(m, url, body) : await app.api(m, url);
      assert.ok(r.status >= 400, `${m} ${url} devrait échouer`);
      assert.match(r.body.error, /introuvable|not found/i, `${m} ${url} → ${r.body.error}`);
    }
  });

  /* Une relance doit solder l'échec précédent DÈS la mise en file, pas au démarrage effectif :
     sinon la carte continue d'afficher « erreur » entre le clic et le départ du job — et
     derrière une file chargée, cet entre-deux dure. On vérifie donc l'état juste après le POST,
     avant que le job n'ait pu s'exécuter. */
  test('relancer une session en erreur solde l’erreur immédiatement', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'ai/echec' }],
    });
    const id = t.body.id;
    app.db.prepare("UPDATE task SET status='error', last_error='échec précédent' WHERE id=?").run(id);
    app.db.prepare("UPDATE task_target SET status='error', last_error='échec précédent' WHERE task_id=?").run(id);

    const job = await app.api('POST', `/api/tasks/${id}/run`);
    assert.equal(job.status, 200);
    // le job vient d'être MIS EN FILE ; l'erreur ne doit déjà plus être affichable
    const apres = await app.api('GET', `/api/tasks/${id}`);
    assert.equal(apres.body.task.last_error, null, 'l’erreur de la session est soldée à la mise en file');
    for (const tg of apres.body.task.targets) {
      assert.equal(tg.last_error, null, 'l’erreur du projet aussi');
    }
    await waitForJobs(app.api);
  });

  /* Le cœur du correctif « relance après un échec tardif » : `commitAll` renvoie « rien à
     committer » aussi bien quand l'IA n'a rien produit que quand la branche porte DÉJÀ le
     travail. Confondre les deux renvoyait la session en erreur sans diff ni bouton « Créer la
     MR », alors que le code était là. C'est `aheadOf` qui les sépare. */
  test('une branche qui porte déjà le travail est reconnue comme telle', async () => {
    const gitmod = require('../src/git');
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'ahead-'));
    const r = makeRemoteRepo(dir, { branch: 'feature/deja-fait' });
    const work = path.join(dir, 'work');

    // sur une branche neuve, sans commit : rien d'avance → l'IA n'a vraiment rien produit
    git(work, ['checkout', '-b', 'feature/vide', 'main']);
    git(work, ['fetch', 'origin']);
    assert.equal(await gitmod.aheadOf(work, 'main'), 0, 'branche vide : aucune avance');
    assert.equal(await gitmod.isPushed(work, 'feature/vide'), false, 'branche vide : pas sur origin');

    // la branche de travail, elle, porte des commits : une relance ne doit PAS crier à l'erreur
    git(work, ['checkout', r.branch]);
    assert.ok(await gitmod.aheadOf(work, 'main') > 0, 'branche de travail : du travail d’avance');

    // et une fois poussée, on sait le dire
    git(work, ['push', '-u', 'origin', r.branch]);
    git(work, ['fetch', 'origin']);
    assert.equal(await gitmod.isPushed(work, r.branch), true, 'branche poussée : reconnue comme telle');
  });

  /* Le scénario réel : un projet commite, puis échoue APRÈS (push refusé). La cible reste
     « erreur », donc sans diff ni bouton MR, alors que le travail est dans le clone. Réconcilier
     doit le rétablir SANS appeler l'IA — et ne rien maquiller quand la branche est vraiment vide. */
  test('réconcilier rétablit un projet dont le travail est déjà commité', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'travail déjà fait', targets: [{ repo_id: repoId, branch: 'ai/deja-commite' }],
    });
    const id = t.body.id;
    await app.api('POST', `/api/tasks/${id}/run`);
    await waitForJobs(app.api);

    // état après un run réussi : on le casse comme le ferait un push refusé APRÈS le commit
    const avant = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets[0];
    assert.ok(['committed', 'pushed'].includes(avant.status), `préalable : run réussi (${avant.status})`);
    app.db.prepare("UPDATE task_target SET status='error', last_error='push refusé', diff_path=NULL WHERE id=?").run(avant.id);
    app.db.prepare("UPDATE task SET status='error', last_error='push refusé' WHERE id=?").run(id);

    const casse = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets[0];
    assert.equal(casse.diff_path, null, 'préalable : plus de diff, donc plus de bouton');

    const job = await app.api('POST', `/api/tasks/${id}/reconcile`);
    assert.equal(job.status, 200, 'la réconciliation est acceptée');
    await waitForJobs(app.api);

    const apres = (await app.api('GET', `/api/tasks/${id}`)).body;
    const tg = apres.task.targets[0];
    assert.ok(['committed', 'pushed'].includes(tg.status), `la cible est rétablie (${tg.status})`);
    assert.equal(tg.last_error, null, 'l’erreur est levée');
    assert.ok(tg.diff_path, 'le diff est régénéré — donc « Voir le diff » et la création de MR reviennent');
    assert.ok(tg.commit_sha, 'le commit est de nouveau référencé');
  });

  test('réconcilier ne maquille pas un projet réellement en échec', async () => {
    // branche jamais créée : rien à réconcilier, la cible DOIT rester en erreur.
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'jamais lancé', targets: [{ repo_id: repoId, branch: 'ai/jamais-creee' }],
    });
    const id = t.body.id;
    const tgId = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets[0].id;
    app.db.prepare("UPDATE task_target SET status='error', last_error='échec réel' WHERE id=?").run(tgId);

    await app.api('POST', `/api/tasks/${id}/reconcile`);
    await waitForJobs(app.api);

    const tg = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets[0];
    assert.equal(tg.status, 'error', 'une branche vide reste en erreur');
    assert.equal(tg.last_error, 'échec réel', 'et son message n’est pas effacé');
  });

  /* Une session multi-dépôts se relançait forcément EN ENTIER. Le point qui compte n'est pas
     que le projet visé tourne, c'est que les AUTRES ne soient pas touchés : sinon on paie un
     appel IA par projet déjà bon, et l'agent repasse sur du code qu'on ne voulait plus voir
     modifier. */
  test('on lance un seul projet d’une session multi-dépôts', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'multi', targets: [
        { repo_id: repoId, branch: 'ai/cible-a' },
        { repo_id: repo2Id, branch: 'ai/cible-b' },
      ],
    });
    const id = t.body.id;
    const cibles = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    assert.equal(cibles.length, 2);
    const [a, b] = cibles;

    await app.api('POST', `/api/tasks/${id}/run`, { targets: [a.id] });
    await waitForJobs(app.api);

    const apres = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    const va = apres.find((x) => x.id === a.id);
    const vb = apres.find((x) => x.id === b.id);
    assert.ok(['committed', 'pushed', 'needs_input'].includes(va.status), `le projet visé a tourné (${va.status})`);
    assert.equal(vb.status, 'new', 'l’autre projet n’a pas été touché');
    assert.equal(vb.commit_sha, null, 'et n’a rien produit');
  });

  /* Même exigence pour la CORRECTION : une remarque porte presque toujours sur un dépôt
     précis. La passer à toute la session refait un travail bon, dépôt par dépôt, et fait
     repasser l'agent sur du code qu'on ne voulait plus voir toucher. */
  test('on corrige un seul projet d’une session multi-dépôts', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'multi-fix', targets: [
        { repo_id: repoId, branch: 'ai/fix-a' },
        { repo_id: repo2Id, branch: 'ai/fix-b' },
      ],
    });
    const id = t.body.id;
    await app.api('POST', `/api/tasks/${id}/run`);
    await waitForJobs(app.api);

    const avant = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    const [a, b] = avant;
    assert.ok(['committed', 'pushed'].includes(a.status) && ['committed', 'pushed'].includes(b.status),
      'les deux projets ont produit un commit');

    await app.api('POST', `/api/tasks/${id}/followup`, { instruction: 'Renomme la variable', targets: [a.id] });
    await waitForJobs(app.api);

    const apres = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    const va = apres.find((x) => x.id === a.id);
    const vb = apres.find((x) => x.id === b.id);
    assert.notEqual(va.commit_sha, a.commit_sha, 'le projet visé a une nouvelle passe');
    assert.equal(vb.commit_sha, b.commit_sha, 'l’autre projet n’a pas bougé');

    // L'historique le confirme là où ça compte : une itération d'un côté, aucune de l'autre.
    const ha = await app.api('GET', `/api/tasks/${id}/targets/${a.id}/passes`);
    const hb = await app.api('GET', `/api/tasks/${id}/targets/${b.id}/passes`);
    assert.deepEqual(ha.body.passes.map((p) => p.kind), ['run', 'followup']);
    assert.deepEqual(hb.body.passes.map((p) => p.kind), ['run'], 'aucun appel IA gaspillé sur l’autre dépôt');
  });

  /* Une exploration produit UNE synthèse commune : viser un dépôt n'a pas de sens. Refuser
     vaut mieux qu'ignorer en silence — sinon l'utilisateur croit avoir restreint la passe. */
  test('cibler un dépôt est refusé sur une exploration', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'où est la config ?', targets: [{ repo_id: repoId }],
    });
    const tg = (await app.api('GET', `/api/tasks/${t.body.id}`)).body.task.targets[0];
    const r = await app.api('POST', `/api/tasks/${t.body.id}/followup`, { instruction: 'précise', targets: [tg.id] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /synthèse|write-up/);
  });

  test('un projet étranger à la session est refusé, pas ignoré', async () => {
    // Ignorer un id inconnu ferait tourner la session ENTIÈRE sans le dire — le contraire
    // de ce qu'on a demandé, et sur un multi-dépôts ça se paie.
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'ai/solo' }],
    });
    const r = await app.api('POST', `/api/tasks/${t.body.id}/run`, { targets: [999999] });
    assert.ok(r.status >= 400, 'un id étranger est refusé');
    const tg = (await app.api('GET', `/api/tasks/${t.body.id}`)).body.task.targets[0];
    assert.equal(tg.status, 'new', 'et rien n’a été lancé');
  });

  /* Actions groupées d'une session multi-dépôts. Le point à vérifier n'est pas qu'elles
     marchent quand tout va bien, mais qu'elles ne touchent QUE ce qu'il faut : pousser ne doit
     pas repousser une branche déjà poussée, et créer les MR ne doit pas en ouvrir une seconde
     là où il y en a déjà une. */
  test('pousser tous / créer toutes les MR ne visent que ce qui manque', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'lot', targets: [
        { repo_id: repoId, branch: 'ai/lot-a' },
        { repo_id: repo2Id, branch: 'ai/lot-b' },
      ],
    });
    const id = t.body.id;
    await app.api('POST', `/api/tasks/${id}/run`);
    await waitForJobs(app.api);

    let cibles = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    // on ramène les deux à « commité », dont un qui portera déjà une MR
    for (const tg of cibles) app.db.prepare("UPDATE task_target SET status='committed', mr_iid=NULL, mr_url=NULL WHERE id=?").run(tg.id);

    const push = await app.api('POST', `/api/tasks/${id}/push-all`);
    assert.equal(push.status, 200, 'le push groupé est accepté');
    await waitForJobs(app.api);
    cibles = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    assert.ok(cibles.every((tg) => tg.status === 'pushed'), 'les deux branches sont poussées');

    // plus rien à pousser : l'action doit le DIRE, pas relancer un job vide
    const encore = await app.api('POST', `/api/tasks/${id}/push-all`);
    assert.ok(encore.status >= 400, 'sans branche à pousser, l’action est refusée');

    // une MR existe déjà sur le premier projet : la création groupée doit l'ignorer
    app.db.prepare("UPDATE task_target SET mr_iid=42, mr_url='https://x/42' WHERE id=?").run(cibles[0].id);
    const mrs = await app.api('POST', `/api/tasks/${id}/mrs`, { squash: false, removeSourceBranch: false });
    assert.equal(mrs.status, 200);
    assert.equal(mrs.body.created.length, 1, 'une seule MR créée — pas de doublon sur le projet qui en a déjà une');
    assert.equal(mrs.body.created[0].project, cibles[1].project);

    const apres = (await app.api('GET', `/api/tasks/${id}`)).body.task.targets;
    assert.equal(apres.find((x) => x.id === cibles[0].id).mr_iid, 42, 'la MR existante n’a pas été remplacée');

    // toutes en ont une : plus rien à créer
    const vide = await app.api('POST', `/api/tasks/${id}/mrs`, {});
    assert.ok(vide.status >= 400, 'sans MR à créer, l’action est refusée');

    /* Nettoyage : les statistiques comptent les MR créées SUR TOUTE la base, et un autre test
       assure ce compteur. Un test qui laisse des traces globales en fait échouer un autre selon
       l'ordre d'exécution — on préfère nettoyer plutôt que dépendre de l'ordre. */
    app.db.prepare('UPDATE task_target SET mr_iid = NULL, mr_url = NULL WHERE task_id = ?').run(id);
  });

  /* Le journal d'activité répond à « qu'est-ce que j'avais lancé, et qu'est-ce qui est fini ».
     Ce qui le rend utile, c'est qu'il NOMME l'objet : « job #42 » n'apprend rien. Le lien job →
     objet n'existait pas en base, d'où ce test sur ce qui le porte. */
  test('le journal d’activité nomme l’objet de chaque job', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un timeout sur les appels sortants',
      targets: [{ repo_id: repoId, branch: 'ai/hist' }],
    });
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    await waitForJobs(app.api);

    const h = await app.api('GET', '/api/jobs/history');
    const j = h.body.jobs.find((x) => x.target_kind === 'task' && x.target_id === t.body.id);
    assert.ok(j, 'le job est dans le journal, rattaché à sa session');
    assert.match(j.label, /timeout/, 'et il en donne un libellé lisible');
    assert.deepEqual(j.href, { kind: 'task', id: t.body.id }, 'de quoi y mener en un clic');
    assert.ok(j.started_at && j.finished_at, 'début et fin, donc une durée calculable');
    assert.equal(h.body.latest, h.body.jobs[0].id, 'le curseur « déjà vu » est fourni');
  });

  test('le journal est trié sur l’activité la plus récente, pas sur l’identifiant', async () => {
    /* L'identifiant croît à la MISE EN FILE. Un job queué tôt mais terminé tard doit passer
       APRÈS un job queué ensuite et terminé avant — sinon la liste se lit comme un désordre,
       puisque la colonne affichée est l'heure de fin. Le cas est courant depuis que plusieurs
       jobs tournent de front. */
    const long = app.db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at, finished_at)
      VALUES ('review', 'done', 1, 1, '', '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z')`).run().lastInsertRowid;
    const court = app.db.prepare(`INSERT INTO job (kind, status, total, done_count, message, started_at, finished_at)
      VALUES ('review', 'done', 1, 1, '', '2030-01-01T10:05:00Z', '2030-01-01T10:06:00Z')`).run().lastInsertRowid;
    assert.ok(court > long, 'préalable : le court a bien un id PLUS GRAND');

    const ids = (await app.api('GET', '/api/jobs/history')).body.jobs.map((j) => j.id);
    assert.ok(ids.indexOf(long) < ids.indexOf(court), 'le job terminé le plus récemment vient en premier');

    const h = await app.api('GET', '/api/jobs/history');
    assert.equal(h.body.latest, Math.max(...h.body.jobs.map((j) => j.id)),
      'le curseur suit le plus grand id, pas la tête de liste');

    app.db.prepare('DELETE FROM job WHERE id IN (?, ?)').run(long, court);
  });

  test('le journal reste lisible quand l’objet a disparu', async () => {
    // Une session supprimée ne doit ni faire échouer l'écran, ni afficher un libellé menteur.
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'session éphémère', targets: [{ repo_id: repoId, branch: 'ai/ephemere' }],
    });
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    await waitForJobs(app.api);
    await app.api('DELETE', `/api/tasks/${t.body.id}`);

    const h = await app.api('GET', '/api/jobs/history');
    const orphelin = h.body.jobs.find((x) => x.target_kind === 'task' && x.target_id === t.body.id);
    assert.ok(orphelin, 'le job reste dans le journal');
    assert.equal(orphelin.label, null, 'sans libellé, plutôt qu’un libellé faux');
    assert.equal(orphelin.href, null, 'et sans lien vers un objet qui n’existe plus');
  });

  test('la création d’une session valide ses entrées', async () => {
    const sansPrompt = await app.api('POST', '/api/tasks', { targets: [{ repo_id: repoId, branch: 'x' }] });
    assert.equal(sansPrompt.status, 400);

    const sansProjet = await app.api('POST', '/api/tasks', { prompt: 'fais un truc', targets: [] });
    assert.equal(sansProjet.status, 400);

    const sansBranche = await app.api('POST', '/api/tasks', { prompt: 'p', targets: [{ repo_id: repoId }] });
    assert.equal(sansBranche.status, 400, 'en codage, la branche de travail est obligatoire');

    const brancheInvalide = await app.api('POST', '/api/tasks', { prompt: 'p', targets: [{ repo_id: repoId, branch: '--yolo' }] });
    assert.equal(brancheInvalide.status, 400, 'un nom de branche ne doit jamais pouvoir passer pour un flag git');

    const traversee = await app.api('POST', '/api/tasks', { prompt: 'p', targets: [{ repo_id: repoId, branch: 'a/../../b' }] });
    assert.equal(traversee.status, 400);

    const doublon = await app.api('POST', '/api/tasks', {
      prompt: 'p', targets: [{ repo_id: repoId, branch: 'a' }, { repo_id: repoId, branch: 'b' }],
    });
    assert.equal(doublon.status, 400, 'un même projet ne peut pas être sélectionné deux fois');

    const inconnu = await app.api('POST', '/api/tasks', { prompt: 'p', targets: [{ repo_id: 99999, branch: 'a' }] });
    assert.equal(inconnu.status, 400);
  });

  test('cycle complet d’une session de codage sur deux projets', async () => {
    const creation = await app.api('POST', '/api/tasks', {
      kind: 'code',
      prompt: 'Ajoute une fonction de total',
      commit_message: 'feat: total',
      images: [PNG],
      targets: [{ repo_id: repoId, branch: 'feat/total' }, { repo_id: repo2Id, branch: 'feat/total' }],
    });
    assert.equal(creation.status, 200);
    const taskId = creation.body.id;
    assert.equal(creation.body.targets.length, 2);
    assert.equal(creation.body.status, 'new');

    const detail = await app.api('GET', `/api/tasks/${taskId}`);
    assert.equal(detail.body.images.length, 1);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}/image/0`)).status, 200);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}/image/9`)).status, 404);

    // Exécution : l'agent est en dry-run, le commit et le diff sont bien réels.
    await app.api('POST', `/api/tasks/${taskId}/run`);
    await waitForJobs(app.api);

    const apres = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(apres.status, 'committed');
    assert.ok(apres.targets.every((t) => t.status === 'committed' && t.commit_sha));
    assert.equal(apres.targets[0].push_command, 'git push -u origin feat/total');

    const diff = await app.api('GET', `/api/tasks/${taskId}/targets/${apres.targets[0].id}/diff`);
    assert.match(diff.body.diff, /PROJ_TASK_DRYRUN\.md/);
    assert.equal(diff.body.project, 'grp/app');
    assert.equal((await app.api('GET', `/api/tasks/${taskId}/targets/99999/diff`)).status, 400);

    /* « Voir le diff » : le viewer plein écran d'un projet de session est alimenté par
       LES MÊMES routes que celui d'une MR (`/diffview`, `/file`, `/filediff`), donc les
       tester ici garantit que la factorisation côté serveur reste valable. */
    const tgId = apres.targets[0].id;
    const dv = await app.api('GET', `/api/tasks/${taskId}/targets/${tgId}/diffview`);
    assert.equal(dv.status, 200);
    assert.equal(dv.body.project, 'grp/app');
    assert.equal(dv.body.branch, 'feat/total');
    assert.match(dv.body.diff, /PROJ_TASK_DRYRUN\.md/);
    assert.ok(dv.body.stats.files >= 1 && dv.body.stats.added > 0, 'compteurs du diff');
    const changed = dv.body.files.filter((f) => f.changed).map((f) => f.path);
    assert.ok(changed.includes('PROJ_TASK_DRYRUN.md'), 'le fichier modifié est marqué dans l’arbre');
    assert.ok(dv.body.files.some((f) => f.path === 'src/app.js' && !f.changed), 'l’arbre porte AUSSI les fichiers non modifiés');

    // Contenu entier d'un fichier non modifié (panneau de droite du viewer).
    const file = await app.api('GET', `/api/tasks/${taskId}/targets/${tgId}/file?path=src/app.js`);
    assert.equal(file.status, 200);
    assert.match(file.body.content, /module\.exports/);

    // Diff à contexte complet d'un fichier modifié.
    const fd = await app.api('GET', `/api/tasks/${taskId}/targets/${tgId}/filediff?path=PROJ_TASK_DRYRUN.md`);
    assert.equal(fd.status, 200);
    assert.match(fd.body.diff, /PROJ_TASK_DRYRUN\.md/);

    // Garde-fou : un chemin hors de l'arborescence est refusé (anti-traversal).
    assert.equal((await app.api('GET', `/api/tasks/${taskId}/targets/${tgId}/file?path=../../etc/passwd`)).status, 400);
    assert.equal((await app.api('GET', `/api/tasks/${taskId}/targets/99999/diffview`)).status, 400);

    // Itération : une 2e passe sur la même branche.
    assert.equal((await app.api('POST', `/api/tasks/${taskId}/followup`, { instruction: ' ' })).status, 400);
    await app.api('POST', `/api/tasks/${taskId}/followup`, { instruction: 'Ajoute aussi la TVA' });
    await waitForJobs(app.api);
    const t2 = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.notEqual(t2.targets[0].commit_sha, apres.targets[0].commit_sha, 'la reprise produit un nouveau commit');

    /* HISTORIQUE DES ITÉRATIONS : chaque passe conserve le prompt envoyé ET le retour de
       l'IA. Sans ça, relire une réponse plusieurs itérations plus tard ne dit pas à quoi
       elle répondait, et seul le dernier retour survivait. */
    const hist = await app.api('GET', `/api/tasks/${taskId}/targets/${t2.targets[0].id}/passes`);
    assert.equal(hist.status, 200);
    assert.equal(hist.body.passes.length, 2, 'le run initial ET la correction sont conservés');
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run', 'followup']);
    assert.equal(hist.body.current.n, 2, 'la dernière itération est affichée par défaut');
    assert.match(hist.body.current.prompt, /Ajoute aussi la TVA/, 'le prompt de suivi est conservé');

    // La 1re passe reste lisible, avec SON prompt (celui de la session).
    const p1 = await app.api('GET', `/api/tasks/${taskId}/targets/${t2.targets[0].id}/passes?n=1`);
    assert.equal(p1.body.current.n, 1);
    assert.match(p1.body.current.prompt, /Ajoute une fonction de total/);
    assert.ok(!/TVA/.test(p1.body.current.prompt), 'chaque passe garde SON prompt');

    /* Régression : une session ANTÉRIEURE à l'historique n'a aucune ligne `agent_pass`,
       seulement son `output_path`. « Retour de l'IA » doit continuer de l'afficher. */
    const tgOld = t2.targets[0].id;
    app.db.prepare('DELETE FROM agent_pass WHERE scope = ? AND task_id = ?').run('task', taskId);
    const legacy = await app.api('GET', `/api/tasks/${taskId}/targets/${tgOld}/passes`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.passes.length, 1, 'le retour historique est présenté comme une passe');
    assert.equal(legacy.body.current.kind, 'legacy');
    assert.ok(legacy.body.current.output, 'le retour reste lisible');

    // Push : la branche existe ensuite réellement dans le dépôt distant.
    const target = t2.targets[0];
    await app.api('POST', `/api/tasks/${taskId}/targets/${target.id}/push`);
    await waitForJobs(app.api);
    const t3 = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(t3.targets[0].status, 'pushed');
    assert.match(git(repo.bare, ['branch', '--list', 'feat/total']), /feat\/total/);

    // MR : créée via l'API GitLab, puis mergée.
    const avantPush = t3.targets[1];
    assert.equal((await app.api('POST', `/api/tasks/${taskId}/targets/${avantPush.id}/mr`)).status, 400,
      'on ne crée pas de MR sur une branche non poussée');

    const mr = await app.api('POST', `/api/tasks/${taskId}/targets/${target.id}/mr`, { title: 'Total TTC' });
    assert.equal(mr.status, 200);
    assert.ok(mr.body.iid);
    const doublon = await app.api('POST', `/api/tasks/${taskId}/targets/${target.id}/mr`);
    assert.equal(doublon.status, 400, 'une MR déjà ouverte n’est pas recréée');

    const merge = await app.api('POST', `/api/tasks/${taskId}/targets/${target.id}/merge`);
    assert.equal(merge.body.merged, true);
    const t4 = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(t4.targets[0].mr_merged, 1);

    const stats = await app.api('GET', '/api/stats');
    assert.equal(stats.body.tasks.mrCreated, 1);
    assert.equal(stats.body.tasks.mrMerged, 1);
  });

  test('modification et suppression d’une session', async () => {
    const { body: task } = await app.api('POST', '/api/tasks', {
      prompt: 'v1', targets: [{ repo_id: repoId, branch: 'feat/edit' }],
    });

    const maj = await app.api('PUT', `/api/tasks/${task.id}`, {
      prompt: 'v2', commit_message: 'chore: v2', auto_push: 1,
      targets: [{ repo_id: repoId, branch: 'feat/edit' }],
    });
    assert.equal(maj.body.prompt, 'v2');
    assert.equal(maj.body.auto_push, 1);
    assert.equal(maj.body.targets.length, 1);

    // Le toggle « L'IA peut me poser des questions » se persiste à l'édition (et se décoche).
    const on = await app.api('PUT', `/api/tasks/${task.id}`, { ask_questions: true });
    assert.equal(on.body.ask_questions, 1, 'coché → enregistré');
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).body.task.ask_questions, 1, 'toujours coché au rechargement');
    const off = await app.api('PUT', `/api/tasks/${task.id}`, { ask_questions: false });
    assert.equal(off.body.ask_questions, 0, 'décoché → enregistré');
    assert.equal(maj.body.targets[0].id, task.targets[0].id, 'une composition inchangée préserve l’état d’exécution');

    const recompose = await app.api('PUT', `/api/tasks/${task.id}`, {
      targets: [{ repo_id: repoId, branch: 'feat/edit' }, { repo_id: repo2Id, branch: 'feat/edit' }],
    });
    assert.equal(recompose.body.targets.length, 2);

    assert.equal((await app.api('PUT', '/api/tasks/99999', {})).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/99999/run')).status, 400);

    const images = await app.api('PUT', `/api/tasks/${task.id}`, { images: [PNG, PNG] });
    assert.equal(images.status, 200);
    const detail = await app.api('GET', `/api/tasks/${task.id}`);
    assert.equal(detail.body.images.length, 2);
    const imgId = (await app.api('GET', `/api/tasks/${task.id}`)).body.images[0].id;
    assert.equal((await app.api('DELETE', `/api/tasks/${task.id}/image/${imgId}`)).body.ok, true);
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).body.images.length, 1);

    assert.equal((await app.api('DELETE', `/api/tasks/${task.id}`)).body.ok, true);
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).status, 400);
    assert.ok(!fs.existsSync(path.join(app.dataDir, 'tasks', String(task.id))));
  });

  test('une session en échec consigne son erreur et l’efface à la demande', async () => {
    const { body: task } = await app.api('POST', '/api/tasks', {
      prompt: 'suivi impossible', targets: [{ repo_id: repoId, branch: 'jamais/creee' }],
    });
    // Un suivi sans exécution préalable : la branche n'existe nulle part.
    await app.api('POST', `/api/tasks/${task.id}/followup`, { instruction: 'continue' });
    await waitForJobs(app.api);

    const enErreur = (await app.api('GET', `/api/tasks/${task.id}`)).body.task;
    assert.equal(enErreur.status, 'error');
    assert.ok(enErreur.last_error);

    assert.equal((await app.api('POST', `/api/tasks/${task.id}/clear-error`)).body.ok, true);
    assert.equal((await app.api('GET', `/api/tasks/${task.id}`)).body.task.last_error, null);
  });

  test('exploration : lecture seule, réponse en Markdown', async () => {
    const { body: task } = await app.api('POST', '/api/tasks', {
      kind: 'explore',
      prompt: 'Comment fonctionne le module app ?',
      targets: [{ repo_id: repoId }],   // branche facultative en exploration
    });
    assert.equal(task.kind, 'explore');
    assert.ok(!task.branch, 'en exploration la branche est facultative');
    assert.equal(task.targets[0].branch, null);

    await app.api('POST', `/api/tasks/${task.id}/run`);
    await waitForJobs(app.api);

    const apres = (await app.api('GET', `/api/tasks/${task.id}`)).body.task;
    assert.equal(apres.status, 'done');

    const md = await app.api('GET', `/api/tasks/${task.id}/md`);
    assert.match(md.body.md, /Comment fonctionne le module app/);
    assert.equal(md.body.prompt, 'Comment fonctionne le module app ?');

    /* Question de suivi. Hors dry-run elle REPREND la session d'agent — l'IA se souvient de
       ce qu'elle a lu, pas seulement de ce qu'elle a écrit. En dry-run (le cas ici) aucune
       session n'est ouverte : la réponse précédente reste alors le seul fil de continuité,
       et c'est ce repli qu'on vérifie — il doit survivre au passage en session. */
    await app.api('POST', `/api/tasks/${task.id}/followup`, { instruction: 'Et les tests ?' });
    await waitForJobs(app.api);
    const md2 = await app.api('GET', `/api/tasks/${task.id}/md`);
    assert.match(md2.body.md, /Et les tests/);

    /* Les DEUX questions restent consultables : une question de suivi écrase le fichier
       de réponse, donc sans archivage la question initiale et sa réponse seraient perdues. */
    const hist = await app.api('GET', `/api/tasks/${task.id}/passes`);
    assert.equal(hist.body.passes.length, 2);
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run', 'followup']);
    assert.equal(hist.body.current.prompt, 'Et les tests ?', 'la dernière question est affichée');
    const q1 = await app.api('GET', `/api/tasks/${task.id}/passes?n=1`);
    assert.equal(q1.body.current.prompt, 'Comment fonctionne le module app ?');
    // La réponse archivée est le CORPS seul : la question est déjà portée par la passe,
    // inutile de la dupliquer dans le texte.
    // (en dry-run le mock est déterministe : les deux réponses se ressemblent, ce qui
    // compte est que CHAQUE passe ait la sienne, archivée dans son propre fichier)
    assert.ok(q1.body.current.output && q1.body.current.output.length > 20, 'sa réponse est archivée');
    assert.ok(hist.body.passes.every((p) => p.has_output), 'les deux passes ont leur fichier');

    // Le dépôt exploré n'a subi aucune modification.
    const clone = path.join(app.dataDir, 'clones', 'grp__app');
    assert.equal(git(clone, ['status', '--porcelain']).trim(), '', 'exploration = lecture seule');
    assert.equal((await app.api('GET', '/api/tasks/99999/md')).status, 400);

    // En dry-run, aucune session n'est ouverte : les cibles restent sans handle.
    const cible = app.db.prepare('SELECT session_key FROM task_target WHERE task_id = ?').get(task.id);
    assert.equal(cible.session_key, null, 'le dry-run n’invente pas de session');
  });

  test('GET /api/tasks liste les sessions avec leurs projets', async () => {
    const { body } = await app.api('GET', '/api/tasks');
    assert.ok(body.length >= 2);
    assert.ok(body.every((t) => Array.isArray(t.targets)));
    assert.ok(body.some((t) => t.image_count > 0));
  });

  /* L'ordre de la liste répond à « qu'est-ce qui vient de finir ? ». C'est la date de fin
     d'EXÉCUTION qui décide, pas la dernière modification : corriger un prompt ou pousser une
     branche ne doit pas faire remonter une session en tête devant celle qui vient de tourner. */
  test('les sessions les plus récemment exécutées passent devant', async () => {
    const creer = async (nom) => (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: nom, targets: [{ repo_id: repoId, branch: `ai/${nom}` }],
    })).body.id;
    const a = await creer('tri-a');
    const b = await creer('tri-b');

    // On exécute A APRÈS B : c'est A qui doit être en tête, alors que B a l'id le plus grand.
    await app.api('POST', `/api/tasks/${b}/run`);
    await waitForJobs(app.api);
    await app.api('POST', `/api/tasks/${a}/run`);
    await waitForJobs(app.api);

    const rang = async () => (await app.api('GET', '/api/tasks')).body.map((t) => t.id);
    let ordre = await rang();
    assert.ok(ordre.indexOf(a) < ordre.indexOf(b), `dernier exécuté en tête (vu ${ordre.join(',')})`);

    /* Modifier B sans le relancer ne doit RIEN changer à l'ordre : `updated_at` bouge, pas
       `finished_at`. C'est toute la raison d'avoir une colonne séparée. */
    await app.api('PUT', `/api/tasks/${b}`, { prompt: 'tri-b corrigé' });
    ordre = await rang();
    assert.ok(ordre.indexOf(a) < ordre.indexOf(b), 'une simple modification ne remonte pas la session');

    // …mais la relancer, si.
    await app.api('POST', `/api/tasks/${b}/run`);
    await waitForJobs(app.api);
    ordre = await rang();
    assert.ok(ordre.indexOf(b) < ordre.indexOf(a), 'après relance, B repasse devant');

    // Une session jamais exécutée se range à sa date de création, pas en fin de liste.
    const neuve = await creer('tri-neuve');
    ordre = await rang();
    assert.ok(ordre.indexOf(neuve) < ordre.length - 1,
      'une session qu’on vient de créer ne doit pas tomber tout en bas');
  });

  /* Relancer un job arrêté. Ce qui compte n'est pas le bouton mais ce qu'il rejoue : la même
     action sur le même objet, et RIEN pour les opérations qui doivent repasser par leur
     aperçu. Un job qui est allé au bout n'est pas rejouable non plus — sinon « Relancer »
     deviendrait un second bouton « Lancer », au mauvais endroit. */
  test('relance d’un job : seulement ce qui s’est arrêté, et pas les opérations git', async () => {
    const t2 = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'ai/retry' }],
    })).body;
    await app.api('POST', `/api/tasks/${t2.id}/run`);
    await waitForJobs(app.api);

    const job = app.db.prepare("SELECT * FROM job WHERE kind = 'task' ORDER BY id DESC LIMIT 1").get();
    assert.ok(job.retry, 'l’intention du job est mémorisée');
    assert.deepEqual(JSON.parse(job.retry).taskId, t2.id);

    // Terminé (ou en erreur puis relancé) : on n'autorise la relance que sur stopped/error.
    app.db.prepare("UPDATE job SET status = 'done' WHERE id = ?").run(job.id);
    assert.equal((await app.api('POST', `/api/jobs/${job.id}/retry`)).status, 409, 'un job abouti ne se rejoue pas');

    app.db.prepare("UPDATE job SET status = 'stopped' WHERE id = ?").run(job.id);
    const relance = await app.api('POST', `/api/jobs/${job.id}/retry`);
    assert.equal(relance.status, 200);
    assert.equal(relance.body.job.kind, 'task');
    assert.notEqual(relance.body.job.id, job.id, 'la relance crée un NOUVEAU job, elle ne ressuscite pas l’ancien');
    await waitForJobs(app.api);

    // Une opération git n'est pas rejouable d'ici : elle doit repasser par son aperçu.
    const gitJob = app.db.prepare("INSERT INTO job (kind, status, retry) VALUES ('gitops', 'stopped', '{}')").run();
    assert.equal((await app.api('POST', `/api/jobs/${gitJob.lastInsertRowid}/retry`)).status, 409);
  });

  /* Le périmètre d'un job : ce qu'il va toucher. C'est cette déduction qui décide si deux
     jobs peuvent tourner ensemble ; une erreur ici ne fait pas planter, elle laisse deux
     process se disputer le même clone. On la vérifie donc sur de vraies sessions. */
  test('périmètre d’un job : les dépôts touchés sont bien déduits', async () => {
    const { jobKeys, keysClash } = require('../src/jobs');

    const deux = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'ai/k1' }, { repo_id: repo2Id, branch: 'ai/k1' }],
    })).body;
    const un = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repo2Id, branch: 'ai/k2' }],
    })).body;

    const kDeux = [...jobKeys({ kind: 'task', taskId: deux.id })];
    assert.deepEqual(kDeux.sort(), [`repo:${repoId}`, `repo:${repo2Id}`].sort());
    const kUn = [...jobKeys({ kind: 'task', taskId: un.id })];
    assert.deepEqual(kUn, [`repo:${repo2Id}`]);
    assert.equal(keysClash(kDeux, kUn), true, 'ils partagent un dépôt : jamais en parallèle');

    // Docker ne touche aucun dépôt ; une opération git déclare les siens.
    assert.deepEqual([...jobKeys({ kind: 'docker', payload: {} })], []);
    assert.deepEqual([...jobKeys({ kind: 'gitops', payload: { targets: [{ repo_id: repoId }] } })], [`repo:${repoId}`]);
    // Une RESTAURATION relit sa cible en base au moment du run : périmètre inconnu → refus.
    assert.deepEqual([...jobKeys({ kind: 'gitops', payload: { restoreOpId: 7 } })], ['*']);
  });

  /* Reprendre une session d'agent EXISTANTE au lieu d'en ouvrir une neuve. Le mécanisme
     n'ajoute rien aux exécutants : ils reprennent déjà une session dès qu'un handle est
     présent sur le projet. Tout tient donc à ce que la création range bien l'identifiant —
     c'est ce qui est vérifié ici, plus le refus de ce qui passerait pour un flag. */
  test('session existante fournie à la création : rangée sur chaque projet', async () => {
    const { backendName } = require('../src/agentsession');
    const id = backendName() === 'claude'
      ? '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
      : '/home/moi/.mergerie/agent-sessions/deja-la';

    const avec = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'continue ce que tu faisais', session_id: id,
      targets: [{ repo_id: repoId, branch: 'ai/reprise' }, { repo_id: repo2Id, branch: 'ai/reprise' }],
    });
    assert.equal(avec.status, 200);
    const cibles = app.db.prepare('SELECT session_key, session_backend, session_cwd FROM task_target WHERE task_id = ?').all(avec.body.id);
    assert.equal(cibles.length, 2);
    for (const c of cibles) {
      assert.equal(c.session_key, id, 'chaque projet part sur la session fournie');
      assert.equal(c.session_backend, backendName());
      assert.equal(c.session_cwd, null, 'cwd inconnu : le garde-fou « même cwd » ne doit pas bloquer');
    }

    // Sans le champ, rien ne change : la session est créée au premier run, comme avant.
    const sans = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'ai/neuve' }],
    });
    assert.equal(app.db.prepare('SELECT session_key FROM task_target WHERE task_id = ?').get(sans.body.id).session_key, null);

    // Un identifiant est passé tel quel à l'agent : il ne doit jamais pouvoir passer pour un flag.
    const flag = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', session_id: '--dangerously-skip-permissions',
      targets: [{ repo_id: repoId, branch: 'ai/x' }],
    });
    assert.equal(flag.status, 400);

    if (backendName() === 'claude') {
      const pasUuid = await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'p', session_id: 'pas-un-uuid',
        targets: [{ repo_id: repoId, branch: 'ai/y' }],
      });
      assert.equal(pasUuid.status, 400, 'claude attend un UUID : autant le dire avant de cloner');
    }

    // La session se change aussi APRÈS coup ; un champ vide, lui, n'efface pas ce qui existe.
    const autre = backendName() === 'claude' ? '11111111-2222-3333-4444-555555555555' : '/tmp/agent-sessions/autre';
    await app.api('PUT', `/api/tasks/${avec.body.id}`, { prompt: 'suite', session_id: autre });
    let keys = app.db.prepare('SELECT session_key FROM task_target WHERE task_id = ?').all(avec.body.id).map((x) => x.session_key);
    assert.deepEqual(keys, [autre, autre]);
    await app.api('PUT', `/api/tasks/${avec.body.id}`, { prompt: 'encore', session_id: '' });
    keys = app.db.prepare('SELECT session_key FROM task_target WHERE task_id = ?').all(avec.body.id).map((x) => x.session_key);
    assert.deepEqual(keys, [autre, autre], 'un champ vide ne perd pas la session');
  });

  /* Ranger une session la sort de la liste sans rien détruire : c'est le point qui distingue
     ce geste d'une suppression, donc celui qu'il faut vérifier. */
  test('ranger une session : elle reste entière et le drapeau fait l’aller-retour', async () => {
    const { body: avant } = await app.api('GET', '/api/tasks');
    const t = avant[0];
    assert.equal(t.hidden, 0, 'une session est visible par défaut');

    const range = await app.api('POST', `/api/tasks/${t.id}/hidden`, { hidden: true });
    assert.equal(range.status, 200);
    assert.equal(range.body.hidden, 1);

    const { body: apres } = await app.api('GET', '/api/tasks');
    const memeSession = apres.find((x) => x.id === t.id);
    assert.equal(memeSession.hidden, 1);
    assert.equal(memeSession.prompt, t.prompt, 'le rangement ne touche pas au contenu');
    assert.deepEqual(memeSession.targets.map((x) => x.id), t.targets.map((x) => x.id), 'ni aux projets');
    assert.equal(apres.length, avant.length, 'la session est toujours renvoyée : c’est le front qui filtre');

    const ressorti = await app.api('POST', `/api/tasks/${t.id}/hidden`, { hidden: false });
    assert.equal(ressorti.body.hidden, 0);
    assert.equal((await app.api('GET', '/api/tasks')).body.find((x) => x.id === t.id).hidden, 0);

    const inconnue = await app.api('POST', '/api/tasks/999999/hidden', { hidden: true });
    assert.equal(inconnue.status, 400, 'une session inexistante ne se range pas silencieusement');
  });

  // ask → stop → resume : l'IA pose des questions, la session passe en attente (la file se
  // libère), puis reprend après réponses. En dry-run l'agent « simule » un bloc QUESTIONS.
  test('l’IA pose une question : needs_input puis reprise après réponses', async () => {
    const creation = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un mécanisme de retry', ask_questions: true,
      targets: [{ repo_id: repoId, branch: 'feat/ask' }],
    });
    assert.equal(creation.status, 200);
    assert.equal(creation.body.ask_questions, 1, 'l’option est persistée');
    const taskId = creation.body.id;

    await app.api('POST', `/api/tasks/${taskId}/run`);
    await waitForJobs(app.api); // la file rend la main → elle n'est pas gelée

    let task = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(task.status, 'needs_input', 'la session est en attente, pas en erreur');
    const tg = task.targets[0];
    assert.equal(tg.status, 'needs_input');
    assert.equal(tg.questions.length, 2, 'les deux questions sont exposées');
    assert.ok(tg.questions[0].options && tg.questions[0].options.length, 'q1 : options (radio)');
    assert.equal(tg.questions[1].options, null, 'q2 : réponse libre');
    assert.ok(!tg.commit_sha, 'aucun commit tant que la question n’est pas répondue');

    // Réponses vides → refus explicite.
    assert.equal((await app.api('POST', `/api/tasks/${taskId}/targets/${tg.id}/answer`, { answers: {} })).status, 400);

    // Réponses valides → reprise de la session.
    const ans = await app.api('POST', `/api/tasks/${taskId}/targets/${tg.id}/answer`, {
      answers: { q1: 'decorator', q2: 'Oui, via une migration idempotente' },
    });
    assert.equal(ans.status, 200);
    await waitForJobs(app.api);

    task = (await app.api('GET', `/api/tasks/${taskId}`)).body.task;
    assert.equal(task.status, 'committed', 'après réponses, l’agent poursuit et commite');
    assert.equal(task.targets[0].status, 'committed');
    assert.ok(task.targets[0].commit_sha);
    assert.ok(!task.targets[0].questions, 'les questions sont soldées');

    // Répondre à un projet qui n'attend rien → refusé.
    assert.equal((await app.api('POST', `/api/tasks/${taskId}/targets/${task.targets[0].id}/answer`, { answers: { q1: 'x' } })).status, 400);
  });

  test('toggle désactivé : aucune question n’est posée', async () => {
    const c = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Tâche sans questions', ask_questions: false,
      targets: [{ repo_id: repoId, branch: 'feat/noask' }],
    });
    assert.equal(c.body.ask_questions, 0);
    await app.api('POST', `/api/tasks/${c.body.id}/run`);
    await waitForJobs(app.api);
    const task = (await app.api('GET', `/api/tasks/${c.body.id}`)).body.task;
    assert.equal(task.status, 'committed', 'sans le toggle, l’agent tranche seul et commite');

    // Retour de l'agent consultable en fin de session (comme la réponse d'une exploration).
    const tg = task.targets[0];
    assert.ok(tg.output_path, 'le retour de l’agent est référencé sur le projet');
    const out = (await app.api('GET', `/api/tasks/${c.body.id}/targets/${tg.id}/output`)).body;
    assert.ok(out.output && out.output.includes('dry-run'), 'le retour est lisible');
    assert.equal(out.project, 'grp/app');
  });
});
