'use strict';
/* COUPER LE RÉSEAU SORTANT D'UNE COMMANDE (plan_secure.md, lot B, point 4).
 *
 * Un vérificateur AUTOMATIQUE (`verification.automatic`, déclenché par l'arrivée d'une MR ou
 * une planification — jamais par un clic) exécute déjà avec un `HOME` jetable : ni `~/.ssh`, ni
 * `~/.npmrc`, ni `~/.aws`. Il gardait pourtant le réseau grand ouvert, et c'est lui qui peut
 * exécuter le code d'une merge request hostile sous vérification. Ici, quand l'outil du système
 * le permet, ses commandes tournent SANS accès réseau sortant.
 *
 * Best-effort, jamais un échec silencieux du run : sans `unshare` (Linux) ni `sandbox-exec`
 * (macOS), la commande part inchangée — c'est le jeton de session local (`jetonlocal.js`) qui
 * ferme alors l'API, le réseau sortant restant ouvert. Windows : aucun outil, même repli. */
const { spawnSync } = require('node:child_process');

let dispoCache = null;

/** `'unshare'`, `'sandbox-exec'`, ou `null` si aucun n'est utilisable sur cette machine. */
function disponible() {
  if (dispoCache !== null) return dispoCache;
  dispoCache = null;
  try {
    if (process.platform === 'linux') {
      if (spawnSync('unshare', ['-n', '--', 'true'], { timeout: 3000 }).status === 0) dispoCache = 'unshare';
    } else if (process.platform === 'darwin') {
      if (spawnSync('sandbox-exec', ['-p', '(version 1)(deny network*)(allow default)', 'true'], { timeout: 3000 }).status === 0) dispoCache = 'sandbox-exec';
    }
  } catch { /* binaire absent, ou refusé : repli */ }
  return dispoCache;
}
const oublier = () => { dispoCache = null; };

/** Enveloppe `programme`/`args` pour leur couper le réseau — rend la commande TELLE QUELLE si
 *  aucun outil n'est disponible ici, jamais une erreur. */
function envelopper(programme, args) {
  const outil = disponible();
  if (outil === 'unshare') return { programme: 'unshare', args: ['-n', '--', programme, ...args] };
  if (outil === 'sandbox-exec') {
    return { programme: 'sandbox-exec', args: ['-p', '(version 1)(deny network*)(allow default)', programme, ...args] };
  }
  return { programme, args };
}

module.exports = { disponible, oublier, envelopper };
