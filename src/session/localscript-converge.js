'use strict';
/* LA BOUCLE DE CONVERGENCE DU SCRIPT EXPORTÉ (`{ converge: true }`), en bash : relecture en lecture
   seule du diff complet `base...HEAD`, note relue dans la même ligne stricte que l'outil
   (review/note.js), corrections tant qu'elle est sous le seuil — voir l'en-tête de localscript.js.
   Gabarit JavaScript ordinaire : `\${…}` y écrit un `${…}` de bash. */

const DOSSIER = '@FOLDER@';   // le dossier de travail dans les options d'agent, posé par le script
const TEMPORAIRE = '@TMPDIR@'; // le dossier temporaire de la machine qui LANCE le script, pas de celle qui l'exporte

function convergeBash({ m, t, sq }) {
  return `# ── ${t('local.script.converge-code')}
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
  local n=$1 a prompt t0=$SECONDS args=()
  res step review
  git diff "$REF...HEAD" > "$WORK/diff.patch"
  for a in \${REVIEW_ARGS[@]+"\${REVIEW_ARGS[@]}"}; do a=\${a//${DOSSIER}/$PWD}; args+=("\${a//${TEMPORAIRE}/$AGENT_TMP}"); done
  prompt=$(fill "$REVIEW_PROMPT"$'\\n\\n'"$REVIEW_RULES")
  if [ "$n" -gt 0 ] && [ -f "$RUN/review-$((n - 1)).md" ]; then
    prompt="$prompt"$'\\n\\n'"$PREVIOUS_INTRO"$'\\n'"$(data_block ${sq(t('local.script.data.previous'))} "$(cat "$RUN/review-$((n - 1)).md")")"
  fi
  if [ -n "$JIRA_CONTEXT" ]; then
    prompt="$prompt"$'\\n\\n'"$(printf ${sq(t('local.script.ticket-intro'))} "$JIRA_TICKET")"$'\\n'"$(data_block "$(printf ${sq(t('local.script.data.ticket'))} "$JIRA_TICKET")" "$JIRA_CONTEXT")"
  fi
  step "$(printf ${sq(m('conv-review'))} "$n")"
  "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PREAMBLE"$'\\n\\n'"$prompt" < /dev/null > "$RUN/review-$n.md"
  say "$(printf ${sq(m('conv-report'))} "$RUN/review-$n.md") ($(fmt_dur $((SECONDS - t0))))"
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
  res reports "$RUN"
  DIFF_REL="$WORK/diff.patch"
  say "$(printf ${sq(m('conv-start'))} "$THRESHOLD" "$MAX_PASSES" "$REF")"
  run_review 0
  score=$(score_of "$RUN/review-0.md")
  res score "$score"
  while :; do
    if [ -z "$score" ]; then status=${sq(m('conv-no-score'))}; break; fi
    say "$(printf ${sq(m('conv-score'))} "$score")"
    if at_least "$score" "$THRESHOLD"; then status="$(printf ${sq(m('conv-converged'))} "$score" "$pass")"; break; fi
    if [ "$pass" -ge "$MAX_PASSES" ]; then status="$(printf ${sq(m('conv-capped'))} "$MAX_PASSES" "$score")"; break; fi
    pass=$((pass + 1))
    step "$(printf ${sq(m('conv-fix'))} "$pass" "$MAX_PASSES")"
    res step fix
    CUR_REPORT=$(cat "$RUN/review-$((pass - 1)).md")
    args=()
    for a in \${AGENT_ARGS[@]+"\${AGENT_ARGS[@]}"}; do a=\${a//${DOSSIER}/$PWD}; args+=("\${a//${TEMPORAIRE}/$AGENT_TMP}"); done
    AGENT_START=$(git rev-parse HEAD)
    "$AGENT_BIN" \${args[@]+"\${args[@]}"} \${AGENT_PROMPT_FORM[@]+"\${AGENT_PROMPT_FORM[@]}"} "$PREAMBLE"$'\\n\\n'"$(fill "$FIX_PROMPT")" < /dev/null
    if ! commit_work; then status=${sq(m('conv-no-change'))}; break; fi
    if [ "$PUSH" = 1 ] || [ "$CREATE_MR" = 1 ]; then git push -q origin "$BRANCH"; fi
    run_verify
    run_review "$pass"
    new=$(score_of "$RUN/review-$pass.md")
    res score "$new"
    if [ -n "$new" ] && ! at_least "$new" "$THRESHOLD" && at_least "$score" "$new"; then
      status="$(printf ${sq(m('conv-regressed'))} "$new" "$score")"; break
    fi
    score=$new
  done
  say "$status"
  say "$(printf ${sq(m('conv-reports'))} "$RUN")"
  for a in "$RUN"/review-*.md; do new=$(score_of "$a"); say "  $(basename "$a") — \${new:-?}/10"; done
}
`;
}

module.exports = { convergeBash, DOSSIER, TEMPORAIRE };
