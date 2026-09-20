'use strict';
/* Lire le corps des requêtes (JSON, audio brut) et servir les fichiers statiques.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const express = require('express');
const path = require('path');
const { assemblerPage } = require('../../core/page');

const PUBLIC = path.join(__dirname, '..', '..', '..', 'public');
const INDEX = path.join(PUBLIC, 'index.html');

app.use(express.json({ limit: '20mb' })); // marge pour les captures de ticket (base64)
/* L'AUDIO DE LA DICTÉE arrive en corps BRUT, pas en multipart : Express 4 ne sait pas lire un
   multipart sans dépendance, et les métadonnées d'un segment (numéro, contexte, langue)
   tiennent très bien dans la query. Dix mégaoctets, soit un peu plus de cinq minutes de PCM
   16 kHz mono — au-delà, ce n'est plus de la dictée dans un champ. Le corps n'est JAMAIS
   écrit sur disque ni journalisé : il est relayé au moteur et libéré à la réponse. */
app.use(express.raw({ type: 'audio/wav', limit: '10mb' }));
/* Fichiers statiques. `no-cache` = le navigateur peut mettre en cache mais DOIT
   revalider avant chaque usage (requête conditionnelle → 304 si inchangé, contenu
   frais sinon). Évite le piège « je ne vois pas mes changements » sans forcer un
   rechargement complet à chaque fois : un simple refresh récupère la dernière version. */
/* LA PAGE EST ASSEMBLÉE PAR MORCEAUX (`src/core/page.js`) : `index.html` est une coquille et
   des marqueurs `<!--@include html/…-->`, résolus ici pour `/` et `/index.html` — la route est
   posée AVANT `express.static`, qui passe en `index: false` pour ne plus servir le gabarit brut.
   Mêmes en-têtes qu'un fichier statique (`no-cache`, la CSP posée par `entetes.js` avant), et
   un morceau modifié est servi sans redémarrage. */
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(assemblerPage(INDEX));
});
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
