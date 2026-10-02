'use strict';
/* LA VEILLE DES BUILDS LANCÉS D'ICI — ce que le serveur regarde pendant que l'écran regarde
 * ailleurs. Un build lancé depuis Mergerie n'était vu finir que si l'onglet Jenkins restait
 * ouvert, parce que c'est le NAVIGATEUR qui interrogeait Jenkins. Or on lance un build
 * précisément pour aller faire autre chose. Le serveur attend donc, et pousse un fait.
 *
 * Trois règles :
 *   1. On ne sonde QUE ce qu'on attend. Sans lancement en cours, aucun appel n'est fait à
 *      Jenkins — un outil local n'a pas à marteler le CI de l'équipe.
 *   2. Une transition, jamais un état : c'est l'APPARITION d'un build terminé, de numéro
 *      strictement plus grand que celui connu au lancement, qui fait l'événement.
 *   3. Ce qui n'aboutit pas s'oublie : un build qui ne revient jamais (job supprimé, Jenkins
 *      éteint) sort de la liste au bout de six heures plutôt que d'y sonder sans fin.
 *
 * L'état vit dans ce module (en mémoire : un redémarrage oublie l'attente, le bon compromis
 * pour une liste qui se vide d'elle-même en quelques minutes). `configurer` reçoit le client
 * et le ctx ; les tests remplacent `client.detail` sur l'objet exposé ici. */

const OUBLI_MS = 6 * 3600 * 1000;   // au-delà, un lancement attendu est considéré perdu
const MAX_ATTENTES = 20;            // borne de sécurité : autant d'appels Jenkins par tour

const attentes = new Map();         // chemin du job → { depuis: numéro connu au lancement, at }
const etat = { client: null, ctx: null, cfg: () => ({}) };

function configurer({ client, ctx, cfg }) {
  etat.client = client; etat.ctx = ctx; etat.cfg = cfg;
  module.exports.client = client;
}

function attendreJenkins(chemin, depuis) {
  const p = String(chemin || '').trim();
  if (!p) return;
  if (attentes.size >= MAX_ATTENTES && !attentes.has(p)) return;
  attentes.set(p, { depuis: Number(depuis) || 0, at: Date.now() });
}
const attendus = () => [...attentes.keys()];

async function tourJenkins(cfg) {
  const client = module.exports.client;
  if (!attentes.size || !client || !client.isConfigured(cfg)) return 0;
  let finis = 0;
  for (const [chemin, a] of [...attentes]) {
    if (Date.now() - a.at > OUBLI_MS) { attentes.delete(chemin); continue; }
    let d;
    try { d = await client.detail(cfg, chemin, 1); }
    catch { continue; } // Jenkins injoignable : on retentera au tour suivant, sans rien dire
    const b = (d.builds || [])[0];
    if (!b || !b.number || b.number <= a.depuis || b.building) continue;
    attentes.delete(chemin);
    finis += 1;
    const fait = { path: chemin, number: b.number, result: b.result || 'UNKNOWN', ok: b.result === 'SUCCESS' };
    if (etat.ctx) {
      etat.ctx.notify.push('jenkins_done', fait);
      etat.ctx.events.emit('jenkins.job.finished', fait).catch(() => {});
    }
  }
  return finis;
}

// Remise à zéro (tests, désactivation) : la veille garde de l'état entre deux tours, par construction.
function oublierTout() { attentes.clear(); }

module.exports = { configurer, attendreJenkins, attendus, tourJenkins, oublierTout, OUBLI_MS, client: null };
