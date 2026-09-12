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

/* A7 — OÙ UN COMMENTAIRE PEUT S'ACCROCHER, et où il ne peut pas.
 *
 * Un constat cite une ligne de la VERSION FINALE du fichier (c'est ce que `annoterDiff` donne
 * à l'IA). Mais un commentaire inline ne s'accroche pas n'importe où : la forge n'accepte
 * qu'une ligne présente dans le diff. Trois cas, et ils ne s'écrivent pas pareil :
 *
 *   ligne AJOUTÉE   → `new_line` seul ;
 *   ligne de CONTEXTE (inchangée, mais dans un hunk) → `new_line` ET `old_line`, sinon GitLab
 *     refuse la position ;
 *   ligne HORS DU DIFF → aucun ancrage possible. L'IA a parfaitement le droit de parler d'une
 *     ligne qu'elle n'a pas vue changer (« cette fonction est maintenant appelée avec null ») ;
 *     ce qui n'est pas permis, c'est d'en faire un commentaire posé sur une ligne que personne
 *     n'a touchée.
 *
 * Rend `Map<fichier, Map<ligne finale, { old_line }>>`. `old_line` vaut `null` sur une ligne
 * ajoutée — c'est exactement ce que la position attend.
 */
function lignesAncrables(diff) {
  const out = new Map();
  let fichier = null;
  let n = 0;   // ligne courante dans la version finale
  let o = 0;   // ligne courante dans l'ancienne version
  for (const l of String(diff || '').split('\n')) {
    const mf = /^\+\+\+ b\/(.+)$/.exec(l);
    if (mf) {
      fichier = mf[1] === '/dev/null' ? null : mf[1];
      if (fichier && !out.has(fichier)) out.set(fichier, new Map());
      continue;
    }
    /* Les en-têtes AVANT le test des préfixes : `--- a/x` commence par `-` et `+++ b/x` par
       `+`. Les compter comme des lignes décalerait toute la numérotation du fichier suivant. */
    if (/^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity index|rename |old mode|new mode|Binary files )/.test(l)) continue;
    const mh = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (mh) { o = Number(mh[1]); n = Number(mh[2]); continue; }
    if (!fichier) continue;
    if (l.startsWith('\\')) continue;                       // « \ No newline at end of file »
    if (l.startsWith('+')) { out.get(fichier).set(n, { old_line: null }); n += 1; continue; }
    if (l.startsWith('-')) { o += 1; continue; }            // absente de la version finale
    out.get(fichier).set(n, { old_line: o });               // contexte : les DEUX numéros
    n += 1; o += 1;
  }
  return out;
}

module.exports = { annoterDiff, lignesAncrables, MAX_LIGNES };
