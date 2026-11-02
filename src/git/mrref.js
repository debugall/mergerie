'use strict';
/* LA REF À RELIRE D'UNE MERGE REQUEST — un seul endroit qui décide, pour la review ET le viewer.
 *
 * Tant qu'une merge request est ouverte, `origin/<target>...origin/<source>` dit ce qu'elle
 * apporte. Une fois MERGÉE, deux choses cassent, l'une visible, l'autre non :
 *   - la branche source est souvent supprimée : `origin/<source>` n'existe plus ;
 *   - et surtout le diff à trois points est VIDE PAR CONSTRUCTION, puisque
 *     `merge-base(target, head) = head` dès que `head` est dans `target`. Refetcher la branche
 *     ne suffirait pas : la review tournerait sur zéro ligne et rendrait une note sur rien.
 *
 * D'où la règle, indépendante de la stratégie de merge : `base_sha..head_sha` à DEUX points, où
 * `base_sha` est le merge-base au moment de la MR (la forge le garde dans `diff_refs` / `base`)
 * et `head_sha` sa tête, ramenée par la ref que les deux forges conservent après le merge
 * (`refs/merge-requests/<iid>/head`, `refs/pull/<n>/head`), rangée ici sous `refs/mergerie/mr/`,
 * un espace que `fetch --prune` ne touche pas. Repli quand `base_sha` manque (vieille MR GitLab
 * sans `diff_refs`) : le premier parent du merge commit, ou le parent du commit de squash. */
const git = require('./git');
const forge = require('../forge');

const refLocale = (iid) => `refs/mergerie/mr/${iid}`;
const refspec = (repo, iid) => `+${forge.clientFor(repo).mrHeadRef(iid)}:${refLocale(iid)}`;

/* Ramène les têtes de plusieurs merge requests en un seul fetch. */
async function fetchMrRefs(cwd, repo, iids, onLog = () => {}) {
  const liste = [...new Set((iids || []).map(Number).filter(Boolean))];
  if (!liste.length) return;
  await git.fetchRefs(cwd, liste.map((iid) => refspec(repo, iid)), onLog);
}

const existe = (cwd, ref) => (ref ? git.refExists(cwd, ref) : Promise.resolve(false));

/* `{ base, head, headSha, mode }` ou `null` quand rien ne permet de relire la MR.
   `mode` : 'merged' (deux points, SHA résolus) ou 'open' (trois points, branches vivantes). */
async function refARelire(cwd, mr, repo, onLog = () => {}) {
  const mergee = !!(mr.merged_at || mr.merge_commit_sha || mr.squash_commit_sha);
  const sourceVivante = mr.source_branch && await existe(cwd, `origin/${mr.source_branch}`);
  if (!mergee && sourceVivante && mr.target_branch) {
    return { base: `origin/${mr.target_branch}`, head: `origin/${mr.source_branch}`, headSha: null, mode: 'open' };
  }
  // La tête : le SHA connu, sinon la ref de la MR (fetchée à la demande).
  let head = null;
  if (mr.head_sha && await existe(cwd, mr.head_sha)) head = mr.head_sha;
  if (!head && mr.iid) {
    const loc = refLocale(mr.iid);
    if (!await existe(cwd, loc)) {
      try { await fetchMrRefs(cwd, repo, [mr.iid], onLog); } catch { /* la forge n'a plus la ref */ }
    }
    if (await existe(cwd, loc)) {
      const { stdout } = await git.run('git', ['rev-parse', loc], { cwd });
      head = stdout.trim();
    }
  }
  if (!head && mr.reviewed_sha && await existe(cwd, mr.reviewed_sha)) head = mr.reviewed_sha;
  if (!head && sourceVivante) head = `origin/${mr.source_branch}`;
  if (!head) return null;

  // La base : le merge-base d'alors, sinon ce que le commit de merge en dit.
  let base = null;
  if (mr.base_sha && await existe(cwd, mr.base_sha)) base = mr.base_sha;
  if (!base && mr.merge_commit_sha && await existe(cwd, mr.merge_commit_sha)) {
    const { stdout } = await git.run('git', ['rev-list', '--parents', '-n', '1', mr.merge_commit_sha], { cwd });
    const parents = stdout.trim().split(/\s+/).slice(1);
    if (parents.length >= 2) base = parents[0];
  }
  if (!base && mr.squash_commit_sha && await existe(cwd, mr.squash_commit_sha)) base = `${mr.squash_commit_sha}^`;
  if (!base && mr.target_branch && await existe(cwd, `origin/${mr.target_branch}`)) {
    /* Dernier repli, pour une MR ouverte dont on relit un SHA précis : le merge-base avec la
       cible. Pour une MR mergée il serait `head` lui-même — un diff vide —, on le refuse. */
    if (mergee) return null;
    return { base: `origin/${mr.target_branch}`, head, headSha: head, mode: 'open' };
  }
  if (!base) return null;
  const { stdout } = await git.run('git', ['rev-parse', head], { cwd });
  return { base, head, headSha: stdout.trim(), mode: 'merged' };
}

/* Le diff à relire, selon la ref. Deux points pour une MR mergée, trois pour une ouverte. */
async function diffARelire(cwd, ref, onLog = () => {}) {
  if (!ref) return null;
  return ref.mode === 'merged'
    ? git.diffRange(cwd, ref.base, ref.head, onLog)
    : git.diffTroisPoints(cwd, ref.base, ref.head, onLog);
}

/* SANS BASE COMMUNE ENTRE LA CIBLE ET LA SOURCE (`diffTroisPoints` a levé `NO_MERGE_BASE`) :
   on relit la merge request comme la forge l'affiche elle-même, `base_sha..head_sha` de ses
   `diff_refs` — les SHA déjà connus de la ligne `mr`, sinon le détail de la MR (un appel). La
   tête est ramenée par la ref que la forge conserve si le clone ne l'a pas. Rend
   `{ base, head, diff }`, ou `null` quand la forge ne donne pas de quoi relire. */
async function diffSansBaseCommune(cwd, mr, repo, cfg, onLog = () => {}) {
  /* TOUJOURS LE DÉTAIL DE LA FORGE, même quand la ligne porte déjà des SHA : ceux-là datent du
     dernier rafraîchissement, et c'est précisément la tête courante qu'il faut relire. Les SHA de
     la ligne ne servent que de repli si la forge ne répond pas. */
  let base = null; let head = null; let raison = null;
  try {
    const d = await forge.clientFor(repo).getMergeRequest(cfg, repo.project, mr.iid);
    base = (d && d.base_sha) || null;
    head = (d && (d.head_sha || d.sha)) || null;
    if (!base) raison = `la forge ne donne pas de diff_refs.base_sha (cible ${d && d.target_branch}, source ${d && d.source_branch}, état ${d && d.state})`;
  } catch (e) {
    base = mr.base_sha || null; head = mr.head_sha || null;
    if (!base || !head) raison = `détail de la MR injoignable : ${String(e.message).split('\n')[0]}`;
  }
  if (base && head && base === head) raison = `diff_refs vides : base = tête = ${base.slice(0, 8)}`;
  if (raison) return { diff: null, raison };
  if (!await existe(cwd, head) && mr.iid) {
    try { await fetchMrRefs(cwd, repo, [mr.iid], onLog); } catch { /* la forge n'a plus la ref */ }
  }
  if (!await existe(cwd, head)) return { diff: null, raison: `tête ${head.slice(0, 8)} absente du clone, même après fetch de la ref de la MR` };
  if (!await existe(cwd, base)) return { diff: null, raison: `base ${base.slice(0, 8)} absente du clone` };
  return { base, head, diff: await git.diffRange(cwd, base, head, onLog) };
}

module.exports = { refLocale, refspec, fetchMrRefs, refARelire, diffARelire, diffSansBaseCommune };
