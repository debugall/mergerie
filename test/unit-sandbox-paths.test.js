'use strict';
/* CONFINEMENT DE CHEMINS : `..`, liens sortants, liens vers `/etc`/`$HOME` — chacun refusé, pas
 * silencieusement ramené dans les clous. Module pur (`src/sandbox/paths.js`), tmpdir du système
 * suffit : pas de MERGERIE_DATA_DIR nécessaire ici.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { resolveInside, assertInside, assertNoExternalSymlink, listMountsFor } = require('../src/sandbox/paths');

describe('sandbox/paths : confinement', () => {
  let root;
  let dehors;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-paths-'));
    dehors = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-dehors-'));
    fs.writeFileSync(path.join(dehors, 'secret.txt'), 'x');
    fs.mkdirSync(path.join(root, 'sous'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sous', 'fichier.txt'), 'ok');
  });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dehors, { recursive: true, force: true }); });

  test('un chemin sous root se résout', () => {
    const r = resolveInside(root, 'sous/fichier.txt');
    assert.ok(r.startsWith(fs.realpathSync(root)));
  });

  test('root lui-même se résout', () => {
    assert.equal(resolveInside(root, '.'), fs.realpathSync(root));
  });

  test('un chemin non encore créé sous root est accepté (fichier de sortie à venir)', () => {
    assert.doesNotThrow(() => assertInside(root, 'sous/nouveau.txt'));
  });

  test('« .. » qui sort de root est refusé', () => {
    assert.throws(() => assertInside(root, '../en-dehors'), { code: 'SANDBOX_PATH_OUTSIDE_ROOT' });
  });

  test('un chemin absolu hors root est refusé', () => {
    assert.throws(() => assertInside(root, dehors), { code: 'SANDBOX_PATH_OUTSIDE_ROOT' });
  });

  test('un lien symbolique sortant de root est refusé', () => {
    const lien = path.join(root, 'evasion');
    fs.symlinkSync(dehors, lien);
    try {
      assert.throws(() => assertInside(root, 'evasion'), { code: 'SANDBOX_SYMLINK_ESCAPE' });
      assert.throws(() => assertNoExternalSymlink(root, 'evasion'), { code: 'SANDBOX_SYMLINK_ESCAPE' });
    } finally { fs.rmSync(lien, { force: true }); }
  });

  test('un lien symbolique dans un sous-dossier profond est détecté', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.symlinkSync(dehors, path.join(root, 'a', 'b', 'c'));
    try {
      assert.throws(() => assertNoExternalSymlink(root, 'a/b/c/secret.txt'), { code: 'SANDBOX_SYMLINK_ESCAPE' });
    } finally { fs.rmSync(path.join(root, 'a'), { recursive: true, force: true }); }
  });

  test('un lien symbolique interne à root est accepté', () => {
    fs.symlinkSync(path.join(root, 'sous'), path.join(root, 'alias'));
    try {
      assert.doesNotThrow(() => assertNoExternalSymlink(root, 'alias/fichier.txt'));
    } finally { fs.rmSync(path.join(root, 'alias'), { force: true }); }
  });
});

describe('sandbox/paths : montages', () => {
  const layout = { sourceRo: '/j/source-ro', worktreeRw: '/j/worktree-rw', home: '/j/home', scratch: '/j/scratch', out: '/j/out' };
  const permissions = (filesystem) => ({ filesystem, network: 'none', commands: [], allowCommit: false, allowPush: false, allowPublish: false, allowSecrets: false, allowDockerSocket: false, allowSshAgent: false });

  test('review (read-only) ne monte pas worktree-rw', () => {
    const mounts = listMountsFor({ permissions: permissions('read-only'), source: { allowExtraDirs: [] } }, layout);
    assert.equal(mounts.some((m) => m.guest === '/workspace-rw'), false);
    assert.ok(mounts.some((m) => m.guest === '/workspace' && m.mode === 'ro'));
  });

  test('edit (job-write) monte worktree-rw en rw', () => {
    const mounts = listMountsFor({ permissions: permissions('job-write'), source: { allowExtraDirs: [] } }, layout);
    const rw = mounts.find((m) => m.guest === '/workspace-rw');
    assert.ok(rw);
    assert.equal(rw.mode, 'rw');
  });

  test('aucun montage ne désigne `/`, `$HOME` ou un socket', () => {
    const mounts = listMountsFor({ permissions: permissions('job-write'), source: { allowExtraDirs: [] } }, layout);
    for (const m of mounts) {
      assert.notEqual(m.host, '/');
      assert.notEqual(m.guest, '/');
      assert.doesNotMatch(String(m.host), /docker\.sock|ssh-agent/);
    }
  });

  test('un dossier lié en plus (allowExtraDirs) est monté en lecture seule, sous /extra', () => {
    const mounts = listMountsFor({ permissions: permissions('read-only'), source: { allowExtraDirs: ['/data/clones/grp/lib'] } }, layout);
    const extra = mounts.find((m) => m.host === '/data/clones/grp/lib');
    assert.ok(extra);
    assert.equal(extra.mode, 'ro');
    assert.equal(extra.guest, '/extra/lib');
  });
});
