'use strict';
/* L'API de la sandbox sécurisée (§8.1 du plan) : ce que ce poste peut tenir, la politique
 * compilée d'un mode (aperçu, sans rien lancer), et le journal des jobs déjà exécutés.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); await app.configure(); });
after(async () => { if (app) await app.stop(); });

describe('API sandbox', () => {
  test('GET /api/sandbox/capabilities : dit ce que CE poste peut tenir', async () => {
    const { status, body } = await app.api('GET', '/api/sandbox/capabilities');
    assert.equal(status, 200);
    assert.equal(typeof body.platform, 'boolean');
    assert.equal(typeof body.disponible, 'boolean');
    assert.equal(body.reglage, 'off', 'off par défaut, sans configuration explicite');
    // Sur ce poste de test (macOS/CI sans bwrap) : jamais faussement "disponible".
    if (!body.platform || !body.bin || !body.namespaces) assert.equal(body.disponible, false);
  });

  test('GET /api/sandbox/policies : les quatre modes, chacun avec sa politique et son hash', async () => {
    const { status, body } = await app.api('GET', '/api/sandbox/policies');
    assert.equal(status, 200);
    const modes = body.policies.map((p) => p.mode).sort();
    assert.deepEqual(modes, ['edit', 'plan', 'review', 'verify']);
    const review = body.policies.find((p) => p.mode === 'review');
    assert.equal(review.permissions.filesystem, 'read-only');
    assert.equal(review.permissions.network, 'none');
  });

  test('POST /api/sandbox/preview : compile sans rien lancer, écrête au plafond', async () => {
    const { status, body } = await app.api('POST', '/api/sandbox/preview', { mode: 'plan', limits: { wallTimeMs: 999999999 } });
    assert.equal(status, 200);
    assert.equal(body.mode, 'plan');
    assert.ok(body.limits.wallTimeMs < 999999999, 'écrêté au plafond global, jamais accepté tel quel');
  });

  test('POST /api/sandbox/preview : un mode inconnu est un 400 explicite', async () => {
    const { status, body } = await app.api('POST', '/api/sandbox/preview', { mode: 'delete-everything' });
    assert.equal(status, 400);
    assert.equal(body.code, 'SANDBOX_POLICY_INVALID');
  });

  test('GET /api/sandbox/jobs : liste vide tant qu’aucun job n’a tourné', async () => {
    const { status, body } = await app.api('GET', '/api/sandbox/jobs');
    assert.equal(status, 200);
    assert.deepEqual(body.jobs, []);
  });

  test('GET /api/sandbox/jobs/:id : 404 explicite sur un id inconnu', async () => {
    const { status, body } = await app.api('GET', '/api/sandbox/jobs/id-qui-nexiste-pas');
    assert.equal(status, 404);
    assert.ok(body.error);
  });

  test('GET /api/sandbox/jobs/:id : un job réel se relit avec sa politique et ses événements', async () => {
    const runnerSandbox = require('../src/sandbox/runner');
    const proc = require('../src/core/proc');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-api-e2e-'));
    const jobId = 'sbx-api-e2e-1';
    await proc.run(() => runnerSandbox.executer({
      id: jobId, kind: 'verify',
      source: { repoId: 9, sourcePath: dir, revision: 'HEAD', sourceMode: 'local-dir', allowExtraDirs: [] },
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], cwdRel: '.', agentBackend: 'verifier', agentOptions: {} },
      permissions: { filesystem: 'job-write', network: 'none' },
      limits: {},
      policyHash: 'abc',
    }, { sandbox: 'disabled' })).done;

    const { status, body } = await app.api('GET', `/api/sandbox/jobs/${jobId}`);
    assert.equal(status, 200);
    assert.equal(body.status, 'done');
    assert.equal(body.repo_id, 9);
    assert.equal(body.permissions.filesystem, 'job-write');
    assert.ok(body.events.some((e) => e.type === 'job_started'));
    assert.ok(body.events.some((e) => e.type === 'job_finished'));

    const { body: liste } = await app.api('GET', '/api/sandbox/jobs');
    assert.ok(liste.jobs.some((j) => j.id === jobId));
  });
});
