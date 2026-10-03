'use strict';
/* Le `job` que reçoit le runner d'un plugin : de quoi écrire dans le journal, dire où l'on en est, lancer une commande dont la sortie
   va au journal, et savoir si « Stop » a été demandé. Bâti ICI, une fois, depuis des fournisseurs : le cœur donne le journal de la
   file (base) et l'arrêt par groupe de processus, le SDK de test un journal en mémoire. */
const { flux } = require('./exec');

/**
 * @param {string} plugin
 * @param {{ id: number, log(text: string): void, message(text: string): void, progress(done: number, total: number): void, estAnnule(): boolean, exec?: object }} f
 */
function creerJob(plugin, f) {
  return Object.freeze({
    id: f.id,
    log: (texte) => f.log(String(texte)),
    message: (texte) => f.message(String(texte)),
    progress: (done, total) => f.progress(Number(done) || 0, Number(total) || 0),
    isCancelled: () => !!f.estAnnule(),
    /* La sortie (stdout et stderr, ligne à ligne) va au journal du job ; rend `{ code, tail }` — `tail` : les dernières lignes, pour dire POURQUOI
       dans le message d'erreur du job. Le « Stop » du job tue le groupe de processus. */
    exec: (bin, args, options = {}) => {
      const fin = [];
      return flux(plugin, bin, args, options, (_flux, ligne) => { f.log(ligne); fin.push(ligne); if (fin.length > 20) fin.shift(); }, { ...(f.exec || {}), suivre: (f.exec || {}).suivreJob || (f.exec || {}).suivre })
        .fini.then((r) => ({ ...r, tail: fin.join('\n').slice(-1500) }));
    },
  });
}

module.exports = { creerJob };
