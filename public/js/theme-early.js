'use strict';
/* LE THÈME AVANT LE PREMIER RENDU — sans quoi l'écran clignote en sombre avant de passer au clair.
   Un fichier et non un <script> dans la page : la politique de contenu n'admet que les scripts
   servis par l'application (`script-src 'self'`), et un script en ligne serait la seule
   exception qu'il faudrait lui ouvrir. Chargé en synchrone dans le <head>, il tourne toujours
   avant le premier rendu. */
try {
  var p = localStorage.getItem('aidevtools_theme') || 'auto';
  var r = p === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : p;
  document.documentElement.setAttribute('data-theme', r);
  document.documentElement.lang = localStorage.getItem('aidevtools_lang') || 'fr';
} catch (e) { /* stockage indisponible : thème sombre + français par défaut */ }
