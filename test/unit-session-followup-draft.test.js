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

const { lireSource: lire, lireDossier } = require('./helpers/sources');

describe('le suivi en attente ne part pas tout seul', () => {
  test('aucun module parlant à l’agent ne connaît la colonne', () => {
    const fautifs = [];
    for (const f of ['session/taskrunner', 'session/localcoder', 'review/converge', 'agent/copilot']) {
      lire(f).split('\n').forEach((ligne, i) => {
        if (/followup_(draft|auto)/.test(ligne)) fautifs.push(`src/${f}:${i + 1}  ${ligne.trim()}`);
      });
    }
    assert.deepEqual(fautifs, [],
      'ces modules construisent ce qui part à l’agent : un suivi en attente n’a rien à y faire');
  });

  /* `jobs/` est le seul module de la chaîne autorisé à lire la colonne, parce que c'est lui
     qui enchaîne la fin d'une session. Encore faut-il qu'il ne la lise QUE là : une lecture
     ailleurs dans le dossier serait un second chemin d'envoi, qui n'aurait pas la garde de la
     case ni le retrait du texte avant lancement. */
  test('dans jobs/, elle n’est lue que par la fonction qui décide de l’envoi', () => {
    const src = lireDossier('jobs');
    const debut = src.indexOf('function envoyerSuiviEnAttente(');
    assert.ok(debut > 0, 'la fonction d’envoi du suivi en attente doit exister sous ce nom');
    const fin = src.indexOf('\n}', debut);
    const dedans = src.slice(debut, fin);

    const dehors = [];
    src.split('\n').forEach((ligne, i) => {
      if (!/followup_(draft|auto)/.test(ligne)) return;
      if (!dedans.includes(ligne)) dehors.push(`src/jobs/ (ligne ${i + 1} du dossier concaténé)  ${ligne.trim()}`);
    });
    assert.deepEqual(dehors, [],
      'un second chemin d’envoi n’aurait ni la garde de la case ni le retrait du texte : il bouclerait');

    // Et cette fonction refuse d'envoyer tant que la case n'est pas armée — sauf si l'appelant
    // porte un autre armement (la DATE programmée), et il doit le dire.
    assert.match(dedans, /if \(!s \|\| !s\.d \|\| \(exigerCase && !s\.a\)\) return null;/,
      'sans texte rien ne part ; sans case armée non plus, à moins que l’appelant ne passe outre explicitement');
    assert.match(dedans, /SET followup_draft = NULL, followup_auto = 0/,
      'le texte est retiré AVANT le lancement : sinon la passe suivante le retrouve et la session boucle');
    // La fin de session, elle, exige la case.
    assert.match(src, /const suiviAutomatique = \(scope, id, onLog\) => envoyerSuiviEnAttente\(scope, id, onLog, \{ exigerCase: true \}\);/);
  });

  /* LA DATE PROGRAMMÉE est le SEUL autre armement : un suivi part à la fin de la session (case) ou
     à sa date, jamais parce qu'un troisième chemin l'a trouvé. Passer outre la case ne se fait
     qu'à un endroit, et c'est celui qui efface la date avant de lancer. */
  test('seule la programmation à une date passe outre la case', () => {
    const src = lireDossier('jobs');
    const occurrences = src.split('exigerCase: false').length - 1;
    assert.equal(occurrences, 1, 'un seul appel qui n’exige pas la case');
    assert.ok(lire('jobs/programmation').includes('exigerCase: false'), 'et c’est celui de la date programmée');
  });
});
