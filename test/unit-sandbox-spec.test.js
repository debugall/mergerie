'use strict';
/* LE CONTRAT D'UN JOB DE SANDBOX : valeurs par défaut, refus fermé sur toute forme inattendue.
 * Module pur (`src/sandbox/spec.js`) — pas de MERGERIE_DATA_DIR nécessaire ici.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validerSpec, DEFAULTS, PLAFONDS } = require('../src/sandbox/spec');

const base = () => ({
  id: 'job-1',
  kind: 'review',
  source: { repoId: 12, sourcePath: '/data/clones/grp/app', revision: 'abc123', sourceMode: 'snapshot', allowExtraDirs: [] },
  command: { program: 'claude', args: ['-p', 'hello'], cwdRel: '.', agentBackend: 'claude', agentOptions: {} },
  permissions: {},
  limits: {},
  policyHash: null,
});

describe('sandbox/spec : validation', () => {
  test('une spec minimale valide se complète avec les valeurs par défaut', () => {
    const spec = validerSpec(base());
    assert.equal(spec.permissions.filesystem, DEFAULTS.filesystem);
    assert.equal(spec.permissions.network, DEFAULTS.network);
    assert.equal(spec.limits.wallTimeMs, DEFAULTS.wallTimeMs);
    assert.deepEqual(spec.permissions.commands, []);
  });

  test('une propriété inconnue à la racine est refusée, pas ignorée', () => {
    assert.throws(() => validerSpec({ ...base(), extra: true }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('une propriété inconnue dans permissions est refusée', () => {
    assert.throws(() => validerSpec({ ...base(), permissions: { toolerance: true } }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('un kind hors de la liste est refusé', () => {
    assert.throws(() => validerSpec({ ...base(), kind: 'delete-everything' }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('une limite au-delà du plafond global est refusée', () => {
    assert.throws(() => validerSpec({ ...base(), limits: { wallTimeMs: PLAFONDS.wallTimeMs + 1 } }),
      { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('une limite à zéro ou négative est refusée', () => {
    assert.throws(() => validerSpec({ ...base(), limits: { pids: 0 } }), { code: 'SANDBOX_POLICY_INVALID' });
    assert.throws(() => validerSpec({ ...base(), limits: { pids: -1 } }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('une limite sous le plafond global est acceptée telle quelle', () => {
    const spec = validerSpec({ ...base(), limits: { pids: 4 } });
    assert.equal(spec.limits.pids, 4);
  });

  test('args non-tableau ou contenant un non-string est refusé', () => {
    assert.throws(() => validerSpec({ ...base(), command: { ...base().command, args: 'x' } }), { code: 'SANDBOX_POLICY_INVALID' });
    assert.throws(() => validerSpec({ ...base(), command: { ...base().command, args: ['ok', 1] } }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('un mode réseau ou filesystem hors énumération est refusé', () => {
    assert.throws(() => validerSpec({ ...base(), permissions: { network: 'anywhere' } }), { code: 'SANDBOX_POLICY_INVALID' });
    assert.throws(() => validerSpec({ ...base(), permissions: { filesystem: 'read-write-everything' } }), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('allowCommit/allowPush non booléens sont refusés', () => {
    assert.throws(() => validerSpec({ ...base(), permissions: { allowCommit: 'yes' } }), { code: 'SANDBOX_POLICY_INVALID' });
  });
});
