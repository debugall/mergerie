'use strict';
/* Suivi du process enfant courant + drapeau d'annulation, pour pouvoir stopper un job en
   cours (tue git/copilot et interrompt la boucle).

   L'état est PAR JOB, et non global. Tant qu'un seul job tournait, un booléen de module
   suffisait ; dès que deux jobs tournent en parallèle il devient faux : « Stop » sur l'un
   arrêterait l'autre, et le second job écraserait le process enfant du premier — donc le
   Stop tuerait le mauvais.

   Le contexte est porté par un `AsyncLocalStorage` plutôt que passé en paramètre : les
   appels à `proc.*` sont répartis jusqu'au fond de `git.run` et `copilot.runPrompt`, et
   leur ajouter un argument aurait contaminé toutes les signatures intermédiaires. Ici,
   `jobs.pump` enveloppe l'exécution d'un job et tout ce qui s'y déroule — y compris après
   un `await` — retrouve SON contexte sans le savoir.

   Hors job (explorateur de branches, find-ref, tag-author…), il n'y a pas de contexte : on
   retombe sur un contexte AMBIANT qui n'est jamais annulé. C'est ce que faisait déjà le
   `proc.reset()` de fin de file, en moins fragile. */

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const newCtx = () => ({ cancelled: false, activeChild: null });
const ambient = newCtx();          // hors job : jamais annulé
const ctx = () => als.getStore() || ambient;

/* Exécute `fn` dans un contexte d'annulation neuf. Renvoie le contexte (pour l'annuler
   plus tard, depuis le serveur) et la promesse du travail. */
function run(fn) {
  const c = newCtx();
  return { ctx: c, done: als.run(c, fn) };
}

function setActive(child) { ctx().activeChild = child; }
function clearActive(child) { const c = ctx(); if (c.activeChild === child) c.activeChild = null; }
function isCancelled() { return ctx().cancelled; }

// `c` explicite : celui qui annule (le serveur) n'est pas dans le contexte à annuler.
function cancel(c) {
  const target = c || ctx();
  target.cancelled = true;
  const child = target.activeChild;
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* déjà mort */ }
    // si le process résiste, on force après 2s
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 2000);
  }
}

// Rétablit le contexte ambiant (hors job). Conservé pour les tests et les cas de secours :
// un contexte ambiant annulé ferait échouer à tort les opérations git lancées d'un écran.
function reset() { ambient.cancelled = false; ambient.activeChild = null; }

module.exports = { run, setActive, clearActive, isCancelled, cancel, reset };
