'use strict';
/* LES VARIABLES D'ENVIRONNEMENT D'UN VÉRIFICATEUR : LES NOMS SONT D'ÉQUIPE, LES VALEURS NON.
 *
 * Une variable de commande de test est le lieu naturel d'un `DATABASE_URL`, d'un `NPM_TOKEN`, de
 * la clé d'API d'un bac à sable. La liste noire du registre ne regarde que le NOM DE COLONNE —
 * `env_json` n'y ressemble pas — donc rien ne l'arrêtait, et un secret commité dans git est
 * définitif : l'historique est immuable, chaque clone le garde, la forge le garde. Le retirer ne
 * suffit pas, il faut révoquer.
 *
 * Le vérificateur reste un produit d'équipe : ses commandes, sa couverture, ses options. On
 * partage donc les NOMS des variables qu'il attend (`env_keys`), pour que le collègue sache quoi
 * renseigner, et on garde les VALEURS ici — une ligne de `local_state` par variable, sur le poste
 * qui l'a saisie.
 */
const { etat } = require('../data/localstate');

const KIND = 'verifier_env';

/** Les noms attendus par ce vérificateur, tels que l'équipe les a déclarés. */
function noms(verifier) {
  if (!verifier) return [];
  try {
    const l = JSON.parse(verifier.env_keys || '[]');
    return Array.isArray(l) ? l.map((x) => String(x)).filter(Boolean) : [];
  } catch { return []; }
}

/** Les valeurs connues SUR CE POSTE : `{ NOM: valeur }`, jamais un secret venu d'ailleurs. */
function valeurs(verifier) {
  if (!verifier || !verifier.uid) return {};
  return Object.fromEntries(etat.sous(KIND, verifier.uid));
}

/** Ce qui manque ici pour que ce vérificateur tourne : les noms sans valeur. */
function manquantes(verifier) {
  const connues = valeurs(verifier);
  return noms(verifier).filter((n) => !String(connues[n] || '').length);
}

/**
 * Remplace TOUTES les valeurs de ce poste par celles fournies. Remplacer plutôt que fusionner :
 * le formulaire montre la liste entière, en retirer une ligne doit retirer la variable.
 * @returns {string} le JSON des noms, à ranger dans `verifier.env_keys`
 */
function poser(uid, paires) {
  if (!uid) return '[]';
  for (const cle of etat.sous(KIND, uid).keys()) etat.ecrire(KIND, uid, cle, null);
  const nomsPoses = [];
  for (const [k, v] of Object.entries(paires || {})) {
    if (!k) continue;
    nomsPoses.push(k);
    etat.ecrire(KIND, uid, k, String(v == null ? '' : v));
  }
  return JSON.stringify(nomsPoses);
}

/** Le vérificateur disparaît : ses valeurs n'ont plus de parent. */
const oublier = (uid) => { if (uid) etat.oublier(KIND, uid); };

module.exports = { KIND, noms, valeurs, manquantes, poser, oublier };
