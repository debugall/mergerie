'use strict';
/* Servir un fichier qui ne vient pas de nous — le SEUL `res.sendFile` du serveur : nosniff, sandbox, pièce jointe sauf pour une image.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const path = require('path');

/* SERVIR UN FICHIER QUE QUELQU'UN D'AUTRE A FOURNI — pièce jointe Jira ou de session, capture
   d'une note, image de ticket. Une seule porte, parce que les quatre avaient divergé : la pièce
   jointe Jira était déjà prudente, les trois autres servaient `inline` ce qu'on leur donnait. Un
   `.html` ou un `.svg` ouvert en navigation directe sur NOTRE origine exécutait son script avec
   accès à l'API locale.
     — `inline` pour les images matricielles (non scriptables) et le PDF (lu par le lecteur du
       navigateur, hors de notre origine), `attachment` pour tout le reste ;
     — `nosniff` partout, et une CSP `sandbox` qui retire l'origine à ce qui serait rendu malgré
       tout (le PDF en est dispensé : le lecteur de Chrome refuse de s'ouvrir sous `sandbox`).
   Ni `html` ni `xml` ne sont refusés à l'envoi — l'agent sait les lire —, ils ne s'exécutent plus. */
const TYPES_PAR_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
};
const INLINE_SUR = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
function servirFichierNonFiable(res, { chemin = null, buffer = null, nom = '', mime = '' }) {
  const ext = path.extname(String(nom || chemin || '')).slice(1).toLowerCase();
  const type = String(mime || TYPES_PAR_EXTENSION[ext] || 'application/octet-stream');
  const pdf = /^application\/pdf$/i.test(type);
  const inline = INLINE_SUR.test(type) || pdf;
  const nomAffiche = String(nom || (chemin ? path.basename(chemin) : 'fichier'));
  const ascii = nomAffiche.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!pdf) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nomAffiche)}`);
  if (buffer) return res.send(buffer);
  return res.sendFile(path.resolve(chemin));
}

module.exports = {
  TYPES_PAR_EXTENSION, INLINE_SUR, servirFichierNonFiable,
};
