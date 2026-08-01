'use strict';
/* « Stop » doit VRAIMENT arrêter l'agent.

   Le bug corrigé ici : `agentsession.js` ne s'enregistrait pas auprès de `proc`. `proc.cancel`
   levait donc son drapeau d'annulation sans avoir d'enfant à tuer, et le process de l'agent
   continuait jusqu'à son délai — quinze minutes à écrire dans le clone et à consommer des
   tokens. Et c'est le chemin NOMINAL (COPILOT_BIN=claude), c'est-à-dire exactement la phase
   qu'on veut pouvoir interrompre.

   Un test qui vérifierait le câblage (« proc.setActive est-il appelé ? ») ne prouverait rien :
   il passerait avec un enfant déjà mort, ou avec un signal qui n'aboutit pas. On lance donc un
   VRAI process qui refuse de finir, on l'arrête, et on mesure. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Un faux binaire d'agent qui dort trois minutes : bien au-delà de tout délai de test, donc
// s'il s'arrête, c'est qu'on l'a tué. Son nom contient « claude » pour emprunter le chemin
// par défaut (`backendName()` déduit le backend du nom du binaire).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-'));
const fauxAgent = path.join(tmp, 'claude-qui-dort');
fs.writeFileSync(fauxAgent, '#!/usr/bin/env node\nsetTimeout(() => {}, 180000);\n');
fs.chmodSync(fauxAgent, 0o755);

process.env.MERGERIE_DATA_DIR = tmp;
process.env.COPILOT_BIN = fauxAgent;

// Après les variables d'environnement : copilot.js fige COPILOT_BIN au chargement.
// eslint-disable-next-line import/order
const proc = require('../src/proc');
// eslint-disable-next-line import/order
const agentsession = require('../src/agentsession');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Stop : l’agent est réellement tué', () => {
  test('le backend déduit du binaire est bien « claude »', () => {
    // Préalable : sans lui le test emprunterait l'autre chemin et ne prouverait rien.
    assert.equal(agentsession.backendName(), 'claude');
  });

  test('annuler un job tue le process de l’agent au lieu d’attendre son délai', async () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
    const debut = Date.now();

    const { ctx, done } = proc.run(() => agentsession.runInSession({
      key: 'test-stop', prompt: 'peu importe', cwd, resume: false, onLog: () => {},
    }));
    const issue = done.then(() => 'résolu', (e) => `rejeté: ${e.message}`);

    // On laisse le process démarrer : annuler avant le spawn ne testerait rien.
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(ctx.activeChild, 'le process de l’agent est enregistré auprès de proc');
    const pid = ctx.activeChild.pid;
    assert.ok(estVivant(pid), 'préalable : il tourne vraiment');

    proc.cancel(ctx);
    const r = await issue;
    const duree = Date.now() - debut;

    assert.match(r, /^rejeté/, 'le run se termine par un échec, pas par un succès silencieux');
    assert.ok(duree < 10000, `arrêt immédiat attendu, obtenu après ${duree} ms`);
    assert.equal(ctx.cancelled, true, 'le drapeau d’annulation est posé');

    // Le drapeau seul ne suffit pas : c'est la mort du process qui était en cause.
    await new Promise((r2) => setTimeout(r2, 300));
    assert.equal(estVivant(pid), false, 'le process de l’agent est mort');
  });

  test('un run non annulé ne laisse pas d’enfant enregistré derrière lui', async () => {
    // Sinon un « Stop » ultérieur viserait un process déjà terminé — ou pire, le mauvais.
    const cwd = fs.mkdtempSync(path.join(tmp, 'work2-'));
    const { ctx, done } = proc.run(() => agentsession.runInSession({
      key: 'test-stop-2', prompt: 'peu importe', cwd, resume: false, onLog: () => {},
    }));
    const issue = done.catch(() => null);
    await new Promise((r) => setTimeout(r, 400));
    proc.cancel(ctx);
    await issue;
    assert.equal(ctx.activeChild, null, 'l’enfant est désenregistré à la fermeture');
  });
});

function estVivant(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
