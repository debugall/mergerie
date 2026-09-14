'use strict';
/* LA COUCHE QUI FAIT DU DOSSIER DE FICHIERS LA SOURCE DE VÉRITÉ.
 *
 * On ne remplace pas SQLite. Le code compte plus de huit cents requêtes préparées, et les
 * jointures, les tris et la recherche en dépendent : un moteur maison sur fichiers coûterait des
 * mois pour un résultat moins bon. On change seulement QUI FAIT FOI.
 *
 *    écran ──► API ──► store ──► fichiers de `data/shared/` ──► git ──► autres postes
 *                        │                                        │
 *                        ▼                                        ▼  pull
 *                    SQLite (cache)  ◄──── hydratation ◄──── fichiers modifiés
 *                        ▲
 *                        │ lit (les 852 requêtes, inchangées)
 *    écran ◄── API ◄─────┘
 *
 * TROIS RÈGLES, ET ELLES EXPLIQUENT TOUT LE FICHIER :
 *
 * 1. UN FICHIER PAR ENTITÉ, nommé par une identité qui ne dépend d'aucun poste (un ULID, ou une
 *    clé naturelle). C'est ce qui rend les conflits rares : deux postes ne touchent presque
 *    jamais le même fichier, et quand ils le font, c'est qu'ils ont vraiment modifié la même
 *    chose.
 * 2. SÉRIALISATION DÉTERMINISTE. Deux écritures du même état donnent le même octet, sinon
 *    « git status propre » ne voudrait plus dire « rien n'a changé » et chaque sauvegarde
 *    produirait un commit de bruit.
 * 3. LA BASE NE PEUT PAS ÊTRE EN AVANCE SUR LES FICHIERS. Toute écriture passe par une
 *    transaction SQLite qui écrit AUSSI le fichier : si le fichier échoue, la base revient en
 *    arrière. « Enregistré » ne peut jamais vouloir dire « enregistré ici seulement ».
 *
 * Ce que ce module ne fait PAS : du git. Commits, `pull --rebase` et `push` vivent ailleurs ;
 * ici, on ne connaît que des fichiers.
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { SHARED_DIR, DATA_DIR, ensureDir } = require('./paths');
const registre = require('./store-registry');

/* La version du FORMAT DE FICHIERS, indépendante des migrations SQLite. Un dépôt écrit par une
   version plus récente est refusé au démarrage : hydrater à moitié ferait pire que ne rien
   faire — on afficherait des objets amputés en les croyant complets. */
const SCHEMA = 1;
const MARQUEUR = '.mergerie-data.json';

/* ---------- 1. Sérialisation déterministe ---------- */

/* Clés triées RÉCURSIVEMENT, deux espaces, une nouvelle ligne finale, et aucun champ nul ou
   indéfini (omis plutôt qu'écrit `null` : « absent » et « vide » ne doivent pas produire deux
   octets différents pour le même état). Les tableaux gardent leur ordre — il porte du sens
   (les commandes d'un vérificateur : `npm ci` avant `npm test`). */
function trier(v) {
  if (Array.isArray(v)) return v.map(trier);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === null || v[k] === undefined) continue;
      out[k] = trier(v[k]);
    }
    return out;
  }
  return v;
}

const serialize = (obj) => `${JSON.stringify(trier(obj), null, 2)}\n`;

/* ---------- 2. Écriture atomique sous `data/shared/` ---------- */

/* Un chemin de fichier VENU D'UNE DONNÉE ne doit jamais sortir du dépôt. Un slug, une clé de
   ticket ou un nom de projet traversent des formulaires : `..` y est concevable, et un
   `notes/../../.ssh/config` écrirait chez l'utilisateur. On résout et on vérifie. */
function absolu(relatif) {
  const p = path.resolve(SHARED_DIR, relatif);
  const racine = path.resolve(SHARED_DIR) + path.sep;
  if (p !== path.resolve(SHARED_DIR) && !p.startsWith(racine)) {
    throw new Error(`store : chemin hors du dépôt de données — ${relatif}`);
  }
  return p;
}

/* LE MÊME GARDE, DANS L'AUTRE SENS. `absolu` protège le dépôt de ce que l'utilisateur tape ;
   celui-ci protège `data/` de ce que le DÉPÔT raconte. Le nom d'une capture, le dossier d'un
   agent viennent d'un fichier écrit sur un AUTRE poste : un `../../.ssh/authorized_keys` y est
   tout aussi concevable, et l'hydratation le déposerait sans broncher. On résout, on vérifie,
   et on refuse — un fichier refusé vaut mieux qu'un fichier écrit hors du dossier de données. */
function sousDonnees(sousDossier, nom) {
  const racine = path.resolve(DATA_DIR) + path.sep;
  const p = path.resolve(DATA_DIR, String(sousDossier || ''), String(nom || ''));
  if (!p.startsWith(racine) || /\0/.test(`${sousDossier}${nom}`)) {
    throw new Error(`store : chemin hors du dossier de données — ${sousDossier}/${nom}`);
  }
  return p;
}

/* `write` puis `rename` : un lecteur (ou un `git add` déclenché au même instant) voit l'ancien
   fichier ou le nouveau, jamais un fichier à moitié écrit. */
function ecrireFichier(relatif, contenu) {
  const p = absolu(relatif);
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenu);
  fs.renameSync(tmp, p);
}

function supprimerFichier(relatif) {
  try { fs.unlinkSync(absolu(relatif)); } catch { /* déjà parti */ }
}

const lireFichier = (relatif) => {
  try { return fs.readFileSync(absolu(relatif), 'utf8'); } catch { return null; }
};

const existe = (relatif) => fs.existsSync(absolu(relatif));

/** Tous les fichiers du dépôt, en chemins relatifs, `.git/` exclu. */
function listerFichiers(sous = '') {
  const racine = absolu(sous);
  const out = [];
  const marcher = (dir, prefixe) => {
    let entrees;
    try { entrees = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entrees.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const rel = prefixe ? `${prefixe}/${e.name}` : e.name;
      if (e.isDirectory()) marcher(path.join(dir, e.name), rel);
      else if (!e.name.endsWith('.tmp') && !/\.tmp-\d+$/.test(e.name)) out.push(rel);
    }
  };
  marcher(racine, sous);
  return out;
}

/* ---------- 3. Le contexte : traduire les références d'un poste à l'autre ---------- */

/* Un fichier ne contient JAMAIS d'identifiant entier. Deux postes créent chacun le dépôt n° 12 ;
   écrire `repo_id: 12` désignerait deux choses différentes. Le fichier porte donc une clé
   naturelle (`gitlab/acme/web`) ou un `uid`, et c'est ici qu'on traduit dans les deux sens.
   Les caches évitent une requête par ligne : une hydratation complète en fait des milliers. */
/* LE COMPTEUR DES VALEURS PROVISOIRES, au niveau du MODULE et non du contexte. L'hydratation
   refait un contexte à chaque ligne — les caches doivent voir ce qui vient d'être inséré —, et
   un compteur remis à zéro à chaque fois donnerait deux fois `-1` : exactement la collision que
   ces valeurs existent pour éviter. Il ne sert qu'entre l'insertion et la renumérotation. */
let provisoire = 0;

function contexte() {
  const memo = new Map();
  const memoise = (cle, calcul) => {
    if (!memo.has(cle)) memo.set(cle, calcul());
    return memo.get(cle);
  };
  return {
    /** L'uid d'une ligne, depuis son id entier. */
    uid(table, id) {
      if (!id) return null;
      const r = memoise(`u:${table}:${id}`,
        () => db.prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(Number(id)));
      return r ? r.uid : null;
    },
    /** L'id entier d'une ligne SUR CE POSTE, depuis son uid. */
    id(table, uid) {
      if (!uid) return null;
      const r = memoise(`i:${table}:${uid}`,
        () => db.prepare(`SELECT id FROM ${table} WHERE uid = ?`).get(String(uid)));
      return r ? r.id : null;
    },
    /** La clé naturelle d'un dépôt : `gitlab/acme/web`. */
    repoRef(id) {
      if (!id) return null;
      const r = memoise(`rr:${id}`,
        () => db.prepare('SELECT forge, project FROM repo WHERE id = ?').get(Number(id)));
      return r ? `${r.forge || 'gitlab'}/${r.project}` : null;
    },
    /** … et le chemin inverse. `null` si ce poste ne connaît pas ce dépôt. */
    repoId(ref) {
      if (!ref) return null;
      const i = String(ref).indexOf('/');
      if (i <= 0) return null;
      const forge = ref.slice(0, i);
      const project = ref.slice(i + 1);
      const r = memoise(`ri:${ref}`,
        () => db.prepare('SELECT id FROM repo WHERE forge = ? AND project = ?').get(forge, project));
      return r ? r.id : null;
    },
    /** Le slug d'un agent ou d'une page — ce qui nomme son fichier. */
    slug(table, id) {
      if (!id) return null;
      const r = memoise(`s:${table}:${id}`,
        () => db.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(Number(id)));
      return r ? r.slug : null;
    },
    idParSlug(table, slug) {
      if (!slug) return null;
      const r = memoise(`is:${table}:${slug}`,
        () => db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(String(slug)));
      return r ? r.id : null;
    },
    /* SORTIR UN BINAIRE DU DÉPÔT POUR LE SERVIR. Une capture collée dans une page vit dans le
       dépôt sous le dossier de sa page ; l'application, elle, la sert depuis `data/notes/<id>/`.
       On la recopie donc à l'hydratation — la recopie est idempotente, et une image absente du
       dépôt rend `null` plutôt que de faire échouer toute la passe pour une vignette. */
    copierDepuisDepot(relatif, sousDossier, nom) {
      if (!relatif) return null;
      let source; let dest;
      try { source = absolu(relatif); dest = sousDonnees(sousDossier, nom); } catch { return null; }
      if (!fs.existsSync(source)) return null;
      ensureDir(path.dirname(dest));
      try { fs.copyFileSync(source, dest); } catch { return null; }
      return dest;
    },
    /* LE CORPS D'UN DOCUMENT QUI VIT SUR LE DISQUE. La carte d'un agent de domaine est un
       Markdown dans `data/agents/<id>/` ; le dépôt, lui, veut le TEXTE. Un fichier illisible
       rend une chaîne vide plutôt que de faire échouer tout l'export : mieux vaut une carte
       vide et visible qu'une équipe sans carte du tout. */
    lireDisque(p) {
      if (!p) return '';
      try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
    },
    /* … et le chemin inverse : on repose le corps sur le disque local, là où l'application le
       lit, et on rend son chemin absolu — qui, lui, ne repart jamais dans le dépôt. */
    ecrireDisque(sousDossier, nom, contenu) {
      const dest = sousDonnees(sousDossier, nom);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, contenu, 'utf8');
      return dest;
    },
    /* UNE VALEUR PROVISOIRE, UNIQUE, POUR UNE COLONNE QUI SERA RECALCULÉE. `version` est
       `NOT NULL` et unique par agent, mais c'est un COMPTEUR LOCAL : sa vraie valeur se déduit
       de l'ordre des uid, donc seulement une fois toutes les lignes posées. On pose donc un
       négatif distinct — jamais deux lignes égales, et `apresHydratation` renumérote. */
    sequence() { provisoire -= 1; return provisoire; },
    /** Les colonnes d'équipe d'une table — le registre fait foi, on ne les recopie nulle part. */
    champsPartages: (table) => ((registre.pour(table) || {}).partagees || []),
    /** Les lignes filles d'un parent — la liste que le fichier du parent héberge. */
    enfants(table, colonneParent, idParent) {
      if (!idParent) return [];
      /* `rowid` et non `id` : une table de jointure comme `verifier_command` n'a pas de clé
         primaire propre — (vérificateur, position) la décrit entièrement —, donc pas de colonne
         `id`. `rowid` existe partout et donne l'ordre d'insertion, qui est ce qu'on veut. */
      return memoise(`e:${table}:${colonneParent}:${idParent}`, () => db.prepare(
        `SELECT * FROM ${table} WHERE ${colonneParent} = ? ORDER BY rowid`,
      ).all(Number(idParent)));
    },
    /* LES TROIS MORCEAUX DU CHEMIN D'UNE MERGE REQUEST. Tout ce qui pend à une MR — sa review,
       ses versions, ses brouillons — se range sous elle, et c'est la clé naturelle qui nomme le
       dossier : `mrs/gitlab/acme/web/218`. Un id entier donnerait deux dossiers différents chez
       deux personnes pour la même merge request. */
    mrChemin(id) {
      if (!id) return null;
      const r = memoise(`mc:${id}`, () => db.prepare(
        'SELECT repo.forge AS forge, repo.project AS project, mr.iid AS iid FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?',
      ).get(Number(id)));
      return r ? { forge: r.forge || 'gitlab', project: r.project, iid: r.iid } : null;
    },
    /* L'uid de la SESSION qui possède cette passe ou cette pièce jointe. Quatre tables parentes
       possibles selon le `scope` — c'est déjà la raison pour laquelle ces tables n'ont pas de
       clé étrangère. */
    sessionUid(scope, id) {
      const table = { task: 'task', local: 'local_task', ask: 'question', review: 'mr' }[scope];
      return table ? this.uid(table, id) : null;
    },
    sessionId(scope, uid) {
      const table = { task: 'task', local: 'local_task', ask: 'question', review: 'mr' }[scope];
      return table ? this.id(table, uid) : null;
    },
    /** La désignation d'une merge request : `gitlab/acme/web!218`. */
    mrRef(id) {
      if (!id) return null;
      const r = memoise(`mr:${id}`, () => db.prepare(
        'SELECT repo.forge AS forge, repo.project AS project, mr.iid AS iid FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?',
      ).get(Number(id)));
      return r ? `${r.forge || 'gitlab'}/${r.project}!${r.iid}` : null;
    },
    mrId(ref) {
      if (!ref) return null;
      const m = /^(.+)!(\d+)$/.exec(String(ref));
      if (!m) return null;
      const repoId = this.repoId(m[1]);
      if (!repoId) return null;
      const r = memoise(`mi:${ref}`,
        () => db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(repoId, Number(m[2])));
      return r ? r.id : null;
    },
  };
}

/* ---------- 4. Les fichiers d'une ligne ---------- */

/**
 * Le chemin du fichier d'une ligne, ou `null` si elle n'en a pas encore (référence manquante).
 * Sert à demander « qui a écrit ça ? » à git, sans avoir à tenir une colonne `author`.
 */
function cheminSur(table, row) {
  const e = registre.pour(table);
  if (!e || !e.chemin || !e.toFile || !row) return null;
  try { return cheminDe(table, { ...row, ...e.toFile(row, contexte()) }); } catch { return null; }
}

/** Le chemin du fichier principal d'une ligne. */
function cheminDe(table, row) {
  const e = registre.pour(table);
  if (!e || !e.chemin) throw new Error(`store : ${table} n'a pas de fichier propre`);
  return registre.cheminDe(table, row);
}

/** Le `.json` jumeau d'un `.md` : les métadonnées d'un document dont le corps est le fichier. */
const jumeau = (chemin) => chemin.replace(/\.md$/, '.json');

/**
 * Les fichiers que cette ligne produit : `[{ chemin, contenu }]`.
 * Un document Markdown en produit DEUX — le corps, relisible tel quel hors de l'outil (une page
 * de notes exportée est déjà le fichier du dépôt), et son `.json` jumeau pour le reste.
 */
function fichiersDe(table, row, ctx) {
  const e = registre.pour(table);
  const doc = e.toFile(row, ctx);
  const chemin = cheminDe(table, { ...row, ...doc });
  if (!e.corps) return [{ chemin, contenu: serialize(doc) }];
  const corps = doc[e.corps];
  const meta = { ...doc };
  delete meta[e.corps];
  return [
    { chemin, contenu: typeof corps === 'string' ? corps : '' },
    { chemin: jumeau(chemin), contenu: serialize(meta) },
  ];
}

/**
 * Les fichiers BINAIRES qu'une ligne traîne : les captures collées dans une page, les pièces
 * jointes d'une session. Copiés tels quels — jamais de base64 dans un fichier texte, qui
 * rendrait un diff illisible et ferait grossir la ligne de plusieurs mégaoctets.
 * `[{ chemin, source }]`, `source` étant le fichier sur le disque local.
 */
function binairesDe(table, row, ctx) {
  const e = registre.pour(table);
  return e.binaires ? e.binaires(row, ctx).filter((b) => b.source && fs.existsSync(b.source)) : [];
}

/* CETTE LIGNE-CI PART-ELLE ? Par défaut oui : le registre classe par TABLE, et c'est ce qui
   rend le partage tenable. Une seule table pose la question ligne par ligne — les pages de
   notes, qu'on écrit sans destinataire —, et elle répond non tant qu'on n'a pas coché. */
const partageable = (table, row) => {
  const e = registre.pour(table);
  return !e || !e.partageable ? true : Boolean(e.partageable(row));
};

/* Tous les chemins qu'une ligne occupe dans le dépôt, binaires compris et SANS filtrer sur
   l'existence de la source : c'est ce qu'il faut RETIRER quand une ligne cesse de se partager,
   et une capture disparue du disque ne doit pas laisser son double dans le dépôt. */
function cheminsDe(table, row, ctx) {
  const e = registre.pour(table);
  const bin = e.binaires ? e.binaires(row, ctx).map((b) => b.chemin) : [];
  return [...fichiersDe(table, row, ctx).map((f) => f.chemin), ...bin];
}

/**
 * Pose (ou retire) les fichiers d'une ligne. LE SEUL ENDROIT qui décide si une ligne devient un
 * fichier : décocher « partager » doit RETIRER du dépôt, pas simplement cesser d'y écrire —
 * sinon la page resterait chez tout le monde, et la case aurait menti.
 */
function poser(table, row, ctx) {
  if (!partageable(table, row)) {
    for (const c of cheminsDe(table, row, ctx)) supprimerFichier(c);
    return;
  }
  for (const f of fichiersDe(table, row, ctx)) ecrireFichier(f.chemin, f.contenu);
  for (const b of binairesDe(table, row, ctx)) copierBinaire(b.chemin, b.source);
}

/** Copie un fichier binaire dans le dépôt, sans le relire en mémoire. */
function copierBinaire(relatif, source) {
  const p = absolu(relatif);
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, p);
}

/* ---------- 5. Écrire : la base ne peut pas être en avance ---------- */

/* QUI PRÉVENIR QUAND UN FICHIER CHANGE. `datasync` s'abonne ici pour marquer le dépôt « sale »
   et déclencher un commit trois secondes plus tard. On passe par un abonnement plutôt que par un
   `require` : `datasync` a besoin de `store`, et l'inverse ferait un cycle — le store doit
   pouvoir fonctionner seul, sans git, et c'est précisément le mode mono-poste. */
const abonnes = [];
const surEcriture = (fn) => { abonnes.push(fn); };
const prevenir = (table, row, genre) => {
  for (const fn of abonnes) { try { fn(table, row, genre); } catch { /* un abonné ne casse pas une écriture */ } }
};

/**
 * Applique une écriture en base ET écrit ses fichiers, dans UNE SEULE transaction SQLite.
 * Si l'écriture d'un fichier échoue — disque plein, droits, chemin refusé —, la base revient en
 * arrière et l'erreur remonte à l'écran. C'est la garantie n° 3 : « enregistré » ne veut jamais
 * dire « enregistré ici seulement ».
 *
 * @param {string} table
 * @param {() => number} ecrireEnBase rend l'`id` de la ligne écrite
 * @returns {object} la ligne telle qu'elle est en base après l'écriture
 */
function ecrire(table, ecrireEnBase) {
  /* On relit par `rowid`, pas par `id` : deux tables partagées n'ont pas de colonne `id` (les
     réglages, une veille Jira nommée par la clé du ticket), et `rowid` vaut `id` partout
     ailleurs. Un appelant rend donc toujours le `lastInsertRowid` ou l'`id` de sa ligne. */
  const lire = db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`);
  return db.transaction(() => {
    const id = ecrireEnBase();
    const row = lire.get(Number(id));
    if (!row) throw new Error(`store : ${table}#${id} introuvable après écriture`);
    const ctx = contexte();
    poser(table, row, ctx);
    prevenir(table, row, 'ecrit');
    return row;
  })();
}

/** Supprime une ligne ET ses fichiers, même transaction, même garantie. */
function supprimer(table, id) {
  const lire = db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`);
  return db.transaction(() => {
    const row = lire.get(Number(id));
    if (!row) return false;
    const ctx = contexte();
    const fichiers = cheminsDe(table, row, ctx);
    db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(Number(id));
    for (const c of fichiers) supprimerFichier(c);
    prevenir(table, row, 'supprime');
    return true;
  })();
}

/** Réécrit le fichier d'une ligne sans rien changer en base — après un changement de liste fille. */
function rafraichir(table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`).get(Number(id));
  if (!row) return null;
  const ctx = contexte();
  poser(table, row, ctx);
  prevenir(table, row, 'ecrit');
  return row;
}

/* ---------- 5 bis. Écouler ce que les déclencheurs ont noté ----------
 *
 * `src/db.js` pose un déclencheur par table partagée : toute écriture, d'où qu'elle vienne,
 * note la ligne dans `store_sale`. C'est ce qui rend l'invariant tenable — il y a plus de deux
 * cents écritures dans vingt modules, et les passer une par une en revue, c'est se donner
 * rendez-vous avec l'oubli.
 *
 * LA FILE EST DANS LA MÊME TRANSACTION QUE L'ÉCRITURE : si le processus meurt entre la ligne et
 * le fichier, la file a survécu et le démarrage suivant écrit le fichier manquant. Rien ne se
 * perd, tout au plus se retarde.
 */

/** Vrai s'il reste des fichiers à écrire. Sert au pied de page et aux tests. */
const enRetard = () => db.prepare('SELECT COUNT(*) n FROM store_sale').get().n
  + db.prepare('SELECT COUNT(*) n FROM store_menage').get().n;

/**
 * Écrit les fichiers des lignes notées, et balaie les tables où quelque chose a été supprimé.
 * Idempotent, et sans effet quand la file est vide — on peut l'appeler après chaque requête.
 * @returns {{ ecrits: number, supprimes: number }}
 */
function ecouler() {
  const bilan = { ecrits: 0, supprimes: 0 };
  /* DISTINCT : la file accepte les doublons — `INSERT OR IGNORE` ne fonctionne pas dans un
     déclencheur SQLite, qui applique la résolution de conflit de l'instruction extérieure. */
  const sales = db.prepare('SELECT DISTINCT tbl, rid FROM store_sale ORDER BY tbl, rid').all();
  const menages = db.prepare('SELECT DISTINCT tbl FROM store_menage').all().map((r) => r.tbl);
  if (!sales.length && !menages.length) return bilan;

  const ctx = contexte();
  const oublier = db.prepare('DELETE FROM store_sale WHERE tbl = ? AND rid = ?');
  for (const { tbl, rid } of sales) {
    const e = registre.pour(tbl);
    if (!e || !e.toFile) { oublier.run(tbl, rid); continue; }
    const row = db.prepare(`SELECT * FROM ${tbl} WHERE rowid = ?`).get(rid);
    if (!row) {
      /* La ligne a été écrite puis supprimée avant qu'on passe : c'est au balayage de retirer
         son fichier, puisque lui seul sait comparer le dossier aux lignes restantes. */
      db.prepare('INSERT INTO store_menage (tbl) VALUES (?)').run(tbl);
      oublier.run(tbl, rid);
      continue;
    }
    try {
      poser(tbl, row, ctx);
      prevenir(tbl, row, 'ecrit');
      bilan.ecrits += 1;
    } catch (err) {
      /* UNE LIGNE QUI NE SAIT PAS ENCORE DEVENIR UN FICHIER N'EST PAS UNE PANNE. Une review dont
         la merge request vient d'être supprimée, une passe dont la session n'existe plus : on la
         laisse dans la file, et le tour suivant réessaiera. Ce qui ne doit jamais arriver, c'est
         qu'une erreur ici fasse échouer la requête qui l'a déclenchée. */
      if (!/store :/.test(String(err && err.message))) oublier.run(tbl, rid);
    }
    oublier.run(tbl, rid);
  }

  for (const tbl of menages) {
    bilan.supprimes += balayer(tbl, ctx);
    db.prepare('DELETE FROM store_menage WHERE tbl = ?').run(tbl);
  }
  return bilan;
}

/**
 * LE BALAYAGE. Une suppression ne peut pas dire quel fichier retirer — le chemin se calcule en
 * JavaScript, pas en SQL. On compare donc ce que le dossier contient à ce que les lignes
 * RESTANTES devraient produire, et on retire la différence. C'est plus coûteux qu'une
 * suppression ciblée, mais ça ne tourne qu'après une suppression, et surtout : c'est le seul
 * moyen de garantir qu'il ne reste jamais un fichier orphelin — lequel ferait revenir l'objet à
 * la prochaine hydratation.
 */
function balayer(table, ctx = contexte()) {
  const e = registre.pour(table);
  if (!e || !e.chemin || !e.toFile) return 0;
  const attendus = new Set();
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) {
    /* Une ligne qui ne se partage plus NE PROTÈGE PLUS SES FICHIERS : c'est ainsi que le
       balayage retire du dépôt une page qu'on vient de décocher, même si personne n'a pensé
       à la retirer nommément. */
    if (!partageable(table, row)) continue;
    try {
      for (const f of fichiersDe(table, row, ctx)) attendus.add(f.chemin);
      for (const b of binairesDe(table, row, ctx)) attendus.add(b.chemin);
    } catch { /* une ligne incomplète ne protège aucun fichier : le balayage retirera le sien */ }
  }
  /* On ne balaie que sous la RACINE du gabarit — `notes/`, `reviews/`, `sessions/` —, et jamais
     tout le dépôt : deux tables peuvent partager un dossier (les trois saveurs de session), et
     un balayage trop large effacerait les fichiers de la voisine. */
  const racine = e.chemin.split('/')[0];
  if (racine.includes('{')) return 0;
  const motif = motifDe(e);
  let n = 0;
  for (const relatif of listerFichiers(racine)) {
    if (attendus.has(relatif)) continue;
    const nom = canonique(e, relatif);
    if (!motif.test(nom)) continue;          // un fichier d'une autre table : ce n'est pas le nôtre
    if (attendus.has(nom)) continue;
    supprimerFichier(relatif);
    n += 1;
  }
  return n;
}

/* ---------- 6. Export complet ---------- */

/* Les tables qui portent leur propre fichier, parents avant enfants. `mr` en fait partie bien
   qu'elle soit un CACHE : la forge fait foi de son titre et de ses branches, mais l'état du
   travail du relecteur — « à traiter », « reviewée », le contexte saisi à la main — est
   exactement ce qu'une équipe a intérêt à partager. Ce sont ses `partagees` qui partent, et
   elles seules. */
const tablesFichier = () => registre.REGISTRE
  .filter((e) => (e.famille === 'P' || (e.partagees || []).length) && e.chemin && e.toFile)
  .map((e) => e.table);

/** (Ré)écrit le marqueur de format. Le dépôt doit pouvoir se présenter avant d'être lu. */
function marquer() {
  const version = (() => {
    try { return require('../package.json').version; } catch { return '?'; }
  })();
  ecrireFichier(MARQUEUR, serialize({ created_by: `mergerie ${version}`, schema: SCHEMA }));
}

/** Vérifie qu'on sait lire ce dépôt. Un format plus récent est refusé, pas hydraté à moitié. */
function verifierFormat() {
  const brut = lireFichier(MARQUEUR);
  if (!brut) return { ok: true, neuf: true };
  let doc = null;
  try { doc = JSON.parse(brut); } catch { return { ok: false, raison: 'marqueur illisible' }; }
  const n = Number(doc.schema);
  if (!Number.isFinite(n)) return { ok: false, raison: 'marqueur sans version de format' };
  if (n > SCHEMA) return { ok: false, raison: `format ${n} — mettez Mergerie à jour (cette version lit ${SCHEMA})` };
  return { ok: true, neuf: false };
}

/* LE DÉPÔT SE PRÉSENTE DÈS SA PREMIÈRE LIGNE. Sans marqueur, un dossier de fichiers ne dit pas
   quel format il parle, et la version suivante de Mergerie ne saurait pas s'il faut le migrer ou
   le refuser. On l'écrit donc au chargement s'il manque — et JAMAIS s'il existe : écraser un
   marqueur plus récent que ce qu'on sait lire, ce serait se donner la permission de l'abîmer. */
if (!existe(MARQUEUR)) marquer();

/* CE QUI A ÉTÉ PARTAGÉ ET NE DOIT PLUS L'ÊTRE DOIT EN SORTIR.
 *
 * Quatre onglets sont redevenus locaux — Docker, Jenkins, Git, Jira : ils décrivent une machine,
 * ses accès et sa façon de travailler, pas un travail accumulé. Leurs fichiers, eux, sont déjà dans le dépôt des équipes qui
 * ont synchronisé avant ce changement, et rien ne les en retirerait : le balayage ne connaît
 * que les tables qui écrivent encore, et une table devenue locale n'en fait plus partie. Ils
 * resteraient donc là, et la prochaine hydratation d'un collègue les reposerait chez lui.
 * On les retire donc UNE FOIS, au premier démarrage qui suit. Les dépôts suivis sont remis dans
 * la file pour que leur fichier se réécrive sans son bloc `jenkins`. */
const RACINES_RETIREES = ['git-commands', 'git-ops', 'docker-backups', 'jira'];
{
  const fait = db.prepare(
    "SELECT 1 FROM local_state WHERE kind = 'data' AND ref = 'depot' AND key = 'menus_locaux'",
  ).get();
  if (!fait) {
    let n = 0;
    for (const racine of RACINES_RETIREES) {
      for (const relatif of listerFichiers(racine)) { supprimerFichier(relatif); n += 1; }
    }
    if (n) console.log(`[store] ${n} fichier(s) d'onglets redevenus locaux retirés du dépôt`);
    try {
      db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'repo', rowid FROM repo").run();
    } catch { /* la file sera remplie au prochain démarrage */ }
    db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('data', 'depot', 'menus_locaux', '1', ?)`).run(new Date().toISOString());
  }
}

/** Écrit TOUT ce qui est partagé. Le point de départ d'une équipe, et le filet d'un doute. */
function exporterTout() {
  marquer();
  const ctx = contexte();
  const compte = {};
  for (const table of tablesFichier()) {
    /* `rowid` et non `id` : `jira_watch` est nommée par la clé du ticket et n'a pas de colonne
       `id`, pas plus que `config`. `rowid` existe partout et donne l'ordre d'insertion. */
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .filter((row) => partageable(table, row));
    for (const row of rows) poser(table, row, ctx);
    compte[table] = rows.length;
  }
  return compte;
}

module.exports = {
  SCHEMA,
  surEcriture,
  ecouler,
  enRetard,
  balayer,
  MARQUEUR,
  serialize,
  contexte,
  cheminDe,
  cheminSur,
  jumeau,
  fichiersDe,
  binairesDe,
  copierBinaire,
  ecrire,
  supprimer,
  rafraichir,
  ecrireFichier,
  supprimerFichier,
  lireFichier,
  existe,
  listerFichiers,
  tablesFichier,
  partageable,
  marquer,
  verifierFormat,
  exporterTout,
};

/* ---------- 7. Hydrater : des fichiers vers SQLite ----------
 *
 * Le chemin inverse, et le plus délicat : ce qui arrive vient d'un AUTRE poste, où les
 * identifiants entiers n'ont pas la même valeur. Trois règles le gouvernent :
 *
 *   — UPSERT, jamais « tout effacer puis tout réinsérer ». Un `DELETE` en cascade emporterait
 *     les merge requests d'un dépôt, les préférences locales rattachées, le cache.
 *   — LES RÉFÉRENCES SE RÉSOLVENT PAR CLÉ NATURELLE, et une référence qui ne se résout pas n'est
 *     jamais devinée : elle est mise de côté et retentée en fin de passe (une sous-page qui
 *     arrive avant son parent), puis abandonnée. Perdre un lien vaut mieux que pointer à côté.
 *   — UN FICHIER SUPPRIMÉ SUPPRIME SA LIGNE, par son uid.
 */

/** Le motif de fichier d'une table, en expression régulière, pour reconnaître un chemin. */
function motifDe(e) {
  const source = e.chemin
    .split(/(\{\w+\})/)
    .map((bout) => (/^\{\w+\}$/.test(bout)
      // Un segment de gabarit ne traverse pas les `/` — sauf `{project}`, qui EST un chemin
      // (`acme/sous-groupe/web`) : c'est la seule clé naturelle à plusieurs segments.
      ? (bout === '{project}' ? '(.+)' : '([^/]+)')
      : bout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/** À quelle table appartient ce fichier ? `null` s'il n'est à personne (le marqueur, un binaire). */
function tablePour(relatif) {
  const candidates = registre.REGISTRE.filter((e) => (e.famille === 'P' || (e.partagees || []).length)
    && e.chemin && e.toFile);
  /* DEUX PASSES, et l'ordre compte. `reviews/…/218/review.json` est le fichier de la review
     COURANTE ; lu comme le `.json` jumeau d'un document Markdown, il passerait pour une version
     nommée « review ». On essaie donc d'abord les correspondances directes, et seulement ensuite
     les jumeaux. */
  for (const e of candidates) if (motifDe(e).test(relatif)) return e.table;
  for (const e of candidates) {
    if (e.corps && motifDe(e).test(relatif.replace(/\.json$/, '.md'))) return e.table;
  }
  return null;
}

/** Le `.md` d'une entité Markdown, depuis l'un ou l'autre de ses deux fichiers. */
const versMd = (relatif) => (relatif.endsWith('.json') ? relatif.replace(/\.json$/, '.md') : relatif);

/* LE FICHIER QUI NOMME L'ENTITÉ. Pour un document Markdown, c'est son `.md` — son `.json`
   jumeau désigne la même chose. Pour tout le reste, c'est le fichier lui-même : appliquer
   `versMd` à `todos/<uid>.json` en ferait un `.md` qui ne correspond à aucun gabarit, et le
   fichier ne serait plus reconnu — ni pour l'hydrater, ni pour le balayer. */
const canonique = (e, relatif) => (e && e.corps ? versMd(relatif) : relatif);

/** Relit le document complet d'une entité depuis ses fichiers. `null` s'il a disparu. */
function lireDocument(table, relatif) {
  const e = registre.pour(table);
  if (!e.corps) {
    const brut = lireFichier(relatif);
    if (brut === null) return null;
    try { return JSON.parse(brut); } catch { throw new Error(`store : ${relatif} illisible (JSON)`); }
  }
  const md = versMd(relatif);      // ici l'entité a forcément un corps : on est dans la branche `e.corps`
  const corps = lireFichier(md);
  const metaBrut = lireFichier(jumeau(md));
  if (corps === null && metaBrut === null) return null;
  let meta = {};
  if (metaBrut !== null) {
    try { meta = JSON.parse(metaBrut); } catch { throw new Error(`store : ${jumeau(md)} illisible (JSON)`); }
  }
  return { ...meta, [e.corps]: corps === null ? '' : corps };
}

/** Écrit une ligne dans SQLite par son `uid` : insertion ou mise à jour, jamais de doublon. */
function upsert(table, row) {
  /* `config` n'a ni `uid` ni plusieurs lignes : c'est LA ligne des réglages. On la met à jour
     en place — un `INSERT … ON CONFLICT (uid)` n'aurait rien sur quoi s'appuyer. */
  if (table === 'config') {
    const champs = Object.keys(row).filter((c) => c !== 'id');
    if (champs.length) {
      db.prepare(`UPDATE config SET ${champs.map((c) => `${c} = @${c}`).join(', ')} WHERE id = 1`).run(row);
    }
    return db.prepare('SELECT * FROM config WHERE id = 1').get();
  }
  /* SUR QUOI SE FAIT LE RAPPROCHEMENT. Presque partout, l'`uid` : c'est l'identité qui survit au
     partage. Quelques tables n'en ont pas parce qu'elles portent déjà une clé naturelle qui a le
     même sens partout — un ticket Jira est `PROJ-1408` chez tout le monde. */
  const e = registre.pour(table);
  const cle = e && e.uidPropre ? 'uid' : (e && e.cle) || 'uid';
  const colonnes = Object.keys(row).filter((c) => c !== 'id');
  const set = colonnes.filter((c) => c !== cle).map((c) => `${c} = excluded.${c}`).join(', ');

  /* DEUX POSTES, LE MÊME OBJET, DEUX UID. C'est le cas du poste qui rejoint : il a installé le
     même agent livré (« Documentaliste »), écrit la même page de notes, suivi le même dépôt —
     chacun avec un uid tiré chez lui. Le fichier, lui, est nommé par la CLÉ NATURELLE
     (`agents/documentaliste/`, `notes/deploiement-prod.md`, `repos/gitlab/eq__api.json`) : deux
     fichiers de même nom sont le même document, il ne peut pas y en avoir deux.
     Le cas le plus courant n'est même pas celui-là : DEUX POSTES DÉCOUVRENT LA MÊME MERGE
     REQUEST chez la forge, chacun lui donnant son uid. Le premier qui la reviewe la partage, et
     le second ne pouvait pas la recevoir — `UNIQUE(repo_id, iid)`. Sa relecture n'arrivait
     jamais, alors que c'est exactement ce qu'une équipe attend du partage.
     Sans ce rapprochement, l'insertion butait sur l'unicité de la clé — « UNIQUE constraint
     failed: agent.slug » — et faisait échouer tout le rattachement, donc l'arrivée de TOUT le
     reste. La ligne locale adopte donc l'identité du dépôt : c'est lui qui fait foi, et l'uid
     local n'était qu'une identité parallèle pour ce que l'équipe connaît déjà. */
  const naturelle = registre.cleNaturelle(table);
  if (naturelle && row.uid && naturelle.every((c) => row[c] != null)) {
    const homonyme = db.prepare(
      `SELECT id, uid FROM ${table} WHERE ${naturelle.map((c) => `${c} = ?`).join(' AND ')}`,
    ).get(...naturelle.map((c) => row[c]));
    if (homonyme && homonyme.uid !== row.uid) {
      db.prepare(`UPDATE ${table} SET ${colonnes.map((c) => `${c} = @${c}`).join(', ')} WHERE id = ${homonyme.id}`).run(row);
      return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(homonyme.id);
    }
  }

  db.prepare(`INSERT INTO ${table} (${colonnes.join(', ')})
              VALUES (${colonnes.map((c) => `@${c}`).join(', ')})
              ON CONFLICT (${cle}) DO UPDATE SET ${set}`).run(row);
  return db.prepare(`SELECT * FROM ${table} WHERE ${cle} = ?`).get(row[cle]);
}

/**
 * Hydrate une liste de fichiers (chemins relatifs). Un fichier absent du disque est traité
 * comme supprimé. Rend un compte-rendu : ce qui est entré, ce qui est parti, ce qui manque.
 */
function hydraterFichiers(relatifs) {
  const ctx = contexte();
  const bilan = { ecrits: 0, supprimes: 0, orphelins: [] };

  /* DANS L'ORDRE DU REGISTRE, PARENTS D'ABORD. Git rend ses fichiers par ordre alphabétique :
     `convergences/` arrive avant `mrs/`, qui arrive avant `repos/`. Hydrater dans cet ordre-là
     obligerait à trois passes de rattrapage pour une chaîne dépôt → merge request → review.
     Le registre, lui, est écrit dans l'ordre des dépendances — on s'en sert. */
  const rang = new Map(registre.REGISTRE.map((e, i) => [e.table, i]));
  const vus = new Set();
  const aPoser = [];
  for (const relatif of relatifs) {
    const table = tablePour(relatif);
    if (!table) continue;
    const cle = `${table}::${canonique(registre.pour(table), relatif)}`;
    if (vus.has(cle)) continue;            // les deux fichiers d'un document ne comptent qu'une fois
    vus.add(cle);
    aPoser.push({ table, relatif });
  }
  aPoser.sort((a, b) => (rang.get(a.table) - rang.get(b.table)));

  const enAttente = [];
  for (const { table, relatif } of aPoser) {
    const e = registre.pour(table);
    const doc = lireDocument(table, relatif);
    if (doc === null) {
      if (supprimerLigne(e, table, relatif)) bilan.supprimes += 1;
      continue;
    }
    /* Une entité se reconnaît à son uid — sauf celles qui ont une clé naturelle et une seule
       ligne possible : `settings.json`, ou un ticket Jira nommé par sa clé. */
    if (!doc.uid && e.cle !== 'id' && !doc[e.cle]) { bilan.orphelins.push(`${relatif} : sans identité`); continue; }
    enAttente.push({ table, relatif, doc });
  }

  /* ON N'INSÈRE JAMAIS UNE LIGNE AMPUTÉE. Une review dont la merge request n'est pas encore
     posée serait refusée par la base (`mr_id NOT NULL`) — ou pire, acceptée avec un trou, et
     rattachée plus tard à ce qu'on aurait sous la main. On la remet donc à la passe suivante,
     tant qu'une passe fait progresser quelque chose. Trois tours suffisent à la plus longue
     chaîne (dépôt → merge request → review) ; au-delà, c'est que la cible n'arrivera pas. */
  let reste = enAttente;
  for (let tour = 0; tour < 4 && reste.length; tour++) {
    const encore = [];
    for (const item of reste) {
      const e = registre.pour(item.table);
      const ctxTour = contexte();
      const row = e.fromFile(item.doc, ctxTour);
      /* `fromFile` peut REFUSER une ligne : une pièce jointe dont le binaire n'est pas dans le
         dépôt (clone sans LFS) vaut mieux absente qu'affichée en vignette cassée. */
      if (!row) { bilan.orphelins.push(`${item.relatif} : ignoré ici (contenu absent du dépôt)`); continue; }
      const manque = (e.referencesDifferees || [])
        .filter((c) => row[c] === null && item.doc[e.refSource[c]]);
      if (manque.length && tour < 3) { encore.push(item); continue; }
      if (manque.length) {
        for (const c of manque) {
          bilan.orphelins.push(`${item.relatif} : ${c} → « ${item.doc[e.refSource[c]]} » inconnu ici`);
        }
        continue;
      }
      /* UN FICHIER QUI PASSE MAL N'EMPORTE PAS LES AUTRES. Une passe d'hydratation pose des
         centaines de documents ; laisser une exception remonter, c'est perdre TOUT ce qui suit
         dans l'ordre du registre — et l'ordre du registre étant celui des dépendances, ce qui
         suit est précisément le plus intéressant. Le poste qui rejoignait avec un agent de même
         nom recevait ainsi ses reviews (posées avant) mais ni ses sessions, ni ses notes, ni
         même les pointeurs vers ses rapports, calculés tout à la fin. On le signale comme
         orphelin — c'est visible dans l'état de la synchro — et on continue. */
      let ligne;
      try {
        ligne = upsert(item.table, row);
      } catch (err) {
        bilan.orphelins.push(`${item.relatif} : ${(err && err.message) || err}`);
        continue;
      }
      if (e.listes) hydraterListes(e, ligne, item.doc, ctxTour, (m) => bilan.orphelins.push(`${item.relatif} : ${m}`));
      bilan.ecrits += 1;
    }
    if (encore.length === reste.length) {
      /* Aucune progression : inutile de tourner. On signale, et on passe à la suite. */
      for (const item of encore) {
        const e = registre.pour(item.table);
        for (const c of (e.referencesDifferees || [])) {
          if (item.doc[e.refSource[c]]) bilan.orphelins.push(`${item.relatif} : ${c} → « ${item.doc[e.refSource[c]]} » inconnu ici`);
        }
      }
      reste = [];
      break;
    }
    reste = encore;
  }

  /* CE QUI SE RECALCULE UNE FOIS TOUT POSÉ. Les numéros de version et de passe sont des
     compteurs par parent — locaux par nature. On les renumérote dans l'ordre des uid, qui est
     l'ordre de création et le même chez tout le monde : deux postes qui produisent chacun une
     carte donnent v4 et v5, jamais deux v4. */
  const touchees = new Set(aPoser.map((x) => x.table));
  /* DANS L'ORDRE DU REGISTRE là aussi : une reprise qui lit les lignes d'une autre table doit
     passer après elle. */
  for (const e of registre.REGISTRE) {
    if (e.apresHydratation && touchees.has(e.table)) e.apresHydratation(db, contexte());
  }

  /* CE QU'ON VIENT D'IMPORTER N'EST PAS « SALE ». Les déclencheurs ont noté chaque ligne écrite
     par l'hydratation — et par les renumérotations ci-dessus. Les réexporter produirait
     exactement les mêmes octets, donc aucun commit, mais ferait relire des centaines de fichiers
     pour rien. Vidé APRÈS les reprises, sans quoi elles rempliraient la file qu'on vient de
     nettoyer. */
  db.exec('DELETE FROM store_sale');
  db.exec('DELETE FROM store_menage');
  return bilan;
}

/**
 * Un fichier parti emporte sa ligne — retrouvée par ce qui NOMME le fichier.
 *
 * On ne cherche QUE parmi les champs du gabarit qui sont de vraies colonnes : `notes/{slug}.md`
 * se retrouve par son slug, `todos/{uid}.json` par son uid. Certains fichiers ne portent rien de
 * tel — `reviews/<forge>/<projet>/<iid>/review.json` est nommé par sa merge request, pas par
 * lui-même. On ne devine pas : ces fichiers-là ne disparaissent que quand leur merge request ou
 * leur dépôt disparaît, et la cascade SQL s'en charge déjà.
 */
function supprimerLigne(e, table, relatif) {
  const m = motifDe(e).exec(canonique(e, relatif));
  if (!m) return false;
  const champs = (e.chemin.match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1));
  const colonnes = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const conditions = [];
  const valeurs = [];
  champs.forEach((c, i) => {
    if (!colonnes.has(c) || m[i + 1] === undefined) return;
    conditions.push(`${c} = ?`);
    valeurs.push(m[i + 1]);
  });
  if (!conditions.length) return false;
  const cible = db.prepare(`SELECT rowid AS r, * FROM ${table} WHERE ${conditions.join(' AND ')}`).get(...valeurs);
  if (!cible) return false;
  /* UN FICHIER ABSENT PARCE QU'ON L'A VOULU N'EST PAS UNE SUPPRESSION. Décocher « partager »
     retire la page du dépôt ; le commit qui la retire revient ensuite par l'hydratation, et
     sans ce garde-fou il emporterait la page de la base de celui-là même qui l'a décochée. La
     règle « un fichier parti emporte sa ligne » ne vaut que pour les lignes qui se partagent. */
  if (!partageable(table, cible)) return false;
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(cible.r);
  return true;
}

/** Les listes filles d'un parent : remplacées en bloc, elles n'ont de sens qu'avec lui. */
function hydraterListes(e, parent, doc, ctx, signaler = () => {}) {
  for (const l of e.listes) {
    const items = Array.isArray(doc[l.liste]) ? doc[l.liste] : [];
    /* DEUX FAÇONS DE POSER UNE LISTE FILLE, selon que ses lignes ont une identité propre.
       `verifier_command` n'en a pas — (vérificateur, position) la décrit entièrement —, donc la
       liste se remplace en bloc. `note_image` en a une, donc chaque ligne se retrouve par son
       uid et seules les disparues sont retirées. */
    if (l.remplace) { l.remplace(db, parent, items, ctx, signaler); continue; }
    const gardes = new Set();
    for (const item of items) {
      const row = l.fromItem(item, ctx, parent);
      if (!row) continue;
      upsert(l.table, row);
      gardes.add(row.uid);
    }
    /* Ce que le fichier ne mentionne plus a été retiré chez celui qui l'a écrit : le fichier
       fait foi, et la liste fille ne vit que par lui. */
    for (const r of db.prepare(`SELECT id, uid FROM ${l.table} WHERE ${l.colonneParent} = ?`).all(parent.id)) {
      if (!gardes.has(r.uid)) db.prepare(`DELETE FROM ${l.table} WHERE id = ?`).run(r.id);
    }
  }
}

/** Hydrate TOUT le dépôt — au premier démarrage, après un clone, ou quand la base a disparu. */
function hydraterTout() {
  const format = verifierFormat();
  if (!format.ok) throw new Error(`store : dépôt de données illisible — ${format.raison}`);
  return hydraterFichiers(listerFichiers());
}

module.exports.versMd = versMd;
module.exports.motifDe = motifDe;
module.exports.tablePour = tablePour;
module.exports.lireDocument = lireDocument;
module.exports.upsert = upsert;
module.exports.hydraterFichiers = hydraterFichiers;
module.exports.hydraterTout = hydraterTout;
