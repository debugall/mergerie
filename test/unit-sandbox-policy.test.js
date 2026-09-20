'use strict';
/* LA POLITIQUE COMPILÉE D'UN MODE DE JOB : hash stable, écrêtage aux plafonds, capacités. Module
 * pur (`src/sandbox/policy.js`) — pas de MERGERIE_DATA_DIR nécessaire ici.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { policyFor, validatePolicy, hashPolicy, can } = require('../src/sandbox/policy');
const { PLAFONDS } = require('../src/sandbox/spec');

describe('sandbox/policy : review n’autorise rien de dangereux par défaut', () => {
  for (const cap of ['write', 'exec-unapproved', 'network-arbitrary', 'git-mutate', 'publish', 'push', 'secret-read', 'docker-socket']) {
    test(`can('review', '${cap}') est faux`, () => assert.equal(can('review', cap), false));
  }
});

describe('sandbox/policy : compilation', () => {
  test('un mode inconnu est refusé', () => {
    assert.throws(() => policyFor('delete-everything'), { code: 'SANDBOX_POLICY_INVALID' });
  });

  test('verify/plan/edit peuvent écrire dans le worktree du job, review non', () => {
    assert.equal(policyFor('review').permissions.filesystem, 'read-only');
    for (const mode of ['verify', 'plan', 'edit']) assert.equal(policyFor(mode).permissions.filesystem, 'job-write');
  });

  test('une limite demandée au-delà du plafond global est écrêtée, pas refusée', () => {
    const p = policyFor('plan', { limits: { wallTimeMs: PLAFONDS.wallTimeMs * 10 } });
    assert.equal(p.limits.wallTimeMs, PLAFONDS.wallTimeMs);
  });

  test('une liste de commandes approuvées ferme exec-unapproved pour verify', () => {
    assert.equal(can('verify', 'exec-unapproved'), true, 'sans liste, aucune commande n’est pré-approuvée');
    assert.equal(can('verify', 'exec-unapproved', { permissions: { commands: ['npm test'] } }), false);
  });

  test('validatePolicy refuse une politique de forme inattendue', () => {
    assert.throws(() => validatePolicy({ mode: 'review', permissions: { filesystem: 'anywhere', network: 'none', commands: [] } }),
      { code: 'SANDBOX_POLICY_INVALID' });
    assert.throws(() => validatePolicy({ mode: 'review', permissions: { filesystem: 'read-only', network: 'none', commands: 'not-an-array' } }),
      { code: 'SANDBOX_POLICY_INVALID' });
  });
});

describe('sandbox/policy : hash', () => {
  test('deux politiques identiques ont le même hash quel que soit l’ordre des clés', () => {
    const a = hashPolicy({ mode: 'review', permissions: { filesystem: 'read-only', network: 'none' }, limits: { pids: 4 } });
    const b = hashPolicy({ mode: 'review', permissions: { network: 'none', filesystem: 'read-only' }, limits: { pids: 4 } });
    assert.equal(a, b);
  });

  test('un changement de permission change le hash', () => {
    const a = hashPolicy(policyFor('review'));
    const b = hashPolicy(policyFor('edit'));
    assert.notEqual(a, b);
  });

  test('un changement de limite change le hash', () => {
    const a = hashPolicy(policyFor('plan'));
    const b = hashPolicy(policyFor('plan', { limits: { pids: 4 } }));
    assert.notEqual(a, b);
  });
});
