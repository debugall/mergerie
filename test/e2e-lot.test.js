'use strict';
/* Lots et vérification groupée (plan_add_verify.md §8, §9, §14).
 *
 * Deux promesses sont testées ici, et ce sont les deux raisons d'être de la fonctionnalité :
 * un verdict de lot vaut pour TOUTES ses merge requests, et le bouton « Corriger » ouvre une
 * session qui couvre TOUS les dépôts — pas seulement celui où le test a cassé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

// Un dépôt avec une branche `feature/x` : de quoi faire une MR vérifiable.
function depot(nom) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lot-${nom}-`));
  git(d, 'init', '-q', '-b', 'main');
  poserIdentiteGit(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(d, 'a.txt'), 'tête\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'tête');
  const sha = git(d, 'rev-parse', 'HEAD');
  git(d, 'checkout', '-q', 'main');
  return { dir: d, sha };
}

describe('Vérification objective — lots', () => {
  let app;
  let bin;
  const repos = {};
  const mrs = {};

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-bin-'));
    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'lot-clones-')) });

    app.state.projects = [];
    for (const nom of ['app', 'lib']) {
      const d = depot(nom);
      const projet = `grp/${nom}`;
      repos[nom] = { ...d, id: (await app.api('POST', '/api/repos', { project: projet, url: d.dir })).body.id };
      app.state.projects.push({ id: app.state.projects.length + 1, path_with_namespace: projet, http_url_to_repo: d.dir });
      app.state.mrs[projet] = [{
        iid: nom === 'app' ? 1 : 2, title: `MR ${nom}`, state: 'opened',
        source_branch: 'feature/x', target_branch: 'main',
        web_url: `https://gitlab.test/${projet}/-/merge_requests/1`,
        sha: d.sha, created_at: new Date().toISOString(), author: { name: 'A' },
      }];
    }
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) mrs[m.project.split('/')[1]] = m;
  });

  after(async () => { await app.stop(); });

  const script = (corps, nom) => {
    const p = path.join(bin, `${nom}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };

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

  test('un lot refuse deux merge requests du même dépôt', async () => {
    const r = await app.api('POST', '/api/lots', { name: 'doublon', members: [mrs.app.id, mrs.app.id] });
    // Le doublon exact est dédoublonné ; c'est deux MR DIFFÉRENTES du même dépôt qui doivent être refusées.
    assert.equal(r.status, 200);
    await app.api('DELETE', `/api/lots/${r.body.id}`);

    app.state.mrs['grp/app'].push({
      iid: 77, title: 'Autre MR du même dépôt', state: 'opened',
      source_branch: 'feature/y', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/77',
      sha: repos.app.sha, created_at: new Date().toISOString(), author: { name: 'B' },
    });
    await app.api('POST', '/api/discover');
    const autre = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 77);
    const refuse = await app.api('POST', '/api/lots', { name: 'x', members: [mrs.app.id, autre.id] });
    assert.equal(refuse.status, 400);
    assert.match(refuse.body.error, /même dépôt/);
    // Et la même règle s'applique au lancement direct, sans lot enregistré.
    assert.equal((await app.api('POST', '/api/verify/mrs', { mr_ids: [mrs.app.id, autre.id] })).status, 400);
  });

  test('le verdict d’un lot porte sur toutes ses merge requests', async () => {
    const lot = await app.api('POST', '/api/lots', { name: 'sortie 2.4', members: [mrs.app.id, mrs.lib.id] });
    assert.equal(lot.status, 200);
    assert.equal(lot.body.members.length, 2);

    const v = (await app.api('POST', '/api/verifiers', {
      name: 'integ-lot', run_base: false,
      command: script(`cat >/dev/null\nprintf '%s\\n' '${JSON.stringify({
        version: 1, status: 'fail', failed: [{ test: 'integ › panier', message: 'total faux' }],
      })}'`, 'lot-rouge'),
      repos: [{ repo_id: repos.app.id, mode: 'worktree' }, { repo_id: repos.lib.id, mode: 'worktree' }],
    })).body;

    const lance = await app.api('POST', `/api/lots/${lot.body.id}/verify`);
    assert.equal(lance.status, 200);
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.lot_id, lot.body.id);
    assert.deepEqual(d.targets.map((c) => c.repo_id).sort(), [repos.app.id, repos.lib.id].sort(),
      'les deux dépôts sont bien dans le run');

    // Le badge de chaque MR se lit depuis la même vérification.
    for (const id of [mrs.app.id, mrs.lib.id]) {
      const { body } = await app.api('GET', `/api/verifications?mr_id=${id}`);
      assert.equal(body.verifications[0].id, d.id, `la MR ${id} porte le verdict du lot`);
    }

    /* « Corriger » : UNE session couvrant les DEUX dépôts, sur les branches existantes.
       C'est le point de conception le plus important — la cause d'un échec d'intégration
       n'est pas forcément dans le dépôt où le test a cassé. */
    const fix = await app.api('POST', `/api/verifications/${d.id}/fix`);
    assert.equal(fix.status, 200);
    assert.deepEqual(fix.body.targets.map((x) => x.repo_id).sort(), [repos.app.id, repos.lib.id].sort());
    assert.ok(fix.body.targets.every((x) => x.branch === 'feature/x'),
      'on reprend les branches des MR : le push met les MR à jour en place');
    assert.match(fix.body.prompt, /integ › panier/, 'le prompt porte le test cassé');
    assert.match(fix.body.prompt, /total faux/, '…et son message');
    assert.match(fix.body.prompt, /Commits testés/, '…et les commits sur lesquels le verdict porte');
    assert.equal(fix.body.auto_push, 1);

    await app.api('DELETE', `/api/verifiers/${v.id}`);
    await app.api('DELETE', `/api/lots/${lot.body.id}`);
  });

  test('« Corriger » est refusé quand l’échec n’est pas imputable aux branches', async () => {
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'integ-vert', run_base: false,
      command: script(`cat >/dev/null\nprintf '%s\\n' '{"version":1,"status":"pass"}'`, 'lot-vert'),
      repos: [{ repo_id: repos.app.id, mode: 'worktree' }, { repo_id: repos.lib.id, mode: 'worktree' }],
    })).body;
    const lance = await app.api('POST', '/api/verify/mrs', { mr_ids: [mrs.app.id, mrs.lib.id] });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_pass');
    const fix = await app.api('POST', `/api/verifications/${d.id}/fix`);
    assert.equal(fix.status, 400, 'rien à corriger : proposer une session serait absurde');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('un vérificateur qui ne couvre qu’un dépôt sur deux est refusé', async () => {
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'partiel', command: script('exit 0', 'partiel'),
      repos: [{ repo_id: repos.app.id, mode: 'worktree' }],
    })).body;
    const r = await app.api('POST', '/api/verify/mrs', { mr_ids: [mrs.app.id, mrs.lib.id] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Aucun vérificateur/, 'un run partiel donnerait un vert qui ne dit rien de la moitié du lot');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Un rapport est une archive. Si supprimer un vérificateur était refusé — ou effaçait les
     verdicts rendus — on paierait un choix d'outillage par une perte d'historique. */
  test('supprimer le vérificateur ou le lot n’efface pas les rapports rendus', async () => {
    const lot = (await app.api('POST', '/api/lots', { name: 'archive', members: [mrs.app.id, mrs.lib.id] })).body;
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'jetable', run_base: false,
      command: script(`cat >/dev/null\nprintf '%s\\n' '{"version":1,"status":"pass"}'`, 'jetable'),
      repos: [{ repo_id: repos.app.id, mode: 'worktree' }, { repo_id: repos.lib.id, mode: 'worktree' }],
    })).body;
    const d = await attendre((await app.api('POST', `/api/lots/${lot.id}/verify`)).body.verification.id);
    assert.equal(d.verdict, 'verified_pass');

    assert.equal((await app.api('DELETE', `/api/verifiers/${v.id}`)).status, 200,
      'un verdict rendu ne doit pas rendre son vérificateur indestructible');
    assert.equal((await app.api('DELETE', `/api/lots/${lot.id}`)).status, 200);

    const apres = await app.api('GET', `/api/verifications/${d.id}`);
    assert.equal(apres.status, 200, 'le rapport survit');
    assert.equal(apres.body.verdict, 'verified_pass');
    assert.equal(apres.body.verifier_name, 'jetable', 'le nom du vérificateur reste lisible');
    assert.equal(apres.body.lot_name, 'archive');
    assert.deepEqual(apres.body.targets.map((c) => c.repo_id).sort(), [repos.app.id, repos.lib.id].sort());
  });
});
