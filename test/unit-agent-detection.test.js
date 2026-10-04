'use strict';
/* LA DÉTECTION DU BINAIRE DE L'AGENT NE LANCE RIEN.
 *
 * Elle faisait `spawnSync(bin, ['--version'])` avec cinq secondes de délai, résultat gardé une
 * minute : sous charge, le délai tombait, l'écran disait « introuvable » pour un binaire bien
 * présent, et une review lancée pendant cette minute revenait SIMULÉE. Un binaire est disponible
 * s'il se résout — un chemin exécutable, ou un nom trouvé sur le PATH — ce que `spawn` fera de
 * toute façon au lancement. Ici : chemin absent, présent mais non exécutable, exécutable ; nom nu
 * hors PATH puis sur le PATH ; et `redetecter()` qui relit l'état sans rien retenir.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-detect-'));
process.env.COPILOT_DRY_RUN = '0';

const skipWindows = process.platform === 'win32';

describe('détection du binaire de l’agent', { skip: skipWindows && 'droits d’exécution POSIX' }, () => {
  let copilot;
  let dossier;
  before(() => {
    copilot = require('../src/agent/copilot');
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bin-'));
  });

  test('un chemin absent, puis présent mais non exécutable, n’est pas disponible', () => {
    const p = path.join(dossier, 'agent-absent');
    assert.equal(copilot.binaryAvailable(p), false);
    fs.writeFileSync(p, '#!/bin/sh\necho ok\n', { mode: 0o644 });
    assert.equal(copilot.binaryAvailable(p), false, 'présent mais sans droit d’exécution');
  });

  test('un chemin exécutable est disponible, et le devient sans délai ni cache', () => {
    const p = path.join(dossier, 'agent-present');
    assert.equal(copilot.binaryAvailable(p), false);
    fs.writeFileSync(p, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    assert.equal(copilot.binaryAvailable(p), true, 'rien n’a été mis en cache : l’état est relu');
    assert.equal(typeof copilot.redetecter(), 'boolean', '« Réessayer » relit l’état du binaire par défaut, sans rien à effacer');
    fs.rmSync(p);
    assert.equal(copilot.binaryAvailable(p), false, 'retiré, il n’est plus disponible — sans attendre une minute');
  });

  test('un nom nu se cherche sur le PATH du serveur, et nulle part ailleurs', () => {
    const nom = `agent-nu-${process.pid}`;
    fs.writeFileSync(path.join(dossier, nom), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const avant = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent-for-test';
      assert.equal(copilot.binaryAvailable(nom), false, 'hors PATH : introuvable, même s’il existe sur le disque');
      process.env.PATH = `${dossier}${path.delimiter}${avant}`;
      assert.equal(copilot.binaryAvailable(nom), true);
    } finally { process.env.PATH = avant; }
  });

  test('un nom vide n’est jamais disponible', () => {
    assert.equal(copilot.binaryAvailable(''), false);
    assert.equal(copilot.binaryAvailable('   '), false);
  });
});
