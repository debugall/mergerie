'use strict';
/* Analyse du graphe des branches (onglet Git → explorateur).

   Trois informations, de fiabilité TRÈS différente — c'est le point central de ce
   module, et l'interface doit le refléter au lieu de tout présenter à plat :

   1. ahead/behind vs la branche par défaut  → EXACT   (git rev-list)
   2. « mergée dans X »                      → CERTAIN si une MR l'atteste,
                                               sinon EXACT via git branch --merged
   3. « créée depuis X »                     → INFÉRÉ, jamais certain

   Sur le point 3 : git n'enregistre nulle part de quelle branche une branche a été
   créée. Une branche est un pointeur vers un commit ; le graphe ne conserve que des
   liens entre commits. On ne peut donc que déduire, et la déduction se trompe dès
   que deux branches partent du même commit — cas courant. D'où un champ
   `confidence` sur chaque origine, que l'appelant DOIT afficher. */

const path = require('path');
const git = require('./git');

// Le clone local est indispensable ici : l'analyse exige l'historique complet.
// `--force` : un tag supprimé puis recréé sur un autre SHA ferait sinon échouer TOUT le
// fetch (« would clobber existing tag », code 1). Le clone est un miroir d'exploration :
// il doit refléter le remote, donc on écrase le tag local par la version distante.
async function fetchRepo(cwd, onLog = () => {}) {
  await git.run('git', ['fetch', '--prune', '--tags', '--force', 'origin'], { cwd, onLog });
}

async function gitOut(cwd, args) {
  const r = await git.run('git', args, { cwd });
  return String(r.stdout || '').trim();
}

/* Commits d'avance / de retard par rapport à la branche de référence.
   `A...B` avec --left-right --count donne les deux compteurs d'un coup. */
async function aheadBehind(cwd, ref, base) {
  try {
    const out = await gitOut(cwd, ['rev-list', '--left-right', '--count', `${base}...${ref}`]);
    const [behind, ahead] = out.split(/\s+/).map((x) => parseInt(x, 10) || 0);
    return { ahead, behind };
  } catch { return { ahead: null, behind: null }; }
}

/* Branches dans lesquelles `ref` est entièrement contenue.
   ⚠ C'est `--contains`, PAS `--merged` : `--merged X` liste les branches contenues
   DANS X (donc ses ancêtres), soit exactement l'inverse de ce qu'on cherche ici.
   `--contains X` liste les branches dont l'historique inclut le sommet de X — donc
   celles dans lesquelles X a bien été mergée. Exact, contrairement à l'origine. */
async function mergedInto(cwd, ref, candidates) {
  const bare = String(ref).replace(/^origin\//, '');
  try {
    const out = await gitOut(cwd, ['branch', '-r', '--contains', ref, '--format=%(refname:short)']);
    const names = out.split('\n').map((s) => s.replace(/^origin\//, '').trim()).filter(Boolean);
    return names.filter((n) => n !== bare && candidates.includes(n));
  } catch { return []; }
}

/* Origine INFÉRÉE. Pour chaque candidate, on calcule la base commune ; on retient
   celle dont la base est la plus PROCHE du sommet de `ref` (le moins de commits
   propres à ref). En cas d'égalité entre plusieurs candidates, l'origine est
   ambiguë et on le dit — c'est précisément le cas des branches parties du même
   commit, qu'aucune heuristique ne peut départager. */
async function inferOrigin(cwd, ref, candidates, defaultBranch) {
  const tip = await gitOut(cwd, ['rev-parse', `origin/${ref}`]).catch(() => '');
  const scored = [];
  for (const cand of candidates) {
    if (cand === ref) continue;
    try {
      const base = await gitOut(cwd, ['merge-base', `origin/${cand}`, `origin/${ref}`]);
      if (!base) continue;
      // base === sommet de ref → ref est un ANCÊTRE de la candidate : celle-ci
      // est en aval, elle ne peut pas être l'origine.
      if (tip && base === tip) continue;
      const own = parseInt(await gitOut(cwd, ['rev-list', '--count', `${base}..origin/${ref}`]), 10);
      if (!Number.isFinite(own)) continue;
      scored.push({ branch: cand, own, base });
    } catch { /* candidate inatteignable : on l'ignore */ }
  }
  if (!scored.length) return { branch: null, confidence: 'unknown' };
  scored.sort((a, b) => a.own - b.own || a.branch.length - b.branch.length);
  const best = scored[0];
  const ties = scored.filter((s) => s.own === best.own);
  if (ties.length > 1) {
    // Égalité stricte : aucune heuristique ne peut départager (branches parties
    // du même commit). On privilégie la branche par défaut, de loin la plus
    // probable en pratique, mais on garde la confiance à « ambiguous » et on
    // expose les autres candidates — l'interface doit montrer le doute.
    const pick = ties.find((t) => t.branch === defaultBranch) || best;
    return {
      branch: pick.branch,
      confidence: 'ambiguous',
      alternatives: ties.map((t) => t.branch).filter((b) => b !== pick.branch).slice(0, 4),
    };
  }
  return { branch: best.branch, confidence: 'inferred' };
}

/* Analyse complète d'un dépôt cloné.
   `mrs` vient de l'API GitLab : c'est la seule source CERTAINE d'une origine
   (source_branch → target_branch d'une MR réellement mergée). */
async function analyzeBranches(cwd, { branches, defaultBranch, mrs = [], limit = 400 }) {
  const names = branches.map((b) => b.name);
  // Index des MR par branche source : une MR mergée fixe l'origine ET la cible.
  const bySource = new Map();
  for (const m of mrs) {
    if (!bySource.has(m.source_branch)) bySource.set(m.source_branch, []);
    bySource.get(m.source_branch).push(m);
  }

  const out = [];
  for (const b of branches.slice(0, limit)) {
    const row = {
      name: b.name, sha: b.sha, default: b.default, protected: b.protected,
      committed_date: b.committed_date, author: b.author,
      ahead: null, behind: null, merged_into: null, merged_mr: null, contained_in: [],
      origin: null, origin_confidence: 'unknown', origin_alternatives: null, open_mr: null,
    };
    if (b.default) { out.push(row); continue; }

    // Une MR OUVERTE depuis cette branche : on la remonte pour que l'explorateur
    // n'offre pas d'en créer une seconde et propose plutôt le lien vers l'existante.
    const open = (bySource.get(b.name) || []).find((m) => m.state === 'opened' || m.state === 'reopened');
    if (open) row.open_mr = { iid: open.iid, url: open.web_url, target: open.target_branch };

    const ab = await aheadBehind(cwd, `origin/${b.name}`, `origin/${defaultBranch}`);
    row.ahead = ab.ahead; row.behind = ab.behind;

    // 1) La MR mergée : source certaine, on la privilégie toujours.
    const merged = (bySource.get(b.name) || []).find((m) => m.state === 'merged');
    if (merged) {
      row.merged_into = merged.target_branch;
      row.merged_mr = { iid: merged.iid, url: merged.web_url };
      row.origin = merged.target_branch;
      row.origin_confidence = 'certain';   // une MR part de sa cible, par construction
    } else {
      // 2) Repli exact : dans quelles branches ref est-elle contenue ?
      //    ⚠ Techniquement, une branche est « contenue » dans toutes celles qui en
      //    dérivent : develop est contenue dans feat-B, qui en est issue. Vrai, mais
      //    trompeur — ce n'est pas ce que « mergée dans » veut dire pour un humain.
      //    On ne retient donc comme merge REEL que la branche par défaut ; les autres
      //    conteneurs sont exposés à part, sans le mot « mergée ».
      const into = await mergedInto(cwd, `origin/${b.name}`, names);
      row.contained_in = into;
      if (into.includes(defaultBranch)) row.merged_into = defaultBranch;

      // 3) Origine inférée, avec son niveau de confiance.
      const org = await inferOrigin(cwd, b.name, names, defaultBranch);
      row.origin = org.branch;
      row.origin_confidence = org.confidence;
      row.origin_alternatives = org.alternatives || null;

      // Une fois la branche mergée, merge-base ne peut plus retrouver son origine
      // (la cible contient désormais toute la branche, donc elle est écartée comme
      // « descendante »). Or une branche est presque toujours remergée là d'où elle
      // vient : on retombe sur la cible du merge, en restant sur « inferred ».
      if (row.merged_into && (org.confidence === 'ambiguous' || org.confidence === 'unknown')) {
        row.origin = row.merged_into;
        row.origin_confidence = 'inferred';
        row.origin_alternatives = null;
      }
    }
    out.push(row);
  }
  return out;
}

module.exports = { fetchRepo, aheadBehind, mergedInto, inferOrigin, analyzeBranches };
