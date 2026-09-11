'use strict';
/* Les blocs de protocole d'un run d'agent.
 *
 * Ils portent trois décisions de produit : quel dépôt corriger, quel agent créer, quelle
 * partie d'une carte est périmée. Un parseur trop strict fait disparaître le bouton
 * « Corriger sur X » sans un mot ; un parseur trop laxiste crée un agent sur un dépôt
 * inventé. La règle qui tient les deux bouts : un bloc mal formé n'est JAMAIS une erreur de
 * run — il est ignoré, et le rapport reste lisible. */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/protocol');

describe('protocol : extraire', () => {
  test('un bloc en fin de réponse est extrait, et retiré du Markdown affiché', () => {
    const md = '# Rapport\n\nDu texte.\n\n<<<REPO\ngrp/api | src/a.js | 12\nREPO>>>\n';
    const { block, rest } = protocol.extraire(md, 'REPO');
    assert.equal(block, 'grp/api | src/a.js | 12');
    assert.equal(rest, '# Rapport\n\nDu texte.');
    assert.ok(!rest.includes('REPO'), 'le bloc ne doit jamais s’afficher');
  });

  test('un bloc en TÊTE de réponse marche aussi — c’est ce que fait le cartographe', () => {
    const md = '<<<AGENT\nname: Notifications\nAGENT>>>\n\n# Les notifications\n\nDu contenu.';
    const { block, rest } = protocol.extraire(md, 'AGENT');
    assert.equal(block, 'name: Notifications');
    assert.equal(rest, '# Les notifications\n\nDu contenu.');
  });

  test('bloc absent : rien n’est extrait, le texte est rendu intact', () => {
    const { block, rest } = protocol.extraire('# Rapport\n\nRien de spécial.', 'REPO');
    assert.equal(block, null);
    assert.equal(rest, '# Rapport\n\nRien de spécial.');
  });

  test('balise ouverte jamais refermée : ignorée, et le texte n’est pas amputé', () => {
    // Sinon on couperait tout ce qui suit une balise mal tapée — c'est-à-dire le rapport.
    const md = 'Texte.\n<<<REPO\ngrp/api | a.js |';
    const { block, rest } = protocol.extraire(md, 'REPO');
    assert.equal(block, null);
    assert.equal(rest, md.trim());
  });

  test('deux blocs : le PREMIER est pris, et lui seul', () => {
    const md = '<<<REPO\na | b | 1\nREPO>>>\ntexte\n<<<REPO\nc | d | 2\nREPO>>>';
    const { block, rest } = protocol.extraire(md, 'REPO');
    assert.equal(block, 'a | b | 1');
    assert.ok(rest.includes('<<<REPO'), 'le second reste dans le texte, il sera ignoré aussi');
  });

  test('chaque balise est indépendante des autres', () => {
    const md = '<<<AGENT\nname: X\nAGENT>>>\ntexte\n<<<STALE\ngrp | a.js | faux\nSTALE>>>';
    assert.equal(protocol.extraire(md, 'AGENT').block, 'name: X');
    assert.equal(protocol.extraire(md, 'STALE').block, 'grp | a.js | faux');
    assert.equal(protocol.extraire(md, 'REPO').block, null);
  });
});

describe('protocol : nettoyer', () => {
  test('les trois blocs partent d’un coup, le Markdown reste', () => {
    const md = '<<<AGENT\nname: X\nAGENT>>>\n\n# Titre\n\ncorps\n\n<<<STALE\na | b | c\nSTALE>>>\n\n<<<REPO\nd | e | 1\nREPO>>>';
    const propre = protocol.nettoyer(md);
    assert.equal(propre, '# Titre\n\ncorps');
    for (const n of protocol.NOMS) assert.ok(!propre.includes(`<<<${n}`), n);
  });

  test('un texte sans bloc traverse sans changer', () => {
    assert.equal(protocol.nettoyer('# Rien\n\nà voir.'), '# Rien\n\nà voir.');
    assert.equal(protocol.nettoyer(''), '');
    assert.equal(protocol.nettoyer(null), '');
  });
});

describe('protocol : lignes', () => {
  test('les champs sont scindés sur « | » et trimés', () => {
    assert.deepEqual(protocol.lignes('grp/api |  src/a.js  | 12'), [['grp/api', 'src/a.js', '12']]);
  });

  test('les lignes vides et les séparateurs Markdown sont écartés', () => {
    // Un agent qui a compris « tableau » plutôt que « bloc » produit une ligne de tirets.
    const l = protocol.lignes('a | b | 1\n\n---|---|---\n\nc | d | 2\n');
    assert.deepEqual(l, [['a', 'b', '1'], ['c', 'd', '2']]);
  });

  test('un champ manquant rend une chaîne vide, pas une erreur', () => {
    assert.deepEqual(protocol.lignes('grp/api | src/a.js |'), [['grp/api', 'src/a.js', '']]);
    assert.deepEqual(protocol.lignes(''), []);
    assert.deepEqual(protocol.lignes(null), []);
  });
});
