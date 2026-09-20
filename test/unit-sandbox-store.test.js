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

const { DATA_DIR } = require('../src/core/paths');
const db = require('../src/db');
const store = require('../src/sandbox/store');
const runnerSandbox = require('../src/sandbox/runner');
const proc = require('../src/core/proc');
const { policyFor } = require('../src/sandbox/policy');

// `runner.executer` tourne dans le contexte du JOB APPELANT (voir son en-tête) : un appel
// direct, hors job, s'enveloppe donc lui-même — comme le font les autres tests de ce module.
const runner = { executer: (spec, opts) => proc.run(() => runnerSandbox.executer(spec, opts)).done };

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

  test('bout en bout (backend legacy, portable) : l’audit survit à la destruction du dossier du job', async () => {
    const jobId = 'job-store-e2e-1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-store-e2e-'));
    const resultat = await runner.executer({
      id: jobId, kind: 'verify',
      source: { repoId: null, sourcePath: dir, revision: 'HEAD', sourceMode: 'local-dir', allowExtraDirs: [] },
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], cwdRel: '.', agentBackend: 'verifier', agentOptions: {} },
      permissions: { filesystem: 'job-write', network: 'none' },
      limits: {},
      policyHash: null,
    }, { sandbox: 'disabled' });
    assert.equal(resultat.code, 0);

    const ligne = db.prepare('SELECT * FROM sandbox_job WHERE id = ?').get(jobId);
    assert.equal(ligne.status, 'done');
    assert.ok(ligne.audit_path, 'audit_path doit être renseigné');
    assert.ok(ligne.audit_path.startsWith(path.join(DATA_DIR, 'sandbox-audit')), ligne.audit_path);
    // Le fichier archivé existe VRAIMENT, et le dossier de travail du job a bien disparu.
    assert.equal(fs.existsSync(ligne.audit_path), true);
    const evenements = fs.readFileSync(ligne.audit_path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    assert.ok(evenements.includes('job_started'));
    assert.ok(evenements.includes('job_finished'));
  });
});
