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
if (arg && arg !== 'demo') {
  console.error(`usage : mergerie [demo]\n  demo   base fictive, IA simulée, aucun jeton\n  (rien) l'outil sur ~/.mergerie/data — MERGERIE_DATA_DIR pour choisir ailleurs`);
  process.exit(arg === '--help' || arg === '-h' ? 0 : 2);
}
const demo = arg === 'demo';

/* ---------------------------------------------------------------- le `.env` du premier jour
 *
 * SANS `.env`, L'OUTIL DÉMARRE MAIS NE SAIT PAS APPELER L'IA. `COPILOT_BIN` vaut « copilot »
 * par défaut ; qui a installé Claude Code n'a pas ce binaire, l'outil bascule en dry-run (des
 * rapports simulés) et chaque review rend un texte factice. Depuis un clone on copie
 * `.env.example` — sous `npx` il n'y a pas de clone, donc rien à copier, et rien ne dit où le
 * fichier devrait aller. Node 20 ajoute même une ligne déroutante au démarrage :
 * « .env not found. Continuing without it. »
 *
 * On en écrit donc un, une seule fois, DANS LE DOSSIER COURANT — là où la commande le relira
 * au prochain lancement —, et on dit ce qu'on a créé : un fichier qui apparaît en silence dans
 * le dossier de quelqu'un est une surprise, pas un service.
 *
 * PAS EN MODE DÉMO : « npx mergerie demo » promet de ne rien installer et de ne rien laisser.
 */
const CANDIDATS = [
  { bin: 'claude', args: '--dangerously-skip-permissions' },
  { bin: 'copilot', args: '--yolo --model claude-sonnet-5' },
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
  const autre = CANDIDATS.find((c) => !agent || c.bin !== agent.bin) || CANDIDATS[1];
  return `# Réglages de Mergerie pour CE DOSSIER, écrits au premier lancement.
# La commande relit ce fichier à chaque démarrage depuis ici : reviens dans ce dossier, ou
# emporte le fichier avec toi. La liste complète des variables est dans le guide.

# ─────────────────────────────────────────────────────────────────────────────────────────
#  L'AGENT IA, ET CE QU'IL A LE DROIT DE FAIRE — à lire une fois.
#
#  \`--dangerously-skip-permissions\` (claude) et \`--yolo\` (copilot) laissent l'agent agir sans
#  rien demander. Ce n'est pas du confort : Mergerie l'appelle en NON-INTERACTIF
#  (\`<bin> [args] -p "<prompt>"\`, sortie capturée), et personne n'est là pour répondre à une
#  demande de permission. Sans ces options, le travail se bloque — ou, pire, tout ce qui
#  demanderait est refusé SANS UN MOT et le rapport revient plus pauvre sans qu'on sache
#  pourquoi.
#
#  CE QUE ÇA VEUT DIRE QUAND MÊME. L'agent tourne avec TES droits. Il travaille dans le clone
#  du dépôt relu, et c'est Mergerie qui fait le git — commit, push —, pas lui ; mais l'option
#  ne construit AUCUN MUR autour de ce dossier. Et ce qu'il lit — un diff, un ticket — n'est
#  pas écrit par toi.
# ─────────────────────────────────────────────────────────────────────────────────────────

${agent ? `# L'agent IA trouvé sur cette machine au moment de la création.
COPILOT_BIN=${agent.chemin}
COPILOT_ARGS=${agent.args}`
    : `# AUCUN AGENT TROUVÉ sur cette machine (ni claude, ni copilot). Tant que ce chemin est
# faux, Mergerie tourne en dry-run : les rapports sont simulés, aucun appel n'est fait.
COPILOT_BIN=claude
COPILOT_ARGS=--dangerously-skip-permissions`}
${(!agent || agent.bin === 'claude') ? `
# PLUS ÉTROIT, SI TU PRÉFÈRES : REMPLACE la ligne ci-dessus par celle-ci (n'en laisse qu'une,
# sinon la dernière lue gagne en silence). Les éditions de fichiers sont acceptées, le reste
# est refusé.
# Le prix est écrit plus haut : sous \`-p\`, un refus est MUET. Une review qui ne peut plus
# lire l'historique git rend un rapport plus faible, et rien ne le signale.
# COPILOT_ARGS=--permission-mode acceptEdits
` : ''}
# Pour l'autre agent, remplacer les deux lignes ci-dessus par :
# COPILOT_BIN=${autre.bin}
# COPILOT_ARGS=${autre.args}

# 0 = l'IA est vraiment appelée. 1 = rapports simulés, aucun appel (essais, démonstration).
COPILOT_DRY_RUN=0
# Durée maximale d'UN appel à l'agent, en millisecondes. 3600000 = une heure.
COPILOT_TIMEOUT_MS=3600000

PORT=4319

# Cloner en SSH (avec ta clé) au lieu d'HTTPS avec le jeton. À décommenter si ta forge
# n'accepte que SSH.
# GIT_CLONE_SSH=1

# ⚠ CERTIFICATS. Ces deux lignes DÉSACTIVENT la vérification TLS du service concerné : à ne
# décommenter que derrière un proxy d'entreprise qui remplace les certificats, et de préférence
# après avoir essayé NODE_EXTRA_CA_CERTS avec le certificat de l'entreprise, qui garde la
# vérification. Livrées commentées : personne ne doit désactiver TLS sans l'avoir voulu.
# GITLAB_INSECURE_TLS=1
# JENKINS_INSECURE_TLS=1
`;
}

/** Écrit le `.env` s'il n'y en a pas. Rend ce qu'il faut annoncer, ou `null` s'il existait. */
function creerEnvSiAbsent() {
  const cible = path.resolve('.env');
  if (fs.existsSync(cible)) return null;
  const agent = trouverAgent();
  try {
    /* `wx` : on n'écrase JAMAIS. Entre le test ci-dessus et l'écriture il peut s'être passé
       quelque chose, et un `.env` contient des jetons. */
    fs.writeFileSync(cible, contenuEnv(agent), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    /* Dossier en lecture seule, droits, course : on ne bloque pas le démarrage pour ça. */
    return { erreur: e.message, cible };
  }
  return { cible, agent };
}

/* LE `.env` DU DOSSIER COURANT SE LIT ICI AUSSI. Le serveur le charge lui-même
   (`--env-file-if-exists`), mais trop tard pour MERGERIE_DATA_DIR : la ligne d'après a déjà posé
   son défaut dans l'environnement de l'enfant, et `--env-file` ne réécrit pas une variable déjà
   présente. Un `.env` demandant un autre dossier de données était donc lu — et ignoré, en
   silence, pendant que la base partait dans ~/.mergerie. On garde la règle de priorité de Node :
   ce que le shell exporte l'emporte sur le fichier. */
/* On l'écrit AVANT de le lire — c'est tout l'objet de l'opération : le premier lancement doit
   partir avec les bons réglages, pas au lancement suivant. */
const neuf = demo ? null : creerEnvSiAbsent();
if (neuf && neuf.erreur) {
  console.warn(`⚠ .env non créé (${neuf.cible}) : ${neuf.erreur} — l'outil démarre avec les valeurs par défaut.`);
} else if (neuf) {
  console.log(neuf.agent
    ? `.env créé dans ce dossier : agent « ${neuf.agent.bin} » (${neuf.agent.chemin}), port 4319. À relire avant de commencer.`
    : '.env créé dans ce dossier — mais NI claude NI copilot n\'ont été trouvés : ouvre-le et corrige COPILOT_BIN, sinon les rapports seront simulés.');
}

const duShell = { ...process.env };
try { process.loadEnvFile(); } catch { /* pas de `.env` dans ce dossier : le cas courant */ }
Object.assign(process.env, duShell);

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
