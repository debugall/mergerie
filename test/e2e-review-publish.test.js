'use strict';
/* PUBLIER LE RAPPORT DE REVIEW SUR LA MERGE REQUEST.
 *
 * C'est une fonctionnalité qui ÉCRIT CHEZ LES AUTRES : ce qui part est lu par des collègues,
 * sur leur merge request, sous le nom de l'utilisateur. Quatre choses doivent être vraies, et
 * ce fichier ne teste presque que ça :
 *
 *   1. Le réglage est DÉCOCHÉ par défaut, et une valeur douteuse retombe sur « décoché ».
 *      Le doute doit profiter au silence : personne ne doit découvrir que son outil a posté
 *      sur les merge requests de l'équipe parce qu'un champ était mal lu.
 *   2. Ce qui est publié est le rapport SUR LE DISQUE, pas un texte reçu du navigateur.
 *   3. Rien ne part quand le réglage est décoché — un mutant qui publierait toujours doit
 *      faire tomber un test, c'est là qu'est le risque.
 *   4. Un refus de la forge ne fait pas disparaître la review, et ne laisse pas de trace
 *      « publié » : sans ça, on croirait le rapport parti et personne ne l'aurait lu.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');

describe('Rapport de review publié sur la merge request', () => {
  let app; let mrId; let iid = 0; let distant;

  /** Une MR neuve à chaque test : une review publiée ne se re-teste pas sur la même. */
  async function nouvelleMr() {
    iid += 1;
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', `feature/x${iid}`);
    fs.writeFileSync(path.join(distant, 'a.txt'), `tete ${iid}\n`);
    git('add', '-A'); git('commit', '-qm', `tete ${iid}`);
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    app.state.mrs['grp/app'] = [{
      iid, title: `Sujet ${iid}`, state: 'opened', source_branch: `feature/x${iid}`,
      target_branch: 'main', web_url: `http://x/${iid}`, sha: head,
      created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    return (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === iid).id;
  }

  /** Lance une review et attend que la file soit vide — le job fait foi, pas un délai. */
  async function reviewer(id) {
    assert.equal((await app.api('POST', `/api/mrs/${id}/review`)).status, 200);
    for (let i = 0; i < 900; i += 1) {
      const { body: st } = await app.api('GET', '/api/status');
      if (!st.running && !st.queued) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('la review ne se termine pas');
  }

  /** Les commentaires réellement postés sur la forge, lus dans le journal du faux GitLab. */
  const notesPostees = () => app.state.calls
    .filter((c) => c.method === 'POST' && /\/merge_requests\/\d+\/notes$/.test(c.path))
    .map((c) => (c.body && c.body.body) || '');

  before(async () => {
    app = await startApp();
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    await app.configure();
    await app.api('POST', '/api/repos', { project: 'grp/app', url: distant });
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    mrId = await nouvelleMr();
  });
  after(async () => { await app.stop(); });

  /* -------------------------------------------------------------- le réglage ---- */

  test('la publication automatique est décochée par défaut', async () => {
    const { body } = await app.api('GET', '/api/config');
    assert.equal(body.auto_post_review, '0');
  });

  test('le réglage se sauvegarde vraiment — lu depuis le serveur, pas depuis l’écran', async () => {
    await app.api('PUT', '/api/config', { auto_post_review: '1' });
    assert.equal((await app.api('GET', '/api/config')).body.auto_post_review, '1');
    await app.api('PUT', '/api/config', { auto_post_review: '0' });
    assert.equal((await app.api('GET', '/api/config')).body.auto_post_review, '0');
  });

  test('une valeur douteuse retombe sur « décoché », jamais sur « publier »', async () => {
    for (const valeur of ['oui', 'true', '2', '']) {
      await app.api('PUT', '/api/config', { auto_post_review: valeur });
      assert.equal((await app.api('GET', '/api/config')).body.auto_post_review, '0',
        `« ${valeur} » ne doit pas activer la publication`);
    }
  });

  /* --------------------------------------------------------- le bouton manuel ---- */

  test('sans rapport, publier est refusé et rien ne part', async () => {
    const vierge = await nouvelleMr();
    const avant = notesPostees().length;
    const r = await app.api('POST', `/api/mrs/${vierge}/publish-review`);
    assert.equal(r.status, 400);
    assert.equal(notesPostees().length, avant, 'aucun commentaire ne doit partir');
  });

  test('publier envoie le rapport tel qu’il est sur le disque, et garde la trace', async () => {
    const id = await nouvelleMr();
    await reviewer(id);
    const surDisque = fs.readFileSync(
      app.db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(id).md_path, 'utf8').trim();

    const avant = notesPostees().length;
    const r = await app.api('POST', `/api/mrs/${id}/publish-review`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const parties = notesPostees();
    assert.equal(parties.length, avant + 1, 'un commentaire, et un seul');
    assert.equal(parties[parties.length - 1], surDisque,
      'ce qui part doit être le rapport enregistré, au caractère près');

    // La trace est visible par l'écran : c'est elle qui fait dire « Republier » au bouton.
    const { body } = await app.api('GET', `/api/mrs/${id}`);
    assert.ok(body.review.comment_posted_at, 'la date de publication doit remonter au client');
    assert.ok((body.comments || []).some((c) => c.body === surDisque),
      'le rapport publié doit apparaître dans le journal des commentaires');
  });

  test('un refus de la forge ne laisse pas de trace « publié »', async () => {
    const id = await nouvelleMr();
    await reviewer(id);
    app.state.failNextNote = true;
    const r = await app.api('POST', `/api/mrs/${id}/publish-review`);
    assert.equal(r.status, 400, 'un refus de la forge doit remonter comme une erreur');
    const { body } = await app.api('GET', `/api/mrs/${id}`);
    assert.equal(body.review.comment_posted_at, null,
      'marquer « publié » après un échec ferait croire que l’équipe a lu le rapport');
  });

  /* ---------------------------------------------------- la publication auto ---- */

  test('réglage décoché : une review ne publie rien', async () => {
    await app.api('PUT', '/api/config', { auto_post_review: '0' });
    const id = await nouvelleMr();
    const avant = notesPostees().length;
    await reviewer(id);
    assert.equal(notesPostees().length, avant, 'rien ne doit partir sans l’avoir demandé');
    const { body } = await app.api('GET', `/api/mrs/${id}`);
    assert.equal(body.review.comment_posted_at, null);
  });

  test('réglage coché : la review publie son rapport, une fois', async () => {
    await app.api('PUT', '/api/config', { auto_post_review: '1' });
    const id = await nouvelleMr();
    const avant = notesPostees().length;
    await reviewer(id);
    const parties = notesPostees();
    assert.equal(parties.length, avant + 1, 'une review, un commentaire');
    const surDisque = fs.readFileSync(
      app.db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(id).md_path, 'utf8').trim();
    assert.equal(parties[parties.length - 1], surDisque);
    assert.ok((await app.api('GET', `/api/mrs/${id}`)).body.review.comment_posted_at);
  });

  test('forge injoignable : le rapport reste acquis, la review n’échoue pas', async () => {
    await app.api('PUT', '/api/config', { auto_post_review: '1' });
    const id = await nouvelleMr();
    app.state.failNextNote = true;
    await reviewer(id);
    /* Le point de la fonctionnalité : une publication ratée est un incident de réseau, pas la
       perte d'une review qu'on vient de payer en jetons. */
    const { body } = await app.api('GET', `/api/mrs/${id}`);
    assert.equal(body.mr.status, 'reviewed', 'la MR reste reviewée');
    assert.ok(body.review && body.review.md, 'le rapport est bien là');
    assert.equal(body.review.comment_posted_at, null, 'mais rien n’est marqué comme publié');
    await app.api('PUT', '/api/config', { auto_post_review: '0' });
  });
});
