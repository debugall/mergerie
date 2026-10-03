'use strict';
/* Joue des instructions SQL (une par ligne, fichier $SQL_FILE) sur la connexion du cœur — celle qui porte
   les fonctions et déclencheurs du schéma —, dans un processus frais : ce que fait un démarrage. Lancé
   par les tests de migration avec MERGERIE_DATA_DIR posé dans l'environnement du processus enfant. */
const fs = require('node:fs');

// eslint-disable-next-line global-require
const db = require('../../src/db');
for (const s of fs.readFileSync(process.env.SQL_FILE, 'utf8').split('\n')) if (s.trim()) db.exec(s);
