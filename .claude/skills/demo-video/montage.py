#!/usr/bin/env python3
"""Montage de la démonstration réellement filmée.

L'image vient du navigateur (webm produit par Playwright), la voix est recollée aux repères
enregistrés pendant le pilotage. On ne fait PAS confiance à la somme des durées : un clic peut
prendre 200 ms de plus, et l'écart s'accumulerait sur 77 étapes. Chaque clip est donc posé à
l'instant exact où l'étape a commencé à l'écran.
"""
import json
import os
import subprocess
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
LANGUE = os.environ.get('LANGUE', 'fr')
RACINE = os.path.join(ICI, 'travail')
AUD = os.path.join(RACINE, f'voix-{LANGUE}')
TRAVAIL = os.path.join(RACINE, f'montage-{LANGUE}')
SORTIE = sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(
    os.path.join(ICI, '..', '..', '..', f'demo-live-real-{LANGUE}.mp4'))


def sh(a):
    return subprocess.run(a, check=True, capture_output=True, text=True)


def duree(f):
    return float(sh(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                     '-of', 'csv=p=0', f]).stdout.strip())


def silence(secondes, chemin):
    sh(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
        '-i', f'anullsrc=r=44100:cl=mono', '-t', f'{secondes:.3f}',
        '-c:a', 'aac', '-b:a', '128k', chemin])


def main():
    infos = json.load(open(os.path.join(RACINE, f'reperes-{LANGUE}.json')))
    video = infos['video']
    reperes = infos['reperes']
    os.makedirs(TRAVAIL, exist_ok=True)

    dv = duree(video)
    pilote = infos['fin'] / 1000.0
    # L'enregistrement commence avant t0 (chargement de la page) et s'arrête après la
    # dernière action : l'écart entre les deux donne le décalage à appliquer à la voix.
    tete = dv - pilote
    print(f'vidéo {dv:.1f}s · pilotage {pilote:.1f}s · tête {tete:.2f}s')
    if tete < 0:
        raise SystemExit('vidéo plus courte que le pilotage : montage impossible')

    morceaux = []
    curseur = 0.0
    for r in reperes:
        debut = tete + r['t'] / 1000.0
        clip = os.path.join(AUD, f"{r['i']:02d}.m4a")
        ecart = debut - curseur
        if ecart > 0.01:
            sil = os.path.join(TRAVAIL, f"sil-{r['i']:02d}.m4a")
            silence(ecart, sil)
            morceaux.append(sil)
            curseur += ecart
        morceaux.append(clip)
        curseur += duree(clip)

    if dv - curseur > 0.05:
        fin = os.path.join(TRAVAIL, 'sil-fin.m4a')
        silence(dv - curseur, fin)
        morceaux.append(fin)

    liste = os.path.join(TRAVAIL, 'liste.txt')
    with open(liste, 'w') as f:
        for m in morceaux:
            f.write(f"file '{m}'\n")
    bande = os.path.join(TRAVAIL, 'bande.m4a')
    sh(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', bande])

    # 1600×879 → 1920×1080 : on met à l'échelle sans déformer et on complète en blanc.
    sh(['ffmpeg', '-y', '-v', 'error', '-i', video, '-i', bande,
        '-vf', 'scale=1920:-2:flags=lanczos,pad=1920:1080:0:(oh-ih)/2:white,fps=25',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', SORTIE])
    print(f'{SORTIE} · {duree(SORTIE)/60:.1f} min')


if __name__ == '__main__':
    main()
