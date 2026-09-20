'use strict';
/* LE BRANCHEMENT DE `copilot.runReal` SUR LE SUPERVISEUR DE SANDBOX (§6.1 du plan) — vérifié
 * cross-plateforme : le réglage `agent_sandbox` doit bien engager le chemin sandboxé (pas le
 * chemin direct silencieusement) dès qu'il vaut `'required'`, et refuser plutôt que de retomber
 * sur un lancement non isolé quand le poste ne peut pas le tenir (ce qui est TOUJOURS le cas
 * ici : ce test tourne sans bubblewrap disponible, macOS compris).
 *
 * L'exécution RÉELLE d'un job sandboxé au travers de `runReal` (bubblewrap qui lance vraiment
 * le CLI) n'est pas éprouvée ici : le faux binaire de test (`#!/usr/bin/env node`, sous
 * `os.tmpdir()`) n'est visible d'AUCUN bac à sable, comme aucun binaire hors des chemins système
 * (`bindsSysteme`, `backends/linux.js`) ou de la source du job ne l'est — exactement ce que
 * `unit-sandbox-linux.test.js` prouve déjà pour le CLI RÉEL, monté depuis `/usr/local` comme
 * `claude`/`copilot` le sont en production.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-copilot-wiring-'));
process.env.MERGERIE_DATA_DIR = tmp;
// `copilot.runReal` (contrairement à `session.runInSession`) n'utilise jamais
// `--output-format stream-json` sur ce chemin : un texte brut est le contrat, pas un événement.
const fauxBin = path.join(tmp, 'claude-faux');
fs.writeFileSync(fauxBin, '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o755 });
process.env.COPILOT_BIN = fauxBin;
delete process.env.COPILOT_DRY_RUN;

const copilot = require('../src/agent/copilot');
const config = require('../src/data/config');
const linux = require('../src/sandbox/backends/linux');

const depot = (() => {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', '.'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
})();

before(() => config.updateConfig({ agent_sandbox: 'required' }));
after(() => { config.updateConfig({ agent_sandbox: 'off' }); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('copilot.runReal : engage la sandbox en lecture quand `agent_sandbox` l’exige', () => {
  test('review : refuse (SANDBOX_UNAVAILABLE), jamais un lancement direct silencieux', async (t) => {
    const cap = await linux.capabilities().catch(() => ({ platform: false, bin: null, namespaces: false }));
    if (cap.platform && cap.bin && cap.namespaces) {
      // Ce poste PEUT tenir la sandbox : le faux binaire de ce fichier (sous `os.tmpdir()`)
      // n'y est justement pas visible (voir l'en-tête) — `unit-sandbox-linux.test.js` prouve
      // le lancement réel, ce test-ci ne prouve que le refus sur un poste qui ne peut pas.
      return t.skip('bubblewrap disponible ici : ce test ne couvre que le cas contraire');
    }
    await assert.rejects(
      copilot.runPrompt('question', depot, { kind: 'explain' }),
      (e) => e.code === 'SANDBOX_UNAVAILABLE',
      'le poste de test n’a pas bubblewrap : le refus est le comportement attendu, pas un échec',
    );
  });

  test('agent_sandbox = off (défaut) : le chemin direct reste inchangé', async () => {
    config.updateConfig({ agent_sandbox: 'off' });
    const texte = await copilot.runPrompt('question', depot, { kind: 'explain' });
    assert.equal(texte, 'ok');
    config.updateConfig({ agent_sandbox: 'required' });
  });

  test('une saveur d’ÉCRITURE ignore encore `agent_sandbox` (chantier suivant, documenté)', async () => {
    // 'task' est en écriture : ce lot ne câble QUE la lecture (§ rapport). Si ce test se met à
    // échouer parce que l'écriture est enfin routée, c'est une bonne nouvelle — à ajuster alors.
    const texte = await copilot.runPrompt('question', depot, { kind: 'task' });
    assert.equal(texte, 'ok');
  });
});
