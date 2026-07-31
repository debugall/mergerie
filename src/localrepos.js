'use strict';
/* « Répertoires locaux » : un dossier de la machine qui contient UN SOUS-DOSSIER PAR
   PROJET git, déjà clonés à la main (le classique ~/dev). Deux écrans s'en servent :
   - l'onglet Git → Navigation, qui positionne plusieurs de ces projets sur la branche
     distante choisie, en un seul geste ;
   - le codage hors dépôt, où le dossier de travail se CHOISIT (répertoire puis projet)
     au lieu de se saisir — un chemin tapé à la main est une faute de frappe silencieuse.

   ⚠ Ces dépôts ne sont PAS les clones de l'application (data/clones) : ce sont ceux de
   l'utilisateur, avec son travail en cours dedans. D'où la règle qui gouverne tout le
   module : on ne jette JAMAIS une modification locale. Le checkout est tenté tel quel ;
   si git l'accepte en emportant les modifications, on le DIT en listant les fichiers
   concernés, plutôt que de laisser croire à un dépôt propre. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('./db');
const git = require('./git');
const { t } = require('../public/i18n-runtime.js');

// Mode démo : dépôts locaux FICTIFS (la machine réelle n'existe pas en démo) pour que
// Navigation et « Commandes Git » restent consultables. Séquence figée.
const isDemo = () => process.env.MERGERIE_DEMO === '1';
const DEMO_ROOT = { id: 901, path: '/home/moi/dev', label: 'Mes dépôts (démo)' };
const DEMO_PROJECTS = [
  { name: 'boutique-api', git: true, branch: 'main' },
  { name: 'boutique-web', git: true, branch: 'develop' },
  { name: 'monitoring', git: true, branch: 'main' },
  { name: 'scripts', git: false, branch: null },
  // Dossiers SANS git : c'est le cas d'usage du « codage hors dépôt », et ce sont ceux
  // que les sessions de démo ciblent — sans eux, leur modale d'édition ne retrouverait
  // aucun projet et ne serait pas démontrable.
  { name: 'backup-tool', git: false, branch: null },
  { name: 'csv-cleaner', git: false, branch: null },
  { name: 'legacy-report', git: false, branch: null },
];

/* Un nom de branche sûr : pas de tiret en tête (sinon git le lit comme une option),
   pas de `..`, caractères limités. Même règle que les branches de session — c'est ce
   qui empêche une saisie de se transformer en argument de commande. */
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/* ---------- Répertoires ---------- */

function roots() {
  if (isDemo()) return [{ ...DEMO_ROOT }];
  return db.prepare('SELECT * FROM local_root ORDER BY id').all();
}

function rootById(id) {
  return db.prepare('SELECT * FROM local_root WHERE id = ?').get(Number(id)) || null;
}

function addRoot(rawPath, label) {
  const p = String(rawPath || '').trim();
  if (!p) throw new Error(t('err.local-root.path-required'));
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(t('err.local-root.not-found', { path: abs })); }
  if (!st.isDirectory()) throw new Error(t('err.local-root.not-a-dir', { path: abs }));
  if (db.prepare('SELECT 1 FROM local_root WHERE path = ?').get(abs)) {
    throw new Error(t('err.local-root.exists', { path: abs }));
  }
  const info = db.prepare('INSERT INTO local_root (path, label, created_at) VALUES (?, ?, ?)')
    .run(abs, String(label || '').trim() || null, new Date().toISOString());
  return rootById(info.lastInsertRowid);
}

function removeRoot(id) {
  db.prepare('DELETE FROM local_root WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* ---------- Projets d'un répertoire ---------- */

// `.git` est un DOSSIER dans un clone ordinaire, mais un FICHIER « gitdir: … » dans un
// worktree ou un submodule : tester l'existence couvre les deux sans les distinguer.
function isGitRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/* Branche courante, lue à même le dépôt plutôt que via `git` : lister un répertoire
   de trente projets lancerait sinon trente processus juste pour remplir une colonne. */
function currentBranch(dir) {
  try {
    const dot = path.join(dir, '.git');
    let gitDir = dot;
    if (fs.statSync(dot).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dot, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : head.slice(0, 8);   // HEAD détachée : le sha court
  } catch { return null; }
}

function projects(rootId) {
  if (isDemo()) return DEMO_PROJECTS.map((p) => ({ ...p, path: `${DEMO_ROOT.path}/${p.name}` }));
  const root = rootById(rootId);
  if (!root) throw new Error(t('err.local-root.unknown'));
  let entries;
  try { entries = fs.readdirSync(root.path, { withFileTypes: true }); }
  catch { throw new Error(t('err.local-root.unreadable', { path: root.path })); }
  return entries
    // Les dossiers cachés (.cache, .idea…) ne sont pas des projets : les proposer
    // n'ajouterait que du bruit dans une liste déjà longue.
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const dir = path.join(root.path, e.name);
      const isGit = isGitRepo(dir);
      return { name: e.name, path: dir, git: isGit, branch: isGit ? currentBranch(dir) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* Chemin d'un projet, VALIDÉ. Le nom vient du client : sans ce contrôle, un `..`
   sortirait du répertoire déclaré et l'outil irait manipuler n'importe quel dépôt
   de la machine. On vérifie donc à la fois la forme du nom et le chemin résolu. */
function projectDir(rootId, name) {
  const root = rootById(rootId);
  if (!root) throw new Error(t('err.local-root.unknown'));
  const nm = String(name || '').trim();
  if (!nm || nm === '.' || nm === '..' || /[/\\]/.test(nm)) throw new Error(t('err.local-project.invalid-name', { name: nm }));
  const dir = path.resolve(root.path, nm);
  if (path.dirname(dir) !== path.resolve(root.path)) throw new Error(t('err.local-project.invalid-name', { name: nm }));
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error(t('err.local-project.not-found', { name: nm })); }
  if (!st.isDirectory()) throw new Error(t('err.local-project.not-found', { name: nm }));
  return dir;
}

/* ---------- Branches distantes ---------- */

// Un `fetch` avant de lister : sans lui, une branche poussée par un collègue depuis le
// dernier fetch manuel de l'utilisateur n'apparaîtrait pas — c'est-à-dire exactement la
// branche qu'il vient chercher ici. Best-effort : hors ligne, on liste ce qu'on a.
async function fetchRemote(dir, out, onLog) {
  try {
    await git.run('git', [...git.gitTlsArgs(), 'fetch', '--prune', 'origin'], { cwd: dir, onLog });
  } catch (e) {
    out.fetch_error = String(e.message).split('\n')[0].slice(0, 200);
  }
}

async function branches(rootId, name, { fetch = true, onLog = () => {} } = {}) {
  if (isDemo()) return { project: name, path: `${DEMO_ROOT.path}/${name}`, current: 'main', fetch_error: null, branches: [{ name: 'main', date: '2026-07-20T10:00:00Z' }, { name: 'develop', date: '2026-07-18T09:00:00Z' }, { name: 'release/2.0', date: '2026-07-10T14:00:00Z' }] };
  const dir = projectDir(rootId, name);
  if (!isGitRepo(dir)) throw new Error(t('err.local-project.not-git', { name }));
  const out = { project: name, path: dir, current: currentBranch(dir), branches: [], fetch_error: null };
  if (fetch) await fetchRemote(dir, out, onLog);
  const { stdout } = await git.run('git',
    ['for-each-ref', '--format=%(refname:lstrip=3)\t%(committerdate:iso-strict)', 'refs/remotes/origin'], { cwd: dir });
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const [raw, date] = line.split('\t');
    const nm = (raw || '').trim();
    if (!nm || nm === 'HEAD' || seen.has(nm)) continue;   // origin/HEAD n'est pas une branche
    seen.add(nm);
    out.branches.push({ name: nm, date: (date || '').trim() || null });
  }
  out.branches.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* ---------- Positionnement (checkout) ---------- */

// Les fichiers déjà modifiés AVANT le checkout. C'est cette liste qu'on rapporte :
// après coup les mêmes fichiers sont toujours modifiés, mais on veut nommer ce qui
// était là avant qu'on touche au dépôt.
async function dirtyFiles(dir) {
  const { stdout } = await git.run('git', ['status', '--porcelain'], { cwd: dir });
  return stdout.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean)
    .slice(0, 200)
    .map((l) => ({ code: l.slice(0, 2).trim() || '??', file: l.slice(3) }));
}

/* Aligne la branche locale sur la distante, en FAST-FORWARD uniquement : jamais de
   merge, jamais de reset. Si l'historique local a divergé (des commits pas encore
   poussés), on le signale et on laisse l'utilisateur trancher — écraser son travail
   pour « bien se positionner » serait le pire service à lui rendre. */
async function fastForward(dir, branch, out, onLog) {
  try { await git.run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: dir }); }
  catch { out.local_only = true; return; }        // branche purement locale : rien à aligner
  try { await git.run('git', ['merge', '--ff-only', `origin/${branch}`], { cwd: dir, onLog }); }
  catch (e) { out.ff_error = String(e.message).split('\n')[0].slice(0, 200); }
}

async function checkoutOne(tg, onLog) {
  const name = String(tg.name || '').trim();
  const branch = String(tg.branch || '').trim();
  const out = {
    root_id: Number(tg.root_id), project: name, branch,
    path: null, from: null, files: [], state: 'error',
  };
  const dir = projectDir(tg.root_id, name);
  out.path = dir;
  if (!isGitRepo(dir)) throw new Error(t('err.local-project.not-git', { name }));
  if (!branch) throw new Error(t('err.navigate.branch-required', { name }));
  if (!BRANCH_RE.test(branch)) throw new Error(t('err.navigate.invalid-branch', { branch }));
  out.from = currentBranch(dir);

  await fetchRemote(dir, out, onLog);
  out.files = await dirtyFiles(dir);

  if (out.from === branch) {
    // Déjà sur place : on n'en profite pas moins pour aligner sur la distante.
    await fastForward(dir, branch, out, onLog);
    out.state = out.files.length ? 'already_dirty' : 'already';
    return out;
  }
  // `git checkout <branche>` crée au besoin la branche locale de suivi depuis
  // origin/<branche>. S'il n'y a ni l'une ni l'autre, git refuse : c'est l'erreur
  // « branche introuvable », remontée telle quelle à l'écran.
  await git.run('git', ['checkout', branch], { cwd: dir, onLog });
  await fastForward(dir, branch, out, onLog);
  out.state = out.files.length ? 'done_dirty' : 'done';
  return out;
}

/* Positionne N projets. Un échec sur un dépôt N'INTERROMPT PAS les autres — même
   sémantique que les opérations git multi-dépôts et les sessions multi-projets :
   on veut le bilan complet, pas le premier obstacle. */
async function checkout(targets, onLog = () => {}) {
  if (!Array.isArray(targets) || !targets.length) throw new Error(t('err.navigate.no-target'));
  if (isDemo()) {
    // Démo : bilan fictif « déjà à jour » (aucune machine réelle à manipuler).
    const results = targets.map((tg) => ({
      root_id: Number(tg.root_id), project: String(tg.name || ''), branch: String(tg.branch || ''),
      path: `${DEMO_ROOT.path}/${tg.name}`, from: String(tg.branch || ''), files: [], state: 'already',
    }));
    return { results, counts: { done: results.length, dirty: 0, failed: 0 } };
  }
  const results = [];
  for (const tg of targets) {
    onLog(`──────── ${tg.name || '?'} → ${tg.branch || '?'} ────────`);
    try {
      const r = await checkoutOne(tg, onLog);
      results.push(r);
    } catch (e) {
      results.push({
        root_id: Number(tg.root_id), project: String(tg.name || '').trim(),
        branch: String(tg.branch || '').trim(), path: null, from: null, files: [],
        state: 'error', error: String(e.message).split('\n').slice(0, 3).join(' ').slice(0, 400),
      });
    }
  }
  const done = results.filter((r) => /^(done|already)/.test(r.state)).length;
  return {
    results,
    counts: {
      done,
      dirty: results.filter((r) => /_dirty$/.test(r.state)).length,
      failed: results.filter((r) => r.state === 'error').length,
    },
  };
}

/* ---------- Commandes git multi-projets (onglet « Commandes Git ») ---------- */

// Découpe une chaîne en tokens en respectant les guillemets simples/doubles. On lance ensuite
// spawn('git', tokens) SANS shell → les métacaractères (; | > & $()) ne sont pas interprétés.
// ⚠ « sans shell » ne suffit PAS : git a lui-même des options qui exécutent une commande
// arbitraire (RCE) — voir `assertSafeGitArgs`. Les deux garde-fous vont ensemble.
function parseGitArgs(command) {
  const s = String(command || '').trim();
  const toks = []; let cur = ''; let quote = null; let has = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else cur += c; has = true; }
    else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\s/.test(c)) { if (has) { toks.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) throw new Error(t('err.gitcmd.unbalanced-quote'));
  if (has) toks.push(cur);
  if (toks[0] && toks[0].toLowerCase() === 'git') toks.shift(); // « git … » toléré : on l'ajoute nous-mêmes
  return toks;
}

// Options git qui permettent d'EXÉCUTER une commande arbitraire (et pas seulement de manipuler
// le dépôt) OU de sortir du dossier ciblé. On les REFUSE : c'est ce qui rend « git-only » réellement
// sûr. Couvre `-c core.sshCommand=…`, `--upload-pack`/`--receive-pack`/`--exec=…`, la redirection
// de dépôt (`-C`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`) et l'ouverture d'un pager.
const DANGEROUS_GIT_ARG = /^(-c|--config(-env)?|-C|--exec-path|--git-dir|--work-tree|--namespace|--upload-pack|--receive-pack|--exec|--upload-archive|--open-files-in-pager)(=.*)?$/i;
// URL de transport « helper » (ext::/fd:: = exécution de commande) passée comme argument.
const DANGEROUS_TRANSPORT = /^(ext|fd)::/i;

function assertSafeGitArgs(args) {
  if (!args.length) throw new Error(t('err.gitcmd.empty'));
  // Le 1er token DOIT être une sous-commande (fetch, status…), pas une option globale : sinon
  // « -c core.sshCommand=evil status » exécuterait « evil ».
  if (!/^[a-z][a-z0-9-]*$/i.test(args[0])) throw new Error(t('err.gitcmd.subcommand-first'));
  for (const a of args) {
    if (DANGEROUS_GIT_ARG.test(a) || DANGEROUS_TRANSPORT.test(a)) throw new Error(t('err.gitcmd.forbidden-arg', { arg: a }));
  }
}

// `git <args>` à la racine d'un projet. Capture stdout+stderr et le code de sortie ; NE LÈVE PAS
// sur code ≠ 0 : un échec fait partie du bilan (on l'affiche), il n'interrompt pas les autres.
// Préfixes défensifs : protocole ext:: interdit, pas d'invite bloquante (defense-in-depth).
function runGitAt(dir, args) {
  const full = ['-c', 'protocol.ext.allow=never', ...args];
  return new Promise((resolve) => {
    const child = spawn('git', full, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: -1, output: String(e.message) }));
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

// Exécute la MÊME commande git à la racine de chaque projet sélectionné. Bilan par projet.
async function runCommand(targets, command) {
  const args = parseGitArgs(command);
  assertSafeGitArgs(args); // refuse les options git qui permettraient un RCE (voir plus haut)
  const list = Array.isArray(targets) ? targets.filter((x) => x && x.name) : [];
  if (!list.length) throw new Error(t('err.gitcmd.no-target'));
  const full = `git ${args.join(' ')}`;

  if (isDemo()) {
    const results = list.map((tg) => ({
      root_id: Number(tg.root_id), project: String(tg.name), path: `${DEMO_ROOT.path}/${tg.name}`,
      code: 0, ok: true, truncated: false,
      output: `$ ${full}\n(demo) exécuté dans ${DEMO_ROOT.path}/${tg.name}\nAlready up to date.`,
    }));
    return { command: full, results, counts: { ok: results.length, failed: 0 } };
  }

  const results = [];
  for (const tg of list) {
    const name = String(tg.name).trim();
    const out = { root_id: Number(tg.root_id), project: name, path: null, code: null, ok: false, output: '', truncated: false };
    try {
      const dir = projectDir(tg.root_id, name);
      out.path = dir;
      if (!isGitRepo(dir)) throw new Error(t('err.local-project.not-git', { name }));
      const r = await runGitAt(dir, args);
      out.code = r.code; out.ok = r.code === 0;
      const text = r.output || '';
      out.output = text.slice(0, 20000);
      out.truncated = text.length > 20000;
    } catch (e) {
      out.output = String(e.message); out.ok = false; out.code = -1;
    }
    results.push(out);
  }
  return { command: full, results, counts: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } };
}

module.exports = {
  roots, rootById, addRoot, removeRoot,
  projects, projectDir, currentBranch, isGitRepo,
  branches, checkout, parseGitArgs, assertSafeGitArgs, runCommand,
};
