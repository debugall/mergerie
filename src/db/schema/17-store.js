'use strict';
/* Ce qui a changé et n’est pas encore écrit dans le dépôt : la file d’export et ses déclencheurs, générés depuis le registre.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- CE QUI A CHANGÉ ET N'EST PAS ENCORE ÉCRIT DANS LE DÉPÔT ----------
 *
 * Le dossier `data/shared/` est la source de vérité : chaque ligne partagée y a son fichier. Le
 * problème est de ne JAMAIS en oublier un — l'application compte plus de deux cents écritures,
 * réparties dans vingt modules, et la moitié se produit au fond d'un runner. Les passer une par
 * une en revue, c'est se donner rendez-vous avec l'oubli : il suffirait qu'une écriture ajoutée
 * l'an prochain n'appelle pas le `store` pour qu'un objet cesse silencieusement d'être partagé.
 *
 * On prend donc le même parti que pour les `uid` : c'est LA BASE qui tient l'invariant. Un
 * déclencheur par table partagée note la ligne touchée dans `store_sale` ; `store.ecouler()`
 * réécrit ensuite les fichiers correspondants. Les suppressions, elles, ne peuvent pas dire
 * QUEL fichier retirer (le chemin se calcule en JavaScript) : elles marquent la table dans
 * `store_menage`, et le balayage compare le dossier aux lignes restantes.
 *
 * LA FILE EST DANS LA MÊME TRANSACTION QUE L'ÉCRITURE. C'est ce qui rend l'ensemble sûr à la
 * coupure : si le processus meurt entre la ligne et le fichier, la file a survécu, et le
 * démarrage suivant écrit le fichier manquant. Rien ne peut être perdu, seulement retardé.
 *
 * Une ligne fille marque son PARENT : un constat de review vit dans le fichier de sa passe, une
 * commande de vérificateur dans celui de son vérificateur.
 *
 * Placé APRÈS tous les `CREATE TABLE` : un déclencheur sur une table qui n'existe pas encore
 * lève, et le `catch {}` voisin l'avalerait. */
/* PAS DE CLÉ PRIMAIRE, ET CE N'EST PAS UN OUBLI. `INSERT OR IGNORE` À L'INTÉRIEUR D'UN
   DÉCLENCHEUR NE FAIT RIEN : SQLite ignore la clause `OR IGNORE` du corps d'un déclencheur et
   applique celle de l'instruction EXTÉRIEURE. Un simple `DELETE FROM verifier` — qui cascade sur
   ses commandes et met à NULL la référence de ses vérifications — faisait donc marquer deux fois
   la même ligne, et échouait sur une violation d'unicité. Le doublon ne coûte rien ici : on
   déduplique à la lecture, et l'effacement retire toutes les copies d'un coup. */
{
  /* Une base écrite par une version antérieure porte encore la clé primaire : on la reconstruit
     en gardant la file, qui peut contenir du travail non écrit. */
  const aUnIndex = (t) => {
    try { return db.prepare(`PRAGMA index_list(${t})`).all().length > 0; } catch { return false; }
  };
  const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const [table, colonnes] of [['store_sale', 'tbl, rid'], ['store_menage', 'tbl']]) {
    if (existe(table) && aUnIndex(table)) {
      /* ON RETIRE D'ABORD LES DÉCLENCHEURS. `ALTER TABLE … RENAME` réécrit les références à la
         table DANS LE CORPS DES DÉCLENCHEURS : les anciens se mettraient à viser
         `store_sale_ancien`, qu'on s'apprête à supprimer — et la première écriture venue
         échouerait sur « no such table ». Ils sont recréés juste en dessous, de toute façon. */
      for (const t of db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'trg_%_sale_%' OR name LIKE 'trg_%_menage')",
      ).all()) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_ancien`);
      db.exec(`CREATE TABLE ${table} (${colonnes.split(', ').map((c) => `${c} ${c === 'rid' ? 'INTEGER' : 'TEXT'} NOT NULL`).join(', ')})`);
      db.exec(`INSERT INTO ${table} (${colonnes}) SELECT ${colonnes} FROM ${table}_ancien`);
      db.exec(`DROP TABLE ${table}_ancien`);
    }
  }
}
/* Un vestige de reconstruction interrompue : sans ça, la table renommée resterait à jamais. */
for (const t of ['store_sale_ancien', 'store_menage_ancien']) {
  try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch { /* déjà partie */ }
}
db.exec('CREATE TABLE IF NOT EXISTS store_sale (tbl TEXT NOT NULL, rid INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS store_menage (tbl TEXT NOT NULL)');

{
  const registre = require('../../data/store-registry');
  const aFichier = registre.REGISTRE.filter((e) => e.chemin && e.toFile
    && (e.famille === 'P' || (e.partagees || []).length));
  const parents = new Map();          // table fille -> { parent, colonne }
  for (const e of aFichier) {
    for (const l of e.listes || []) parents.set(l.table, { parent: e.table, colonne: l.colonneParent });
  }

  const marquer = (table, cible, colonne) => {
    /* `rowid` et non `id` : deux tables partagées n'ont pas de colonne `id` — les réglages, une
       veille Jira nommée par la clé du ticket. `rowid` existe partout. */
    const valeur = colonne ? `${cible}.${colonne}` : `${cible}.rowid`;
    const source = colonne
      ? `(SELECT rowid FROM ${table} WHERE ${registre.pour(table).uidPropre || table === 'config' ? 'id' : 'rowid'} = ${valeur})`
      : valeur;
    return `INSERT INTO store_sale (tbl, rid) VALUES ('${table}', ${source});`;
  };

  /* ON RECRÉE TOUJOURS, plutôt que `CREATE TRIGGER IF NOT EXISTS`. Le corps de ces déclencheurs
     est GÉNÉRÉ à partir du registre : s'il change — une table qui rejoint la famille partagée,
     une liste fille qui apparaît —, un déclencheur d'une version antérieure resterait en place
     et marquerait la mauvaise chose. Pire : `ALTER TABLE … RENAME` réécrit les références au
     nom de table DANS le corps des déclencheurs, si bien qu'une reconstruction de la file
     laissait des déclencheurs pointant une table supprimée, et la première écriture venue
     échouait sur « no such table ». Les recréer à chaque démarrage coûte quelques
     millisecondes et supprime toute la classe de problèmes. */
  const recreer = (nom, corps) => { db.exec(`DROP TRIGGER IF EXISTS ${nom}`); db.exec(corps); };
  for (const e of aFichier) {
    for (const evenement of ['INSERT', 'UPDATE']) {
      const nom = `trg_${e.table}_sale_${evenement.toLowerCase()}`;
      recreer(nom, `CREATE TRIGGER ${nom}
               AFTER ${evenement} ON ${e.table}
               BEGIN ${marquer(e.table, 'NEW')} END`);
    }
    recreer(`trg_${e.table}_menage`, `CREATE TRIGGER trg_${e.table}_menage
             AFTER DELETE ON ${e.table}
             BEGIN INSERT INTO store_menage (tbl) VALUES ('${e.table}'); END`);
  }

  /* LE JOUR OÙ LA COLONNE APPARAÎT, LES PAGES DÉJÀ ÉCRITES DEVIENNENT PRIVÉES — et celles qui
     étaient déjà dans le dépôt doivent en SORTIR. Sans ce balayage, leurs fichiers resteraient
     sur le disque, le prochain `git add -A` les emporterait, et la case « partager » aurait été
     mise en place le jour même où l'outil publiait ses brouillons. On passe par la FILE plutôt
     que par le balayage : écouler une ligne non partagée retire ses fichiers ET ses captures,
     là où le balayage ne connaît que le gabarit de la page.
     LE REPÈRE EST UNE MARQUE, PAS LE SUCCÈS DE L'`ALTER` : une base qui a connu une version
     intermédiaire a déjà la colonne, et se serait donc passée du nettoyage — c'est-à-dire
     précisément celle qui en a besoin. */
  const balaye = db.prepare("SELECT value FROM local_state WHERE kind = 'data' AND ref = 'notes' AND key = 'unshared_swept'").get();
  if (!balaye) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'note_page', rowid FROM note_page").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'notes', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* LE MÊME JOUR POUR LES SESSIONS. Elles partaient en bloc : prompt, réponse, chaque passe avec
     son retour complet, les captures jointes, le coût de chaque essai. Devenues privées par
     défaut, elles doivent SORTIR du dépôt — avec leurs passes et leurs pièces, qui suivent leur
     session et n'ont pas de case à elles. On remet donc les cinq tables dans la file : écouler
     une ligne qui ne se partage plus retire ses fichiers et ses binaires. */
  const balayeSessions = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'sessions' AND key = 'unshared_swept'",
  ).get();
  if (!balayeSessions) {
    for (const t of ['task', 'local_task', 'question', 'agent_pass', 'piece_jointe']) {
      db.prepare(`INSERT INTO store_sale (tbl, rid) SELECT '${t}', rowid FROM ${t}`).run();
    }
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'sessions', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* LES BROUILLONS DE COMMENTAIRE SORTENT DU FICHIER DE LEUR MERGE REQUEST. Ils y étaient
     encore : une remarque inline pas encore envoyée, lisible par tout le monde. Le fichier se
     réécrit sans eux dès qu'on remet les merge requests dans la file — rien d'autre ne les
     aurait retirés, puisque le fichier de la MR existe toujours. */
  const brouillonsSortis = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'mrs' AND key = 'drafts_unshared'",
  ).get();
  if (!brouillonsSortis) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'mr', rowid FROM mr").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'mrs', 'drafts_unshared', '1', ?)`).run(new Date().toISOString());
  }

  /* ET LES TODOS. Elles partaient en bloc, y compris celles qu'aucune main n'a écrites — la
     veille Jira d'un collègue, la question posée par son agent. Devenues privées par défaut,
     leurs fichiers doivent sortir du dépôt. */
  const todosBalayees = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'todos' AND key = 'unshared_swept'",
  ).get();
  if (!todosBalayees) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'todo', rowid FROM todo").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'todos', 'unshared_swept', '1', ?)`).run(new Date().toISOString());
  }

  /* HUIT RÉGLAGES ONT CHANGÉ DE CÔTÉ (brief du matin, cadences, fermeture des todos, cases
     d'office d'une session) : `settings.json` les porte encore. On remet la ligne de réglages
     dans la file pour que le fichier se réécrive sans eux — le drain les a déjà vidés de
     `config`, mais rien n'aurait réécrit le fichier. */
  const reglagesRelus = db.prepare(
    "SELECT value FROM local_state WHERE kind = 'data' AND ref = 'settings' AND key = 'locaux_2'",
  ).get();
  if (!reglagesRelus) {
    db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'config', rowid FROM config").run();
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'settings', 'locaux_2', '1', ?)`).run(new Date().toISOString());
  }

  /* Les lignes FILLES marquent leur parent : elles n'ont pas de fichier à elles. Une suppression
     de ligne fille ne demande aucun balayage — le fichier du parent, réécrit, ne la mentionnera
     simplement plus. */
  for (const [fille, { parent, colonne }] of parents) {
    for (const evenement of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = evenement === 'DELETE' ? 'OLD' : 'NEW';
      const nom = `trg_${fille}_sale_${evenement.toLowerCase()}`;
      recreer(nom, `CREATE TRIGGER ${nom}
               AFTER ${evenement} ON ${fille}
               BEGIN INSERT INTO store_sale (tbl, rid)
                 SELECT '${parent}', rowid FROM ${parent} WHERE id = ${ref}.${colonne}; END`);
    }
  }
}
