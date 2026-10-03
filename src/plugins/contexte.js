'use strict';
/* LE CTX, CÔTÉ CŒUR : le constructeur commun (`sdk/lib/contexte.js`) nourri des fournisseurs
   du serveur — son bus, son dictionnaire, son registre, son horloge, sa base, son client HTTP
   à TLS épinglable, ses notifications, ses processus. Rien de plus que ce que le SDK de test
   fournit en mémoire : c'est ce qui rend l'API publique réellement suffisante. */
const path = require('path');

const { creerContexte: construire, primitivesDe } = require(path.join(__dirname, '..', '..', 'sdk', 'lib', 'contexte.js'));
const events = require('../core/events');
const i18nCoeur = require('../core/i18n');
const registre = require('./registre');
const horloge = require('./horloge');
const jobsPlugins = require('./jobs-plugins');

/* Les dictionnaires des plugins, côté serveur : fusionnés dans celui du cœur pour que `t()`
   les trouve, et retirés à la désactivation. */
/* Les noms de TOUS les plugins connus, fournis par le chargeur (qui importe ce module : l'inverse serait un cycle). */
let nomsConnus = () => [];
function connaitreLesPlugins(fn) { nomsConnus = fn; }

const dictsParPlugin = new Map();
function retirerDicts(nom) {
  const mien = dictsParPlugin.get(nom);
  if (!mien) return;
  for (const locale of ['fr', 'en']) for (const k of Object.keys(mien[locale] || {})) delete i18nCoeur.dict[locale][k];
  dictsParPlugin.delete(nom);
}

/**
 * @param {object} manifeste le plugin.json validé
 * @param {{ db?: any, log?: (m: string) => void, isDemo?: () => boolean, sortie?: object }} [options]
 */
function creerContexte(manifeste, options = {}) {
  const nom = String(manifeste.name);
  const sortie = options.sortie || {};
  const ctx = construire(manifeste, {
    log: options.log || ((m) => console.log(`[${nom}] ${m}`)),
    sortie,
    bus: events,
    i18n: { dict: i18nCoeur.dict, t: i18nCoeur.t, getLang: i18nCoeur.getLang },
    registre,
    horloge,
    db: () => options.db || require('../db'),
    net: require('../core/httpreq'),
    notify: { push: (type, data) => require('../core/notify').push(type, data) },
    /* `suivre` : tout processus est suivi pour ne laisser aucun groupe orphelin à l'arrêt ; `suivreJob` : le processus d'un `job.exec` devient l'enfant ACTIF du job courant (contexte d'annulation du cœur), donc « Stop » le tue. */
    exec: { options: (o) => require('../core/proc').options(o), tuer: (child, signal) => require('../core/proc').tuerGroupe(child, signal), suivre: (child) => require('../core/proc').suivre(child), suivreJob: (child) => require('../core/proc').setActive(child) },
    jobs: { register: jobsPlugins.inscrire, start: jobsPlugins.demarrer },
    localRoots: () => (options.db || require('../db')).prepare('SELECT id, path, label FROM local_root ORDER BY path').all(),
    dataDir: (n) => require('./donnees').dossierDe(n),
    autresPlugins: () => nomsConnus(),
    env: process.env,
    isDemo: options.isDemo || (() => process.env.MERGERIE_DEMO === '1'),
  });
  dictsParPlugin.set(nom, sortie.dicts);
  return ctx;
}

module.exports = { creerContexte, primitivesDe, retirerDicts, connaitreLesPlugins };
