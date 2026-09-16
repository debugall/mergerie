'use strict';
/* La commande `mergerie` (bin/mergerie.js), celle de `npx mergerie demo`.
 *
 * Elle est lancée comme npx la lancerait : un processus à part, un HOME jetable, aucun
 * MERGERIE_DATA_DIR. Ce que l'on prouve : la démo se sème dans ~/.mergerie/demo (et non à côté
 * du code, qui sous npx est un cache), le serveur répond avec la bannière de démo, et tuer la
 * commande tue le serveur — sinon chaque Ctrl-C laisserait un orphelin sur son port.
 *
 * Pas de startApp() ici : le serveur est un sous-processus avec son propre dossier de données,
 * et rien de `src/` n'est chargé dans ce processus. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const BIN = path.join(__dirname, '..', 'bin', 'mergerie.js');
const portLibre = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const get = (url) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).catch(() => null);
const attendre = async (fn, essais = 300) => { for (let i = 0; i < essais; i += 1) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };

test('`mergerie demo` sème dans ~/.mergerie/demo, répond en mode démo, et meurt avec la commande', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-home-'));
  const port = await portLibre();
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
  delete env.MERGERIE_DATA_DIR; delete env.MERGERIE_DEMO;
  const child = spawn(process.execPath, [BIN, 'demo'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let sortie = '';
  child.stdout.on('data', (d) => { sortie += d; }); child.stderr.on('data', (d) => { sortie += d; });
  try {
    const page = await attendre(() => get(`http://127.0.0.1:${port}/`));
    assert.ok(page, `le serveur n'a pas répondu sur :${port}\n${sortie}`);
    assert.match(page, /demoBanner/, 'la bannière de démo : MERGERIE_DEMO est passé au serveur');
    assert.ok(fs.existsSync(path.join(home, '.mergerie', 'demo', 'reviewer.db')), 'la base est dans ~/.mergerie/demo');
    assert.ok(await get(`http://127.0.0.1:${port}/api/config`), "l'API répond");
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
  // Le serveur a suivi : le port est libre à nouveau (on attend l'effet, pas un délai).
  assert.equal(await attendre(async () => ((await get(`http://127.0.0.1:${port}/api/config`)) ? null : true), 100), true, 'le serveur est mort avec la commande');
  fs.rmSync(home, { recursive: true, force: true });
});

test('`mergerie` refuse un argument inconnu et explique', async () => {
  const child = spawn(process.execPath, [BIN, 'plop'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(err, /usage : mergerie \[demo\]/);
});
