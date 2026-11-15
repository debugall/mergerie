'use strict';
/* LE COMMENTAIRE « #tech » D'UN TICKET : le premier commentaire qui commence par le marqueur, lui
 * seul, rejoint le contexte de review. Couvert ici sans réseau : la casse et les espaces ignorés
 * (l'éditeur de Jira fait d'un « #tech » un titre « # tech »), la frontière de mot (« #technique »
 * n'en est pas un), un marqueur réglé autrement, un marqueur au milieu du texte ignoré, et le bloc
 * de contexte qui le range sous son titre. Le parcours HTTP est éprouvé dans e2e-api. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-tech-'));

test('commentaireTech : le premier commentaire marqué, sans son marqueur', () => {
  const { commentaireTech } = require('../src/integrations/jira');
  assert.equal(commentaireTech(['Reproduit en préprod.', '#tech Arrondir au centime.', '#tech Le second.']), 'Arrondir au centime.');
  assert.equal(commentaireTech(['# tech\n\nRendu en titre par Jira.']), 'Rendu en titre par Jira.');
  assert.equal(commentaireTech(['#TECH : majuscules et deux-points']), 'majuscules et deux-points');
  assert.equal(commentaireTech(['#technique pas le marqueur']), '', 'frontière de mot');
  assert.equal(commentaireTech(['Voir le #tech plus bas']), '', 'le marqueur doit ouvrir le commentaire');
  assert.equal(commentaireTech(['[dev] autre convention'], '[dev]'), 'autre convention');
  assert.equal(commentaireTech([]), '');
});

test('marqueurTech et issueToContext : défaut « #tech », bloc titré à la suite de la description', () => {
  const { marqueurTech, issueToContext } = require('../src/integrations/jira');
  assert.equal(marqueurTech({}), '#tech');
  assert.equal(marqueurTech({ jira_tech_marker: '  ' }), '#tech');
  assert.equal(marqueurTech({ jira_tech_marker: '#dev' }), '#dev');
  const ctx = issueToContext({ summary: 'Titre', descriptionMd: 'Desc', techMd: 'Note', techMarker: '#tech' });
  assert.match(ctx, /^# Titre\n\nDesc\n\n## .*#tech.*\n\nNote$/);
  assert.equal(issueToContext({ summary: 'Titre', descriptionMd: 'Desc', techMd: '' }), '# Titre\n\nDesc');
});
