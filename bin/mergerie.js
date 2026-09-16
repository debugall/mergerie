#!/usr/bin/env node
'use strict';
/* LA COMMANDE `mergerie`, pour `npx mergerie demo` et `npx mergerie`.
 *
 *   npx mergerie demo     sème une base fictive et lance l'outil dessus, en dry-run, sans jeton
 *   npx mergerie          l'outil, pour de vrai : http://localhost:4319
 *
 * Sous npx le paquet vit dans un CACHE (~/.npm/_npx/…), effacé sans prévenir : les données ne
 * peuvent pas aller « à côté du code » comme avec `npm start` dans un clone. Sans
 * MERGERIE_DATA_DIR, elles vont donc chez l'utilisateur — `~/.mergerie/data`, et
 * `~/.mergerie/demo` pour la démo, qui est effacée et resemée à chaque lancement. Tout ce que
 * `npm start` honore reste honoré : PORT, HOST, MERGERIE_DATA_DIR, et le `.env` du dossier courant.
 *
 * Le serveur est un PROCESSUS ENFANT (pas un `require`) : c'est le même `src/server.js` que
 * `npm start`, avec le même drapeau `--env-file-if-exists`, et Ctrl-C lui est transmis — sinon
 * tuer la commande laisserait le serveur orphelin, sur son port, avec sa base ouverte. */
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = process.argv[2];
if (arg && arg !== 'demo') {
  console.error(`usage : mergerie [demo]\n  demo   base fictive, IA simulée, aucun jeton\n  (rien) l'outil sur ~/.mergerie/data — MERGERIE_DATA_DIR pour choisir ailleurs`);
  process.exit(arg === '--help' || arg === '-h' ? 0 : 2);
}
const demo = arg === 'demo';
const env = { ...process.env };
env.MERGERIE_DATA_DIR = env.MERGERIE_DATA_DIR || path.join(os.homedir(), '.mergerie', demo ? 'demo' : 'data');
if (demo) Object.assign(env, { MERGERIE_DEMO: '1', COPILOT_DRY_RUN: '1' });

const nodeArgs = (file) => ['--env-file-if-exists=.env', path.join(ROOT, file)];
if (demo) {
  const seed = spawnSync(process.execPath, nodeArgs(path.join('scripts', 'demo-seed.js')), { stdio: 'inherit', env });
  if (seed.status !== 0) process.exit(seed.status || 1);
}
const server = spawn(process.execPath, nodeArgs(path.join('src', 'server.js')), { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => server.kill(sig));
server.on('exit', (code, signal) => process.exit(code === null ? (signal ? 130 : 1) : code));
