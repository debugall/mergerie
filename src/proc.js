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

/* ARRÊTER UN PROCESSUS, C'EST ARRÊTER TOUT CE QU'IL A LANCÉ. Tuer l'enfant direct laissait ses
   propres enfants tourner : un `npm test` qui lance jest, un agent qui lance un serveur de dev, un
   `sh -c 'sleep 600 & wait'`. « Stop » disait « arrêté », et la machine continuait de travailler.
   Chaque enfant est donc lancé chef de son propre GROUPE de processus (`detached` sous POSIX), et
   on tue le groupe entier. Sous Windows, `detached` ouvrirait une console par commande : on s'en
   passe, et on tue l'enfant seul comme avant. */
const POSIX = process.platform !== 'win32';
const options = (opts = {}) => (POSIX ? { ...opts, detached: true } : { ...opts });
const vivants = new Set();

function tuerGroupe(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (POSIX && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* groupe déjà parti : on vise l'enfant */ }
  }
  try { child.kill(signal); } catch { /* déjà mort */ }
}

/* Tout enfant rendu « actif » est suivi jusqu'à sa fin : c'est ce qui permet, à l'arrêt du
   serveur, de ne laisser aucun groupe orphelin. */
function suivre(child) {
  if (!child || vivants.has(child)) return;
  vivants.add(child);
  child.once('exit', () => vivants.delete(child));
}

function setActive(child) { suivre(child); ctx().activeChild = child; }
function clearActive(child) { const c = ctx(); if (c.activeChild === child) c.activeChild = null; }
function isCancelled() { return ctx().cancelled; }

// `c` explicite : celui qui annule (le serveur) n'est pas dans le contexte à annuler.
function cancel(c) {
  const target = c || ctx();
  target.cancelled = true;
  const child = target.activeChild;
  if (child) {
    tuerGroupe(child, 'SIGTERM');
    // si le groupe résiste, on force après 2s
    setTimeout(() => tuerGroupe(child, 'SIGKILL'), 2000);
  }
}

/** À l'arrêt du serveur : aucun groupe ne doit survivre à celui qui l'a lancé. */
function tuerTout(signal = 'SIGTERM') {
  for (const child of vivants) tuerGroupe(child, signal);
}

// Rétablit le contexte ambiant (hors job). Conservé pour les tests et les cas de secours :
// un contexte ambiant annulé ferait échouer à tort les opérations git lancées d'un écran.
function reset() { ambient.cancelled = false; ambient.activeChild = null; }

module.exports = { run, setActive, clearActive, isCancelled, cancel, reset, options, suivre, tuerGroupe, tuerTout };
