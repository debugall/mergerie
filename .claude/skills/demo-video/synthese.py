#!/usr/bin/env python3
"""Synthèse de la narration : un clip audio par étape, plus la table de leurs durées.

Deux moteurs :
  — `edge` (défaut) : voix neuronales Microsoft via edge-tts (réseau, gratuit, sans clé). C'est
    la voix retenue depuis septembre 2026 : la voix Piper « faisait IA ». Le texte passe par
    les règles `*_NEURONAL` de `prononciation.py` — sigles et ponctuation seulement, jamais de
    respelling phonétique, la voix neuronale lit les mots anglais d'elle-même ;
  — `piper` : l'ancien moteur, local, gardé en repli (`MOTEUR=piper`).

Un clip déjà présent n'est pas refait. Pour corriger une phrase, supprimer SON fichier
(`travail/voix-fr/07.m4a`) et relancer : les autres ne sont pas resynthétisés. Changer de voix
ou de moteur = supprimer le dossier `travail/voix-<langue>/` entier.

Usage :
    python3 synthese.py            # français
    LANGUE=en python3 synthese.py  # anglais
    VOIX=fr-FR-HenriNeural python3 synthese.py   # une autre voix edge-tts (edge-tts --list-voices)
"""
import asyncio
import json
import os
import subprocess
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
LANGUE = os.environ.get('LANGUE', 'fr')
MOTEUR = os.environ.get('MOTEUR', 'edge')
TRAVAIL = os.path.join(ICI, 'travail')
VOIX = os.path.join(TRAVAIL, f'voix-{LANGUE}')
SILENCE_FIN = 0.7   # respiration après chaque phrase, sinon les étapes se télescopent

# Voix neuronales : les « Multilingual » sont la génération la plus récente et lisent les mots
# anglais glissés dans le français (merge request, commit, git) sans accent forcé.
VOIX_EDGE = {'fr': 'fr-FR-RemyMultilingualNeural', 'en': 'en-US-AndrewMultilingualNeural'}
DEBIT_EDGE = {'fr': '-4%', 'en': '-4%'}   # un poil plus lent qu'une lecture : on regarde en même temps
PY_EDGE = os.path.join(TRAVAIL, 'venv-tts', 'bin', 'python')

# Modèles Piper (repli). Voir SKILL.md pour où les poser — ils ne sont PAS dans le dépôt.
MODELES = {
    'fr': os.path.join(TRAVAIL, 'voix', 'fr_FR-siwis-medium.onnx'),
    'en': os.path.join(TRAVAIL, 'voix', 'en_US-lessac-medium.onnx'),
}
LENTEUR = {'fr': '1.06', 'en': '1.02'}

sys.path.insert(0, ICI)
from prononciation import dire  # noqa: E402


def python_piper():
    candidats = [os.environ.get('PIPER_PYTHON'), sys.executable,
                 os.path.join(TRAVAIL, 'venv-piper', 'bin', 'python'),
                 os.path.join(TRAVAIL, 'venv', 'bin', 'python'), 'python3']
    for c in candidats:
        if not c:
            continue
        try:
            subprocess.run([c, '-c', 'import piper'], check=True, capture_output=True)
            return c
        except Exception:
            continue
    raise SystemExit('piper introuvable : pip install piper-tts, ou PIPER_PYTHON=/chemin/python')


def vers_m4a(src, m4a):
    subprocess.run(
        ['ffmpeg', '-y', '-v', 'error', '-i', src,
         '-af', f'apad=pad_dur={SILENCE_FIN}', '-ar', '44100', '-ac', '1',
         '-c:a', 'aac', '-b:a', '128k', m4a], check=True)
    os.remove(src)


def synthese_piper(manquants):
    py = python_piper()
    modele = MODELES[LANGUE]
    if not os.path.exists(modele):
        raise SystemExit(f'modèle de voix absent : {modele}\nvoir SKILL.md § « Voix »')
    for i, texte in manquants:
        wav = os.path.join(VOIX, f'{i:02d}.wav')
        subprocess.run([py, '-m', 'piper', '-m', modele, '--length-scale', LENTEUR[LANGUE], '-f', wav],
                       input=dire(texte, LANGUE, 'piper'), text=True, check=True, capture_output=True)
        vers_m4a(wav, os.path.join(VOIX, f'{i:02d}.m4a'))
        print(f'  {i:02d} ← {dire(texte, LANGUE, "piper")[:64]}')


def synthese_edge(manquants):
    """edge-tts, quatre clips à la fois : chaque clip est un aller-retour réseau."""
    if not os.path.exists(PY_EDGE):
        raise SystemExit(f'{PY_EDGE} absent : python3 -m venv travail/venv-tts && travail/venv-tts/bin/pip install edge-tts')
    voix = os.environ.get('VOIX') or VOIX_EDGE[LANGUE]
    debit = os.environ.get('DEBIT') or DEBIT_EDGE[LANGUE]
    script = (
        'import asyncio, json, sys, edge_tts\n'
        'taches = json.load(sys.stdin)\n'
        'sem = asyncio.Semaphore(4)\n'
        'async def un(t):\n'
        '    async with sem:\n'
        '        for essai in range(4):\n'
        '            try:\n'
        f'                await edge_tts.Communicate(t["texte"], {voix!r}, rate={debit!r}).save(t["mp3"]); return\n'
        '            except Exception as e:\n'
        '                if essai == 3: raise\n'
        '                await asyncio.sleep(2 * (essai + 1))\n'
        'async def tout():\n'
        '    await asyncio.gather(*(un(t) for t in taches))\n'
        'asyncio.run(tout())\n'
    )
    taches = [{'texte': dire(texte, LANGUE, 'edge'), 'mp3': os.path.join(VOIX, f'{i:02d}.mp3')} for i, texte in manquants]
    subprocess.run([PY_EDGE, '-c', script], input=json.dumps(taches), text=True, check=True)
    for i, texte in manquants:
        mp3 = os.path.join(VOIX, f'{i:02d}.mp3')
        if os.path.getsize(mp3) < 1000:
            raise SystemExit(f'clip {i:02d} vide — edge-tts a rendu un fichier sans son')
        vers_m4a(mp3, os.path.join(VOIX, f'{i:02d}.m4a'))
        print(f'  {i:02d} ← {dire(texte, LANGUE, "edge")[:64]}')


def main():
    module = 'narration_en' if LANGUE == 'en' else 'narration_fr'
    narration = __import__(module).NARRATION
    os.makedirs(VOIX, exist_ok=True)
    manquants = [(i, t) for i, t in enumerate(narration, 1) if not os.path.exists(os.path.join(VOIX, f'{i:02d}.m4a'))]
    if manquants:
        (synthese_edge if MOTEUR == 'edge' else synthese_piper)(manquants)

    durees = []
    for i in range(1, len(narration) + 1):
        m4a = os.path.join(VOIX, f'{i:02d}.m4a')
        d = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                            '-of', 'csv=p=0', m4a], capture_output=True, text=True).stdout
        durees.append(round(float(d.strip()), 3))
    with open(os.path.join(TRAVAIL, f'durees-{LANGUE}.json'), 'w') as f:
        json.dump(durees, f)
    print(f'{len(durees)} clips · {sum(durees)/60:.1f} min de narration ({LANGUE}, {MOTEUR})')


if __name__ == '__main__':
    main()
