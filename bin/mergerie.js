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
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = process.argv[2];
if (arg && !['demo', 'token'].includes(arg)) {
  console.error(`usage : mergerie [demo|token]\n  demo   base fictive, IA simulée, aucun jeton\n  token  affiche le jeton de session local (pour un curl à la main)\n  (rien) l'outil sur ~/.mergerie/data — MERGERIE_DATA_DIR pour choisir ailleurs`);
  process.exit(arg === '--help' || arg === '-h' ? 0 : 2);
}
const demo = arg === 'demo';

if (arg === 'token') {
  const dataDir = process.env.MERGERIE_DATA_DIR || path.join(os.homedir(), '.mergerie', 'data');
  const fichier = path.join(dataDir, 'local-token');
  try {
    process.stdout.write(`${fs.readFileSync(fichier, 'utf8').trim()}\n`);
    process.exit(0);
  } catch {
    console.error(`Jeton introuvable (${fichier}) — lance d'abord \`mergerie\`, ou pose MERGERIE_DATA_DIR sur le bon dossier.`);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- le `.env` du premier jour
 *
 * SANS `.env`, L'OUTIL DÉMARRE MAIS NE SAIT PAS APPELER L'IA. Le binaire vaut « copilot » par
 * défaut ; qui a installé Claude Code n'a pas ce binaire, l'outil bascule en dry-run (des
 * rapports simulés) et chaque review rend un texte factice. Depuis un clone on copie
 * `.env.example` — sous `npx` il n'y a pas de clone, donc rien à copier.
 *
 * On en écrit donc un, une seule fois, À CÔTÉ DES DONNÉES (`~/.mergerie/.env`) — et non dans le
 * dossier courant, qui change d'un lancement à l'autre : le fichier écrit un jour dans
 * `~/projets/x` était ignoré sans un mot dès qu'on relançait la commande depuis `~/projets/y`.
 * Le `.env` du dossier courant reste lu, et passe DEVANT : c'est la surcharge locale.
 *
 * Il est COURT. L'agent, ses arguments et son délai se règlent désormais à l'écran (Réglages →
 * Session IA) et s'appliquent sans redémarrage ; ce qui est écrit ici n'est que le point de
 * départ. Les explications (permissions, TLS, proxy) sont dans le guide, pas dans un fichier
 * de configuration de cinquante lignes qu'on ouvre avec appréhension.
 *
 * PAS EN MODE DÉMO : « npx mergerie demo » promet de ne rien installer et de ne rien laisser.
 */
const CANDIDATS = [
  { bin: 'claude', args: '' },
  { bin: 'copilot', args: '--model claude-sonnet-5' },
];
/* Le PATH d'un shell non interactif n'a pas toujours `~/.local/bin` : on regarde aussi là où
   les installateurs posent ces binaires, sinon on écrirait « introuvable » sur une machine qui
   l'a. */
const DOSSIERS_AGENT = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
];
function trouverAgent() {
  for (const c of CANDIDATS) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c.bin], { encoding: 'utf8' });
    const duPath = r.status === 0 && String(r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean);
    if (duPath) return { ...c, chemin: duPath };
    for (const d of DOSSIERS_AGENT) {
      const p = path.join(d, c.bin);
      if (fs.existsSync(p)) return { ...c, chemin: p };
    }
  }
  return null;
}

function contenuEnv(agent) {
  return `# Mergerie — réglages de départ, écrits au premier lancement (relus à chaque démarrage).
# Un .env dans le dossier d'où tu lances la commande passe devant ; le shell passe devant tout.
# L'agent, ses arguments et son délai se règlent aussi à l'écran : Réglages → Session IA.
# Toutes les variables : voir le guide (docs/guide.*.md, § Configuration).
${agent ? `AGENT_BIN=${agent.chemin}
AGENT_ARGS=${agent.args}`
    : `# Aucun agent trouvé (ni claude, ni copilot) : l'écran le dira, et tourne en simulé d'ici là.
AGENT_BIN=claude
AGENT_ARGS=`}
# 1 = rapports simulés, aucun appel à l'IA (essais, démonstration).
COPILOT_DRY_RUN=0
PORT=4319
# Cloner en SSH (avec ta clé) plutôt qu'en HTTPS avec le jeton :
# GIT_CLONE_SSH=1
`;
}

/** Écrit le `.env` s'il n'y en a pas. Rend ce qu'il faut annoncer, ou `null` s'il existait. */
const FICHIER_ENV_UTILISATEUR = path.join(os.homedir(), '.mergerie', '.env');
function creerEnvSiAbsent() {
  const cible = FICHIER_ENV_UTILISATEUR;
  if (fs.existsSync(cible)) return null;
  const agent = trouverAgent();
  try {
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    /* `wx` : on n'écrase JAMAIS. Entre le test ci-dessus et l'écriture il peut s'être passé
       quelque chose, et un `.env` peut contenir des jetons. */
    fs.writeFileSync(cible, contenuEnv(agent), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    /* Dossier en lecture seule, droits, course : on ne bloque pas le démarrage pour ça. */
    return { erreur: e.message, cible };
  }
  return { cible, agent };
}

/* LES DEUX `.env` SE LISENT ICI. Le serveur charge celui du dossier courant lui-même
   (`--env-file-if-exists`), mais trop tard pour MERGERIE_DATA_DIR : la ligne d'après a déjà posé
   son défaut dans l'environnement de l'enfant, et `--env-file` ne réécrit pas une variable déjà
   présente. Priorité, de la plus forte à la plus faible : le shell, le `.env` du dossier
   courant, `~/.mergerie/.env`. */
/* On l'écrit AVANT de le lire — c'est tout l'objet de l'opération : le premier lancement doit
   partir avec les bons réglages, pas au lancement suivant. */
const neuf = demo ? null : creerEnvSiAbsent();
if (neuf && neuf.erreur) {
  console.warn(`⚠ .env non créé (${neuf.cible}) : ${neuf.erreur} — l'outil démarre avec les valeurs par défaut.`);
} else if (neuf) {
  console.log(neuf.agent
    ? `.env créé (${neuf.cible}) : agent « ${neuf.agent.bin} » (${neuf.agent.chemin}), port 4319.`
    : `.env créé (${neuf.cible}) — mais NI claude NI copilot n'ont été trouvés : l'écran le dira, et les rapports seront simulés d'ici là.`);
}

const duShell = { ...process.env };
try { process.loadEnvFile(); } catch { /* pas de `.env` dans ce dossier : le cas courant */ }
const duDossier = { ...process.env };
try { process.loadEnvFile(FICHIER_ENV_UTILISATEUR); } catch { /* pas encore écrit (démo), ou illisible */ }
Object.assign(process.env, duDossier, duShell);

const env = { ...process.env };
env.MERGERIE_DATA_DIR = env.MERGERIE_DATA_DIR || path.join(os.homedir(), '.mergerie', demo ? 'demo' : 'data');
if (demo) Object.assign(env, { MERGERIE_DEMO: '1', COPILOT_DRY_RUN: '1' });
/* LA DÉMO EFFACE SON DOSSIER avant de le resemer. Tant que le `.env` était ignoré, ce dossier
   était toujours ~/.mergerie/demo ; il peut désormais venir du fichier, alors on le NOMME. */
if (demo) console.log(`démo : ${env.MERGERIE_DATA_DIR} est effacé, puis resemé`);

const nodeArgs = (file) => ['--env-file-if-exists=.env', path.join(ROOT, file)];
if (demo) {
  const seed = spawnSync(process.execPath, nodeArgs(path.join('scripts', 'demo-seed.js')), { stdio: 'inherit', env });
  if (seed.status !== 0) process.exit(seed.status || 1);
}
const server = spawn(process.execPath, nodeArgs(path.join('src', 'server.js')), { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => server.kill(sig));
server.on('exit', (code, signal) => process.exit(code === null ? (signal ? 130 : 1) : code));
