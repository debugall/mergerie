'use strict';
/* CE QU'UNE ITÉRATION HORS DÉPÔT A CHANGÉ — sans rien poser dans le dossier de l'utilisateur.
 *
 * Le codage hors dépôt travaille EN PLACE dans un dossier arbitraire : pas de branche, pas de
 * commit, donc rien à comparer. Relire un suivi obligeait à ouvrir les fichiers et à deviner ce
 * qui venait de bouger — exactement le problème que le diff par itération résout côté dépôt.
 *
 * On tient donc un git de SUIVI dont le dépôt vit dans le dossier de travail de Mergerie et
 * dont l'arbre de travail est le dossier de l'utilisateur (`core.worktree`) : deux commits par
 * passe, un avant, un après, et le diff entre les deux. Le dossier de l'utilisateur ne reçoit
 * AUCUN fichier — pas même un `.git` : c'est la règle que le hors dépôt s'est déjà donnée pour
 * les pièces jointes, et elle vaut ici pour la même raison. Un dossier qui est DÉJÀ un dépôt
 * git n'est pas touché non plus : son `.git` à lui n'est jamais ni lu ni écrit, et git refuse
 * de toute façon d'indexer un répertoire nommé `.git`.
 *
 * Ce qui est exclu : ce que le dossier ignore déjà (son `.gitignore` est respecté) plus les
 * dossiers d'artefacts et de dépendances, qui pèsent tout et n'apprennent rien.
 *
 * Et un GARDE-FOU de volume. Le dossier est choisi par l'utilisateur : il peut contenir un
 * demi-million de fichiers. Indexer cela retarderait le codage lui-même — alors que la mesure
 * n'est qu'une commodité de relecture. Au-delà du plafond, on renonce UNE FOIS POUR TOUTES sur
 * ce dossier (un témoin sur disque, pour ne pas recompter à chaque passe) et l'écran se tait,
 * comme pour une session antérieure à cette mesure. Se taire vaut mieux que ralentir.
 *
 * Tout est best-effort : un codage qui a réussi ne doit jamais échouer parce que son journal
 * n'a pas pu s'écrire.
 */

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const { TASKS_DIR, ensureDir } = require('./paths');

/* Au-delà, on renonce : la mesure coûterait plus que ce qu'elle rend. Un objet plutôt que deux
   constantes, pour qu'un test puisse abaisser le plafond et vérifier le renoncement — atteindre
   vingt mille fichiers pour de vrai prendrait plus longtemps que tout le reste de la suite. */
const LIMITES = { fichiers: 20000, octets: 512 * 1024 * 1024 };

/* Ce que le suivi ignore en plus du `.gitignore` du dossier : des dépendances et des
   artefacts de build. Ils pèsent l'essentiel d'un dossier de projet et ne disent rien de ce
   que l'IA a écrit — les voir apparaître dans le diff d'un suivi le rendrait illisible. */
const EXCLUSIONS = [
  'node_modules/', 'vendor/', 'bower_components/',
  'dist/', 'build/', 'out/', 'target/', 'coverage/',
  '.venv/', 'venv/', '__pycache__/', '.tox/', '.mypy_cache/', '.pytest_cache/',
  '.next/', '.nuxt/', '.svelte-kit/', '.parcel-cache/', '.cache/',
  '.gradle/', '.terraform/', '.idea/', '.vscode/',
  '.DS_Store',
];

function dossierSuivi(taskId, dirId) {
  return path.join(TASKS_DIR, 'local', String(taskId), String(dirId), 'suivi.git');
}
const temoinRenonce = (g) => path.join(g, 'MERGERIE_RENONCE');

/* Le dépôt de suivi, créé à la première passe. `--bare` puis `core.bare false` + `core.worktree` :
   c'est la recette qui permet de suivre un dossier SANS y déposer de `.git`. L'identité est
   posée LOCALEMENT — ces commits ne sortent jamais d'ici, et dépendre d'un `user.email` global
   ferait échouer la mesure sur une machine qui n'en a pas. */
async function preparer(gitdir, chemin, onLog) {
  if (fs.existsSync(path.join(gitdir, 'HEAD'))) return true;
  ensureDir(path.dirname(gitdir));
  await git.run('git', ['init', '--bare', '-q', gitdir], {});
  const cfg = async (k, v) => git.run('git', ['--git-dir', gitdir, 'config', k, v], {});
  await cfg('core.bare', 'false');
  await cfg('core.worktree', path.resolve(chemin));
  await cfg('user.name', 'Mergerie');
  await cfg('user.email', 'mergerie@localhost');
  fs.writeFileSync(path.join(gitdir, 'info', 'exclude'), `${EXCLUSIONS.join('\n')}\n`, 'utf8');

  /* LE COMPTE, une seule fois. `ls-files -o --exclude-standard` liste exactement ce que le
     premier `add -A` prendrait : le `.gitignore` du dossier et nos exclusions sont déjà
     appliqués. Un dossier démesuré fait déborder le tampon — c'est déjà la réponse. */
  let fichiers = [];
  try {
    const { stdout } = await git.run('git', ['--git-dir', gitdir, 'ls-files', '-o', '--exclude-standard'],
      { cwd: chemin, maxBuffer: 1024 * 1024 * 8 });
    fichiers = stdout.split('\n').filter(Boolean);
  } catch { return renoncer(gitdir, onLog, 'dossier trop vaste pour être mesuré'); }
  if (fichiers.length > LIMITES.fichiers) return renoncer(gitdir, onLog, `${fichiers.length} fichiers`);
  let octets = 0;
  for (const f of fichiers) {
    try { octets += fs.statSync(path.join(chemin, f)).size; } catch { /* disparu entre-temps */ }
    if (octets > LIMITES.octets) return renoncer(gitdir, onLog, `plus de ${Math.round(LIMITES.octets / 1024 / 1024)} Mo`);
  }
  return true;
}

function renoncer(gitdir, onLog, raison) {
  try { fs.writeFileSync(temoinRenonce(gitdir), `${raison}\n`, 'utf8'); } catch { /* best-effort */ }
  onLog(`⚠ diff par itération non mesuré (${raison}) — le codage, lui, se poursuit normalement.`);
  return false;
}

// Un commit de l'état courant du dossier. `--allow-empty` : l'absence de changement est une
// information, et c'est le commit vide qui permet de la dire au lieu de ne rien montrer.
async function commiter(gitdir, message) {
  await git.run('git', ['--git-dir', gitdir, 'add', '-A'], { maxBuffer: 1024 * 1024 * 32 });
  await git.run('git', ['--git-dir', gitdir, 'commit', '-q', '--allow-empty', '-m', message], {});
  const { stdout } = await git.run('git', ['--git-dir', gitdir, 'rev-parse', 'HEAD'], {});
  return stdout.trim();
}

/* L'état du dossier AVANT que l'agent n'y touche. `null` = pas de mesure pour ce dossier ;
   l'appelant ne fera rien de plus, et l'écran se taira. */
async function avant(taskId, dirId, chemin, onLog = () => {}) {
  const gitdir = dossierSuivi(taskId, dirId);
  try {
    if (fs.existsSync(temoinRenonce(gitdir))) return null;
    if (!(await preparer(gitdir, chemin, onLog))) return null;
    return await commiter(gitdir, 'avant');
  } catch { return null; }
}

/* …et APRÈS. Renvoie le SHA d'arrivée et le patch entre les deux — vide quand l'itération n'a
   rien changé, ce qui est une réponse en soi. */
async function apres(taskId, dirId, shaAvant, onLog = () => {}) {
  const gitdir = dossierSuivi(taskId, dirId);
  try {
    const sha = await commiter(gitdir, 'apres');
    if (sha === shaAvant) return { sha, diff: '' };
    const diff = await git.diffRange(gitdir, shaAvant, sha);
    return { sha, diff };
  } catch (e) {
    onLog(`⚠ diff par itération non mesuré : ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

module.exports = { avant, apres, dossierSuivi, LIMITES };
