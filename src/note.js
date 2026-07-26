'use strict';
// Extrait une "note globale" d'un rapport de revue en Markdown (texte libre IA).
// Renvoie { raw, value } avec value ∈ [0,1] (pour le code couleur), ou null.

function frac(numStr, denStr) {
  const num = parseFloat(String(numStr).replace(',', '.'));
  const den = parseFloat(String(denStr).replace(',', '.'));
  if (!(den > 0) || num > den) return null;
  return { raw: `${numStr}/${denStr}`, value: num / den };
}

function extractNote(md) {
  if (!md) return null;
  const lines = md.split('\n');
  const fracRe = /(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/;

  // 1) ligne mentionnant "note" ou "score" avec une fraction X/Y
  for (const l of lines) {
    if (/\bnotes?\b|\bscore\b/i.test(l)) {
      const m = l.match(fracRe);
      if (m) { const f = frac(m[1], m[2]); if (f) return f; }
    }
  }
  // 2) toute fraction sur une base classique 5/10/20/100
  const m2 = md.match(/(\d+(?:[.,]\d+)?)\s*\/\s*(5|10|20|100)\b/);
  if (m2) { const f = frac(m2[1], m2[2]); if (f) return f; }

  // 3) note en lettre A..F (majuscule isolée sur une ligne mentionnant "note")
  const letterMap = { A: 1, B: 0.8, C: 0.6, D: 0.4, E: 0.2, F: 0 };
  for (const l of lines) {
    if (/\bnotes?\b/i.test(l)) {
      const m = l.match(/\b([A-F])\b/); // majuscule uniquement, évite les faux positifs
      if (m) { const g = m[1]; return { raw: g, value: letterMap[g] }; }
    }
  }
  return null;
}

module.exports = { extractNote };
