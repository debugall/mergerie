'use strict';
/* LE JOURNAL DES JOBS DE SANDBOX (§8.2 du plan) — une ligne PAR JOB, de CE poste : jamais
 * partagée (`store-registry.js`, famille locale « L »), puisqu'elle ne dit rien qu'un collègue
 * pourrait rejouer. `policy_json`/`limits_json` portent la politique COMPILÉE (déjà sans secret,
 * voir `sandbox/policy.js`) — jamais le prompt ni un jeton : `audit_path` pointe le détail,
 * conservé à part (`sandbox/audit.js`), pas dupliqué ici.
 *
 * `id` est l'identifiant du JOB lui-même (celui que `sandbox/runner.js` a déjà généré, pas un
 * `rowid` de plus) : c'est aussi le nom du dossier sous `DATA_DIR/tmp/jobs/`, donc la même clé
 * partout — rapport, audit, dossier.
 */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS sandbox_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  backend TEXT,
  mode TEXT,
  repo_id INTEGER,
  source_revision TEXT,
  policy_json TEXT,
  policy_hash TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  result_path TEXT,
  audit_path TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sandbox_job_created ON sandbox_job(created_at)');

/* Au démarrage : un job resté « running » a été coupé (arrêt du serveur, kill -9) — comme les
 * jobs de la file principale (`db/index.js`). Son DOSSIER a déjà été balayé par
 * `sandbox/fs.js:gcJobs()` ; la ligne le dit à son tour, pour qu'un écran d'historique ne
 * l'affiche pas comme éternellement en cours. */
try {
  db.prepare("UPDATE sandbox_job SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
} catch { /* table toute neuve : rien à corriger */ }

module.exports = {};
