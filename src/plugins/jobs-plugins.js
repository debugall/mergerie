'use strict';
/* LES GENRES DE JOB QUE LES PLUGINS ONT INSCRIT. La file de jobs est au-dessus de ce dossier (`jobs/` importe `plugins/`, pas
   l'inverse) : le démarreur, qui crée la ligne en base et met l'entrée dans la file, est donc INJECTÉ par `jobs/runners/plugin.js`
   au chargement, et le ctx ne voit que ces deux fonctions. */
const runners = new Map();      // « plugin:genre » → { plugin, kind, runner, exec }
let demarreur = null;

const cle = (plugin, kind) => `${plugin}:${kind}`;
function brancher(fn) { demarreur = fn; }
function inscrire(plugin, kind, runner, exec) { runners.set(cle(plugin, kind), { plugin, kind, runner, exec }); }
function demarrer(plugin, kind, payload, options) {
  if (!runners.has(cle(plugin, kind))) throw new Error(`${plugin} : jobs.start('${kind}') — genre non inscrit (jobs.register)`);
  if (!demarreur) throw new Error('la file de jobs n’est pas démarrée');
  return demarreur(plugin, kind, payload, options || {});
}
/* Les jobs en cours : un plugin tiers pilote le sien, op par op, par l'identifiant. */
const enCours = new Map();
const lier = (id, job) => enCours.set(Number(id), job);
const delier = (id) => enCours.delete(Number(id));
const actif = (id) => enCours.get(Number(id)) || null;
const trouver = (plugin, kind) => runners.get(cle(plugin, kind)) || null;
function oublier(plugin) { for (const [k, r] of [...runners]) if (r.plugin === plugin) runners.delete(k); }

module.exports = { brancher, inscrire, demarrer, trouver, oublier, lier, delier, actif };
