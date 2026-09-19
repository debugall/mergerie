'use strict';
/* Parallélisme BORNÉ : `limit` tâches en vol, pas une de plus.
 *
 * `Promise.all` sur une liste entière part en rafale — vingt dépôts × plusieurs pages, c'est
 * un pic de requêtes qu'une forge accueille par un 429, et une machine par du swap. Un `for`
 * séquentiel, à l'inverse, additionne les latences : vingt fois 300 ms de trajet réseau se
 * paient en secondes d'écran figé. Ce module tient le milieu.
 *
 * L'ordre des RÉSULTATS suit celui des entrées, même si les tâches finissent dans le désordre :
 * les appelants indexent leur sortie sur leur entrée.
 */
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return out;
}

module.exports = { pMap };
