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

const DOSSIER = '@FOLDER@';   // le dossier de travail dans les options d'agent, posé par le script

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
      return nettoyerArgs(flags);
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

${c('folders')}
FOLDERS=(
${dossiers.map((d) => `  ${sq(d)}`).join('\n')}
)

${c('agent')}
${v('AGENT_BIN')}
${envOu('AGENT_BIN', agent.bin)}
${v('AGENT_ARGS')}
AGENT_ARGS=(${agent.args.map(sq).join(' ')})
${v('AGENT_PROMPT_FORM')}
AGENT_PROMPT_FORM=(${agent.forme.map(sq).join(' ')})
${conv ? `${v('REVIEW_ARGS')}
REVIEW_ARGS=(${agent.relecture.map(sq).join(' ')})
` : ''}
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

${c('jira')}
${v('JIRA_TICKET')}
JIRA_TICKET=''
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

# ────────────────────────────────────────────────────────────────────────────
${c('framing')}
${heredoc('PROMPT_BEFORE', avant, '__BEFORE__').code}
${heredoc('PROMPT_AFTER', apres, '__AFTER__').code}
${conv ? `${heredoc('PREAMBLE', conv.preambule, '__PREAMBLE__').code}
${heredoc('REVIEW_RULES', conv.regles, '__RULES__').code}
${heredoc('PREVIOUS_INTRO', t('local.script.previous-report'), '__PREVIOUS__').code}
` : ''}
say() { printf '%s\\n' "$*" >&2; }
fail() { say "✖ $*"; exit 1; }

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

${conv ? `# ── ${t('local.script.converge-code')}
# A tagged data block (nonce of this run): what the agent reads as data, never as instructions.
NONCE=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
data_block() {
  local body
  body=$(printf '%s' "$2" | sed 's/<<</‹‹‹/g; s/>>>/›››/g')
  printf '<<<DONNEE %s %s>>>\\n%s\\n<<<FIN DONNEE %s>>>' "$NONCE" "$1" "$body" "$NONCE"
}

# The template variables, filled for this pass. {report} last: a report quoting {source} stays as it is.
fill() {
  local s=$1 p v
  p='{source}'; s=\${s//$p/"$BRANCH"}
  p='{target}'; s=\${s//$p/"$REF"}
  p='{diff_file}'; s=\${s//$p/"$DIFF_REL"}
  p='{project}'; s=\${s//$p/"$(basename "$PWD")"}
  p='{lines_file}'; s=\${s//$p/}
  p='{out_file}'; s=\${s//$p/}
  v=$(data_block ${sq(t('local.script.data.title'))} "\${MR_TITLE:-$COMMIT_MESSAGE}"); p='{title}'; s=\${s//$p/"$v"}
  v=$(data_block ${sq(t('local.script.data.request'))} "$PROMPT"); p='{description}'; s=\${s//$p/"$v"}
  p='@REPORT@'; v=$(printf '%s' "$CUR_REPORT" | sed 's/<<</‹‹‹/g; s/>>>/›››/g'); s=\${s//$p/"$v"}
  printf '%s' "$s"
}

# The score of a report: the last "Overall score: X/10" line (or a score heading and the line after it). Empty = none.
score_of() {
  awk '{ l[NR] = $0 }
  END {
    for (i = NR; i >= 1; i--) {
      s = tolower(l[i]); sub(/\\r$/, "", s)
      if (s ~ /^[ \\t]*[*_]*[ \\t]*(note[ \\t]+globale|overall[ \\t]+score)[ \\t]*[*_]*[ \\t]*:[ \\t]*[*_]*[ \\t]*[0-9]+([.,][0-9]+)?[ \\t]*\\/[ \\t]*10[ \\t]*[*_]*[ \\t]*\\.?[ \\t]*$/) {
        sub(/^[^:]*:[ \\t*_]*/, "", s); sub(/[ \\t]*\\/.*$/, "", s); print s; exit
      }
      if (s ~ /^[ \\t]*#+[ \\t]*(note[ \\t]+globale|overall[ \\t]+score)[ \\t]*:?[ \\t]*$/) {
        for (j = i + 1; j <= NR && l[j] !~ /[^ \\t\\r]/; j++) {}
        if (j <= NR && l[j] ~ /^[ \\t]*[*_]*[ \\t]*[0-9]+([.,][0-9]+)?[ \\t]*\\/[ \\t]*10/) {
          v = l[j]; sub(/^[ \\t*_]+/, "", v); sub(/[ \\t]*\\/.*$/, "", v); print v; exit
        }
      }
    }
  }' "$1" | tr , .
}
at_least() { awk -v a="$1" -v b="$(printf '%s' "$2" | tr , .)" 'BEGIN { exit !(a + 0 >= b + 0) }'; }

# $1 = pass number: the full diff base...HEAD read by the agent in read-only mode, its report in review-N.md.
run_review() {
  local n=$1 a prompt args=()
  git diff "$REF...HEAD" > "$WORK/diff.patch"
  for a in \${REVIEW_ARGS[@]+"\${REVIEW_ARGS[@]}"}; do args+=("\${a//${DOSSIER}/$PWD}"); done
  prompt=$(fill "$REVIEW_PROMPT"$'\\n\\n'"$REVIEW_RULES")
  if [ "$n" -gt 0 ] && [ -f "$RUN/review-$((n - 1)).md" ]; then
    prompt="$prompt"$'\\n\\n'"$PREVIOUS_INTRO"$'\\n'"$(data_block ${sq(t('local.script.data.previous'))} "$(cat "$RUN/review-$((n - 1)).md")")"
  fi
  if [ -n "$JIRA_CONTEXT" ]; then
    prompt="$prompt"$'\\n\\n'"$(printf ${sq(t('local.script.ticket-intro'))} "$JIRA_TICKET")"$'\\n'"$(data_block "$(printf ${sq(t('local.script.data.ticket'))} "$JIRA_TICKET")" "$JIRA_CONTEXT")"
  fi
  say "$(printf ${sq(m('conv-review'))} "$n")"
  "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PREAMBLE"$'\\n\\n'"$prompt" < /dev/null > "$RUN/review-$n.md"
  say "$(printf ${sq(m('conv-report'))} "$RUN/review-$n.md")"
}

run_verify() {
  local cmd
  for cmd in \${VERIFY_CMDS[@]+"\${VERIFY_CMDS[@]}"}; do
    if bash -c "$cmd" > "$WORK/verify.log" 2>&1; then say "✓ $cmd"; else say "$(printf ${sq(m('conv-verify-failed'))} "$cmd" "$WORK/verify.log")"; fi
  done
}

# The loop: review, then while the score is below the threshold, fix → commit → push → review again.
converge_folder() {
  local score new pass=0 status a args=()
  REF=$1
  WORK="$(git rev-parse --absolute-git-dir)/converge"
  # One folder per run, so a second run never overwrites the reports of the first.
  if [ -n "$REPORTS_DIR" ]; then RUN="$REPORTS_ROOT/$(basename "$PWD")"; else RUN=$WORK; fi
  RUN="$RUN/\${BRANCH//\//-}-$(date +%Y%m%d-%H%M%S)"; a=$RUN
  while [ -e "$RUN" ]; do pass=$((pass + 1)); RUN="$a-$((pass + 1))"; done
  pass=0
  mkdir -p "$WORK" "$RUN"
  DIFF_REL="$WORK/diff.patch"
  say "$(printf ${sq(m('conv-start'))} "$THRESHOLD" "$MAX_PASSES" "$REF")"
  run_review 0
  score=$(score_of "$RUN/review-0.md")
  while :; do
    if [ -z "$score" ]; then status=${sq(m('conv-no-score'))}; break; fi
    say "$(printf ${sq(m('conv-score'))} "$score")"
    if at_least "$score" "$THRESHOLD"; then status="$(printf ${sq(m('conv-converged'))} "$score" "$pass")"; break; fi
    if [ "$pass" -ge "$MAX_PASSES" ]; then status="$(printf ${sq(m('conv-capped'))} "$MAX_PASSES" "$score")"; break; fi
    pass=$((pass + 1))
    say "$(printf ${sq(m('conv-fix'))} "$pass" "$MAX_PASSES")"
    CUR_REPORT=$(cat "$RUN/review-$((pass - 1)).md")
    args=()
    for a in \${AGENT_ARGS[@]+"\${AGENT_ARGS[@]}"}; do args+=("\${a//${DOSSIER}/$PWD}"); done
    AGENT_START=$(git rev-parse HEAD)
    "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PREAMBLE"$'\\n\\n'"$(fill "$FIX_PROMPT")" < /dev/null
    if ! commit_work; then status=${sq(m('conv-no-change'))}; break; fi
    if [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; then git push -q origin "$BRANCH"; fi
    run_verify
    run_review "$pass"
    new=$(score_of "$RUN/review-$pass.md")
    if [ -n "$new" ] && ! at_least "$new" "$THRESHOLD" && at_least "$score" "$new"; then
      status="$(printf ${sq(m('conv-regressed'))} "$new" "$score")"; break
    fi
    score=$new
  done
  say "$status"
  say "$(printf ${sq(m('conv-reports'))} "$RUN")"
  for a in "$RUN"/review-*.md; do new=$(score_of "$a"); say "  $(basename "$a") — \${new:-?}/10"; done
}
` : ''}
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
trap 'rm -f "$UNTRACKED_BEFORE"' EXIT
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
  local dir=$1 base='' start=HEAD target a
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
  for a in \${AGENT_ARGS[@]+"\${AGENT_ARGS[@]}"}; do args+=("\${a//${DOSSIER}/$dir}"); done
  say "$ $AGENT_BIN \${args[*]+\${args[*]}} \${AGENT_PROMPT_FORM[*]+\${AGENT_PROMPT_FORM[*]}} …"
  AGENT_START=$(git rev-parse -q --verify HEAD 2>/dev/null || true)
  "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PROMPT_BEFORE$JIRA_PREFIX$PROMPT$PROMPT_AFTER" < /dev/null

  [ -n "$BRANCH" ] || return 0
  if [ "$COMMIT" != 1 ]; then say "$(printf ${sq(m('no-commit'))} "$BRANCH")"; return 0; fi
  commit_work || say ${sq(m('nothing'))}
  target=\${base:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)}
  target=\${target:-main}
  # No commit of its own over the target: pushing would open a merge request of someone else's commits.
  a=$target
  git rev-parse -q --verify "$a^{commit}" >/dev/null || a="origin/$target"
  if git rev-parse -q --verify "$a^{commit}" >/dev/null && [ "$(git rev-list --count "$a..HEAD")" = 0 ]; then
    say "$(printf ${sq(m('no-work'))} "$BRANCH" "$target")"; return 0
  fi
  if [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; then
    git push -u origin "$BRANCH"
  fi
  if [ "$CREATE_MR" = 1 ]; then
    create_mr "$BRANCH" "$target" "\${MR_TITLE:-$COMMIT_MESSAGE}"
  fi${conv ? `
  if [ "$CONVERGE" = 1 ]; then
    if git rev-parse -q --verify "$target^{commit}" >/dev/null; then converge_folder "$target"
    elif git rev-parse -q --verify "origin/$target^{commit}" >/dev/null; then converge_folder "origin/$target"
    else say "$(printf ${sq(m('conv-no-base'))} "$target")"; fi
  fi` : ''}
}

${vierge ? `${c('required')}
missing=''
[ -n "\${PROMPT//[[:space:]]/}" ] || missing="$missing PROMPT"
for var in COMMIT_MESSAGE MR_TITLE; do
  [ -n "\${!var}" ] || missing="$missing $var"
done
[ -z "$missing" ] || fail "$(printf ${sq(m('missing'))} "\${missing# }")"

` : ''}${c('clean')}
dirty=0
for dir in "\${FOLDERS[@]}"; do
  [ -d "$dir" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
  changes=$(dirty_files "$dir")
  [ -n "$changes" ] || continue
  dirty=1
  say "$(printf ${sq(m('dirty-folder'))} "$dir")"
  printf '%s\\n' "$changes" | sed 's/^/    /' >&2
done
[ "$dirty" = 0 ] || fail ${sq(m('dirty-stop'))}

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
for dir in "\${FOLDERS[@]}"; do
  say "──────── $dir ────────"
  # ${t('local.script.restore')}
  origin=''
  if [ -d "$dir" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    origin=$(git -C "$dir" symbolic-ref -q --short HEAD || git -C "$dir" rev-parse -q --verify HEAD || true)
  fi
  set +e
  ( set -e; process_folder "$dir" )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then failed=$((failed + 1)); say "$(printf ${sq(m('folder-failed'))} "$dir")"; fi
  now=$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null || git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null || true)
  if [ -n "$origin" ] && [ "$now" != "$origin" ]; then
    if [ "$COMMIT" != 1 ] || [ "$RESTORE_BRANCH" != 1 ]; then say "$(printf ${sq(m('stays'))} "$now")"
    elif git -C "$dir" checkout -q "$origin"; then say "$(printf ${sq(m('restored'))} "$origin")"
    else say "$(printf ${sq(m('restore-failed'))} "$origin" "$dir")"; fi
  fi
done
say "$(printf ${sq(m('done'))} "$(( \${#FOLDERS[@]} - failed ))" "\${#FOLDERS[@]}")"
[ "$failed" -eq 0 ]
`;
  return { script, fichier: `${nom}${converge ? '-converge' : ''}${vierge ? '-vierge' : ''}.sh` };
}

module.exports = { scriptDe, nettoyerArgs };
