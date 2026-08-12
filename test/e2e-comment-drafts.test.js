'use strict';
/* LES COMMENTAIRES INLINE EN ATTENTE.
 *
 * On relit une merge request fichier par fichier et on écrit ses remarques au fil de la
 * lecture. Les envoyer une par une bombarde l'auteur de notifications et fige des remarques
 * qu'on aurait retirées trois fichiers plus loin. Ils restent donc en local, modifiables,
 * jusqu'à un envoi explicite.
 *
 * Deux points portent tout le reste, et sont la matière de ce fichier :
 *   — tant qu'on n'a pas envoyé, RIEN ne part vers la forge (le faux serveur en est le témoin) ;
 *   — l'envoi supprime ce qui EST parti et garde ce qui a échoué, avec sa raison. Un « envoyé »
 *     global sur un lot à moitié parti ferait refermer la MR en croyant le travail fait.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo } = require('./helpers/app');

describe('Commentaires inline en attente', () => {
  let app;
  let mrId;

  const posts = () => app.state.calls.filter((c) => c.method === 'POST' && /\/discussions$/.test(c.path));

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'brouillons-')));
    app.state.mrs['grp/app'] = [{
      iid: 11, title: 'Relecture', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/11',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!11'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
  });
  after(async () => { if (app) await app.stop(); });

  const creer = (body, ligne) => app.api('POST', `/api/mrs/${mrId}/comment-drafts`,
    { body, new_path: 'src/app.js', new_line: ligne });
  const liste = () => app.api('GET', `/api/mrs/${mrId}/comment-drafts`).then((r) => r.body.drafts);

  test('un commentaire s’enregistre sans RIEN envoyer à la forge', async () => {
    const avant = posts().length;
    const r = await creer('la variable mérite un nom', 3);
    assert.equal(r.status, 200);
    assert.equal(r.body.body, 'la variable mérite un nom');
    assert.equal(r.body.new_line, 3);
    assert.equal(posts().length, avant,
      'tant qu’on n’a pas envoyé, l’auteur de la MR ne doit rien recevoir');
    assert.equal((await liste()).length, 1);
  });

  test('il se corrige et se supprime tant qu’il n’est pas parti', async () => {
    const d = (await creer('à retoucher', 4)).body;
    const maj = await app.api('PUT', `/api/mrs/${mrId}/comment-drafts/${d.id}`, { body: 'retouché' });
    assert.equal(maj.body.body, 'retouché');

    const jeter = (await creer('à jeter', 5)).body;
    await app.api('DELETE', `/api/mrs/${mrId}/comment-drafts/${jeter.id}`);
    const restants = await liste();
    assert.ok(!restants.some((x) => x.id === jeter.id));
    assert.ok(restants.some((x) => x.body === 'retouché'));

    // Un corps vide n'est pas une correction : ce serait un commentaire qui ne dit rien.
    assert.equal((await app.api('PUT', `/api/mrs/${mrId}/comment-drafts/${d.id}`, { body: '  ' })).status, 400);
    await app.api('DELETE', `/api/mrs/${mrId}/comment-drafts/${d.id}`);
  });

  test('l’envoi les publie tous, dans l’ordre, et vide la file', async () => {
    for (const d of await liste()) await app.api('DELETE', `/api/mrs/${mrId}/comment-drafts/${d.id}`);
    await creer('premier', 1);
    await creer('second', 2);
    const avant = posts().length;

    const r = await app.api('POST', `/api/mrs/${mrId}/comment-drafts/send`);
    assert.deepEqual({ s: r.body.sent, f: r.body.failed.length }, { s: 2, f: 0 });
    const partis = posts().slice(avant);
    assert.deepEqual(partis.map((c) => c.body.body), ['premier', 'second'],
      'dans l’ordre d’écriture : c’est celui de la relecture');
    assert.equal(partis[0].body.position.new_line, 1, 'chacun retrouve sa ligne');
    assert.ok(partis[0].body.position.head_sha, 'la position est résolue à l’ENVOI, pas à l’écriture');
    assert.equal((await liste()).length, 0, 'parti = plus en attente');
  });

  /* CE QUI ÉCHOUE RESTE. Sans ça, une erreur réseau sur le troisième commentaire les perdrait
     tous les trois — trente minutes de relecture avec eux. */
  test('un échec laisse le commentaire en attente, avec sa raison', async () => {
    await creer('celui qui passe', 1);
    await creer('celui qui casse', 2);
    // Le faux serveur refuse la création de discussion : les deux tentatives échouent.
    app.state.fail['/discussions'] = { status: 500, body: '{"message":"boom"}' };
    const r = await app.api('POST', `/api/mrs/${mrId}/comment-drafts/send`);
    delete app.state.fail['/discussions'];

    assert.equal(r.body.sent, 0);
    assert.equal(r.body.failed.length, 2);
    assert.match(r.body.failed[0].error, /500|boom/, 'la raison est rendue, pas avalée');
    assert.equal((await liste()).length, 2, 'rien n’a été perdu : on peut réessayer');

    // …et le réessai les fait bien partir.
    const r2 = await app.api('POST', `/api/mrs/${mrId}/comment-drafts/send`);
    assert.equal(r2.body.sent, 2);
    assert.equal((await liste()).length, 0);
  });

  test('envoyer sans rien en attente est refusé', async () => {
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/comment-drafts/send`)).status, 400);
  });

  test('une MR inconnue ne se laisse pas annoter', async () => {
    assert.equal((await app.api('POST', '/api/mrs/99999/comment-drafts', { body: 'x', new_path: 'a' })).status, 400);
    assert.equal((await app.api('GET', '/api/mrs/99999/comment-drafts')).status, 400);
  });

  test('un commentaire sans fichier ou sans texte est refusé', async () => {
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/comment-drafts`, { body: 'x' })).status, 400);
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/comment-drafts`, { body: ' ', new_path: 'a' })).status, 400);
  });
});
