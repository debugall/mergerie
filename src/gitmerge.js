'use strict';
/* MERGER UNE BRANCHE DANS UNE AUTRE, conflits compris (onglet Git → Merge).
 *
 * Trois partis pris, qui expliquent tout le reste du fichier.
 *
 * 1. LE MERGE VIT DANS SON PROPRE WORKTREE, jamais dans le clone partagé. Un merge se résout
 *    en plusieurs minutes et plusieurs requêtes ; laisser le clone à moitié fusionné pendant ce
 *    temps bloquerait tout ce qui le touche — reviews, sessions, vérifications — et le premier
 *    `ensureCleanWorktree` venu l'annulerait sans prévenir.
 *
 * 2. ON TRAVAILLE EN DÉTACHÉ, depuis `origin/<destination>`, et on pousse `HEAD:<destination>`.
 *    Aucune branche locale n'est créée ni déplacée : impossible d'entrer en conflit avec la
 *    branche que le clone principal a sortie, et impossible de laisser une branche locale en
 *    avance sur la distante après coup. Ce qui compte est ce qui part sur la forge.
 *
 * 3. GIT EST LA SOURCE DE VÉRITÉ, pas une machine à états parallèle. Les fichiers en conflit se
 *    relisent à chaque fois (`--diff-filter=U`), la résolution est un `write` + `git add`, le
 *    message de commit vient de `MERGE_MSG` que git a lui-même écrit. La table `git_merge` ne
 *    retient que ce que git ne sait pas : quel dossier appartient à quelle demande.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const git = require('./git');
const { DATA_DIR, ensureDir } = require('./paths');
const { t } = require('../public/i18n-runtime.js');
const { decouper, recoller } = require('./conflits');

/* Répertoire SÉPARÉ de celui des vérifications : `verifyrun.gcWorktrees` vide le sien à chaque
   démarrage, ce qui jetterait une résolution en cours. Un merge, lui, se reprend après un
   redémarrage — les fichiers résolus sont déjà dans son index. */
const MERGES_DIR = path.join(DATA_DIR, 'merges');

const assainir = (x) => String(x).replace(/[^\w.-]+/g, '_');

function repoDe(id) {
  const r = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(id));
  if (!r) throw new Error(t('err.depot-introuvable'));
  return r;
}

function ligne(id) {
  const m = db.prepare('SELECT * FROM git_merge WHERE id = ?').get(Number(id));
  if (!m) throw new Error(t('err.merge.not-found'));
  return m;
}

/** Les fichiers que git laisse « unmerged », relus à chaque fois. */
async function enConflit(dir) {
  const { stdout } = await git.run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Ce que le merge a préparé et qui est prêt à partir (résolu ou repris sans conflit). */
async function prets(dir) {
  const { stdout } = await git.run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/* LE MESSAGE PRÉ-REMPLI.
 *
 * La PREMIÈRE LIGNE est écrite ici, pas reprise de git. Comme on travaille en détaché sur
 * `origin/<destination>`, git propose « Merge remote-tracking branch 'origin/x' into HEAD » :
 * exact, et illisible — « into HEAD » ne dit rien à personne. On rend la formule que l'auteur
 * attend : « Merge branch 'source' into destination ».
 *
 * Le RESTE de `MERGE_MSG`, lui, est repris tel quel : c'est là que git énumère les fichiers qui
 * ont été en conflit, et cette liste a sa place dans l'historique. */
async function messageParDefaut(dir, m) {
  const premiere = `Merge branch '${m.source_branch}' into ${m.target_branch}`;
  try {
    const { stdout } = await git.run('git', ['rev-parse', '--git-path', 'MERGE_MSG'], { cwd: dir });
    const f = path.resolve(dir, stdout.trim());
    if (!fs.existsSync(f)) return premiere;
    const suite = fs.readFileSync(f, 'utf8')
      .split('\n').filter((l) => !l.startsWith('#')).slice(1).join('\n').trim();
    return suite ? `${premiere}\n\n${suite}` : premiere;
  } catch { return premiere; }
}

/** L'état complet, tel que l'écran le consomme. Recalculé, jamais mémorisé. */
async function etat(id) {
  const m = ligne(id);
  const repo = repoDe(m.repo_id);
  if (!fs.existsSync(m.dir)) {
    /* Le dossier a disparu (ménage manuel, disque nettoyé). On le dit au lieu de laisser
       l'écran interroger un chemin mort à chaque rafraîchissement. */
    return { ...m, project: repo.project, forge: repo.forge, perdu: true, conflits: [], prets: [] };
  }
  const conflits = m.status === 'committed' || m.status === 'pushed' ? [] : await enConflit(m.dir);
  return {
    ...m,
    project: repo.project,
    forge: repo.forge,
    perdu: false,
    conflits,
    prets: m.status === 'committed' || m.status === 'pushed' ? [] : await prets(m.dir),
    message: m.status === 'conflict' || m.status === 'ready' ? await messageParDefaut(m.dir, m) : '',
  };
}

/* DÉMARRER. `--no-commit --no-ff` : on veut TOUJOURS passer par l'écran de commit, même quand
   la destination pourrait simplement avancer — c'est le geste que l'utilisateur a demandé, et
   un merge qui se serait fait tout seul sans rien montrer serait déroutant. */
async function demarrer(cfg, { repo_id: repoId, source, target, allow_unrelated: sansAncetre }, onLog = () => {}) {
  const repo = repoDe(repoId);
  if (!source || !target) throw new Error(t('err.merge.branches-required'));
  if (source === target) throw new Error(t('err.merge.same-branch'));

  const dejaLa = db.prepare(`SELECT * FROM git_merge WHERE repo_id = ? AND status IN ('conflict','ready')`).get(repo.id);
  if (dejaLa) throw new Error(t('err.merge.already-running', { source: dejaLa.source_branch, target: dejaLa.target_branch }));

  const clone = await git.ensureRepo(cfg, repo, onLog);
  try { await git.run('git', ['worktree', 'prune'], { cwd: clone }); } catch { /* best effort */ }
  ensureDir(MERGES_DIR);
  const dir = path.join(MERGES_DIR, `${assainir(repo.project)}-${assainir(target)}-${assainir(source)}`);
  if (fs.existsSync(dir)) await retirer(clone, dir);

  for (const ref of [`origin/${target}`, `origin/${source}`]) {
    if (!await git.refExists(clone, ref)) throw new Error(t('err.merge.ref-missing', { ref }));
  }
  /* DEUX BRANCHES SANS ANCÊTRE COMMUN. Git refuse de les fusionner, et il a raison : ça arrive
     quand une branche a été créée avec `--orphan`, quand un dépôt a été réinitialisé, ou quand
     `master` et `main` ont chacun leur racine. Le résultat n'est alors pas une fusion mais une
     juxtaposition de deux projets, souvent avec des conflits partout.
     On ne force donc pas d'office : on l'explique, et on laisse demander explicitement. Sans ce
     contrôle, l'utilisateur reçoit « fatal: refusing to merge unrelated histories » — la sortie
     brute de git, qui ne dit ni pourquoi ni quoi faire. */
  if (!sansAncetre) {
    let ancetre = '';
    try {
      const { stdout } = await git.run('git', ['merge-base', `origin/${target}`, `origin/${source}`], { cwd: clone });
      ancetre = stdout.trim();
    } catch { ancetre = ''; }
    if (!ancetre) {
      const e = new Error(t('err.merge.unrelated', { source, target }));
      e.code = 'UNRELATED';
      throw e;
    }
  }
  await git.run('git', ['worktree', 'add', '--detach', dir, `origin/${target}`], { cwd: clone, onLog });

  let status = 'ready';
  try {
    await git.run('git', ['merge', '--no-commit', '--no-ff',
      ...(sansAncetre ? ['--allow-unrelated-histories'] : []), `origin/${source}`], { cwd: dir, onLog });
  } catch (e) {
    const conflits = await enConflit(dir);
    if (!conflits.length) {                       // échec pour une autre raison : on nettoie
      await retirer(clone, dir);
      throw e;
    }
    status = 'conflict';
  }
  /* « Déjà à jour » : git n'a rien à faire, il n'y a donc rien à commiter. On ne crée pas une
     demande fantôme que l'écran afficherait avec un bouton « Commiter » sans effet. */
  if (status === 'ready' && !(await prets(dir)).length) {
    await retirer(clone, dir);
    throw new Error(t('err.merge.already-merged', { source, target }));
  }

  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO git_merge
    (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(repo.id, source, target, dir, status, now, now);
  return etat(info.lastInsertRowid);
}

/* RÉSOUDRE UN FICHIER. Le contenu vient de l'écran : c'est le texte que l'utilisateur a validé,
   qu'il l'ait obtenu par un bouton « Garder » ou en éditant à la main. On n'accepte QUE des
   chemins que git déclare en conflit — un chemin libre laisserait écrire n'importe où sur le
   disque depuis le navigateur. */
async function resoudre(id, fichier, { contenu = null, choix = null } = {}) {
  const m = ligne(id);
  const conflits = await enConflit(m.dir);
  if (!conflits.includes(fichier)) throw new Error(t('err.merge.file-not-conflicted', { file: fichier }));
  const abs = path.join(m.dir, fichier);
  /* DEUX FAÇONS DE RÉSOUDRE, UN SEUL ASSEMBLEUR. Les boutons « garder celle-ci / celle-là /
     les deux » envoient des CHOIX, et c'est le serveur qui recolle : l'écran n'a pas sa propre
     version de la règle, qui finirait par diverger de celle qu'on teste. L'édition à la main,
     elle, envoie le texte — par définition c'est celui que l'utilisateur a écrit. */
  const texte = contenu != null
    ? String(contenu)
    : recoller(decouper(fs.readFileSync(abs, 'utf8')), Array.isArray(choix) ? choix : []);
  fs.writeFileSync(abs, texte, 'utf8');
  await git.run('git', ['add', '--', fichier], { cwd: m.dir });
  const reste = await enConflit(m.dir);
  const status = reste.length ? 'conflict' : 'ready';
  db.prepare('UPDATE git_merge SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), m.id);
  return etat(m.id);
}

/** Le contenu d'un fichier en conflit, tel qu'il est sur le disque (marqueurs compris). */
function contenu(id, fichier) {
  const m = ligne(id);
  const abs = path.join(m.dir, fichier);
  /* `path.resolve` puis comparaison au dossier : un `../` dans le nom sortirait du worktree. */
  if (!path.resolve(abs).startsWith(path.resolve(m.dir) + path.sep)) {
    throw new Error(t('err.merge.file-not-conflicted', { file: fichier }));
  }
  if (!fs.existsSync(abs)) throw new Error(t('err.merge.file-not-conflicted', { file: fichier }));
  return fs.readFileSync(abs, 'utf8');
}

/* COMMITER. On refuse tant qu'il reste un conflit : `git commit` le refuserait de toute façon,
   mais avec un message que personne ne lit. */
async function commiter(id, message, onLog = () => {}) {
  const m = ligne(id);
  if ((await enConflit(m.dir)).length) throw new Error(t('err.merge.still-conflicted'));
  const texte = String(message || '').trim();
  if (!texte) throw new Error(t('err.merge.message-required'));
  await git.run('git', ['commit', '-m', texte], { cwd: m.dir, onLog });
  const { stdout } = await git.run('git', ['rev-parse', 'HEAD'], { cwd: m.dir });
  db.prepare("UPDATE git_merge SET status = 'committed', commit_sha = ?, updated_at = ? WHERE id = ?")
    .run(stdout.trim(), new Date().toISOString(), m.id);
  return etat(m.id);
}

/* POUSSER. `HEAD:refs/heads/<destination>` : on pousse le commit obtenu vers la branche visée,
   sans jamais avoir créé de branche locale. Pas de forçage — un merge AJOUTE un commit, il ne
   réécrit rien ; si la forge refuse, c'est que la destination a bougé, et il faut refaire le
   merge plutôt que d'écraser le travail de quelqu'un. */
async function pousser(cfg, id, onLog = () => {}) {
  const m = ligne(id);
  if (m.status !== 'committed') throw new Error(t('err.merge.commit-first'));
  await git.run('git', [...git.gitTlsArgs(), 'push', 'origin', `HEAD:refs/heads/${m.target_branch}`],
    { cwd: m.dir, onLog, redactSecrets: git.secretsOf(cfg) });
  db.prepare("UPDATE git_merge SET status = 'pushed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), m.id);
  return etat(m.id);
}

async function retirer(clone, dir) {
  try { await git.run('git', ['worktree', 'remove', '--force', dir], { cwd: clone }); }
  catch { /* on insiste ci-dessous */ }
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch { /* le ménage ne doit jamais faire échouer l'appel */ }
}

/* ABANDONNER. Le worktree part avec la demande : un merge à moitié résolu qu'on garderait
   « au cas où » réapparaîtrait plus tard sans qu'on sache d'où il sort. */
async function abandonner(cfg, id) {
  const m = ligne(id);
  const repo = repoDe(m.repo_id);
  await retirer(git.cloneDirFor(cfg, repo), m.dir);
  db.prepare('DELETE FROM git_merge WHERE id = ?').run(m.id);
  return { ok: true };
}

/** Les merges non soldés, pour que l'écran puisse en reprendre un. */
function enCours() {
  return db.prepare(`SELECT gm.*, repo.project, repo.forge FROM git_merge gm
    JOIN repo ON repo.id = gm.repo_id
    WHERE gm.status IN ('conflict','ready','committed') ORDER BY gm.id DESC`).all();
}

module.exports = {
  MERGES_DIR, demarrer, etat, resoudre, contenu, commiter, pousser, abandonner, enCours,
  // Réexportés par commodité pour les routes ; ils vivent dans `conflits.js`, qui ne touche
  // NI la base NI le disque — c'est ce qui les rend testables sans démarrer l'application.
  decouper, recoller,
};
