'use strict';
/* LA PORTE DU SYSTÈME DE PLUGINS, pour `server.js` et la couche HTTP. Tout le reste de
   `src/plugins/` est un détail de cette porte. */
const chargeur = require('./chargeur');
const registre = require('./registre');
const pageplugins = require('./pageplugins');
const { creerContexte, primitivesDe } = require('./contexte');

/** Les fragments de page des plugins actifs (texte par marqueur). */
function fragmentsDePage() {
  return pageplugins.texteDesFragments(pageplugins.fragments(chargeur.actifsPourPage()));
}

/** Ce que le navigateur demande au chargement et après une bascule : les déclarations de tous les plugins actifs. */
function uiPourNavigateur() {
  return pageplugins.fragments(chargeur.actifsPourPage()).meta;
}

module.exports = {
  demarrer: chargeur.demarrer, arreter: chargeur.arreter,
  liste: chargeur.liste, fiche: chargeur.fiche, decouvrir: chargeur.decouvrir,
  activer: chargeur.activer, desactiver: chargeur.desactiver,
  installerDepuisDossier: chargeur.installerDepuisDossier, installerDepuisGit: chargeur.installerDepuisGit, mettreAJour: chargeur.mettreAJour, desinstaller: chargeur.desinstaller,
  routesDe: chargeur.routesDe, semerDemo: chargeur.semerDemo,
  reglagesPourEcran: chargeur.reglagesPourEcran, lireSecretPourCopie: chargeur.lireSecretPourCopie, ecrireReglages: chargeur.ecrireReglages,
  fragmentsDePage, uiPourNavigateur, bundle: (nom) => { const f = chargeur.fiche(nom); return f && f.actif ? pageplugins.bundle(f) : null; },
  services: { register: (nom, fn) => registre.registerService('coeur', nom, fn), call: registre.callService, has: registre.hasService },
  palette: registre.palette,
  declarations: registre.declarations,
  creerContexte, primitivesDe,
};
