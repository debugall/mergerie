'use strict';
/* API de la sandbox sécurisée (§8.1 du plan) : ce que ce poste peut tenir, la politique
 * compilée d'un mode (aperçu, sans rien lancer), et le journal des jobs déjà exécutés.
 *
 * PAS de route de lancement ni d'annulation ici : un job de sandbox part toujours DEPUIS un
 * job Mergerie existant (review, verify, task) — c'est le bouton « Stop » de CE job, déjà
 * câblé, qui l'arrête (`sandbox/runner.js` tourne dans son contexte). Ajouter un `/cancel` à
 * part demanderait de faire correspondre un id de job de sandbox à un id de job Mergerie,
 * jamais tracé aujourd'hui — un chantier à part, pas fait ici.
 */
const fs = require('node:fs');
const { app } = require('../app');
const db = require('../../db');
const { wrap } = require('../http');
const { t } = require('../../core/i18n');
const linux = require('../../sandbox/backends/linux');
const resources = require('../../sandbox/resources');
const { policyFor, PROFILS } = require('../../sandbox/policy');
const { erreurSandbox } = require('../../sandbox/errors');
const { getConfig } = require('../../data/config');

/* Sondé une fois par démarrage (mise en cache dans `backends/linux.js`/`resources.js`) : un GET
   répété ne relance donc pas `bwrap --version` ni la sonde de namespaces à chaque appel. */
app.get('/api/sandbox/capabilities', wrap(async (req, res) => {
  const cap = await linux.capabilities().catch(() => ({ platform: false, bin: null, version: null, namespaces: false }));
  res.json({
    platform: cap.platform, bin: !!cap.bin, version: cap.version, namespaces: cap.namespaces,
    resources: resources.capacites(),
    disponible: !!(cap.platform && cap.bin && cap.namespaces),
    reglage: getConfig().agent_sandbox,
  });
}));

app.get('/api/sandbox/policies', wrap((req, res) => {
  res.json({ policies: Object.keys(PROFILS).map((mode) => policyFor(mode)) });
}));

/* Aperçu : compile la politique d'un mode avec des dérogations, SANS rien lancer — ce que
   `/preview` doit être d'après le plan. */
app.post('/api/sandbox/preview', wrap((req, res) => {
  const { mode, permissions, limits } = req.body || {};
  if (!PROFILS[mode]) throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'mode', valeur: String(mode) });
  res.json(policyFor(mode, { permissions, limits }));
}));

const LIMITE_LISTE = 100;

app.get('/api/sandbox/jobs', wrap((req, res) => {
  const lignes = db.prepare('SELECT id, kind, status, backend, repo_id, created_at, started_at, finished_at, error_code FROM sandbox_job ORDER BY created_at DESC LIMIT ?')
    .all(LIMITE_LISTE);
  res.json({ jobs: lignes });
}));

app.get('/api/sandbox/jobs/:id', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM sandbox_job WHERE id = ?').get(req.params.id);
  if (!job) throw Object.assign(new Error(t('err.sandbox.job-introuvable')), { status: 404 });
  let events = [];
  if (job.audit_path && fs.existsSync(job.audit_path)) {
    try {
      events = fs.readFileSync(job.audit_path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* fichier corrompu : le job reste consultable sans son détail */ }
  }
  res.json({
    ...job,
    permissions: job.policy_json ? JSON.parse(job.policy_json) : null,
    limits: job.limits_json ? JSON.parse(job.limits_json) : null,
    events,
  });
}));
