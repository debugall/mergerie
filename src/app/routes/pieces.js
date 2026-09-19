'use strict';
/* Les pièces jointes d’une session : les lire et les retirer. Leur enregistrement est dans lib/pieces.js.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const path = require('path');
const fs = require('fs');
const { servirFichierNonFiable } = require('../fichiers');
const { wrap } = require('../http');
const { pieceDemandee } = require('../lib/pieces');

app.get('/api/pieces/:scope/:id', (req, res) => {
  const pj = pieceDemandee(req);
  if (!pj || !fs.existsSync(pj.path)) return res.status(404).end();
  // Le nom d'origine suit le fichier : `pj_2.pdf` ne dit rien à qui l'enregistre.
  return servirFichierNonFiable(res, { chemin: pj.path, nom: pj.name || path.basename(pj.path), mime: pj.mime });
});
/* Le fichier part avec la ligne : une pièce détachée resterait sur le disque pour toujours,
   invisible et impossible à retrouver depuis l'écran. */
app.delete('/api/pieces/:scope/:id', wrap((req, res) => {
  const pj = pieceDemandee(req);
  if (pj) {
    try { fs.rmSync(pj.path, { force: true }); } catch { /* déjà parti */ }
    db.prepare('DELETE FROM piece_jointe WHERE id = ?').run(pj.id);
  }
  res.json({ ok: true });
}));
