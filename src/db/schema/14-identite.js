'use strict';
/* L’identité qui survit au partage : `uid` posé par déclencheur sur chaque ligne partagée.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');
const { ulid } = require('../../core/ulid');

/* ---------- L'IDENTITÉ QUI SURVIT AU PARTAGE : `uid` et `slug` ----------
 *
 * Les entiers auto-incrémentés sont LOCAUX par nature. Deux postes créent chacun le dépôt
 * n° 12 ; deux reviews de la même merge request reçoivent chacune la version 2. Dès que le
 * travail accumulé part dans un dépôt git d'équipe, ces numéros se télescopent — et il n'y a
 * personne pour arbitrer, c'est tout l'intérêt d'une synchronisation sans serveur.
 *
 * Chaque table partagée reçoit donc un `uid` : un ULID, produit sans se concerter, et TRIABLE
 * PAR DATE DE CRÉATION. C'est cette dernière propriété qui fait le travail : les numéros de
 * version (`review_version.version`), de passe (`agent_pass.n`) et de connaissance
 * (`agent_knowledge.version`) deviennent DÉRIVÉS — on les renumérote en lisant les uids dans
 * l'ordre, sans compteur partagé. Deux postes qui reviewent la même MR en même temps produisent
 * v2 et v3, jamais deux v2, et dans le même ordre chez tout le monde.
 *
 * LES 852 REQUÊTES EXISTANTES NE CHANGENT PAS : elles continuent de joindre par `id`. L'uid ne
 * sert qu'à franchir la frontière entre deux postes.
 *
 * COMMENT IL EST POSÉ. Pas par les ~100 `INSERT` de l'application — les oublier un par un est
 * précisément ce qui se produirait —, mais par un DÉCLENCHEUR par table, qui appelle la
 * fonction JS enregistrée plus haut. L'invariant est ainsi tenu par la base elle-même, y
 * compris pour les insertions du mode démo et des scripts. Contrepartie assumée : cette base
 * ne s'écrit plus depuis le `sqlite3` en ligne de commande, qui ne connaît pas `mergerie_ulid`.
 * Elle se LIT toujours, ce qui est le seul usage qu'on en fait de l'extérieur.
 *
 * Placé APRÈS tous les `CREATE TABLE` : un `ALTER TABLE` sur une table qui n'existe pas encore
 * lève, le `catch {}` l'avale, et la colonne n'existe alors que sur les bases où la table
 * préexistait. */
{
  const TABLES_UID = require('../../data/store-registry').REGISTRE.filter((e) => e.uidPropre).map((e) => e.table);
  for (const table of TABLES_UID) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`); } catch { /* déjà présente */ }

    /* REMPLISSAGE DES LIGNES EXISTANTES. On respecte l'ordre de création : l'horodatage en tête
       de l'ULID est repris de `created_at` quand la table en a un, sinon d'un compteur qui suit
       l'ordre des `rowid`. Sans cette précaution, les uids d'une base déjà en service seraient
       tous datés de la migration et leur tri serait aléatoire — or c'est ce tri qui renumérote
       les versions et les passes. Les ex æquo sont départagés par la milliseconde ajoutée. */
    const colonnes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const dateCol = ['created_at', 'started_at', 'added_at', 'at', 'ts'].find((c) => colonnes.includes(c));
    const aRemplir = db.prepare(
      `SELECT rowid AS r${dateCol ? `, ${dateCol} AS d` : ''} FROM ${table} WHERE uid IS NULL ORDER BY rowid`,
    ).all();
    if (aRemplir.length) {
      const poser = db.prepare(`UPDATE ${table} SET uid = ? WHERE rowid = ?`);
      const base = Date.now() - aRemplir.length;
      db.transaction(() => {
        aRemplir.forEach((ligne, i) => {
          const t = dateCol && ligne.d ? Date.parse(ligne.d) : NaN;
          poser.run(ulid(Number.isFinite(t) ? t + i : base + i), ligne.r);
        });
      })();
    }

    /* UNIQUE, et non « UNIQUE NOT NULL » : SQLite ne sait pas ajouter une colonne NOT NULL sans
       valeur par défaut à une table existante, et un index unique laisse passer les NULL. Le
       déclencheur ci-dessous est ce qui garantit qu'il n'en reste jamais. */
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uid ON ${table}(uid)`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_uid AFTER INSERT ON ${table}
             WHEN NEW.uid IS NULL
             BEGIN UPDATE ${table} SET uid = mergerie_ulid() WHERE rowid = NEW.rowid; END`);
  }
}
