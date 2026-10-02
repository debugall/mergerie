'use strict';
/* UN PLUGIN N'IMPORTE RIEN DE `src/`. La règle est statique (`npm run check:plugins` la relit
   sur les plugins embarqués) ET dynamique : ce crochet sur `Module.prototype.require` refuse,
   au moment du chargement, tout `require` émis depuis un dossier de plugin qui se résoudrait
   sous `src/` de Mergerie, ou sous un autre plugin. Un plugin ne connaît que le ctx, le SDK
   (`@mergerie/plugin-sdk` ou `sdk/`) et ses propres fichiers. Node lui-même ne sait pas dire
   « d'où » vient un require ; `this.filename` le dit, et c'est ce qu'on lit.

   Posé une fois par processus (le serveur, ou un worker de plugin tiers). */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const RACINE = path.join(__dirname, '..', '..');
const SRC = path.join(RACINE, 'src') + path.sep;
const SDK = path.join(RACINE, 'sdk') + path.sep;

/** @type {string[]} les dossiers de plugins surveillés (chemins absolus, terminés par un séparateur) */
const dossiers = [];
let pose = false;

const sous = (f, dir) => typeof f === 'string' && f.startsWith(dir);

function dossierDe(fichier) {
  return dossiers.find((d) => sous(fichier, d)) || null;
}

function poser() {
  if (pose) return;
  pose = true;
  const original = Module.prototype.require;
  Module.prototype.require = function requireGarde(id) {
    const depuis = dossierDe(this.filename || '');
    if (depuis) {
      let cible = null;
      try { cible = Module._resolveFilename(id, this); } catch { cible = null; }
      if (cible && cible.startsWith(SRC)) {
        throw new Error(`plugin ${path.basename(depuis.slice(0, -1))} : require('${id}') refusé — un plugin n'importe rien de src/, il passe par le ctx`);
      }
      if (cible && !cible.startsWith(depuis) && !cible.startsWith(SDK) && dossierDe(cible)) {
        throw new Error(`plugin ${path.basename(depuis.slice(0, -1))} : require('${id}') refusé — un plugin n'importe pas un autre plugin, il passe par ctx.services ou ctx.events`);
      }
    }
    return original.call(this, id);
  };
}

/** Déclare un dossier de plugin à surveiller. */
function surveiller(dir) {
  /* Node nomme un module par son chemin RÉEL : sous macOS, `/var/folders/…` est `/private/var/…`. On
     surveille les deux formes, sinon un plugin posé sous un lien symbolique passerait sous le garde. */
  const formes = [path.resolve(dir)];
  try { formes.push(fs.realpathSync(dir)); } catch { /* dossier disparu : la forme donnée suffit */ }
  for (const f of formes) { const d = f + path.sep; if (!dossiers.includes(d)) dossiers.push(d); }
  poser();
}

module.exports = { surveiller, poser, SRC, SDK };
