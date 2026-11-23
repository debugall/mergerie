'use strict';
/* LES JETONS « &&dépôt » — l'analyse partagée entre le navigateur et Node
 * (`public/runtime/jetons-runtime.js`). Le comportement dans la modale est prouvé dans un vrai
 * navigateur par `e2e-jetons-depots` ; ici, les règles du texte seules : priorité de la dernière
 * branche écrite, code en ligne, ambigus, inconnus, trop courts, retrait. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const J = require('../public/runtime/jetons-runtime.js');

const DEPOTS = [
  { id: 1, project: 'grp/tarification' }, { id: 2, project: 'grp/tarif-legacy' },
  { id: 3, project: 'grp/api' }, { id: 4, project: 'grp/api-core' },
];

test('la dernière branche écrite pour un dépôt l’emporte, un jeton sans branche ne l’efface pas', () => {
  const r = J.resoudreJetonsDepots('desc &&tarification:old puis #tech `&&tarification:new` et &&tarification', DEPOTS);
  assert.deepEqual([...r.voulus], [[1, { nom: 'tarification', branche: 'new', depart: '' }]]);
});

test('le nom exact l’emporte sur les contenances ; ambigus, inconnus et trop courts sont rendus à part', () => {
  const r = J.resoudreJetonsDepots('&&grp/api &&tarif &&nulle-part &&ab &&*:feature/x', DEPOTS);
  assert.deepEqual([...r.voulus.keys()], [3]);
  assert.deepEqual(r.ambigus, [{ nom: 'tarif', projets: ['grp/tarification', 'grp/tarif-legacy'] }]);
  assert.deepEqual(r.inconnus, ['nulle-part']);
  assert.deepEqual(r.court, ['ab']);
  assert.equal(r.globale, 'feature/x');
});

test('exclure écarte le jeton en cours de frappe', () => {
  const texte = 'voir &&tarif';
  const r = J.resoudreJetonsDepots(texte, DEPOTS, (j) => j.fin === texte.length);
  assert.deepEqual(r.ambigus, []);
});

test('a&&b n’est pas un jeton ; un jeton en code en ligne l’est, et son retrait ne laisse pas de `` vide', () => {
  assert.deepEqual(J.jetonsDepots('if (a&&bcde) x'), []);
  assert.deepEqual(J.jetonsDepots('dans &&tarif. Et &&api-core:fix/x.').map((j) => [j.nom, j.branche]), [['tarif', ''], ['api-core', 'fix/x']], 'le point final n’en est pas');
  assert.deepEqual(J.jetonsDepots('dans `&&api-core:fix/x` ici').map((j) => [j.nom, j.branche]), [['api-core', 'fix/x']]);
  assert.equal(J.retirerJetonsDepots('Corriger dans `&&api-core:fix/x` et &&*:rel/1 vite'), 'Corriger dans et vite');
  assert.equal(J.retirerJetonsDepots('```js\nconst a = 1;\n```'), '```js\nconst a = 1;\n```', 'un bloc de code reste intact');
});

test('la branche de départ : &&nom:branche<depart, &&nom<depart, et pour tous &&*:branche<depart, &&*<depart', () => {
  assert.deepEqual(J.jetonsDepots('&&api-core:feature/x<develop. puis &&tarification<main et &&grp/api:f@g')
    .map((j) => [j.nom, j.branche, j.depart]),
  [['api-core', 'feature/x', 'develop'], ['tarification', '', 'main'], ['grp/api', 'f@g', '']]);
  const r = J.resoudreJetonsDepots('&&api-core:a<develop puis &&api-core:b', DEPOTS);
  assert.deepEqual(r.voulus.get(4), { nom: 'api-core', branche: 'b', depart: 'develop' }, 'un départ écrit plus tôt reste');
  assert.equal(J.brancheGlobaleJeton('&&*:feature/x<develop'), 'feature/x');
  assert.equal(J.departGlobalJeton('&&*:feature/x<develop'), 'develop');
  assert.equal(J.departGlobalJeton('&&*<release/2'), 'release/2');
  assert.equal(J.brancheGlobaleJeton('&&*<release/2'), '', '&&*<départ ne pose aucune branche de travail');
  assert.equal(J.retirerJetonsDepots('A &&api-core:f<d B &&*<dev C &&*:x<y D `&&api-core<dev` E'), 'A B C D E');
});

test('les anciennes formes ne sont plus des jetons : &&&, et « & » ou « @ » ne séparent plus la branche', () => {
  assert.equal(J.brancheGlobaleJeton('&&&feature/x'), '');
  assert.deepEqual(J.jetonsDepots('&&api-core&fix/x').map((j) => [j.nom, j.branche]), [['api-core', '']]);
  assert.equal(J.jetonsDepots('&&&feature/x').length, 0);
});

test('la demande &&> : une ligne par préfixe, réunies dans l’ordre, retirées du contexte, préfixe ôté à l’envoi', () => {
  const ticket = '# TVA\n\nContexte.\n\n&&> Corriger la TVA\n\n&&> - sur les paniers\nvoir &&> au milieu : pas une demande\n  &&>collé';
  assert.equal(J.demandeDe(ticket), 'Corriger la TVA\n- sur les paniers\ncollé');
  assert.equal(J.retirerDemande(ticket), '# TVA\n\nContexte.\n\nvoir &&> au milieu : pas une demande');
  assert.equal(J.demandeDe('rien ici'), '');
  assert.equal(J.retirerJetonsDepots('&&> Faire X dans &&api-core\nPuis Y'), 'Faire X dans\nPuis Y');
});
