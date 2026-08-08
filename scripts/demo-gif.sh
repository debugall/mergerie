#!/bin/sh
# Le GIF du README, à partir de l'enregistrement produit par `npm run record:demo`.
#
# Pourquoi un script et non une ligne de commande à retrouver : ces réglages ont été calés
# pour tenir sous ~4,5 Mo — un GIF que GitHub recharge à chaque visite de la page d'accueil
# — sans rendre l'interface illisible. Les redécouvrir à chaque régénération coûte une
# demi-heure et donne un fichier deux fois trop lourd.
#
# Deux passes, et l'ordre compte : une palette calculée SUR la vidéo (`stats_mode=diff`
# privilégie ce qui bouge d'une image à l'autre), puis l'encodage avec cette palette. Sans
# elle, un GIF 256 couleurs sur une interface à dégradés vire au marron par bandes.
#
#   npm run demo:gif                     # depuis demo-recordings/mergerie-demo-fr.webm
#   sh scripts/demo-gif.sh <src> <dst>   # à la main
set -eu

SRC="${1:-demo-recordings/mergerie-demo-fr.webm}"
DST="${2:-docs/demo.gif}"
# 6 im/s : en dessous, le faux curseur saccade et la démo paraît cassée plutôt que rapide.
FPS="${FPS:-6}"
# 640 px : la largeur d'affichage du README. Au-delà, on paie des pixels que personne ne voit.
LARGE="${LARGE:-640}"
# 64 couleurs plutôt que 256. C'est le réglage qui rapporte le plus sans toucher à la
# lisibilité : l'interface est en aplats, et sur une capture de l'onglet Notes le texte reste
# aussi lisible qu'à 128. Mesuré sur la visite guidée de 163 s : 256 → hors sujet,
# 128 → 5235 Ko, 96 → 4659 Ko, 64 → 3455 Ko. La marge compte, la vidéo s'allonge à chaque
# fonctionnalité ajoutée et le budget, lui, ne bouge pas.
COULEURS="${COULEURS:-64}"

[ -f "$SRC" ] || { echo "Enregistrement absent : $SRC (lance d'abord « npm run record:demo »)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg est nécessaire (brew install ffmpeg)" >&2; exit 1; }

PAL="$(dirname "$DST")/.palette-$$.png"
trap 'rm -f "$PAL"' EXIT

ffmpeg -v error -y -i "$SRC" \
  -vf "fps=$FPS,scale=$LARGE:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=$COULEURS" "$PAL"

# `diff_mode=rectangle` : seule la zone qui change est réécrite d'une image à l'autre.
ffmpeg -v error -y -i "$SRC" -i "$PAL" \
  -lavfi "fps=$FPS,scale=$LARGE:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$DST"

OCTETS=$(wc -c < "$DST" | tr -d " ")
echo "✓ $DST — $((OCTETS / 1024)) Ko, $(ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$DST")"
