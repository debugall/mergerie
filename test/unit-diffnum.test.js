'use strict';
/* NUMÉROTER LE DIFF DONNÉ À L'IA.
 *
 * Un rapport de review cite « src/foo.js ligne 137 ». Ce numéro doit tomber sur la ligne que
 * l'écran affiche à droite, sinon le lecteur suit une piste fausse — et doute ensuite du
 * rapport entier pour un chiffre. Or l'IA ne reçoit qu'un patch : les numéros n'y vivent que
 * dans les en-têtes `@@`, tout le reste est à recompter à la main.
 *
 * Ce fichier surveille le comptage qu'on fait à sa place. Trois choses cassent en silence :
 *   1. le décalage après une ligne SUPPRIMÉE (elle n'existe pas dans la version finale) ;
 *   2. la remise à zéro à chaque hunk et à chaque FICHIER ;
 *   3. les lignes qui ne sont pas du contenu (en-têtes, « \ No newline ») comptées par erreur.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { annoterDiff, MAX_LIGNES } = require('../src/diffnum');

const numeroDe = (vue, motif) => {
  const l = vue.split('\n').find((x) => x.includes(motif));
  const m = l && /^\s*(\d+) /.exec(l);
  return m ? Number(m[1]) : null;
};

describe('Diff numéroté pour la review', () => {
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    'index 1111111..2222222 100644',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -28,4 +28,5 @@ function x() {',
    '   const a = 1;',
    '+  const b = 2;',
    '-  const c = 3;',
    '   return a;',
    '@@ -80,2 +81,3 @@ function y() {',
    '   const d = 4;',
    '+  const e = 5;',
  ].join('\n');

  test('chaque ligne porte son numéro dans la version FINALE', () => {
    const vue = annoterDiff(diff);
    assert.equal(numeroDe(vue, 'const a = 1'), 28);
    assert.equal(numeroDe(vue, 'const b = 2'), 29, 'la ligne ajoutée suit le contexte');
    /* La ligne SUPPRIMÉE n'existe pas dans la version finale : elle n'a pas de numéro, et
       surtout elle n'en consomme pas — c'est là que le décalage se glisse. */
    assert.equal(numeroDe(vue, 'const c = 3'), null, 'une ligne supprimée n’est pas numérotée');
    assert.equal(numeroDe(vue, 'return a'), 30, 'et la suivante ne saute pas un numéro');
  });

  test('chaque hunk repart de l’en-tête @@, pas du compteur précédent', () => {
    const vue = annoterDiff(diff);
    assert.equal(numeroDe(vue, 'const d = 4'), 81);
    assert.equal(numeroDe(vue, 'const e = 5'), 82);
  });

  test('chaque fichier est annoncé et repart de ses propres numéros', () => {
    const deux = `${diff}\n${[
      'diff --git a/src/bar.js b/src/bar.js',
      '--- a/src/bar.js',
      '+++ b/src/bar.js',
      '@@ -1,2 +1,3 @@',
      ' const z = 0;',
      '+const w = 1;',
    ].join('\n')}`;
    const vue = annoterDiff(deux);
    assert.ok(vue.includes('=== src/foo.js ==='));
    assert.ok(vue.includes('=== src/bar.js ==='));
    assert.equal(numeroDe(vue, 'const w = 1'), 2, 'le second fichier ne continue pas le compteur du premier');
  });

  test('un fichier créé se numérote à partir de 1', () => {
    const vue = annoterDiff([
      'diff --git a/src/neuf.js b/src/neuf.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/neuf.js',
      '@@ -0,0 +1,2 @@',
      "+'use strict';",
      '+module.exports = {};',
    ].join('\n'));
    assert.equal(numeroDe(vue, "'use strict'"), 1);
    assert.equal(numeroDe(vue, 'module.exports'), 2);
  });

  /* Les en-têtes de patch ne sont pas du contenu : les compter décalerait TOUT le fichier
     de trois lignes, silencieusement. */
  test('les en-têtes et « \\ No newline » ne consomment aucun numéro', () => {
    const vue = annoterDiff([
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,2 @@',
      ' un',
      '+deux',
      '\\ No newline at end of file',
    ].join('\n'));
    assert.equal(numeroDe(vue, ' un'), 1);
    assert.equal(numeroDe(vue, 'deux'), 2);
    assert.equal(numeroDe(vue, 'No newline'), null);
    assert.ok(!vue.includes('index 1111'), 'les en-têtes de patch ne sont pas recopiés');
  });

  test('un diff vide ou illisible ne fabrique rien', () => {
    assert.equal(annoterDiff(''), '');
    assert.equal(annoterDiff(null), '');
    // Du texte sans en-tête de fichier : rien à numéroter, on n'invente pas de fichier.
    assert.equal(annoterDiff('juste du texte\nsans diff'), '');
  });

  /* Un diff géant gonflerait le prompt sans rien apprendre de plus : on borne — et on le DIT,
     sinon une vue coupée passe pour la vue entière. */
  test('la vue est bornée, et la troncature est annoncée', () => {
    const gros = ['diff --git a/g.txt b/g.txt', '--- a/g.txt', '+++ b/g.txt', '@@ -1,1 +1,50000 @@'];
    for (let i = 0; i < MAX_LIGNES + 50; i += 1) gros.push(`+ligne ${i}`);
    const vue = annoterDiff(gros.join('\n'));
    assert.ok(vue.split('\n').length <= MAX_LIGNES + 1);
    assert.match(vue, /tronqu/i);
  });
});
