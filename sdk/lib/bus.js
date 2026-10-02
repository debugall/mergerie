'use strict';
/* LE BUS D'ÉVÉNEMENTS, instanciable : le cœur en tient un (`src/core/events.js`), le SDK de
   test en crée un par contexte. Même code, même règles — voir `src/core/events.js` pour le
   pourquoi de chacune : handlers en file, isolés par try/catch et délai, payload sérialisable
   portant `version`. */
const contrat = require('../contract');

const DELAI_DEFAUT_MS = 30_000;

function versionDe(nom) {
  const e = contrat.EVENTS[nom];
  return e && Number.isInteger(e.version) ? e.version : 1;
}

function serialiser(nom, payload) {
  let p = payload;
  try { p = JSON.parse(JSON.stringify(payload == null ? {} : payload)); } catch { p = {}; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = { value: p };
  return { version: versionDe(nom), ...p };
}

function creerBus({ log, delai } = {}) {
  const abonnes = new Map();
  let journal = typeof log === 'function' ? log : (m) => console.error(m);
  let delaiMs = Number.isFinite(delai) && delai > 0 ? delai : DELAI_DEFAUT_MS;

  function on(nom, handler, { proprietaire = 'coeur' } = {}) {
    if (typeof nom !== 'string' || !nom.trim()) throw new Error('events.on : nom d’événement requis');
    if (typeof handler !== 'function') throw new Error(`events.on(${nom}) : handler requis`);
    const liste = abonnes.get(nom) || [];
    liste.push({ nom, handler, proprietaire });
    abonnes.set(nom, liste);
    return () => off(nom, handler);
  }
  function off(nom, handler) {
    const liste = abonnes.get(nom);
    if (!liste) return;
    const reste = liste.filter((a) => a.handler !== handler);
    if (reste.length) abonnes.set(nom, reste); else abonnes.delete(nom);
  }
  function offAll(proprietaire) {
    let n = 0;
    for (const [nom, liste] of [...abonnes]) {
      const reste = liste.filter((a) => a.proprietaire !== proprietaire);
      n += liste.length - reste.length;
      if (reste.length) abonnes.set(nom, reste); else abonnes.delete(nom);
    }
    return n;
  }
  function executer(abonne, payload) {
    return new Promise((resolve) => {
      let fini = false;
      const timer = setTimeout(() => { if (fini) return; fini = true; resolve({ ok: false, error: `délai de ${delaiMs} ms dépassé` }); }, delaiMs);
      Promise.resolve().then(() => abonne.handler(payload)).then(
        () => { if (!fini) { fini = true; clearTimeout(timer); resolve({ ok: true }); } },
        (e) => { if (!fini) { fini = true; clearTimeout(timer); resolve({ ok: false, error: (e && e.message) || String(e) }); } },
      );
    });
  }
  async function emit(nom, payload = {}) {
    if (typeof nom !== 'string' || !nom.trim()) throw new Error('events.emit : nom d’événement requis');
    const p = serialiser(nom, payload);
    const liste = [...(abonnes.get(nom) || [])];
    const errors = [];
    for (const abonne of liste) {
      const r = await executer(abonne, p);
      if (!r.ok) { errors.push({ owner: abonne.proprietaire, error: r.error }); journal(`[events] ${nom} → ${abonne.proprietaire} : ${r.error}`); }
    }
    return { name: nom, delivered: liste.length, errors, payload: p };
  }
  const listeners = (nom) => (abonnes.get(nom) || []).map((a) => a.proprietaire);
  function ecoutesPar(proprietaire) {
    const out = [];
    for (const [nom, liste] of abonnes) if (liste.some((a) => a.proprietaire === proprietaire)) out.push(nom);
    return out.sort();
  }
  /** @param {{ delai?: number, log?: (message: string) => void }} [options] */
  function configurer({ delai: d, log: l } = {}) {
    if (Number.isFinite(d) && d > 0) delaiMs = d;
    if (typeof l === 'function') journal = l;
  }
  function reset() { abonnes.clear(); delaiMs = DELAI_DEFAUT_MS; journal = (m) => console.error(m); }

  return { on, off, offAll, emit, listeners, ecoutesPar, versionDe, configurer, reset, EVENTS: contrat.EVENTS, DELAI_DEFAUT_MS };
}

module.exports = { creerBus, versionDe, serialiser, DELAI_DEFAUT_MS };
