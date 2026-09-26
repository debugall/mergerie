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
  const jetonlocal = require('../core/jetonlocal');
  const protocolesecret = require('../core/protocolesecret');
  const fs = require('node:fs');
  /* Le CLI compare au chemin RÉEL (`/var` → `/private/var` sur macOS) : on pose les deux. */
  const reels = (p) => { const r = [path.resolve(p)]; try { r.push(fs.realpathSync(p)); } catch { /* absent */ } return r; };
  const abs = (p) => `/${p}`.replace(/\\/g, '/');     // `//chemin` = absolu pour le CLI
  const cibles = [
    ...reels(DATA_DIR).map((d) => `${abs(d)}/reviewer.db*`),
    /* Le jeton de session local (lot B, S1) : lu par un agent, il ouvrirait l'API depuis SON
       Bash comme n'importe quel processus du poste. */
    ...reels(jetonlocal.FICHIER).map(abs),
    /* Le secret des nonces de protocole (lot D, revue) : lu par un agent, il pourrait forger
       n'importe quel bloc `<<<AGENT…>>>`/`<<<QUESTIONS…>>>` et le glisser dans un fichier qu'un
       AUTRE run lirait comme sa propre sortie. */
    ...reels(protocolesecret.FICHIER).map(abs),
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
    bare: /--bare\b/.test(aide),
    permissionPrompts: /--permission-prompts\b/.test(aide),
    settings: /--settings\b/.test(aide),
    denyTool: /--deny-tool\b/.test(aide),
    allowTool: /--allow-tool\b/.test(aide),
  };
  return capaciteCache;
}
const oublierCapacites = () => { capaciteCache = null; };

/* Le backend que désigne `COPILOT_BIN` (plan_secure.md, lot A, S7/point 8) — d'après ce que le
   binaire répond à `--version`, PAS son seul nom : un wrapper neutre (`runPrompt`) qui relaie à
   `claude` sans le dire dans son propre nom désactivait toute la politique en silence. Le nom
   reste un REPLI quand `--version` ne dit rien de reconnaissable (binaire absent, ancien CLI
   sans cette sortie) ; `unknown` dans les deux cas — jamais un fail-open. */
let backendCache = null;
function backendDe(bin) {
  const b = String(bin || '');
  if (backendCache && backendCache.bin === b) return backendCache.val;
  let val = 'unknown';
  try {
    const sortie = String(spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout || '');
    if (/claude code/i.test(sortie)) val = 'claude';
    else if (/github copilot/i.test(sortie)) val = 'copilot';
  } catch { /* binaire absent, ou --version inconnu : repli sur le nom */ }
  if (val === 'unknown') {
    const low = b.toLowerCase();
    if (low.includes('claude')) val = 'claude';
    else if (low.includes('copilot')) val = 'copilot';
  }
  backendCache = { bin: b, val };
  return val;
}
const oublierBackend = () => { backendCache = null; };

/* FAIL-CLOSED (plan_secure.md, lot A, point 8) : une saveur qu'on ne sait pas NOMMER est traitée
   en LECTURE, jamais en écriture. L'inverse (l'ancien défaut) élargissait sans un mot dès qu'un
   appelant passait un `kind` mal orthographié ou nouveau. */
const saveurDe = (kind) => (ECRITURE.has(String(kind || '')) ? 'ecriture' : 'lecture');

/* Kinds qui n'ont besoin d'AUCUN réglage du dépôt — ni `CLAUDE.md`, ni `.claude/`, ni plugin —
   pour répondre : une question libre ou l'essai d'une session. `--bare` les coupe tous ; une
   review ou une exploration, elles, lisent le `CLAUDE.md` du dépôt comme contexte légitime et
   gardent `--setting-sources user` + `--strict-mcp-config` (lot A, point 6). */
const BARE_KINDS = new Set(['ask', 'test']);

/** Intersection outils-de-lecture × outils-du-profil — JAMAIS l'union (S3). Un profil qui ne
 *  demande rien (pas de liste, kind sans profil) laisse la liste de lecture intacte ; un
 *  chevauchement vide (syntaxe de motif différente) aussi, plutôt que de tout fermer. */
function retrecir(listeLecture, demandeProfil) {
  if (!demandeProfil || !demandeProfil.length) return listeLecture;
  const inter = listeLecture.filter((o) => demandeProfil.includes(o));
  return inter.length ? inter : listeLecture;
}

function argvLecture({ bin, extra, addDirs, allowedToolsProfil, kind }) {
  const cap = capacites(bin);
  const outils = retrecir(cap.restricted ? OUTILS_LECTURE.slice(0, 3) : OUTILS_LECTURE, allowedToolsProfil);
  const disallowedTools = [...INTERDITS_LECTURE, ...interditsDonnees()].join(',');
  const bare = cap.bare && BARE_KINDS.has(String(kind || ''));
  const args = bare
    ? ['--bare', '--allowedTools', outils.join(','), '--disallowedTools', disallowedTools]
    : cap.restricted
      ? ['--restricted', '--permission-mode', 'default', '--allowedTools', outils.join(','),
        '--disallowedTools', disallowedTools, ...(cap.strictMcp ? ['--strict-mcp-config'] : [])]
      : ['--permission-mode', 'default', '--allowedTools', outils.join(','),
        '--disallowedTools', disallowedTools,
        ...(cap.settingSources ? ['--setting-sources', 'user'] : []),
        ...(cap.strictMcp ? ['--strict-mcp-config'] : [])];
  for (const d of addDirs || []) args.push('--add-dir', String(d));
  return { extra: sansModeLarge(extra), args, lecture: true, note: null, mode: bare ? 'bare' : 'lecture' };
}

/* ---------------------------------------------------------------- écriture : sandbox du CLI */

/* Les fichiers qu'un agent en écriture ne doit JAMAIS pouvoir lire, sandbox ou pas : la base
   (jetons de forge/Jira/Jenkins), le jeton de session local (lot B), le `.env` du serveur, les
   identifiants du poste. Séparé de `interditsDonnees()` (une règle `Read(//chemin)` du CLI, qui
   ne connaît que Claude) : ici c'est la forme `denyRead` du réglage `--settings` du sandbox. */
function sandboxDenyRead() {
  const path = require('node:path');
  const { DATA_DIR, ROOT } = require('../core/paths');
  const jetonlocal = require('../core/jetonlocal');
  const protocolesecret = require('../core/protocolesecret');
  return [
    path.join(DATA_DIR, 'reviewer.db*'),
    jetonlocal.FICHIER,
    protocolesecret.FICHIER,
    path.join(DATA_DIR, 'shared'),
    path.join(ROOT, '.env'),
    '~/.ssh', '~/.aws', '~/.config/gh', '~/.netrc',
  ];
}

/** Le réglage `--settings` inline qui sandboxe l'agent en écriture : écriture bornée au dossier
 *  de travail et à un dossier temporaire, réseau fermé sauf les domaines nommés par
 *  `agent_sandbox_network_domains`, jeton GitHub jamais transmis en credential du sandbox. */
function sandboxSettings(cwd) {
  const os = require('node:os');
  const { getConfig } = require('../data/config');
  const cfg = getConfig();
  const domaines = String(cfg.agent_sandbox_network_domains || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: { allowWrite: [cwd || process.cwd(), os.tmpdir()], denyRead: sandboxDenyRead() },
      network: { allowedDomains: domaines, allowLocalBinding: false },
      credentials: { envVars: [{ name: 'GH_TOKEN', mode: 'deny' }] },
    },
  };
}

/* Les commandes des VÉRIFICATEURS APPROUVÉS sur ce poste (Réglages → Vérificateurs) : ce qu'on
   sait déjà vouloir laisser tourner sans surveillance — `npm test`, `npm run lint`… — devient la
   liste blanche du repli sans sandbox. Un vérificateur non approuvé n'y contribue rien : son
   contenu peut avoir changé par la synchro sans qu'on l'ait relu (`data/approbation.js`).
   L'ENTRÉE EST LA COMMANDE EXACTE, jamais `Bash(<programme>:*)` (revue de add-secure-layer-2) :
   un `:*` sur `npm` autorise aussi `npm exec`/`npm publish`/`npm run <n'importe quoi>`, sur
   `node` autorise `node -e "…"` — un shell complet, alors que seule LA commande approuvée doit
   tourner sans surveillance. */
function commandesVerificateursApprouves() {
  const db = require('../db');
  const approbation = require('../data/approbation');
  const out = new Set();
  for (const v of db.prepare('SELECT id FROM verifier').all()) {
    if (!approbation.verificateurApprouve(v.id)) continue;
    for (const c of db.prepare('SELECT command FROM verifier_command WHERE verifier_id = ? ORDER BY position').all(v.id)) {
      const cmd = String((c && c.command) || '').trim();
      if (cmd) out.add(`Bash(${cmd})`);
    }
  }
  return [...out];
}

/* Le sous-ensemble de git qu'une écriture sans sandbox peut lancer sans surveillance : jamais
   `push`, `remote` ni `config` (déjà dans `INTERDITS_ECRITURE`, répété nulle part ici — une
   seule liste qui dit ce qui fuit). */
const GIT_ALLOWLIST = ['status', 'log', 'show', 'diff', 'blame', 'add', 'commit', 'stash', 'checkout'];

/** La liste blanche du mode `allowlist` (repli quand le sandbox manque ou n'est pas vérifié) :
 *  fichiers, le sous-ensemble de git, les commandes des vérificateurs approuvés, et ce que
 *  `agent_write_allow` (Réglages → Session IA) ajoute explicitement. */
function allowlistEcriture() {
  const { getConfig } = require('../data/config');
  const cfg = getConfig();
  const dits = String(cfg.agent_write_allow || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    .map((c) => (c.startsWith('Bash(') || !/^[\w.-]+$/.test(c.split(':')[0]) ? c : `Bash(${c})`));
  return [...new Set([
    'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep',
    ...GIT_ALLOWLIST.map((s) => `Bash(git ${s}:*)`),
    ...commandesVerificateursApprouves(),
    ...dits,
  ])];
}

/**
 * L'argv d'une saveur d'écriture (plan_secure.md, lot A) : plus jamais de mode large. Trois
 * modes, réglage de poste `agent_write_mode` (Réglages → Session IA) :
 *   — `sandbox` (défaut) ET vérifié (`agent_sandbox_verified`, posé par le bouton « Tester le
 *     sandbox », jamais par un simple `PUT /api/config`) : `--settings` sandboxé, filesystem et
 *     réseau bornés par le CLI lui-même.
 *   — `sandbox` NON vérifié, ou `allowlist` explicite : repli en liste blanche de commandes
 *     (`allowlistEcriture`), sans sandbox — moins sûr, mais jamais un mode large.
 *   — `large` : l'ancien comportement (`--dangerously-skip-permissions` intact), jamais le
 *     défaut d'un réglage mal lu (`data/config.js` s'en assure), un bandeau rouge le rappelle.
 */
function argvEcriture({ bin, extra, profil, addDirs, cwd }) {
  const disallowedTools = [...INTERDITS_ECRITURE, ...interditsDonnees()].join(',');
  if (profil) {
    /* Un profil de CODAGE porte ses propres permissions (`args.js`, ajoutées par l'appelant) :
       policy.js n'y ajoute que les interdits de fuite et, quand il est vérifié, le sandbox —
       qui ne retire rien qu'un profil aurait explicitement demandé, il borne le système de
       fichiers et le réseau autour de lui. */
    const { getConfig } = require('../data/config');
    const cfg = getConfig();
    const args = ['--disallowedTools', disallowedTools];
    if ((cfg.agent_write_mode || 'sandbox') === 'sandbox' && cfg.agent_sandbox_verified && capacites(bin).settings) {
      args.push('--settings', JSON.stringify(sandboxSettings(cwd)));
    }
    return { extra: sansModeLarge(extra), args, lecture: false, note: null, mode: 'profil' };
  }

  const { getConfig } = require('../data/config');
  const cfg = getConfig();
  const mode = cfg.agent_write_mode || 'sandbox';

  if (mode === 'large') {
    return { extra, args: ['--disallowedTools', disallowedTools], lecture: false, note: null, mode: 'large' };
  }

  const cap = capacites(bin);
  const base = ['--permission-mode', 'acceptEdits', ...(cap.permissionPrompts ? ['--permission-prompts', 'none'] : []), '--disallowedTools', disallowedTools];
  for (const d of addDirs || []) base.push('--add-dir', String(d));

  if (mode === 'sandbox' && cfg.agent_sandbox_verified && cap.settings) {
    return {
      extra: sansModeLarge(extra),
      args: [...base, '--allowedTools', 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash', '--settings', JSON.stringify(sandboxSettings(cwd))],
      lecture: false, note: null, mode: 'sandbox',
    };
  }
  return {
    extra: sansModeLarge(extra),
    args: [...base, '--allowedTools', allowlistEcriture().join(',')],
    lecture: false,
    note: null,
    mode: 'allowlist',
    sandboxDemandeNonVerifie: mode === 'sandbox',
  };
}

/* ---------------------------------------------------------------- copilot */

function argvCopilot({ extra, kind, bin }) {
  const lecture = saveurDe(kind) === 'lecture';
  const cap = capacites(bin || 'copilot');
  /* `extra` (COPILOT_ARGS) PASSE PAR LE MÊME FILTRE QUE CLAUDE : `LARGES` connaît
     `--allow-all-tools`, l'équivalent Copilot du mode large, précisément pour ce backend — le
     laisser passer intact aurait rouvert par COPILOT_ARGS ce que policy.js ferme partout
     ailleurs (plan_secure.md, lot A, S4). */
  const sansLarge = sansModeLarge(extra);
  if (!lecture) {
    /* Écriture : restreindre ce qui fuit, quand le binaire le sait faire — sondé une fois via
       `--help` (lot A, point 7). Un CLI qui ne connaît pas `--deny-tool` reçoit `extra` (mode
       large excepté) intact : c'est la limite documentée du backend Copilot (`SECURITY.md`). */
    if (!cap.denyTool) return { extra: sansLarge, args: [], lecture, note: 'copilot-ecriture-non-restreinte', mode: 'copilot' };
    return {
      extra: sansLarge, args: ["--deny-tool", "shell(git push*)", "--deny-tool", "shell(curl*)", "--deny-tool", "shell(wget*)", "--deny-tool", "shell(nc*)", "--deny-tool", "shell(ssh*)", "--deny-tool", "shell(scp*)"],
      lecture, note: null, mode: 'copilot',
    };
  }
  /* Lecture : sans `--deny-tool`, ce backend ne sait pas se restreindre — REFUSER plutôt que de
     laisser croire à une lecture seule (point 7). `agent_read_unrestricted=1` est l'échappatoire
     assumée, jamais le défaut. */
  if (!cap.denyTool) {
    const { getConfig } = require('../data/config');
    const cfg = getConfig();
    if (String(cfg.agent_read_unrestricted) !== '1') {
      const { t } = require('../core/i18n');
      const e = new Error(t('err.agent.copilot-lecture-non-restreinte'));
      e.code = 'COPILOT_UNRESTRICTED';
      throw e;
    }
    return { extra: sansLarge, args: [], lecture, note: 'copilot-lecture-non-restreinte', mode: 'copilot' };
  }
  return {
    extra: sansLarge, args: ["--deny-tool", "write", "--deny-tool", "shell(*)"],
    lecture, note: null, mode: 'copilot',
  };
}

/**
 * L'argv de permission pour un lancement.
 * @param {object} p
 * @param {'claude'|'copilot'|string} p.backend
 * @param {string} p.bin
 * @param {string[]} p.extra  `COPILOT_ARGS` découpé
 * @param {string} p.kind     la saveur demandée
 * @param {boolean} p.profil  un profil de CODAGE porte ses propres permissions (jamais un profil
 *                            d'exploration : celui-ci passe TOUJOURS par la branche lecture)
 * @param {string[]} p.addDirs dossiers hors du dossier de travail que la lecture doit voir
 *                             (les projets liés d'une review, montés par lien symbolique)
 * @param {string[]} p.allowedToolsProfil outils demandés par un profil de LECTURE — rétrécit la
 *                             liste de lecture, ne l'élargit jamais (S3)
 * @param {string} p.cwd      dossier de travail — borne l'écriture du sandbox
 * @returns {{ extra: string[], args: string[], lecture: boolean, note: string|null, mode: string }}
 */
function argvPermissions({ backend, bin, extra = [], kind, profil = false, addDirs = [], allowedToolsProfil = [], cwd }) {
  if (backend !== 'claude') return argvCopilot({ extra, kind, bin });
  if (saveurDe(kind) === 'lecture') return argvLecture({ bin, extra, addDirs, allowedToolsProfil, kind });
  return argvEcriture({ bin, extra, profil, addDirs, cwd });
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
    const { t } = require('../core/i18n');
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
  LECTURE, ECRITURE, backendDe, oublierBackend, saveurDe, sortieSurStdout, bornes, depenseDuJour, exigerBudget, argsMaxTurns, sansModeLarge, argvPermissions, capacites, oublierCapacites, envAgent,
  OUTILS_LECTURE, INTERDITS_LECTURE, INTERDITS_ECRITURE, interditsDonnees,
  allowlistEcriture, sandboxSettings, BARE_KINDS,
};
