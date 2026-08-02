#!/usr/bin/env python3
"""Synthèse de la narration : un clip audio par étape, plus la table de leurs durées.

Deux garde-fous :
  — la narration passe TOUJOURS par `prononciation.py` avant d'atteindre la voix : c'est là
    que « MRs » cesse d'être lu « misters » et que « git » cesse d'être lu « jite » ;
  — un clip déjà présent n'est pas refait. Pour corriger une phrase, supprimer SON fichier
    (`travail/voix-fr/07.m4a`) et relancer : les 76 autres ne sont pas resynthétisés.

Usage :
    python3 synthese.py            # français
    LANGUE=en python3 synthese.py  # anglais
"""
import json
import os
import subprocess
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
LANGUE = os.environ.get('LANGUE', 'fr')
TRAVAIL = os.path.join(ICI, 'travail')
VOIX = os.path.join(TRAVAIL, f'voix-{LANGUE}')

# Modèles Piper. Voir SKILL.md pour où les poser — ils ne sont PAS dans le dépôt (60 Mo pièce).
MODELES = {
    'fr': os.path.join(TRAVAIL, 'voix', 'fr_FR-siwis-medium.onnx'),
    'en': os.path.join(TRAVAIL, 'voix', 'en_US-lessac-medium.onnx'),
}
# Débit : la voix française de Piper est légèrement pressée par défaut.
LENTEUR = {'fr': '1.06', 'en': '1.02'}
SILENCE_FIN = 0.7   # respiration après chaque phrase, sinon les étapes se télescopent

sys.path.insert(0, ICI)
from prononciation import dire  # noqa: E402


def main():
    module = 'narration_en' if LANGUE == 'en' else 'narration_fr'
    narration = __import__(module).NARRATION
    modele = MODELES[LANGUE]
    if not os.path.exists(modele):
        raise SystemExit(f'modèle de voix absent : {modele}\nvoir SKILL.md § « Voix »')
    os.makedirs(VOIX, exist_ok=True)

    durees = []
    for i, texte in enumerate(narration, 1):
        m4a = os.path.join(VOIX, f'{i:02d}.m4a')
        if not os.path.exists(m4a):
            wav = os.path.join(VOIX, f'{i:02d}.wav')
            subprocess.run(
                [sys.executable, '-m', 'piper', '-m', modele,
                 '--length-scale', LENTEUR[LANGUE], '-f', wav],
                input=dire(texte, LANGUE), text=True, check=True, capture_output=True)
            subprocess.run(
                ['ffmpeg', '-y', '-v', 'error', '-i', wav,
                 '-af', f'apad=pad_dur={SILENCE_FIN}', '-ar', '44100', '-ac', '1',
                 '-c:a', 'aac', '-b:a', '128k', m4a], check=True)
            os.remove(wav)
            print(f'  {i:02d} ← {dire(texte, LANGUE)[:64]}')
        d = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                            '-of', 'csv=p=0', m4a], capture_output=True, text=True).stdout
        durees.append(round(float(d.strip()), 3))

    with open(os.path.join(TRAVAIL, f'durees-{LANGUE}.json'), 'w') as f:
        json.dump(durees, f)
    print(f'{len(durees)} clips · {sum(durees)/60:.1f} min de narration ({LANGUE})')


if __name__ == '__main__':
    main()
