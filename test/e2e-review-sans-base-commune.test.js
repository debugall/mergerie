'use strict';
/* « NO MERGE BASE » : la cible et la source d'une merge request n'ont aucun ancêtre commun dans
 * le clone — cible changée sur la forge, historique réécrit, branche orpheline. `git diff A...B`
 * répond `fatal: no merge base`, et la review comme « Voir le diff » s'arrêtaient là, sur le
 * message de git.
 *
 * Ce qu'on attend désormais : la review et la visionneuse relisent la merge request comme la
 * forge l'affiche — `base_sha..head_sha` de ses `diff_refs` —, les SHA sont gardés sur la ligne
 * `mr`, et quand la forge n'a rien à offrir l'erreur dit la situation, pas la commande.
 * Sans navigateur : tout se lit par l'API et la base.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

describe('Review et diff d’une merge request sans base commune', () => {
  let app; let repo; let orphanSha;
  const id = {};
  const git = (...a) => execFileSync('git', a, { cwd: repo.work, stdio: 'pipe' }).toString().trim();

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    /* Une branche ORPHELINE : aucun commit en commun avec `main`. C'est le cas d'école du
       « no merge base » ; une réécriture d'historique produit la même situation. */
    git('checkout', '-q', '--orphan', 'feature/orpheline');
    git('rm', '-rfq', '.');
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src/app.js'), 'const z = 26;\nmodule.exports = { z };\n');
    fs.writeFileSync(path.join(repo.work, 'ORPHELINE.md'), 'historique à part\n');
    git('add', '-A'); git('commit', '-qm', 'orpheline');
    git('push', '-q', 'origin', 'feature/orpheline');
    orphanSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    app.state.mrs['grp/app'] = [
      { iid: 41, title: 'Sans base commune, avec diff_refs', source_branch: 'feature/orpheline',
        diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: orphanSha } },
      // La forge ne sait rien de plus : pas de diff_refs.
      { iid: 42, title: 'Sans base commune, sans diff_refs', source_branch: 'feature/orpheline' },
    ].map((m) => ({
      ...m, state: 'opened', target_branch: 'main', sha: orphanSha,
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${m.iid}`,
      created_at: '2026-05-01T10:00:00.000Z', author: { name: 'Alice' },
    }));
    for (const iid of [41, 42]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
  });
  after(async () => { if (app) await app.stop(); });

  const enBase = (iid) => app.db.prepare('SELECT * FROM mr WHERE id = ?').get(id[iid]);

  test('« Voir le diff » relit la merge request par les diff_refs de la forge, et garde les SHA', async () => {
    const r = await app.api('GET', `/api/mrs/${id[41]}/diffview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(String(r.body.diff), /const z = 26/, 'le diff est celui de base_sha..head_sha');
    assert.match(String(r.body.diff), /ORPHELINE\.md/);
    const m = enBase(41);
    assert.equal(m.base_sha, repo.mainSha);
    assert.equal(m.head_sha, orphanSha);
  });

  test('la review tourne sur ce même diff au lieu de s’arrêter sur le fatal de git', async () => {
    const r = await app.api('POST', `/api/mrs/${id[41]}/review`, { explain: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitForJobs(app.api);
    const rev = app.db.prepare('SELECT * FROM review WHERE mr_id = ?').get(id[41]);
    assert.ok(rev && rev.diff_path, 'une review existe, avec son diff rangé');
    assert.match(fs.readFileSync(rev.diff_path, 'utf8'), /const z = 26/);
    assert.equal(enBase(41).last_error, null, 'aucune erreur posée sur la merge request');
  });

  test('quand la forge n’a pas de diff_refs, l’erreur nomme la situation et non la commande', async () => {
    const r = await app.api('GET', `/api/mrs/${id[42]}/diffview`);
    assert.notEqual(r.status, 200);
    const msg = String((r.body && r.body.error) || JSON.stringify(r.body));
    assert.match(msg, /[Aa]ucune base commune|[Nn]o common ancestor/, msg);
    assert.doesNotMatch(msg, /fatal:/, 'le fatal de git ne remonte plus tel quel');
  });
});
