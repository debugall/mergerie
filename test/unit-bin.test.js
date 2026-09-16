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
    // La démo EFFACE son dossier avant de le resemer : elle doit le nommer, pas l'effacer en silence.
    assert.match(sortie, /démo : .*\.mergerie.*demo est effacé/, 'la commande dit quel dossier elle efface');
    assert.ok(await get(`http://127.0.0.1:${port}/api/config`), "l'API répond");
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
  // Le serveur a suivi : le port est libre à nouveau (on attend l'effet, pas un délai).
  assert.equal(await attendre(async () => ((await get(`http://127.0.0.1:${port}/api/config`)) ? null : true), 100), true, 'le serveur est mort avec la commande');
  fs.rmSync(home, { recursive: true, force: true });
});

/* LE `.env` DU DOSSIER COURANT CHOISIT LE DOSSIER DE DONNÉES. Le serveur charge ce fichier, mais
   trop tard : le lanceur avait déjà posé ~/.mergerie/data dans son environnement, et le
   `--env-file` de Node ne réécrit pas une variable déjà présente. Le `.env` était donc lu et sa
   ligne MERGERIE_DATA_DIR ignorée — en silence, ce qui est le pire des deux. Et la priorité de
   Node est conservée : ce que le shell exporte passe devant le fichier. */
test('un `.env` du dossier courant choisit le dossier de données, et le shell garde le dernier mot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-home-'));
  const projet = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-projet-'));
  const parLeFichier = path.join(projet, 'donnees-du-env');
  const parLeShell = path.join(projet, 'donnees-du-shell');

  const lancer = async (supplement) => {
    const port = await portLibre();
    fs.writeFileSync(path.join(projet, '.env'),
      `PORT=${port}\nMERGERIE_DATA_DIR=${parLeFichier}\nCOPILOT_DRY_RUN=1\n`);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    // On part d'un shell NU — c'est la situation de qui lance `npx mergerie` — puis on y ajoute
    // ce que le cas veut y exporter.
    delete env.MERGERIE_DATA_DIR; delete env.MERGERIE_DEMO; delete env.PORT;
    Object.assign(env, supplement);
    const child = spawn(process.execPath, [BIN], { env, cwd: projet, stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = ''; child.stdout.on('data', (d) => { sortie += d; }); child.stderr.on('data', (d) => { sortie += d; });
    const vivant = await attendre(() => get(`http://127.0.0.1:${port}/api/config`));
    const arret = async () => { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); };
    return { port, sortie: () => sortie, vivant, arret };
  };

  // 1. le fichier seul : c'est lui qui décide, et rien ne part dans ~/.mergerie
  let app = await lancer({});
  try {
    assert.ok(app.vivant, `le serveur n'a pas répondu sur le port du .env\n${app.sortie()}`);
    assert.ok(fs.existsSync(path.join(parLeFichier, 'reviewer.db')), 'la base va où le `.env` le demande');
    assert.equal(fs.existsSync(path.join(home, '.mergerie', 'data', 'reviewer.db')), false,
      'et surtout pas dans ~/.mergerie/data, que le lanceur ne doit plus imposer');
  } finally { await app.arret(); }

  // 2. le shell par-dessus : il l'emporte, comme partout ailleurs avec --env-file
  app = await lancer({ MERGERIE_DATA_DIR: parLeShell });
  try {
    assert.ok(app.vivant, `le serveur n'a pas répondu\n${app.sortie()}`);
    assert.ok(fs.existsSync(path.join(parLeShell, 'reviewer.db')), 'ce que le shell exporte passe devant le fichier');
  } finally { await app.arret(); }

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projet, { recursive: true, force: true });
});

test('`mergerie` refuse un argument inconnu et explique', async () => {
  const child = spawn(process.execPath, [BIN, 'plop'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(err, /usage : mergerie \[demo\]/);
});
