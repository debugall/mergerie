'use strict';
/* Écriture d'archives ZIP, sans dépendance.
 *
 * Node sait déjà compresser (`zlib`) ; il ne sait pas empaqueter. Ces quelque cent lignes
 * suffisent, et évitent d'ajouter une bibliothèque à un projet qui en compte trois.
 * Deux usages : l'export `.docx` d'une réponse d'agent (un `.docx` EST un ZIP) et la
 * sauvegarde des données.
 *
 * Tout est assemblé en mémoire : c'est adapté à des archives de quelques dizaines de Mo,
 * pas à des sauvegardes de plusieurs giga-octets — les appelants doivent donc borner ce
 * qu'ils y mettent, et le dire quand ils écartent quelque chose.
 */

const zlib = require('zlib');

/* ---------------------------------------------------------------- ZIP (le format .docx) */

// Table CRC-32, calculée une fois : le format ZIP l'exige pour chaque entrée.
const TABLE_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ TABLE_CRC[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/* Écrit un ZIP à partir de [{ nom, data }]. Pas d'horodatage réel : une date fixe rend
   l'export REPRODUCTIBLE (deux exports du même contenu donnent le même fichier), ce qui
   se teste — et Word ne regarde pas ces dates. */
function zipper(entrees) {
  const locaux = [];
  const centraux = [];
  let offset = 0;

  for (const { nom, data } of entrees) {
    const nomBuf = Buffer.from(nom, 'utf8');
    const compresse = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const enTete = Buffer.alloc(30);
    enTete.writeUInt32LE(0x04034b50, 0);   // signature
    enTete.writeUInt16LE(20, 4);           // version minimale
    enTete.writeUInt16LE(0, 6);            // drapeaux
    enTete.writeUInt16LE(8, 8);            // méthode : deflate
    enTete.writeUInt16LE(0, 10);           // heure (fixe)
    enTete.writeUInt16LE(0x21, 12);        // date (fixe : 1980-01-01)
    enTete.writeUInt32LE(crc, 14);
    enTete.writeUInt32LE(compresse.length, 18);
    enTete.writeUInt32LE(data.length, 22);
    enTete.writeUInt16LE(nomBuf.length, 26);
    enTete.writeUInt16LE(0, 28);           // pas de champ « extra »
    locaux.push(enTete, nomBuf, compresse);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version d'écriture
    central.writeUInt16LE(20, 6);          // version minimale
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compresse.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nomBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // commentaire
    central.writeUInt16LE(0, 34);          // disque
    central.writeUInt16LE(0, 36);          // attributs internes
    central.writeUInt32LE(0, 38);          // attributs externes
    central.writeUInt32LE(offset, 42);
    centraux.push(central, nomBuf);

    offset += enTete.length + nomBuf.length + compresse.length;
  }

  const corps = Buffer.concat(locaux);
  const annuaire = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(annuaire.length, 12);
  fin.writeUInt32LE(corps.length, 16);
  fin.writeUInt16LE(0, 20);
  return Buffer.concat([corps, annuaire, fin]);
}

module.exports = { zipper, crc32 };
