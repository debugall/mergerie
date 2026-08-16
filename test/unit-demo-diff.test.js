'use strict';
/* Viewer de code en mode démo — logique PURE (aucun clone, aucun réseau).
 *
 * Ce que ces tests protègent : en démo la forge n'existe pas, donc « Voir le diff » ne peut
 * pas passer par un clone git. Le dépôt fictif doit rendre EXACTEMENT les formes attendues
 * par le front (`viewerPayload` / `viewerFile` / `viewerFileDiff`) — une divergence de forme
 * casserait le viewer sans erreur visible côté serveur.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-demo-diff-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const demoDiff = require('../src/demo-diff');

const MR = {
  iid: 207, project: 'groupe/api-core',
  source_branch: 'feat/PROJ-640-webhook', target_branch: 'main',
};

describe('demo-diff — charge utile du viewer', () => {
  test('isDemo suit la variable d’environnement', () => {
    const avant = process.env.MERGERIE_DEMO;
    process.env.MERGERIE_DEMO = '1';
    assert.equal(demoDiff.isDemo(), true);
    delete process.env.MERGERIE_DEMO;
    assert.equal(demoDiff.isDemo(), false);
    if (avant !== undefined) process.env.MERGERIE_DEMO = avant;
  });

  test('viewFor rend un diff unifié, l’arbre marqué et des compteurs cohérents', () => {
    const v = demoDiff.viewFor(MR);
    assert.match(v.diff, /^diff --git a\//m);
    assert.equal(v.source, MR.source_branch);
    assert.equal(v.target, 'main');

    const modifies = v.files.filter((f) => f.changed).map((f) => f.path);
    assert.deepEqual(modifies.sort(), ['src/webhooks/validate.js', 'test/webhooks.test.js']);
    assert.equal(v.stats.files, modifies.length, 'le compteur de fichiers suit les fichiers marqués');

    // Les compteurs doivent correspondre au diff réellement rendu, pas à une valeur écrite en dur.
    const ajouts = (v.diff.match(/^\+(?!\+\+)/gm) || []).length;
    const retraits = (v.diff.match(/^-(?!--)/gm) || []).length;
    assert.equal(v.stats.added, ajouts);
    assert.equal(v.stats.removed, retraits);
    assert.ok(ajouts > 0 && retraits > 0, 'un diff de démo montre des ajouts ET des retraits');
  });

  test('un fichier créé par la MR apparaît dans l’arbre', () => {
    // 250 ajoute src/metrics.js, qui n'est pas dans l'arbre de base du projet.
    const v = demoDiff.viewFor({ ...MR, iid: 250 });
    assert.ok(v.files.some((f) => f.path === 'src/metrics.js' && f.changed));
  });

  test('une MR inconnue reçoit tout de même un diff, jamais un viewer vide', () => {
    const v = demoDiff.viewFor({ ...MR, iid: 99999 });
    assert.match(v.diff, /^diff --git a\//m);
    assert.ok(v.stats.files >= 1);
  });
});

describe('demo-diff — fichier et diff par fichier', () => {
  test('treeFor marque les mêmes fichiers que le diff', () => {
    const t = demoDiff.treeFor(MR);
    assert.equal(t.ref, `origin/${MR.source_branch}`);
    assert.deepEqual(
      t.files.filter((f) => f.changed).map((f) => f.path).sort(),
      ['src/webhooks/validate.js', 'test/webhooks.test.js'],
    );
  });

  test('fileFor rend un contenu pour un chemin de l’arbre', () => {
    const f = demoDiff.fileFor(MR, 'src/pricing.js');
    assert.equal(f.path, 'src/pricing.js');
    assert.ok(f.content.length > 0);
  });

  test('un chemin hors arborescence est REFUSÉ (pas de traversal, même en démo)', () => {
    assert.throws(() => demoDiff.fileFor(MR, '../../etc/passwd'), /hors arborescence/);
    assert.throws(() => demoDiff.fileFor(MR, '/etc/passwd'), /hors arborescence/);
    assert.throws(() => demoDiff.fileFor(MR, ''), /path requis/);
    assert.throws(() => demoDiff.fileDiffFor(MR, '../secret'), /hors arborescence/);
  });

  test('fileDiffFor ne rend QUE la section du fichier demandé', () => {
    const d = demoDiff.fileDiffFor(MR, 'src/webhooks/validate.js');
    assert.match(d.diff, /\+\+\+ b\/src\/webhooks\/validate\.js/);
    assert.ok(!d.diff.includes('+++ b/test/webhooks.test.js'),
      'la section d’un autre fichier ne doit pas fuiter dans le diff du fichier demandé');
  });

  test('un fichier de l’arbre non touché par la MR a un diff vide', () => {
    assert.equal(demoDiff.fileDiffFor(MR, 'README.md').diff, '');
  });
});
