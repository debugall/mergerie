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

  test('décochée par défaut, et une valeur douteuse ne l’active pas', async () => {
    assert.equal((await app.api('GET', '/api/config')).body.auto_review_new, '0');
    for (const valeur of ['oui', 'true', '2', '']) {
      await app.api('PUT', '/api/config', { auto_review_new: valeur });
      assert.equal((await app.api('GET', '/api/config')).body.auto_review_new, '0',
        `« ${valeur} » ne doit pas lancer des appels IA`);
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
    await app.api('PUT', '/api/config', { auto_review_new: '1', review_auto_max: '5' });
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
});
