#!/bin/sh
# De la source au registre npm, en un seul passage — pour que `npx mergerie demo` marche.
#
#   sh scripts/publish-npm.sh             contrôles, archive, puis ESSAI RÉEL : `npx mergerie demo`
#                                         depuis un dossier vide, avec un HOME jetable
#   sh scripts/publish-npm.sh --publish   la même chose, puis `npm publish` — depuis main, arbre
#                                         propre, après `npm login` (le code OTP est demandé)
#
# L'essai est ce qui compte : il prouve que le binaire natif de better-sqlite3 se télécharge, que
# la démo se sème dans ~/.mergerie/demo (pas dans le cache de npx), et que le serveur répond avec
# la bannière de démo. Un `npm pack` qui passe ne prouve rien de tout cela.
set -eu
cd "$(dirname "$0")/.."
PUBLISH=0
for a in "$@"; do [ "$a" = "--publish" ] && PUBLISH=1; done
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

say "1/6  $NAME $VERSION — état des lieux"
BRANCH=$(git branch --show-current)
echo "branche : $BRANCH, node $(node --version), npm $(npm --version)"
if [ "$PUBLISH" = 1 ]; then
  [ "$BRANCH" = main ] || fail "on publie depuis main (ici : $BRANCH) — la version taguée, jamais develop"
  [ -z "$(git status --porcelain)" ] || fail "arbre de travail sale : commiter ou remiser avant de publier"
  git describe --tags --exact-match >/dev/null 2>&1 || fail "HEAD n'est pas tagué : la release (vX.Y.Z) vient avant la publication"
  npm whoami >/dev/null 2>&1 || fail "pas connecté au registre : npm login d'abord (compte npmjs.com avec 2FA)"
fi

say "2/6  Contrôles du projet"
npm run check

say "3/6  Ce que l'archive contiendra"
npm pack --dry-run --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const [p] = JSON.parse(s); const files = p.files.map((f) => f.path);
    const requis = ["bin/mergerie.js", "src/server.js", "src/db/index.js", "public/index.html", "public/app.js", "public/i18n/index.js", "public/vendor/mermaid.min.js", "scripts/demo-seed.js", "README.md", "LICENSE"];
    const interdits = [/^data(-demo)?\//, /^test\//, /^docs\//, /^\.env/, /^PLAN\.md$/, /^social_network\//, /\.mp4$/, /\.gif$/];
    const manquants = requis.filter((f) => !files.includes(f));
    const fuites = files.filter((f) => interdits.some((re) => re.test(f)));
    console.log(`${files.length} fichiers, ${(p.size / 1e6).toFixed(1)} Mo archivés, ${(p.unpackedSize / 1e6).toFixed(1)} Mo décompressés`);
    if (manquants.length) { console.error("manquants : " + manquants.join(", ")); process.exit(1); }
    if (fuites.length) { console.error("ne doivent pas partir : " + fuites.join(", ")); process.exit(1); }
    if (p.unpackedSize > 15e6) { console.error("archive trop lourde (> 15 Mo) : vérifier `files` dans package.json"); process.exit(1); }
  });' || fail "le contenu de l'archive n'est pas celui attendu (liste \`files\` de package.json)"

say "4/6  Archive"
TMP=$(mktemp -d)
TGZ="$TMP/$(npm pack --pack-destination "$TMP" 2>/dev/null | tail -1)"
echo "$TGZ"

say "5/6  Essai réel depuis un dossier vide : npx mergerie demo"
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME" "$TMP/vide"
# HOME jetable : npm y met son cache (donc TOUT est téléchargé comme chez un inconnu) et Node y
# résout ~/.mergerie — on vérifie ensuite que la démo est bien allée là, et nulle part ailleurs.
( cd "$TMP/vide" && HOME="$FAKE_HOME" PORT="$PORT" npm exec --yes --package="$TGZ" -- mergerie demo > "$TMP/demo.log" 2>&1 ) &
RUNNER=$!
i=0
until curl -sf "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ $i -gt 240 ] || ! kill -0 "$RUNNER" 2>/dev/null; then cat "$TMP/demo.log"; fail "le serveur de démo n'a pas répondu sur :$PORT"; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/" | grep -q demoBanner || { cat "$TMP/demo.log"; fail "pas de bannière de démo : MERGERIE_DEMO n'est pas passé"; }
[ -f "$FAKE_HOME/.mergerie/demo/reviewer.db" ] || fail "la base de démo n'est pas dans ~/.mergerie/demo"
[ -z "$(find "$FAKE_HOME/.npm" -name reviewer.db 2>/dev/null)" ] || fail "une base a été écrite dans le cache de npx"
MRS=$(curl -sf "http://127.0.0.1:$PORT/api/mrs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')
echo "démo levée en ${i}s sur :$PORT — $MRS merge requests fictives, base dans ~/.mergerie/demo, rien dans le cache"
# Le serveur est l'enfant de la commande ; on tue par le port, ce qui marche quel que soit le
# nombre d'intermédiaires que npm exec a mis entre nous et lui.
(lsof -ti "tcp:$PORT" 2>/dev/null || true) | xargs kill 2>/dev/null || true
kill "$RUNNER" 2>/dev/null || true
wait "$RUNNER" 2>/dev/null || true

say "6/6  Publication"
if [ "$PUBLISH" = 1 ]; then
  npm publish "$TGZ"
  # LE REGISTRE ÉCRIT PLUS VITE QU'IL NE RELIT. Interrogé dans la foulée du `publish`, `npm view`
  # répond 404 — le paquet est bien parti, la lecture n'a pas encore propagé. La ligne annonçait
  # alors « publié :  » (version vide) précédée d'une erreur 404 en travers d'une publication
  # RÉUSSIE : de quoi la croire ratée et la refaire. On laisse au registre le temps de se relire,
  # et on ne redescend jamais en échec — ce qui est publié est publié.
  PUBLIEE=""
  i=0
  while [ $i -lt 12 ]; do
    PUBLIEE=$(npm view "$NAME" version --prefer-online 2>/dev/null || true)
    [ "$PUBLIEE" = "$VERSION" ] && break
    i=$((i + 1)); sleep 3
  done
  if [ "$PUBLIEE" = "$VERSION" ]; then
    echo "publié : $VERSION — https://www.npmjs.com/package/$NAME"
  else
    echo "publié : $VERSION — https://www.npmjs.com/package/$NAME"
    echo "le registre ne le relit pas encore${PUBLIEE:+ (il annonce $PUBLIEE)} — à revérifier dans une minute : npm view $NAME version"
  fi
  cat <<EOF

Reste à faire, à la main :
  - dans ../mergerie_site/deploy/deploy.sh, retirer les lignes SITE_TRY_COMMAND et SITE_RUN_COMMAND
    (le site affichera alors « npx mergerie demo » et « npx mergerie »), puis npm run deploy
  - vérifier depuis une autre machine : npx mergerie@latest demo
EOF
else
  cat <<EOF

Essai réussi, rien n'a été publié. Pour publier :
  git checkout main            # la version taguée
  npm login                    # une fois par machine
  sh scripts/publish-npm.sh --publish
EOF
fi
rm -rf "$TMP"
