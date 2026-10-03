'use strict';
/* LA VEILLE DE FOND — ce que le serveur regarde pendant que l'écran regarde ailleurs.
 *
 * Un conteneur qui tombe ne réveillait personne : le badge de santé change de couleur dans un
 * menu qu'on ne regarde pas. Le SERVEUR mesure donc, et pousse un fait dans `notify` ; le
 * client, lui, garde ce qu'il a toujours eu — le droit de décider s'il l'affiche.
 *
 * Deux règles :
 *   1. Une transition, jamais un état. Un conteneur arrêté depuis trois jours ne notifie pas
 *      tous les matins : seul le passage de « tourne » à « tombé » est un événement.
 *   2. On ne sonde qu'en local (un `docker ps`), à une cadence d'une minute.
 *
 * (La fin des builds de CI lancés depuis Mergerie est veillée par le plugin qui les lance,
 * sur sa propre tâche périodique — `ctx.schedule`.) */

const notify = require('../core/notify');
const docker = require('./docker');

/* L'état Docker du dernier tour : nom → « tournait-il ? ». `null` tant qu'on n'a pas mesuré
   une première fois — on ne notifie donc RIEN au démarrage, sans quoi ouvrir Mergerie
   annoncerait comme neufs tous les conteneurs arrêtés de la semaine. */
let etatDocker = null;
// Ce que le brief relit : les tombés du dernier relevé, et quand il date. Le brief ne sonde
// pas Docker lui-même — il reste sans réseau, et affiche ce que la veille a déjà vu.
let dernierDocker = { at: null, containers: [] };
const dockerTombes = () => ({ at: dernierDocker.at, containers: dernierDocker.containers.slice() });

async function tourDocker() {
  let liste;
  try {
    const st = await docker.status();
    if (!st.ok) return 0;                       // pas de démon : rien à surveiller, rien à dire
    liste = await docker.listContainers();
  } catch { return 0; }

  const tombes = liste.filter((c) => docker.estTombe(c))
    .map((c) => ({ name: c.name, state: c.state, status: c.status, project: c.project || null }));
  dernierDocker = { at: new Date().toISOString(), containers: tombes };

  const avant = etatDocker;
  etatDocker = new Map(liste.map((c) => [c.name, !!c.running]));
  if (!avant) return 0;                         // première mesure : on se cale, on n'alerte pas

  const neufs = tombes.filter((c) => avant.get(c.name) === true);
  if (neufs.length) {
    notify.push('docker_down', { n: neufs.length, names: neufs.map((c) => c.name).join(', ') });
  }
  return neufs.length;
}

let timer = null;
let occupe = false;

function demarrer({ periodeMs = 60000 } = {}) {
  arreter();
  if (!periodeMs) return;
  const tour = async () => {
    if (occupe) return;
    occupe = true;
    try { await tourDocker(); } catch (e) { console.error(`[veille] docker : ${e.message}`); }
    occupe = false;
  };
  timer = setInterval(tour, periodeMs);
  if (timer.unref) timer.unref();             // un timer de fond ne retient pas le processus
  return tour;
}

function arreter() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Remise à zéro (tests) : la veille garde de l'état entre deux tours, par construction.
function oublierTout() {
  etatDocker = null;
  dernierDocker = { at: null, containers: [] };
}

module.exports = { tourDocker, dockerTombes, demarrer, arreter, oublierTout };
