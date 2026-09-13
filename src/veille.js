'use strict';
/* LA VEILLE DE FOND — ce que le serveur regarde pendant que l'écran regarde ailleurs.
 *
 * Deux familles d'événements se produisaient sans que personne ne l'apprenne :
 *
 *   — un build Jenkins lancé depuis Mergerie n'était vu finir que si l'onglet Jenkins était
 *     resté ouvert, parce que c'est le NAVIGATEUR qui interrogeait Jenkins toutes les minutes.
 *     Or on lance un build précisément pour aller faire autre chose ;
 *   — un conteneur qui tombe ne réveillait personne : le badge de santé change de couleur
 *     dans un menu qu'on ne regarde pas.
 *
 * Le remède est le même pour les deux : le SERVEUR mesure, et pousse un fait dans `notify` ;
 * le client, lui, garde ce qu'il a toujours eu — le droit de décider s'il l'affiche.
 *
 * Trois règles :
 *   1. On ne sonde QUE ce qu'on attend. Sans lancement en cours, aucun appel n'est fait à
 *      Jenkins — un outil local n'a pas à marteler le CI de l'équipe.
 *   2. Une transition, jamais un état. Un conteneur arrêté depuis trois jours ne notifie pas
 *      tous les matins : seul le passage de « tourne » à « tombé » est un événement.
 *   3. Ce qui n'aboutit pas s'oublie. Un build qui ne revient jamais (job supprimé, Jenkins
 *      éteint) sort de la liste d'attente au bout de six heures plutôt que d'y sonder sans fin.
 */

const notify = require('./notify');
const jenkins = require('./jenkins');
const docker = require('./docker');

const OUBLI_MS = 6 * 3600 * 1000;   // au-delà, un lancement attendu est considéré perdu
const MAX_ATTENTES = 20;            // borne de sécurité : autant d'appels Jenkins par tour

/* Ce qu'on attend de Jenkins : chemin du job → numéro du dernier build AU MOMENT du
   lancement. Le build neuf n'existe pas encore (Jenkins met en file) ; c'est son APPARITION
   — un numéro strictement plus grand, terminé — qui fait l'événement. En mémoire : un
   redémarrage du serveur oublie l'attente, ce qui est le bon compromis pour une liste qui se
   vide d'elle-même en quelques minutes. */
const attentes = new Map();

function attendreJenkins(chemin, depuis) {
  const p = String(chemin || '').trim();
  if (!p) return;
  if (attentes.size >= MAX_ATTENTES && !attentes.has(p)) return;
  attentes.set(p, { depuis: Number(depuis) || 0, at: Date.now() });
}
const attendus = () => [...attentes.keys()];

async function tourJenkins(cfg) {
  if (!attentes.size || !jenkins.isConfigured(cfg)) return 0;
  let finis = 0;
  for (const [chemin, a] of [...attentes]) {
    if (Date.now() - a.at > OUBLI_MS) { attentes.delete(chemin); continue; }
    let d;
    try { d = await jenkins.detail(cfg, chemin, 1); }
    catch { continue; } // Jenkins injoignable : on retentera au tour suivant, sans rien dire
    const b = (d.builds || [])[0];
    if (!b || !b.number || b.number <= a.depuis || b.building) continue;
    attentes.delete(chemin);
    finis += 1;
    notify.push('jenkins_done', {
      path: chemin, number: b.number, result: b.result || 'UNKNOWN',
      ok: b.result === 'SUCCESS',
    });
  }
  return finis;
}

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

/* Le timer. Une seule cadence pour les deux veilles : elles sont l'une et l'autre locales
   (un `docker ps`, un appel Jenkins seulement quand on attend quelque chose), et deux timers
   de plus n'apporteraient qu'un réglage de plus à comprendre. */
let timer = null;
let occupe = false;

function demarrer({ getConfig, periodeMs = 60000 } = {}) {
  arreter();
  if (!periodeMs) return;
  const tour = async () => {
    if (occupe) return;
    occupe = true;
    try { await tourDocker(); } catch (e) { console.error(`[veille] docker : ${e.message}`); }
    try { await tourJenkins(getConfig ? getConfig() : {}); } catch (e) { console.error(`[veille] jenkins : ${e.message}`); }
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
  attentes.clear();
  etatDocker = null;
  dernierDocker = { at: null, containers: [] };
}

module.exports = {
  attendreJenkins, attendus, tourJenkins, tourDocker, dockerTombes,
  demarrer, arreter, oublierTout, OUBLI_MS,
};
