'use strict';
/* Vérification objective SIMULÉE pour le mode démo (MERGERIE_DEMO=1), sur le modèle de
 * demo-git.js et demo-docker.js.
 *
 * En démo il n'y a ni dépôt cloné ni script de tests : lancer une vérification pour de vrai
 * échouerait immédiatement, et le bouton ne montrerait rien. On rejoue donc un verdict
 * plausible, sans aucun spawn ni aucune commande git.
 *
 * Le verdict ALTERNE : rouge, puis vert, puis rouge… C'est la séquence qui rend la
 * fonctionnalité lisible — un échec nommé, puis le vert qui suit la correction. Un verdict
 * toujours vert ne dirait rien de ce à quoi sert un vérificateur.
 */

const db = require('./db');

const isDemo = () => process.env.MERGERIE_DEMO === '1';

const ECHECS = [
  { test: 'connexion › jeton expiré', message: 'attendu 401, reçu 500',
    log_excerpt: 'AuthController.login\n  TypeError: cannot read property "exp" of undefined' },
  { test: 'santé › readiness quand la base est absente', message: 'attendu « degraded », reçu « ok »' },
];

/* Rend le couple (base, head) que le script AURAIT répondu, plus le verdict qui en découle.
   La parité se lit sur le nombre de vérifications déjà terminées : deux clics successifs
   montrent donc les deux faces, sans état caché à maintenir. */
function verdictSimule(verifier) {
  const n = db.prepare("SELECT COUNT(*) c FROM verification WHERE status IN ('done','error')").get().c;
  const rouge = n % 2 === 0;
  const base = { version: 1, status: 'pass', total: 218, duration_ms: 89000 };

  /* Un vérificateur « commandes » ne rend pas la même forme de run qu'un script : le rapport
     montre le déroulé commande par commande. La démo doit donc rejouer LA BONNE forme, sinon
     elle montrerait un écran qui n'existe pas. */
  if (verifier && verifier.kind === 'commands') {
    const cmds = db.prepare('SELECT command FROM verifier_command WHERE verifier_id = ? ORDER BY position')
      .all(verifier.id).map((c) => c.command);
    const deroule = cmds.map((command, i) => ({
      command,
      code: rouge && i === cmds.length - 1 ? 1 : 0,
      duration_ms: i === 0 ? 41000 : 55000,
      output_tail: rouge && i === cmds.length - 1
        ? 'TAP version 13\nok 1 - panier › calcule le total\nnot ok 2 - connexion › jeton expiré\n# fail 1'
        : 'ajout de 412 paquets en 41 s',
    }));
    return {
      verdict: rouge ? 'verified_fail' : 'verified_pass',
      base: { ...base, commands: deroule.map((c) => ({ ...c, code: 0 })) },
      imputable: rouge ? [ECHECS[0]] : [],
      head: {
        version: 1, status: rouge ? 'fail' : 'pass', total: 218,
        duration_ms: 96000, failed: rouge ? [ECHECS[0]] : [],
        commands: deroule, detail_source: 'tap', detail_partiel: false, incoherence: false,
      },
    };
  }

  if (rouge) {
    return {
      verdict: 'verified_fail', base, imputable: ECHECS,
      head: { version: 1, status: 'fail', total: 218, duration_ms: 96000, failed: ECHECS },
    };
  }
  return {
    verdict: 'verified_pass', base, imputable: [],
    head: { version: 1, status: 'pass', total: 218, duration_ms: 91000 },
  };
}

module.exports = { isDemo, verdictSimule };
