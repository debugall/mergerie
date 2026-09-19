'use strict';
/* Le nom de fichier d’un objet qu’on nomme : le `slug`, repris sur l’existant.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');
const { slugLibre } = require('../../core/ulid');

/* ---------- LE NOM DE FICHIER D'UN OBJET QU'ON NOMME : `slug` ----------
 *
 * Un agent et une page de notes portent un nom lisible, et c'est lui qui doit nommer leur
 * fichier dans le dépôt partagé — `agents/documentaliste/agent.json` se relit, pas
 * `agents/01JCXZ.../agent.json`. Le slug est donc FIGÉ À LA CRÉATION : renommer l'agent ne
 * déplace pas son dossier. Sans ce gel, chaque renommage produirait chez les collègues une
 * suppression suivie d'un ajout au lieu d'un changement de titre, et l'historique git du
 * fichier — précisément ce qu'on gagne à passer par git — serait perdu à chaque fois.
 *
 * Le suffixe `-2`, `-3` règle les homonymes après normalisation (« Déploiement » et
 * « déploiement ! » donnent le même slug). Il demande une lecture de la table, donc il ne peut
 * pas vivre dans un déclencheur : `src/ulid.js` le calcule, les deux points de création
 * l'appellent, et la reprise ci-dessous rattrape tout ce qui aurait été inséré autrement —
 * l'amorçage du mode démo, par exemple, qui tourne dans son propre processus. */
for (const [table, colonne] of [['agent', 'name'], ['note_page', 'title']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN slug TEXT`); } catch { /* déjà présente */ }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_slug ON ${table}(slug)`);
  const sans = db.prepare(`SELECT id, ${colonne} AS nom FROM ${table} WHERE slug IS NULL ORDER BY id`).all();
  if (sans.length) {
    const pris = new Set(db.prepare(`SELECT slug FROM ${table} WHERE slug IS NOT NULL`).all().map((r) => r.slug));
    const poser = db.prepare(`UPDATE ${table} SET slug = ? WHERE id = ?`);
    db.transaction(() => {
      for (const ligne of sans) {
        const s = slugLibre(ligne.nom, (x) => pris.has(x));
        pris.add(s);
        poser.run(s, ligne.id);
      }
    })();
  }
}
