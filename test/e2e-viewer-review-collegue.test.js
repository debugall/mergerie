'use strict';
/* « OUVRIR LE CODE » SUR UNE MERGE REQUEST RELUE PAR UN COLLÈGUE.
 *
 * `reviewed_sha` est partagé par le dépôt de données : il arrive sur un poste dont le clone n'a
 * pas fetché depuis — ou désigne un commit que la branche, force-pushée, ne porte plus. `/tree`
 * retombait sur la tête de branche, mais `/file` et `/filediff` visaient le SHA absent : chaque
 * fichier de l'arbre répondait « Fichier hors arborescence ».
 *
 * Deux cas, simulés en posant `reviewed_sha` à la main (c'est ce que fait la synchro) :
 *  1. le commit existe sur le remote, pas dans le clone → le viewer fetche une fois et sert CE commit ;
 *  2. le commit n'existe nulle part → repli sur la tête de branche, arbre et fichiers d'accord.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, pushChange } = require('./helpers/app');

describe('Ouvrir le code d’une review reçue de l’équipe', () => {
  let app; let repo; let mrId;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajout de b', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
    // Clone le dépôt (c'est le rôle documenté de /diffview) : le clone porte la tête d'alors.
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/diffview`)).status, 200);
  });

  after(async () => { await app.stop(); });

  test('un commit relu ailleurs, absent du clone, est fetché puis servi tel quel', async () => {
    // Le collègue a relu un commit poussé APRÈS notre dernier fetch.
    const sha2 = pushChange(repo, 'src/app.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\nmodule.exports = { a, b, c };\n', 'feat: ajoute c');
    app.db.prepare('UPDATE mr SET reviewed_sha = ? WHERE id = ?').run(sha2, mrId);

    const fichier = await app.api('GET', `/api/mrs/${mrId}/file?path=src/app.js`);
    assert.equal(fichier.status, 200, JSON.stringify(fichier.body));
    assert.match(fichier.body.content, /const c = 3;/, 'le contenu est celui du commit relu, pas de l’ancienne tête');

    const tree = await app.api('GET', `/api/mrs/${mrId}/tree`);
    assert.equal(tree.body.ref, sha2, 'l’arbre décrit le commit relu');
    assert.ok(tree.body.files.some((f) => f.path === 'src/app.js' && f.changed));

    const fd = await app.api('GET', `/api/mrs/${mrId}/filediff?path=src/app.js`);
    assert.equal(fd.status, 200);
    assert.match(fd.body.diff, /const c = 3;/);
  });

  test('un commit relu qui n’existe plus nulle part retombe sur la tête de branche, arbre et fichiers d’accord', async () => {
    app.db.prepare('UPDATE mr SET reviewed_sha = ? WHERE id = ?').run('f'.repeat(40), mrId);

    const tree = await app.api('GET', `/api/mrs/${mrId}/tree`);
    assert.equal(tree.body.ref, `origin/${repo.branch}`);
    const fichier = await app.api('GET', `/api/mrs/${mrId}/file?path=src/app.js`);
    assert.equal(fichier.status, 200, 'plus de « hors arborescence » : le fichier se lit à la même ref que l’arbre');
    assert.match(fichier.body.content, /const c = 3;/);
    const fd = await app.api('GET', `/api/mrs/${mrId}/filediff?path=src/app.js`);
    assert.equal(fd.status, 200);
    assert.match(fd.body.diff, /const c = 3;/);

    // Un chemin hors du dépôt reste refusé : le repli ne desserre pas la garde.
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/file?path=../../etc/passwd`)).status, 400);
  });
});
