# -*- coding: utf-8 -*-
"""Réécriture du texte PRONONCÉ, sans toucher au texte affiché.

Une synthèse vocale lit de l'orthographe, pas du sens : « MRs » sort en « misters », « IA »
en un mot, « /10 » en silence. On applique donc un dictionnaire de prononciation à la seule
narration — les slides, elles, gardent l'écriture correcte.

Deux règles de méthode :
  — quand un sigle a un équivalent parlé naturel, on dit le mot entier (« MR » → « merge
    request ») plutôt que d'épeler : c'est ce qu'un humain dirait à l'oral ;
  — sinon on épelle en séparant les lettres, ce que tout moteur lit correctement.
"""
import re

# L'ordre compte : les entrées les plus longues d'abord, sinon « MR » mange « MRs ».
FR = [
    # --- Ponctuation qui ne produit AUCUN phonème : la phrase perd son sujet.
    #     Vérifié : « ? affiche la liste » sort en « affiche la liste », et le « / » est muet. ---
    (r'Chiffres pour les onglets, / pour la recherche',
     'Les chiffres pour les onglets, la touche slache pour la recherche'),
    (r'\?\s+affiche la liste complète', 'La touche point d’interrogation affiche la liste complète'),
    (r'à portée de\s*«?\s*\?\s*»?', 'à portée du point d’interrogation'),

    # --- Sigles et symboles ---
    (r'\bMRs\b', 'merge requests'),
    (r'\bMR\b', 'merge request'),
    # « IA » n'a AUCUNE graphie qui se lise /i.a/ : « I A » insère une pause (_!), « l'ia »
    # donne « lya », et « L'I A » en début de phrase fait épeler « L apostrophe I A ».
    # On dit donc le mot entier — ce qu'un narrateur dirait de toute façon.
    (r'\bappel IA\b', 'appel d’intelligence artificielle'),
    (r'\bagent IA\b', 'agent d’intelligence artificielle'),
    (r'\breview IA\b', 'review par intelligence artificielle'),
    (r'\bDev IA\b', 'Dev intelligence artificielle'),
    (r'\bIA\b', 'intelligence artificielle'),
    (r'\bCLI\b', 'C L I'),
    (r'\bURL\b', 'U R L'),
    (r'\bAPI\b', 'A P I'),
    (r'\bSSH\b', 'S S H'),
    (r'\bXSS\b', 'X S S'),
    # « JUnit » et « TAP » arrivent avec les vérificateurs. Le moteur français lit « TAP »
    # sans le p final ; les développeurs francophones disent /tap/ et « ji-unite ».
    (r'\bJUnit\b', 'J unite'),
    (r'\bTAP\b', 'tape'),
    (r'\bSQL\b', 'S Q L'),
    (r'\bSHA\b', 'S H A'),
    (r'\bGNU\b', 'G N U'),
    (r'\bMINORANT\b', 'minorant'),
    (r'\bN°\b', 'numéro'),
    (r'\bAGPL-3\.0\b', 'A G P L trois point zéro'),
    (r'\bCtrl/Cmd \+ K\b', 'Contrôle ou Commande plusse K'),   # « plus » seul se lit « plu »
    (r'\bCtrl\+V\b', 'Contrôle plusse V'),
    (r'\bCtrl\+K\b', 'Contrôle plusse K'),
    (r'\bnpm install\b', 'N P M inne-stole'),
    (r'\bnpm start\b', 'N P M starte'),
    (r'\.env\b', 'point ènve'),
    (r'\bNode 22\.9\b', 'Node vingt-deux point neuf'),
    (r'\*\*/migrations/\*\*, \*\.sql', 'un dossier de migrations, ou des fichiers S Q L'),
    (r'\bDB_POOL_SIZE\b', 'D B poule saïze'),
    (r'\bFEATURE_X\b', 'fitcheur X'),
    (r'\bet/ou\b', 'et ou'),
    (r'(\d),(\d)\b', r'\1 virgule \2'),
    (r'\s*→\s*', ', puis '),
    (r'\s*·\s*', ', '),
    (r'/10\b', ' sur 10'),
    (r'\b30 s\b', '30 secondes'),
    (r'\bj\s*/\s*k\b', 'J et K'),

    # --- Mots que le français lit MAL (consonne finale muette, nasalisation, u français) ---
    (r'(?i)\bprompts\b', 'promptes'),
    (r'(?i)\bprompt\b', 'prompte'),
    (r'(?i)\bcockpit\b', 'cockpitte'),
    (r'(?i)\bissues\b', 'ichiouze'),
    (r'(?i)\bfunnel\b', 'feunel'),
    (r'(?i)\bEnterprise\b', 'Enn-teurpraïze'),
    (r'(?i)\bBitbucket\b', 'Bitbeukette'),
    (r'(?i)\bJira\b', 'Djira'),
    (r'(?i)\bstreamé\b', 'strimé'),
    (r'(?i)\bMakefile\b', 'Mèk-faïle'),

    # --- Mots qui font BASCULER espeak en anglais : le modèle français n'a jamais
    #     entendu ces phonèmes, c'est le risque le plus sérieux du corpus. ---
    (r'(?i)\bauthentification\b', 'otentification'),
    (r'(?i)\btokens\b', 'tokènes'),
    (r'(?i)\btoken\b', 'tokène'),
    (r'(?i)\bshell\b', 'chelle'),
    (r'(?i)\bweb\b', 'ouèbe'),
    (r'(?i)\bscan\b', 'skanne'),
    (r'(?i)\blive\b', 'laïve'),
    (r'(?i)\bdown\b', 'daoune'),
    (r'(?i)\bpull requests?\b', 'poule rikouest'),
    (r'(?i)\bpull\b', 'poule'),
    (r'(?i)\breleases\b', 'rilisses'),
    (r'(?i)\brelease\b', 'riliss'),
    (r'(?i)\bMarkdown\b', 'Marc-daoune'),
    (r'(?i)\btech lead\b', 'tèk lide'),
    (r'(?i)\bfast-forward\b', 'faste forouorde'),
    (r'(?i)\bmerge requests\b', 'meurdje rikouestes'),
    (r'(?i)\bmerge request\b', 'meurdje rikouest'),
    # « git » se lit « ji » en français : le g doit être durci. Placé APRÈS GitLab/GitHub,
    # qui ne contiennent pas de frontière de mot après « git » et ne sont donc pas touchés.
    (r'(?i)\bidempotente\b', 'idempotente'),      # déjà correct : idɑ̃potɑ̃t
    (r'(?i)\bidempotent\b', 'idempotant'),        # masculin : le « nt » final est muet
    (r'(?i)\bGitLab\b', 'Guite Lab'),
    (r'(?i)\bgithub\.com\b', 'Guite Heub point com'),
    (r'(?i)\bGitHub\b', 'Guite Heub'),
    (r'(?i)\bgit\b', 'guite'),
    (r'(?i)\bcontainers\b', 'conteneurs'),
    (r'(?i)\bcontainer\b', 'conteneur'),
    (r'(?i)\bpush(e[rz])?\b', 'pouche'),
    (r'(?i)\bcommits\b', 'commites'),
    (r'(?i)\bcommit\b', 'commite'),
    (r'(?i)\bbuild\b', 'bilde'),
    (r'(?i)\blint\b', 'linnte'),
    (r'(?i)\bcheckout\b', 'tchèk-aoute'),
    (r'(?i)\bsquash\b', 'skouache'),
    (r'(?i)\bskill\b', 'skile'),
    (r'(?i)\bstale\b', 'stéïle'),
    (r'(?i)\bdry-run\b', 'draï reune'),
    (r'(?i)\bunhealthy\b', 'anèlsi'),
    (r'(?i)\brestarting\b', 'ri-startinng'),
    (r'(?i)\bexited\b', 'égzitèd'),
    (r'(?i)\bre-reviewer\b', 'Re-riviouer'),
    (r'(?i)\breviewer\b', 'riviouer'),
    (r'(?i)\breviewées\b', 'reviouées'),
    (r'(?i)\breviewée\b', 'reviouée'),
    (r'\bdocker run\b', 'docker reune'),

    # --- NE PAS réécrire : Docker, tag, job, drift, log, compose, review, merge,
    #     pipelines, changelog, pattern, diff, patch, fetch, ref, dev, app, repo…
    #     la lecture française par défaut est déjà celle qu'emploient les développeurs,
    #     et certains respellings dégradaient le rendu (o fermé au lieu de o ouvert). ---
    (r'«\s*', ''), (r'\s*»', ''),
]

EN = [
    # « an MR » avant « MR », sinon on obtient « an merge request ».
    (r'\ban MR\b', 'a merge request'),
    (r'\bMRs\b', 'merge requests'),
    (r'\bMR\b', 'merge request'),
    (r'\bCLI\b', 'C L I'),
    (r'\bURL\b', 'U R L'),
    (r'\bAPI\b', 'A P I'),
    (r'\bSSH\b', 'S S H'),
    (r'\bXSS\b', 'X S S'),
    (r'\bAGPL-3\.0\b', 'A G P L three point zero'),
    (r'\bCtrl\+K\b', 'Control plus K'),
    (r'\bCtrl\+V\b', 'Control plus V'),
    (r'\bnpm install\b', 'N P M install'),
    (r'\bnpm start\b', 'N P M start'),
    (r'\.env\b', 'dot E N V'),
    (r'\bNode 22\.9\b', 'Node twenty-two point nine'),
    (r'\*\*/migrations/\*\*, \*\.sql', 'a migrations folder, or SQL files'),
    (r'\bDB_POOL_SIZE\b', 'D B POOL SIZE'),
    (r'\bFEATURE_X\b', 'FEATURE X'),
    (r'\s*→\s*', ', then '),
    (r'\s*·\s*', ', '),
    (r'/10\b', ' out of ten'),
    (r'\bj and k\b', 'J and K'),
    (r'\bJUnit\b', 'J Unit'),
    (r'\bSQL\b', 'S Q L'),
    (r'\bSHA\b', 'S H A'),
    (r'\bGNU\b', 'G N U'),
    (r'\bLOWER BOUND\b', 'lower bound'),
    (r'\band/or\b', 'and or'),
    (r'“\s*', ''), (r'\s*”', ''),
]


def dire(texte, langue='fr'):
    for motif, remplacement in (FR if langue == 'fr' else EN):
        texte = re.sub(motif, remplacement, texte)
    return re.sub(r'\s{2,}', ' ', texte).strip()
