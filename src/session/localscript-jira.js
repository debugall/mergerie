'use strict';
/* LE TICKET JIRA DU SCRIPT EXPORTÉ (pour le codage, et pour la relecture avec convergence). Le script exporté ne dépend que de bash, git et curl :
   le JSON de Jira y est lu par awk, en API v2 (description et commentaires en texte, Cloud comme
   Data Center), et seul le premier commentaire qui commence par le marqueur est gardé — la même
   règle que `commentaireTech` côté outil. Tout échec rend un contexte vide : le script continue
   sans le ticket, jamais il ne s'arrête pour lui.

   String.raw : ce texte est du bash et de l'awk tels quels, barres obliques comprises. */

function jiraBash({ m, t, sq }) {
  return String.raw`# $1 = Jira JSON (API v2), $2 = marker, $3 = heading of the technical note: title, description and
# the first comment opening with the marker, as text. awk alone, byte by byte (LC_ALL=C), \uXXXX decoded to UTF-8.
jira_context() {
  LC_ALL=C awk -v marker="$2" -v techtitle="$3" '
  function hex(h,   i, v) { v = 0; h = tolower(h); for (i = 1; i <= 4; i++) v = v * 16 + index("0123456789abcdef", substr(h, i, 1)) - 1; return v }
  function utf8(v) {
    if (v < 128) return sprintf("%c", v)
    if (v < 2048) return sprintf("%c%c", 192 + int(v / 64), 128 + v % 64)
    if (v < 65536) return sprintf("%c%c%c", 224 + int(v / 4096), 128 + int(v / 64) % 64, 128 + v % 64)
    return sprintf("%c%c%c%c", 240 + int(v / 262144), 128 + int(v / 4096) % 64, 128 + int(v / 64) % 64, 128 + v % 64)
  }
  function unesc(r,   o, i, n, c, v, w) {
    o = ""; n = length(r)
    for (i = 1; i <= n; i++) {
      c = substr(r, i, 1)
      if (c != "\\") { o = o c; continue }
      c = substr(r, ++i, 1)
      if (c == "n") o = o "\n"
      else if (c == "t") o = o "\t"
      else if (c == "r" || c == "b" || c == "f") { }
      else if (c == "u") {
        v = hex(substr(r, i + 1, 4)); i += 4
        if (v >= 55296 && v < 56320 && substr(r, i + 1, 2) == "\\u") {
          w = hex(substr(r, i + 3, 4))
          if (w >= 56320 && w < 57344) { v = 65536 + (v - 55296) * 1024 + (w - 56320); i += 6 }
        }
        o = o utf8(v)
      } else o = o c
    }
    return o
  }
  # The marker opens the comment, case and spaces aside; a wiki heading "h1. tech" reads "# tech".
  # "" = not this comment; "\001" = the marker alone, nothing after it.
  function tech(b,   m, i, k, n, h) {
    m = tolower(marker); gsub(/[ \t\r\n]/, "", m)
    if (m == "") return ""
    sub(/^[ \t\r\n]+/, "", b)
    if (b ~ /^h[1-6]\.[ \t]/) { h = substr(b, 2, 1) + 0; b = substr(b, 4); sub(/^[ \t]+/, "", b); while (h-- > 0) b = "#" b }
    sub(/^\\/, "", b)
    n = length(b); i = 1
    for (k = 1; k <= length(m); k++) {
      while (i <= n && substr(b, i, 1) ~ /[ \t\r\n]/) i++
      if (i > n || tolower(substr(b, i, 1)) != substr(m, k, 1)) return ""
      i++
    }
    if (m ~ /[a-z0-9_]$/ && substr(b, i, 1) ~ /[A-Za-z0-9_]/) return ""
    b = substr(b, i)
    while (b ~ /^[ \t\r\n:-]/ || substr(b, 1, 3) == "—" || substr(b, 1, 3) == "–") b = substr(b, b ~ /^[ \t\r\n:-]/ ? 2 : 4)
    sub(/[ \t\r\n]+$/, "", b)
    return b == "" ? "\001" : b
  }
  function path(   i, p) { p = ""; for (i = 1; i <= d; i++) p = p (i > 1 ? "." : "") (type[i] == "o" ? key[i] : idx[i]); return p }
  { s = s $0 "\n" }
  END {
    n = length(s); d = 0
    for (pos = 1; pos <= n; pos++) {
      c = substr(s, pos, 1)
      if (c == "{") { type[++d] = "o"; key[d] = ""; wantkey[d] = 1 }
      else if (c == "[") { type[++d] = "a"; idx[d] = 0 }
      else if (c == "}" || c == "]") d--
      else if (c == ",") { if (type[d] == "a") idx[d]++; else wantkey[d] = 1 }
      else if (c == ":") wantkey[d] = 0
      else if (c == "\"") {
        for (j = pos + 1; j <= n; j++) { e = substr(s, j, 1); if (e == "\\") j++; else if (e == "\"") break }
        raw = substr(s, pos + 1, j - pos - 1); pos = j
        if (type[d] == "o" && wantkey[d]) { key[d] = raw; continue }
        p = path()
        if (p == "fields.summary") summary = unesc(raw)
        else if (p == "fields.description") desc = unesc(raw)
        else if (techtxt == "" && p ~ /^fields\.comment\.comments\.[0-9]+\.body$/) techtxt = tech(unesc(raw))
      }
    }
    if (techtxt == "\001") techtxt = ""
    out = ""
    if (summary != "") out = "# " summary
    if (desc != "") out = out (out == "" ? "" : "\n\n") desc
    if (techtxt != "") out = out (out == "" ? "" : "\n\n") "## " techtitle "\n\n" techtxt
    printf "%s", out
  }' "$1"
}

# The ticket, read once before any agent; whatever fails, the script goes on without it.
# The credentials reach curl on its standard input, never on its command line.
fetch_jira() {
  local f code e tok
  JIRA_CONTEXT=''
  case "$JIRA_TICKET" in
    ''|*[!A-Za-z0-9_-]*|-*|*-) say "$(printf ${sq(m('jira-bad-key'))} "$JIRA_TICKET")"; return 0 ;;
  esac
  f=$(mktemp)
  e=${'$'}{JIRA_EMAIL//\\/\\\\}; e=${'$'}{e//\"/\\\"}
  tok=${'$'}{JIRA_TOKEN:-}; tok=${'$'}{tok//\\/\\\\}; tok=${'$'}{tok//\"/\\\"}
  code=$(
    if [ -n "$JIRA_EMAIL" ]; then printf 'user = "%s:%s"\n' "$e" "$tok"; else printf 'header = "Authorization: Bearer %s"\n' "$tok"; fi |
      curl -sS --max-time 30 -K - -H 'Accept: application/json' -o "$f" -w '%{http_code}' \
        "${'$'}{JIRA_URL%/}/rest/api/2/issue/$JIRA_TICKET?fields=summary,description,comment" 2>/dev/null
  ) || code=000
  if [ "$code" = 200 ]; then
    JIRA_CONTEXT=$(jira_context "$f" "$JIRA_TECH_MARKER" "$(printf ${sq(t('local.script.ticket-tech'))} "$JIRA_TECH_MARKER")")
  fi
  rm -f "$f"
  if [ -n "$JIRA_CONTEXT" ]; then say "$(printf ${sq(m('jira-ok'))} "$JIRA_TICKET")"
  else say "$(printf ${sq(m('jira-failed'))} "$JIRA_TICKET" "$code")"; fi
}`;
}

module.exports = { jiraBash };
