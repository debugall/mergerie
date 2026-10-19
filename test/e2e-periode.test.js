'use strict';
/* LE RATTRAPAGE D'UNE PÉRIODE (Notes → Période), de bout en bout, sur un VRAI dépôt git.
 *
 * Quatre stratégies de merge posées dans un dépôt nu (merge commit, squash, fast-forward et
 * une MR relue par sa ref après suppression de branche), deux commits directs, un revert, un
 * bot — et un faux GitLab qui rend les merge requests de la fenêtre. Ce qu'on prouve :
 *   - les commits passés par une MR ne sont JAMAIS « directs », quelle que soit la stratégie ;
 *   - les pushs directs sont trouvés, regroupés, étiquetés (revert, bot) ;
 *   - la base est réparée au passage (MR écrite, session liée, todo cochée, journal daté) ;
 *   - « vu » survit au recalcul ;
 *   - une MR mergée dont la branche a disparu se relit par ses SHA, avec un diff NON vide ;
 *   - la présence se mesure sur un geste, et l'absence dépasse le seuil ; « Je pars » la pose à la minute ;
 *   - les pushs de la forge (GitLab `events`) regroupent EXACTEMENT ; un pipeline rouge sur `main` se dit ;
 *   - Jira (changements d'état, affectations), ce que Mergerie a fait seul, le résumé IA (dry-run) ;
 *   - ce que la synchro a fait ENTRER compte comme « fait par l'équipe », quelle que soit sa date.
 * Un seul `startApp()` ; rien de `src/` en tête de fichier. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, waitForJobs, attendreServeur, git, poserIdentiteGit } = require('./helpers/app');

const ISO = (d = Date.now()) => new Date(d).toISOString();
const JOUR = 86400e3;

describe('Notes → Période : rattrapage d’une fenêtre', () => {
  let app; let repoId; let bare; let work;
  const sha = {};        // les SHA du décor
  const mrIds = {};      // iid → id interne
  let periodeId;

  /* L'AUTEUR DU COMMIT EST CE QUE L'ÉCRAN AFFICHE : les variables `GIT_AUTHOR_*` du harnais
     priment sur `-c user.name`, on les pose donc nommément pour chaque commit du décor. */
  const commit = (dir, auteur, msg, date = null) => {
    const email = `${auteur.replace(/[^a-z]/gi, '')}@x.test`;
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: auteur, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: auteur, GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    });
    return git(dir, ['rev-parse', 'HEAD']).trim();
  };
  const ecrire = (dir, f, contenu) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), contenu); git(dir, ['add', '-A']); };

  before(async () => {
    app = await startApp();
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'remote-'));
    bare = path.join(dir, 'origin.git'); work = path.join(dir, 'work');
    fs.mkdirSync(bare, { recursive: true }); fs.mkdirSync(work, { recursive: true });
    git(bare, ['init', '--bare', '--initial-branch=main', '.']);
    git(work, ['init', '--initial-branch=main', '.']);
    poserIdentiteGit(work);
    git(work, ['remote', 'add', 'origin', bare]);
    ecrire(work, 'README.md', '# app\n');
    sha.c0 = commit(work, 'sofia', 'init', ISO(Date.now() - 30 * JOUR));   // avant la fenêtre

    // MR !1 — merge commit classique, branche supprimée ensuite (relue par sa ref).
    git(work, ['checkout', '-q', '-b', 'feat/a']);
    ecrire(work, 'src/a.js', 'module.exports = 1;\n');
    sha.a1 = commit(work, 'sofia', 'feat: a');
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '-q', '--no-ff', '-m', 'Merge branch feat/a', 'feat/a']);
    sha.M1 = git(work, ['rev-parse', 'HEAD']).trim();

    // MR !2 — squash.
    git(work, ['checkout', '-q', '-b', 'feat/b']);
    ecrire(work, 'src/b.js', 'module.exports = 2;\n');
    sha.b1 = commit(work, 'karim', 'feat: b');
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '-q', '--squash', 'feat/b']);
    sha.S1 = commit(work, 'karim', 'feat: b (squash)');

    // MR !3 — fast-forward : le commit arrive sur main sous son propre SHA.
    git(work, ['checkout', '-q', '-b', 'feat/c']);
    ecrire(work, 'src/c.js', 'module.exports = 3;\n');
    sha.c1 = commit(work, 'lina', 'feat: c');
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '-q', '--ff-only', 'feat/c']);

    // Deux commits DIRECTS de karim (un push), un revert de lina, un bot.
    ecrire(work, 'src/hotfix.js', 'module.exports = 4;\n');
    sha.d1 = commit(work, 'karim', 'hotfix: timeout on /health');
    ecrire(work, 'package.json', '{ "version": "2.3.1" }\n');
    sha.d2 = commit(work, 'karim', 'bump version 2.3.1');
    sha.r1 = commit(work, 'lina', 'Revert "feat: c"');
    sha.bot = commit(work, 'dependabot[bot]', 'chore(deps): bump lodash');

    git(work, ['push', '-q', 'origin', 'main', 'feat/b', 'feat/c']);
    // Les refs que GitLab conserve après le merge — et la branche de !1 supprimée.
    git(work, ['push', '-q', 'origin', `${sha.a1}:refs/merge-requests/1/head`, `${sha.b1}:refs/merge-requests/2/head`, `${sha.c1}:refs/merge-requests/3/head`]);
    git(work, ['branch', '-q', '-D', 'feat/a']);

    const il = (j) => ISO(Date.now() - j * JOUR);
    const mr = (iid, o) => ({
      iid, title: o.title, state: o.state, source_branch: o.src, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, author: { name: o.author },
      sha: o.head, created_at: o.created || il(5), updated_at: o.updated || ISO(), merged_at: o.merged || null, closed_at: o.closed || null,
      merge_commit_sha: o.merge || null, squash_commit_sha: o.squash || null,
      diff_refs: { base_sha: o.base, start_sha: o.base, head_sha: o.head },
    });
    app.state.mrs['grp/app'] = [
      // !1 est d'abord OUVERTE : la découverte la connaît, puis elle est mergée « pendant l'absence ».
      mr(1, { title: 'Ajout de a', state: 'opened', src: 'feat/a', author: 'sofia', head: sha.a1, base: sha.c0, created: il(6) }),
      mr(2, { title: 'Ajout de b', state: 'merged', src: 'feat/b', author: 'karim', head: sha.b1, base: sha.M1, squash: sha.S1, merged: il(2) }),
      mr(3, { title: 'Ajout de c', state: 'merged', src: 'feat/c', author: 'lina', head: sha.c1, base: sha.S1, merged: il(1) }),
      mr(4, { title: 'Nouvelle, encore ouverte', state: 'opened', src: 'feat/d', author: 'sofia', head: 'x4', base: sha.c0, created: il(1) }),
      mr(5, { title: 'Fermée sans merge', state: 'closed', src: 'feat/e', author: 'karim', head: 'x5', base: sha.c0, closed: il(1) }),
      // Mergée AVANT la fenêtre, mais touchée pendant : de l'activité, pas une mergée.
      mr(6, { title: 'Vieille', state: 'merged', src: 'feat/old', author: 'sofia', head: 'x6', base: sha.c0, merged: il(40), updated: il(2), created: il(45) }),
    ];
    app.state.protectedBranches['grp/app'] = ['main'];
    await app.configure({ review_explain: '0' });
    repoId = (await app.api('POST', '/api/repos', { url: bare, project: 'grp/app', branch_pattern: '' })).body.id;
    await app.api('POST', '/api/discover');
    mrIds[1] = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 1).id;
    // Une session a ouvert feat/a, une todo la suit : c'est ce que le rattrapage doit réparer.
    app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at) VALUES (?, 'code', 'p', 'feat/a', 'done', ?, ?)").run(repoId, ISO(), ISO());
    const taskId = app.db.prepare('SELECT MAX(id) id FROM task').get().id;
    app.db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, mr_merged, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(taskId, repoId, 'feat/a', 'main', 'done', ISO());
    await app.api('POST', '/api/todos', { title: 'suivre !1', link_kind: 'mr', link_ref: String(mrIds[1]) });
    // Puis !1 est mergée pendant l'absence — avec un merge commit.
    const m1 = app.state.mrs['grp/app'][0];
    Object.assign(m1, { state: 'merged', merged_at: il(3), merge_commit_sha: sha.M1, updated_at: ISO() });
  });
  after(async () => { if (app) await app.stop(); });

  test('construire une fenêtre lance un job, et le résultat classe MR et commits', async () => {
    const r = (await app.api('POST', '/api/periode', { depuis: ISO(Date.now() - 10 * JOUR).slice(0, 10), jusqua: ISO().slice(0, 10) })).body;
    assert.ok(r.periode && r.periode.id, 'une période est créée tout de suite');
    assert.equal(r.job.kind, 'periode');
    periodeId = r.periode.id;
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    assert.ok(p.built_at, 'la période est construite');
    assert.equal(p.job.status, 'done', p.job.message);
    const par = (k) => p.items.filter((it) => it.kind === k);
    assert.deepEqual(par('mr_merged').map((it) => Number(it.ref)).sort(), [1, 2, 3]);
    assert.deepEqual(par('mr_new').map((it) => Number(it.ref)), [4]);
    assert.deepEqual(par('mr_closed').map((it) => Number(it.ref)), [5]);
    assert.deepEqual(par('mr_active').map((it) => Number(it.ref)), [6], 'mergée avant la fenêtre : de l’activité, pas une mergée');
    // Les pushs directs : karim (2 commits), lina (revert), le bot — et RIEN d'une merge request.
    const pushs = par('push');
    const parAuteur = Object.fromEntries(pushs.map((it) => [it.author, it]));
    assert.deepEqual(Object.keys(parAuteur).sort(), ['dependabot[bot]', 'karim', 'lina']);
    assert.deepEqual(parAuteur.karim.extra.commits.map((c) => c.sha), [sha.d1, sha.d2], 'deux commits consécutifs du même auteur = un push');
    assert.equal(parAuteur.lina.extra.revert, true);
    assert.equal(parAuteur['dependabot[bot]'].extra.bot, true);
    const tousLesSha = pushs.flatMap((it) => it.extra.commits.map((c) => c.sha));
    for (const s of [sha.M1, sha.S1, sha.c1, sha.a1, sha.b1]) assert.ok(!tousLesSha.includes(s), `${s.slice(0, 8)} est passé par une MR : jamais direct`);
    assert.equal(parAuteur.karim.extra.stat.files, 2, 'le diffstat du push');
    assert.equal(parAuteur.karim.extra.non_verifie, false, 'la forge a répondu (liste vide) : vérifié');
    // La branche de !1 a disparu : relevée.
    assert.deepEqual(par('branch_gone').map((it) => it.ref), ['feat/a']);
    assert.equal(p.unseen, p.items.length);
  });

  test('la base est réparée au passage : MR écrites, session liée, todo cochée, journal daté au merge', async () => {
    const mrs = (await app.api('GET', '/api/mrs')).body;
    const m1 = mrs.find((m) => m.iid === 1);
    assert.equal(m1.closed_seen, 1);
    assert.ok(m1.merged_at, 'la date de merge vient de la forge');
    assert.equal(m1.merge_commit_sha, sha.M1);
    assert.equal(m1.base_sha, sha.c0);
    assert.equal(m1.head_sha, sha.a1);
    const m2 = mrs.find((m) => m.iid === 2);
    assert.ok(m2, 'une MR jamais vue ouverte est écrite quand même');
    assert.equal(m2.squash_commit_sha, sha.S1);
    assert.equal(m2.title, 'Ajout de b');
    const tt = app.db.prepare('SELECT mr_merged, mr_iid FROM task_target WHERE repo_id = ? AND branch = ?').get(repoId, 'feat/a');
    assert.equal(tt.mr_merged, 1); assert.equal(tt.mr_iid, 1);
    const todo = app.db.prepare("SELECT status, note FROM todo WHERE link_kind = 'mr' AND link_ref = ?").get(String(m1.id));
    assert.equal(todo.status, 'done'); assert.match(todo.note, /!1/);
    const feed = app.db.prepare("SELECT at FROM feed WHERE type = 'mr_merged' AND mr_iid = 1").get();
    assert.equal(feed.at, m1.merged_at, 'le journal est daté au merge, pas au retour');
  });

  test('« vu » survit au recalcul', async () => {
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const push = p.items.find((it) => it.kind === 'push' && it.author === 'karim');
    const r = (await app.api('POST', `/api/periode/${periodeId}/seen`, { item_ids: [push.id] })).body;
    assert.equal(r.unseen, p.items.length - 1);
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p2 = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const push2 = p2.items.find((it) => it.kind === 'push' && it.author === 'karim');
    assert.ok(push2.seen_at, 'retrouvé par (kind, dépôt, ref) : toujours vu');
    assert.equal(p2.unseen, p2.items.length - 1);
    const liste = (await app.api('GET', '/api/periode')).body.periodes;
    assert.equal(liste[0].id, periodeId); assert.equal(liste[0].unseen, p2.items.length - 1);
  });

  test('le diff d’un push direct se lit par ses deux SHA', async () => {
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const push = p.items.find((it) => it.kind === 'push' && it.author === 'karim');
    const d = (await app.api('GET', `/api/periode/${periodeId}/items/${push.id}/diff`)).body;
    assert.match(d.diff, /src\/hotfix\.js/);
    assert.match(d.diff, /package\.json/);
    assert.equal(d.branch, 'main');
  });

  test('une MR mergée dont la branche a disparu se relit par ses SHA : diff NON vide, SHA relu = sa tête', async () => {
    assert.equal((await app.api('GET', `/api/mrs/${mrIds[1]}/diff`)).body.diff.includes('src/a.js'), true, 'le viewer aussi, avant toute review');
    await app.api('POST', `/api/mrs/${mrIds[1]}/review`);
    await waitForJobs(app.api);
    const d = (await app.api('GET', `/api/mrs/${mrIds[1]}`)).body;
    assert.equal(d.mr.status, 'reviewed', d.mr.last_error || '');
    assert.equal(d.mr.reviewed_sha, sha.a1);
    const diff = (await app.api('GET', `/api/mrs/${mrIds[1]}/diff`)).body.diff;
    assert.match(diff, /src\/a\.js/, 'le diff relu est celui de la MR, pas un trois-points vide');
    assert.doesNotMatch(diff, /src\/b\.js/, 'et rien de ce qui est arrivé après sur main');
    // Rien n'est parti sur la forge tout seul.
    assert.ok(!app.state.calls.some((c) => c.method === 'POST' && /merge_requests\/1\/notes/.test(c.path)), 'pas de note postée sur une MR mergée');
  });

  test('la présence se mesure sur un geste, et l’absence au-delà du seuil allume la bannière', async () => {
    const a0 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a0.banner, false, 'jamais de bannière sans dernier passage connu');
    assert.equal(a0.threshold, 3);
    const r = (await app.api('POST', '/api/presence')).body;
    assert.ok(r.last_seen);
    const a1 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a1.days, 0); assert.equal(a1.banner, false);
    app.db.prepare("UPDATE local_state SET value = ? WHERE kind = 'absence' AND ref = 'poste' AND key = 'last_seen'").run(ISO(Date.now() - 12 * JOUR));
    const a2 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a2.days, 12); assert.equal(a2.banner, true);
    assert.equal(a2.last_periode.id, periodeId);
    /* LE PREMIER GESTE DU RETOUR NE FAIT PAS TOMBER LA BANNIÈRE : l'absence est figée (début,
       retour) jusqu'à ce qu'elle soit écartée ou que la période soit ouverte. */
    await app.api('POST', '/api/presence');
    const a3 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a3.banner, true, 'figée au premier geste du retour');
    assert.equal(a3.days, 12); assert.equal(a3.frozen, true);
    assert.equal(a3.last_seen.slice(0, 10), ISO(Date.now() - 12 * JOUR).slice(0, 10), 'la fenêtre proposée part du départ');
    await app.api('POST', '/api/periode/absence/dismiss');
    assert.equal((await app.api('GET', '/api/periode/absence')).body.banner, false, 'écartée');
    // Le seuil se règle : à 0, jamais.
    await app.api('PUT', '/api/config', { periode_banner_days: 0 });
    assert.equal((await app.api('GET', '/api/periode/absence')).body.banner, false);
    assert.equal((await app.api('GET', '/api/config')).body.periode_banner_days, 0);
    await app.api('PUT', '/api/config', { periode_banner_days: 3 });
  });

  test('base partagée : la review d’un collègue se note sur la MR mergée, celle d’une MR ouverte fait une ligne « équipe », et la carte dit « nouveau pour toi »', async () => {
    // Un dépôt de données local suffit à dire « partagé » ; l'auteur d'un fichier est ce que git en sait (`local_state`).
    const partage = path.join(app.dataDir, 'equipe.git');
    git(path.dirname(partage), ['init', '-q', '--bare', '--initial-branch=main', partage]);
    await app.api('PUT', '/api/config', { data_repo_url: partage });
    // eslint-disable-next-line global-require
    const store = require('../src/data/store');
    // eslint-disable-next-line global-require
    const { etat } = require('../src/data/localstate');
    const mrs = (await app.api('GET', '/api/mrs')).body;
    const m2 = mrs.find((m) => m.iid === 2); const m4 = mrs.find((m) => m.iid === 4);
    const ins = app.db.prepare(`INSERT INTO review_version (mr_id, version, md_path, note_value, reviewed_sha, kind, created_at, uid)
      VALUES (?, 1, '/dev/null', ?, ?, 'review', ?, ?)`);
    ins.run(m2.id, 0.7, sha.b1, ISO(Date.now() - 2 * JOUR), 'rv-claire-2');
    ins.run(m4.id, 0.4, 'x4', ISO(Date.now() - 1 * JOUR), 'rv-claire-4');
    for (const uid of ['rv-claire-2', 'rv-claire-4']) {
      const row = app.db.prepare('SELECT * FROM review_version WHERE uid = ?').get(uid);
      const chemin = store.cheminSur('review_version', row);
      assert.ok(chemin, 'le fichier de la version a un chemin');
      etat.ecrire('author', chemin, 'name', 'claire');
    }
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const mergee2 = p.items.find((it) => it.kind === 'mr_merged' && Number(it.ref) === 2);
    assert.equal(mergee2.extra.team_review.author, 'claire', 'la review du collègue se note SUR la ligne de la MR mergée');
    assert.equal(mergee2.extra.team_review.note, 0.7);
    const equipe = p.items.filter((it) => it.kind === 'team');
    assert.deepEqual(equipe.map((it) => [it.extra.objet, it.extra.iid, it.author]), [['review', 4, 'claire']], 'une seule ligne « équipe » : la mergée a déjà sa carte');
    assert.equal(equipe[0].extra.a_bouge, false);
    /* CE QUE LA SYNCHRO A FAIT ENTRER COMPTE, quelle que soit la date écrite par le collègue : une
       review de claire datée d'il y a quarante jours, mais hydratée aujourd'hui (journal
       `local_state('data', 'hydrated:<sha>')`), fait une ligne « équipe » marquée « arrivée ». */
    const m6 = mrs.find((m) => m.iid === 6);
    ins.run(m6.id, 0.9, 'x6', ISO(Date.now() - 40 * JOUR), 'rv-claire-6-vieille');
    const vieille = app.db.prepare('SELECT * FROM review_version WHERE uid = ?').get('rv-claire-6-vieille');
    const fichiers = store.fichiersDe('review_version', vieille, store.contexte());
    for (const f of fichiers) store.ecrireFichier(f.chemin, f.contenu);
    etat.ecrire('author', store.cheminSur('review_version', vieille), 'name', 'claire');
    etat.ecrire('data', 'hydrated:deadbeef', 'files', JSON.stringify(fichiers.map((f) => f.chemin)));
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p2 = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const arrivee = p2.items.find((it) => it.kind === 'team' && it.extra.iid === 6);
    assert.ok(arrivee, 'la review hydratée est là malgré sa date hors fenêtre');
    assert.ok(arrivee.extra.arrive, 'et dit qu’elle est ARRIVÉE par la synchro');
    assert.equal(arrivee.author, 'claire');
    assert.equal(p2.items.filter((it) => it.kind === 'team' && it.extra.iid === 4).length, 1, 'la review datée dans la fenêtre n’est pas doublée');
    // La pastille « nouveau pour toi », et sa chute à l'ouverture du rapport.
    const avant = (await app.api('GET', '/api/mrs')).body;
    assert.equal(avant.find((m) => m.iid === 4).new_for_me, true);
    assert.equal(avant.find((m) => m.iid === 3).new_for_me, false, 'une MR sans review de collègue');
    await app.api('POST', `/api/mrs/${m4.id}/seen`);
    assert.equal((await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 4).new_for_me, false);
    await app.api('PUT', '/api/config', { data_repo_url: '' });
  });

  test('GitHub, même contrat : une pull request mergée n’est jamais un push direct, un commit hors PR l’est', async () => {
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'gh-'));
    const bare2 = path.join(dir, 'origin.git'); const work2 = path.join(dir, 'work');
    fs.mkdirSync(bare2, { recursive: true }); fs.mkdirSync(work2, { recursive: true });
    git(bare2, ['init', '--bare', '--initial-branch=main', '.']);
    git(work2, ['init', '--initial-branch=main', '.']);
    poserIdentiteGit(work2);
    git(work2, ['remote', 'add', 'origin', bare2]);
    ecrire(work2, 'README.md', '# web\n');
    const c0 = commit(work2, 'bob', 'init', ISO(Date.now() - 30 * JOUR));
    git(work2, ['checkout', '-q', '-b', 'feat/g']);
    ecrire(work2, 'src/g.js', 'export const g = 1;\n');
    const g1 = commit(work2, 'bob', 'feat: g');
    git(work2, ['checkout', '-q', 'main']);
    git(work2, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'feat/g']);
    const Mg = git(work2, ['rev-parse', 'HEAD']).trim();
    ecrire(work2, 'src/direct.js', 'export const d = 1;\n');
    const h1 = commit(work2, 'eve', 'direct: quick fix');
    git(work2, ['push', '-q', 'origin', 'main', `${g1}:refs/pull/7/head`]);
    const PROJECT = 'acme/web';
    app.ghState.repos = [{ id: 1, full_name: PROJECT, clone_url: bare2, ssh_url: bare2, default_branch: 'main' }];
    app.ghState.pulls[PROJECT] = [{
      number: 7, title: 'Ajout de g', state: 'closed', merged: true, merged_at: ISO(Date.now() - 2 * JOUR),
      created_at: ISO(Date.now() - 5 * JOUR), updated_at: ISO(), merge_commit_sha: Mg,
      head: { ref: 'feat/g', sha: g1, repo: { full_name: PROJECT } }, base: { ref: 'main', sha: c0, repo: { full_name: PROJECT } },
      html_url: `https://github.test/${PROJECT}/pull/7`, user: { login: 'bob' },
    }];
    // Le pipeline de `main` : GitHub n'a de CI que par SHA — la branche se résout, puis ses check-runs.
    app.ghState.branches[PROJECT] = [{ name: 'main', protected: false, commit: { sha: h1, commit: {} } }];
    app.ghState.checkRuns[h1] = [{ status: 'completed', conclusion: 'failure', html_url: 'https://github.test/acme/web/runs/9' }];
    await app.configureGithub();
    const ghRepoId = (await app.api('POST', '/api/repos', { url: bare2, project: PROJECT, forge: 'github', branch_pattern: '' })).body.id;
    const r = (await app.api('POST', '/api/periode', { depuis: ISO(Date.now() - 10 * JOUR).slice(0, 10), jusqua: ISO().slice(0, 10), repo_ids: [ghRepoId] })).body;
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${r.periode.id}`)).body;
    assert.equal(p.job.status, 'done', p.job.message);
    assert.deepEqual(p.items.filter((it) => it.kind === 'mr_merged').map((it) => Number(it.ref)), [7]);
    const pushs = p.items.filter((it) => it.kind === 'push');
    assert.deepEqual(pushs.map((it) => [it.author, it.extra.commits.map((c) => c.sha)]), [['eve', [h1]]]);
    const m7 = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7 && m.project === PROJECT);
    assert.equal(m7.merge_commit_sha, Mg); assert.equal(m7.head_sha, g1); assert.equal(m7.base_sha, c0);
    assert.equal(m7.closed_seen, 1);
    const pl = p.items.find((it) => it.kind === 'pipeline');
    assert.ok(pl, 'le pipeline rouge de main est relevé');
    assert.equal(pl.ref, 'main'); assert.equal(pl.extra.state, 'failed'); assert.equal(pl.extra.sha, h1);
    assert.match(pl.extra.url, /runs\/9/);
    assert.ok(!pushs.some((it) => it.extra.exact), 'GitHub n’expose pas les pushs : regroupement heuristique');
    await app.api('DELETE', `/api/repos/${ghRepoId}`);
  });

  test('deux dates sont exigées, dans l’ordre ; une période se supprime', async () => {
    assert.equal((await app.api('POST', '/api/periode', { depuis: '2026-10-17', jusqua: '2026-10-03' })).status, 400);
    assert.equal((await app.api('POST', '/api/periode', { depuis: 'x' })).status, 400);
    const r = (await app.api('POST', '/api/periode', { depuis: '2020-01-01', jusqua: '2020-01-02', repo_ids: [repoId] })).body;
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${r.periode.id}`)).body;
    assert.equal(p.items.length, 0, 'rien en 2020');
    assert.equal((await app.api('DELETE', `/api/periode/${r.periode.id}`)).body.ok, true);
    assert.equal((await app.api('GET', `/api/periode/${r.periode.id}`)).status, 400);
  });

  test('les pushs vus par GitLab regroupent EXACTEMENT : deux pushs consécutifs du même auteur font deux lignes', async () => {
    const il = (j) => ISO(Date.now() - j * JOUR);
    const push = (from, to, j) => ({ action_name: 'pushed', created_at: il(j), author: { name: 'karim' }, push_data: { ref: 'main', ref_type: 'branch', action: 'pushed', commit_from: from, commit_to: to, commit_count: 1 } });
    app.state.events['grp/app'] = [push(sha.d1, sha.d2, 1), push(sha.c1, sha.d1, 1.1), { action_name: 'pushed', created_at: il(1), author: { name: 'x' }, push_data: { ref: 'feat/z', ref_type: 'branch', commit_from: sha.c0, commit_to: sha.d2 } }];
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const karim = p.items.filter((it) => it.kind === 'push' && it.author === 'karim');
    assert.deepEqual(karim.map((it) => it.extra.commits.map((c) => c.sha)).sort(), [[sha.d1], [sha.d2]].sort(), 'un push par événement, plus de regroupement à 30 minutes');
    assert.ok(karim.every((it) => it.extra.exact), 'marqués exacts');
    const lina = p.items.find((it) => it.kind === 'push' && it.author === 'lina');
    assert.equal(lina.extra.exact, false, 'un commit hors événement garde l’heuristique');
    app.state.events['grp/app'] = [];
  });

  test('un pipeline rouge sur une branche surveillée est relevé ; vert, rien', async () => {
    app.state.refPipelines['grp/app'] = { main: [{ id: 77, status: 'failed', web_url: 'https://gitlab.test/grp/app/-/pipelines/77', sha: sha.bot, updated_at: ISO() }] };
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    let p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const pl = p.items.filter((it) => it.kind === 'pipeline');
    assert.deepEqual(pl.map((it) => [it.ref, it.extra.state, it.title]), [['main', 'failed', '#77']]);
    app.state.refPipelines['grp/app'] = { main: [{ id: 78, status: 'success', web_url: '', sha: sha.bot }] };
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    assert.equal(p.items.filter((it) => it.kind === 'pipeline').length, 0);
  });

  test('Jira : les tickets qui ont changé d’état ou m’ont été affectés pendant — les miens, les surveillés, ceux des MR', async () => {
    const il = (j) => ISO(Date.now() - j * JOUR);
    const moi = { accountId: 'me-test', displayName: 'Moi' };
    const autre = { accountId: 'u-claire', displayName: 'Claire' };
    const statut = (name, cat) => ({ name, statusCategory: { key: cat } });
    const ticket = (key, summary, assignee, status, j) => ({ key, fields: { summary, status, assignee, updated: il(j), issuetype: { name: 'Story' }, project: { key: 'PROJ' } } });
    app.state.jiraIssues['PROJ-7'] = ticket('PROJ-7', 'Export comptable', moi, statut('Done', 'done'), 2);
    app.state.jiraStatusChanged['PROJ-7'] = il(2);
    app.state.jiraIssues['PROJ-8'] = ticket('PROJ-8', 'Nouveau pour moi', moi, statut('À faire', 'new'), 1);
    app.state.jiraAssignedAt['PROJ-8'] = il(1);
    app.state.jiraIssues['PROJ-9'] = ticket('PROJ-9', 'Surveillé', autre, statut('En cours', 'indeterminate'), 3);
    app.state.jiraStatusChanged['PROJ-9'] = il(3);
    app.state.jiraIssues['PROJ-10'] = ticket('PROJ-10', 'Vieux', moi, statut('Done', 'done'), 40);
    app.state.jiraStatusChanged['PROJ-10'] = il(40);
    app.state.jiraIssues['PROJ-11'] = ticket('PROJ-11', 'Pas à moi', autre, statut('Done', 'done'), 1);
    app.state.jiraStatusChanged['PROJ-11'] = il(1);
    app.state.jiraIssues['PROJ-12'] = ticket('PROJ-12', 'Celui de la MR fermée', autre, statut('Abandonné', 'done'), 1);
    app.state.jiraStatusChanged['PROJ-12'] = il(1);
    app.state.mrs['grp/app'][4].title = '[PROJ-12] Fermée sans merge';
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0', review_explain: '0' });
    await app.api('POST', '/api/jira/watch', { key: 'PROJ-9' });
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const jiraItems = p.items.filter((it) => it.kind === 'jira');
    assert.deepEqual(jiraItems.map((it) => it.ref).sort(), ['PROJ-12', 'PROJ-7', 'PROJ-8', 'PROJ-9'], 'ni le vieux, ni celui qui n’est ni à moi, ni surveillé, ni d’une MR');
    const t7 = jiraItems.find((it) => it.ref === 'PROJ-7');
    assert.equal(t7.extra.status_changed, true); assert.equal(t7.extra.done, true); assert.equal(t7.extra.status, 'Done');
    assert.match(t7.extra.url, /browse\/PROJ-7/);
    assert.equal(jiraItems.find((it) => it.ref === 'PROJ-8').extra.objet, 'assigned');
    assert.equal(p.partiel_jira, null);
    // Jira qui tombe : la section est partielle, le reste de la période passe.
    app.state.jiraFail = { status: 500, body: { errorMessages: ['boom'] } };
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p2 = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    app.state.jiraFail = null;
    assert.ok(p2.partiel_jira, 'la raison est affichée');
    assert.equal(p2.partiel, 1);
    assert.ok(p2.items.some((it) => it.kind === 'mr_merged'), 'les merge requests sont là quand même');
    await app.api('PUT', '/api/config', { jira_url: '' });
  });

  test('« Pendant ce temps, Mergerie a… » : les passes d’agents planifiés et les vérifications de la fenêtre', async () => {
    const il = (j) => ISO(Date.now() - j * JOUR);
    const agentId = app.db.prepare("INSERT INTO agent (name, description, kind, created_at, updated_at) VALUES ('veille', '', 'explore', ?, ?)").run(il(3), il(3)).lastInsertRowid;
    const run = app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, agent_id, agent_name, created_at, updated_at) VALUES (?, 'explore', 'p', '', ?, ?, 'veille', ?, ?)");
    run.run(repoId, 'done', agentId, il(2), il(2));
    run.run(repoId, 'error', agentId, il(1), il(1));
    run.run(repoId, 'done', agentId, il(40), il(40));     // hors fenêtre
    const verifId = app.db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at, started_at, finished_at)
      VALUES ('tests unitaires', 'done', 'verified_fail', '[]', ?, ?, ?)`).run(il(2), il(2), il(1.9)).lastInsertRowid;
    await app.api('POST', `/api/periode/${periodeId}/rebuild`);
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    const faits = p.items.filter((it) => it.kind === 'mergerie');
    const agent = faits.find((it) => it.extra.objet === 'agent');
    assert.ok(agent, 'une ligne par agent');
    assert.equal(agent.title, 'veille'); assert.equal(agent.extra.runs, 2); assert.equal(agent.extra.erreurs, 1);
    const verif = faits.find((it) => it.extra.objet === 'verification');
    assert.equal(verif.extra.verification_id, verifId); assert.equal(verif.extra.verdict, 'verified_fail'); assert.equal(verif.extra.rouge, true);
    assert.match(verif.title, /tests unitaires/);
  });

  test('« Je pars » pose le départ à la minute ; un geste ne le bouge pas ; le retour se fige au-delà du seuil', async () => {
    const d = (await app.api('POST', '/api/periode/depart')).body;
    assert.equal(d.explicit, true); assert.equal(d.days, 0); assert.equal(d.banner, false);
    const depart = d.depart;
    await app.api('POST', '/api/presence');
    const a1 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a1.depart, depart, 'un passage furtif au bureau ne décale pas le départ');
    assert.equal(a1.explicit, true); assert.equal(a1.frozen, false);
    // Douze jours plus tard : la bannière, depuis le départ exact — puis le premier geste fige le retour.
    const ilYa12 = ISO(Date.now() - 12 * JOUR);
    app.db.prepare("UPDATE local_state SET value = ? WHERE kind = 'absence' AND ref = 'poste' AND key IN ('depart', 'last_seen')").run(ilYa12);
    const a2 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a2.banner, true); assert.equal(a2.days, 12); assert.equal(a2.last_seen, ilYa12);
    await app.api('POST', '/api/presence');
    const a3 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a3.frozen, true); assert.equal(a3.banner, true); assert.equal(a3.days, 12); assert.equal(a3.depart, ilYa12);
    await app.api('POST', '/api/periode/absence/dismiss');
    const a4 = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a4.explicit, false); assert.equal(a4.banner, false);
  });

  test('le résumé IA est un job, sur demande : le texte arrive sur la période, daté', async () => {
    const r = (await app.api('POST', `/api/periode/${periodeId}/resume`)).body;
    assert.equal(r.job.kind, 'periode-resume');
    await waitForJobs(app.api);
    const p = (await app.api('GET', `/api/periode/${periodeId}`)).body;
    assert.equal(p.resume_job.status, 'done', p.resume_job.message);
    assert.ok(p.resume && p.resume.length > 20, 'un texte');
    assert.ok(p.resume_at);
    assert.ok(app.db.prepare("SELECT COUNT(*) n FROM usage WHERE owner_kind = 'periode' AND owner_id = ?").get(periodeId).n >= 1, 'l’appel est compté');
    // Une période pas encore construite ne se résume pas.
    const vide = (await app.api('POST', '/api/periode', { depuis: '2019-01-01', jusqua: '2019-01-02', repo_ids: [repoId] })).body;
    const refus = await app.api('POST', `/api/periode/${vide.periode.id}/resume`);
    await waitForJobs(app.api);
    assert.ok(refus.status === 400 || (await app.api('GET', `/api/periode/${vide.periode.id}`)).body.resume_job === null, 'refusée avant la construction, ou acceptée seulement une fois construite');
    await app.api('DELETE', `/api/periode/${vide.periode.id}`);
  });

  test('un dépôt dont la forge tombe est PARTIEL, pas absent — et les autres passent', async () => {
    app.state.fail['merge_requests'] = { status: 500, body: { message: 'boom' } };
    const r = (await app.api('POST', '/api/periode', { depuis: ISO(Date.now() - 10 * JOUR).slice(0, 10), jusqua: ISO().slice(0, 10) })).body;
    await waitForJobs(app.api);
    delete app.state.fail['merge_requests'];
    const p = (await app.api('GET', `/api/periode/${r.periode.id}`)).body;
    assert.equal(p.partiel, 1);
    const repo = p.repos.find((x) => x.id === repoId);
    assert.ok(repo.partiel && repo.partiel.raisons.some((x) => /forge/.test(x)), JSON.stringify(repo.partiel));
    assert.ok(p.items.some((it) => it.kind === 'push'), 'les commits du clone sont quand même là');
  });
});
