'use strict';
// @ts-check
/* LE BUS D'ÉVÉNEMENTS. Le cœur dit ce qui vient de se passer (`session.finished`,
   `verify.finished`…), et quiconque écoute — un plugin, un module du cœur — réagit, sans que
   l'émetteur sache qui. C'est le seul tissage admis entre le cœur et un plugin, et entre deux
   plugins : un `require` d'un module de l'autre côté est refusé, un événement ne l'est jamais.

   Trois règles, chacune née d'un besoin précis :
   — LES HANDLERS TOURNENT EN FILE, dans l'ordre d'abonnement, l'un après l'autre : un plugin qui
     réagit à `session.finished` en écrivant sa table ne court pas après un autre qui lit la même.
   — UN HANDLER QUI ÉCHOUE EST ISOLÉ : try/catch et délai (30 s par défaut). L'erreur est
     journalisée avec le nom de l'abonné ; ni l'émetteur ni les autres handlers ne la voient.
     Un plugin tiers qui lève ne doit jamais interrompre une session de codage.
   — LE PAYLOAD EST UN OBJET SIMPLE, sérialisable, qui porte `version` (celle de l'événement dans
     le contrat) : il traverse tel quel la frontière d'un worker, et un plugin écrit contre la
     version 1 saura reconnaître une version 2.

   Les noms et versions viennent de `sdk/contract.js` — la source unique, partagée avec la
   documentation et les types du SDK. Un nom hors contrat se laisse émettre (un plugin tiers
   déclare les siens), mais sans version connue il part en version 1. */
const path = require('path');

const contrat = require(path.join(__dirname, '..', '..', 'sdk', 'contract.js'));

const DELAI_DEFAUT_MS = 30_000;

/** @typedef {{ nom: string, handler: (payload: any) => any, proprietaire: string }} Abonne */

/** @type {Map<string, Abonne[]>} */
const abonnes = new Map();
/** @type {(message: string) => void} */
let journal = (m) => console.error(m);
let delaiMs = DELAI_DEFAUT_MS;

/** La version d'un événement selon le contrat, 1 à défaut. */
function versionDe(nom) {
  const e = contrat.EVENTS[nom];
  return e && Number.isInteger(e.version) ? e.version : 1;
}

/** Un payload sérialisable : ce qui passe par JSON, et rien d'autre (pas de handle, pas de req). */
function serialiser(nom, payload) {
  let p = payload;
  try { p = JSON.parse(JSON.stringify(payload == null ? {} : payload)); } catch { p = {}; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { value: p };
  return { version: versionDe(nom), ...p };
}

/**
 * S'abonne. `proprietaire` nomme l'abonné (un plugin, un module) pour le journal et pour
 * `offAll` à sa désactivation. Rend la fonction de désabonnement.
 * @param {string} nom
 * @param {(payload: any) => any} handler
 * @param {{ proprietaire?: string }} [options]
 */
function on(nom, handler, { proprietaire = 'coeur' } = {}) {
  if (typeof nom !== 'string' || !nom.trim()) throw new Error('events.on : nom d’événement requis');
  if (typeof handler !== 'function') throw new Error(`events.on(${nom}) : handler requis`);
  const liste = abonnes.get(nom) || [];
  liste.push({ nom, handler, proprietaire });
  abonnes.set(nom, liste);
  return () => off(nom, handler);
}

/** Se désabonne (handler précis). */
function off(nom, handler) {
  const liste = abonnes.get(nom);
  if (!liste) return;
  const reste = liste.filter((a) => a.handler !== handler);
  if (reste.length) abonnes.set(nom, reste); else abonnes.delete(nom);
}

/** Retire tous les abonnements d'un propriétaire — ce que fait la désactivation d'un plugin. */
function offAll(proprietaire) {
  let n = 0;
  for (const [nom, liste] of [...abonnes]) {
    const reste = liste.filter((a) => a.proprietaire !== proprietaire);
    n += liste.length - reste.length;
    if (reste.length) abonnes.set(nom, reste); else abonnes.delete(nom);
  }
  return n;
}

/** Un handler, borné dans le temps. */
function executer(abonne, payload) {
  return new Promise((resolve) => {
    let fini = false;
    const timer = setTimeout(() => {
      if (fini) return;
      fini = true;
      resolve({ ok: false, error: `délai de ${delaiMs} ms dépassé` });
    }, delaiMs);
    Promise.resolve().then(() => abonne.handler(payload)).then(
      () => { if (!fini) { fini = true; clearTimeout(timer); resolve({ ok: true }); } },
      (e) => { if (!fini) { fini = true; clearTimeout(timer); resolve({ ok: false, error: (e && e.message) || String(e) }); } },
    );
  });
}

/**
 * Émet. Les handlers s'exécutent en file ; le résultat dit combien ont répondu et lesquels ont
 * échoué (journalisés, jamais levés). Le payload rendu est celui qui a circulé, `version` incluse.
 * @param {string} nom
 * @param {object} [payload]
 * @returns {Promise<{ name: string, delivered: number, errors: { owner: string, error: string }[], payload: object }>}
 */
async function emit(nom, payload = {}) {
  if (typeof nom !== 'string' || !nom.trim()) throw new Error('events.emit : nom d’événement requis');
  const p = serialiser(nom, payload);
  const liste = [...(abonnes.get(nom) || [])];
  const errors = [];
  for (const abonne of liste) {
    const r = await executer(abonne, p);
    if (!r.ok) {
      errors.push({ owner: abonne.proprietaire, error: r.error });
      journal(`[events] ${nom} → ${abonne.proprietaire} : ${r.error}`);
    }
  }
  return { name: nom, delivered: liste.length, errors, payload: p };
}

/** Les abonnés d'un événement, par propriétaire — ce que Réglages → Plugins affiche. */
function listeners(nom) {
  return (abonnes.get(nom) || []).map((a) => a.proprietaire);
}

/** Tous les noms écoutés par un propriétaire. */
function ecoutesPar(proprietaire) {
  const out = [];
  for (const [nom, liste] of abonnes) if (liste.some((a) => a.proprietaire === proprietaire)) out.push(nom);
  return out.sort();
}

/**
 * Réglages de test : délai et journal.
 * @param {{ delai?: number, log?: (message: string) => void }} [options]
 */
function configurer({ delai, log } = {}) {
  if (Number.isFinite(delai) && delai > 0) delaiMs = delai;
  if (typeof log === 'function') journal = log;
}

/** Remise à zéro (tests). */
function reset() { abonnes.clear(); delaiMs = DELAI_DEFAUT_MS; journal = (m) => console.error(m); }

module.exports = { on, off, offAll, emit, listeners, ecoutesPar, versionDe, configurer, reset, EVENTS: contrat.EVENTS, DELAI_DEFAUT_MS };
