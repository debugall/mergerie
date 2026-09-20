'use strict';
/* LE BRANCHEMENT DE `verifyrun.lancerCommandes` SUR LA SANDBOX (§6.5 du plan) : engagé
 * uniquement pour les dépôts `mode: 'worktree'`, JAMAIS pour `mode: 'in_place'` (son
 * consentement porte sur un accès direct au dossier de l'utilisateur — hors sujet ici), et
 * seulement quand `agent_sandbox` vaut `'required'` (off par défaut).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-verify-'));
process.env.MERGERIE_DATA_DIR = tmp;

const verifyrun = require('../src/verify/verifyrun');
const config = require('../src/data/config');
const linux = require('../src/sandbox/backends/linux');

const verifier = { timeout_s: 30 };

before(() => config.updateConfig({ agent_sandbox: 'required' }));
after(() => { config.updateConfig({ agent_sandbox: 'off' }); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('verifyrun.lancerCommandes : sandbox sur les worktrees, jamais sur le in place', () => {
  test('mode worktree : la sandbox est engagée — refus net sans bubblewrap, succès réel avec', async () => {
    const cap = await linux.capabilities().catch(() => ({ platform: false, bin: null, namespaces: false }));
    const dispo = !!(cap.platform && cap.bin && cap.namespaces);
    const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const r = await verifyrun.lancerCommandes(verifier, ['echo ok'], [{ name: 'app', dir, mode: 'worktree' }]);
    if (dispo) {
      // Le poste peut tenir la sandbox : la commande y tourne réellement, avec succès.
      assert.equal(r.erreur, undefined, JSON.stringify(r));
      assert.equal(r.run.commands[0].code, 0);
    } else {
      // Sans bubblewrap : le refus prouve que le chemin sandboxé a bien été choisi — un
      // chemin direct aurait simplement réussi avec "ok".
      assert.ok(r.erreur, `attendu un refus explicite : ${JSON.stringify(r)}`);
    }
  });

  test('mode in_place : jamais sandboxé, même avec agent_sandbox required', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'inplace-'));
    const r = await verifyrun.lancerCommandes(verifier, ['echo ok'], [{ name: 'app', dir, mode: 'in_place' }]);
    assert.equal(r.erreur, undefined, `le mode in_place ne doit jamais passer par la sandbox : ${JSON.stringify(r)}`);
    assert.equal(r.run.commands[0].code, 0);
  });

  test('agent_sandbox = off (défaut) : les deux modes restent sur le chemin direct', async () => {
    config.updateConfig({ agent_sandbox: 'off' });
    try {
      const dir = fs.mkdtempSync(path.join(tmp, 'repo-off-'));
      const r = await verifyrun.lancerCommandes(verifier, ['echo ok'], [{ name: 'app', dir, mode: 'worktree' }]);
      assert.equal(r.erreur, undefined, JSON.stringify(r));
      assert.equal(r.run.commands[0].code, 0);
    } finally { config.updateConfig({ agent_sandbox: 'required' }); }
  });

  test('sur Linux avec bubblewrap : le worktree tourne réellement dans la sandbox', async (t) => {
    const cap = await linux.capabilities().catch(() => ({ platform: false, bin: null, namespaces: false }));
    if (!(cap.platform && cap.bin && cap.namespaces)) return t.skip('bubblewrap indisponible sur ce poste');
    const dir = fs.mkdtempSync(path.join(tmp, 'repo-linux-'));
    fs.writeFileSync(path.join(dir, 'marqueur.txt'), 'x');
    const r = await verifyrun.lancerCommandes(verifier, ['ls marqueur.txt', 'echo pass'], [{ name: 'app', dir, mode: 'worktree' }]);
    assert.equal(r.erreur, undefined, JSON.stringify(r));
    assert.equal(r.run.commands[0].code, 0);
  });
});
