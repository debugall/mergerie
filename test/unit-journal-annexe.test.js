'use strict';
/* LE JOURNAL D'UN AGENT : une ligne courte par outil, et l'annexe qui garde ce que la ligne ne
 * montre pas — le diff d'un Edit, le contenu d'un Write. Sur les fonctions nues. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-journal-annexe-'));
process.env.COPILOT_DRY_RUN = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ligneOutil, annexeOutil } = require('../src/agent/session');

describe('Journal · lignes d’outil et annexes', () => {
  test('Edit : la ligne compte les lignes, l’annexe porte l’ancien et le nouveau', () => {
    const c = { name: 'Edit', input: { file_path: 'src/a.js', old_string: 'a\nb', new_string: 'a\nb\nc' } };
    assert.equal(ligneOutil(c), '» Edit src/a.js (+3 −2)');
    assert.deepEqual(annexeOutil(c), { kind: 'edit', file: 'src/a.js', edits: [{ old: 'a\nb', new: 'a\nb\nc' }] });
  });
  test('MultiEdit et Write', () => {
    const m = { name: 'MultiEdit', input: { file_path: 'x.py', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: '', new_string: 'd' }] } };
    assert.equal(ligneOutil(m), '» MultiEdit x.py (2 × · +3 −1)');
    assert.equal(annexeOutil(m).edits.length, 2);
    const w = { name: 'Write', input: { file_path: 'README.md', content: '# T\n\ntexte' } };
    assert.equal(ligneOutil(w), '» Write README.md (3 lignes)');
    assert.deepEqual(annexeOutil(w), { kind: 'write', file: 'README.md', content: '# T\n\ntexte' });
  });
  test('une lecture n’a rien à annexer', () => {
    assert.equal(annexeOutil({ name: 'Read', input: { file_path: 'a' } }), null);
    assert.equal(annexeOutil({ name: 'Bash', input: { command: 'ls' } }), null);
    assert.match(ligneOutil({ name: 'Bash', input: { command: 'ls' } }), /^» Bash/);
  });
});
