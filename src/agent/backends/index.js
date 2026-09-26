'use strict';
/* LES BACKENDS D'AGENT, DERRIÈRE UNE SEULE PORTE.
 *
 * Deux CLI étaient câblés en vingt et une branches `if (backend === …)` réparties sur onze
 * fichiers ; un troisième était « unknown », donc refusé ou lancé sans politique. Ce registre
 * dit, pour chaque CLI, ce qui diffère VRAIMENT de l'un à l'autre — comment se dit sa lecture
 * seule, comment se borne son écriture, comment se passe le prompt, s'il sait reprendre une
 * session, quelles variables d'environnement il exige — et le reste du code ne pose plus que
 * deux questions : `pour(id)` et `detecter(bin)`.
 *
 * Le NIVEAU DE GARANTIE d'un backend (`niveau`) est ce que l'écran affiche à côté de son nom,
 * et ce que le journal d'un run écrit en première ligne :
 *   — `prouve`  : la sandbox du CLI a été VUE bloquer une écriture hors dossier et un appel
 *                 réseau sur cette machine (« Tester le sandbox ») ;
 *   — `declare` : un mode lecture seule ou une sandbox existent dans le CLI (`--restricted`,
 *                 `--sandbox read-only`, `--deny-tool`) mais rien ne les a prouvés ici — le
 *                 contrôle d'intégrité après coup (`git/integrite.js`) fait foi ;
 *   — `allege`  : rien de tout cela (un CLI maison, un modèle local) — l'agent tourne tel
 *                 quel, le contrôle après coup seul, et l'écran le dit avant le lancement.
 * Aucun niveau ne BLOQUE un CLI : la sonde qui ne passe pas fait descendre d'un cran, jamais
 * refuser. Ce qui n'est jamais allégé : le jeton de forge hors du clone, l'API fermée par le
 * jeton local, l'environnement en liste blanche.
 *
 * Les argv de claude et copilot restent dans `policy.js` — c'est là que les tests et le
 * contrôle `sansModeLarge` de `npm run check` les prouvent ; codex, gemini et le backend
 * générique vivent ici. Ce dossier n'importe que `core/` et ses voisins de `agent/`. */
const { spawnSync } = require('node:child_process');

const claude = require('./claude');
const copilot = require('./copilot');
const codex = require('./codex');
const gemini = require('./gemini');
const generic = require('./generic');

const REGISTRE = { claude, copilot, codex, gemini };
const IDS = Object.keys(REGISTRE);
const NIVEAUX = ['prouve', 'declare', 'allege'];

/** Le module d'un backend par son id ; `unknown` (ou inconnu) rend le générique. */
function pour(id) { return REGISTRE[id] || generic; }

/* Le backend choisi EXPLICITEMENT — Réglages → Session IA (`agent_backend`), sinon
   `AGENT_BACKEND` — l'emporte sur la détection : un wrapper maison autour de claude peut
   dire « claude ». `auto` (le défaut) laisse la détection décider. */
function choixExplicite() {
  let v = '';
  // Le profil du lancement en cours (`agent/cli.js`) dit le sien ; `auto` laisse deviner.
  const profil = require('../cli').courant();
  if (profil) v = String(profil.backend || '').trim();
  else { try { const { getConfig } = require('../../data/config'); v = String(getConfig().agent_backend || '').trim(); } catch { /* base pas encore là */ } }
  if (!v || v === 'auto') v = String(process.env.AGENT_BACKEND || '').trim();
  return IDS.includes(v) ? v : (v === 'generic' ? 'unknown' : '');
}

/* La détection : `--version` d'abord (un wrapper neutre qui relaie à claude se reconnaît à
   ce qu'il répond, pas à son nom), le nom du binaire en repli, `unknown` sinon — jamais un
   fail-open. */
function detecter(bin) {
  const explicite = choixExplicite();
  if (explicite) return explicite;
  const b = String(bin || '');
  let sortie = '';
  try { sortie = String(spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout || ''); } catch { /* absent */ }
  for (const id of IDS) if (REGISTRE[id].version.test(sortie)) return id;
  const low = b.toLowerCase().split(/[\\/]/).pop();
  for (const id of IDS) if (REGISTRE[id].nom.test(low)) return id;
  return 'unknown';
}

/** Le niveau de garantie d'un lancement, pour un backend et les capacités lues dans son `--help`. */
function niveau(id, cap, cfg) {
  const n = pour(id).niveau(cap || {}, cfg || {});
  return NIVEAUX.includes(n) ? n : 'allege';
}

module.exports = { pour, detecter, niveau, IDS, NIVEAUX, REGISTRE, generic };
