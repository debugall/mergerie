'use strict';
/* LA DÉCISION LA PLUS RÉCENTE GAGNE, PAS LE FICHIER LE PLUS RÉCEMMENT ÉCRIT.
 *
 * Le poste d'un collègue réécrit le fichier d'une merge request pour des raisons sans décision
 * (titre, auteur relus chez la forge) avec SON statut, encore « à traiter ». Quand les deux
 * postes avaient touché le fichier, la version distante gagnait en bloc et une MR reviewée ici
 * retournait dans « À traiter ». Le statut voyage désormais avec l'instant de sa décision
 * (`status_at`) : un statut moins récent, ou jamais décidé, n'écrase pas le nôtre ; une décision
 * plus récente venue d'ailleurs passe, comme avant.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'statut-mr-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

describe('Synchro : le statut d’une merge request reviewée survit au fichier d’un collègue', () => {
  let db; let store; let SHARED_DIR; let repoId; let mrId;
  const REL = 'mrs/gitlab/eq/api/218.json';
  const lire = () => JSON.parse(fs.readFileSync(path.join(SHARED_DIR, REL), 'utf8'));
  const ecrire = (obj) => fs.writeFileSync(path.join(SHARED_DIR, REL), `${JSON.stringify(obj, null, 2)}\n`);
  const statut = () => db.prepare('SELECT status, status_at, reviewed_sha FROM mr WHERE id = ?').get(mrId);

  before(() => {
    db = require('../src/db');
    store = require('../src/data/store');
    ({ SHARED_DIR } = require('../src/core/paths'));
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    repoId = db.prepare("INSERT INTO repo (forge, project, url) VALUES ('gitlab', 'eq/api', 'https://gitlab.test/eq/api.git')").run().lastInsertRowid;
    mrId = db.prepare(`INSERT INTO mr (repo_id, iid, title, status, status_at, reviewed_sha, updated_at)
      VALUES (?, 218, 'Paiement 3×', 'reviewed', '2026-09-30T10:00:00.000Z', 'abc123', '2026-09-30T10:00:00.000Z')`).run(repoId).lastInsertRowid;
    store.rafraichir('mr', mrId);
  });

  test('la décision part datée dans le fichier', () => {
    const doc = lire();
    assert.equal(doc.status, 'reviewed');
    assert.equal(doc.status_at, '2026-09-30T10:00:00.000Z');
  });

  test('un fichier « à traiter » sans date de décision ne rétrograde pas la review', () => {
    ecrire({ ...lire(), status: 'to_review', status_at: null, reviewed_sha: null, title: 'Paiement 3× (titre relu)' });
    store.hydraterFichiers([REL]);
    const s = statut();
    assert.equal(s.status, 'reviewed');
    assert.equal(s.reviewed_sha, 'abc123', 'le SHA reviewé reste avec le statut');
    assert.equal(s.status_at, '2026-09-30T10:00:00.000Z');
    assert.equal(db.prepare('SELECT title FROM mr WHERE id = ?').get(mrId).title, 'Paiement 3× (titre relu)',
      'le reste du fichier passe : seule la décision est arbitrée');
  });

  test('une décision plus ancienne venue d’ailleurs ne l’emporte pas non plus', () => {
    ecrire({ ...lire(), status: 'to_review', status_at: '2026-09-29T08:00:00.000Z', reviewed_sha: null });
    store.hydraterFichiers([REL]);
    assert.equal(statut().status, 'reviewed');
  });

  test('…et la ligne locale repart avec sa décision : l’autre poste s’alignera', () => {
    store.ecouler();
    const doc = lire();
    assert.equal(doc.status, 'reviewed');
    assert.equal(doc.status_at, '2026-09-30T10:00:00.000Z');
  });

  test('une décision plus récente venue d’ailleurs passe, comme avant', () => {
    ecrire({ ...lire(), status: 'done', status_at: '2026-09-30T12:00:00.000Z' });
    store.hydraterFichiers([REL]);
    const s = statut();
    assert.equal(s.status, 'done');
    assert.equal(s.status_at, '2026-09-30T12:00:00.000Z');
  });

  test('un poste qui n’a jamais décidé prend la décision qui arrive', () => {
    const autre = db.prepare(`INSERT INTO mr (repo_id, iid, title, status, updated_at) VALUES (?, 219, 'Autre', 'to_review', ?)`)
      .run(repoId, new Date().toISOString()).lastInsertRowid;
    store.rafraichir('mr', autre);
    const rel = 'mrs/gitlab/eq/api/219.json';
    const doc = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, rel), 'utf8'));
    fs.writeFileSync(path.join(SHARED_DIR, rel), `${JSON.stringify({ ...doc, status: 'reviewed', status_at: '2026-09-30T09:00:00.000Z', reviewed_sha: 'def456' })}\n`);
    store.hydraterFichiers([rel]);
    const s = db.prepare('SELECT status, reviewed_sha FROM mr WHERE id = ?').get(autre);
    assert.equal(s.status, 'reviewed');
    assert.equal(s.reviewed_sha, 'def456');
  });
});
