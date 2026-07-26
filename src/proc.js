'use strict';
// Suivi du process enfant courant + drapeau d'annulation, pour pouvoir
// stopper un job en cours (tue git/copilot et interrompt la boucle).

let activeChild = null;
let cancelled = false;

function setActive(child) { activeChild = child; }
function clearActive(child) { if (activeChild === child) activeChild = null; }
function isCancelled() { return cancelled; }

function requestCancel() {
  cancelled = true;
  const c = activeChild;
  if (c) {
    try { c.kill('SIGTERM'); } catch { /* déjà mort */ }
    // si le process résiste, on force après 2s
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ok */ } }, 2000);
  }
}

// À appeler au démarrage d'un nouveau job.
function reset() { cancelled = false; activeChild = null; }

module.exports = { setActive, clearActive, isCancelled, requestCancel, reset };
