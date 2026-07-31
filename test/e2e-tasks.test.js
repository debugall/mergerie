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
