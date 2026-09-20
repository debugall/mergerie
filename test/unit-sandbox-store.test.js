'use strict';
/* LE JOURNAL `sandbox_job` (§8.2 du plan) : une ligne par job, JAMAIS de prompt ni d'argument —
 * seulement la politique compilée (déjà sans secret) et des chemins.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-store-'));

const db = require('../src/db');
const store = require('../src/sandbox/store');
const { policyFor } = require('../src/sandbox/policy');

const specDeBase = (id) => {
  const p = policyFor('review');
  return {
    id, kind: 'review',
    source: { repoId: 42, sourcePath: '/tmp/x', revision: 'abc123', sourceMode: 'snapshot', allowExtraDirs: [] },
    command: { program: 'claude', args: ['-p', 'un prompt secret que la base ne doit jamais voir'], cwdRel: '.', agentBackend: 'claude', agentOptions: {} },
    permissions: p.permissions,
    limits: p.limits,
    policyHash: 'hash123',
  };
};

describe('sandbox/store : journal des jobs', () => {
  test('demarrer() insère une ligne « running », sans prompt ni argument', () => {
    const spec = specDeBase('job-store-1');
    store.demarrer(spec, { backend: 'linux', auditPath: '/tmp/x/logs/audit.jsonl' });
    const ligne = db.prepare('SELECT * FROM sandbox_job WHERE id = ?').get('job-store-1');
    assert.equal(ligne.status, 'running');
    assert.equal(ligne.kind, 'review');
    assert.equal(ligne.backend, 'linux');
    assert.equal(ligne.repo_id, 42);
    assert.equal(ligne.source_revision, 'abc123');
    assert.equal(ligne.policy_hash, 'hash123');
    assert.doesNotMatch(ligne.policy_json + ligne.limits_json, /prompt secret/);
    assert.equal(JSON.parse(ligne.policy_json).network, 'none');
  });

  test('terminer() met à jour le statut et l’erreur, sans écraser ce qui précède', () => {
    store.demarrer(specDeBase('job-store-2'), { backend: 'linux' });
    store.terminer('job-store-2', { status: 'error', errorCode: 'SANDBOX_LIMIT_EXCEEDED', errorMessage: 'trop de fichiers' });
    const ligne = db.prepare('SELECT * FROM sandbox_job WHERE id = ?').get('job-store-2');
    assert.equal(ligne.status, 'error');
    assert.equal(ligne.error_code, 'SANDBOX_LIMIT_EXCEEDED');
    assert.equal(ligne.error_message, 'trop de fichiers');
    assert.equal(ligne.kind, 'review', 'terminer() ne doit pas effacer ce que demarrer() a posé');
    assert.ok(ligne.finished_at);
  });

  test('une écriture ratée ne lève jamais (best-effort)', () => {
    assert.doesNotThrow(() => store.terminer('job-jamais-demarre-et-alors', { status: 'error' }));
  });
});
