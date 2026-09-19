'use strict';
/* Enregistrer les pièces jointes d’une session — images collées et fichiers —, avec leurs bornes.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const i18n = require('../../core/i18n');
const { t } = i18n;
const pieces = require('../../agent/pieces');
const path = require('path');
const fs = require('fs');

/* ---------- PIÈCES JOINTES D'UNE SESSION ----------
   Captures ET documents, un seul mécanisme : pour l'agent, une capture d'écran et un PDF de
   spécification sont la même chose — un fichier à ouvrir. La distinction ne vaut qu'à
   l'affichage (vignette ou nom de fichier), pas ici.

   Le nom donné par le navigateur ne sert QU'À L'AFFICHAGE et au prompt : le fichier écrit sur
   disque porte un nom fabriqué. Un nom venu de l'extérieur n'a rien à faire dans un chemin —
   `../../.ssh/config` est un nom de fichier valide pour un formulaire. */
const PJ_MAX_OCTETS = 10 * 1024 * 1024;
/* Ce qu'on accepte, par EXTENSION. Une liste fermée dit clairement non plutôt que d'accepter
   n'importe quoi et de laisser l'agent découvrir un binaire qu'il ne sait pas ouvrir. */
const PJ_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'log',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);
const PJ_SCOPES = { task: (id) => path.join(TASKS_DIR, String(id)), local: (id) => path.join(TASKS_DIR, 'local', String(id)), ask: (id) => path.join(TASKS_DIR, 'ask', String(id)) };
function decodeDataUrlImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { ext, buf: Buffer.from(m[2], 'base64') };
}
/* Une pièce arrive en `{ name, data }` (data URL). L'extension est lue sur le NOM — le type
   MIME annoncé par le navigateur varie d'un poste à l'autre pour un même .docx, et se refuser
   à ouvrir un fichier parce que Windows l'a déclaré `application/octet-stream` serait absurde. */
function decodePiece(piece) {
  const nom = String((piece && piece.name) || '').trim();
  const data = String((piece && piece.data) || '');
  const m = /^data:([^;,]*);base64,(.+)$/i.exec(data);
  if (!m) throw new Error(t('err.piece.invalide', { name: nom || '?' }));
  const ext = (nom.split('.').pop() || '').toLowerCase();
  if (!nom || !PJ_EXTENSIONS.has(ext)) throw new Error(t('err.piece.type', { name: nom || '?' }));
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > PJ_MAX_OCTETS) throw new Error(t('err.piece.trop-grosse', { name: nom, mo: Math.round(PJ_MAX_OCTETS / 1024 / 1024) }));
  return { ext, buf, nom, mime: m[1] || null };
}
/* `followup` : la pièce illustre une demande de SUIVI, pas la consigne initiale. Les ids rendus
   permettent de n'attacher QUE celles-là au prompt de ce suivi — les pièces d'un suivi passé
   parleraient d'autre chose. */
function savePieces(scope, ownerId, pieces, { followup = 0 } = {}) {
  if (!Array.isArray(pieces) || !pieces.length) return [];
  const dossier = PJ_SCOPES[scope];
  if (!dossier) throw new Error(`scope de pièce jointe inconnu : ${scope}`);
  const dir = ensureDir(dossier(ownerId));
  const ins = db.prepare(`INSERT INTO piece_jointe (scope, owner_id, path, name, mime, followup, created_at)
    VALUES (?,?,?,?,?,?,?)`);
  const ids = [];
  for (const piece of pieces) {
    const { ext, buf, nom, mime } = decodePiece(piece);
    const n = db.prepare('SELECT COUNT(*) c FROM piece_jointe WHERE scope = ? AND owner_id = ?').get(scope, ownerId).c + 1;
    const file = path.join(dir, `pj_${n}.${ext}`);
    fs.writeFileSync(file, buf);
    ids.push(ins.run(scope, ownerId, file, nom, mime, followup ? 1 : 0, new Date().toISOString()).lastInsertRowid);
  }
  return ids;
}
/* Les captures collées gardent leur chemin d'entrée (`images: [dataUrl]`) : le formulaire les
   envoie sans nom, puisqu'elles viennent du presse-papiers. On leur en fabrique un — il faut
   bien nommer ce qu'on donne à l'agent. */
function saveImagesAsPieces(scope, ownerId, images, opts) {
  if (!Array.isArray(images) || !images.length) return [];
  const n0 = db.prepare('SELECT COUNT(*) c FROM piece_jointe WHERE scope = ? AND owner_id = ?').get(scope, ownerId).c;
  return savePieces(scope, ownerId, images.map((dataUrl, i) => {
    const { ext } = decodeDataUrlImage(dataUrl);
    return { name: `capture-${n0 + i + 1}.${ext}`, data: dataUrl };
  }), opts);
}
// Tout ce qu'un formulaire peut envoyer : des captures collées et des fichiers choisis.
const savePiecesEtImages = (scope, ownerId, body, opts) => [
  ...saveImagesAsPieces(scope, ownerId, (body && body.images) || [], opts),
  ...savePieces(scope, ownerId, (body && body.files) || [], opts),
];
const piecesDe = (scope, ownerId) => db
  .prepare('SELECT id, path, name, mime, followup FROM piece_jointe WHERE scope = ? AND owner_id = ? ORDER BY id')
  .all(scope, Number(ownerId) || 0);
/* CE QUE L'ÉCRAN A LE DROIT DE VOIR d'une pièce jointe : de quoi l'afficher (un nom, un type),
   de quoi la demander (son id), et à quelle passe elle appartient — la consigne initiale (0) ou
   un suivi. Jamais le `path` : c'est un chemin sur le disque de la machine, il ne sert à rien
   au navigateur et il n'a rien à faire dans une réponse HTTP. */
const piecesExposees = (scope, ownerId) => piecesDe(scope, ownerId)
  .map((pj) => ({ id: pj.id, name: pj.name, mime: pj.mime, followup: pj.followup || 0 }));
/* SERVIR ET RETIRER une pièce jointe, quelle que soit la saveur de session. Une seule paire de
   routes pour les quatre : c'est la même table, le même disque et le même geste à l'écran — trois
   variantes finiraient par diverger, et l'une des trois par ne pas supprimer le fichier. */
const PJ_SCOPES_LUS = new Set(['task', 'local', 'ask']);
const pieceDemandee = (req) => (PJ_SCOPES_LUS.has(req.params.scope)
  ? db.prepare('SELECT * FROM piece_jointe WHERE id = ? AND scope = ?').get(Number(req.params.id), req.params.scope)
  : null);

module.exports = {
  PJ_MAX_OCTETS, PJ_EXTENSIONS, PJ_SCOPES, decodeDataUrlImage, decodePiece, savePieces, saveImagesAsPieces, savePiecesEtImages, piecesDe, piecesExposees, PJ_SCOPES_LUS, pieceDemandee,
};
