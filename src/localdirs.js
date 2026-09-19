'use strict';
/* LE DOSSIER LOCAL D'UNE SESSION HORS DÉPÔT — désigné partout, résolu chez soi.
 *
 * « Codage hors dépôt » fait travailler l'agent EN PLACE dans un dossier de la machine. Ce
 * dossier n'existe que là : `/Users/amady/lin/monprojet` ne désigne rien sur le Linux du
 * collègue. La session, elle, mérite d'être partagée — ses passes se relisent, son verdict
 * compte, et c'est souvent elle qu'on veut montrer.
 *
 * On sépare donc ce qui VOYAGE de ce qui RESTE :
 *   `dir_hash`  — l'empreinte du chemin normalisé. Elle voyage, et elle ne dit rien du chemin :
 *                 ni l'arborescence de la machine, ni le nom de l'utilisateur.
 *   `dir_label` — le dernier segment (« monprojet »). Il voyage, pour que la carte dise quelque
 *                 chose chez le voisin plutôt que d'afficher une ligne vide.
 *   `owner`     — l'identité git de celui qui a créé la session.
 *   le chemin   — reste dans `local_dir_map`, sur le poste qui le connaît.
 *
 * Un autre poste peut RATTACHER son propre dossier à la même empreinte (« c'est ce dossier chez
 * moi ») : il n'écrit alors que dans sa table à lui, et rien ne part nulle part.
 */
const db = require('./db');
const { normaliser, empreinte, libelle } = require('./core/dirhash');

const majCarte = db.prepare(`INSERT INTO local_dir_map (dir_hash, path, updated_at)
                             VALUES (?, ?, ?)
                             ON CONFLICT (dir_hash) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`);

/**
 * Déclare un dossier de CE poste et rend ce qui doit être stocké sur la ligne partagée.
 * @returns {{ dir_hash: string, dir_label: string }}
 */
function declarer(p) {
  const chemin = normaliser(p);
  const h = empreinte(chemin);
  majCarte.run(h, chemin, new Date().toISOString());
  return { dir_hash: h, dir_label: libelle(chemin) };
}

/** Le chemin de ce dossier SUR CE POSTE, ou `null` s'il appartient à quelqu'un d'autre. */
function cheminDe(dirHash) {
  if (!dirHash) return null;
  const r = db.prepare('SELECT path FROM local_dir_map WHERE dir_hash = ?').get(String(dirHash));
  return r ? r.path : null;
}

/** `dir_hash -> path` d'un coup : une liste de sessions ne fait pas une requête par dossier. */
function carte() {
  const m = new Map();
  for (const r of db.prepare('SELECT dir_hash, path FROM local_dir_map').all()) m.set(r.dir_hash, r.path);
  return m;
}

/** Recolle le chemin sur une ligne `local_task_dir` — `path` reste le champ que tout lit. */
const resoudre = (d, m = null) => (d
  ? { ...d, path: (m || carte()).get(d.dir_hash) || null }
  : d);

module.exports = { empreinte, libelle, normaliser, declarer, cheminDe, carte, resoudre };
