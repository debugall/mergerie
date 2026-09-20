'use strict';
/* SNAPSHOTS ET DOSSIERS DE JOB — créés et détruits ICI, jamais par le backend de sandbox
 * lui-même (qui ne fait que MONTER ce qui existe déjà, voir `backends/linux.js`).
 *
 * Le clone partagé n'est jamais touché : une source est une extraction `git archive` — un arbre
 * de fichiers SANS `.git`, donc sans lien arrière vers le clone, ses remotes ou ses jetons —
 * plutôt qu'un `git worktree add` (qui garde un `.git` pointant HORS du dossier, par construction
 * inutilisable une fois ce dossier monté seul, et une fuite du chemin du clone s'il l'était). Le
 * prix : un job en sandbox ne peut pas lancer `git log`/`git blame` lui-même — le contexte
 * d'historique, quand il compte, reste celui que Mergerie assemble dans le prompt (§4.2 du plan).
 *
 * `plan`/`edit` reçoivent une COPIE de cette même extraction comme worktree éditable ; le patch
 * final se calcule en comparant les deux arbres après coup, jamais avec `git diff` (qui
 * demanderait un `.git`, donc le problème ci-dessus).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SANDBOX_JOBS_DIR } = require('../core/paths');
const git = require('../git/git');
const { erreurSandbox } = require('./errors');

/* `localDir` (worktree de vérification déjà préparé par l'appelant, §6.5) : ni `source-ro` ni
 * `worktree-rw` ne sont créés ici — le montage vise directement `spec.source.sourcePath`
 * (`sandbox/paths.js`), et ce dossier n'appartient pas à ce job : ni copié, ni détruit par lui. */
function creerLayout(jobId, { worktree = false, localDir = false } = {}) {
  const racine = path.join(SANDBOX_JOBS_DIR, String(jobId));
  const layout = {
    racine,
    sourceRo: localDir ? null : path.join(racine, 'source-ro'),
    worktreeRw: (worktree && !localDir) ? path.join(racine, 'worktree-rw') : null,
    scratch: path.join(racine, 'scratch'),
    home: path.join(racine, 'home'),
    out: path.join(racine, 'out'),
    logs: path.join(racine, 'logs'),
  };
  for (const d of Object.values(layout)) if (d) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return layout;
}

/** Extrait la révision `sha` du clone dans `dest` (déjà créé), sans `.git` : `git archive` en
 *  flux vers `tar -x`. Jamais via `git.run` — son stdout est capturé en chaîne, ce qui
 *  corromprait un flux tar binaire. */
function archiverVersDossier(clone, sha, dest) {
  return new Promise((resolvePromise, reject) => {
    const archive = spawn('git', git.argsDurcis(['archive', '--format=tar', sha]), { cwd: clone, env: git.envGit() });
    const tar = spawn('tar', ['-x', '-C', dest]);
    archive.stdout.pipe(tar.stdin);
    let erreurArchive = '';
    let erreurTar = '';
    archive.stderr.on('data', (d) => { erreurArchive += d; });
    tar.stderr.on('data', (d) => { erreurTar += d; });
    let fini = false;
    const terminer = (err) => { if (fini) return; fini = true; (err ? reject(err) : resolvePromise()); };
    archive.on('error', terminer);
    tar.on('error', terminer);
    archive.on('close', (code) => { if (code !== 0) terminer(new Error(`git archive a échoué (${code}) : ${erreurArchive}`)); });
    tar.on('close', (code) => terminer(code !== 0 ? new Error(`tar -x a échoué (${code}) : ${erreurTar}`) : undefined));
  });
}

/** Copie une extraction déjà faite (source-ro) vers un worktree éditable — deux arbres
 *  indépendants, pour que le patch final se calcule par comparaison de contenu. */
function copierDossier(depuis, vers) {
  fs.cpSync(depuis, vers, { recursive: true });
}

/** Chaque lien symbolique sous `dir`, chemin relatif à `dir`. Un job n'a jamais besoin d'en créer
 *  un dans son worktree : plus sûr d'en refuser la présence entière que de tenter de distinguer
 *  un lien « interne » d'un lien qui s'évaderait une fois le patch appliqué ailleurs. */
function listerLiens(dir) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('find', [dir, '-type', 'l']);
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0
      ? resolvePromise(out.split('\n').filter(Boolean).map((p) => path.relative(dir, p)))
      : reject(new Error(err))));
  });
}

function diffArbres(baseline, worktreeRw) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('diff', ['-ruN', '--exclude=.git', baseline, worktreeRw]);
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    // `diff` renvoie 1 quand des différences existent — c'est le cas normal, pas 0.
    proc.on('close', (code) => (code === 2 ? reject(new Error(`diff a échoué : ${err}`)) : resolvePromise(out)));
  });
}

/** Calcule le patch d'un job `plan`/`edit`, refuse tout lien symbolique produit et toute taille
 *  au-delà de `limits.fileBytes`, puis l'écrit dans `out/patch.diff`. */
async function collecterSortie(baseline, worktreeRw, outDir, limits) {
  const liens = await listerLiens(worktreeRw);
  if (liens.length) throw erreurSandbox('SANDBOX_SYMLINK_ESCAPE', { chemin: liens[0] });
  const patch = await diffArbres(baseline, worktreeRw);
  if (Buffer.byteLength(patch) > limits.fileBytes) throw erreurSandbox('SANDBOX_LIMIT_EXCEEDED', { limite: 'fileBytes' });
  const patchPath = path.join(outDir, 'patch.diff');
  fs.writeFileSync(patchPath, patch, { mode: 0o600 });
  return { patchPath, bytes: Buffer.byteLength(patch) };
}

/** Octets sous `dir`, récursif — pour surveiller `diskBytes` pendant qu'un job tourne (les
 *  cgroups ne bornent ni la taille d'un dossier ni celle d'un tmpfs monté par bwrap). */
function tailleDossier(dir) {
  let total = 0;
  let pile;
  try { pile = [dir]; } catch { return 0; }
  while (pile.length) {
    const courant = pile.pop();
    let entrees;
    try { entrees = fs.readdirSync(courant, { withFileTypes: true }); } catch { continue; }
    for (const e of entrees) {
      const p = path.join(courant, e.name);
      if (e.isSymbolicLink()) continue; // jamais suivi : sa taille propre, pas celle de sa cible
      if (e.isDirectory()) { pile.push(p); continue; }
      try { total += fs.statSync(p).size; } catch { /* disparu entre-temps */ }
    }
  }
  return total;
}

/** Fichiers sous `dir`, récursif — même logique que `tailleDossier`, pour surveiller `files`
 *  pendant qu'un job tourne. */
function compterFichiers(dir) {
  let total = 0;
  const pile = [dir];
  while (pile.length) {
    const courant = pile.pop();
    let entrees;
    try { entrees = fs.readdirSync(courant, { withFileTypes: true }); } catch { continue; }
    for (const e of entrees) {
      const p = path.join(courant, e.name);
      if (e.isSymbolicLink()) { total += 1; continue; }
      if (e.isDirectory()) { pile.push(p); continue; }
      total += 1;
    }
  }
  return total;
}

/** Détruit le dossier d'un job — best-effort : un ménage qui échoue ne doit jamais faire
 *  échouer le job lui-même (§ Definition of Done : « aucune fuite… », pas « aucune erreur »). */
function nettoyerJob(layout) {
  try { fs.rmSync(layout.racine, { recursive: true, force: true }); return true; }
  catch { return false; } // pas de rethrow : un ménage qui échoue ne doit jamais faire échouer le job
}

/** Dossiers de jobs restés d'un arrêt brutal (coupure, kill -9) — ramassés au démarrage, comme
 *  `verify/verifyrun.js` le fait déjà pour ses worktrees. */
function gcJobs() {
  if (!fs.existsSync(SANDBOX_JOBS_DIR)) return 0;
  let n = 0;
  for (const nom of fs.readdirSync(SANDBOX_JOBS_DIR)) {
    try { fs.rmSync(path.join(SANDBOX_JOBS_DIR, nom), { recursive: true, force: true }); n += 1; }
    catch { /* un dossier récalcitrant ne doit pas empêcher le serveur de démarrer */ }
  }
  return n;
}

module.exports = {
  creerLayout, archiverVersDossier, copierDossier, listerLiens, diffArbres, collecterSortie,
  tailleDossier, compterFichiers, nettoyerJob, gcJobs,
};
