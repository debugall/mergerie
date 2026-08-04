'use strict';
/* Mode « in place » — garde-fous et restauration (plan_add_verify.md §6, §14).
 *
 * C'est le bloc le plus sensible de la fonctionnalité : Mergerie fait un checkout dans un
 * répertoire de travail de l'utilisateur. Tout est vérifié sur un VRAI dépôt, parce que
 * l'engagement porté ici — « on remet toujours comme on a trouvé » — ne se prouve pas
 * autrement.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

describe('Vérification objective — mode in place', () => {
  let app;
  let repoId;
  let mrId;
  let distant;
  let workdir;
  let bin;
  let headSha;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-bin-'));

    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-remote-'));
    git(distant, 'init', '-q', '-b', 'main');
    git(distant, 'config', 'user.email', 'test@example.com');
    git(distant, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    git(distant, 'checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tête\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'tête');
    headSha = git(distant, 'rev-parse', 'HEAD');
    git(distant, 'checkout', '-q', 'main');

    // Le répertoire de travail de l'utilisateur : un clone ordinaire, sur sa branche.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-wd-'));
    workdir = path.join(parent, 'app');
    execFileSync('git', ['clone', '-q', distant, workdir], { stdio: 'pipe' });
    git(workdir, 'config', 'user.email', 'test@example.com');
    git(workdir, 'config', 'user.name', 'Test');

    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'ip-clones-')) });
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    app.state.mrs['grp/app'] = [{
      iid: 9, title: 'Changement', state: 'opened',
      source_branch: 'feature/x', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/9',
      sha: headSha, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 9).id;
  });

  after(async () => { await app.stop(); });

  const script = (corps, nom) => {
    const p = path.join(bin, `${nom}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };
  const repond = (obj) => `cat >/dev/null\nprintf '%s\\n' '${JSON.stringify(obj)}'`;

  async function poserVerifier(nom, corps, opts = {}) {
    const r = await app.api('POST', '/api/verifiers', {
      name: nom, command: script(corps, nom), timeout_s: opts.timeout_s || 60, run_base: false,
      repos: [{ repo_id: repoId, mode: 'in_place', workdir: opts.workdir || workdir, checkout_allowed: true }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }

  async function attendre(id) {
    let detail = null;
    for (let i = 0; i < 300 && !detail; i++) {
      const { body } = await app.api('GET', `/api/verifications/${id}`);
      if (body.status === 'done' || body.status === 'error') detail = body;
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!detail) throw new Error('la vérification ne se termine pas');
    /* La vérification est close, mais le JOB qui la porte peut ne pas l'être encore — et
       c'est lui qui tient le verrou « une seule vérification à la fois ». Sans cette
       attente, le test suivant se ferait refuser son lancement. */
    for (let i = 0; i < 300; i++) {
      const { body } = await app.api('GET', '/api/status');
      if (!body.running && !body.queued) return detail;
      await new Promise((r) => setTimeout(r, 50));
    }
    return detail;
  }

  test('« Tester le répertoire » reconnaît le bon dépôt et refuse un autre', async () => {
    const ok = await app.api('POST', '/api/verifiers/test-workdir', { repo_id: repoId, workdir });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.dirty, false);
    assert.equal(ok.body.branche, 'main');

    // Un répertoire qui n'est pas un dépôt, et un dépôt qui n'est pas LE dépôt.
    const pasGit = await app.api('POST', '/api/verifiers/test-workdir', { repo_id: repoId, workdir: os.tmpdir() });
    assert.equal(pasGit.body.ok, false);
    assert.match(pasGit.body.raison, /pas un dépôt git/);

    const autre = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-autre-'));
    git(autre, 'init', '-q', '-b', 'main');
    git(autre, 'remote', 'add', 'origin', 'https://gitlab.test/grp/AUTRE.git');
    const mauvais = await app.api('POST', '/api/verifiers/test-workdir', { repo_id: repoId, workdir: autre });
    assert.equal(mauvais.body.ok, false);
    assert.match(mauvais.body.raison, /pointe sur/, 'le message dit sur quoi il pointe, pas juste « non »');

    assert.equal((await app.api('POST', '/api/verifiers/test-workdir', { repo_id: repoId, workdir: 'relatif' })).status, 400);
  });

  test('un run in place remet le répertoire sur sa branche d’origine', async () => {
    const v = await poserVerifier('ip-vert', repond({ version: 1, status: 'pass' }));
    const avant = git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD');
    assert.equal(avant, 'main');

    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_pass');
    assert.equal(d.in_place, true, 'le rapport doit dire que le run a touché un répertoire de travail');
    assert.equal(git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'remis comme trouvé');
    assert.equal(d.restore_error, null);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('la restauration a lieu même quand les tests échouent, et même sur timeout', async () => {
    const rouge = await poserVerifier('ip-rouge', repond({ version: 1, status: 'fail', failed: [{ test: 'a' }] }));
    const d1 = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: rouge.id })).body.verification.id);
    assert.equal(d1.verdict, 'verified_fail');
    assert.equal(git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    await app.api('DELETE', `/api/verifiers/${rouge.id}`);

    // Un script qui ne rend jamais la main : la restauration doit survivre à son arrêt forcé.
    const bloque = await poserVerifier('ip-bloque', 'cat >/dev/null\nsleep 60', { timeout_s: 10 });
    const d2 = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: bloque.id })).body.verification.id);
    assert.equal(d2.verdict, 'verify_error');
    assert.equal(git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main',
      'un timeout ne doit pas laisser le dépôt de l’utilisateur sur un commit détaché');
    await app.api('DELETE', `/api/verifiers/${bloque.id}`);
  });

  test('un répertoire modifié fait REFUSER le run — jamais de stash automatique', async () => {
    fs.writeFileSync(path.join(workdir, 'brouillon.txt'), 'travail en cours\n');
    const v = await poserVerifier('ip-dirty', repond({ version: 1, status: 'pass' }));
    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /non commitées/);
    // Le fichier de l'utilisateur est intact : on n'a rien déplacé.
    assert.equal(fs.readFileSync(path.join(workdir, 'brouillon.txt'), 'utf8'), 'travail en cours\n');
    assert.equal(git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    fs.unlinkSync(path.join(workdir, 'brouillon.txt'));
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('sans consentement de checkout, la ligne in place est refusée à l’enregistrement', async () => {
    const r = await app.api('POST', '/api/verifiers', {
      name: 'ip-sans-accord', command: script(repond({ version: 1, status: 'pass' }), 'x'),
      repos: [{ repo_id: repoId, mode: 'in_place', workdir }],
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /autorisation/);
  });

  /* Le CONTEXTE : les dépôts que le vérificateur sait tester mais qui n'étaient pas dans le
     lot. Un vert peut très bien venir d'un voisin resté sur une vieille branche ; le rapport
     doit le dire, sinon le verdict rassure à tort. On regarde, on ne touche à rien. */
  test('les dépôts couverts hors du lot sont constatés, pas touchés', async () => {
    // Un deuxième dépôt, couvert par le vérificateur mais sans MR dans la vérification.
    const voisinRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-voisin-remote-'));
    git(voisinRemote, 'init', '-q', '-b', 'main');
    git(voisinRemote, 'config', 'user.email', 'test@example.com');
    git(voisinRemote, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(voisinRemote, 'v.txt'), 'v\n');
    git(voisinRemote, 'add', '-A'); git(voisinRemote, 'commit', '-qm', 'v');
    git(voisinRemote, 'checkout', '-q', '-b', 'vieille-branche');
    git(voisinRemote, 'checkout', '-q', 'main');   // la branche par défaut du dépôt reste `main`

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-voisin-wd-'));
    const voisinWd = path.join(parent, 'voisin');
    execFileSync('git', ['clone', '-q', voisinRemote, voisinWd], { stdio: 'pipe' });
    // …mais l'utilisateur, lui, a laissé son répertoire sur une autre branche.
    git(voisinWd, 'checkout', '-q', 'vieille-branche');
    const voisinId = (await app.api('POST', '/api/repos', { project: 'grp/voisin', url: voisinRemote })).body.id;
    const brancheVoisin = git(voisinWd, 'rev-parse', '--abbrev-ref', 'HEAD');

    const v = (await app.api('POST', '/api/verifiers', {
      name: 'ip-contexte', run_base: false,
      command: script(repond({ version: 1, status: 'pass' }), 'ip-contexte'),
      repos: [
        { repo_id: repoId, mode: 'in_place', workdir, checkout_allowed: true },
        { repo_id: voisinId, mode: 'in_place', workdir: voisinWd, checkout_allowed: true },
      ],
    })).body;

    const shaVoisinAvant = git(voisinWd, 'rev-parse', 'HEAD');
    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d.verdict, 'verified_pass');
    assert.deepEqual(d.targets.map((c) => c.repo_id), [repoId], 'le voisin n’est PAS une cible');

    const ctx = (d.context || []).find((c) => c.repo_id === voisinId);
    assert.ok(ctx, 'le dépôt voisin doit apparaître dans le contexte du rapport');
    assert.equal(ctx.branche, brancheVoisin);
    assert.equal(ctx.dirty, false);
    // Il est sur `vieille-branche`, pas sur la branche par défaut du dépôt : ça se signale.
    assert.equal(ctx.warn, true, 'hors branche par défaut : le rapport doit le signaler');

    assert.equal(git(voisinWd, 'rev-parse', 'HEAD'), shaVoisinAvant, 'un dépôt de contexte n’est jamais touché');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
    await app.api('DELETE', `/api/repos/${voisinId}`);
  });

  test('un workdir devenu invalide arrête le run proprement, sans toucher au dépôt', async () => {
    const perdu = path.join(os.tmpdir(), 'ip-inexistant-xyz');
    const v = await poserVerifier('ip-perdu', repond({ version: 1, status: 'pass' }), { workdir: perdu });
    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /pas un dépôt git/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* La configuration PAR DÉFAUT : run base activé. Le piège : le run base fetche le SHA de
     base de façon ciblée — s'il réussit (SHA annoncé, cas GitLab/GitHub), le « fetch tout »
     de repli n'a pas lieu, et le SHA de TÊTE, poussé après le clone du répertoire, doit être
     fetché à son tour avant le second checkout. Sans ça : verify_error au premier run. */
  test('run base activé : une tête inconnue du répertoire est fetchée avant le checkout', async () => {
    // Un commit poussé APRÈS le clone du répertoire de travail : lui ne le connaît pas.
    git(distant, 'checkout', '-q', 'feature/x');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tête 2\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'tête 2');
    const nouvelleTete = git(distant, 'rev-parse', 'HEAD');
    git(distant, 'checkout', '-q', 'main');
    app.state.mrs['grp/app'][0].sha = nouvelleTete;
    await app.api('POST', '/api/discover');

    const r = await app.api('POST', '/api/verifiers', {
      name: 'ip-avec-base', command: script(repond({ version: 1, status: 'pass' }), 'ip-avec-base'),
      timeout_s: 60, run_base: true,
      repos: [{ repo_id: repoId, mode: 'in_place', workdir, checkout_allowed: true }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: r.body.id })).body.verification.id);
    assert.equal(d.verdict, 'verified_pass', d.log_excerpt);
    assert.equal(d.targets[0].head_sha, nouvelleTete, 'c’est bien la tête inconnue qui a été testée');
    assert.equal(git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'remis comme trouvé');
    assert.equal(d.restore_error, null);
    await app.api('DELETE', `/api/verifiers/${r.body.id}`);
  });
});
