'use strict';
const db = require('./connexion');

/* RÉPARATION, TOUT EN HAUT, AVANT LA MOINDRE ÉCRITURE.
 *
 * `ALTER TABLE … RENAME` réécrit les références au nom de table DANS LE CORPS DES DÉCLENCHEURS.
 * Une reconstruction de la file d'export (`store_sale`) laissait donc des déclencheurs pointant
 * une table renommée puis supprimée : la première écriture venue — une simple mise à jour de la
 * configuration, quelques lignes plus bas — échouait sur « no such table », et le serveur ne
 * démarrait plus.
 *
 * On les retire ici, avant tout : ils sont recréés en fin de fichier, générés depuis le
 * registre. Une base saine n'en a aucun et ne paie rien. */
for (const t of db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%_ancien%'",
).all()) {
  db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
}

