'use strict';
/* UN SUIVI NE PART QUE PARCE QU'ON L'A DÉCIDÉ — au clic, ou en armant la case.
 *
 * Le suivi s'écrit pendant que la session travaille : à la seconde où la remarque vient, pas
 * une fois la session finie. Il attend donc, parfois longtemps, sur un dépôt qui bouge. C'est
 * pourquoi il ne part pas tout seul par défaut : un envoi automatique est un CHOIX, coché en
 * écrivant le texte, jamais un effet de bord.
 *
 * Le comportement est éprouvé de bout en bout (`e2e-session-followup-draft`). Ce test-ci ferme
 * la porte pour la suite : la colonne n'est lue QU'À L'ENDROIT QUI DÉCIDE D'ENVOYER. Ailleurs
 * dans la chaîne — et surtout dans les modules qui parlent à l'agent — la lire, c'est déjà
 * pouvoir la faire partir, ou pire, la glisser dans un prompt.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

describe('le suivi en attente ne part pas tout seul', () => {
  test('aucun module parlant à l’agent ne connaît la colonne', () => {
    const fautifs = [];
    for (const f of ['taskrunner.js', 'localcoder.js', 'converge.js', 'copilot.js']) {
      lire(f).split('\n').forEach((ligne, i) => {
        if (/followup_(draft|auto)/.test(ligne)) fautifs.push(`src/${f}:${i + 1}  ${ligne.trim()}`);
      });
    }
    assert.deepEqual(fautifs, [],
      'ces modules construisent ce qui part à l’agent : un suivi en attente n’a rien à y faire');
  });

  /* `jobs.js` est le seul module de la chaîne autorisé à lire la colonne, parce que c'est lui
     qui enchaîne la fin d'une session. Encore faut-il qu'il ne la lise QUE là : une lecture
     ailleurs dans le fichier serait un second chemin d'envoi, qui n'aurait pas la garde de la
     case ni le retrait du texte avant lancement. */
  test('dans jobs.js, elle n’est lue que par la fonction qui décide de l’envoi', () => {
    const src = lire('jobs.js');
    const debut = src.indexOf('function suiviAutomatique(');
    assert.ok(debut > 0, 'la fonction d’envoi automatique doit exister sous ce nom');
    const fin = src.indexOf('\n}', debut);
    const dedans = src.slice(debut, fin);

    const dehors = [];
    src.split('\n').forEach((ligne, i) => {
      if (!/followup_(draft|auto)/.test(ligne)) return;
      if (!dedans.includes(ligne)) dehors.push(`src/jobs.js:${i + 1}  ${ligne.trim()}`);
    });
    assert.deepEqual(dehors, [],
      'un second chemin d’envoi n’aurait ni la garde de la case ni le retrait du texte : il bouclerait');

    // Et cette fonction refuse d'envoyer tant que la case n'est pas armée.
    assert.match(dedans, /if \(!s \|\| !s\.a \|\| !s\.d\) return null;/,
      'sans case armée et sans texte, rien ne part');
    assert.match(dedans, /SET followup_draft = NULL, followup_auto = 0/,
      'le texte est retiré AVANT le lancement : sinon la passe suivante le retrouve et la session boucle');
  });
});
