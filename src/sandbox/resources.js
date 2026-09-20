'use strict';
/* LIMITES DE RESSOURCES D'UN JOB — CPU, mémoire, PIDs. `bwrap` ne les impose pas lui-même
 * (§3.5 du plan) ; deux mécanismes, du plus précis au plus universel :
 *
 *   1. `systemd-run --user --scope` : un cgroup v2 délégué à l'utilisateur, sans root — présent
 *      sur tout systemd ≥ 245 (Ubuntu 20.04+, Debian 11+, la quasi-totalité des distributions
 *      actuelles, dont les runners `ubuntu-latest`). C'est le mécanisme que §3.5 demande.
 *   2. À défaut, des `ulimit` (RLIMIT_CPU/AS/NPROC) posés dans un `sh -c` qui enveloppe la
 *      commande avant `exec` : hérités à travers `unshare` (les rlimits ne sont pas remis à
 *      zéro par un namespace), mais plus grossiers — `RLIMIT_NPROC` compte les process de
 *      l'UID RÉEL sur toute la machine, pas seulement ceux du job. Marqué `degraded` dans le
 *      rapport plutôt que présenté comme équivalent à un cgroup.
 *
 * Le temps mural reste un troisième mécanisme, déjà en place et indépendant des deux
 * ci-dessus : `core/proc.js` tue le GROUPE de processus au timeout, cgroup ou non.
 */
const { spawnSync } = require('node:child_process');

let capaciteCache = null;
function capacites() {
  if (capaciteCache) return capaciteCache;
  let systemdRun = false;
  try {
    systemdRun = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { timeout: 5000 }).status === 0;
  } catch { /* systemd-run absent ou hors service : repli */ }
  capaciteCache = { systemdRun };
  return capaciteCache;
}
const oublierCapacites = () => { capaciteCache = null; };

/** Enveloppe `argv` pour appliquer `limits` — renvoie `{ argv, degraded }` : `degraded` dit si
 *  seul le repli `ulimit` a pu s'appliquer (pas de cgroup réellement scopé à ce job). */
function envelopper(limits, argv, { scopeName } = {}) {
  const cap = capacites();
  const cpuS = Math.max(1, Math.ceil(limits.cpuTimeMs / 1000));
  const memKB = Math.max(1024, Math.floor(limits.memoryBytes / 1024));
  const fileKB = Math.max(1, Math.floor(limits.fileBytes / 1024));
  // Toujours posé, même sous systemd-run : deuxième filet, et seul rempart pour `pids` quand le
  // cgroup n'a pas pu être délégué.
  const ulimitScript = `ulimit -t ${cpuS} 2>/dev/null; ulimit -v ${memKB} 2>/dev/null; ulimit -f ${fileKB} 2>/dev/null; exec "$@"`;
  const avecUlimit = ['sh', '-c', ulimitScript, 'sh', ...argv];

  if (!cap.systemdRun) return { argv: avecUlimit, degraded: true };

  const cpuPct = Math.max(1, Math.min(100, Math.round((limits.cpuTimeMs / limits.wallTimeMs) * 100) || 100));
  const args = [
    '--user', '--scope', '--quiet', '--collect',
    ...(scopeName ? ['--unit', scopeName] : []),
    '-p', `MemoryMax=${limits.memoryBytes}`,
    '-p', `TasksMax=${limits.pids}`,
    '-p', `CPUQuota=${cpuPct}%`,
    '--',
    ...avecUlimit,
  ];
  return { argv: ['systemd-run', ...args], degraded: false };
}

module.exports = { capacites, oublierCapacites, envelopper };
