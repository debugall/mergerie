'use strict';
const path = require('path');
const fs = require('fs');

// La racine du projet : ce fichier vit dans `src/core/`, deux niveaux sous elle.
const ROOT = path.resolve(__dirname, '..', '..');

// Rétrocompatibilité des variables d'environnement renommées (anciennement `LIN_*`). Si la
// nouvelle est absente mais l'ancienne présente, on adopte l'ancienne et on prévient UNE SEULE
// fois. Résolu ici car `paths.js` est chargé très tôt (avant les modules qui lisent le flag démo).
const ENV_RENAMES = [['MERGERIE_DATA_DIR', 'LIN_DATA_DIR'], ['MERGERIE_DEMO', 'LIN_DEMO']];
const _deprecatedEnv = [];
for (const [nom, ancien] of ENV_RENAMES) {
  if (process.env[nom] == null && process.env[ancien] != null) {
    process.env[nom] = process.env[ancien];
    _deprecatedEnv.push(`${ancien} → ${nom}`);
  }
}
if (_deprecatedEnv.length) {
  console.warn(`⚠ Variable(s) d'environnement dépréciée(s), à renommer : ${_deprecatedEnv.join(', ')}.`);
}

// Dossier de données isolable via MERGERIE_DATA_DIR (utile pour les tests, pour ne
// JAMAIS toucher la base de production `data/`). Défaut = data/ du projet.
const DATA_DIR = process.env.MERGERIE_DATA_DIR ? path.resolve(process.env.MERGERIE_DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'reviewer.db');
const DEFAULT_CLONE_DIR = path.join(DATA_DIR, 'clones');
const REVIEWS_DIR = path.join(DATA_DIR, 'reviews');
const TICKETS_DIR = path.join(DATA_DIR, 'tickets');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
// Captures collées dans une page de notes : un sous-dossier par page.
const NOTES_DIR = path.join(DATA_DIR, 'notes');
// Un dossier par agent de domaine : ses versions de connaissance (`knowledge-v<N>.md`).
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
/* LE DÉPÔT DE DONNÉES PARTAGÉ. Un dossier de fichiers texte qui, à terme, EST la base : une
   entité = un fichier, format déterministe, et git par-dessus pour qu'une équipe se le passe.
   Il vit sous `DATA_DIR` comme le reste, et non ailleurs sur le disque : une sauvegarde du
   dossier de données doit continuer de tout emporter. */
const SHARED_DIR = path.join(DATA_DIR, 'shared');

// Le dossier de connaissance d'un agent, créé à la demande.
function agentsDir(agentId) { return ensureDir(path.join(AGENTS_DIR, String(agentId))); }

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function initDirs() {
  /* LE DOSSIER DE DONNÉES EST À SOI : la base, les jetons de poste, les rapports. Créé avec
     l'umask par défaut, il était lisible par tous les comptes de la machine. `0700` à la
     création — un dossier qui existe déjà garde les droits que son propriétaire lui a donnés. */
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  ensureDir(DEFAULT_CLONE_DIR);
  ensureDir(REVIEWS_DIR);
  ensureDir(TICKETS_DIR);
  ensureDir(TASKS_DIR);
  ensureDir(NOTES_DIR);
  ensureDir(TMP_DIR);
  ensureDir(AGENTS_DIR);
  ensureDir(SHARED_DIR);
}

// slug sûr pour un chemin de dossier à partir d'un "group/sub/project"
function slugify(project) {
  return String(project)
    .replace(/[^a-zA-Z0-9._/-]/g, '_')
    .replace(/\//g, '__');
}

module.exports = {
  ROOT, DATA_DIR, DB_PATH, DEFAULT_CLONE_DIR, REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, AGENTS_DIR, SHARED_DIR,
  agentsDir,
  ensureDir, initDirs, slugify,
};
