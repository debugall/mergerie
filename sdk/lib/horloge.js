'use strict';
/* LES TÂCHES PÉRIODIQUES DES PLUGINS, centralisées. Un plugin ne pose jamais son propre
   `setInterval` : il demande une cadence, et c'est ici qu'elle vit — ce qui permet de tout
   arrêter à sa désactivation ou à l'arrêt du serveur, de ne jamais faire se recouvrir deux
   tours d'une même tâche, et de respecter le mode démo (où rien de ce qui sonde l'extérieur ne
   tourne, sauf demande explicite `inDemo`). Les timers sont `unref` : ils ne retiennent pas le
   processus, exactement comme la veille du cœur. Instanciable : le SDK de test en crée une
   qu'il avance à la main (`tick`). */

function creer({ log } = {}) {
  let seq = 0;
  const taches = new Map();
  let enMarche = false;
  let demo = false;
  const journal = typeof log === 'function' ? log : (m) => console.error(m);

  async function tour(id) {
    const t = taches.get(id);
    if (!t || t.busy) return false;
    t.busy = true;
    try { await t.fn(); return true; }
    catch (e) { journal(`[plugins] ${t.owner} : tâche périodique — ${(e && e.message) || e}`); return false; }
    finally { t.busy = false; }
  }
  function lancerTimer(id) {
    const t = taches.get(id);
    if (!t || t.timer || !enMarche) return;
    if (demo && !t.inDemo) return;
    t.timer = setInterval(() => { tour(id); }, t.ms);
    if (t.timer.unref) t.timer.unref();
    if (t.immediate) setImmediate(() => { tour(id); });
  }
  function planifier(owner, ms, fn, { immediate = false, inDemo = false } = {}) {
    const periode = Number(ms);
    if (!Number.isFinite(periode) || periode < 1000) throw new Error(`${owner} : schedule — intervalle ≥ 1000 ms requis`);
    if (typeof fn !== 'function') throw new Error(`${owner} : schedule(ms, fn) — fonction requise`);
    seq += 1;
    taches.set(seq, { owner, ms: periode, fn, timer: null, busy: false, inDemo: !!inDemo, immediate: !!immediate });
    lancerTimer(seq);
    return seq;
  }
  function deplanifier(id) {
    const t = taches.get(id);
    if (!t) return false;
    if (t.timer) clearInterval(t.timer);
    taches.delete(id);
    return true;
  }
  function arreterTout(owner) {
    let n = 0;
    for (const [id, t] of [...taches]) if (t.owner === owner) { deplanifier(id); n += 1; }
    return n;
  }
  function demarrer({ demo: enDemo = false } = {}) { enMarche = true; demo = !!enDemo; for (const id of taches.keys()) lancerTimer(id); }
  function arreter() { enMarche = false; for (const t of taches.values()) { if (t.timer) clearInterval(t.timer); t.timer = null; } }
  const tachesDe = (owner) => [...taches.entries()].filter(([, t]) => t.owner === owner).map(([id, t]) => ({ id, ms: t.ms, active: !!t.timer }));
  /** Avance à la main : joue toutes les tâches d'un propriétaire (ou toutes), une fois. Pour les tests. */
  async function tick(owner) {
    let n = 0;
    for (const [id, t] of [...taches]) if (!owner || t.owner === owner) { if (await tour(id)) n += 1; }
    return n;
  }
  function reset() { arreter(); taches.clear(); seq = 0; demo = false; }

  return { planifier, deplanifier, arreterTout, demarrer, arreter, tachesDe, tick, reset };
}

module.exports = { creer };
