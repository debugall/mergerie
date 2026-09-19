'use strict';
/* La visionneuse de diff : le contexte d’un clone, un fichier, son diff, et la charge utile que l’écran affiche.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const garde = require('../../core/garde');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const forge = require('../../forge');
const git = require('../../git/git');
const path = require('path');
const fs = require('fs');
const { readFileSafe } = require('../http');

// Ensemble des fichiers modifiés (chemins « b/ ») extraits d'un diff unifié.
function changedFilesFromDiff(diff) {
  const set = new Set();
  if (!diff) return set;
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(diff))) set.add(m[2]);
  return set;
}
/* LE DIFF D'UNE REVIEW EST UN FICHIER DE CETTE MACHINE — et le collègue ne l'a pas.
 *
 * `review.diff_path` est un chemin local : il ne part pas dans le dépôt de données, et il n'y
 * aurait aucun sens. Le poste qui REÇOIT une review ouvrait donc « le code » sur un arbre sans
 * un seul fichier colorié et un diff vide — le rapport était arrivé, le code à côté duquel le
 * lire, non.
 *
 * On le RECALCULE depuis son clone quand le fichier manque. Un diff de merge request n'est pas
 * une donnée à transporter : c'est une fonction de deux références que tout le monde a. On vise
 * le commit RELU tant que le clone le porte — c'est de celui-là que parle le rapport, et c'est
 * l'arbre qu'on affiche à côté — et on retombe sur la tête de branche sinon (force-push,
 * branche avancée depuis).
 *
 * Aucun `fetch` tant que les références sont là : `/diff` et `/tree` partent EN PARALLÈLE
 * depuis l'écran, et deux fetch simultanés dans le même clone se disputeraient ses verrous.
 */
async function diffDeLaMr(mr, cwdConnu = null) {
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const garde = rev ? readFileSafe(rev.diff_path) : null;
  if (garde) return garde;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo || !mr.target_branch || !(mr.reviewed_sha || mr.source_branch)) return null;
  try {
    let cwd = cwdConnu || git.cloneDirFor(getConfig(), repo);
    const base = `origin/${mr.target_branch}`;
    const vise = async () => (mr.reviewed_sha && await git.refExists(cwd, mr.reviewed_sha)
      ? mr.reviewed_sha
      : (mr.source_branch && await git.refExists(cwd, `origin/${mr.source_branch}`)
        ? `origin/${mr.source_branch}` : null));
    let ref = await vise();
    /* LE CLONE PEUT ÊTRE EN RETARD : une branche créée après le dernier fetch n'y est pas
       encore. On ne va chercher qu'à ce moment-là — pas à chaque ouverture. */
    if (!cwdConnu && (!ref || !await git.refExists(cwd, base))) {
      cwd = await git.ensureRepo(getConfig(), repo, () => {});
      ref = await vise();
    }
    if (!ref || !await git.refExists(cwd, base)) return null;
    return await git.diffTroisPoints(cwd, base, ref);
  } catch { return null; }
}
function mrCloneCtx(mr) {
  const cfg = getConfig();
  const cwd = git.cloneDirFor(cfg, { project: mr.project, forge: mr.forge });
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    throw new Error(t('err.depot-non-clone-localement-lance'));
  }
  const ref = mr.reviewed_sha || `origin/${mr.source_branch}`;
  return { cwd, ref, target: mr.target_branch || 'main' };
}
/* Même contexte pour un PROJET DE SESSION : le viewer plein écran est identique,
   seule la source change (la branche produite par l'IA au lieu de la MR). On vise le
   commit exact produit par la session quand il existe — la branche a pu bouger depuis. */
function targetCloneCtx(tg) {
  const cfg = getConfig();
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cwd = git.cloneDirFor(cfg, repo);
  // Message propre à la session : parler de « relancer une review » n'aurait aucun sens ici.
  if (!fs.existsSync(path.join(cwd, '.git'))) throw new Error(t('err.depot-non-clone-session'));
  return { cwd, ref: tg.commit_sha || `origin/${tg.branch}`, target: tg.base_branch || 'main' };
}
/* --- Corps des trois routes du viewer, partagés MR / session ---------------
   Le chemin demandé est TOUJOURS validé contre l'arborescence de la ref : c'est
   ce qui empêche de lire un fichier hors du dépôt (traversal). */
async function viewerFile(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let content = await git.showFile(ctx.cwd, ctx.ref, p);
  if (content.indexOf(String.fromCharCode(0)) !== -1) content = '(fichier binaire, non affiche)';
  return { path: p, content };
}
async function viewerFileDiff(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let diff = '';
  /* `shaRange` : les deux bornes sont des COMMITS, pas une branche de départ. C'est le cas
     quand on relit une seule itération de codage — `fileDiffFull` préfixerait la base par
     `origin/`, et `origin/<sha>` n'existe pas. */
  try {
    diff = ctx.shaRange
      ? await git.fileDiffRange(ctx.cwd, ctx.target, ctx.ref, p)
      : await git.fileDiffFull(ctx.cwd, ctx.target, ctx.ref, p);
  } catch { diff = ''; }
  return { diff };
}
// Charge utile d'ouverture du viewer : diff complet + arbre marqué + compteurs.
async function viewerPayload(ctx, { diff, source }) {
  const changed = changedFilesFromDiff(diff);
  let files = [];
  try { files = await git.lsTree(ctx.cwd, ctx.ref); } catch { /* arbre indisponible */ }
  return {
    diff,
    source,
    target: ctx.target,
    files: files.map((f) => ({ path: f, changed: changed.has(f) })),
    stats: {
      files: changed.size,
      added: (diff.match(/^\+(?!\+\+)/gm) || []).length,
      removed: (diff.match(/^-(?!--)/gm) || []).length,
    },
  };
}

module.exports = {
  changedFilesFromDiff, diffDeLaMr, mrCloneCtx, targetCloneCtx, viewerFile, viewerFileDiff, viewerPayload,
};
