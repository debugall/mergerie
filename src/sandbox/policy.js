'use strict';
/* LA POLITIQUE D'UN JOB DE SANDBOX, COMPILÉE À PARTIR DU MODE (review/verify/plan/edit) — pas du
 * CLI d'agent : ce module ignore claude et copilot, il ne connaît que ce qu'un job a le droit de
 * toucher. C'est `src/agent/policy.js` qui traduit un « kind » d'agent vers ce mode.
 *
 * Le hash de la politique voyage jusqu'au rapport et à l'UI (§8.1, §11 du plan) : il doit être
 * STABLE pour un même contenu (ordre des clés normalisé) et CHANGER dès qu'une permission change,
 * pour qu'un audit distingue un job « review » d'aujourd'hui de celui d'hier si la politique a
 * bougé entre les deux.
 *
 * `can()` est un outil d'INTROSPECTION (API `/preview`, UI, tests) — pas l'application réelle de
 * la permission : celle-ci vient du backend de sandbox (namespaces, montages) et de
 * `core/commande.js` (validation structurée). Une réponse fausse de `can()` n'ouvrirait rien de
 * plus ; elle mentirait seulement à l'affichage, ce qui reste à éviter mais n'est pas la même
 * gravité qu'un trou dans l'isolation elle-même.
 */
const crypto = require('node:crypto');
const { DEFAULTS, PLAFONDS, FILESYSTEM_MODES, NETWORK_MODES } = require('./spec');
const { erreurSandbox } = require('./errors');

// Ce qu'un MODE permet par défaut — seulement `permissions`, pas un JobSpec complet (pas de
// source ni de commande) : `spec.validerSpec` reste l'autorité une fois le job assemblé.
const PROFILS = Object.freeze({
  review: { filesystem: 'read-only', network: 'none' },
  verify: { filesystem: 'job-write', network: 'none' },
  plan: { filesystem: 'job-write', network: 'none' },
  edit: { filesystem: 'job-write', network: 'none' },
});

// Les capacités interrogeables par `can()`, chacune déduite des permissions compilées — jamais
// d'une supposition sur le mode : un futur mode qui autoriserait `push` répondrait vrai sans
// que cette table change.
const CAPACITES = Object.freeze({
  write: (p) => p.filesystem === 'job-write',
  'exec-unapproved': (p) => p.filesystem === 'job-write' && p.commands.length === 0,
  'network-arbitrary': (p) => p.network === 'allowlist' || p.network === 'model-proxy',
  'git-mutate': (p) => p.allowCommit || p.allowPush,
  publish: (p) => p.allowPublish,
  push: (p) => p.allowPush,
  'secret-read': (p) => p.allowSecrets,
  'docker-socket': (p) => p.allowDockerSocket,
});

function profilDe(mode) {
  const p = PROFILS[mode];
  if (!p) throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'mode', valeur: String(mode) });
  return p;
}

/** Compile la politique d'un mode. `overrides.permissions`/`overrides.limits` peuvent RESTREINDRE
 *  ou préciser (ex. la liste `commands` approuvée d'un verify), jamais dépasser les plafonds
 *  globaux (`spec.PLAFONDS`) : une limite demandée au-delà est simplement écrêtée. */
function policyFor(mode, overrides = {}) {
  const base = profilDe(mode);
  const permissions = {
    ...DEFAULTS, ...base, commands: [],
    ...(overrides.permissions || {}),
  };
  const limits = {};
  for (const champ of Object.keys(PLAFONDS)) {
    const demande = (overrides.limits || {})[champ];
    limits[champ] = demande != null ? Math.min(demande, PLAFONDS[champ]) : DEFAULTS[champ];
  }
  const policy = { mode, permissions, limits };
  validatePolicy(policy);
  return policy;
}

/** Refuse toute forme inattendue — filet avant `hashPolicy`. */
function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'policy' });
  profilDe(policy.mode);
  const p = policy.permissions || {};
  if (!FILESYSTEM_MODES.has(p.filesystem)) throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'permissions.filesystem' });
  if (!NETWORK_MODES.has(p.network)) throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'permissions.network' });
  if (!Array.isArray(p.commands)) throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ: 'permissions.commands' });
  return true;
}

/** Hash stable : clés triées à chaque niveau, jamais l'ordre d'insertion d'un appelant. */
function hashPolicy(policy) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {});
    return v;
  };
  const json = JSON.stringify(stable({ mode: policy.mode, permissions: policy.permissions, limits: policy.limits }));
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/** Vrai quand la politique compilée du mode (avec ses `overrides`) autorise la capacité nommée. */
function can(mode, capability, overrides) {
  const test = CAPACITES[capability];
  if (!test) throw new Error(`capacité sandbox inconnue : ${capability}`);
  return test(policyFor(mode, overrides).permissions);
}

module.exports = { PROFILS, policyFor, validatePolicy, hashPolicy, can };
