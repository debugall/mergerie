'use strict';
// Extrait une "note globale" d'un rapport de revue en Markdown (texte libre IA).
// Renvoie { raw, value } avec value ∈ [0,1] (pour le code couleur), ou null.

function frac(numStr, denStr) {
  const num = parseFloat(String(numStr).replace(',', '.'));
  const den = parseFloat(String(denStr).replace(',', '.'));
  if (!(den > 0) || num > den) return null;
  return { raw: `${numStr}/${denStr}`, value: num / den };
}

/* ⚠ On cherche TOUJOURS en partant de la FIN du rapport.
   La note globale le CONCLUT (c'est ce que demandent les gabarits de prompt), alors
   qu'une re-review cite volontiers la note précédente dès son résumé d'ouverture
   (« la note passe de 5,8 à 8,4 »). Chercher depuis le début renvoyait donc l'ANCIENNE
   note après chaque « Relancer la review » — la liste restait bloquée sur la 1re note. */
function extractNote(md) {
  if (!md) return null;
  const lines = md.split('\n');
  const fracRe = /(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/;
  const mentionsNote = (l) => /\bnotes?\b|\bscore\b|\brating\b/i.test(l);
  // La valeur peut être sur la ligne du libellé, ou juste en dessous quand c'est un
  // titre (« ## Note globale » puis « **8,4/10** » — forme du gabarit et du mock).
  const fracAt = (i) => {
    for (const cand of [lines[i], lines[i + 1] || '']) {
      const m = cand.match(fracRe);
      if (m) { const f = frac(m[1], m[2]); if (f) return f; }
    }
    return null;
  };

  // 1) mention EXPLICITE d'une note globale : le signal le plus sûr.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/note\s+globale|overall\s+(score|rating|grade)/i.test(lines[i])) continue;
    const f = fracAt(i);
    if (f) return f;
  }
  // 2) à défaut, la dernière ligne mentionnant "note"/"score" porteuse d'une fraction.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!mentionsNote(lines[i])) continue;
    const f = fracAt(i);
    if (f) return f;
  }
  // 3) toute fraction sur une base classique 5/10/20/100 — la dernière, même raison.
  const all = [...md.matchAll(/(\d+(?:[.,]\d+)?)\s*\/\s*(5|10|20|100)\b/g)];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const f = frac(all[i][1], all[i][2]);
    if (f) return f;
  }
  // 4) note en lettre A..F (majuscule isolée sur une ligne mentionnant "note")
  const letterMap = { A: 1, B: 0.8, C: 0.6, D: 0.4, E: 0.2, F: 0 };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/\bnotes?\b/i.test(lines[i])) continue;
    const m = lines[i].match(/\b([A-F])\b/); // majuscule uniquement, évite les faux positifs
    if (m) { const g = m[1]; return { raw: g, value: letterMap[g] }; }
  }
  return null;
}

module.exports = { extractNote };
