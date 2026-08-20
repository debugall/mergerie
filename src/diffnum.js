'use strict';
/* NUMÉROTER UN DIFF — pour que l'IA cite des numéros de ligne JUSTES.
 *
 * La review ne reçoit que le patch. Or un patch ne porte les numéros que dans ses en-têtes
 * `@@ -a,b +c,d @@` : pour dire « ligne 137 », un modèle doit compter les lignes depuis
 * l'en-tête, à la main, sur des dizaines de hunks. Il y arrive souvent, pas toujours — d'où
 * des rapports dont les numéros tombent à côté du code affiché à droite, et un lecteur qui
 * doute du rapport entier pour une ligne fausse.
 *
 * On lui donne donc le travail déjà fait : chaque ligne du diff préfixée de son numéro RÉEL
 * dans la version finale du fichier. Une ligne supprimée n'existe pas dans cette version : sa
 * colonne reste vide (son numéro dans l'ANCIENNE version n'aiderait qu'à se tromper).
 *
 * Pur : ni disque ni réseau, donc testable sans dépôt.
 */

const MAX_LIGNES = 20000;   // borne de sécurité : un diff géant ne doit pas gonfler le prompt

/* Rend une vue numérotée du diff unifié. Format volontairement proche du patch — mêmes
   marqueurs `+`/`-`/espace — pour que l'IA reconnaisse ce qu'elle lit, avec le numéro devant. */
function annoterDiff(diff) {
  const lignes = String(diff || '').split('\n');
  const out = [];
  let fichier = null;
  let n = 0;                 // prochaine ligne de la version finale
  let tronque = false;

  for (const l of lignes) {
    if (out.length >= MAX_LIGNES) { tronque = true; break; }
    const mf = /^\+\+\+ b\/(.+)$/.exec(l);
    if (mf) {
      fichier = mf[1] === '/dev/null' ? null : mf[1];
      if (fichier) out.push(`=== ${fichier} ===`);
      continue;
    }
    const mh = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (mh) { n = Number(mh[1]); out.push(`     … ${l}`); continue; }
    if (!fichier) continue;                       // en-têtes `diff --git`, `index`, `--- a/…`
    if (l.startsWith('+')) { out.push(`${String(n).padStart(6)} ${l}`); n += 1; continue; }
    if (l.startsWith('-')) { out.push(`       ${l}`); continue; }   // absente de la version finale
    if (l.startsWith('\\')) { out.push(`       ${l}`); continue; }  // « \ No newline at end of file »
    // Ligne de contexte (préfixe espace) — et tolérance à un contexte sans préfixe.
    out.push(`${String(n).padStart(6)} ${l.startsWith(' ') ? l : ` ${l}`}`);
    n += 1;
  }
  if (tronque) out.push(`     … (vue tronquée à ${MAX_LIGNES} lignes)`);
  return out.join('\n');
}

module.exports = { annoterDiff, MAX_LIGNES };
