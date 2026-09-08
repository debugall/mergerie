#!/bin/sh
# Installe ce qu'il faut pour la dictée vocale de Mergerie (voir whisper.md) : le moteur
# whisper.cpp (`whisper-server` + `whisper-cli`), un modèle Whisper et le modèle de détection de
# voix Silero, dans le dossier de données de Mergerie. macOS et Linux ; Windows a son propre
# script (`scripts/install-whisper.ps1`).
#
# Tout est gratuit et local : whisper.cpp et les modèles sont sous licence MIT, et rien ici
# n'appelle un service payant. Les téléchargements viennent de GitHub et de Hugging Face.
#
#   sh scripts/install-whisper.sh                      # large-v3-turbo, dans data/models
#   sh scripts/install-whisper.sh --model large-v3     # précision maximale, 3,1 Go
#   sh scripts/install-whisper.sh --model large-v3-turbo-q5_0   # machine sans GPU, 574 Mo
#   sh scripts/install-whisper.sh --build --cuda       # Linux + carte NVIDIA : compile avec CUDA
#
# Le binaire : sur macOS, Homebrew (`brew install whisper-cpp`, Metal activé d'office). Sur Linux
# x64/arm64, l'archive précompilée de la dernière release (CPU seulement). Avec `--build`, `--cuda`
# ou `--vulkan`, compilation depuis les sources (git + cmake + un compilateur C++), en binaires
# statiques. Dans les deux cas le résultat vit dans <données>/whisper/bin.
#
# Relançable sans risque : ce qui est déjà en place est gardé (un téléchargement interrompu
# reprend où il s'est arrêté).
#
# Lancé par Mergerie (bouton « Installer » des réglages, whisper.md §6.5) : MERGERIE_JOB=1, ou
# simplement pas de terminal en sortie. Alors pas de barre de progression (une ligne toutes les
# 5 s), et une dernière ligne `MERGERIE_RESULT {…}` que le serveur lit pour remplir les réglages.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="${MERGERIE_DATA_DIR:-$ROOT/data}"
MODEL="large-v3-turbo"
WITH_VAD=1
FORCE_BUILD=0
CUDA=0
VULKAN=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options :"
  echo "  --model NOM     large-v3-turbo (défaut) | large-v3-turbo-q8_0 | large-v3-turbo-q5_0 | large-v3 | large-v3-q5_0 | …"
  echo "  --dir DOSSIER   dossier de données (défaut : \$MERGERIE_DATA_DIR ou $ROOT/data)"
  echo "  --no-vad        ne pas télécharger le modèle Silero (détection de voix côté moteur)"
  echo "  --build         compiler depuis les sources (au lieu de Homebrew sur macOS, de l'archive précompilée sur Linux)"
  echo "  --cuda          compiler avec CUDA (Linux, carte NVIDIA, nvcc installé)"
  echo "  --vulkan        compiler avec Vulkan (toute carte, SDK Vulkan installé)"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --dir) DATA_DIR="$2"; shift 2 ;;
    --no-vad) WITH_VAD=0; shift ;;
    --build) FORCE_BUILD=1; shift ;;
    --cuda) CUDA=1; FORCE_BUILD=1; shift ;;
    --vulkan) VULKAN=1; FORCE_BUILD=1; shift ;;
    -h|--help) usage ;;
    *) echo "option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
done

MODELS_DIR="$DATA_DIR/models"
WHISPER_HOME="$DATA_DIR/whisper"
MODEL_FILE="$MODELS_DIR/ggml-$MODEL.bin"
VAD_FILE="$MODELS_DIR/ggml-silero-v5.1.2.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
REPO="ggml-org/whisper.cpp"

# Sans terminal (job Mergerie, redirection) : pas de gras ANSI, pas de barre de progression (une
# ligne toutes les 5 secondes à la place), et une ligne MERGERIE_RESULT à la fin.
JOB=0; if [ "${MERGERIE_JOB:-}" = 1 ] || [ ! -t 1 ]; then JOB=1; fi
say()  { if [ "$JOB" = 1 ]; then printf '\n== %s\n' "$*"; else printf '\n\033[1m%s\033[0m\n' "$*"; fi; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
die()  { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$MODEL" in
  large-v3-turbo|large-v3-turbo-q8_0|large-v3-turbo-q5_0|large-v3|large-v3-q5_0|medium|small|base) ;;
  *) warn "modèle « $MODEL » hors de la liste connue : on tente quand même ggml-$MODEL.bin" ;;
esac

filesize() { wc -c < "$1" | tr -d ' '; }

# ---------- téléchargement avec reprise ----------
fetch() { # fetch URL DEST
  if have curl; then
    if [ "$JOB" = 1 ]; then
      total=$(curl -sIL "$1" | tr -d '\r' | awk 'tolower($1)=="content-length:"{s=$2} END{print s+0}')
      curl -sSL --fail --retry 3 --retry-delay 2 -C - -o "$2" "$1" & cp=$!
      while kill -0 "$cp" 2>/dev/null; do
        sleep 5
        kill -0 "$cp" 2>/dev/null || break
        [ -f "$2" ] || continue
        if [ "${total:-0}" -gt 0 ]; then echo "  … $(( $(filesize "$2") / 1048576 )) / $(( total / 1048576 )) Mo"
        else echo "  … $(( $(filesize "$2") / 1048576 )) Mo"; fi
      done
      wait "$cp" || curl -sSL --fail --retry 3 -o "$2" "$1"   # le serveur refuse la reprise : on repart
    else
      curl -L --fail --retry 3 --retry-delay 2 -C - --progress-bar -o "$2" "$1" \
        || curl -L --fail --retry 3 --progress-bar -o "$2" "$1"
    fi
  elif have wget; then
    if [ "$JOB" = 1 ]; then wget -c -q -O "$2" "$1"; else wget -c -q --show-progress -O "$2" "$1"; fi
  else
    die "ni curl ni wget : impossible de télécharger"
  fi
}

# Un fichier ggml commence par la signature « lmgg » ; une page d'erreur HTML commence par « < ».
is_ggml() { [ "$(head -c 4 "$1" 2>/dev/null)" = "lmgg" ]; }

# ---------- 1. le moteur ----------
say "1/3  Moteur whisper.cpp"
OS=$(uname -s)
SERVER_BIN=""
CLI_BIN=""

if [ "$FORCE_BUILD" = 0 ] && [ "$OS" = Darwin ] && have brew; then
  if brew list --formula whisper-cpp >/dev/null 2>&1; then
    ok "whisper-cpp déjà installé par Homebrew ($(brew list --versions whisper-cpp))"
  else
    echo "  brew install whisper-cpp …"
    brew install whisper-cpp
  fi
  SERVER_BIN=$(command -v whisper-server || true)
  CLI_BIN=$(command -v whisper-cli || true)
  [ -n "$SERVER_BIN" ] || die "whisper-server introuvable dans le PATH après l'installation Homebrew"
elif [ "$FORCE_BUILD" = 0 ] && have whisper-server; then
  SERVER_BIN=$(command -v whisper-server)
  CLI_BIN=$(command -v whisper-cli || true)
  ok "whisper-server déjà présent : $SERVER_BIN"
elif [ "$FORCE_BUILD" = 0 ] && [ -x "$WHISPER_HOME/bin/whisper-server" ]; then
  SERVER_BIN="$WHISPER_HOME/bin/whisper-server"
  CLI_BIN="$WHISPER_HOME/bin/whisper-cli"
  ok "whisper-server déjà installé : $SERVER_BIN (relancer avec --build pour le refaire)"
elif [ "$FORCE_BUILD" = 0 ] && [ "$OS" = Linux ] && { [ "$(uname -m)" = x86_64 ] || [ "$(uname -m)" = aarch64 ]; }; then
  # Archive précompilée de la release (whisper-bin-ubuntu-<arch>.tar.gz) : binaires liés
  # dynamiquement à leurs .so voisins. On les range dans lib/ et on pose dans bin/ deux
  # lanceurs qui fixent LD_LIBRARY_PATH — Mergerie n'a alors rien à savoir de tout cela.
  have curl || die "curl manque (nécessaire pour télécharger l'archive ; ou bien --build)"
  have tar  || die "tar manque"
  ARCH=x64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$TAG" ] || die "dernière release introuvable via l'API GitHub (ou bien --build)"
  ASSET="whisper-bin-ubuntu-$ARCH.tar.gz"
  mkdir -p "$WHISPER_HOME"
  echo "  téléchargement de $ASSET ($TAG) …"
  fetch "https://github.com/$REPO/releases/download/$TAG/$ASSET" "$WHISPER_HOME/$ASSET"
  rm -rf "$WHISPER_HOME/lib" "$WHISPER_HOME/_extract"; mkdir -p "$WHISPER_HOME/_extract"
  tar xzf "$WHISPER_HOME/$ASSET" -C "$WHISPER_HOME/_extract"
  REAL=$(find "$WHISPER_HOME/_extract" -type f -name whisper-server | head -n 1)
  [ -n "$REAL" ] || die "whisper-server absent de $ASSET"
  mv "$(dirname "$REAL")" "$WHISPER_HOME/lib"
  rm -rf "$WHISPER_HOME/_extract" "$WHISPER_HOME/$ASSET"
  mkdir -p "$WHISPER_HOME/bin"
  for b in whisper-server whisper-cli; do
    [ -f "$WHISPER_HOME/lib/$b" ] || continue
    chmod +x "$WHISPER_HOME/lib/$b"
    printf '#!/bin/sh\nd=$(cd "$(dirname "$0")/.." && pwd)\nLD_LIBRARY_PATH="$d/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$d/lib/%s" "$@"\n' "$b" > "$WHISPER_HOME/bin/$b"
    chmod +x "$WHISPER_HOME/bin/$b"
  done
  SERVER_BIN="$WHISPER_HOME/bin/whisper-server"
  CLI_BIN="$WHISPER_HOME/bin/whisper-cli"
  ok "archive précompilée installée ($TAG, CPU) : $SERVER_BIN — pour un GPU, relancer avec --cuda ou --vulkan"
else
  have git   || die "git manque (nécessaire pour compiler)"
  have cmake || die "cmake manque : brew install cmake / apt install cmake / dnf install cmake"
  have c++ || have g++ || have clang++ || die "aucun compilateur C++ (Xcode CLT, build-essential, gcc-c++…)"
  if [ "$CUDA" = 1 ] && ! have nvcc; then die "--cuda demandé mais nvcc introuvable (CUDA Toolkit)"; fi

  TAG=""
  if have curl; then
    TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
          | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  fi
  [ -n "$TAG" ] || { warn "dernière release introuvable (API GitHub), on prend la branche par défaut"; }

  SRC="$WHISPER_HOME/src"
  mkdir -p "$WHISPER_HOME"
  if [ -d "$SRC/.git" ]; then
    echo "  mise à jour des sources dans $SRC …"
    git -C "$SRC" fetch --depth 1 origin ${TAG:+tag "$TAG"} >/dev/null 2>&1 || git -C "$SRC" fetch --depth 1 origin
    [ -n "$TAG" ] && git -C "$SRC" checkout -q "$TAG" || true
  else
    echo "  clone de $REPO ${TAG:+($TAG)} …"
    git clone --depth 1 ${TAG:+--branch "$TAG"} "https://github.com/$REPO.git" "$SRC"
  fi

  FLAGS="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF"
  [ "$CUDA" = 1 ]   && FLAGS="$FLAGS -DGGML_CUDA=ON"
  [ "$VULKAN" = 1 ] && FLAGS="$FLAGS -DGGML_VULKAN=ON"
  # macOS : Metal est activé par défaut par le CMake de whisper.cpp ; rien à ajouter.
  echo "  compilation ($FLAGS) …"
  JOBS=$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) )
  # shellcheck disable=SC2086
  cmake -S "$SRC" -B "$SRC/build" $FLAGS >/dev/null
  cmake --build "$SRC/build" --config Release -j "$JOBS" --target whisper-server whisper-cli

  mkdir -p "$WHISPER_HOME/bin"
  for b in whisper-server whisper-cli; do
    f=$(find "$SRC/build" -type f -name "$b" -perm -u+x | head -n 1)
    [ -n "$f" ] || die "$b non produit par la compilation"
    cp "$f" "$WHISPER_HOME/bin/$b"
  done
  SERVER_BIN="$WHISPER_HOME/bin/whisper-server"
  CLI_BIN="$WHISPER_HOME/bin/whisper-cli"
  ok "compilé : $SERVER_BIN"
fi

"$SERVER_BIN" --help 2>&1 | grep -qi usage || die "$SERVER_BIN ne démarre pas"
ok "whisper-server répond"

# ---------- 2. les modèles ----------
say "2/3  Modèles (dans $MODELS_DIR)"
mkdir -p "$MODELS_DIR"

if [ -f "$MODEL_FILE" ] && is_ggml "$MODEL_FILE" && [ "$(filesize "$MODEL_FILE")" -gt 10000000 ]; then
  ok "ggml-$MODEL.bin déjà là ($(( $(filesize "$MODEL_FILE") / 1048576 )) Mo)"
else
  echo "  téléchargement de ggml-$MODEL.bin (large-v3-turbo ≈ 1,6 Go ; large-v3 ≈ 3,1 Go) …"
  fetch "$MODEL_URL" "$MODEL_FILE"
  is_ggml "$MODEL_FILE" || { rm -f "$MODEL_FILE"; die "le fichier reçu n'est pas un modèle ggml (nom de modèle inconnu sur Hugging Face ?)"; }
  ok "ggml-$MODEL.bin ($(( $(filesize "$MODEL_FILE") / 1048576 )) Mo)"
fi

if [ "$WITH_VAD" = 1 ]; then
  if [ -f "$VAD_FILE" ] && [ "$(filesize "$VAD_FILE")" -gt 200000 ] && [ "$(head -c 1 "$VAD_FILE")" != "<" ]; then
    ok "ggml-silero-v5.1.2.bin déjà là"
  else
    echo "  téléchargement du modèle de détection de voix Silero …"
    fetch "$VAD_URL" "$VAD_FILE"
    [ "$(head -c 1 "$VAD_FILE")" != "<" ] || { rm -f "$VAD_FILE"; die "le fichier VAD reçu est une page HTML, pas un modèle"; }
    ok "ggml-silero-v5.1.2.bin"
  fi
fi

# ---------- 3. le modèle se charge-t-il vraiment ? ----------
say "3/3  Vérification"
BACKEND="CPU"
if [ -n "$CLI_BIN" ] && [ -x "$CLI_BIN" ]; then
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t whisper)
  WAV="$TMP/silence.wav"
  # 1 s de silence, 16 kHz mono 16 bits : en-tête WAV de 44 octets puis 32 000 octets à zéro.
  printf 'RIFF\044\175\000\000WAVEfmt \020\000\000\000\001\000\001\000\200\076\000\000\000\175\000\000\002\000\020\000data\000\175\000\000' > "$WAV"
  dd if=/dev/zero bs=32000 count=1 >> "$WAV" 2>/dev/null
  LOG="$TMP/run.log"
  if "$CLI_BIN" -m "$MODEL_FILE" -f "$WAV" -l fr -nt >"$LOG" 2>&1; then
    grep -qi 'metal'  "$LOG" && BACKEND="Metal (GPU Apple)"
    grep -qi 'cuda'   "$LOG" && BACKEND="CUDA (GPU NVIDIA)"
    grep -qi 'vulkan' "$LOG" && BACKEND="Vulkan (GPU)"
    ok "le modèle se charge ; accélération : $BACKEND"
    T=$(sed -n 's/.*total time *= *\([0-9.]* ms\).*/\1/p' "$LOG" | tail -n 1)
    [ -n "$T" ] && ok "1 s de silence traitée en $T (chargement du modèle compris)"
  else
    warn "whisper-cli n'a pas réussi à charger le modèle — journal : $LOG"
    tail -n 15 "$LOG" >&2
  fi
  rm -f "$WAV"
else
  warn "whisper-cli absent : vérification du chargement sautée"
fi

# ---------- récapitulatif ----------
say "Installé"
echo "  moteur   : $SERVER_BIN"
echo "  modèle   : $MODEL_FILE"
[ "$WITH_VAD" = 1 ] && echo "  VAD      : $VAD_FILE"
echo
echo "  Réglages Mergerie › IA › Dictée vocale (cf. whisper.md §6.3) :"
echo "    dictation_provider  = local"
echo "    dictation_model     = $MODEL_FILE"
[ "$WITH_VAD" = 1 ] && echo "    dictation_vad_model = $VAD_FILE"
case ":$PATH:" in
  *":$(dirname "$SERVER_BIN"):"*) echo "    dictation_command   = (vide : whisper-server est dans le PATH)" ;;
  *) echo "    dictation_command   = $SERVER_BIN" ;;
esac
echo
echo "  Pour l'essayer à la main dès maintenant :"
VAD_ARGS=""; [ "$WITH_VAD" = 1 ] && VAD_ARGS=" --vad --vad-model \"$VAD_FILE\""
echo "    $SERVER_BIN -m \"$MODEL_FILE\" --host 127.0.0.1 --port 8178 -l fr$VAD_ARGS"
echo "    curl -s 127.0.0.1:8178/inference -F file=@mon-audio.wav -F response_format=text"

# Dernière ligne, pour Mergerie : ce qu'il faut écrire dans les réglages. Les chemins sont
# échappés pour du JSON (antislash et guillemet ; le reste ne s'y trouve pas dans un chemin).
if [ "$JOB" = 1 ]; then
  j() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  IN_PATH=false; case ":$PATH:" in *":$(dirname "$SERVER_BIN"):"*) IN_PATH=true ;; esac
  VAD_JSON=null; [ "$WITH_VAD" = 1 ] && VAD_JSON="\"$(j "$VAD_FILE")\""
  printf 'MERGERIE_RESULT {"server":"%s","model":"%s","vad":%s,"backend":"%s","in_path":%s}\n' \
    "$(j "$SERVER_BIN")" "$(j "$MODEL_FILE")" "$VAD_JSON" "$(j "$BACKEND")" "$IN_PATH"
fi
