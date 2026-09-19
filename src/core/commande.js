'use strict';
/* DÉCOUPER UNE LIGNE DE COMMANDE EN MOTS, sans shell. C'est ce qui sépare « une commande » de
   « ce qu'un shell en ferait » : ni tube, ni redirection, ni variable — un programme et ses
   arguments, les guillemets respectés. Les vérificateurs, la dictée et la validation des
   réglages en ont tous besoin, et aucun ne doit dépendre des deux autres pour ça : d'où core/. */
const META_SHELL = /[;|&<>`$\n\r]|\$\(/;

function decouperCommande(ligne) {
  const s = String(ligne || '').trim();
  if (!s) return { ok: false, erreur: 'commande vide' };
  if (META_SHELL.test(s)) {
    return { ok: false, erreur: 'les tubes, redirections, enchaînements et variables ne sont pas interprétés (aucun shell) — mets-les dans un script' };
  }
  const toks = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else cur += c; has = true; }
    else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\s/.test(c)) { if (has) { toks.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) return { ok: false, erreur: 'guillemet non fermé' };
  if (has) toks.push(cur);
  if (!toks.length) return { ok: false, erreur: 'commande vide' };
  return { ok: true, programme: toks[0], args: toks.slice(1) };
}

module.exports = { decouperCommande, META_SHELL };
