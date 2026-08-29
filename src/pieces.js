'use strict';
/* PIÈCES JOINTES D'UNE SESSION — captures d'écran ET documents.
 *
 * Pour l'agent, une capture et un PDF de spécification sont la même chose : un fichier à ouvrir.
 * Une seule table (`piece_jointe`, avec un `scope` comme `agent_pass`), une seule sélection, un
 * seul bloc de prompt — les quatre saveurs de session s'en servent à l'identique, au lieu de
 * quatre câblages qui auraient dérivé.
 *
 * Deux règles portées ici, et pas ailleurs :
 *   — on joint les pièces de la CONSIGNE INITIALE, plus celles du suivi en cours (`ids`). Celles
 *     d'un suivi passé illustraient une autre demande : les renvoyer ferait dire au prompt
 *     « voici les pièces jointes » en montrant autre chose ;
 *   — le fichier est COPIÉ à côté de l'agent quand celui-ci travaille dans un clone (il ne voit
 *     que son dossier de travail), et référencé par son chemin absolu quand il travaille en
 *     place — copier dans le dossier de l'utilisateur y laisserait des traces.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { t } = require('../public/i18n-runtime.js');

// Les pièces à joindre à CETTE passe : celles de la consigne, plus celles du suivi en cours.
function pourLaPasse(scope, ownerId, ids = []) {
  const suivi = (ids || []).map(Number).filter(Number.isInteger);
  const base = db.prepare(`SELECT * FROM piece_jointe
    WHERE scope = ? AND owner_id = ? AND followup = 0 ORDER BY id`).all(scope, ownerId);
  const duSuivi = suivi.length
    ? db.prepare(`SELECT * FROM piece_jointe WHERE scope = ? AND owner_id = ? AND id IN (${suivi.map(() => '?').join(',')})`)
      .all(scope, ownerId, ...suivi)
    : [];
  return [...base, ...duSuivi].filter((p) => { try { return fs.existsSync(p.path); } catch { return false; } });
}

/* Le bloc à coller au prompt. `dest` = dossier où copier les fichiers (clone de l'agent) ; sans
   lui, on donne les chemins absolus tels quels. Le NOM D'ORIGINE accompagne le chemin : « le
   devis du client » est ce que l'utilisateur a joint, `pj_2.pdf` ce que le disque en a fait. */
function blocPrompt(scope, ownerId, { ids = [], dest = null, sousDossier = '', onLog = () => {} } = {}) {
  const pieces = pourLaPasse(scope, ownerId, ids);
  if (!pieces.length) return '';
  const lignes = [];
  pieces.forEach((p, i) => {
    if (!dest) { lignes.push(`\n- \`${p.path}\` (${p.name})`); return; }
    /* Déjà DANS le dossier de l'agent (c'est le cas d'une question libre, dont le répertoire de
       travail est aussi celui des pièces) : on la nomme telle qu'elle est. Recopier créerait un
       doublon sous un autre numéro, et l'agent verrait deux fois le même document. */
    const dedans = path.relative(dest, p.path);
    if (dedans && !dedans.startsWith('..') && !path.isAbsolute(dedans)) {
      lignes.push(`\n- \`${dedans}\` (${p.name})`);
      return;
    }
    const rel = `${sousDossier ? `${sousDossier}/` : ''}pj_${i + 1}${path.extname(p.path)}`;
    try {
      fs.copyFileSync(p.path, path.join(dest, rel));
      lignes.push(`\n- \`${rel}\` (${p.name})`);
    } catch { /* une pièce illisible ne doit pas faire échouer la session */ }
  });
  if (!lignes.length) return '';
  onLog(t('log.task.images', { n: lignes.length, count: lignes.length }));
  return `\n\n${t('prompt.pieces-jointes')}${lignes.join('')}`;
}

// Ménage à la suppression d'une session : pas de clé étrangère possible (trois tables parentes).
function removeOwner(scope, ownerId) {
  for (const p of db.prepare('SELECT path FROM piece_jointe WHERE scope = ? AND owner_id = ?').all(scope, ownerId)) {
    try { fs.rmSync(p.path, { force: true }); } catch { /* déjà parti */ }
  }
  db.prepare('DELETE FROM piece_jointe WHERE scope = ? AND owner_id = ?').run(scope, ownerId);
}

module.exports = { pourLaPasse, blocPrompt, removeOwner };
