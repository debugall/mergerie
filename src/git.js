'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DEFAULT_CLONE_DIR, ensureDir, slugify } = require('./paths');
const forge = require('./forge');
const proc = require('./proc');
const { t } = require('../public/i18n-runtime.js');

// Émet les lignes complètes d'un buffer vers onLog, renvoie le reste incomplet.
function emitLines(buf, onLog) {
  const norm = buf.replace(/\r/g, '\n');
  const parts = norm.split('\n');
  const remainder = parts.pop();
  for (const p of parts) onLog(p);
  return remainder;
}

// Masque les secrets (token) dans les arguments loggés.
function redact(args, secrets = []) {
  return args.map((a) => {
    let s = String(a);
    for (const sec of secrets) if (sec) s = s.split(sec).join('***');
    s = s.replace(/(\/\/[^:/@]+:)[^@]+@/g, '$1***@'); // //user:pass@ -> //user:***@
    return s;
  });
}

function run(cmd, args, opts = {}) {
  const onLog = opts.onLog;
  const secrets = opts.redactSecrets || [];
  return new Promise((resolve, reject) => {
    if (proc.isCancelled()) return reject(new Error(t('err.job.stopped')));
    if (onLog) onLog(`$ ${cmd} ${redact(args, secrets).join(' ')}`);
    const child = spawn(cmd, args, { ...opts });
    proc.setActive(child);
    let stdout = '';
    let stderr = '';
    let obuf = '';
    let ebuf = '';
    child.stdout.on('data', (d) => { stdout += d; if (onLog) obuf = emitLines(obuf + d, onLog); });
    child.stderr.on('data', (d) => { stderr += d; if (onLog) ebuf = emitLines(ebuf + d, onLog); });
    child.on('error', (e) => { proc.clearActive(child); reject(e); });
    child.on('close', (code) => {
      proc.clearActive(child);
      if (onLog) { if (obuf) onLog(obuf); if (ebuf) onLog(ebuf); }
      if (proc.isCancelled()) return reject(new Error(t('err.job.stopped')));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(t('err.cmd.failed', { cmd: `${cmd} ${redact(args, secrets).join(' ')}`, code, sortie: stderr || stdout })));
    });
  });
}

/* Injecte le token dans une URL https de clone. Le nom d'utilisateur dépend de la
   forge : GitLab attend `oauth2`, GitHub attend `x-access-token`. */
function authUrl(cloneUrl, token, user = 'oauth2') {
  if (!token) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    if (u.protocol === 'https:') {
      u.username = user;
      u.password = token;
      return u.toString();
    }
  } catch { /* URL non https : on laisse tel quel */ }
  return cloneUrl;
}

// Le jeton qui donne accès au dépôt, selon sa forge.
function tokenFor(cfg, repo) {
  return repo && repo.forge === 'github' ? (cfg.github_token || '') : (cfg.access_token || '');
}
// Tous les secrets à masquer dans les logs : on ne sait pas lequel apparaîtra.
function secretsOf(cfg) {
  return [cfg.access_token, cfg.github_token].filter(Boolean);
}

function cloneDirFor(cfg, repo) {
  const base = String(cfg.clone_path || DEFAULT_CLONE_DIR).trim();
  const proj = forge.clientFor(repo).normalizeProject(repo.project) || repo.project;
  return path.join(base, slugify(proj));
}

// Config TLS passée à git, alignée sur les réglages de l'API Node.
function gitTlsArgs() {
  if (process.env.GITLAB_CA_CERT) return ['-c', `http.sslCAInfo=${process.env.GITLAB_CA_CERT}`];
  if (process.env.GITLAB_INSECURE_TLS === '1') return ['-c', 'http.sslVerify=false'];
  return [];
}

// URL de clone : SSH tel quel ; sinon conversion https->ssh si GIT_CLONE_SSH=1
// (utilise ta clé, aucun certificat) ; sinon https avec token injecté.
function cloneUrl(cfg, repo) {
  const raw = String(repo.url || '').trim();
  if (/^(ssh:\/\/|git@)/.test(raw)) return raw;             // déjà en SSH
  if (process.env.GIT_CLONE_SSH === '1') {
    try {
      const u = new URL(raw);
      return `git@${u.hostname}:${u.pathname.replace(/^\/+/, '')}`;
    } catch { /* pas une URL : on continue */ }
  }
  const user = repo && repo.forge === 'github' ? 'x-access-token' : 'oauth2';
  return authUrl(raw, tokenFor(cfg, repo), user);           // https + token de la forge
}

// Clone si absent, sinon fetch. Renvoie le chemin du clone.
// Récupère/initialise les submodules (best-effort : n'échoue pas la review).
async function updateSubmodules(dir, tls, secrets, onLog) {
  onLog(t('log.git.submodules'));
  try {
    await run('git', [...tls, 'submodule', 'sync', '--recursive'], { cwd: dir, onLog, redactSecrets: secrets });
    await run('git', [...tls, 'submodule', 'update', '--init', '--recursive'], { cwd: dir, onLog, redactSecrets: secrets });
  } catch (e) {
    onLog(`⚠ submodules : ${String(e.message).split('\n')[0]} (on continue sans)`);
  }
}

async function ensureRepo(cfg, repo, onLog = () => {}) {
  const dir = cloneDirFor(cfg, repo);
  const gitDir = path.join(dir, '.git');
  const url = cloneUrl(cfg, repo);
  const tls = gitTlsArgs();
  const secrets = secretsOf(cfg);
  if (fs.existsSync(gitDir)) {
    onLog(`fetch ${repo.project}`);
    // met à jour l'origin (au cas où le token/protocole a changé) puis fetch.
    // `--force` : un tag supprimé/recréé sur un autre SHA ferait sinon échouer le fetch
    // entier (« would clobber existing tag »). Le clone est un miroir : il suit le remote.
    await run('git', ['remote', 'set-url', 'origin', url], { cwd: dir, onLog, redactSecrets: secrets });
    await run('git', [...tls, 'fetch', 'origin', '--prune', '--force'], { cwd: dir, onLog, redactSecrets: secrets });
  } else {
    onLog(`clone ${repo.project}`);
    ensureDir(path.dirname(dir));
    await run('git', [...tls, 'clone', url, dir], { onLog, redactSecrets: secrets });
  }
  ensureInternalIgnore(dir); // ne jamais committer les dossiers de travail internes
  await updateSubmodules(dir, tls, secrets, onLog);
  return dir;
}

// Ajoute le dossier de travail interne de l'app à .git/info/exclude du clone,
// pour qu'il ne soit jamais stagé par `git add -A` (reviews ET tâches partagent
// le même clone). Ne modifie pas le .gitignore versionné du dépôt. Idempotent
// par motif (garde les anciens noms pour les clones déjà existants).
function ensureInternalIgnore(cwd) {
  const f = path.join(cwd, '.git', 'info', 'exclude');
  const patterns = ['ai-dev-tools-internal/', '.lin-review/', '.lin-task/'];
  try {
    let content = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const lines = content.split('\n');
    let changed = false;
    for (const p of patterns) {
      if (!lines.includes(p)) {
        if (content && !content.endsWith('\n')) content += '\n';
        content += `${p}\n`; changed = true;
      }
    }
    if (changed) fs.writeFileSync(f, content, 'utf8');
  } catch { /* best-effort */ }
}

// Diff ciblé : changements de la branche source depuis sa divergence d'avec target.
// three-dot => n'inclut pas les commits de target absents de source.
async function targetedDiff(cwd, sourceBranch, targetBranch, onLog = () => {}) {
  const src = `origin/${sourceBranch}`;
  const tgt = `origin/${targetBranch}`;
  // on log la commande mais PAS la sortie (le diff peut être énorme) : juste un résumé.
  onLog(`$ git diff ${tgt}...${src}`);
  const { stdout } = await run(
    'git',
    ['diff', `${tgt}...${src}`],
    { cwd, maxBuffer: 1024 * 1024 * 64 },
  );
  const lines = stdout ? stdout.split('\n').length : 0;
  onLog(`diff obtenu : ${lines} lignes, ${stdout.length} octets`);
  return stdout;
}

// Auteur PRÉCIS d'un tag, lu dans le clone local (la seule source du « tagger ») :
//  - tag ANNOTÉ → le tagger (celui qui a créé le tag), + sa date ;
//  - tag LÉGER  → pas de tagger, on retombe sur l'auteur du commit pointé.
// L'API GitLab n'expose pas le tagger, d'où cette lecture git à la demande.
async function tagAuthor(cwd, tag) {
  // Garantit l'objet tag en local : un tag pointant un commit déjà présent n'est pas
  // toujours rapatrié par le fetch général. Best-effort (déjà là / injoignable = on lit ce qu'on a).
  try { await run('git', [...gitTlsArgs(), 'fetch', 'origin', '--force', `refs/tags/${tag}:refs/tags/${tag}`], { cwd }); } catch { /* on lit l'état local */ }
  const fmt = '%(taggername)\t%(taggerdate:iso-strict)\t%(authorname)\t%(authordate:iso-strict)';
  const { stdout } = await run('git', ['for-each-ref', `--format=${fmt}`, `refs/tags/${tag}`], { cwd });
  const line = (stdout.split('\n').find((l) => l.trim())) || '';
  const [taggername = '', taggerdate = '', authorname = '', authordate = ''] = line.split('\t');
  const annotated = !!taggername.trim();
  return {
    found: !!line,
    annotated,
    author: (annotated ? taggername : authorname).trim(),
    date: ((annotated ? taggerdate : authordate) || '').trim() || null,
  };
}

// Branches (distantes) qui CONTIENNENT un commit — ici le commit pointé par un tag,
// pour répondre à « sur quelle branche ce tag a-t-il été posé ». Un tag ne mémorise
// pas sa branche d'origine (il pointe un commit) : on renvoie donc les branches où ce
// commit est présent, la branche par défaut d'abord (cas courant : tag de release sur
// main). Best-effort : commit absent du clone / erreur => liste vide.
async function branchesForCommit(cwd, sha, defaultBranch) {
  if (!sha) return [];
  try {
    const { stdout } = await run('git', ['branch', '-r', '--contains', sha, '--format=%(refname:lstrip=3)'], { cwd });
    const names = [...new Set(stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'HEAD'))];
    names.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
    return names;
  } catch { return []; }
}

// Variante enrichie de branchesForCommit : pour chaque branche portant le commit, on
// ajoute la date du DERNIER commit de la branche (sa pointe) et `isTip` = « le commit
// visé est justement cette pointe ». Sert à « Trouver une ref » : comparer la date du tag
// à celle du dernier commit de la branche dit si le tag pointe bien le sommet de branche.
async function branchesForCommitDetailed(cwd, sha, defaultBranch) {
  const names = await branchesForCommit(cwd, sha, defaultBranch);
  if (!names.length) return [];
  const tip = {};
  try {
    const { stdout } = await run('git', ['for-each-ref', '--format=%(refname:lstrip=3)\t%(objectname)\t%(committerdate:iso-strict)', 'refs/remotes/origin'], { cwd });
    stdout.split('\n').forEach((l) => {
      const [n, o, d] = l.split('\t');
      if (n && n.trim()) tip[n.trim()] = { sha: (o || '').trim(), date: (d || '').trim() || null };
    });
  } catch { /* best-effort : on renvoie les branches sans date */ }
  return names.map((n) => ({
    name: n,
    tipDate: (tip[n] && tip[n].date) || null,
    isTip: !!(sha && tip[n] && tip[n].sha && tip[n].sha === sha),
  }));
}

// Diff entre deux commits (delta). two-dot => différence directe fromSha → toSha,
// c'est-à-dire ce qui a changé sur la branche depuis fromSha. Sert à la re-review
// incrémentale (fromSha = SHA reviewé la dernière fois, toSha = SHA courant).
async function diffRange(cwd, fromSha, toSha, onLog = () => {}) {
  onLog(`$ git diff ${String(fromSha).slice(0, 8)}..${String(toSha).slice(0, 8)}`);
  const { stdout } = await run(
    'git',
    ['diff', `${fromSha}..${toSha}`],
    { cwd, maxBuffer: 1024 * 1024 * 64 },
  );
  const lines = stdout ? stdout.split('\n').length : 0;
  onLog(`diff delta obtenu : ${lines} lignes, ${stdout.length} octets`);
  return stdout;
}

// Branche par défaut du dépôt distant (main/master/…).
async function defaultBranch(cwd) {
  try {
    const { stdout } = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    return stdout.trim().replace(/^origin\//, '') || 'main';
  } catch {
    for (const b of ['main', 'master', 'develop']) {
      try { await run('git', ['rev-parse', '--verify', `origin/${b}`], { cwd }); return b; } catch { /* suivant */ }
    }
    return 'main';
  }
}

// Vrai si la référence git existe (branche locale, distante, sha…).
async function refExists(cwd, ref) {
  try { await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd }); return true; }
  catch { return false; }
}

// (Re)crée la branche `branch` à partir de startPoint et s'y positionne.
async function createBranchFrom(cwd, branch, startPoint, onLog) {
  await run('git', ['checkout', '-B', branch, startPoint], { cwd, onLog });
}

// Se positionne sur une branche locale existante.
async function checkoutBranch(cwd, branch, onLog) {
  await run('git', ['checkout', branch], { cwd, onLog });
}

// Ajoute tout et commite. Renvoie true si un commit a été créé, false si rien à committer.
async function commitAll(cwd, message, onLog) {
  await run('git', ['add', '-A'], { cwd, onLog });
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
  if (!stdout.trim()) return false;
  // auteur = config git globale de l'utilisateur (pas d'identité forcée)
  await run('git', ['commit', '-m', message], { cwd, onLog });
  return true;
}

/* RENOMMER LE DERNIER COMMIT, sans toucher à ce qu'il contient.
   Le cas : on relance une session après avoir renseigné le message de commit, l'IA constate
   que tout est déjà fait et ne commite rien — le commit garde alors le message d'avant, et le
   champ qu'on vient de remplir n'a servi à rien. `--amend` ne réécrit que le message.
   Renvoie true si le message a changé, false s'il était déjà le bon (rien à faire). */
async function renommerDernierCommit(cwd, message, onLog = () => {}) {
  const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd });
  if (stdout.trim() === String(message).trim()) return false;
  await run('git', ['commit', '--amend', '-m', message], { cwd, onLog });
  return true;
}

async function headSha(cwd) {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

// Liste tous les fichiers présents à une référence (arbo du projet).
async function lsTree(cwd, ref) {
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', ref], { cwd, maxBuffer: 1024 * 1024 * 32 });
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Contenu d'un fichier à une référence donnée.
async function showFile(cwd, ref, filePath) {
  const { stdout } = await run('git', ['show', `${ref}:${filePath}`], { cwd, maxBuffer: 1024 * 1024 * 64 });
  return stdout;
}

// Diff d'un fichier à CONTEXTE COMPLET (tout le fichier + les changements),
// à la manière de la vue « fichier complet » de GitLab.
async function fileDiffFull(cwd, base, ref, filePath) {
  const { stdout } = await run(
    'git',
    ['diff', '--unified=100000', `origin/${base}...${ref}`, '--', filePath],
    { cwd, maxBuffer: 1024 * 1024 * 64 },
  );
  return stdout;
}

/* Nombre de commits d'avance de HEAD sur origin/<base>. Sert à distinguer deux situations que
   `commitAll` renvoie à l'identique (« rien à committer ») et qui n'ont rien à voir : une branche
   qui porte DÉJÀ le travail — cas d'une relance après un échec survenu APRÈS le commit — et une
   branche vide, où l'agent a répondu au lieu de coder. */
async function aheadOf(cwd, base) {
  try {
    const { stdout } = await run('git', ['rev-list', '--count', `origin/${base}..HEAD`], { cwd });
    return Number(stdout.trim()) || 0;
  } catch { return 0; } // base inconnue localement : on ne conclut rien
}

/* Combien de commits la branche LOCALE porte que la distante n'a pas. Sert à ne pas jeter du
   travail : un commit non poussé n'existe nulle part ailleurs, et se réaligner sur origin le
   supprimerait sans que rien ne le dise. Branche distante inconnue → 0, l'appelant a déjà
   vérifié qu'elle existe. */
async function nonPousses(cwd, branch) {
  try {
    const { stdout } = await run('git', ['rev-list', '--count', `origin/${branch}..refs/heads/${branch}`], { cwd });
    return Number(stdout.trim()) || 0;
  } catch { return 0; }
}

/* Combien de commits `origin/base` porte que la branche courante n'a pas — c'est-à-dire de
   combien la branche de départ a avancé sous nos pieds depuis qu'on en est parti. C'est ce
   nombre qui dit s'il y a quelque chose à rattraper. */
async function behindOf(cwd, base) {
  try {
    const { stdout } = await run('git', ['rev-list', '--count', `HEAD..origin/${base}`], { cwd });
    return Number(stdout.trim()) || 0;
  } catch { return 0; } // base inconnue localement : on ne conclut rien
}

/* REJOUER NOS COMMITS PAR-DESSUS LA BRANCHE DE DÉPART À JOUR.
 *
 * `rebase`, pas `merge` : l'historique de `origin/base` est conservé tel quel, et nos commits
 * repassent au-dessus — c'est exactement « garder l'historique distant et réappliquer les
 * changements par-dessus ». Un merge, lui, fabriquerait un commit de fusion et laisserait la
 * branche de départ mêlée à la nôtre.
 *
 * Renvoie `{ ok: true }` si tout est passé, `{ ok: false, conflits: [...] }` si git s'est
 * arrêté sur un conflit — le rebase reste alors EN COURS, à l'appelant de le terminer ou de
 * l'abandonner. On ne décide pas ici : résoudre est un travail d'IA, abandonner est un échec. */
async function rebaseSur(cwd, base, onLog = () => {}) {
  try {
    await run('git', ['rebase', `origin/${base}`], { cwd, onLog });
    return { ok: true, conflits: [] };
  } catch (e) {
    const conflits = await fichiersEnConflit(cwd);
    if (!conflits.length) throw e;            // échec pour une autre raison : on ne le masque pas
    return { ok: false, conflits };
  }
}

// Les fichiers que git a laissés en conflit (« unmerged »), chemins relatifs au dépôt.
async function fichiersEnConflit(cwd) {
  try {
    const { stdout } = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// Un rebase est-il en cours ? (répertoires posés par git, `rebase-merge` ou `rebase-apply`)
function rebaseEnCours(cwd) {
  return ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(cwd, '.git', d)));
}

/* Poursuit le rebase après résolution. Renvoie le même contrat que `rebaseSur` : terminé, ou
   arrêté sur le conflit SUIVANT — un rebase de dix commits peut s'arrêter dix fois. */
async function rebaseContinuer(cwd, onLog = () => {}) {
  await run('git', ['add', '-A'], { cwd });
  /* `GIT_EDITOR=true` : sans lui, `rebase --continue` ouvre l'éditeur du message de commit et
     le processus attend indéfiniment un humain qui n'est pas là. */
  try {
    await run('git', ['rebase', '--continue'], { cwd, onLog, env: { ...process.env, GIT_EDITOR: 'true' } });
    return { ok: true, conflits: [] };
  } catch (e) {
    if (!rebaseEnCours(cwd)) throw e;
    const conflits = await fichiersEnConflit(cwd);
    if (!conflits.length) throw e;
    return { ok: false, conflits };
  }
}

/* Remet la branche exactement là où elle était. Appelé quand la résolution n'aboutit pas :
   laisser un rebase en plan bloquerait tout ce qui touche ensuite à ce clone. */
async function rebaseAbandonner(cwd, onLog = () => {}) {
  if (!rebaseEnCours(cwd)) return;
  try { await run('git', ['rebase', '--abort'], { cwd, onLog }); } catch { /* déjà défait */ }
}

// La branche est-elle déjà sur origin, au même commit que HEAD ?
async function isPushed(cwd, branch) {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD', `origin/${branch}`], { cwd });
    const [local, distant] = stdout.trim().split('\n');
    return !!local && local === distant;
  } catch { return false; } // pas de branche distante
}

// Diff des changements de la branche courante depuis origin/base.
async function branchDiff(cwd, base) {
  const { stdout } = await run('git', ['diff', `origin/${base}...HEAD`], { cwd, maxBuffer: 1024 * 1024 * 64 });
  return stdout;
}

// Pousse la branche vers origin (avec les réglages TLS).
async function pushBranch(cwd, branch, onLog, secrets = []) {
  await run('git', [...gitTlsArgs(), 'push', '-u', 'origin', branch], { cwd, onLog, redactSecrets: secrets });
}


// Remet le worktree dans l'état de la branche : annule les modifications de fichiers
// suivis et supprime les nouveaux fichiers. Garantit qu'une exploration reste en
// LECTURE SEULE même si l'agent a écrit quelque chose (il tourne en mode « yolo »).
// Les dossiers internes de l'app sont ignorés par git : `clean -fd` n'y touche pas.
async function resetWorktree(cwd, onLog = () => {}) {
  try {
    await run('git', ['checkout', '--', '.'], { cwd, onLog });
    await run('git', ['clean', '-fd'], { cwd, onLog });
  } catch (e) {
    onLog(t('log.git.reset-partial', { message: e.message.split('\n')[0] }));
  }
}

// Garantit un worktree propre AVANT de placer une branche de travail.
// Une session de codage interrompue peut laisser des fichiers modifiés ou non
// suivis : le `git checkout` suivant échouerait (« Your local changes would be
// overwritten »), ou pire l'IA repartirait d'un état sale sans que rien ne le
// signale. On remet à zéro — les COMMITS déjà faits sont préservés, seul le
// désordre non commité est jeté. `git clean -fd` respecte .git/info/exclude,
// donc le dossier d'échange interne survit.
// Best-effort : ne jette jamais, pour ne pas bloquer une opération sur un dépôt
// dont l'état est simplement inhabituel. Renvoie true si un nettoyage a eu lieu.
async function ensureCleanWorktree(cwd, onLog = () => {}) {
  let dirty = '';
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
    dirty = stdout.trim();
  } catch { return false; } // pas encore un worktree exploitable : rien à nettoyer
  // Une opération git en cours (merge/rebase/cherry-pick interrompu) bloquerait
  // le checkout autant qu'un worktree sale : on l'annule d'abord, au cas où.
  for (const abort of ['merge', 'rebase', 'cherry-pick']) {
    try {
      if (fs.existsSync(path.join(cwd, '.git', abort === 'rebase' ? 'rebase-merge' : `${abort.toUpperCase().replace('-', '_')}_HEAD`))) {
        await run('git', [abort, '--abort'], { cwd, onLog });
      }
    } catch { /* rien à annuler pour cette opération */ }
  }
  if (!dirty) return false;
  const n = dirty.split('\n').length;
  onLog(t('log.git.dirty', { n, s: n > 1 ? 'ies' : 'y' }));
  await resetWorktree(cwd, onLog);
  return true;
}

module.exports = {
  aheadOf, behindOf, isPushed, renommerDernierCommit, nonPousses,
  rebaseSur, rebaseContinuer, rebaseAbandonner, rebaseEnCours, fichiersEnConflit,
  resetWorktree,
  ensureRepo, targetedDiff, diffRange, tagAuthor, branchesForCommit, branchesForCommitDetailed, cloneDirFor, authUrl, run, secretsOf, tokenFor,
  defaultBranch, ensureCleanWorktree, refExists, createBranchFrom, checkoutBranch, commitAll, headSha, branchDiff, pushBranch, gitTlsArgs,
  lsTree, showFile, fileDiffFull,
};
