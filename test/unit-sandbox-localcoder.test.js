'use strict';
/* LE CODAGE HORS DÉPÔT EST STRUCTURELLEMENT INCOMPATIBLE AVEC LA SANDBOX SÉCURISÉE (§6.4 du
 * plan) : il travaille EN PLACE, dans le dossier réel de l'utilisateur — l'isoler reviendrait à
 * travailler sur une copie, ce qui n'est plus « en place » et ferait croire à une modification
 * qui n'a touché qu'une copie. `agent_sandbox: 'required'` doit donc REFUSER ce dossier
 * explicitement, jamais tenter un confinement qui mentirait sur ce qu'il protège.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-localcoder-'));
process.env.MERGERIE_DATA_DIR = tmp;
const fauxBin = path.join(tmp, 'claude-faux');
fs.writeFileSync(fauxBin, '#!/usr/bin/env node\nprocess.stdout.write("fait.");\n', { mode: 0o755 });
process.env.COPILOT_BIN = fauxBin;
delete process.env.COPILOT_DRY_RUN;

const db = require('../src/db');
const config = require('../src/data/config');
const localdirs = require('../src/data/localdirs');
const localcoder = require('../src/session/localcoder');

function creerTache(dossier) {
  const { dir_hash, dir_label } = localdirs.declarer(dossier);
  const maintenant = new Date().toISOString();
  const taskId = db.prepare('INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES (?,?,?,?)')
    .run('Ranger ce dossier', 'new', maintenant, maintenant).lastInsertRowid;
  db.prepare('INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, status, updated_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, '', dir_hash, dir_label, 'new', maintenant);
  return taskId;
}

before(() => config.updateConfig({ agent_sandbox: 'required' }));
after(() => { config.updateConfig({ agent_sandbox: 'off' }); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('localcoder.runLocal : refus net en sandbox obligatoire, jamais une fausse isolation', () => {
  test('agent_sandbox = required : le dossier passe en erreur, avec le code SANDBOX', async () => {
    const dossier = fs.mkdtempSync(path.join(tmp, 'projet-'));
    const taskId = creerTache(dossier);
    const logs = [];
    // Le seul dossier de cette tâche est refusé : `runLocal` lève (aucun dossier traité,
    // comportement déjà existant — voir `err.local.none-handled`), ce que le job attrape pour
    // marquer la tâche en erreur. Ce qu'on vérifie ici, c'est le dossier lui-même.
    await assert.rejects(localcoder.runLocal(taskId, (l) => logs.push(l)));
    const ligne = db.prepare('SELECT status, last_error FROM local_task_dir WHERE task_id = ?').get(taskId);
    assert.equal(ligne.status, 'error');
    assert.match(ligne.last_error, /mode sécurisé/i, logs.join('\n'));
    // Ni fichier créé, ni copie déguisée en modification du dossier réel : rien n'a tourné.
    assert.deepEqual(fs.readdirSync(dossier), []);
  });

  test('agent_sandbox = off (défaut) : le codage en place se déroule normalement', async () => {
    config.updateConfig({ agent_sandbox: 'off' });
    try {
      const dossier = fs.mkdtempSync(path.join(tmp, 'projet-off-'));
      const taskId = creerTache(dossier);
      await localcoder.runLocal(taskId, () => {});
      const ligne = db.prepare('SELECT status, last_error FROM local_task_dir WHERE task_id = ?').get(taskId);
      assert.equal(ligne.status, 'done', ligne.last_error);
    } finally { config.updateConfig({ agent_sandbox: 'required' }); }
  });
});
