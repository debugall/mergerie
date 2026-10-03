'use strict';
/* LE DOSSIER PRIVÉ D'UN PLUGIN (`ctx.dataDir`, permission `storage`) : `<dataDir>/plugin-data/<nom>/`.
   Ce n'est PAS le dossier du plugin — celui d'un plugin tiers (`<dataDir>/plugins/<nom>/`) est son
   CODE, effacé à la désinstallation et remplacé à la mise à jour. Ce qu'un plugin écrit (un profil
   de navigateur, un cache, un export) vit à côté, et suit l'option « supprimer aussi ses données » :
   les garder ou non est le choix de la personne, pas un effet de bord de la mise à jour du code. */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');

const RACINE = () => path.join(DATA_DIR, 'plugin-data');

/** Le dossier du plugin, créé s'il manque. */
function dossierDe(nom) {
  const d = path.join(RACINE(), String(nom));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Efface le dossier (désinstallation avec suppression des données). */
function effacer(nom) {
  fs.rmSync(path.join(RACINE(), String(nom)), { recursive: true, force: true });
}

module.exports = { dossierDe, effacer };
