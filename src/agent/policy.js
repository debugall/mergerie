'use strict';
/* CE QU'UN AGENT A LE DROIT DE FAIRE, SELON CE QU'ON LUI DEMANDE.
 *
 * `COPILOT_ARGS` — `--dangerously-skip-permissions`, `--yolo` — était préfixé à CHAQUE lancement :
 * review, question, exploration compris. « Lecture seule » n'était alors qu'une phrase du prompt,
 * et c'est justement là qu'arrive le texte le moins fiable — la description d'une merge request,
 * un diff, un rapport venu du dépôt partagé. Une consigne glissée dedans avait sous la main un
 * agent qui pouvait tout écrire et tout lancer.
 *
 * Vérifié contre le CLI, pas supposé :
 *   — `--permission-mode default` + `--allowedTools Read` sous `-p` : une écriture est REFUSÉE ;
 *   — `--disallowedTools …` sous `--dangerously-skip-permissions` : le refus TIENT, sous-agents
 *     compris ;
 *   — `--allowedTools …` sous `--dangerously-skip-permissions` : SANS EFFET. Une liste blanche
 *     n'a de valeur qu'une fois le mode large retiré — y compris celle d'un profil d'agent.
 *
 * DEUX SAVEURS.
 *   LECTURE (review, explication, question, exploration, question libre) : le mode large est
 *   retiré. Avec `--restricted` quand le CLI le connaît — sans outil qui exécute, sans WebFetch,
 *   sans les réglages du dépôt (`.claude/` de l'auteur de la MR), fichiers confinés au dossier de
 *   travail —, sinon `--permission-mode default` et une liste de lecture. Le résultat revient par
 *   la sortie standard : il n'y a rien à écrire.
 *   ÉCRITURE (codage, correction, convergence, hors dépôt) : le mode de l'utilisateur reste — un
 *   agent qui code doit lancer des tests —, mais les chemins de FUITE sont retirés : récupérer une
 *   page, envoyer vers un hôte, pousser, toucher aux remotes et à la configuration git. Ça réduit,
 *   ça n'empêche pas tout : un agent qui écrit du code peut en écrire un qui fuit. Ce qui borne
 *   les dégâts, c'est aussi ce qu'il n'a plus sous la main — le jeton (hors du clone) et
 *   l'environnement (en liste blanche).
 */
const { spawnSync } = require('node:child_process');

const LECTURE = new Set(['review', 'explain', 'question', 'modify', 'explore', 'ask', 'test']);
const ECRITURE = new Set(['code', 'fix', 'converge', 'local', 'task', 'rebase']);

/* Les options qui ÉLARGISSENT : retirées d'une saveur de lecture, et d'un profil qui porte sa
   propre liste (sans quoi sa liste ne vaut rien). `--permission-mode` prend une valeur. */
const LARGES = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--yolo', '--allow-all-tools']);
function sansModeLarge(extra) {
  const out = [];
  const a = extra || [];
  for (let i = 0; i < a.length; i++) {
    const x = String(a[i]);
    if (LARGES.has(x)) continue;
    if (x === '--permission-mode') { i += 1; continue; }
    if (x.startsWith('--permission-mode=')) continue;
    out.push(a[i]);
  }
  return out;
}

const OUTILS_LECTURE = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)'];
const INTERDITS_LECTURE = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const INTERDITS_ECRITURE = ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(nc:*)', 'Bash(ssh:*)',
  'Bash(scp:*)', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)'];

/* LA BASE ET LE `.env` NE SE LISENT PAS. Les clones vivent sous le dossier de données
   (`<data>/clones/<projet>`) : la base est à `../../reviewer.db`, avec les jetons de
   `local_config`. Des règles `Read(//chemin absolu)` les ferment aux outils de fichiers de
   l'agent, dans TOUTES les saveurs — un refus tient même sous `--dangerously-skip-permissions`.
   Limite dite : un agent qui écrit a Bash, et `cat` n'est pas `Read`. Ce qui l'arrête là, c'est
   le jeton de forge hors de la base du clone et l'env filtré, pas cette règle. Requis ici, pas
   en tête : `paths` lit `MERGERIE_DATA_DIR` à son chargement. */
function interditsDonnees() {
  const path = require('node:path');
  const { DATA_DIR, ROOT } = require('../core/paths');
  const fs = require('node:fs');
  /* Le CLI compare au chemin RÉEL (`/var` → `/private/var` sur macOS) : on pose les deux. */
  const reels = (p) => { const r = [path.resolve(p)]; try { r.push(fs.realpathSync(p)); } catch { /* absent */ } return r; };
  const abs = (p) => `/${p}`.replace(/\\/g, '/');     // `//chemin` = absolu pour le CLI
  const cibles = [
    ...reels(DATA_DIR).map((d) => `${abs(d)}/reviewer.db*`),
    ...[path.join(ROOT, '.env'), path.join(process.cwd(), '.env')].flatMap(reels).map(abs),
  ];
  return [...new Set(cibles)].flatMap((c) => [`Read(${c})`, `Edit(${c})`]);
}

/* Ce que CE binaire sait faire, lu une fois dans son `--help`. Une option qu'il ne connaît pas
   ferait échouer chaque lancement : mieux vaut s'en passer et le savoir. */
let capaciteCache = null;
function capacites(bin) {
  if (capaciteCache && capaciteCache.bin === bin) return capaciteCache;
  let aide = '';
  try { aide = String(spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 8000 }).stdout || ''); } catch { /* binaire absent */ }
  capaciteCache = {
    bin,
    restricted: /--restricted\b/.test(aide),
    settingSources: /--setting-sources\b/.test(aide),
    strictMcp: /--strict-mcp-config\b/.test(aide),
  };
  return capaciteCache;
}
const oublierCapacites = () => { capaciteCache = null; };

/** Le backend que désigne `COPILOT_BIN` — d'après son nom, comme l'a toujours fait `agentsession`. */
function backendDe(bin) {
  const b = String(bin || '').toLowerCase();
  if (b.includes('claude')) return 'claude';
  if (b.includes('copilot')) return 'copilot';
  return 'unknown';
}

const saveurDe = (kind) => {
  const k = String(kind || '');
  if (LECTURE.has(k)) return 'lecture';
  if (ECRITURE.has(k)) return 'ecriture';
  return 'ecriture';          // inconnu : on ne restreint pas ce qu'on ne sait pas nommer
};

/**
 * L'argv de permission pour un lancement.
 * @param {object} p
 * @param {'claude'|'copilot'|string} p.backend
 * @param {string} p.bin
 * @param {string[]} p.extra  `COPILOT_ARGS` découpé
 * @param {string} p.kind     la saveur demandée
 * @param {boolean} p.profil  un profil d'agent porte ses propres permissions
 * @param {string[]} p.addDirs dossiers hors du dossier de travail que la lecture doit voir
 *                             (les projets liés d'une review, montés par lien symbolique)
 * @returns {{ extra: string[], args: string[], lecture: boolean, note: string|null }}
 */
function argvPermissions({ backend, bin, extra = [], kind, profil = false, addDirs = [] }) {
  const lecture = saveurDe(kind) === 'lecture';
  if (backend !== 'claude') {
    /* Copilot n'a pas d'équivalent aux listes d'outils : on ne peut pas restreindre ici, et on
       le DIT dans le journal plutôt que de laisser croire à une lecture seule. */
    return { extra, args: [], lecture, note: lecture ? 'copilot-lecture-non-restreinte' : null };
  }
  if (profil) {
    /* Un profil porte ses permissions (approuvées sur ce poste). Pour qu'elles vaillent, le mode
       large est retiré ; on garde tout de même les interdits de fuite. */
    return { extra: sansModeLarge(extra), args: ['--disallowedTools', [...INTERDITS_ECRITURE, ...interditsDonnees()].join(',')], lecture, note: null };
  }
  if (lecture) {
    const cap = capacites(bin);
    /* `--restricted` retire aussi Bash : la liste blanche se réduit aux outils de fichiers.
       Toute liste (variadique) est suivie d'une autre option : l'appelant termine par
       `--output-format … -p <prompt>`, et le prompt ne se fait jamais avaler comme outil. */
    const args = cap.restricted
      ? ['--restricted', '--permission-mode', 'default', '--allowedTools', OUTILS_LECTURE.slice(0, 3).join(','),
        '--disallowedTools', [...INTERDITS_LECTURE, ...interditsDonnees()].join(','), ...(cap.strictMcp ? ['--strict-mcp-config'] : [])]
      : ['--permission-mode', 'default', '--allowedTools', OUTILS_LECTURE.join(','),
        '--disallowedTools', [...INTERDITS_LECTURE, ...interditsDonnees()].join(','),
        ...(cap.settingSources ? ['--setting-sources', 'user'] : [])];
    for (const d of addDirs || []) args.push('--add-dir', String(d));
    return { extra: sansModeLarge(extra), args, lecture, note: null };
  }
  return { extra, args: ['--disallowedTools', [...INTERDITS_ECRITURE, ...interditsDonnees()].join(',')], lecture, note: null };
}

/** Vrai quand ce lancement ne pourra PAS écrire son document : saveur de lecture sur claude. Le
    prompt demande alors la réponse finale comme résultat, au lieu d'un fichier refusé d'avance. */
const sortieSurStdout = (kind, bin) => saveurDe(kind) === 'lecture' && backendDe(bin) === 'claude';

/* ---------------------------------------------------------------- les bornes */

/* LE NOMBRE DE TOURS ET LA DÉPENSE DU JOUR (Réglages → IA). Lus à chaque lancement : un
   plafond qu'on vient de baisser vaut pour le prochain agent. Requis ici : `config` ouvre la
   base, ce que ce module ne fait pas à son chargement. */
function bornes() {
  const { getConfig } = require('../data/config');
  const c = getConfig();
  const mt = Number(c.agent_max_turns);
  const budget = Number(c.agent_daily_budget_usd);
  return {
    maxTurns: Number.isFinite(mt) && mt >= 0 ? mt : 200,
    budget: Number.isFinite(budget) && budget > 0 ? budget : 0,
  };
}

/** Ce qui a été dépensé aujourd'hui (heure locale), d'après ce que les CLI ont rapporté. */
function depenseDuJour() {
  const db = require('../db');
  const debut = new Date();
  debut.setHours(0, 0, 0, 0);
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE created_at >= ?').get(debut.toISOString());
  return Number(r && r.s) || 0;
}

/** Refuse le lancement quand la dépense du jour a atteint le plafond. */
function exigerBudget() {
  const { budget } = bornes();
  if (!budget) return;
  const spent = depenseDuJour();
  if (spent >= budget) {
    const { t } = require('../../public/i18n-runtime.js');
    const e = new Error(t('err.budget.daily', { spent: spent.toFixed(2), cap: budget.toFixed(2) }));
    e.code = 'BUDGET';
    throw e;
  }
}

/** `--max-turns` quand ni le profil ni `COPILOT_ARGS` n'en posent — claude seulement. */
function argsMaxTurns(backend, deja) {
  if (backend !== 'claude' || (deja || []).some((a) => String(a).startsWith('--max-turns'))) return [];
  const { maxTurns } = bornes();
  return maxTurns > 0 ? ['--max-turns', String(maxTurns)] : [];
}

/* ---------------------------------------------------------------- l'environnement de l'agent */

/* L'AGENT N'HÉRITE PLUS DE TOUT. Il recevait `process.env` entier — le `.env` compris, avec ce
   qu'on y met (jetons d'autres outils, `MERGERIE_ACCESS_TOKEN`). Une liste blanche : ce dont un
   agent a besoin pour trouver ses outils, sa configuration, son compte et son proxy. Les
   variables d'authentification du fournisseur (Anthropic, Bedrock, Vertex) passent pour claude ;
   celles de GitHub seulement pour copilot, qui en a besoin. */
const NOMS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'SSH_AUTH_SOCK', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'WINDIR',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
  /* Les chaînes d'outils : un agent qui code lance les tests du projet, et `mvn`, `go`, `cargo`
     ou un virtualenv ne se trouvent pas sans elles. Aucune ne porte de secret. */
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'NVM_DIR', 'NVM_BIN',
  'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'SDKMAN_DIR', 'GRADLE_USER_HOME', 'M2_HOME', 'MAVEN_HOME',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DOTNET_ROOT', 'COREPACK_HOME', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR']);
const PREFIXES_COMMUNS = ['LC_', 'XDG_'];
const PREFIXES = {
  claude: ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'VERTEX_'],
  copilot: ['COPILOT_', 'GH_', 'GITHUB_'],
};

/* `MERGERIE_AGENT_ENV=NOM1,NOM2` ajoute des noms à la liste — le besoin d'un projet qu'on ne
   devine pas (`DATABASE_URL` de test, `KUBECONFIG`…). C'est un choix de l'utilisateur, fait dans
   SON `.env` : il sait ce qu'il donne. */
function envAgent(backend, source = process.env) {
  const prefixes = [...PREFIXES_COMMUNS, ...(PREFIXES[backend] || [...PREFIXES.claude, ...PREFIXES.copilot])];
  const enPlus = new Set(String(source.MERGERIE_AGENT_ENV || '').split(',').map((x) => x.trim()).filter(Boolean));
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (NOMS.has(k) || enPlus.has(k) || prefixes.some((p) => k.startsWith(p))) env[k] = v;
  }
  // Ce que Mergerie lui-même porte ne va jamais à l'agent, quel que soit son préfixe.
  delete env.MERGERIE_ACCESS_TOKEN;
  // `COPILOT_BIN`/`COPILOT_ARGS` sont les réglages de Mergerie, pas ceux de l'agent.
  delete env.COPILOT_ARGS;
  return env;
}

module.exports = {
  LECTURE, ECRITURE, backendDe, saveurDe, sortieSurStdout, bornes, depenseDuJour, exigerBudget, argsMaxTurns, sansModeLarge, argvPermissions, capacites, oublierCapacites, envAgent,
  OUTILS_LECTURE, INTERDITS_LECTURE, INTERDITS_ECRITURE, interditsDonnees,
};
