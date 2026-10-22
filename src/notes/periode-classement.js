'use strict';
/* ISOLER LES COMMITS DIRECTS — l'algorithme, pur. Ni git ni forge ici : `periode.js` lit le clone
 * et interroge la forge, puis passe des tableaux. C'est ce qui permet de prouver les quatre
 * stratégies de merge (merge commit, squash, fast-forward, rebase à SHA réécrits) sans mock.
 *
 * Un candidat est un commit de l'histoire `--first-parent` d'une branche surveillée. Il est
 * DIRECT s'il n'est attribuable à aucune merge request mergée. Trois passes, de la moins chère
 * à la plus chère :
 *   1. les SHA connus des MR mergées (merge commit, squash, tête), et un merge commit dont le
 *      second parent est la tête d'une MR ;
 *   2. le `patch-id` : un candidat de même empreinte qu'un commit d'une MR mergée appartient à
 *      cette MR, quel que soit son SHA — c'est ce qui reconnaît le rebase-merge GitHub ;
 *   3. la forge, commit par commit (`mergeRequestsOfCommit`), pour ce qui reste — plafonnée :
 *      au-delà, la ligne est « non vérifiée », jamais « directe ». Un faux « sans relecture »
 *      accuserait un collègue à tort ; c'est pire qu'un doute affiché.
 *
 * Le seul vrai risque fonctionnel de l'écran est là : cette fonction se teste par stratégie. */
const { estBot } = require('../core/bots');

const REVERT_RE = /^Revert\s+["“']/i;

/**
 * @param {object} p
 * @param {Array}  p.candidats     [{ sha, parents[], author, author_email, date, title, branche, patch_id }]
 * @param {Array}  p.mrs           MR mergées : [{ iid, head_sha, merge_commit_sha, squash_commit_sha, target_branch }]
 * @param {Map}    p.patchIdsParMr Map(patch_id → iid), empreintes des commits des MR mergées
 * @param {Map}    p.secondParentMr Map(sha du candidat → iid) : merge commits dont `^2` descend d'une MR
 * @param {Map}    p.mrsParCommit  Map(sha → [iid]) : réponse de la forge (passe 3), pour ce qu'on lui a demandé
 * @param {Set}    p.nonVerifies   SHA qu'on n'a PAS pu demander à la forge (plafond atteint)
 * @returns {{ directs: Array, attribues: Array, aVerifier: string[] }}
 */
function classer({ candidats = [], mrs = [], patchIdsParMr = new Map(), secondParentMr = new Map(), mrsParCommit = null, nonVerifies = new Set() } = {}) {
  const parSha = new Map();
  for (const m of mrs) {
    for (const sha of [m.merge_commit_sha, m.squash_commit_sha, m.head_sha]) if (sha) parSha.set(sha, m.iid);
  }
  const teteDe = new Map(mrs.filter((m) => m.head_sha).map((m) => [m.head_sha, m.iid]));
  const directs = [];
  const attribues = [];
  const aVerifier = [];
  for (const c of candidats) {
    const estMerge = (c.parents || []).length > 1;
    // Passe 1 — les SHA que les MR mergées nous ont donnés.
    if (parSha.has(c.sha)) { attribues.push({ sha: c.sha, iid: parSha.get(c.sha), par: 'sha' }); continue; }
    if (estMerge) {
      const second = c.parents[1];
      const iid = teteDe.get(second) || secondParentMr.get(c.sha) || null;
      if (iid) { attribues.push({ sha: c.sha, iid, par: 'merge' }); continue; }
    }
    // Passe 2 — même contenu qu'un commit d'une MR mergée, sous un autre SHA.
    if (!estMerge && c.patch_id && patchIdsParMr.has(c.patch_id)) {
      attribues.push({ sha: c.sha, iid: patchIdsParMr.get(c.patch_id), par: 'patch' });
      continue;
    }
    // Passe 3 — la forge, si on l'a interrogée pour ce commit.
    if (mrsParCommit && mrsParCommit.has(c.sha)) {
      const iids = mrsParCommit.get(c.sha) || [];
      if (iids.length) { attribues.push({ sha: c.sha, iid: iids[0], par: 'forge' }); continue; }
    } else if (mrsParCommit === null || !nonVerifies.has(c.sha)) {
      // Pas encore demandé : l'appelant décide s'il interroge la forge.
      aVerifier.push(c.sha);
    }
    directs.push({
      ...c,
      etiquettes: {
        revert: REVERT_RE.test(String(c.title || '')),
        merge_manuel: estMerge,
        bot: estBot(c.author) || estBot(c.author_email),
        non_verifie: nonVerifies.has(c.sha),
      },
    });
  }
  return { directs, attribues, aVerifier };
}

/* REGROUPER EN PUSHS : on relit un push, pas chaque « wip » d'une série. Commits consécutifs du
   même auteur sur la même branche, à moins de `fenetreMs` d'écart. Les candidats arrivent du
   plus récent au plus ancien (ordre de `git log`) ; les pushs sortent du plus récent au plus
   ancien, leurs commits du plus ancien au plus récent (l'ordre dans lequel on les lit). */
/* `evenementDe` (Map sha → clé d'un push vu par la forge, GitLab `events?action=pushed`) rend le
   regroupement EXACT : deux commits d'un même push restent ensemble même à une heure d'écart,
   deux pushs consécutifs du même auteur restent deux lignes. Sans lui, l'heuristique. */
function regrouperPushs(directs, { fenetreMs = 30 * 60 * 1000, evenementDe = null } = {}) {
  const parBranche = new Map();
  for (const c of directs) {
    const k = c.branche || '';
    if (!parBranche.has(k)) parBranche.set(k, []);
    parBranche.get(k).push(c);
  }
  const pushs = [];
  for (const [branche, liste] of parBranche) {
    let courant = null;
    for (const c of liste) {
      const ev = (evenementDe && evenementDe.get(c.sha)) || null;
      const t = Date.parse(c.date || '') || 0;
      const memeEvenement = !!(courant && ev && courant.evenement === ev);
      const memeAuteur = courant && (courant.author_email || courant.author) === (c.author_email || c.author);
      const proche = courant && Math.abs((Date.parse(courant.premier_at || '') || 0) - t) <= fenetreMs;
      // Un push connu de la forge regroupe exactement ses commits ; l'heuristique ne vaut qu'entre inconnus.
      if (courant && (memeEvenement || (!ev && !courant.evenement && memeAuteur && proche))) {
        courant.commits.unshift(c);
        courant.premier_at = c.date;
      } else {
        courant = {
          branche, author: c.author || '', author_email: c.author_email || '',
          at: c.date, premier_at: c.date, commits: [c], evenement: ev,
        };
        pushs.push(courant);
      }
    }
  }
  for (const p of pushs) {
    const et = { revert: false, merge_manuel: false, bot: false, non_verifie: false };
    for (const c of p.commits) for (const k of Object.keys(et)) if (c.etiquettes && c.etiquettes[k]) et[k] = true;
    p.etiquettes = et;
    p.head_sha = p.commits[p.commits.length - 1].sha;
    p.base_sha = (p.commits[0].parents && p.commits[0].parents[0]) || null;
    p.exact = !!p.evenement;
    delete p.premier_at;
    delete p.evenement;
  }
  return pushs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/* CLASSER UNE MERGE REQUEST DANS LA FENÊTRE, par la date de l'événement — jamais par
   `updated_at`, qu'un changement d'étiquette suffit à bouger. Exclusif, dans cet ordre. */
function classerMr(m, depuis, jusqua) {
  const dans = (d) => !!d && d >= depuis && d <= jusqua;
  if (dans(m.merged_at)) return 'mr_merged';
  if (m.state === 'closed' && !m.merged_at && dans(m.closed_at)) return 'mr_closed';
  if (m.state === 'opened' && dans(m.created_at)) return 'mr_new';
  // Touchée pendant (commits, discussions, une étiquette) — ouverte, ou mergée/fermée avant.
  if (dans(m.updated_at)) return 'mr_active';
  return null;
}

module.exports = { classer, regrouperPushs, classerMr, REVERT_RE };
