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

   Bash 3.2 compris (celui de macOS) : ni tableau associatif, ni `${x,,}`, ni heredoc dans `$( )`. */
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

const DOSSIER = '@FOLDER@';   // le dossier de travail dans les options d'agent, posé par le script

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
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

/* L'agent de la session, tel qu'il serait lancé : binaire, options, forme de la demande. */
function agentDe(task) {
  return cli.avec(cli.deSession(task), () => {
    const bin = copilot.binActuel();
    const backend = agentpolicy.backendDe(bin);
    const pol = agentpolicy.argvPermissions({ backend, bin, extra: copilot.argsActuels(), kind: 'local', cwd: DOSSIER });
    const flags = [...pol.extra, ...pol.args];
    flags.push(...agentpolicy.argsMaxTurns(backend, flags));
    const marque = '\u0000';
    const forme = require('../agent/backends').pour(backend).promptArgs(marque).filter((x) => x !== marque);
    return { bin, args: nettoyerArgs(flags), forme };
  });
}

/** Le script d'une session hors dépôt, et le nom de fichier proposé. */
function scriptDe(taskId) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task) throw new Error(t('err.session-introuvable'));
  const carte = localdirs.carte();
  const dossiers = db.prepare('SELECT dir_hash, dir_label FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId)
    .map((d) => carte.get(d.dir_hash) || d.dir_label || '').filter(Boolean);
  const nom = slug(task.label || String(task.prompt || '').split('\n')[0]) || `session-${task.id}`;
  const branche = task.branch || `ai/${nom}`;

  /* Le cadre AUTOUR de la demande, découpé sur la demande elle-même : modifier la demande en tête
     du script garde exactement les consignes que l'agent aurait reçues. */
  const complet = avecPreambule(promptPremierePasse(task.prompt));
  const i = complet.indexOf(task.prompt);
  const avant = i >= 0 ? complet.slice(0, i) : '';
  const apres = i >= 0 ? complet.slice(i + task.prompt.length) : '';
  const agent = agentDe(task);
  const cfg = getConfig();
  const demande = heredoc('PROMPT', task.prompt, '__PROMPT__');
  const m = (k, v) => t(`local.script.msg.${k}`, v || {});
  const c = (k, v) => `# ${t(`local.script.${k}`, v || {}).split('\n').join('\n# ')}`;

  const script = `#!/usr/bin/env bash
${c('title', { label: task.label || nom })}
${c('generated', { date: new Date().toISOString().slice(0, 10) })}
set -euo pipefail

${c('folders')}
FOLDERS=(
${dossiers.map((d) => `  ${sq(d)}`).join('\n')}
)

${c('prompt', { delim: demande.delim })}
${demande.code}

${c('git')}
BRANCH=${sq(branche)}
COMMIT_MESSAGE=${sq(commitMessageFor(task))}
PUSH=1
CREATE_MR=1

${c('agent')}
AGENT_BIN="\${AGENT_BIN:-${agent.bin.replace(/["\\$`]/g, '\\$&')}}"
AGENT_ARGS=(${agent.args.map(sq).join(' ')})
AGENT_PROMPT_FORM=(${agent.forme.map(sq).join(' ')})

${c('forge')}
GITLAB_URL="\${GITLAB_URL:-${String(cfg.gitlab_url || '').replace(/\/+$/, '')}}"
GITHUB_URL="\${GITHUB_URL:-${String(cfg.github_url || '').replace(/\/+$/, '')}}"

# ────────────────────────────────────────────────────────────────────────────
${c('framing')}
${heredoc('PROMPT_BEFORE', avant, '__BEFORE__').code}
${heredoc('PROMPT_AFTER', apres, '__AFTER__').code}

say() { printf '%s\\n' "$*" >&2; }
fail() { say "✖ $*"; exit 1; }

json_str() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}; s=\${s//\\"/\\\\\\"}; s=\${s//$'\\n'/\\\\n}; s=\${s//$'\\r'/\\\\r}; s=\${s//$'\\t'/\\\\t}
  printf '"%s"' "$s"
}

# $1 = variable name, $2 = question: read from the environment, otherwise asked on the terminal, hidden.
ask_secret() {
  local v=\${!1:-}
  if [ -z "$v" ]; then
    { [ -r /dev/tty ] && [ -w /dev/tty ]; } || fail "$(printf ${sq(m('no-tty'))} "$1")"
    printf '%s' "$2" > /dev/tty
    IFS= read -rs v < /dev/tty
    printf '\\n' > /dev/tty
    [ -n "$v" ] || fail ${sq(m('empty-secret'))}
  fi
  printf -v "$1" '%s' "$v"
}

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
      201) say "$(printf ${sq(m('mr-created'))} "$ref")" ;;
      422) say ${sq(m('mr-exists'))} ;;
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
      201) say "$(printf ${sq(m('mr-created'))} "$api/$R_PATH/-/merge_requests/$ref")" ;;
      409) say ${sq(m('mr-exists'))} ;;
      *) say "$(printf ${sq(m('mr-failed'))} "$code")"; say "$resp"; return 1 ;;
    esac
  fi
}

process_folder() {
  local dir=$1 base='' target snapshot h f a
  local args=()
  [ -d "$dir" ] || fail "$(printf ${sq(m('no-folder'))} "$dir")"
  cd "$dir"
  if [ -n "$BRANCH" ]; then
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$(printf ${sq(m('not-git'))} "$dir")"
    # ${t('local.script.dirty')}
    snapshot=$(mktemp)
    git ls-files -m -o --exclude-standard | while IFS= read -r f; do
      printf '%s\\t%s\\n' "$(git hash-object -- "$f" 2>/dev/null || echo -)" "$f"
    done > "$snapshot"
    base=$(git rev-parse --abbrev-ref HEAD)
    if [ "$base" = "$BRANCH" ]; then base=''
    elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then git checkout -q "$BRANCH"
    elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then git checkout -q -b "$BRANCH" "origin/$BRANCH"
    else git checkout -q -b "$BRANCH"; fi
  fi

  for a in \${AGENT_ARGS[@]+"\${AGENT_ARGS[@]}"}; do args+=("\${a//${DOSSIER}/$dir}"); done
  say "$ $AGENT_BIN \${args[*]+\${args[*]}} \${AGENT_PROMPT_FORM[*]+\${AGENT_PROMPT_FORM[*]}} …"
  "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PROMPT_BEFORE$PROMPT$PROMPT_AFTER" < /dev/null

  [ -n "$BRANCH" ] || return 0
  git add -A
  while IFS=$'\\t' read -r h f; do
    if [ "$(git hash-object -- "$f" 2>/dev/null || echo -)" = "$h" ]; then git reset -q -- "$f" 2>/dev/null || true; fi
  done < "$snapshot"
  rm -f "$snapshot"
  if git diff --cached --quiet; then say ${sq(m('nothing'))}; else git commit -q -m "$COMMIT_MESSAGE"; say "commit : $COMMIT_MESSAGE"; fi
  if [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; then
    git push -u origin "$BRANCH"
  fi
  if [ "$CREATE_MR" = 1 ]; then
    target=\${base:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)}
    create_mr "$BRANCH" "\${target:-main}" "$COMMIT_MESSAGE"
  fi
}

${c('tokens')}
if [ -n "$BRANCH" ] && [ "$CREATE_MR" = 1 ]; then
  for dir in "\${FOLDERS[@]}"; do
    [ -d "$dir" ] || continue
    case "$(forge_of "$dir")" in
      github) ask_secret GITHUB_TOKEN ${sq(m('ask-github'))} ;;
      gitlab) ask_secret GITLAB_TOKEN ${sq(m('ask-gitlab'))} ;;
    esac
  done
fi

failed=0
for dir in "\${FOLDERS[@]}"; do
  say "──────── $dir ────────"
  set +e
  ( set -e; process_folder "$dir" )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then failed=$((failed + 1)); say "$(printf ${sq(m('folder-failed'))} "$dir")"; fi
done
say "$(printf ${sq(m('done'))} "$(( \${#FOLDERS[@]} - failed ))" "\${#FOLDERS[@]}")"
[ "$failed" -eq 0 ]
`;
  return { script, fichier: `${nom}.sh` };
}

module.exports = { scriptDe, nettoyerArgs };
