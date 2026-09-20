'use strict';
/* LE SUPERVISEUR DE JOB — choisit le backend, prépare le dossier, lance, collecte, nettoie.
 * Aucune logique métier MR ici : il ne connaît que le job, le dépôt, les chemins, le processus et
 * la politique (§2.1 du plan). Le dossier du job est détruit dans un `finally` — quoi qu'il
 * arrive, succès, erreur, timeout ou annulation — c'est cette garantie unique, pas un
 * `try/finally` répété chez chaque appelant, qui tient le DoD « aucune fuite, aucun job orphelin ».
 */
const { validerSpec } = require('./spec');
const { erreurSandbox } = require('./errors');
const sfs = require('./fs');
const linux = require('./backends/linux');
const legacy = require('./backends/legacy');
const audit = require('./audit');
const proc = require('../core/proc');

/** `diskBytes`/`files` n'ont pas d'équivalent cgroup ici (§3.5) : surveillés par sondage plutôt
 *  que bornés par le noyau. Tue via `proc.cancel()` — le même mécanisme que le bouton « Stop »,
 *  qui retrouve tout seul le process actif posé par `backend.run()` (contexte ambient commun). */
function surveillerDisque(layout, limits, consigner) {
  const t = setInterval(() => {
    const octets = sfs.tailleDossier(layout.scratch) + (layout.worktreeRw ? sfs.tailleDossier(layout.worktreeRw) : 0);
    const fichiers = sfs.compterFichiers(layout.scratch) + (layout.worktreeRw ? sfs.compterFichiers(layout.worktreeRw) : 0);
    if (octets > limits.diskBytes) { consigner('limit_exceeded', { limite: 'diskBytes', octets }); proc.cancel(); }
    else if (fichiers > limits.files) { consigner('limit_exceeded', { limite: 'files', fichiers }); proc.cancel(); }
    // Sondé, pas imposé par le noyau (§3.5) : un intervalle court réduit la fenêtre pendant
    // laquelle une rafale peut finir avant d'être vue, sans prétendre l'éliminer (voir la
    // discussion de `resources.js` — même compromis, appliqué ici à `files`/`diskBytes`).
  }, 150);
  t.unref();
  return t;
}

/** Jamais de repli automatique : `sandbox: 'required'` (review/verify/plan/edit, §6.1) refuse
 *  si le backend Linux n'est pas pleinement disponible ; `'disabled'` est le SEUL chemin vers
 *  `legacy`, et seulement si l'appelant l'a demandé en toutes lettres. */
async function choisirBackend(sandbox) {
  if (sandbox === 'disabled') return { backend: legacy, legacyChoisi: true };
  const cap = await linux.capabilities().catch(() => ({ platform: false, bin: null, namespaces: false }));
  if (cap.platform && cap.bin && cap.namespaces) return { backend: linux, legacyChoisi: false };
  const raison = !cap.platform ? 'plateforme non-Linux' : (!cap.bin ? 'bubblewrap introuvable' : 'espaces de noms utilisateur indisponibles sur ce poste');
  if (sandbox === 'required') throw erreurSandbox('SANDBOX_UNAVAILABLE', { raison });
  // 'optional' : encore un refus, jamais un repli silencieux — seul 'disabled' choisit legacy.
  throw erreurSandbox('SANDBOX_UNAVAILABLE', { raison });
}

/**
 * Exécute un job de sandbox de bout en bout.
 *
 * PAS DE CONTEXTE D'ANNULATION À SOI : tourne dans celui du JOB APPELANT (`jobs/ordonnanceur.js`
 * en pose un autour de chaque job, `proc.run(() => runEntry(entry))`) — c'est ce qui permet au
 * bouton « Stop » existant de tuer le process sandboxé sans câblage neuf, `proc.setActive()`
 * (posé par `backend.run()`) et `surveillerDisque` (qui annule par `proc.cancel()`) visant tous
 * les deux LE MÊME contexte que le job en cours. Un appelant HORS job (un test, un usage
 * ponctuel) doit s'envelopper lui-même dans `proc.run(() => sandbox.executer(...))` : sans
 * contexte ambiant, une limite dépassée annulerait l'ambient PAR DÉFAUT jusqu'à `proc.reset()`,
 * et un appel git sans rapport lancé juste après échouerait avec `err.job.stopped`.
 *
 * @param {object} specBrut     voir `spec.js` — sera validé ici
 * @param {object} options
 * @param {'required'|'disabled'} [options.sandbox]
 * @param {(texte: string) => void} [options.onLog]
 * @param {object} [options.env]                     variables déjà décidées par l'appelant
 * @param {(layout: object) => Promise<void>} options.prepareSource  extrait la révision dans
 *        `layout.sourceRo` (§4.2) — propre à l'appelant : lui seul sait d'où vient la source
 *        (clone d'un repo Mergerie, dossier local déclaré…).
 */
async function executer(specBrut, { sandbox = 'required', onLog = () => {}, env = {}, prepareSource } = {}) {
  const spec = validerSpec(specBrut);
  const { backend, legacyChoisi } = await choisirBackend(sandbox);
  const localDir = spec.source.sourceMode === 'local-dir';
  const worktree = spec.permissions.filesystem === 'job-write';
  const collecterPatch = !localDir && (spec.kind === 'plan' || spec.kind === 'edit');
  const layout = sfs.creerLayout(spec.id, { worktree, localDir });
  const consigner = audit.pour(spec.id, layout.logs);
  consigner('job_started', { kind: spec.kind, backend: legacyChoisi ? 'legacy' : 'linux', policyHash: spec.policyHash });
  try {
    // `local-dir` : le dossier existe déjà (un worktree préparé par l'appelant, §6.5) — rien à
    // extraire ni à copier, et `collecterSortie` (basé sur une comparaison d'arbres) ne
    // s'applique pas : l'appelant relit lui-même ce qu'il a besoin de relire (rapport JUnit…).
    if (!localDir) {
      if (prepareSource) await prepareSource(layout);
      if (worktree) sfs.copierDossier(layout.sourceRo, layout.worktreeRw);
    }

    const minuteurDisque = surveillerDisque(layout, spec.limits, consigner);
    let resultat;
    try { resultat = await backend.run(spec, layout, { onLog, env }); }
    finally { clearInterval(minuteurDisque); }
    if (resultat.timedOut) consigner('limit_exceeded', { limite: 'wallTimeMs' });
    if (resultat.truncated) consigner('limit_exceeded', { limite: 'outputBytes' });

    let sortie = null;
    if (collecterPatch) {
      try { sortie = await sfs.collecterSortie(layout.sourceRo, layout.worktreeRw, layout.out, spec.limits); }
      catch (e) { consigner('output_denied', { code: e.code }); throw e; }
    }

    consigner('job_finished', { code: resultat.code, timedOut: resultat.timedOut, degradedLimits: resultat.degradedLimits });
    return {
      code: resultat.code, signal: resultat.signal, timedOut: resultat.timedOut,
      truncated: resultat.truncated, degradedLimits: resultat.degradedLimits,
      backend: legacyChoisi ? 'legacy' : 'linux', policyHash: spec.policyHash, sortie,
    };
  } catch (e) {
    consigner('job_failed', { code: e.code || null });
    throw e;
  } finally {
    await backend.cleanup().catch(() => {});
    if (!sfs.nettoyerJob(layout)) consigner('cleanup_failed', {});
  }
}

module.exports = { executer, choisirBackend };
