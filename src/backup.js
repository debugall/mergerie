'use strict';
/* Sauvegarde des données — la seule chose que Mergerie ne sait pas reconstruire.
 *
 * Ce qui vit dans `data/` n'a pas la même valeur :
 *
 *   — la BASE et les FICHIERS qu'elle référence (rapports de review, retours d'agent,
 *     captures de contexte) sont le travail accumulé : des mois de reviews, de verdicts et
 *     de suivi de résolution qu'aucune commande ne régénère ;
 *   — les CLONES et les WORKTREES sont des copies de ce qui vit sur la forge. Les inclure
 *     multiplierait la taille de l'archive par cent pour sauvegarder ce qu'un `git clone`
 *     rapporte.
 *
 * D'où une archive volontairement étroite. Elle est aussi assemblée EN MÉMOIRE : au-delà
 * d'un plafond, on refuse plutôt que d'épuiser la mémoire du serveur — et on dit lequel des
 * fichiers a fait déborder, pour que ce refus soit actionnable.
 *
 * La base est copiée par l'API `backup()` de SQLite et non par une copie de fichier : une
 * copie brute pendant une écriture donne une base corrompue, qui ne se découvre qu'au jour
 * où l'on essaie de la restaurer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipper } = require('./zip');
const { DATA_DIR, DB_PATH, REVIEWS_DIR, TICKETS_DIR, TASKS_DIR } = require('./paths');

// 256 Mo : bien au-delà d'un usage normal (une base de quelques Mo, des rapports en Markdown),
// assez bas pour qu'un dossier qui aurait dérapé soit signalé au lieu de faire tomber le serveur.
const MAX_ARCHIVE = 256 * 1024 * 1024;

/* Les dossiers embarqués, avec leur raison d'être. `clones/`, `worktrees/` et `tmp/` en sont
   absents à dessein — voir l'en-tête. */
const DOSSIERS = [
  { dir: REVIEWS_DIR, nom: 'reviews' },   // rapports de review et explications
  { dir: TASKS_DIR, nom: 'tasks' },       // retours d'agent, réponses d'exploration
  { dir: TICKETS_DIR, nom: 'tickets' },   // captures jointes au contexte d'une MR
];

// Liste récursive des fichiers d'un dossier, en chemins RELATIFS à lui.
function fichiersDe(racine) {
  const out = [];
  const marcher = (rel) => {
    let entrees;
    try { entrees = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }); }
    catch { return; }                     // dossier absent : rien à sauvegarder, pas une erreur
    for (const e of entrees) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) marcher(r);
      else if (e.isFile()) out.push(r);
    }
  };
  marcher('');
  return out.sort();                      // ordre stable : deux sauvegardes identiques le restent
}

/* Copie cohérente de la base, via l'API de sauvegarde de SQLite. `db.backup()` est asynchrone
   et rend une promesse ; on écrit dans un fichier temporaire qu'on relit ensuite. */
async function copierBase(db) {
  const tmp = path.join(os.tmpdir(), `mergerie-backup-${process.pid}-${Math.floor(Date.now())}.db`);
  try {
    await db.backup(tmp);
    return fs.readFileSync(tmp);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* déjà parti */ }
  }
}

/* Construit l'archive. Rend `{ buffer, contenu }` où `contenu` décrit ce qui a été pris —
   c'est ce que l'interface affiche pour qu'on sache ce qu'on a sauvegardé, plutôt qu'un
   fichier opaque dont on découvrirait le contenu le jour de la restauration. */
async function construire(db, { maintenant = new Date() } = {}) {
  const entrees = [];
  const contenu = [];

  const base = await copierBase(db);
  entrees.push({ nom: 'reviewer.db', data: base });
  contenu.push({ nom: 'reviewer.db', fichiers: 1, octets: base.length });

  let total = base.length;
  for (const { dir, nom } of DOSSIERS) {
    const fichiers = fichiersDe(dir);
    let octets = 0;
    for (const rel of fichiers) {
      const abs = path.join(dir, rel);
      let data;
      try { data = fs.readFileSync(abs); } catch { continue; }   // fichier disparu entre-temps
      total += data.length;
      if (total > MAX_ARCHIVE) {
        const err = new Error(`sauvegarde trop volumineuse (> ${Math.round(MAX_ARCHIVE / 1024 / 1024)} Mo) — arrêtée sur ${nom}/${rel}`);
        err.status = 400;
        throw err;
      }
      octets += data.length;
      // Le séparateur d'une entrée ZIP est toujours `/`, y compris sur Windows.
      entrees.push({ nom: `${nom}/${rel.split(path.sep).join('/')}`, data });
    }
    contenu.push({ nom, fichiers: fichiers.length, octets });
  }

  /* Un mode d'emploi DANS l'archive : une sauvegarde qu'on ne sait plus restaurer ne vaut
     rien, et c'est six mois plus tard qu'on l'ouvre, sans se rappeler d'où elle vient. */
  entrees.push({ nom: 'LISEZ-MOI.txt', data: Buffer.from(modeDEmploi(maintenant, contenu), 'utf8') });

  return { buffer: zipper(entrees), contenu, octets: total };
}

function modeDEmploi(maintenant, contenu) {
  const lignes = [
    'Sauvegarde Mergerie',
    `Faite le ${maintenant.toISOString()}`,
    '',
    'CONTENU',
    ...contenu.map((c) => `  ${c.nom.padEnd(12)} ${String(c.fichiers).padStart(5)} fichier(s)  ${Math.round(c.octets / 1024)} Ko`),
    '',
    'CE QUI N’EST PAS DEDANS',
    '  Les clones git et les worktrees : ils se retrouvent avec un « git clone », et les',
    '  inclure multiplierait la taille de cette archive sans rien sauver d’irremplaçable.',
    '',
    'RESTAURER',
    '  1. Arrêter Mergerie (la base ne doit pas être écrite pendant la copie).',
    '  2. Mettre l’ancien dossier de données de côté :  mv data data.avant-restauration',
    '  3. Décompresser cette archive à sa place :       mkdir data && unzip <archive> -d data',
    '  4. Relancer Mergerie. Les clones manquants seront refaits à la demande.',
    '',
    'Le chemin du dossier de données est celui de MERGERIE_DATA_DIR, ou « data/ » par défaut.',
  ];
  return `${lignes.join('\n')}\n`;
}

// Nom de fichier daté : trier des sauvegardes par nom doit les trier par date.
const nomArchive = (maintenant = new Date()) =>
  `mergerie-${maintenant.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;

module.exports = { construire, nomArchive, fichiersDe, MAX_ARCHIVE, DATA_DIR, DB_PATH };
