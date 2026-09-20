'use strict';
/* LE CONTRAT D'UN JOB DE SANDBOX — pur : ni fs, ni process, ni réseau. C'est ce qui permet de
 * tester chaque règle de validation sans jamais toucher au disque ni lancer un CLI, et ce qui
 * garantit qu'aucun chemin de contournement ne se glisse dans une lecture de fichier.
 *
 * TOUTE PROPRIÉTÉ INCONNUE EST REFUSÉE, jamais ignorée : un champ mal orthographié qui serait
 * ignoré silencieusement produirait un job avec les valeurs par défaut au lieu de celles voulues —
 * le bug le plus difficile à repérer d'une liste blanche (§2.2 du plan).
 *
 * L'API de sandbox ne reçoit jamais un binaire et un chemin arbitraires : `source.sourcePath` et
 * `command.program` sont des identifiants ou des chemins déjà résolus par Mergerie (repo, worktree,
 * dossier local déclaré) — jamais une valeur saisie librement par l'utilisateur ou lue dans un MR.
 */
const { erreurSandbox } = require('./errors');

const KINDS = new Set(['review', 'verify', 'plan', 'edit']);
const SOURCE_MODES = new Set(['snapshot', 'worktree', 'local-dir']);
const FILESYSTEM_MODES = new Set(['read-only', 'job-write']);
const NETWORK_MODES = new Set(['none', 'model-proxy', 'allowlist']);
const AGENT_BACKENDS = new Set(['claude', 'copilot', 'verifier']);

// Valeurs par défaut sûres (§2.3 du plan) : lecture seule, sans réseau, sans droit d'écrire hors
// scratch, sans secret, sans docker ni ssh.
const DEFAULTS = Object.freeze({
  mode: 'review',
  wallTimeMs: 15 * 60 * 1000,
  cpuTimeMs: 5 * 60 * 1000,
  memoryBytes: 4 * 1024 * 1024 * 1024,
  pids: 128,
  outputBytes: 10 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
  files: 20_000,
  diskBytes: 512 * 1024 * 1024,
  filesystem: 'read-only',
  network: 'none',
  allowCommit: false,
  allowPush: false,
  allowPublish: false,
  allowSecrets: false,
  allowDockerSocket: false,
  allowSshAgent: false,
});

// Le plafond global (§2.3) : une politique peut réduire n'importe quelle limite en dessous, mais
// jamais la dépasser sans une confirmation explicite portée par l'appelant (hors de ce module —
// voir policy.js, qui seul sait ce qu'« explicite » veut dire pour un mode donné).
const PLAFONDS = Object.freeze({
  wallTimeMs: 60 * 60 * 1000,
  cpuTimeMs: 30 * 60 * 1000,
  memoryBytes: 16 * 1024 * 1024 * 1024,
  pids: 1024,
  outputBytes: 100 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024 * 1024,
  files: 200_000,
  diskBytes: 4 * 1024 * 1024 * 1024,
});

const CHAMPS_SOURCE = new Set(['repoId', 'sourcePath', 'revision', 'sourceMode', 'allowExtraDirs']);
const CHAMPS_COMMAND = new Set(['program', 'args', 'cwdRel', 'agentBackend', 'agentOptions']);
const CHAMPS_PERMISSIONS = new Set(['filesystem', 'network', 'commands', 'allowCommit', 'allowPush',
  'allowPublish', 'allowSecrets', 'allowDockerSocket', 'allowSshAgent']);
const CHAMPS_LIMITS = new Set(Object.keys(PLAFONDS));
const CHAMPS_RACINE = new Set(['id', 'kind', 'source', 'command', 'permissions', 'limits', 'policyHash']);

function refuser(champ) { throw erreurSandbox('SANDBOX_POLICY_INVALID', { champ }); }

function assertConnu(objet, connus, prefixe) {
  for (const k of Object.keys(objet || {})) if (!connus.has(k)) refuser(`${prefixe}.${k}`);
}

function assertBool(v, champ) { if (typeof v !== 'boolean') refuser(champ); }
function assertString(v, champ) { if (typeof v !== 'string' || !v) refuser(champ); }
function assertEnum(v, ensemble, champ) { if (!ensemble.has(v)) refuser(champ); }
function assertBorne(v, champ, plafond) {
  if (!Number.isFinite(v) || v <= 0) refuser(champ);
  if (plafond != null && v > plafond) refuser(`${champ}>plafond`);
}

/** Valide et complète un JobSpec. Lève `SANDBOX_POLICY_INVALID` sur toute forme inattendue. */
function validerSpec(brut) {
  if (!brut || typeof brut !== 'object') refuser('spec');
  assertConnu(brut, CHAMPS_RACINE, 'spec');
  assertString(brut.id, 'id');
  assertEnum(brut.kind, KINDS, 'kind');

  const source = brut.source || {};
  assertConnu(source, CHAMPS_SOURCE, 'source');
  assertString(source.repoId != null ? String(source.repoId) : '', 'source.repoId');
  assertString(source.sourcePath, 'source.sourcePath');
  assertString(source.revision, 'source.revision');
  assertEnum(source.sourceMode, SOURCE_MODES, 'source.sourceMode');
  const allowExtraDirs = source.allowExtraDirs || [];
  if (!Array.isArray(allowExtraDirs) || allowExtraDirs.some((d) => typeof d !== 'string' || !d)) {
    refuser('source.allowExtraDirs');
  }

  const command = brut.command || {};
  assertConnu(command, CHAMPS_COMMAND, 'command');
  assertString(command.program, 'command.program');
  const args = command.args || [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) refuser('command.args');
  const cwdRel = command.cwdRel != null ? command.cwdRel : '.';
  if (typeof cwdRel !== 'string') refuser('command.cwdRel');
  assertEnum(command.agentBackend, AGENT_BACKENDS, 'command.agentBackend');
  const agentOptions = command.agentOptions || {};
  if (typeof agentOptions !== 'object' || Array.isArray(agentOptions)) refuser('command.agentOptions');

  const permissions = { ...DEFAULTS, ...(brut.permissions || {}) };
  assertConnu(brut.permissions || {}, CHAMPS_PERMISSIONS, 'permissions');
  assertEnum(permissions.filesystem, FILESYSTEM_MODES, 'permissions.filesystem');
  assertEnum(permissions.network, NETWORK_MODES, 'permissions.network');
  const commands = permissions.commands || [];
  if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string' || !c)) refuser('permissions.commands');
  for (const f of ['allowCommit', 'allowPush', 'allowPublish', 'allowSecrets', 'allowDockerSocket', 'allowSshAgent']) {
    assertBool(permissions[f], `permissions.${f}`);
  }

  const limitsBrutes = brut.limits || {};
  assertConnu(limitsBrutes, CHAMPS_LIMITS, 'limits');
  const limits = { ...DEFAULTS, ...limitsBrutes };
  for (const champ of CHAMPS_LIMITS) assertBorne(limits[champ], `limits.${champ}`, PLAFONDS[champ]);

  const policyHash = brut.policyHash != null ? String(brut.policyHash) : null;

  return {
    id: brut.id,
    kind: brut.kind,
    source: {
      repoId: source.repoId != null ? source.repoId : null,
      sourcePath: source.sourcePath,
      revision: source.revision,
      sourceMode: source.sourceMode,
      allowExtraDirs,
    },
    command: {
      program: command.program,
      args,
      cwdRel,
      agentBackend: command.agentBackend,
      agentOptions,
    },
    permissions: {
      filesystem: permissions.filesystem,
      network: permissions.network,
      commands,
      allowCommit: permissions.allowCommit,
      allowPush: permissions.allowPush,
      allowPublish: permissions.allowPublish,
      allowSecrets: permissions.allowSecrets,
      allowDockerSocket: permissions.allowDockerSocket,
      allowSshAgent: permissions.allowSshAgent,
    },
    limits,
    policyHash,
  };
}

module.exports = { KINDS, SOURCE_MODES, FILESYSTEM_MODES, NETWORK_MODES, AGENT_BACKENDS, DEFAULTS, PLAFONDS, validerSpec };
