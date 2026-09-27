'use strict';
/* DEMANDER À L'IA DE PROPOSER UNE RÉSOLUTION, sur TOUS les conflits de TOUS les fichiers d'un
 * merge, EN UN SEUL APPEL (onglet Git → Merge).
 *
 * L'écran de conflits montre deux versions face à face et laisse choisir ; l'IA en ajoute une
 * TROISIÈME, à côté des deux autres — jamais à leur place. Rien n'est appliqué ici : une
 * proposition est une troisième colonne qu'on peut garder ou ignorer, exactement comme « la
 * nôtre » et « la leur ».
 *
 * LA VUE GLOBALE, PAS FICHIER PAR FICHIER. Demander une résolution fichier par fichier isolerait
 * l'agent : il proposerait pour `a.txt` sans savoir que `b.txt`, juste à côté, renomme la même
 * fonction — deux résolutions cohérentes chacune pour soi, incohérentes ensemble. On lui montre
 * donc TOUS les fichiers en conflit d'un coup, dans un seul prompt, pour qu'il choisisse des
 * résolutions qui se tiennent d'un fichier à l'autre. Un seul appel, un seul job — jamais un par
 * fichier.
 *
 * UN SEUL APPEL, PAS DE SESSION. Contrairement à une session de codage, il n'y a rien à
 * reprendre d'une demande à l'autre : redemander repart à froid sur l'état courant du merge.
 *
 * LE FORMAT DE SORTIE EST DÉLIMITÉ, comme `<<<FINDINGS … FINDINGS>>>` ou
 * `<<<QUESTIONS … QUESTIONS>>>` ailleurs dans l'outil : un conflit = un bloc
 * `<<<FiHj … FiHj>>>` (pas de `>>>` sur la balise ouvrante, même protocole que les deux
 * autres), où `i` est le rang du FICHIER dans la liste envoyée (1 = le premier) et `j` le rang
 * du CONFLIT dans ce fichier, dans l'ordre où il apparaît — jamais le chemin lui-même, qui
 * pourrait porter des caractères embêtants pour une balise. Un bloc absent ou mal formé n'est
 * jamais une panne — ce conflit-là n'a simplement pas de proposition, et l'écran ne montre pas
 * de troisième colonne pour lui.
 *
 * CHAQUE PROPOSITION PORTE SA RAISON, dans un second bloc `<<<RiHj … RiHj>>>` (même i.j que le
 * bloc `F`) : le POURQUOI de ce choix précis, pas un commentaire général sur le merge. Elle ne
 * s'affiche qu'à la demande (bouton « Voir la raison »), pour ne pas noyer l'écran — mais sans
 * elle, valider une proposition à l'aveugle vaut à peine mieux que trancher au hasard. Un bloc
 * `R` absent n'est pas une panne non plus : la proposition reste utilisable, simplement sans
 * raison à montrer.
 *
 * UN CHEMIN EN CONFLIT N'EST PAS TOUJOURS UN FICHIER LISIBLE : un sous-module dont le pointeur
 * diverge entre les deux côtés pointe vers un DOSSIER sur le disque, et `gitmerge.contenu()` y
 * refuse la lecture plutôt que de laisser `fs.readFileSync` lever `EISDIR` (un message Node brut,
 * pas une explication). Un seul chemin de ce genre ne doit pas faire échouer TOUT le lot — il est
 * simplement ignoré, comme un conflit que l'agent aurait choisi de ne pas résoudre.
 */

const copilot = require('../agent/copilot');
const protocol = require('../agent/protocol');
const { nonFiable } = require('../core/nonfiable');
const gitmerge = require('../git/gitmerge');
const { t } = require('../core/i18n');
const protocolesecret = require('../core/protocolesecret');

/* Demande une proposition pour TOUS les fichiers encore en conflit du merge, l'enregistre, et
   rend un petit bilan (pour le journal du job). Un merge sans conflit, ou dont tous les
   fichiers restants sont déjà résolus, ne coûte aucun appel. */
async function proposer(mergeId, onLog = () => {}) {
  const etat = await gitmerge.etat(mergeId);
  const chemins = etat.conflits || [];

  const fichiers = chemins
    .map((chemin) => {
      // Un sous-module en conflit, par exemple, n'est pas un fichier texte : on l'ignore plutôt
      // que de laisser sa lecture faire échouer la demande pour TOUS les autres fichiers.
      let raw;
      try { raw = gitmerge.contenu(mergeId, chemin); } catch { return null; }
      const nb = gitmerge.decouper(raw).filter((m) => m.type === 'conflit').length;
      return { chemin, raw, nb };
    })
    .filter((f) => f && f.nb > 0);
  if (!fichiers.length) return { fichiers: 0, conflits: 0, resolus: 0 };

  const totalConflits = fichiers.reduce((s, f) => s + f.nb, 0);
  const blocsFichiers = fichiers.map((f, i) => t('git.merge.ai.file-block', {
    n: i + 1,
    fichier: f.chemin,
    bloc: nonFiable(t('git.merge.ai.file-label', { fichier: f.chemin }), f.raw),
  })).join('\n\n');
  /* Un nonce PAR DEMANDE, dérivé du secret du poste : ce qu'un fichier en conflit y glisserait ne
     peut pas le deviner, donc ne peut pas se faire passer pour une proposition. */
  const nonce = protocolesecret.hmac(`merge-${mergeId}-${Date.now()}`, 12);
  const prompt = t('git.merge.ai.prompt', {
    nonce, target: etat.target_branch, source: etat.source_branch,
    nFichiers: fichiers.length, nConflits: totalConflits, contenu: blocsFichiers,
  });

  onLog(t('git.merge.ai.log-asking', {
    mode: copilot.isDryRun() ? 'dry-run' : t('log.mode.ai'), n: fichiers.length, count: fichiers.length,
  }));
  const reponse = await copilot.runPrompt(prompt, etat.dir, {
    kind: 'merge-ai', fichiers: fichiers.map((f) => ({ raw: f.raw })),
  }, onLog);

  const parFichier = {};
  let resolus = 0;
  fichiers.forEach((f, i) => {
    /* `null`, PAS UN TROU : un tableau creux redevient `null` aux index sautés dès qu'il passe
       par `JSON.stringify` (c'est ainsi que `git_merge.ai_json` le stocke) — autant le dire
       explicitement ici, pour que le tableau soit le même avant et après un aller-retour. */
    const propositions = new Array(f.nb).fill(null);
    for (let j = 0; j < f.nb; j += 1) {
      const { block: texte } = protocol.extraire(reponse, `F${i + 1}H${j + 1}`, nonce);
      if (!texte) continue;
      const { block: raison } = protocol.extraire(reponse, `R${i + 1}H${j + 1}`, nonce);
      propositions[j] = { texte, raison: raison || null };
      resolus += 1;
    }
    parFichier[f.chemin] = propositions;
  });
  gitmerge.enregistrerPropositionsMultiples(mergeId, parFichier);
  onLog(t('git.merge.ai.log-done', { n: resolus, total: totalConflits, files: fichiers.length, count: fichiers.length }));
  return { fichiers: fichiers.length, conflits: totalConflits, resolus };
}

module.exports = { proposer };
