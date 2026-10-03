#!/usr/bin/env bash
# Publie @mergerie/plugin-sdk sur npm : contrôles, génération, aperçu du paquet, confirmation, publication.
# Usage : scripts/publish-sdk.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/../sdk"

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
SCOPE=${NAME%%/*}   # @mergerie

echo "→ $NAME@$VERSION"

if ! USER_NPM=$(npm whoami 2>/dev/null); then
  echo "✗ Pas connecté à npm : lancez « npm login » puis relancez." >&2; exit 1
fi
echo "✓ connecté : $USER_NPM"

# Le scope doit exister : une organisation « ${SCOPE#@} » ou le nom d'utilisateur lui-même.
if [ "$SCOPE" != "@$USER_NPM" ] && ! npm org ls "${SCOPE#@}" >/dev/null 2>&1; then
  cat >&2 <<MSG
✗ Le scope $SCOPE n'existe pas (ou vous n'y appartenez pas) — c'est l'erreur « 404 Scope not found ».
  Deux issues :
   1. créer l'organisation gratuite : https://www.npmjs.com/org/create  (nom : ${SCOPE#@}), puis relancer ;
   2. ou renommer le paquet sous votre scope : @$USER_NPM/plugin-sdk (sdk/package.json, et les dépendances des plugins).
MSG
  exit 1
fi
echo "✓ scope $SCOPE accessible"

if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "✗ $NAME@$VERSION est déjà publiée (immuable) : « npm version patch|minor » dans sdk/ d'abord." >&2; exit 1
fi

echo "→ génération (types et docs) puis contrôle de cohérence"
npm run generate >/dev/null
( cd .. && npm run --silent check:plugins )
if [ -n "$(git status --porcelain -- . ../docs/plugins)" ]; then
  echo "✗ La génération a modifié des fichiers non commités : commitez-les avant de publier." >&2
  git status --short -- . ../docs/plugins >&2; exit 1
fi

echo "→ contenu du paquet"
npm pack --dry-run

if [ "$DRY" = 1 ]; then echo "(dry-run : rien publié)"; exit 0; fi

read -r -p "Publier $NAME@$VERSION en public ? [o/N] " REP
[ "$REP" = "o" ] || [ "$REP" = "O" ] || { echo "annulé"; exit 1; }
npm publish --access public   # la 2FA demande un code ou ouvre le navigateur
echo "✓ publié : https://www.npmjs.com/package/$NAME"
