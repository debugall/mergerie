'use strict';
/* AU DÉLAI, TOUT LE GROUPE MEURT. Les agents sont lancés en groupe de processus à eux (`proc.js`) :
   un Ctrl-C du terminal ne les atteint plus. Le délai d'expiration ne tuait que l'agent lui-même —
   un serveur de dev ou un `npm test` qu'il avait lancé restait vivant, et `tuerTout` ne le
   retrouvait plus : l'agent mort avait quitté la liste. On lance un faux agent qui démarre un
   petit-fils puis se bloque, et on attend l'EFFET : le petit-fils mort. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delai-'));
const pidFichier = path.join(tmp, 'petit-fils.pid');
const bin = path.join(tmp, 'claude-faux');
fs.writeFileSync(bin, `#!/usr/bin/env node
const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFichier)}, String(c.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });

process.env.MERGERIE_DATA_DIR = tmp;
process.env.COPILOT_BIN = bin;
process.env.AGENT_SESSION_TIMEOUT_MS = '1500';
delete process.env.COPILOT_ARGS;

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Délai d’un agent', { skip: process.platform === 'win32' ? 'groupes POSIX' : false }, () => {
  test('le petit-fils meurt avec l’agent quand le délai expire', async () => {
    // eslint-disable-next-line global-require
    const agentsession = require('../src/agent/session');
    await assert.rejects(agentsession.runInSession({
      key: 'delai', prompt: 'x', cwd: fs.mkdtempSync(path.join(tmp, 'w-')), resume: false, saveur: 'code',
    }), /délai|timeout/i);
    const petitFils = Number(fs.readFileSync(pidFichier, 'utf8'));
    const vivant = () => { try { process.kill(petitFils, 0); return true; } catch { return false; } };
    const fin = Date.now() + 10000;
    while (vivant() && Date.now() < fin) await new Promise((r) => setTimeout(r, 50));
    assert.equal(vivant(), false, 'le petit-fils ne survit pas au délai de l’agent');
  });
});
