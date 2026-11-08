'use strict';
/* « Codage hors dépôt » AVEC une branche : le dossier de l'utilisateur reçoit la branche, le commit, le
   push, puis la merge request et la convergence quand Mergerie reconnaît son remote. Ce qui se vérifie
   ici est ce qui est VRAI d'un dépôt git à la fin — la branche courante du dossier, le commit, ce que
   le dépôt distant a reçu — pas ce que l'écran affiche. L'agent tourne en dry-run (il écrit un marqueur
   dans le dossier) ; git, lui, est le vrai. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, waitForJobs, makeRemoteRepo } = require('./helpers/app');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Codage hors dépôt : branche, commit, push, merge request, convergence', () => {
  let app; let connu; let inconnu;

  const creer = async (corps) => (await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports\nplus de détail', ...corps })).body;
  const lancer = async (id) => {
    await app.api('POST', `/api/local-tasks/${id}/run`);
    await waitForJobs(app.api);
    return (await app.api('GET', `/api/local-tasks/${id}`)).body.task;
  };
  const retourSurMain = (d) => git(d.work, ['checkout', 'main']);

  before(async () => {
    app = await startApp(); await app.configure();
    const racine = (n) => { const d = path.join(app.dataDir, n); fs.mkdirSync(d, { recursive: true }); return d; };
    connu = makeRemoteRepo(racine('connu'));       // son origin est un dépôt enregistré dans Mergerie
    inconnu = makeRemoteRepo(racine('inconnu'));   // son origin ne l'est pas
    await app.api('POST', '/api/repos', { project: 'grp/local-git', url: connu.bare });
    app.state.branches['grp/local-git'] = [{ name: 'main', default: true }];
  });
  after(async () => { await app.stop(); });

  test('une branche invalide est refusée avant que la session ne parte', async () => {
    const r = await app.api('POST', '/api/local-tasks', { prompt: 'x', dirs: [connu.work], branch: 'feature/a..b' });
    assert.equal(r.status, 400);
  });

  test('converger implique la MR, qui implique le push — décidé côté serveur, pas seulement à l’écran', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/implique', converge_after: true });
    assert.equal(lt.create_mr, 1);
    assert.equal(lt.auto_push, 1);
    // …et sans branche, rien de tout cela n'a de sens : les cases sont ramenées à zéro.
    const sans = await creer({ dirs: [connu.work], branch: '', converge_after: true, auto_push: true });
    assert.equal(sans.converge_after, 0);
    assert.equal(sans.auto_push, 0);
  });

  test('sans push : la branche est créée et commitée dans le dossier, rien ne part', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/local-seulement', commit_message: 'Range les imports' });
    const fin = await lancer(lt.id);
    assert.equal(fin.status, 'done');
    assert.equal(git(connu.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/local-seulement');
    assert.equal(git(connu.work, ['log', '-1', '--format=%s']), 'Range les imports');
    assert.equal(fin.dirs[0].git_status, 'committed');
    assert.equal(fin.dirs[0].base_branch, 'main', 'la branche de départ est retenue : c’est la cible de la MR');
    assert.throws(() => git(connu.bare, ['rev-parse', '--verify', 'refs/heads/feature/local-seulement']), 'rien n’est poussé');
    retourSurMain(connu);
  });

  test('avec auto-push : le dépôt distant reçoit la branche, sans merge request', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/poussee', auto_push: true });
    const fin = await lancer(lt.id);
    assert.equal(fin.dirs[0].git_status, 'pushed');
    assert.equal(git(connu.bare, ['rev-parse', 'refs/heads/feature/poussee']), git(connu.work, ['rev-parse', 'HEAD']));
    assert.equal(fin.dirs[0].mr_iid, null);
    // Le message par défaut est la première ligne du prompt, comme pour une session de codage.
    assert.equal(git(connu.work, ['log', '-1', '--format=%s']), 'Range les imports');
    retourSurMain(connu);
  });

  test('avec la MR : elle s’ouvre sur la forge du dépôt reconnu par son remote, vers la branche de départ', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/avec-mr', create_mr: true });
    const fin = await lancer(lt.id);
    const d = fin.dirs[0];
    assert.equal(d.git_status, 'pushed', 'la MR lit la forge : il a fallu pousser');
    assert.ok(d.mr_iid, 'la MR est ouverte');
    const mr = (app.state.mrs['grp/local-git'] || []).find((m) => m.source_branch === 'feature/avec-mr');
    assert.ok(mr, 'la forge a bien reçu la demande');
    assert.equal(mr.target_branch, 'main');
    assert.equal(d.mr_iid, mr.iid);
    assert.ok(app.db.prepare('SELECT 1 FROM mr WHERE iid = ?').get(mr.iid), 'et la MR est connue de Mergerie');
    retourSurMain(connu);
  });

  test('converger : la boucle tourne sur la MR ouverte', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/converge', converge_after: true });
    const fin = await lancer(lt.id);
    assert.ok(fin.dirs[0].mr_iid, 'la MR est ouverte avant de converger');
    const run = app.db.prepare(`SELECT c.status FROM convergence_run c JOIN mr ON mr.id = c.mr_id
      WHERE mr.iid = ?`).get(fin.dirs[0].mr_iid);
    assert.ok(run, 'une convergence a été lancée sur cette MR');
    retourSurMain(connu);
  });

  test('un remote que Mergerie ne connaît pas : la branche est poussée, la MR dit pourquoi elle manque', async () => {
    const lt = await creer({ dirs: [inconnu.work], branch: 'feature/orpheline', create_mr: true });
    const fin = await lancer(lt.id);
    const d = fin.dirs[0];
    assert.equal(fin.status, 'done', 'ce n’est pas un échec de la session');
    assert.equal(d.git_status, 'pushed');
    assert.equal(d.mr_iid, null);
    assert.equal(d.git_note, 'no-repo');
    assert.equal(git(inconnu.bare, ['rev-parse', 'refs/heads/feature/orpheline']), git(inconnu.work, ['rev-parse', 'HEAD']));
  });

  test('un dossier avec du travail non commité ne bloque pas : il reste en place, hors du commit de la session', async () => {
    retourSurMain(connu);
    const perso = path.join(connu.work, '.env');
    fs.writeFileSync(perso, 'SECRET=1\n');
    const lt = await creer({ dirs: [connu.work], branch: 'feature/sale', auto_push: true });
    const fin = await lancer(lt.id);
    assert.equal(fin.dirs[0].status, 'done');
    assert.equal(fin.dirs[0].git_status, 'pushed');
    assert.equal(git(connu.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/sale');
    const commites = git(connu.work, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(commites.length > 0, 'ce que l’agent a écrit est commité');
    assert.ok(!commites.includes('.env'), 'le fichier de l’utilisateur n’est pas avalé');
    assert.equal(fs.readFileSync(perso, 'utf8'), 'SECRET=1\n', 'et il est intact');
    fs.rmSync(perso);
    retourSurMain(connu);
  });

  test('un dossier qui n’est pas un dépôt git est refusé, sans y toucher', async () => {
    const nu = fs.mkdtempSync(path.join(app.dataDir, 'nu-'));
    const lt = await creer({ dirs: [nu], branch: 'feature/nu' });
    const fin = await lancer(lt.id);
    assert.equal(fin.dirs[0].status, 'error');
    assert.match(fin.dirs[0].last_error, /git/);
    assert.deepEqual(fs.readdirSync(nu), [], 'l’agent n’a même pas été lancé');
  });

  test('sans branche, rien ne change : l’agent écrit en place et aucun commit n’est fait', async () => {
    retourSurMain(connu);
    const avant = git(connu.work, ['rev-parse', 'HEAD']);
    const fin = await lancer((await creer({ dirs: [connu.work] })).id);
    assert.equal(fin.status, 'done');
    assert.equal(git(connu.work, ['rev-parse', 'HEAD']), avant);
    assert.equal(fin.dirs[0].git_status, null);
    git(connu.work, ['checkout', '--', '.']); git(connu.work, ['clean', '-fd']);
  });

  test('l’édition relit puis modifie les choix git', async () => {
    const lt = await creer({ dirs: [connu.work], branch: 'feature/edit', auto_push: true });
    const r = await app.api('PUT', `/api/local-tasks/${lt.id}`, { create_mr: true });
    assert.equal(r.body.create_mr, 1);
    assert.equal(r.body.branch, 'feature/edit', 'absent du corps : on garde');
    const vide = await app.api('PUT', `/api/local-tasks/${lt.id}`, { branch: '' });
    assert.equal(vide.body.branch, null);
    assert.equal(vide.body.create_mr, 0, 'plus de branche, plus de MR');
  });
});
