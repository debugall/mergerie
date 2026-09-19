'use strict';
/* Les options d’un merge, et le souvenir des dernières utilisées par dépôt.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');

// Merge une MR (depuis l'onglet Rapports de review).
/* Options de merge : ce que demande l'appel, sinon ce qui avait été choisi à la
   création de la MR (colonnes `mr.squash` / `mr.remove_source_branch`). */
function mergeOptsFor(mr, body) {
  const pick = (v, fallback) => (v === undefined ? fallback : !!(v === true || v === 'true' || v === 1 || v === '1'));
  return {
    squash: pick(body && body.squash, !!(mr && mr.squash)),
    removeSourceBranch: pick(body && body.removeSourceBranch, !!(mr && mr.remove_source_branch)),
  };
}
/* Mémorise les options choisies à la création. Indispensable pour GitHub, dont l'API de
   création ne sait pas les exprimer : c'est ici qu'on retrouve l'intention au merge. */
function rememberMergeOpts(repoId, iid, squash, removeSourceBranch) {
  db.prepare('UPDATE mr SET squash = ?, remove_source_branch = ? WHERE repo_id = ? AND iid = ?')
    .run(squash ? 1 : 0, removeSourceBranch ? 1 : 0, repoId, iid);
}

module.exports = {
  mergeOptsFor, rememberMergeOpts,
};
