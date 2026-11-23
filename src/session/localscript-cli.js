'use strict';
/* CE QUI REND LE SCRIPT EXPORTÉ AGRÉABLE À LANCER, autour de ce qu'il fait (localscript.js) :
   - des OPTIONS qui l'emportent sur les variables écrites en tête (`--prompt-file`, `--branch`,
     `--dry-run`…), une aide qui les liste avec les valeurs actuelles, un `.env` d'exemple ;
   - un RÉCAPITULATIF puis des VÉRIFICATIONS avant tout travail de l'agent — on échoue en dix
     secondes plutôt qu'après vingt minutes : agent absent, dossier modifié, jeton refusé — et une
     confirmation quand on est au terminal ;
   - des étapes lisibles, en couleur au terminal seulement (`NO_COLOR` respecté), un JOURNAL de
     chaque exécution, un BILAN par dossier (branche, commits, MR, note, durée) et un Ctrl-C qui
     remet le dossier en cours sur sa branche quand il le peut, puis dit où on en était.

   Chaque dossier tourne dans un sous-shell : ce qu'il a fait remonte par un fichier de résultats
   (`res clé valeur`), lu par le bilan. String.raw : du bash tel quel ; `${D}` écrit un `$`.
   Bash 3.2 compris. */

const D = '$';

/* Les noms de variables que l'aide affiche, et ceux qu'un `.env` peut fixer. */
const VALEURS = ['WORKSPACE_DIR', 'AGENT_BIN', 'PROMPT_FILE', 'BASE_BRANCH', 'BRANCH', 'COMMIT_MESSAGE', 'MR_TITLE',
  'COMMIT', 'PUSH', 'CREATE_MR', 'RESTORE_BRANCH', 'JIRA_TICKET'];
const VALEURS_CONV = ['CONVERGE', 'THRESHOLD', 'MAX_PASSES', 'REPORTS_DIR'];

function cliBash({ m, t, sq, conv }) {
  const aide = [t('local.script.help', { script: '%s' }), conv ? t('local.script.help-converge') : ''].filter(Boolean).join('\n');
  const optionsConv = '|--threshold|--max-passes|--reports-dir|--verify';
  return String.raw`# ── ${t('local.script.cli-code')}
colours() {
  if [ -t 2 ] && [ -z "${D}{NO_COLOR:-}" ] && [ "${D}{TERM:-}" != dumb ]; then
    C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_OFF=$'\033[0m'
  fi
}
ok() { say "${D}{C_OK}✓${D}{C_OFF} $*"; }
warn() { say "${D}{C_WARN}!${D}{C_OFF} $*"; }
bad() { say "${D}{C_ERR}✖${D}{C_OFF} $*"; }
step() { say "${D}{C_B}▸${D}{C_OFF} $*"; }
fmt_dur() { printf '%d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }

usage() {
  local n
  printf ${sq(aide)}'\n' "$0"
  printf '\n%s\n' ${sq(m('help-values'))}
  for n in ${[...VALEURS, ...(conv ? VALEURS_CONV : [])].join(' ')}; do printf '  %-16s %s\n' "$n" "${D}{!n:-}"; done
  printf '  %-16s %s\n' FOLDERS "${D}{FOLDERS[*]-}"
}

# A .env ready to fill: the current values (environment and .env included), the secrets left commented.
env_example() {
  local n
  printf '# %s\n' ${sq(m('env-example'))}
  for n in WORKSPACE_DIR AGENT_BIN JIRA_URL JIRA_EMAIL GITLAB_URL GITHUB_URL; do
    if [ -n "${D}{!n:-}" ]; then printf '%s=%q\n' "$n" "${D}{!n}"; else printf '# %s=\n' "$n"; fi
  done
  for n in PROMPT_FILE LOG_DIR TMPDIR no_proxy GITLAB_TOKEN GITHUB_TOKEN JIRA_TOKEN; do printf '# %s=\n' "$n"; done
}

OPT_FOLDERS=(); DRY_RUN=0; ASSUME_YES=${D}{ASSUME_YES:-0}; NO_LOG=0; LOG_FILE=''
# The options win over the variables above: "--name value" or "--name=value".
parse_cli() {
  local o
  while [ $# -gt 0 ]; do
    o=$1
    case $o in --*=*) set -- "${D}{o%%=*}" "${D}{o#*=}" "${D}{@:2}"; continue ;; esac
    case $o in
      -h|--help) usage; exit 0 ;;
      --env-example) env_example; exit 0 ;;
      -y|--yes) ASSUME_YES=1 ;;
      -n|--dry-run) DRY_RUN=1 ;;
      --no-color) NO_COLOR=1 ;;
      --no-log) NO_LOG=1 ;;
      --no-commit) COMMIT=0 ;;
      --no-push) PUSH=0; CREATE_MR=0 ;;
      --no-mr) CREATE_MR=0 ;;
      --no-restore) RESTORE_BRANCH=0 ;;
${conv ? `      --no-converge) CONVERGE=0 ;;
` : ''}      -p|--prompt|-f|--prompt-file|-b|--branch|--base|-m|--message|-t|--title|-j|--ticket|-d|--folder|-w|--workspace|-a|--agent|--log-dir${conv ? optionsConv : ''})
        [ $# -ge 2 ] || fail "$(printf ${sq(m('opt-value'))} "$o")"
        case $o in
          -p|--prompt) PROMPT=$2; PROMPT_FILE='' ;;
          -f|--prompt-file) PROMPT_FILE=$2 ;;
          -b|--branch) BRANCH=$2 ;;
          --base) BASE_BRANCH=$2 ;;
          -m|--message) COMMIT_MESSAGE=$2 ;;
          -t|--title) MR_TITLE=$2 ;;
          -j|--ticket) JIRA_TICKET=$2 ;;
          -d|--folder) OPT_FOLDERS+=("$2") ;;
          -w|--workspace) WORKSPACE_DIR=$2 ;;
          -a|--agent) AGENT_BIN=$2 ;;
          --log-dir) LOG_DIR=$2 ;;
${conv ? `          --threshold) THRESHOLD=$2 ;;
          --max-passes) MAX_PASSES=$2 ;;
          --reports-dir) REPORTS_DIR=$2 ;;
          --verify) VERIFY_CMDS+=("$2") ;;
` : ''}        esac
        shift ;;
${conv ? '' : `      --converge|--no-converge${optionsConv}) fail ${sq(m('opt-no-converge'))} ;;
`}      *) fail "$(printf ${sq(m('opt-unknown'))} "$o")" ;;
    esac
    shift
  done
}

# The request from PROMPT_FILE ("-" = standard input); every folder made absolute, a relative one
# under WORKSPACE_DIR (otherwise under the launch folder), ~ expanded.
resolve_inputs() {
  local d list=() ws=${D}{WORKSPACE_DIR:-}
  if [ -n "${D}{PROMPT_FILE:-}" ]; then
    if [ "$PROMPT_FILE" = - ]; then PROMPT=$(cat)
    else
      PROMPT_FILE=${D}{PROMPT_FILE/#\~/$HOME}
      [ -r "$PROMPT_FILE" ] || fail "$(printf ${sq(m('prompt-file-missing'))} "$PROMPT_FILE")"
      PROMPT=$(cat "$PROMPT_FILE")
    fi
  fi
  [ ${D}{#OPT_FOLDERS[@]} -eq 0 ] || FOLDERS=("${D}{OPT_FOLDERS[@]}")
  [ ${D}{#FOLDERS[@]} -gt 0 ] || fail ${sq(m('no-folders'))}
  ws=${D}{ws/#\~/$HOME}
  for d in "${D}{FOLDERS[@]}"; do
    d=${D}{d/#\~/$HOME}
    case $d in /*) ;; *) [ -z "$ws" ] || d="${D}{ws%/}/$d" ;; esac
    case $d in /*) ;; *) d="$PWD/$d" ;; esac
    [ "$d" = / ] || d=${D}{d%/}
    list+=("$d")
  done
  FOLDERS=("${D}{list[@]}")
}

agent_mode() {
  case " ${D}{AGENT_ARGS[*]-} " in
    *" --dangerously-skip-permissions "*|*" --allow-all-tools "*|*" --yolo "*|*" --dangerously-bypass-approvals-and-sandbox "*) printf '%s' ${sq(m('mode-yolo'))} ;;
    *) printf '%s' ${sq(m('mode-secure'))} ;;
  esac
}
yes_no() { if [ "$1" = 1 ]; then printf '%s' ${sq(m('yes'))}; else printf '%s' ${sq(m('no'))}; fi; }

# What is about to happen, before anything happens.
recap() {
  local d first lines
  say ""
  say "${D}{C_B}${m('recap-title')}${D}{C_OFF}"
  for d in "${D}{FOLDERS[@]}"; do say "  $(printf ${sq(m('recap-folder'))} "$d")"; done
  first=${D}{PROMPT%%$'\n'*}
  [ ${D}{#first} -le 100 ] || first="${D}{first:0:100}…"
  lines=$(printf '%s\n' "$PROMPT" | wc -l | tr -d ' ')
  say "  $(printf ${sq(m('recap-prompt'))} "$first" "$lines")"
  if [ -z "$BRANCH" ]; then say "  ${m('recap-no-branch')}"
  else
    say "  $(printf ${sq(m('recap-branch'))} "$BRANCH" "${D}{BASE_BRANCH:-${m('recap-current')}}")"
    if [ "$COMMIT" = 1 ]; then
      say "  $(printf ${sq(m('recap-commit'))} "$COMMIT_MESSAGE" "$(yes_no "$PUSH")")"
      if [ "$CREATE_MR" = 1 ]; then say "  $(printf ${sq(m('recap-mr'))} "${D}{MR_TITLE:-$COMMIT_MESSAGE}")"; fi
    else say "  ${m('recap-no-commit')}"; fi
  fi
  say "  $(printf ${sq(m('recap-agent'))} "$AGENT_BIN" "$(agent_mode)")"
  [ -z "$JIRA_TICKET" ] || say "  $(printf ${sq(m('recap-jira'))} "$JIRA_TICKET")"
${conv ? `  if [ "$CONVERGE" = 1 ]; then say "  $(printf ${sq(m('recap-converge'))} "$THRESHOLD" "$MAX_PASSES")"; fi
` : ''}  [ -z "$LOG_FILE" ] || say "  $(printf ${sq(m('recap-log'))} "$LOG_FILE")"
}

# Fails now rather than after the agent's work: missing agent, git or curl, a folder with changes
# in progress. A missing folder, a base branch or a remote out of reach: a warning, the other folders go on.
preflight() {
  local d url errs=0 dirty=0 changes
  say ""
  say "${D}{C_B}${m('checks-title')}${D}{C_OFF}"
  if command -v "$AGENT_BIN" >/dev/null 2>&1; then ok "$(printf ${sq(m('check-agent'))} "$AGENT_BIN")"
  else bad "$(printf ${sq(m('check-no-agent'))} "$AGENT_BIN")"; errs=$((errs + 1)); fi
  if command -v git >/dev/null 2>&1; then ok git; else bad ${sq(m('check-no-git'))}; errs=$((errs + 1)); fi
  if { [ -n "$BRANCH" ] && [ "$COMMIT" = 1 ] && [ "$CREATE_MR" = 1 ]; } || [ -n "$JIRA_TICKET" ]; then
    if command -v curl >/dev/null 2>&1; then ok curl; else bad ${sq(m('check-no-curl'))}; errs=$((errs + 1)); fi
  fi
  for d in "${D}{FOLDERS[@]}"; do
    if [ ! -d "$d" ]; then warn "$(printf ${sq(m('no-folder'))} "$d")"; continue; fi
    if ! git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      [ -z "$BRANCH" ] || warn "$(printf ${sq(m('not-git'))} "$d")"
      continue
    fi
    changes=$(dirty_files "$d")
    if [ -n "$changes" ]; then
      dirty=1
      bad "$(printf ${sq(m('dirty-folder'))} "$d")"
      printf '%s\n' "$changes" | sed 's/^/    /' >&2
      continue
    fi
    if [ -n "$BRANCH" ] && [ -n "$BASE_BRANCH" ] && ! git -C "$d" rev-parse -q --verify "$BASE_BRANCH^{commit}" >/dev/null \
      && ! git -C "$d" rev-parse -q --verify "origin/$BASE_BRANCH^{commit}" >/dev/null; then
      warn "$(printf ${sq(m('no-base-branch'))} "$BASE_BRANCH" "$d")"; continue
    fi
    if [ -n "$BRANCH" ] && [ "$COMMIT" = 1 ] && { [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; }; then
      if ! url=$(git -C "$d" remote get-url --push origin 2>/dev/null); then warn "$(printf ${sq(m('check-no-remote'))} "$d")"; continue; fi
      if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${D}{GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=10}" \
        git -C "$d" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 ls-remote -q "$url" HEAD >/dev/null 2>&1; then
        ok "$(printf ${sq(m('check-remote'))} "$d")"
      else warn "$(printf ${sq(m('check-remote-unreachable'))} "$d")"; fi
    else ok "$d"; fi
  done
  [ "$dirty" = 0 ] || fail ${sq(m('dirty-stop'))}
  [ "$errs" = 0 ] || fail ${sq(m('checks-failed'))}
}

# The forge of a folder's origin remote → F_KIND (github|gitlab), F_API, F_HOST. 1 = unreadable remote.
forge_api() {
  F_KIND=$(forge_of "$1")
  [ -n "$F_KIND" ] || return 1
  # forge_of ran in a subshell: the remote read again here.
  remote_info "$(git -C "$1" remote get-url origin 2>/dev/null || true)"
  F_HOST=$R_HOST
  if [ "$F_KIND" = github ]; then
    if [ "$R_HOST" = github.com ]; then F_API=https://api.github.com; else F_API="${D}{GITHUB_URL:-https://$R_HOST}/api/v3"; fi
  else F_API=${D}{GITLAB_URL:-https://$R_HOST}/api/v4; fi
}

# Each forge token present, tried once per API: refused stops here, out of reach is only a warning.
# The token reaches curl on its standard input, never on its command line.
check_tokens() {
  local d code tok head seen=' '
  [ -n "$BRANCH" ] && [ "$COMMIT" = 1 ] && [ "$CREATE_MR" = 1 ] || return 0
  for d in "${D}{FOLDERS[@]}"; do
    [ -d "$d" ] && forge_api "$d" || continue
    case $seen in *" $F_API "*) continue ;; esac
    seen="$seen$F_API "
    if [ "$F_KIND" = github ]; then tok=${D}{GITHUB_TOKEN:-}; head='Authorization: Bearer'; else tok=${D}{GITLAB_TOKEN:-}; head='PRIVATE-TOKEN:'; fi
    [ -n "$tok" ] || continue
    tok=${D}{tok//\\/\\\\}; tok=${D}{tok//\"/\\\"}
    code=$(printf 'header = "%s %s"\n' "$head" "$tok" | curl -sS --max-time 15 -K - -o /dev/null -w '%{http_code}' "$F_API/user" 2>/dev/null) || code=000
    case $code in
      200) ok "$(printf ${sq(m('check-token'))} "$F_HOST")" ;;
      401|403) fail "$(printf ${sq(m('check-token-refused'))} "$F_HOST" "$code")" ;;
      *) warn "$(printf ${sq(m('check-token-unknown'))} "$F_HOST" "$code")" ;;
    esac
  done
}

# At a terminal only (standard input and error), unless --yes.
confirm_run() {
  local r=''
  [ "$ASSUME_YES" != 1 ] && [ -t 0 ] && [ -t 2 ] || return 0
  printf '%s' ${sq(m('confirm'))} >&2
  IFS= read -r r || r=''
  case $r in [oOyY]*) return 0 ;; esac
  say ${sq(m('cancelled'))}
  exit 1
}

# Everything the run prints, also in a log file (colours stripped). Its writers ignore Ctrl-C, so
# the last lines (where the run stopped) still reach the screen and the file.
start_log() {
  local dir
  [ "$NO_LOG" != 1 ] || return 0
  dir=${D}{LOG_DIR:-$AGENT_TMP/$(basename "$0" .sh)-logs}
  dir=${D}{dir/#\~/$HOME}
  if ! mkdir -p "$dir" 2>/dev/null; then warn "$(printf ${sq(m('log-failed'))} "$dir")"; return 0; fi
  LOG_FILE="$dir/$(date +%Y%m%d-%H%M%S)-$$.log"
  : > "$LOG_FILE"
  exec 2> >(trap '' INT TERM; tee >(sed -u $'s/\033\\[[0-9;]*m//g' >> "$LOG_FILE") >&2)
  exec 1>&2
}

RESULTS_DIR=$(mktemp -d)
RES_FILE=''
res() { [ -z "$RES_FILE" ] || printf '%s=%s\n' "$1" "$2" >> "$RES_FILE"; }
res_get() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

# One line per folder: what it became, with its merge request, its score and how long it took.
summary() {
  local n f dir st text icon v
  [ -n "$(ls "$RESULTS_DIR" 2>/dev/null)" ] || return 0
  say ""
  say "${D}{C_B}${m('sum-title')}${D}{C_OFF}"
  for n in $(ls "$RESULTS_DIR" | sort -n); do
    f="$RESULTS_DIR/$n"; dir=$(res_get "$f" dir); st=$(res_get "$f" status)
    case $st in
      ok) icon="${D}{C_OK}✓${D}{C_OFF}"; text=$(printf ${sq(m('sum-ok'))} "$(res_get "$f" branch)" "$(res_get "$f" commits)") ;;
      nothing) icon="${D}{C_DIM}·${D}{C_OFF}"; text=${sq(m('sum-nothing'))} ;;
      uncommitted) icon="${D}{C_DIM}·${D}{C_OFF}"; text=$(printf ${sq(m('sum-uncommitted'))} "$(res_get "$f" branch)") ;;
      nobranch) icon="${D}{C_OK}✓${D}{C_OFF}"; text=${sq(m('sum-nobranch'))} ;;
      interrupted) icon="${D}{C_ERR}✖${D}{C_OFF}"; text=$(printf ${sq(m('sum-interrupted'))} "$(res_get "$f" step)") ;;
      *) icon="${D}{C_ERR}✖${D}{C_OFF}"; text=$(printf ${sq(m('sum-failed'))} "$(res_get "$f" step)") ;;
    esac
    v=$(res_get "$f" mr)
    case $v in '') ;; exists) text="$text · ${m('sum-mr-exists')}" ;; *) text="$text · MR $v" ;; esac
    v=$(res_get "$f" score); [ -z "$v" ] || text="$text · $(printf ${sq(m('sum-score'))} "$v")"
    v=$(res_get "$f" seconds); [ -z "$v" ] || text="$text · $(fmt_dur "$v")"
    say "  $icon $(basename "$dir") — $text"
    v=$(res_get "$f" reports); [ -z "$v" ] || say "      $(printf ${sq(m('sum-reports'))} "$v")"
  done
  [ -z "$LOG_FILE" ] || say "  $(printf ${sq(m('sum-log'))} "$LOG_FILE")"
}

# Ctrl-C: the folder in progress goes back to its branch when nothing of the agent's would follow it
# there (and RESTORE_BRANCH asks for it), otherwise it stays as it is, and the run says where it stopped.
CURRENT_DIR=''; CURRENT_ORIGIN=''; T0=0
on_interrupt() {
  local now
  trap - INT TERM
  say ""
  if [ -z "$CURRENT_DIR" ]; then warn ${sq(m('interrupted-before'))}; exit 130; fi
  warn "$(printf ${sq(m('interrupted'))} "$CURRENT_DIR" "$(res_get "$RES_FILE" step)")"
  res status interrupted
  res seconds $((SECONDS - T0))
  now=$(git -C "$CURRENT_DIR" symbolic-ref -q --short HEAD 2>/dev/null || git -C "$CURRENT_DIR" rev-parse -q --verify HEAD 2>/dev/null || true)
  if [ -n "$CURRENT_ORIGIN" ] && [ "$now" != "$CURRENT_ORIGIN" ]; then
    if [ "$COMMIT" = 1 ] && [ "$RESTORE_BRANCH" = 1 ] && [ -z "$(dirty_files "$CURRENT_DIR")" ] \
      && git -C "$CURRENT_DIR" ls-files -z --others --exclude-standard | cmp -s - "$UNTRACKED_BEFORE" \
      && git -C "$CURRENT_DIR" checkout -q "$CURRENT_ORIGIN" 2>/dev/null; then
      say "$(printf ${sq(m('restored'))} "$CURRENT_ORIGIN")"
    else warn "$(printf ${sq(m('interrupt-stays'))} "$now" "$CURRENT_DIR" "$CURRENT_ORIGIN")"; fi
  fi
  summary
  exit 130
}`;
}

module.exports = { cliBash };
