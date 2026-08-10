'use strict';
/* UN SUIVI NE PART QUE PARCE QU'ON L'A ENVOYÉ.
 *
 * Le suivi s'écrit pendant que la session travaille : à la seconde où la remarque vient, pas
 * une fois la session finie. Il attend donc — parfois longtemps, sur un dépôt qui bouge.
 * Le déclencher à la fin d'une session, « puisqu'il est là », relancerait l'agent sur une
 * consigne écrite pour un état du code qui n'existe plus, sans que personne ne regarde.
 *
 * Le test de bout en bout prouve qu'aujourd'hui rien ne le déclenche (`e2e-session-followup-
 * draft`). Celui-ci ferme la porte pour la suite : aucun module de la chaîne d'exécution ne
 * doit seulement CONNAÎTRE cette colonne — la lire, c'est déjà pouvoir l'envoyer.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('le suivi en attente ne s’envoie pas tout seul', () => {
  test('aucun module d’exécution ne lit la colonne', () => {
    const fautifs = [];
    for (const f of ['jobs.js', 'taskrunner.js', 'localcoder.js', 'converge.js', 'copilot.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
      src.split('\n').forEach((ligne, i) => {
        if (/followup_draft/.test(ligne)) fautifs.push(`src/${f}:${i + 1}  ${ligne.trim()}`);
      });
    }
    assert.deepEqual(fautifs, [],
      'le suivi n’appartient qu’aux routes d’envoi manuel : personne d’autre n’a à le connaître');
  });
});
