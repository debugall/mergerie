#!/bin/sh
# Faux script d'installation, pour les tests de bout en bout (whisper.md §6.5).
#
# Il imite ce que fait le vrai : quelques lignes de journal, un temps d'attente INTERRUPTIBLE
# (pour éprouver le « Stop »), puis la ligne `MERGERIE_RESULT` que le serveur relit pour
# remplir les réglages. Il ne télécharge rien et n'installe rien.
#
# `--dir` est passé par le serveur ; on écrit dedans pour que le test puisse vérifier que le
# chemin transmis est bien celui du dossier de données.
set -eu

DIR=""
MODEL="large-v3-turbo"
VAD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --no-vad) VAD=0; shift ;;
    --cuda|--vulkan|--build) shift ;;
    *) shift ;;
  esac
done
[ -n "$DIR" ] || DIR="${MERGERIE_DATA_DIR:-/tmp}"

echo "== 1/3  Moteur whisper.cpp (simulé)"
echo "  ✓ whisper-server répond"
echo "== 2/3  Modèles (dans $DIR/models)"
mkdir -p "$DIR/models"
printf 'lmgg' > "$DIR/models/ggml-$MODEL.bin"
[ "$VAD" = 1 ] && printf 'lmgg' > "$DIR/models/ggml-silero-v5.1.2.bin"
echo "  ✓ ggml-$MODEL.bin"

# Une attente que SIGTERM interrompt : `sleep` suffit, il est tué comme n'importe quel enfant.
sleep "${FAKE_INSTALL_SLEEP:-1}"

echo "== 3/3  Vérification"
echo "  ✓ le modèle se charge ; accélération : Simulée"
VAD_JSON=null
[ "$VAD" = 1 ] && VAD_JSON="\"$DIR/models/ggml-silero-v5.1.2.bin\""
printf 'MERGERIE_RESULT {"server":"/faux/bin/whisper-server","model":"%s","vad":%s,"backend":"Simulée","in_path":false}\n' \
  "$DIR/models/ggml-$MODEL.bin" "$VAD_JSON"
