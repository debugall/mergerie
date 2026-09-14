'use strict';
/* CE QUI N'APPARTIENT QU'À CETTE MACHINE — deux tables, une seule mécanique.
 *
 * Quand le travail accumulé part dans un dépôt git d'équipe, certaines colonnes ne peuvent pas
 * suivre. Pas parce qu'elles sont secrètes : parce qu'elles ne VEULENT RIEN DIRE ailleurs.
 *
 *   `local_state` — de l'état DÉRIVÉ, propre à ce poste. Quand cet agent planifié a tourné ICI ;
 *                   quand ce ticket Jira a été relu ICI, et avec quelle erreur réseau. Effacer
 *                   cette table ne perd rien : tout se recalcule au tour suivant.
 *   `local_pref`  — une PRÉFÉRENCE d'affichage, propre à ce poste. Une session rangée l'est chez
 *                   soi ; la supprimer, en revanche, la supprime pour tout le monde. Effacer
 *                   cette table perd un rangement, pas une donnée.
 *
 * Deux tables de même forme, et c'est voulu : leurs durées de vie diffèrent, et le nom de la
 * table le dit à chaque point d'appel. On peut vider `local_state` sans prévenir personne ; pas
 * `local_pref`.
 *
 * PAS DE CLÉ ÉTRANGÈRE. Une ligne d'ici peut se rattacher à une `task`, une `question`, un
 * `agent`, un ticket Jira : quatre parents possibles, donc aucune contrainte ne peut les couvrir
 * — c'est déjà le cas d'`agent_pass` et de `piece_jointe`, pour la même raison. Le ménage est
 * donc EXPLICITE, par `oublier()`, appelé là où le parent disparaît.
 *
 * La référence est l'`uid` du parent quand il en a un, sa clé naturelle sinon (la clé du ticket
 * pour un `jira_watch`). Jamais l'`id` entier : il ne survit pas au partage, et une ligne
 * d'ici survivrait alors au mauvais parent après une réhydratation.
 */
const db = require('./db');

function tableau(table) {
  const get = db.prepare(`SELECT value FROM ${table} WHERE kind = ? AND ref = ? AND key = ?`);
  const set = db.prepare(`INSERT INTO ${table} (kind, ref, key, value, updated_at)
                          VALUES (@kind, @ref, @key, @value, @updated_at)
                          ON CONFLICT (kind, ref, key)
                          DO UPDATE SET value = @value, updated_at = @updated_at`);
  const del = db.prepare(`DELETE FROM ${table} WHERE kind = ? AND ref = ? AND key = ?`);
  const delTout = db.prepare(`DELETE FROM ${table} WHERE kind = ? AND ref = ?`);
  const parCle = db.prepare(`SELECT ref, value FROM ${table} WHERE kind = ? AND key = ?`);

  return {
    /** La valeur, ou `null`. Jamais `undefined` : un appelant ne doit pas avoir à distinguer. */
    lire(kind, ref, key) {
      if (!ref) return null;
      const r = get.get(kind, String(ref), key);
      return r ? r.value : null;
    },
    /** Écrit — ou EFFACE si la valeur est `null`/`undefined`, pour ne pas garder de ligne vide. */
    ecrire(kind, ref, key, value) {
      if (!ref) return;
      if (value === null || value === undefined) { del.run(kind, String(ref), key); return; }
      set.run({
        kind, ref: String(ref), key, value: String(value), updated_at: new Date().toISOString(),
      });
    },
    /** Tout ce qui est rangé sous ce parent — à appeler quand le parent disparaît. */
    oublier(kind, ref) { if (ref) delTout.run(kind, String(ref)); },
    /** `ref -> value` pour une clé donnée : une seule requête là où l'on afficherait une liste. */
    carte(kind, key) {
      const m = new Map();
      for (const r of parCle.all(kind, key)) m.set(r.ref, r.value);
      return m;
    },
    /** Le booléen d'une préférence, avec son défaut. `'1'` = vrai, tout le reste = faux. */
    drapeau(kind, ref, key) { return this.lire(kind, ref, key) === '1'; },
  };
}

/* Construits à l'import : les deux tables existent dès `db.js`, et une construction paresseuse
   n'apporterait qu'un `if` à chaque appel. */
module.exports = { etat: tableau('local_state'), pref: tableau('local_pref') };
