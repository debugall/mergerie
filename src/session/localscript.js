'use strict';
/* UNE SESSION HORS DÉPÔT, EXPORTÉE EN SCRIPT BASH AUTONOME. Le script refait ce que fait l'outil :
   dans chaque dossier, la branche de la session, l'agent avec le MÊME prompt (consignes permanentes
   comprises) et les mêmes options, puis commit, push et merge request (GitLab ou GitHub, déduit du
   remote `origin`). Ce qui se modifie à la main est en tête : les dossiers, la demande, git, l'agent.

   LE SCRIPT NE NOMME PAS L'OUTIL QUI L'A PRODUIT : il se lit, se partage et se relance sans lui. Les
   règles d'agent qui ne protègent que ses propres données (sa base, son jeton, son `.env`) n'y ont
   donc rien à faire : elles sont retirées, comme tout ce qui désignerait son dossier de données.

   Rien de secret n'y est écrit : les jetons de forge sont demandés à l'exécution (ou lus dans
   l'environnement), un push HTTPS demande ses identifiants par git lui-même. Les variables d'agent
   réglées à l'écran, qui peuvent porter des clés, ne sont pas reprises non plus.

   AVEC CONVERGENCE (`{ converge: true }`), le script enchaîne ce que fait la boucle de l'outil
   (review/converge.js) : une relecture en LECTURE SEULE du diff complet `base...HEAD`, sa note relue
   dans la même ligne stricte (« Note globale : X/10 », review/note.js), puis tant qu'elle est sous le
   seuil une passe de correction (gabarit `prompt_fix`), commit, push, et une nouvelle relecture —
   jusqu'au seuil, à une note qui baisse ou stagne, ou au plafond. Les gabarits sont figés à l'export,
   modifiables en tête. Pas de questions de l'IA, pas de reprise de session : chaque appel repart à
   neuf, le rapport précédent en contexte.

   Bash 3.2 compris (celui de macOS) : ni tableau associatif, ni `${x,,}`, ni heredoc dans `$( )`. */
const os = require('node:os');
const path = require('node:path');
const db = require('../db');
const localdirs = require('../data/localdirs');
const { getConfig } = require('../data/config');
const { DATA_DIR, ROOT } = require('../core/paths');
const { avecPreambule } = require('../core/nonfiable');
const copilot = require('../agent/copilot');
const agentpolicy = require('../agent/policy');
const cli = require('../agent/cli');
const { commitMessageFor } = require('./taskrunner');
const { promptPremierePasse } = require('./localcoder');
const { t } = require('../core/i18n');
const prompts = require('../core/prompts');
const { nonFiable } = require('../core/nonfiable');
const { convergeDefaults } = require('../review/converge');
const { jiraBash } = require('./localscript-jira');
const { cliBash } = require('./localscript-cli');
const { convergeBash, DOSSIER, TEMPORAIRE } = require('./localscript-converge');


const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/* Une variable que l'environnement peut fixer, sinon la valeur exportée — entre apostrophes : une
   valeur des réglages ne peut ni fermer l'expansion (`}`) ni rien exécuter (`$(…)`, guillemets). */
const envOu = (nom, valeur) => `${nom}=\${${nom}:-${sq(valeur)}}`;
// Même règle que la proposition de branche de la modale (`slugBranche`, public/js/ecrans/sessions/cibles.js).
const slug = (texte) => String(texte || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-').slice(0, 40);

/* Ce qui ne regarde que l'outil : son dossier de données, son code, son nom. */
function propreAOutil(s) {
  const v = String(s);
  if (/mergerie/i.test(v)) return false;
  return ![DATA_DIR, ROOT].some((d) => d && v.includes(d));
}
function nettoyerJson(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x !== 'string' || propreAOutil(x)).map(nettoyerJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nettoyerJson(x)]));
  return v;
}
/* Les options de l'agent, sans ce qui protège l'outil : une liste `a,b,c` perd ses éléments, un
   `--settings` JSON ses chaînes, une option seule disparaît avec sa valeur. */
function nettoyerArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a.startsWith('--') && i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
      let v = String(args[i + 1]);
      if (v.startsWith('{')) {
        try { v = JSON.stringify(nettoyerJson(JSON.parse(v))); } catch { /* laissé tel quel */ }
      } else if (/^--(dis)?allowedTools$/.test(a)) {
        v = v.split(',').filter(propreAOutil).join(',');
      }
      if (v && propreAOutil(v)) out.push(a, v);
      i += 1;
      continue;
    }
    if (propreAOutil(a)) out.push(a);
  }
  return out;
}

/* Un texte dans un heredoc : un délimiteur qu'aucune de ses lignes ne reprend. */
function heredoc(nom, texte, delim) {
  const lignes = String(texte).split('\n');
  let d = delim;
  while (lignes.includes(d)) d += '_';
  return { code: `IFS= read -r -d '' ${nom} <<'${d}' || true\n${texte}\n${d}\n${nom}="\${${nom}%$'\\n'}"`, delim: d };
}

/* AUCUN CHEMIN DU POSTE QUI EXPORTE dans les options : le dossier temporaire devient un jeton que le
   script remplace par le TMPDIR du lancement, et une commande permise par son chemin absolu
   (`shell(/Users/x/.nvm/…/bin/npm  ci)`, un vérificateur approuvé) par son seul nom, que le PATH de
   la machine qui lance résout. */
function sansCheminsDuPoste(a) {
  const tmp = os.tmpdir();
  let v = tmp.length > 1 ? String(a).split(tmp).join(TEMPORAIRE) : String(a);
  v = v.replace(/\b(shell|Bash)\(\/[^\s)]*\/([^\s/)]+)([^)]*)\)/g, (_, outil, bin, reste) => `${outil}(${bin}${reste.replace(/\s+/g, ' ')})`);
  return v;
}

/* L'agent de la session, tel qu'il serait lancé : binaire, options, forme de la demande. `relecture` :
   les options d'une review, EN LECTURE SEULE (kind `review` de agent/policy.js). */
function agentDe(task) {
  return cli.avec(cli.deSession(task), () => {
    const bin = copilot.binActuel();
    const backend = agentpolicy.backendDe(bin);
    const options = (kind) => {
      const pol = agentpolicy.argvPermissions({ backend, bin, extra: copilot.argsActuels(), kind, cwd: DOSSIER });
      const flags = [...pol.extra, ...pol.args];
      flags.push(...agentpolicy.argsMaxTurns(backend, flags));
      return nettoyerArgs(flags).map(sansCheminsDuPoste);
    };
    const marque = '\u0000';
    const forme = require('../agent/backends').pour(backend).promptArgs(marque).filter((x) => x !== marque);
    return { bin, args: options('local'), relecture: options('review'), forme };
  });
}

/* LES CONSIGNES DE LA RELECTURE, figées à l'export. Le gabarit de review et celui de correction sont
   ceux des réglages (`prompts.gabarit`), leurs variables laissées telles quelles — `{source}`,
   `{target}`, `{diff_file}`, `{title}`, `{description}`, `{report}` — pour que le script les remplisse
   à chaque passe. Le rapport à corriger arrive balisé comme une donnée (nonce de l'export). */
function gabaritsDeConvergence() {
  const cfg = getConfig();
  const review = prompts.gabarit('prompt_review', cfg);
  const fix = prompts.gabarit('prompt_fix', cfg).replace('{report}', nonFiable(t('local.script.data.report'), '@REPORT@'));
  const regles = [
    t('review.intent.title', { title: '{title}' }),
    t('review.intent.description', { description: '{description}' }),
    t('local.script.note-rule'),
    t('local.script.stdout-rule'),
  ].join('\n\n');
  return { review, fix, regles, preambule: t('prompt.untrusted.preamble') };
}

/* Le dossier parent commun des dossiers de travail ('' s'il n'y a que la racine du disque) : il devient
   WORKSPACE_DIR, surchargeable par l'environnement ou le .env, et chaque dossier s'écrit à partir de lui. */
function racineCommune(dossiers) {
  if (!dossiers.length) return '';
  let r = path.dirname(dossiers[0]);
  while (!dossiers.every((d) => d.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) r = path.dirname(r);
  return r === path.parse(r).root ? '' : r;
}

/** Le script d'une session hors dépôt, et le nom de fichier proposé. */
/* `yolo` : true = l'agent sans restriction (`--dangerously-skip-permissions` pour Claude), false = le
   mode sécurisé (droits d'écriture dans le dossier de travail), absent = le réglage du poste. Le
   prompt suit : la phrase « rien ne t'interdit d'écrire à côté » n'existe qu'en yolo. */
function scriptDe(taskId, { converge = false, vierge = false, yolo } = {}) {
  if (yolo === undefined) return construireScript(taskId, { converge, vierge });
  return agentpolicy.avecMode(yolo ? 'yolo' : 'secure', () => construireScript(taskId, { converge, vierge }));
}

function construireScript(taskId, { converge, vierge }) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task) throw new Error(t('err.session-introuvable'));
  const carte = localdirs.carte();
  const lignes = db.prepare('SELECT dir_hash, dir_label, base_branch FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId);
  const dossiers = lignes.map((d) => carte.get(d.dir_hash) || d.dir_label || '').filter(Boolean);
  // La branche de départ qu'a relevée une exécution, si tous les dossiers sont partis de la même.
  const bases = [...new Set(lignes.map((d) => d.base_branch).filter(Boolean))];
  const depart = bases.length === 1 ? bases[0] : '';
  const nom = slug(task.label || String(task.prompt || '').split('\n')[0]) || `session-${task.id}`;
  const branche = task.branch || `ai/${nom}`;
  const racine = racineCommune(dossiers);
  const fichier = `${nom}${converge ? '-converge' : ''}${vierge ? '-vierge' : ''}.sh`;

  /* Le cadre AUTOUR de la demande, découpé sur la demande elle-même : modifier la demande en tête
     du script garde exactement les consignes que l'agent aurait reçues. */
  const complet = avecPreambule(promptPremierePasse(task.prompt));
  const i = complet.indexOf(task.prompt);
  const avant = i >= 0 ? complet.slice(0, i) : '';
  const apres = i >= 0 ? complet.slice(i + task.prompt.length) : '';
  const agent = agentDe(task);
  const cfg = getConfig();
  /* VIERGE : un modèle à remplir — demande, branches, message et titre vides, et le script refuse
     de partir tant qu'ils le sont. Le cadre autour de la demande reste celui de la session. */
  const demande = heredoc('PROMPT', vierge ? '' : task.prompt, '__PROMPT__');
  const m = (k, v) => t(`local.script.msg.${k}`, v || {});
  const c = (k, v) => `# ${t(`local.script.${k}`, v || {}).split('\n').join('\n# ')}`;
  const v = (nom) => c(`var.${nom}`);

  const conv = converge ? { ...convergeDefaults(), ...gabaritsDeConvergence() } : null;
  const revue = conv && heredoc('REVIEW_PROMPT', conv.review, '__REVIEW__');
  const correction = conv && heredoc('FIX_PROMPT', conv.fix, '__FIX__');
  const blocConvergence = !conv ? '' : `
${c('converge')}
${v('CONVERGE')}
CONVERGE=1
${v('THRESHOLD')}
THRESHOLD=${conv.threshold}
${v('MAX_PASSES')}
MAX_PASSES=${conv.maxPasses}
${v('VERIFY_CMDS')}
VERIFY_CMDS=(
)
${v('REPORTS_DIR')}
REPORTS_DIR=''

${c('review-prompt', { delim: revue.delim })}
${revue.code}

${c('fix-prompt', { delim: correction.delim })}
${correction.code}
`;

  const script = `#!/usr/bin/env bash
set -euo pipefail

${c('usage', { script: `./${fichier}` })}

${c('env')}
load_env() {
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    line=\${line%$'\\r'}; line=\${line#"\${line%%[![:space:]]*}"}; line=\${line#export }
    case $line in '#'*|[!A-Za-z_]*) continue ;; *=*) ;; *) continue ;; esac
    key=\${line%%=*}
    case $key in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
    [ -z "\${!key+x}" ] || continue
    # Set for the script, not exported: the agent never sees the tokens. TMPDIR alone is, the agent's sandbox follows it.
    eval "$line"
    [ "$key" != TMPDIR ] || export TMPDIR
  done < "$1"
}
ENV_FILE=\${ENV_FILE:-"$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/.env"}
[ ! -f "$ENV_FILE" ] || load_env "$ENV_FILE"

# ════════════════════════════════════════════════════════════════════════════
${c('section-main')}
# ════════════════════════════════════════════════════════════════════════════

${racine ? `${v('WORKSPACE_DIR')}
${envOu('WORKSPACE_DIR', racine)}
` : ''}${c('folders')}
FOLDERS=(
${dossiers.map((d) => `  ${sq(racine ? path.relative(racine, d) : d)}`).join('\n')}
)

${v('AGENT_BIN')}
${envOu('AGENT_BIN', agent.bin)}

${v('PROMPT_FILE')}
PROMPT_FILE=\${PROMPT_FILE:-''}
${c('prompt', { delim: demande.delim })}
${demande.code}
${blocConvergence}
${c('git')}
${v('BASE_BRANCH')}
BASE_BRANCH=${sq(vierge ? '' : depart)}
${v('BRANCH')}
BRANCH=${sq(vierge ? '' : branche)}
${v('COMMIT')}
COMMIT=1
${v('COMMIT_MESSAGE')}
COMMIT_MESSAGE=${sq(vierge ? '' : commitMessageFor(task))}
${v('MR_TITLE')}
MR_TITLE=${sq(vierge ? '' : commitMessageFor(task))}
${v('PUSH')}
PUSH=1
${v('CREATE_MR')}
CREATE_MR=1
${v('RESTORE_BRANCH')}
RESTORE_BRANCH=1

${v('JIRA_TICKET')}
JIRA_TICKET=''

# ════════════════════════════════════════════════════════════════════════════
${c('section-advanced')}
# ════════════════════════════════════════════════════════════════════════════

${c('agent')}
${v('AGENT_ARGS')}
AGENT_ARGS=(${agent.args.map(sq).join(' ')})
${v('AGENT_PROMPT_FORM')}
AGENT_PROMPT_FORM=(${agent.forme.map(sq).join(' ')})
${conv ? `${v('REVIEW_ARGS')}
REVIEW_ARGS=(${agent.relecture.map(sq).join(' ')})
` : ''}
${c('jira')}
${v('JIRA_URL')}
${envOu('JIRA_URL', String(cfg.jira_url || '').replace(/\/+$/, ''))}
${v('JIRA_EMAIL')}
${envOu('JIRA_EMAIL', cfg.jira_email || '')}
${v('JIRA_TECH_MARKER')}
JIRA_TECH_MARKER=${sq(String(cfg.jira_tech_marker || '').trim() || '#tech')}

${c('forge')}
${v('GITLAB_URL')}
${envOu('GITLAB_URL', String(cfg.gitlab_url || '').replace(/\/+$/, ''))}
${v('GITHUB_URL')}
${envOu('GITHUB_URL', String(cfg.github_url || '').replace(/\/+$/, ''))}
${v('NO_PROXY_GITLAB')}
NO_PROXY_GITLAB=0

${v('LOG_DIR')}
LOG_DIR=\${LOG_DIR:-''}

# ────────────────────────────────────────────────────────────────────────────
${c('framing')}
${heredoc('PROMPT_BEFORE', avant, '__BEFORE__').code}
${heredoc('PROMPT_AFTER', apres, '__AFTER__').code}
${conv ? `${heredoc('PREAMBLE', conv.preambule, '__PREAMBLE__').code}
${heredoc('REVIEW_RULES', conv.regles, '__RULES__').code}
${heredoc('PREVIOUS_INTRO', t('local.script.previous-report'), '__PREVIOUS__').code}
` : ''}
AGENT_TMP=\${TMPDIR:-/tmp}; AGENT_TMP=\${AGENT_TMP%/}

# curl ignores the "*.domain" wildcards of no_proxy: turned into ".domain" so internal hosts bypass the proxy.
# Whichever of no_proxy / NO_PROXY is set; other entries (localhost, IPs, ".domain") as they are; nothing set = nothing exported.
no_proxy=$(printf '%s' "\${no_proxy:-\${NO_PROXY:-}}" | sed -E 's/(^|,)[[:space:]]*\\*\\./\\1./g; s/[[:space:]]+//g')
if [ "$NO_PROXY_GITLAB" = 1 ]; then
  gl_host=\${GITLAB_URL#*://}; gl_host=\${gl_host%%[/:]*}
  [ -z "$gl_host" ] || no_proxy="\${no_proxy:+$no_proxy,}$gl_host"
fi
if [ -n "$no_proxy" ]; then export no_proxy NO_PROXY=$no_proxy; else unset no_proxy; fi
C_OK=''; C_ERR=''; C_WARN=''; C_DIM=''; C_B=''; C_OFF=''
say() { printf '%s\\n' "$*" >&2; }
fail() { say "\${C_ERR}✖ $*\${C_OFF}"; exit 1; }

json_str() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}; s=\${s//\\"/\\\\\\"}; s=\${s//$'\\n'/\\\\n}; s=\${s//$'\\r'/\\\\r}; s=\${s//$'\\t'/\\\\t}
  printf '"%s"' "$s"
}

# $1 = variable name, $2 = question: read from the environment, otherwise asked on the terminal, hidden.
# $3 = soft: no terminal or an empty answer returns 1 instead of stopping the script.
ask_secret() {
  local v=\${!1:-}
  if [ -z "$v" ]; then
    if [ -n "\${3:-}" ] && ! { : < /dev/tty; } 2>/dev/null; then return 1; fi
    { [ -r /dev/tty ] && [ -w /dev/tty ]; } || fail "$(printf ${sq(m('no-tty'))} "$1")"
    printf '%s' "$2" > /dev/tty
    IFS= read -rs v < /dev/tty
    printf '\\n' > /dev/tty
    [ -n "$v" ] || { [ -z "\${3:-}" ] || return 1; fail ${sq(m('empty-secret'))}; }
  fi
  printf -v "$1" '%s' "$v"
}

${jiraBash({ m, t, sq })}

${cliBash({ m, t, sq, conv })}

# origin remote → R_HOST (host, port included) and R_PATH (group/project).
remote_info() {
  local u=\${1%.git} rest=''
  R_HOST=''; R_PATH=''
  case $u in
    *://*) rest=\${u#*://}; rest=\${rest#*@}; R_HOST=\${rest%%/*}; R_PATH=\${rest#*/} ;;
    *@*:*) rest=\${u#*@}; R_HOST=\${rest%%:*}; R_PATH=\${rest#*:} ;;
  esac
  [ "$R_PATH" != "$R_HOST" ] || R_PATH=''
}

host_of() { local h=\${1#*://}; printf '%s' "\${h%%/*}"; }

# github | gitlab | nothing (unreadable remote), from the folder's origin remote.
forge_of() {
  remote_info "$(git -C "$1" remote get-url origin 2>/dev/null || true)"
  [ -n "$R_PATH" ] || return 0
  if [ "$R_HOST" = github.com ] || { [ -n "$GITHUB_URL" ] && [ "$R_HOST" = "$(host_of "$GITHUB_URL")" ]; }; then printf github; else printf gitlab; fi
}

create_mr() {
  local source=$1 target=$2 title=$3 api body resp code ref
  remote_info "$(git remote get-url origin 2>/dev/null || true)"
  if [ -z "$R_PATH" ]; then say ${sq(m('mr-no-remote'))}; return 0; fi
  if [ "$(forge_of .)" = github ]; then
    ask_secret GITHUB_TOKEN ${sq(m('ask-github'))}
    if [ "$R_HOST" = github.com ]; then api=https://api.github.com; else api="\${GITHUB_URL:-https://$R_HOST}/api/v3"; fi
    body="{\\"title\\":$(json_str "$title"),\\"head\\":$(json_str "$source"),\\"base\\":$(json_str "$target")}"
    resp=$(curl -sS -w '\\n%{http_code}' -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \\
      -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' --data "$body" "$api/repos/$R_PATH/pulls")
    code=\${resp##*$'\\n'}; resp=\${resp%$'\\n'*}
    ref=$(printf '%s' "$resp" | grep -o '"html_url": *"[^"]*"' | head -1 | sed 's/.*"\\(http[^"]*\\)"/\\1/' || true)
    case $code in
      201) say "$(printf ${sq(m('mr-created'))} "$ref")"; res mr "$ref" ;;
      422) say ${sq(m('mr-exists'))}; res mr exists ;;
      *) say "$(printf ${sq(m('mr-failed'))} "$code")"; say "$resp"; return 1 ;;
    esac
  else
    ask_secret GITLAB_TOKEN ${sq(m('ask-gitlab'))}
    api=\${GITLAB_URL:-https://$R_HOST}
    body="{\\"source_branch\\":$(json_str "$source"),\\"target_branch\\":$(json_str "$target"),\\"title\\":$(json_str "$title")}"
    resp=$(curl -sS -w '\\n%{http_code}' -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H 'Content-Type: application/json' \\
      --data "$body" "$api/api/v4/projects/\${R_PATH//\\//%2F}/merge_requests")
    code=\${resp##*$'\\n'}; resp=\${resp%$'\\n'*}
    ref=$(printf '%s' "$resp" | grep -o '"iid": *[0-9]*' | head -1 | grep -o '[0-9]*$' || true)
    case $code in
      201) say "$(printf ${sq(m('mr-created'))} "$api/$R_PATH/-/merge_requests/$ref")"; res mr "$api/$R_PATH/-/merge_requests/$ref" ;;
      409) say ${sq(m('mr-exists'))}; res mr exists ;;
      *) say "$(printf ${sq(m('mr-failed'))} "$code")"; say "$resp"; return 1 ;;
    esac
  fi
}

${conv ? convergeBash({ m, t, sq }) : ''}
# $1 = folder: its changes in progress, one per line, minus what .gitignore names — even a file committed in the past.
# A file never committed does not count: it stays where it is, out of the commits (commit_work).
dirty_files() {
  local e f skip=0
  git -C "$1" status --porcelain -z --untracked-files=no | while IFS= read -r -d '' e; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    f=\${e:3}
    case "\${e:0:1}" in R|C) skip=1 ;; esac
    git -C "$1" check-ignore -q --no-index -- "$f" || printf '%s\\n' "$e"
  done
}

# What the agent changed (the folder was clean before it), without what .gitignore names
# nor the never-committed files that were there before it: 0 = committed, 1 = nothing.
# The agent's own commits since AGENT_START are folded into this one: the message is always COMMIT_MESSAGE.
UNTRACKED_BEFORE=$(mktemp)
trap 'rm -f "$UNTRACKED_BEFORE"; [ -z "$RESULTS_DIR" ] || rm -rf -- "$RESULTS_DIR"' EXIT
AGENT_START=''
commit_work() {
  local f
  if [ -n "$AGENT_START" ] && [ "$(git rev-parse HEAD)" != "$AGENT_START" ]; then git reset -q --soft "$AGENT_START"; fi
  git add -A
  # Never with an empty list: without a path, git reset unstages everything.
  if [ -s "$UNTRACKED_BEFORE" ]; then git --literal-pathspecs reset -q --pathspec-from-file="$UNTRACKED_BEFORE" --pathspec-file-nul; fi
  git diff --cached --name-only -z | while IFS= read -r -d '' f; do
    if git check-ignore -q --no-index -- "$f"; then git reset -q -- "$f"; fi
  done
  if git diff --cached --quiet; then return 1; fi
  git commit -q -m "$COMMIT_MESSAGE"; say "commit : $COMMIT_MESSAGE"
}

process_folder() {
  local dir=$1 base='' start=HEAD target a t0
  local args=()
  [ -d "$dir" ] || fail "$(printf ${sq(m('no-folder'))} "$dir")"
  cd "$dir"
  if [ -n "$BRANCH" ]; then
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$(printf ${sq(m('not-git'))} "$dir")"
    base=$(git rev-parse --abbrev-ref HEAD)
    if [ -n "$BASE_BRANCH" ]; then
      start=$BASE_BRANCH
      git rev-parse -q --verify "$start^{commit}" >/dev/null || start="origin/$BASE_BRANCH"
      git rev-parse -q --verify "$start^{commit}" >/dev/null || fail "$(printf ${sq(m('no-base-branch'))} "$BASE_BRANCH" "$dir")"
    fi
    if [ "$base" = "$BRANCH" ]; then base=''
    elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then git checkout -q "$BRANCH"
    elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then git checkout -q -b "$BRANCH" "origin/$BRANCH"
    else git checkout -q -b "$BRANCH" "$start"; fi
    base=\${BASE_BRANCH:-$base}
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -z --others --exclude-standard > "$UNTRACKED_BEFORE"; fi
  for a in \${AGENT_ARGS[@]+"\${AGENT_ARGS[@]}"}; do a=\${a//${DOSSIER}/$PWD}; args+=("\${a//${TEMPORAIRE}/$AGENT_TMP}"); done
  step "$(printf ${sq(m('step-agent'))} "$AGENT_BIN")"
  say "\${C_DIM}$ $AGENT_BIN \${args[*]+\${args[*]}} \${AGENT_PROMPT_FORM[*]+\${AGENT_PROMPT_FORM[*]}} …\${C_OFF}"
  res step agent
  t0=$SECONDS
  AGENT_START=$(git rev-parse -q --verify HEAD 2>/dev/null || true)
  "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PROMPT_BEFORE$JIRA_PREFIX$PROMPT$PROMPT_AFTER" < /dev/null
  ok "$(printf ${sq(m('step-agent-done'))} "$(fmt_dur $((SECONDS - t0)))")"

  if [ -z "$BRANCH" ]; then res status nobranch; return 0; fi
  res branch "$BRANCH"
  if [ "$COMMIT" != 1 ]; then say "$(printf ${sq(m('no-commit'))} "$BRANCH")"; res status uncommitted; return 0; fi
  res step commit
  commit_work || say ${sq(m('nothing'))}
  target=\${base:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)}
  target=\${target:-main}
  # No commit of its own over the target: pushing would open a merge request of someone else's commits.
  a=$target
  git rev-parse -q --verify "$a^{commit}" >/dev/null || a="origin/$target"
  if git rev-parse -q --verify "$a^{commit}" >/dev/null && [ "$(git rev-list --count "$a..HEAD")" = 0 ]; then
    say "$(printf ${sq(m('no-work'))} "$BRANCH" "$target")"; res status nothing; return 0
  fi
  res commits "$(git rev-list --count "$a..HEAD" 2>/dev/null || echo '?')"
  if [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; then
    res step push
    git push -q -u origin "$BRANCH"
  fi
  if [ "$CREATE_MR" = 1 ]; then
    res step mr
    create_mr "$BRANCH" "$target" "\${MR_TITLE:-$COMMIT_MESSAGE}"
  fi${conv ? `
  if [ "$CONVERGE" = 1 ]; then
    if git rev-parse -q --verify "$target^{commit}" >/dev/null; then converge_folder "$target"
    elif git rev-parse -q --verify "origin/$target^{commit}" >/dev/null; then converge_folder "origin/$target"
    else say "$(printf ${sq(m('conv-no-base'))} "$target")"; fi
  fi` : ''}
  res commits "$(git rev-list --count "$a..HEAD" 2>/dev/null || echo '?')"
  res status ok
}

trap on_interrupt INT TERM
parse_cli "$@"
colours
resolve_inputs

${c(vierge ? 'required' : 'required-prompt')}
missing=''
[ -n "\${PROMPT//[[:space:]]/}" ] || missing="$missing PROMPT"
${vierge ? `for var in COMMIT_MESSAGE MR_TITLE; do
  [ -n "\${!var}" ] || missing="$missing $var"
done
` : ''}[ -z "$missing" ] || fail "$(printf ${sq(m('missing'))} "\${missing# }")"

[ "$DRY_RUN" = 1 ] || start_log
recap
${c('clean')}
preflight
if [ "$DRY_RUN" = 1 ]; then
  check_tokens
  say ""; ok ${sq(m('dry-run'))}
  exit 0
fi
confirm_run

${c('tokens')}
if [ -n "$BRANCH" ] && [ "$COMMIT" = 1 ] && [ "$CREATE_MR" = 1 ]; then
  for dir in "\${FOLDERS[@]}"; do
    [ -d "$dir" ] || continue
    case "$(forge_of "$dir")" in
      github) ask_secret GITHUB_TOKEN ${sq(m('ask-github'))} ;;
      gitlab) ask_secret GITLAB_TOKEN ${sq(m('ask-gitlab'))} ;;
    esac
  done
fi
check_tokens
JIRA_CONTEXT=''
JIRA_PREFIX=''
if [ -n "$JIRA_TICKET" ]; then
  if [ -z "$JIRA_URL" ]; then say ${sq(m('jira-no-url'))}
  elif ask_secret JIRA_TOKEN ${sq(m('ask-jira'))} soft; then fetch_jira
  else say ${sq(m('jira-no-token'))}; fi
fi
# ${t('local.script.ticket-coding-note')}
if [ -n "$JIRA_CONTEXT" ]; then
  JIRA_PREFIX="$(printf ${sq(t('local.script.ticket-coding'))} "$JIRA_TICKET")"$'\n\n'"$JIRA_CONTEXT"$'\n\n---\n\n'
fi
${conv ? `
# REPORTS_DIR: ~ and a relative path resolved from where the script is launched, before any cd.
REPORTS_ROOT=\${REPORTS_DIR/#\~/$HOME}
case $REPORTS_ROOT in ''|/*) ;; *) REPORTS_ROOT="$PWD/$REPORTS_ROOT" ;; esac
` : ''}
failed=0
i=0
for dir in "\${FOLDERS[@]}"; do
  i=$((i + 1))
  RES_FILE="$RESULTS_DIR/$i"
  printf 'dir=%s\n' "$dir" > "$RES_FILE"
  say ""
  say "\${C_B}[$i/\${#FOLDERS[@]}] $(basename "$dir")\${C_OFF}  \${C_DIM}$dir\${C_OFF}"
  # ${t('local.script.restore')}
  origin=''
  if [ -d "$dir" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    origin=$(git -C "$dir" symbolic-ref -q --short HEAD || git -C "$dir" rev-parse -q --verify HEAD || true)
  fi
  CURRENT_DIR=$dir; CURRENT_ORIGIN=$origin; T0=$SECONDS
  set +e
  ( set -e; process_folder "$dir" )
  rc=$?
  set -e
  res seconds $((SECONDS - T0))
  if [ "$rc" -ne 0 ]; then failed=$((failed + 1)); res status failed; bad "$(printf ${sq(m('folder-failed'))} "$dir")"; fi
  now=$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null || git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null || true)
  if [ -n "$origin" ] && [ "$now" != "$origin" ]; then
    if [ "$COMMIT" != 1 ] || [ "$RESTORE_BRANCH" != 1 ]; then say "$(printf ${sq(m('stays'))} "$now")"
    elif git -C "$dir" checkout -q "$origin"; then say "$(printf ${sq(m('restored'))} "$origin")"
    else say "$(printf ${sq(m('restore-failed'))} "$origin" "$dir")"; fi
  fi
  CURRENT_DIR=''
done
summary
say ""
say "$(printf ${sq(m('done'))} "$(( \${#FOLDERS[@]} - failed ))" "\${#FOLDERS[@]}")"
[ "$failed" -eq 0 ]
`;
  return { script, fichier };
}

module.exports = { scriptDe, nettoyerArgs, sansCheminsDuPoste };
