'use strict';
/* LE COFFRE DES JETONS (Réglages → Sécurité). Une ligne, de CE poste : rien ici ne part dans le dépôt
   partagé. Coffre inactif (`actif = 0`), les jetons restent où ils ont toujours été — `local_config`
   et `plugin_secret`. Actif, ces deux endroits sont vides et tout est ici, chiffré : `donnees` est le
   JSON `{ coeur, plugins, totp }` en AES-256-GCM, `iv` et `tag` ses compagnons, `sel` et `kdf` (les
   paramètres scrypt, en JSON) ce qu'il faut pour redériver la clé du mot de passe maître. La clé, elle,
   n'est jamais écrite : `src/data/coffre.js` la garde en mémoire tant que Mergerie tourne.
   `totp` dit seulement si la 2FA est demandée — son secret est DANS `donnees`. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS coffre (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  actif INTEGER NOT NULL DEFAULT 0,
  kdf TEXT NOT NULL DEFAULT '',
  sel TEXT NOT NULL DEFAULT '',
  iv TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  donnees TEXT NOT NULL DEFAULT '',
  totp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
)`);
db.prepare('INSERT OR IGNORE INTO coffre (id) VALUES (1)').run();
