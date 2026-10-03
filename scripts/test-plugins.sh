#!/usr/bin/env bash
# Lance les tests des plugins tiers voisins (unitaires, puis e2e contre CE Mergerie), avec un récapitulatif.
# Usage : scripts/test-plugins.sh [--unit] [plugin ...]     (par défaut : docker-mergerie jenkins-mergerie link-mergerie)
#   --unit : seulement les tests sans Mergerie (pas de navigateur).
# Les dépôts sont cherchés à côté de celui-ci (../<nom>) ou dans PLUGINS_DIR. Prérequis des e2e : `npm ci` et le Chromium de Playwright ici.
set -uo pipefail
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PLUGINS_DIR:-$RACINE/..}"

UNIT_SEUL=0
if [ "${1:-}" = "--unit" ]; then UNIT_SEUL=1; shift; fi
PLUGINS=("$@"); [ ${#PLUGINS[@]} -eq 0 ] && PLUGINS=(docker-mergerie jenkins-mergerie link-mergerie)

if [ "$UNIT_SEUL" = 0 ] && ! node -e "process.exit(require('fs').existsSync(require('playwright').chromium.executablePath())?0:1)" 2>/dev/null; then
  echo "✗ Chromium de Playwright absent : « npm ci && npx playwright install chromium » ici, ou --unit." >&2; exit 2
fi

RESUME=(); ECHECS=0
lancer() { # nom étiquette commande...
  local nom=$1 etiq=$2; shift 2
  if "$@"; then RESUME+=("✓ $nom — $etiq"); else RESUME+=("✗ $nom — $etiq"); ECHECS=$((ECHECS + 1)); fi
}

for nom in "${PLUGINS[@]}"; do
  dir="$BASE/$nom"
  if [ ! -f "$dir/plugin.json" ]; then RESUME+=("- $nom — introuvable ($dir), ignoré"); continue; fi
  echo; echo "━━ $nom"
  ( cd "$dir" && { [ -d node_modules/@mergerie/plugin-sdk ] || npm install --no-audit --no-fund >/dev/null; } ) \
    || { RESUME+=("✗ $nom — npm install"); ECHECS=$((ECHECS + 1)); continue; }
  lancer "$nom" "unitaires" bash -c "cd '$dir' && npm test"
  [ "$UNIT_SEUL" = 0 ] && lancer "$nom" "e2e" bash -c "cd '$dir' && MERGERIE_DIR='$RACINE' npm run test:e2e"
done

echo; echo "━━ Récapitulatif"; printf '%s\n' "${RESUME[@]}"
[ "$ECHECS" -eq 0 ]
