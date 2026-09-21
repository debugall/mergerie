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

// `undefined` = jamais sondé ; `null` = sondé, aucun outil (revue de add-secure-layer-2 : les
// deux valeurs étaient confondues, et une machine sans outil relançait la sonde — bloquante,
// jusqu'à 3 s — à chaque commande enveloppée).
let dispoCache;

/** `'unshare'`, `'sandbox-exec'`, ou `null` si aucun n'est utilisable sur cette machine. */
function disponible() {
  if (dispoCache !== undefined) return dispoCache;
  dispoCache = null;
  try {
    if (process.platform === 'linux') {
      /* `-r` MAPPE L'UTILISATEUR COURANT EN ROOT DANS UN NOUVEL ESPACE DE NOMS (revue de
         add-secure-layer-2) : sans lui, `unshare -n` exige les droits root RÉELS et la sonde
         échoue pour n'importe quel utilisateur normal — l'isolement n'était donc jamais actif
         sur Linux, même quand il aurait pu l'être. `-rn` ne demande rien de plus qu'un noyau
         qui autorise les espaces de noms utilisateur (le cas courant). */
      if (spawnSync('unshare', ['-rn', '--', 'true'], { timeout: 3000 }).status === 0) dispoCache = 'unshare';
    } else if (process.platform === 'darwin') {
      if (spawnSync('sandbox-exec', ['-p', '(version 1)(deny network*)(allow default)', 'true'], { timeout: 3000 }).status === 0) dispoCache = 'sandbox-exec';
    }
  } catch { /* binaire absent, ou refusé : repli */ }
  return dispoCache;
}
const oublier = () => { dispoCache = undefined; };

/** Enveloppe `programme`/`args` pour leur couper le réseau — rend la commande TELLE QUELLE si
 *  aucun outil n'est disponible ici, jamais une erreur.
 *
 *  LIMITE CONNUE (revue de add-secure-layer-2, documentée plutôt que devinée) : ceci coupe AUSSI
 *  la boucle locale — `unshare -n` donne au process sa propre interface `lo`, distincte de celle
 *  de l'hôte, et le profil Seatbelt macOS refuse `network*` sans distinction. Une commande de
 *  vérificateur qui vise une base, Redis ou un `docker-compose` sur `localhost` échoue donc en
 *  run automatique là où elle réussissait avant (voir CHANGELOG). */
function envelopper(programme, args) {
  const outil = disponible();
  if (outil === 'unshare') return { programme: 'unshare', args: ['-rn', '--', programme, ...args] };
  if (outil === 'sandbox-exec') {
    return { programme: 'sandbox-exec', args: ['-p', '(version 1)(deny network*)(allow default)', programme, ...args] };
  }
  return { programme, args };
}

module.exports = { disponible, oublier, envelopper };
