'use strict';
/* Un échec du CLI en mode stream-json (`code !== 0`) n'écrit presque jamais sur stderr :
 * l'explication arrive comme un événement `result` sur STDOUT, déjà lu par le parseur NDJSON.
 * Sans repli sur ce texte, l'erreur remontée à l'écran était « claude a échoué (code 1) : »
 * suivie de rien — le seul indice disponible aurait été le journal complet du job, pas le
 * message d'erreur lui-même. Fichier séparé de `unit-agent-stream.test.js` : `COPILOT_BIN` est
 * figé au chargement de `copilot.js`, il faut donc son propre faux binaire avant tout `require`. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creerFauxClaude } = require('./helpers/fake-claude');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stream-echec-'));
const faux = creerFauxClaude(tmp, {
  exitCode: 1,
  events: [
    { type: 'system', subtype: 'init', session_id: 'sess-echec' },
    { type: 'assistant', session_id: 'sess-echec', message: { content: [{ type: 'text', text: 'Je commence.' }] } },
    { type: 'result', subtype: 'error_during_execution', session_id: 'sess-echec', is_error: true, result: 'Erreur API : le service est surchargé.' },
  ],
});

process.env.MERGERIE_DATA_DIR = tmp;
process.env.COPILOT_BIN = faux.bin;
delete process.env.COPILOT_ARGS;

// eslint-disable-next-line import/order
const agentsession = require('../src/agent/session');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('un échec sans stderr reprend le dernier texte du flux, pas un message vide', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
  await assert.rejects(
    agentsession.runInSession({ key: 'test-echec', prompt: 'peu importe', cwd, resume: false, onLog: () => {} }),
    (err) => {
      assert.match(err.message, /surchargé/, `le résultat du flux doit remplacer un stderr vide : ${err.message}`);
      return true;
    },
  );
});
