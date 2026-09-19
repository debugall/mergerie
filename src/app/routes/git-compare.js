'use strict';
/* Comparer le contenu de deux dépôts sans histoire commune, et les refs d’un dépôt.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const forge = require('../../forge');
const git = require('../../git/git');
const demoGit = require('../../demo/git');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { wrap } = require('../http');

/* ---------- Onglet Git : opérations multi-dépôts + explorateur de branches ---------- */

// Refs d'un dépôt, pour alimenter les sélecteurs. Les branches protégées et la
// branche par défaut sont marquées : le front les rend non sélectionnables à la
// suppression plutôt que de laisser l'aperçu les rejeter ensuite.
/* ---------- Comparer le CONTENU de deux dépôts ----------
   Deux dépôts n'ont pas d'histoire commune : `git diff` entre eux n'a aucun sens, et un
   « nombre de commits d'écart » encore moins. Ce qu'on compare, ce sont les ARBRES — la liste
   des fichiers de chaque branche, et le hash de chacun :

     · à gauche seulement / à droite seulement : ce qui manque d'un côté ;
     · des deux côtés mais différents : même chemin, blob différent ;
     · identiques : on n'en rend que le NOMBRE. Sur deux dépôts jumeaux c'est l'écrasante
       majorité des lignes, et c'est la seule liste que personne ne lit.

   Le hash git suffit à décider « identique » : deux fichiers de même contenu ont le même
   objet, quel que soit le dépôt. Aucune lecture de contenu n'est nécessaire. */
const MAX_COMPARE = 2000;
const MAX_FICHIER_COMPARE = 1024 * 1024;   // 1 Mo par côté
/* Une branche et un tag peuvent porter le MÊME nom : `origin/v1.2` ne dit pas lequel des deux
   on veut. L'écran sait ce qui a été choisi, il le dit, et on résout sans deviner. */
function refComplete(kind, nom) {
  return kind === 'tag' ? `refs/tags/${nom}` : `refs/remotes/origin/${nom}`;
}
async function arbreDeBranche(cwd, repo, ref, kind) {
  const complete = refComplete(kind, ref);
  if (!await git.refExists(cwd, complete)) {
    throw new Error(t('err.verify.branch-unknown', { branch: ref, project: repo.project }));
  }
  const { stdout } = await git.run('git', ['ls-tree', '-r', complete], { cwd });
  const arbre = new Map();
  for (const ligne of String(stdout || '').split('\n')) {
    if (!ligne.trim()) continue;
    /* Format historique de `ls-tree` : « <mode> <type> <hash>\t<chemin> ». On ne se sert pas de
       `--format`, arrivé en git 2.36 : cet outil tourne sur les machines des gens. */
    const sep = ligne.indexOf('\t');
    if (sep < 0) continue;
    const [, type, hash] = ligne.slice(0, sep).split(/\s+/);
    if (type !== 'blob') continue;           // sous-modules et arbres : pas des fichiers
    arbre.set(ligne.slice(sep + 1), hash);
  }
  return arbre;
}
app.get('/api/git/compare', wrap(async (req, res) => {
  const lire = (cle) => db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query[cle]));
  const repoA = lire('repo_a');
  const repoB = lire('repo_b');
  if (!repoA || !repoB) throw new Error(t('err.depot-introuvable'));
  const refA = String(req.query.ref_a || '').trim();
  const refB = String(req.query.ref_b || '').trim();
  const kindA = req.query.kind_a === 'tag' ? 'tag' : 'branch';
  const kindB = req.query.kind_b === 'tag' ? 'tag' : 'branch';
  if (!refA) throw new Error(t('err.verify.branch-required', { project: repoA.project }));
  if (!refB) throw new Error(t('err.verify.branch-required', { project: repoB.project }));

  if (demoGit.isDemo()) {
    return res.json(demoGit.compare(repoA.project, { ref: refA, kind: kindA }, repoB.project, { ref: refB, kind: kindB }));
  }

  const cfg = getConfig();
  const [cwdA, cwdB] = await clonesDeComparaison(cfg, repoA, repoB);
  const [a, b] = await Promise.all([
    arbreDeBranche(cwdA, repoA, refA, kindA),
    arbreDeBranche(cwdB, repoB, refB, kindB),
  ]);

  const seulA = []; const seulB = []; const differents = [];
  let identiques = 0;
  for (const [chemin, hash] of a) {
    if (!b.has(chemin)) seulA.push(chemin);
    else if (b.get(chemin) !== hash) differents.push(chemin);
    else identiques += 1;
  }
  for (const chemin of b.keys()) if (!a.has(chemin)) seulB.push(chemin);

  /* On BORNE, et on le dit. Comparer deux dépôts sans rien en commun rendrait des dizaines de
     milliers de lignes que ni l'écran ni personne ne lit — mais une liste tronquée en silence
     se lit comme une liste complète. */
  const tronque = seulA.length > MAX_COMPARE || seulB.length > MAX_COMPARE || differents.length > MAX_COMPARE;
  res.json({
    a: { project: repoA.project, ref: refA, kind: kindA, files: a.size },
    b: { project: repoB.project, ref: refB, kind: kindB, files: b.size },
    only_a: seulA.sort().slice(0, MAX_COMPARE),
    only_b: seulB.sort().slice(0, MAX_COMPARE),
    differ: differents.sort().slice(0, MAX_COMPARE),
    same: identiques,
    tronque,
  });
}));
/* Les deux clones d'une comparaison. Deux côtés sur le MÊME dépôt — comparer `main` à
   `develop` est le cas le plus banal qui soit — ne préparent qu'UN clone : le faire deux fois
   de front lance deux `git clone` dans le même dossier, et le second échoue. */
async function clonesDeComparaison(cfg, repoA, repoB) {
  if (repoA.id === repoB.id) {
    const cwd = await git.ensureRepo(cfg, repoA, () => {});
    return [cwd, cwd];
  }
  return Promise.all([
    git.ensureRepo(cfg, repoA, () => {}),
    git.ensureRepo(cfg, repoB, () => {}),
  ]);
}
/* Le SHA du blob d'un chemin sur une branche, ou null s'il n'y est pas. `rev-parse` refuse
   de lui-même ce qui sort de l'arborescence : le chemin vient de l'écran, mais rien n'oblige
   la requête à venir de l'écran. */
async function shaDuBlob(cwd, ref, kind, chemin) {
  try {
    const { stdout } = await git.run('git', ['rev-parse', '--verify', `${refComplete(kind, ref)}:${chemin}`], { cwd });
    return stdout.trim() || null;
  } catch { return null; }
}
/* Un blob écrit tel quel sur disque. `git cat-file` sort des OCTETS : les faire transiter par
   une chaîne JS abîmerait tout ce qui n'est pas de l'UTF-8 — or c'est précisément sur ces
   fichiers-là qu'il faut pouvoir dire « binaire » plutôt que d'afficher n'importe quoi. */
function extraireBlob(cwd, sha, dest) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(dest, 'w');
    const child = spawn('git', ['cat-file', 'blob', sha], { cwd, stdio: ['ignore', fd, 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { fs.closeSync(fd); reject(e); });
    child.on('close', (code) => {
      fs.closeSync(fd);
      if (code === 0) resolve(); else reject(new Error(err.trim() || `git cat-file (${code})`));
    });
  });
}
/* `git diff --no-index` sort 1 quand les deux fichiers diffèrent : ce n'est pas une erreur,
   c'est la réponse. D'où ce lancement à part plutôt que `git.run`, qui rejette tout code non
   nul. C'est git qui calcule le diff — et c'est lui qui sait dire qu'un fichier est binaire. */
function diffDeuxFichiers(a, b) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-index', '--unified=3', '--', a, b]);
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve(out);
      else reject(new Error(err.trim() || `git diff (${code})`));
    });
  });
}
/* Le contenu d'un fichier des deux côtés, en diff unifié. Un fichier présent d'un seul côté
   se lit contre le vide : toutes ses lignes en ajout (ou en retrait), ce qui est exactement
   ce qu'on veut voir de ce côté-là. */
app.get('/api/git/compare/file', wrap(async (req, res) => {
  const lire = (cle) => db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query[cle]));
  const repoA = lire('repo_a');
  const repoB = lire('repo_b');
  if (!repoA || !repoB) throw new Error(t('err.depot-introuvable'));
  const refA = String(req.query.ref_a || '').trim();
  const refB = String(req.query.ref_b || '').trim();
  const kindA = req.query.kind_a === 'tag' ? 'tag' : 'branch';
  const kindB = req.query.kind_b === 'tag' ? 'tag' : 'branch';
  if (!refA) throw new Error(t('err.verify.branch-required', { project: repoA.project }));
  if (!refB) throw new Error(t('err.verify.branch-required', { project: repoB.project }));
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.compare.path-required'));

  if (demoGit.isDemo()) {
    return res.json(demoGit.compareFile(repoA.project, { ref: refA, kind: kindA }, repoB.project, { ref: refB, kind: kindB }, chemin));
  }

  const cfg = getConfig();
  const [cwdA, cwdB] = await clonesDeComparaison(cfg, repoA, repoB);
  const cote = async (cwd, ref, kind) => {
    const sha = await shaDuBlob(cwd, ref, kind, chemin);
    if (!sha) return { exists: false, size: 0, sha: null };
    const { stdout } = await git.run('git', ['cat-file', '-s', sha], { cwd });
    return { exists: true, size: Number(stdout.trim()) || 0, sha };
  };
  const [a, b] = await Promise.all([cote(cwdA, refA, kindA), cote(cwdB, refB, kindB)]);
  if (!a.exists && !b.exists) throw new Error(t('err.compare.file-absent', { path: chemin }));

  const entetes = {
    path: chemin,
    a: { project: repoA.project, ref: refA, kind: kindA, exists: a.exists, size: a.size },
    b: { project: repoB.project, ref: refB, kind: kindB, exists: b.exists, size: b.size },
  };
  /* On BORNE. Un fichier de plusieurs mégaoctets rendrait un diff que ni le navigateur ni
     personne ne parcourt — mieux vaut le dire que faire semblant. */
  if (a.size > MAX_FICHIER_COMPARE || b.size > MAX_FICHIER_COMPARE) {
    return res.json({ ...entetes, diff: '', trop_gros: true, binaire: false, identique: false });
  }

  const dir = fs.mkdtempSync(path.join(ensureDir(TMP_DIR), 'cmp-'));
  try {
    const fichiers = [];
    for (const [cle, cwd, cote2] of [['a', cwdA, a], ['b', cwdB, b]]) {
      const dest = path.join(dir, cle);
      if (cote2.exists) await extraireBlob(cwd, cote2.sha, dest);
      else fs.writeFileSync(dest, '');       // l'absence se lit comme un fichier vide
      fichiers.push(dest);
    }
    const diff = await diffDeuxFichiers(fichiers[0], fichiers[1]);
    res.json({
      ...entetes,
      diff,
      binaire: /^Binary files /m.test(diff),
      identique: !diff.trim(),
      trop_gros: false,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));
app.get('/api/git/refs', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const kind = req.query.kind === 'tags' ? 'tags' : 'branches';
  // `repo.url` : un dépôt de démo peut être un VRAI dépôt sur le disque — on lit alors ses refs.
  if (demoGit.isDemo()) return res.json(demoGit.refs(repo.project, kind, repo.url));
  if (kind === 'tags') {
    const api = forge.clientFor(repo);
    const [tags, prot] = await Promise.all([api.listTags(cfg, repo.project), api.listProtectedTags(cfg, repo.project)]);
    return res.json({ kind, refs: tags.map((x) => ({ name: x.name, sha: x.sha, protected: prot.includes(x.name), annotated: x.annotated, date: x.committed_date })) });
  }
  const apiB = forge.clientFor(repo);
  const [branches, prot] = await Promise.all([apiB.listBranchesFull(cfg, repo.project), apiB.listProtectedBranches(cfg, repo.project)]);
  res.json({
    kind,
    default: (branches.find((b) => b.default) || {}).name || null,
    refs: branches.map((b) => ({ name: b.name, sha: b.sha, default: b.default, protected: b.protected || prot.includes(b.name), merged: b.merged, date: b.committed_date, author: b.author })),
  });
}));
