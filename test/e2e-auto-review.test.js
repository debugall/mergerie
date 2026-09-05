'use strict';
/* LA REVIEW LANCÉE TOUTE SEULE À L'ARRIVÉE D'UNE MERGE REQUEST.
 *
 * C'est la fonctionnalité qui DÉPENSE sans qu'on regarde : la découverte tourne en fond, et
 * chaque review est un appel IA facturé. Trois choses doivent être vraies, et ce fichier ne
 * teste presque que ça :
 *
 *   1. Rien ne part tant que la case est décochée — c'est l'état par défaut, et un mutant qui
 *      lancerait toujours doit faire tomber un test.
 *   2. Une valeur douteuse retombe sur « décoché » : le doute profite au silence.
 *   3. Le PLAFOND tient. Sans lui, la première découverte d'une installation neuve — celle qui
 *      ramène d'un coup toutes les MR ouvertes du parc — les reviewerait toutes. Et ce qui
 *      n'est pas parti se DIT, sinon un plafond silencieux se lit comme « tout est reviewé ».
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');

describe('Review automatique à l’arrivée d’une MR', () => {
  let app; let distant; let iid = 100;

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
  });
  after(async () => { await app.stop(); });

  /** Fait arriver `n` merge requests neuves, puis rend le bilan de la découverte. */
  async function arriver(n) {
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    const mrs = [];
    for (let k = 0; k < n; k += 1) {
      iid += 1;
      git('checkout', '-q', 'main');
      git('checkout', '-q', '-b', `feature/x${iid}`);
      fs.writeFileSync(path.join(distant, 'a.txt'), `tete ${iid}\n`);
      git('add', '-A'); git('commit', '-qm', `t${iid}`);
      mrs.push({
        iid, title: `Sujet ${iid}`, state: 'opened', source_branch: `feature/x${iid}`,
        target_branch: 'main', web_url: `http://x/${iid}`, sha: git('rev-parse', 'HEAD'),
        created_at: new Date().toISOString(), author: { name: 'A' },
      });
      git('checkout', '-q', 'main');
    }
    app.state.mrs['grp/app'] = [...(app.state.mrs['grp/app'] || []), ...mrs];
    const { body } = await app.api('POST', '/api/discover');
    return body;
  }

  /** Attend que la file soit vide : un job de review lancé doit avoir le temps d'exister. */
  async function fileVide() {
    for (let i = 0; i < 900; i += 1) {
      const { body: st } = await app.api('GET', '/api/status');
      if (!st.running && !st.queued) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('la file ne se vide pas');
  }
  const reviewees = () => app.db.prepare("SELECT COUNT(*) n FROM review").get().n;

  test('les DEUX cases sont décochées par défaut, et une valeur douteuse ne les active pas', async () => {
    /* Elles dépensent toutes les deux des appels IA sans que personne regarde : le doute doit
       profiter au silence, dans un sens comme dans l'autre. */
    for (const cle of ['auto_review_new', 'auto_rereview_stale']) {
      assert.equal((await app.api('GET', '/api/config')).body[cle], '0', `${cle} par défaut`);
      for (const valeur of ['oui', 'true', '2', '']) {
        await app.api('PUT', '/api/config', { [cle]: valeur });
        assert.equal((await app.api('GET', '/api/config')).body[cle], '0',
          `${cle} : « ${valeur} » ne doit pas lancer des appels IA`);
      }
    }
  });

  test('décochée : une MR qui arrive n’est pas reviewée', async () => {
    await app.api('PUT', '/api/config', { auto_review_new: '0' });
    const avant = reviewees();
    const bilan = await arriver(1);
    assert.equal(bilan.auto_review.lancees, 0);
    await fileVide();
    assert.equal(reviewees(), avant, 'aucun rapport ne doit apparaître');
  });

  test('cochée : la MR qui arrive part en review toute seule', async () => {
    await app.api('PUT', '/api/config', { auto_review_new: '1', review_auto_max: '5' });
    const avant = reviewees();
    const bilan = await arriver(1);
    assert.equal(bilan.auto_review.lancees, 1);
    assert.equal(bilan.auto_review.plafonnees, 0);
    await fileVide();
    assert.equal(reviewees(), avant + 1, 'la review doit avoir produit son rapport');
  });

  test('le plafond tient, et ce qui n’est pas parti est ANNONCÉ', async () => {
    await app.api('PUT', '/api/config', { auto_review_new: '1', review_auto_max: '2' });
    const avant = reviewees();
    const bilan = await arriver(5);
    assert.equal(bilan.auto_review.lancees, 2, 'le plafond borne le lot');
    assert.equal(bilan.auto_review.plafonnees, 3,
      'un plafond silencieux se lirait comme « tout a été reviewé »');
    await fileVide();
    assert.equal(reviewees(), avant + 2);
  });

  test('plafond à 0 = sans limite — le choix s’assume, il ne se devine pas', async () => {
    await app.api('PUT', '/api/config', { auto_review_new: '1', review_auto_max: '0' });
    assert.equal((await app.api('GET', '/api/config')).body.review_auto_max, 0);
    const avant = reviewees();
    const bilan = await arriver(3);
    assert.equal(bilan.auto_review.lancees, 3);
    assert.equal(bilan.auto_review.plafonnees, 0);
    await fileVide();
    assert.equal(reviewees(), avant + 3);
  });

  test('une MR DÉJÀ connue ne repart pas en review à chaque découverte', async () => {
    // `new_mr_ids` ne contient que les nouvelles : sans ça, chaque tour de rafraîchissement
    // automatique rejouerait tout le parc, toutes les cinq minutes.
    await app.api('PUT', '/api/config', { auto_review_new: '1', review_auto_max: '5' });
    const bilan = await app.api('POST', '/api/discover');
    assert.equal(bilan.body.auto_review.lancees, 0, 'rien de nouveau, rien à reviewer');
  });

  test('un nouveau commit sur une MR connue ne relance pas la review non plus', async () => {
    /* « À L'ARRIVÉE » VEUT DIRE À L'ARRIVÉE. Une branche qui avance n'est pas une merge request
       qui arrive : brancher la review sur les MR dont le SHA a bougé ferait repayer un appel IA
       complet à chaque push, sans que personne l'ait demandé. La re-review reste un geste — le
       bouton du rapport, incrémental de surcroît. */
    await app.api('PUT', '/api/config', { auto_review_new: '1', auto_rereview_stale: '0', review_auto_max: '5' });
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    const connue = app.state.mrs['grp/app'][app.state.mrs['grp/app'].length - 1];
    git('checkout', '-q', connue.source_branch);
    fs.writeFileSync(path.join(distant, 'a.txt'), `encore ${connue.iid}\n`);
    git('add', '-A'); git('commit', '-qm', 'suite');
    connue.sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    const avant = reviewees();
    const { body } = await app.api('POST', '/api/discover');
    assert.ok(body.stale_mr_ids ? body.stale_mr_ids.length >= 0 : true);
    assert.equal(body.auto_review.lancees, 0, 'une MR qui bouge n’est pas une MR qui arrive');
    await fileVide();
    assert.equal(reviewees(), avant, 'aucun rapport de plus');
    await app.api('PUT', '/api/config', { auto_review_new: '0' });
  });

  /* ------------------------------ le rapport qui se périme ---- */

  /* L'AUTRE MOITIÉ, ET ELLE SE DÉCIDE À PART. Reviewer une merge request qui arrive est une
     dépense unique ; suivre une branche qui bouge se répète à chaque poussée. Les deux cases
     sont donc indépendantes, et ce qui suit le prouve dans les deux sens. */

  /** Fait avancer la branche d'une MR connue, puis redécouvre. */
  async function pousserSur(mr) {
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('checkout', '-q', mr.source_branch);
    fs.writeFileSync(path.join(distant, 'a.txt'), `suite ${Math.random()}\n`);
    git('add', '-A'); git('commit', '-qm', 'suite');
    mr.sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return (await app.api('POST', '/api/discover')).body;
  }

  /** Une MR arrivée ET reviewée : c'est la seule qui peut avoir un rapport périmé. */
  async function mrReviewee() {
    await app.api('PUT', '/api/config', { auto_review_new: '1', auto_rereview_stale: '0', review_auto_max: '5' });
    await arriver(1);
    await fileVide();
    await app.api('PUT', '/api/config', { auto_review_new: '0' });
    return app.state.mrs['grp/app'][app.state.mrs['grp/app'].length - 1];
  }
  const versions = (iidMr) => app.db.prepare(`SELECT COUNT(*) n FROM review_version rv
    JOIN mr ON mr.id = rv.mr_id WHERE mr.iid = ?`).get(iidMr).n;

  test('décochée : un rapport périmé le reste', async () => {
    const mr = await mrReviewee();
    await app.api('PUT', '/api/config', { auto_rereview_stale: '0' });
    const avant = versions(mr.iid);
    const bilan = await pousserSur(mr);
    assert.equal(bilan.auto_rereview.lancees, 0);
    await fileVide();
    assert.equal(versions(mr.iid), avant, 'aucune version de plus');
  });

  test('cochée : le rapport périmé repart tout seul, en incrémental', async () => {
    const mr = await mrReviewee();
    await app.api('PUT', '/api/config', { auto_rereview_stale: '1', review_auto_max: '5' });
    const avant = versions(mr.iid);
    const bilan = await pousserSur(mr);
    assert.equal(bilan.auto_rereview.lancees, 1);
    await fileVide();
    assert.equal(versions(mr.iid), avant + 1, 'une nouvelle version du rapport');
    /* L'incrémental n'est pas un détail de confort : c'est ce qui rend l'automatisme tenable
       sur une branche qui bouge dix fois par jour. Le job doit l'avoir demandé. */
    const job = app.db.prepare("SELECT retry FROM job WHERE kind = 'rereview' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(job.retry).opts.incremental, true);
    await app.api('PUT', '/api/config', { auto_rereview_stale: '0' });
  });

  test('une MR JAMAIS reviewée qui bouge n’est pas « périmée » — elle n’a pas de rapport', async () => {
    /* Sans ce filtre, la case « rapport périmé » lancerait des PREMIÈRES reviews : ce n'est pas
       ce qu'elle promet, et c'est l'autre case qui est là pour ça. */
    await app.api('PUT', '/api/config', { auto_review_new: '0', auto_rereview_stale: '1' });
    await arriver(1);
    const jamais = app.state.mrs['grp/app'][app.state.mrs['grp/app'].length - 1];
    const bilan = await pousserSur(jamais);
    assert.equal(bilan.auto_rereview.lancees, 0, 'pas de rapport, donc rien à périmer');
    await app.api('PUT', '/api/config', { auto_rereview_stale: '0' });
  });

  test('les deux cases sont indépendantes : « périmé » seule ne reviewe pas les arrivées', async () => {
    await app.api('PUT', '/api/config', { auto_review_new: '0', auto_rereview_stale: '1' });
    const avant = reviewees();
    const bilan = await arriver(1);
    assert.equal(bilan.auto_review.lancees, 0);
    await fileVide();
    assert.equal(reviewees(), avant, 'une arrivée n’est pas un rapport périmé');
    await app.api('PUT', '/api/config', { auto_rereview_stale: '0' });
  });
});
