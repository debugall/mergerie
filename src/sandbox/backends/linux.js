'use strict';
/* LE BACKEND SÉCURISÉ — bubblewrap rootless, Linux uniquement (§3 du plan). REFUS FERMÉ : toute
 * capacité manquante lève `SANDBOX_UNAVAILABLE`/`SANDBOX_UNSUPPORTED_PLATFORM`, jamais un
 * lancement hôte silencieux — c'est `runner.js` qui choisit `backends/legacy.js` si l'appelant
 * l'a explicitement demandé, jamais ce module.
 *
 * `capabilities()` ne se contente pas de sonder un sysctl : la distribution varie (Debian expose
 * `kernel.unprivileged_userns_clone`, Ubuntu 24.04 restreint par AppArmor, Fedora n'a ni l'un ni
 * l'autre) et un simple `--unshare-user -- true` peut réussir alors que monter `/proc` échoue
 * ensuite (constaté en conteneur imbriqué sans `--privileged`). Le seul test fiable est un
 * lancement PROCHE du réel.
 *
 * Ni `mount`/`setns`/seccomp custom dans cette version (voir `resources.js` pour la même
 * discipline appliquée aux limites de ressources) : les namespaces, l'absence de capabilities et
 * les montages en lecture seule sont la ligne de défense de ce lot ; un filtre seccomp calibré
 * est un chantier suivant, documenté, pas silencieux.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const proc = require('../../core/proc');
const paths = require('../paths');
const resources = require('../resources');
const { erreurSandbox } = require('../errors');

const BWRAP_BIN = () => process.env.MERGERIE_BWRAP_BIN || 'bwrap';
// Ce que le job peut exécuter : jamais le PATH de l'utilisateur (des outils qu'il a installés,
// avec leurs propres permissions ou leurs propres soucis) — un système minimal connu.
const PATH_APPROUVE = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/* `bwrap` part d'un système de fichiers VIDE : sans ces montages, même l'agent lui-même
 * (`node`, `claude`, `copilot`, leur interprète, leurs bibliothèques partagées) serait
 * introuvable. Lecture seule, aucun secret : c'est le système, pas le clone ni le poste de
 * l'utilisateur. `/etc/resolv.conf` et le magasin de certificats ne sont ajoutés QUE si la
 * politique autorise un réseau — un job `network: none` ne doit même pas savoir résoudre un nom. */
function bindsSysteme(spec) {
  const fixes = ['/usr', '/usr/local', '/bin', '/sbin', '/lib', '/lib64', '/lib32'].filter((d) => fs.existsSync(d));
  const binds = fixes.map((d) => ({ host: d, guest: d, mode: 'ro' }));
  if (spec.permissions.network !== 'none') {
    for (const d of ['/etc/resolv.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/nsswitch.conf']) {
      if (fs.existsSync(d)) binds.push({ host: d, guest: d, mode: 'ro' });
    }
  }
  return binds;
}

let cache = null;

/** Ce que CE poste sait faire — sondé une fois, comme `agent/policy.js` le fait pour le CLI. */
async function capabilities() {
  if (cache) return cache;
  const bin = BWRAP_BIN();
  const surLinux = process.platform === 'linux';
  let present = false;
  let version = null;
  if (surLinux) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: 5000, encoding: 'utf8' });
      present = r.status === 0;
      version = (/([0-9]+\.[0-9]+\.[0-9]+)/.exec(r.stdout || '') || [])[1] || null;
    } catch { present = false; }
  }
  let namespaces = false;
  if (present) {
    const sondes = ['/usr', '/bin', '/lib', '/lib64'].filter((d) => fs.existsSync(d));
    try {
      const r = spawnSync(bin, [
        '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-net',
        ...sondes.flatMap((d) => ['--ro-bind', d, d]),
        '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
        '--', '/bin/true',
      ], { timeout: 8000 });
      namespaces = r.status === 0;
    } catch { namespaces = false; }
  }
  cache = { platform: surLinux, bin: present ? bin : null, version, namespaces, resources: resources.capacites() };
  return cache;
}
const oublierCapacites = () => { cache = null; resources.oublierCapacites(); };

/** Lève une erreur codée et n'appelle JAMAIS le CLI d'agent si une capacité obligatoire manque. */
async function assertAvailable() {
  if (process.platform !== 'linux') throw erreurSandbox('SANDBOX_UNSUPPORTED_PLATFORM', { plateforme: process.platform });
  const cap = await capabilities();
  if (!cap.bin) throw erreurSandbox('SANDBOX_UNAVAILABLE', { raison: 'bubblewrap introuvable' });
  if (!cap.namespaces) throw erreurSandbox('SANDBOX_UNAVAILABLE', { raison: 'espaces de noms utilisateur indisponibles sur ce poste' });
  return cap;
}

/** L'argv complet — jamais une chaîne shell (§3.3). Ne monte que ce que `paths.listMountsFor`
 *  a décrit pour CE job ; `/tmp` du job est un dossier hôte lié (pas un tmpfs) pour que
 *  `fs.tailleDossier` puisse le surveiller pendant l'exécution. */
function buildCommand(spec, layout, env = {}) {
  const mounts = [...bindsSysteme(spec), ...paths.listMountsFor(spec, layout)];
  const scratch = mounts.find((m) => m.guest === '/tmp');
  const autres = mounts.filter((m) => m.guest !== '/tmp');

  const argv = [
    '--die-with-parent', '--new-session',
    '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-cgroup',
  ];
  for (const m of autres) argv.push(m.mode === 'ro' ? '--ro-bind' : '--bind', m.host, m.guest);
  if (scratch) argv.push('--bind', scratch.host, '/tmp');
  argv.push('--proc', '/proc', '--dev', '/dev');
  argv.push('--chdir', spec.permissions.filesystem === 'job-write' ? '/workspace-rw' : '/workspace');
  argv.push('--clearenv');
  argv.push('--setenv', 'HOME', '/home/mergerie');
  argv.push('--setenv', 'TMPDIR', '/tmp');
  argv.push('--setenv', 'PATH', PATH_APPROUVE);
  for (const [k, v] of Object.entries(env)) {
    if (['HOME', 'TMPDIR', 'PATH'].includes(k)) continue; // ceux ci-dessus font autorité
    argv.push('--setenv', k, String(v));
  }
  if (spec.permissions.network === 'none') argv.push('--unshare-net');
  argv.push('--', spec.command.program, ...spec.command.args);
  return [BWRAP_BIN(), ...argv];
}

/** Lance le job. Suit la même mécanique que `agent/session.js` (`proc.setActive`/`clearActive`) :
 *  le bouton « Stop » d'un job existant tue ce process de la même façon, sans câblage neuf. Le
 *  temps mural est appliqué ICI (`SIGTERM` puis `SIGKILL`), indépendamment d'un cgroup. */
function run(spec, layout, { onLog = () => {}, env = {} } = {}) {
  return assertAvailable().then(() => new Promise((resolvePromise, reject) => {
    const base = buildCommand(spec, layout, env);
    const { argv: wrapped, degraded } = resources.envelopper(spec.limits, base, { scopeName: `mergerie-sandbox-${spec.id}` });
    const [cmd, ...args] = wrapped;
    const child = spawn(cmd, args, proc.options({ cwd: layout.racine }));
    proc.setActive(child);

    const capOctets = spec.limits.outputBytes;
    let emis = 0;
    let tronque = false;
    const emettre = (buf) => {
      if (emis >= capOctets) { tronque = true; return; }
      const texte = buf.toString('utf8');
      emis += Buffer.byteLength(texte);
      onLog(texte);
    };
    child.stdout.on('data', emettre);
    child.stderr.on('data', emettre);

    let expire = false;
    const minuteur = setTimeout(() => {
      expire = true;
      proc.tuerGroupe(child, 'SIGTERM');
      setTimeout(() => proc.tuerGroupe(child, 'SIGKILL'), 2000);
    }, spec.limits.wallTimeMs);

    child.on('error', (e) => { clearTimeout(minuteur); proc.clearActive(child); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(minuteur);
      proc.clearActive(child);
      // `proc.isCancelled()` : vrai aussi quand une AUTRE limite (`files`/`diskBytes`, sondées
      // par `runner.js`) a coupé le job par le même mécanisme que le bouton « Stop » — la seule
      // façon de savoir, depuis ici, qu'un `SIGTERM` reçu n'était pas un hasard extérieur.
      resolvePromise({ code, signal, timedOut: expire || proc.isCancelled(), truncated: tronque, degradedLimits: degraded });
    });
  }));
}

/** Tue un job en cours — utile hors du contexte ambient de `proc.js` (ex. annulation depuis une
 *  route API qui ne passe pas par la file de jobs classique). */
function kill(handle, signal = 'SIGTERM') { proc.tuerGroupe(handle, signal); }

/** Rien de propre à ce backend : les dossiers du job sont détruits par `sandbox/fs.js`
 *  (`nettoyerJob`), appelé par `runner.js` quoi qu'il arrive. */
async function cleanup() { /* voir sandbox/fs.js:nettoyerJob */ }

module.exports = { capabilities, oublierCapacites, assertAvailable, buildCommand, run, kill, cleanup, PATH_APPROUVE };
