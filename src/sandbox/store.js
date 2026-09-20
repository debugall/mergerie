'use strict';
/* LE JOURNAL DES JOBS DE SANDBOX (`sandbox_job`, §8.2 du plan) — best-effort : une écriture de
 * bookkeeping qui échoue ne doit JAMAIS faire échouer le job qu'elle observe (même politique que
 * `sandbox/audit.js`). Ne persiste QUE la politique compilée (permissions, limites — déjà sans
 * secret, voir `sandbox/policy.js`) et des chemins : jamais le prompt ni les arguments de
 * `spec.command`, qui restent dans le prompt de l'agent, pas ici.
 */
const db = require('../db');

const maintenant = () => new Date().toISOString();

function demarrer(spec, { backend, auditPath } = {}) {
  try {
    db.prepare(`INSERT INTO sandbox_job
        (id, kind, status, backend, mode, repo_id, source_revision, policy_json, policy_hash, limits_json, created_at, started_at, audit_path)
      VALUES (@id, @kind, 'running', @backend, @kind, @repoId, @revision, @policyJson, @policyHash, @limitsJson, @maintenant, @maintenant, @auditPath)`)
      .run({
        id: spec.id, kind: spec.kind, backend: backend || null,
        repoId: spec.source.repoId != null ? Number(spec.source.repoId) || null : null,
        revision: spec.source.revision || null,
        policyJson: JSON.stringify(spec.permissions),
        policyHash: spec.policyHash || null,
        limitsJson: JSON.stringify(spec.limits),
        maintenant: maintenant(),
        auditPath: auditPath || null,
      });
  } catch { /* bookkeeping : jamais fatal */ }
}

function terminer(jobId, { status, errorCode, errorMessage, resultPath } = {}) {
  try {
    db.prepare(`UPDATE sandbox_job SET status = ?, finished_at = ?, error_code = ?, error_message = ?, result_path = ? WHERE id = ?`)
      .run(status, maintenant(), errorCode || null, errorMessage ? String(errorMessage).slice(0, 2000) : null, resultPath || null, jobId);
  } catch { /* idem */ }
}

module.exports = { demarrer, terminer };
