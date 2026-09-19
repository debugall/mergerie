'use strict';
/* « TESTER » ET LE JETON ENREGISTRÉ. Le masque `***` veut dire « le jeton en base » : il ne part que
   vers son adresse. Une adresse CHANGÉE exige un jeton tapé — mais une adresse identique écrite
   autrement (le défaut explicite, un slash final) ne doit pas faire croire à un changement : pour
   GitHub, `github_url` vide vaut l'hôte WEB `https://github.com`, pas l'API. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { jetonFraisRequis } = require('../src/core/garde');

describe('jetonFraisRequis', () => {
  test('GitHub vide puis « https://github.com » tapé : même hôte, pas de jeton à retaper', () => {
    assert.equal(jetonFraisRequis('https://github.com', '', '***', 'ghp_x', 'https://github.com'), false);
    assert.equal(jetonFraisRequis('https://github.com/', '', '***', 'ghp_x', 'https://github.com'), false);
  });
  test('une autre adresse avec le masque : jeton à retaper', () => {
    assert.equal(jetonFraisRequis('https://ailleurs.example', '', '***', 'ghp_x', 'https://github.com'), true);
    assert.equal(jetonFraisRequis('https://ailleurs.example', 'https://gitlab.test', '***', 'glpat'), true);
  });
  test('un jeton tapé, ou rien d’enregistré : rien à protéger', () => {
    assert.equal(jetonFraisRequis('https://ailleurs.example', 'https://gitlab.test', 'nouveau', 'glpat'), false);
    assert.equal(jetonFraisRequis('https://ailleurs.example', 'https://gitlab.test', '***', ''), false);
    assert.equal(jetonFraisRequis(undefined, 'https://gitlab.test', '***', 'glpat'), false);
  });
});
