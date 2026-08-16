'use strict';
/* LE JEU JENKINS DE DÉMO NE DOIT PAS SE VIDER À MINUIT.
 *
 * Ses exécutions sont datées en relatif (« il y a 4 minutes »). La pastille du menu, elle,
 * compte les jobs qui ont tourné AUJOURD'HUI. Passé minuit, la plus récente retombait donc la
 * veille, la pastille se masquait, et la démo ne savait plus produire l'écran qu'on commente :
 * un enregistrement commencé à 23 h 50 et terminé à 0 h 10 montrait deux états différents pour
 * la même phrase — c'est exactement comme ça que le bogue a été découvert.
 *
 * Le test fige l'horloge à des heures choisies : juste après minuit, où le décalage doit
 * s'appliquer, et en pleine journée, où il ne doit RIEN changer.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const demo = require('../src/demo-jenkins');

const minuitDe = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* Fige l'horloge, appelle, relâche. `lister()` reconstruit ses dates à chaque appel : c'est ce
   qui rend ce test possible sans jouer avec le cache de `require`, et c'est aussi ce qui
   protège un serveur de démo resté ouvert depuis la veille. */
function a(heure, minute, fn) {
  const d = new Date(); d.setHours(heure, minute, 0, 0);
  const vraiNow = Date.now;
  Date.now = () => d.getTime();
  try { return fn(d.getTime()); } finally { Date.now = vraiNow; }
}

describe('Démo Jenkins : des jobs du jour à toute heure', () => {
  test('à 0 h 07, au moins un job a tourné « aujourd’hui »', () => {
    a(0, 7, (maintenant) => {
      const jobs = demo.lister().jobs || demo.lister();
      const duJour = jobs.filter((j) => j.last && j.last >= minuitDe(maintenant));
      assert.ok(duJour.length >= 1,
        'sans job du jour, la pastille disparaît et la démo ne sait plus montrer ce qu’on raconte');
      for (const j of duJour) {
        assert.ok(j.last <= maintenant, `« ${j.name} » a tourné dans le futur`);
      }
    });
  });

  test('en pleine journée, les dates ne sont pas décalées', () => {
    a(15, 30, (maintenant) => {
      const jobs = demo.lister().jobs || demo.lister();
      const frais = jobs.find((j) => j.name === 'nightly-import');
      // `age: 4` → quatre minutes avant l'instant courant, à la seconde près.
      const ecart = Math.abs((maintenant - 4 * 60000) - frais.last);
      assert.ok(ecart < 2000,
        `hors du voisinage de minuit, aucun décalage ne doit s’appliquer (écart ${ecart} ms)`);
    });
  });

  test('les exécutions restent ordonnées de la plus récente à la plus ancienne', () => {
    a(0, 3, () => {
      const jobs = (demo.lister().jobs || demo.lister()).filter((j) => j.last);
      for (let i = 1; i < jobs.length; i += 1) {
        assert.ok(jobs[i - 1].last >= jobs[i].last,
          'la liste est triée par date : un décalage appliqué de travers casserait cet ordre');
      }
    });
  });
});
