'use strict';
/* GIT EN PLACE, POUR UNE SESSION HORS DÉPÔT — facultatif, et seulement quand un nom de branche a
   été donné. Sans lui, `localcoder` reste ce qu'il a toujours été : l'agent écrit dans le dossier,
   rien n'est commité.

   Avec lui, le dossier de l'utilisateur reçoit le même parcours qu'un clone de Mergerie : la
   branche est posée AVANT l'agent, le commit et le push viennent APRÈS. La différence tient en
   une phrase — c'est SON dossier, avec son travail dedans —, d'où deux gardes que `taskrunner`
   n'a pas :
   — on ne change de branche que sur un dossier PROPRE, fichiers non suivis compris (le commit
     fait `add -A` : un `.env` traînant partirait dans l'historique) ;
   — on ne jette jamais rien (`ensureCleanWorktree` fait un `clean -fd`, ici il détruirait le
     travail de l'utilisateur).
   La merge request et la convergence ne sont pas ici : elles demandent la forge, et vivent dans
   `jobs/apres-local.js`. */
const git = require('../git/git');
const { getConfig } = require('../data/config');
const { t } = require('../core/i18n');

const sortie = async (cwd, args) => (await git.run('git', args, { cwd })).stdout.trim();

/* Les règles de `git check-ref-format`, sans lancer git : la route valide à la création, avant
   qu'une session ne parte avec un nom que le checkout refuserait. */
function brancheValide(nom) {
  const n = String(nom || '').trim();
  if (!n || n === '@' || n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.')) return false;
  if (n.includes('..') || n.includes('//') || n.includes('@{') || n.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return false;
  return !n.split('/').some((s) => !s || s.startsWith('.') || s.endsWith('.lock'));
}

async function estDepotGit(cwd) {
  try { return (await sortie(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
}

/** La branche courante, ou `null` en HEAD détaché. */
async function brancheCourante(cwd) {
  const b = await sortie(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  return b && b !== 'HEAD' ? b : null;
}

/**
 * Place la branche de la session dans le dossier, avant que l'agent n'y touche.
 * @returns {Promise<{ base: string|null }>} `base` = la branche sur laquelle se trouvait le
 *   dossier (le point de départ de la MR), `null` quand il était déjà sur la branche de la session.
 */
async function preparer(cwd, branch, onLog = () => {}) {
  if (!(await estDepotGit(cwd))) throw new Error(t('err.local.git-not-repo', { path: cwd }));
  const courante = await brancheCourante(cwd);
  if (courante === branch) return { base: null };
  const sale = await sortie(cwd, ['status', '--porcelain']);
  if (sale) throw new Error(t('err.local.git-dirty', { branch, n: sale.split('\n').length }));
  if (await git.refExists(cwd, `refs/heads/${branch}`)) await git.checkoutBranch(cwd, branch, onLog);
  else if (await git.refExists(cwd, `origin/${branch}`)) await git.createBranchFrom(cwd, branch, `origin/${branch}`, onLog);
  else await git.run('git', ['checkout', '-b', branch], { cwd, onLog });
  return { base: courante };
}

/**
 * Commit (et push) de ce que l'agent a écrit. Rien à commiter n'est pas une erreur : l'agent a pu
 * répondre au lieu de coder — le retour de la passe le dit déjà.
 * @returns {Promise<{ committed: boolean, sha: string, pushed: boolean }>}
 */
async function enregistrer(cwd, { branch, message, push }, onLog = () => {}) {
  onLog(`commit : ${message}`);
  const committed = await git.commitAll(cwd, message, onLog);
  const sha = await git.headSha(cwd);
  let pushed = false;
  /* Pousser une branche sans commit de plus que `origin/<branche>` n'a pas de sens ; mais une
     relance après un push refusé n'a rien à commiter ET quelque chose à pousser : on regarde. */
  if (push && (committed || await git.nonPousses(cwd, branch) || !(await git.refExists(cwd, `origin/${branch}`)))) {
    onLog(`push : git push -u origin ${branch}`);
    await git.pushBranch(cwd, branch, onLog, git.secretsOf(getConfig()));
    pushed = true;
    onLog(t('log.task.pushed'));
  } else if (!push) {
    onLog(t('log.task.commit-ready'));
  }
  return { committed, sha, pushed };
}

module.exports = { brancheValide, estDepotGit, brancheCourante, preparer, enregistrer };
