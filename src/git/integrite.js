'use strict';
/* LECTURE SEULE, PROUVÉE APRÈS COUP (plan_secure.md, lot A, point 5).
 *
 * `--restricted`, `Write`/`Edit` interdits : c'est ce que les FLAGS du CLI promettent. Ça ne
 * dit rien de Copilot, qui n'a pas d'équivalent vérifié, ni d'un CLI qui aurait un bug, ni d'un
 * outil qu'on aurait oublié d'interdire. La preuve, ici, n'est pas demandée à l'agent : on relève
 * l'état du dépôt avant le run, et on le compare à ce qu'il est après.
 *
 * QUATRE CHOSES, parce que `git status --porcelain` ne voit que le suivi Git normal :
 *   — HEAD (rev-parse) : un commit ne devrait jamais bouger pendant une lecture ;
 *   — le statut (status --porcelain) : fichiers modifiés, créés, supprimés, dans l'INDEX ou pas ;
 *   — `.git/config` : hors du suivi Git — un remote ou un alias ajouté là n'apparaît dans AUCUN
 *     `git status` ;
 *   — `.git/hooks` : hors du suivi Git aussi — un hook planté ici ne s'exécute pas sous les
 *     commandes DURCIES de Mergerie (`git.durcissement()` vide `core.hooksPath`), mais tournerait
 *     à la prochaine commande git lancée par l'utilisateur ou un autre outil, sans rapport avec
 *     ce run.
 *
 * `--git-common-dir` (pas `--git-dir`) pour `config`/`hooks` : dans un WORKTREE, ils sont
 * PARTAGÉS avec le dépôt principal — c'est `--git-dir` qui varie d'un worktree à l'autre.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run } = require('./git');

async function sortieOuNull(cmd, args, cwd) {
  try { return (await run(cmd, args, { cwd })).stdout; } catch { return null; }
}

async function dossierGit(cwd, commun) {
  const sortie = await sortieOuNull('git', ['rev-parse', commun ? '--git-common-dir' : '--git-dir'], cwd);
  if (sortie == null) return null;
  const rel = sortie.trim();
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/* Empreinte d'un fichier hors suivi Git (`.git/config`) : absent → une valeur constante
   distincte de « illisible », pour qu'un fichier qui apparaît ou disparaît compte comme un
   changement au même titre qu'un contenu différent. */
function empreinteFichier(chemin) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex');
  } catch { return 'absent'; }
}

/* Empreinte d'un DOSSIER hors suivi Git (`.git/hooks`) : noms ET contenus, triés — un hook
   renommé ou son contenu changé doit se voir, l'ordre du système de fichiers ne doit pas. */
function empreinteDossier(chemin) {
  let noms;
  try { noms = fs.readdirSync(chemin).sort(); } catch { return 'absent'; }
  const h = crypto.createHash('sha256');
  for (const nom of noms) {
    h.update(nom);
    h.update(empreinteFichier(path.join(chemin, nom)));
  }
  return h.digest('hex');
}

/** L'état du dépôt à cet instant — à appeler avant ET après un run en lecture seule. */
async function empreindre(cwd) {
  const [head, statut] = await Promise.all([
    sortieOuNull('git', ['rev-parse', 'HEAD'], cwd),
    sortieOuNull('git', ['status', '--porcelain'], cwd),
  ]);
  const commun = await dossierGit(cwd, true);
  return {
    head: head == null ? null : head.trim(),
    statut: statut == null ? null : statut.trim(),
    config: commun ? empreinteFichier(path.join(commun, 'config')) : 'introuvable',
    hooks: commun ? empreinteDossier(path.join(commun, 'hooks')) : 'introuvable',
  };
}

/** `null` si rien n'a bougé, sinon la liste des champs qui ont changé (pour le journal).
 *  Pas de dépôt AVANT le run (hors dépôt, dossier qui n'est pas un clone) : rien à comparer,
 *  jamais un « compromis ». Mais un dépôt LISIBLE avant et illisible après (`.git` supprimé,
 *  par exemple) EST un changement — on ne l'efface pas en traitant l'échec comme une absence
 *  de preuve des deux côtés. */
function comparer(avant, apres) {
  if (!avant || avant.head == null) return null;
  if (!apres) return ['head', 'statut', 'config', 'hooks'];
  const changes = ['head', 'statut', 'config', 'hooks'].filter((c) => avant[c] !== apres[c]);
  return changes.length ? changes : null;
}

module.exports = { empreindre, comparer };
