'use strict';
/* Le libellé d'une session NE PART PAS À L'IA.
 *
 * C'est un titre de rangement, écrit pour l'humain qui parcourt la liste — pas une consigne.
 * Le glisser dans le prompt changerait ce que l'agent produit sans que personne ne l'ait demandé,
 * et deux sessions au même prompt mais au libellé différent ne rendraient plus la même chose.
 * Il ne devient pas non plus le message de commit : celui-ci a son propre champ, et à défaut la
 * première ligne du prompt.
 *
 * Un test de source complète le contrôle : le jour où quelqu'un ajoute `task.label` dans un
 * module qui parle à l'agent, il tombe — même si le prompt continue de passer les cas ci-dessous.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const taskrunner = require('../src/taskrunner');

const LIBELLE = 'ZZTITREDERANGEMENTZZ';

describe('le libellé d’une session reste un titre', () => {
  test('il n’entre pas dans le prompt envoyé à l’agent', () => {
    const prompt = taskrunner.buildCodePrompt({
      label: LIBELLE, prompt: 'Ajoute un endpoint /health', ask_questions: 0,
    });
    assert.ok(prompt.includes('Ajoute un endpoint /health'), 'le prompt, lui, y est bien');
    assert.ok(!prompt.includes(LIBELLE),
      `le libellé ne doit pas partir à l’agent, vu : ${prompt}`);
  });

  test('il ne devient pas le message de commit', () => {
    assert.equal(
      taskrunner.commitMessageFor({ label: LIBELLE, prompt: 'Ajoute un endpoint /health' }),
      'Ajoute un endpoint /health',
      'à défaut de message explicite, c’est la première ligne du PROMPT qui sert',
    );
    assert.equal(
      taskrunner.commitMessageFor({ label: LIBELLE, prompt: 'p', commit_message: 'feat: santé' }),
      'feat: santé',
    );
  });

  /* Le garde de source. Les cas ci-dessus prouvent l'état actuel ; celui-ci empêche qu'un
     module se mette à lire le libellé pour le glisser ailleurs dans la conversation. */
  test('aucun module parlant à l’agent ne lit le libellé', () => {
    const fautifs = [];
    for (const f of ['taskrunner.js', 'localcoder.js', 'converge.js', 'copilot.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
      src.split('\n').forEach((ligne, i) => {
        if (/\b(task|t|lt)\.label\b/.test(ligne)) fautifs.push(`src/${f}:${i + 1}  ${ligne.trim()}`);
      });
    }
    assert.deepEqual(fautifs, [],
      'le libellé est un titre de rangement : il n’a rien à faire dans ce qui part à l’agent');
  });
});
