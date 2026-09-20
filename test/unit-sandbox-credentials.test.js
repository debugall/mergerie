'use strict';
/* LE BROKER DE CREDENTIALS : une COPIE, jamais un lien — coupée de la source dès qu'elle est
 * faite — et un refus net plutôt qu'un home vide quand rien n'a pu être importé.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { copierHomeCopilot, EXCLUS } = require('../src/sandbox/credentials');

const creerSource = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-source-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"auth":"jeton-de-test"}');
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'abc.json'), '{"prompt":"secret du passé"}');
  fs.writeFileSync(path.join(dir, 'history'), 'ligne 1\n');
  return dir;
};

describe('sandbox/credentials : broker Copilot', () => {
  test('copie la config, jamais un lien symbolique', () => {
    const source = creerSource();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dest-'));
    const r = copierHomeCopilot(source, dest);
    assert.deepEqual(r.linked, ['config.json']);
    const cible = path.join(dest, 'config.json');
    assert.equal(fs.lstatSync(cible).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(cible, 'utf8'), '{"auth":"jeton-de-test"}');
    // Couper la source ne doit rien changer à la copie : elle est déjà indépendante.
    fs.rmSync(source, { recursive: true, force: true });
    assert.equal(fs.readFileSync(cible, 'utf8'), '{"auth":"jeton-de-test"}');
  });

  test('sessions/historique ne sont jamais importés', () => {
    const source = creerSource();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dest-'));
    copierHomeCopilot(source, dest);
    assert.equal(fs.existsSync(path.join(dest, 'sessions')), false);
    assert.equal(fs.existsSync(path.join(dest, 'history')), false);
  });

  test('un lien symbolique dans la source n’est jamais suivi', () => {
    const source = creerSource();
    const dehors = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dehors-'));
    fs.writeFileSync(path.join(dehors, 'secret.txt'), 'x');
    fs.symlinkSync(dehors, path.join(source, 'lien-externe'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dest-'));
    copierHomeCopilot(source, dest);
    assert.equal(fs.existsSync(path.join(dest, 'lien-externe')), false);
  });

  test('une source absente ou vide de tout auth est un refus net, pas un home vide', () => {
    const dest1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dest-'));
    assert.throws(() => copierHomeCopilot(null, dest1), { code: 'SANDBOX_CREDENTIALS_UNSUPPORTED' });

    const sourceVide = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-source-vide-'));
    fs.mkdirSync(path.join(sourceVide, 'sessions'));
    fs.writeFileSync(path.join(sourceVide, 'history'), 'x');
    const dest2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cred-dest-'));
    assert.throws(() => copierHomeCopilot(sourceVide, dest2), { code: 'SANDBOX_CREDENTIALS_UNSUPPORTED' });
  });

  test('la liste noire couvre les variantes de casse et de pluriel attendues', () => {
    for (const nom of ['history', 'History', 'sessions', 'session', 'logs', 'log', 'tmp', 'cache', 'skills', 'copilot-instructions.md']) {
      assert.ok(EXCLUS.test(nom), `${nom} devrait être exclu`);
    }
    assert.equal(EXCLUS.test('config.json'), false);
  });
});
