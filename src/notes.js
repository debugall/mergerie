'use strict';
/* Notes, todos et rappels — les post-it du poste de travail.
 *
 * Ce module ne contient QUE de la logique et des requêtes : pas de route, pas de rendu.
 * Trois choses y méritent une explication, parce qu'elles ont été tranchées et ne doivent
 * pas se rediscuter à chaque relecture.
 *
 * 1. UN RAPPEL EST UNE PROPRIÉTÉ DE LA TODO, pas une entité. `due_at` est à la fois
 *    l'échéance affichée et l'instant du rappel. Une table `reminder` séparée aurait
 *    autorisé deux vérités (une échéance sans rappel, un rappel sans échéance) qu'il aurait
 *    fallu réconcilier à l'affichage — pour un besoin qui n'existe pas : on veut être
 *    prévenu QUAND c'est dû.
 *
 * 2. `reminded_at` EMPÊCHE LA RE-NOTIFICATION, et TOUT changement de `due_at` le remet à
 *    NULL — snooze compris. Sans ce reset, snoozer un rappel déjà notifié le rendrait
 *    définitivement muet : on repousserait à demain 9 h une alarme qui ne sonnerait plus.
 *
 * 3. LES FAITES NE SONT JAMAIS SUPPRIMÉES. Elles restent barrées 7 jours (on veut voir ce
 *    qu'on a fait cette semaine), puis `archived_at` les sort des listes par défaut. Une
 *    todo cochée par erreur reste donc récupérable, et le filtre « Archivées » garde
 *    l'historique complet.
 */

const db = require('./db');

const JOUR_MS = 24 * 60 * 60 * 1000;

/* Bornes. Une note de poste de travail n'est pas une base de connaissances : le titre tient
   sur une ligne de liste, la note d'une todo sur deux lignes de carte. La page est large
   (200 ko = un très long document) mais pas illimitée — le contenu vit en base et repart
   dans chaque autosauvegarde. */
const MAX_TITLE = 200;
const MAX_NOTE = 2000;
const MAX_PAGE = 200 * 1024;

const PRIORITES = ['high', 'normal', 'low'];
const LINK_KINDS = ['mr', 'ticket', 'repo'];
// Combien de temps une todo faite reste visible, barrée, avant de s'archiver.
const JOURS_AVANT_ARCHIVE = 7;

const nowIso = () => new Date().toISOString();

function erreur(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* Un titre vide n'est pas une todo : c'est une ligne qu'on ne saura plus lire demain.
   On refuse plutôt que d'enregistrer un blanc — la capture rapide coûte deux secondes,
   la recommencer aussi. */
function lireTitre(v, msgVide) {
  const s = String(v == null ? '' : v).trim().slice(0, MAX_TITLE);
  if (!s) throw erreur(msgVide);
  return s;
}
const lireNote = (v) => {
  const s = String(v == null ? '' : v).trim().slice(0, MAX_NOTE);
  return s || null;
};
const lireContenu = (v) => String(v == null ? '' : v).slice(0, MAX_PAGE);

/* Une date d'échéance vient d'un `<input type="datetime-local">` : c'est une heure LOCALE
   sans fuseau (`2026-08-07T09:00`). `new Date()` l'interprète alors en local, ce qui est
   exactement ce qu'on veut — « demain 9 h » veut dire 9 h ici. On normalise en ISO pour
   que la comparaison SQL soit une comparaison de chaînes cohérente. */
function lireDate(v, msgInvalide) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw erreur(msgInvalide);
  return d.toISOString();
}

function lirePriorite(v, msgInvalide) {
  const s = String(v == null ? '' : v).trim() || 'normal';
  if (!PRIORITES.includes(s)) throw erreur(msgInvalide);
  return s;
}

/* Le lien est optionnel, mais il va par PAIRE : un `link_kind` sans `link_ref` donnerait une
   todo « liée à une MR » sans MR, donc un bouton qui ne mène nulle part. On efface les deux
   dès que l'un manque. */
function lireLien(kind, ref, msgInvalide) {
  const k = String(kind == null ? '' : kind).trim();
  const r = String(ref == null ? '' : ref).trim();
  if (!k && !r) return { link_kind: null, link_ref: null };
  if (!LINK_KINDS.includes(k)) throw erreur(msgInvalide);
  if (!r) return { link_kind: null, link_ref: null };
  return { link_kind: k, link_ref: r.slice(0, MAX_TITLE) };
}

/* ---------------------------------------------------------------- pages ---- */

const PAGE_COLS = 'id, title, pinned, created_at, updated_at';

/* La liste ne rend PAS le contenu : vingt pages de plusieurs dizaines de kilo-octets à
   chaque affichage de colonne, pour n'en lire qu'une. La recherche, elle, porte bien sur
   le contenu — c'est souvent le seul endroit où le mot cherché se trouve. */
function listerPages(q = '') {
  const s = String(q || '').trim();
  const ordre = 'ORDER BY pinned DESC, updated_at DESC';
  if (!s) return db.prepare(`SELECT ${PAGE_COLS} FROM note_page ${ordre}`).all();
  const like = `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT ${PAGE_COLS} FROM note_page
    WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' ${ordre}`).all(like, like);
}

const lirePage = (id) => db.prepare('SELECT * FROM note_page WHERE id = ?').get(Number(id) || 0);

function creerPage({ title, content } = {}, { titreVide }) {
  const now = nowIso();
  const info = db.prepare(`INSERT INTO note_page (title, content, pinned, created_at, updated_at)
    VALUES (?,?,0,?,?)`).run(lireTitre(title, titreVide), lireContenu(content), now, now);
  return lirePage(info.lastInsertRowid);
}

/* Mise à jour PARTIELLE : l'autosauvegarde n'envoie que le contenu, le bouton épingler que
   `pinned`. Envoyer l'objet entier à chaque frappe obligerait le client à garder une copie
   fidèle du reste — et à l'écraser dès qu'elle serait périmée. */
function majPage(id, patch = {}, { titreVide, inconnue }) {
  const page = lirePage(id);
  if (!page) throw erreur(inconnue, 404);
  const champs = [];
  const vals = [];
  if (patch.title !== undefined) { champs.push('title = ?'); vals.push(lireTitre(patch.title, titreVide)); }
  if (patch.content !== undefined) { champs.push('content = ?'); vals.push(lireContenu(patch.content)); }
  if (patch.pinned !== undefined) { champs.push('pinned = ?'); vals.push(patch.pinned ? 1 : 0); }
  if (champs.length) {
    champs.push('updated_at = ?'); vals.push(nowIso());
    db.prepare(`UPDATE note_page SET ${champs.join(', ')} WHERE id = ?`).run(...vals, page.id);
  }
  return lirePage(page.id);
}

function supprimerPage(id, { inconnue }) {
  const page = lirePage(id);
  if (!page) throw erreur(inconnue, 404);
  db.prepare('DELETE FROM note_page WHERE id = ?').run(page.id);
  return { ok: true };
}

/* Nom de fichier d'export. Slugifié depuis le titre : un titre porte des espaces, des
   accents, parfois un `/` — et `Content-Disposition` n'est pas l'endroit où découvrir
   qu'un nom de page contenait une traversée de chemin. On retombe sur `note` quand il ne
   reste rien de lisible (un titre entièrement en emoji, par exemple). */
function slugifier(titre) {
  const s = String(titre || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // « migration » et non « migrátion »
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'note';
}

/* ---------------------------------------------------------------- todos ---- */

/* Tri : priorité d'abord, échéance ensuite. Une todo SANS échéance passe après celles qui
   en ont une à priorité égale (`due_at IS NULL` en dernier) — sinon les sans-date, plus
   nombreuses, repousseraient en bas de liste ce qui est dû aujourd'hui. */
const ORDRE_TODO = `ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
  CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id DESC`;

/* LA PRIORITÉ D'ABORD, L'ORDRE CHOISI ENSUITE. Deux questions différentes, et chacune garde
   sa réponse : la priorité dit ce qui presse, l'ordre manuel dit dans quel ordre je m'y prends
   à l'intérieur de ce qui presse. Les mélanger — trier tout à la main — laisserait une haute
   au fond de la liste ; l'inverse — tout automatique — empêchait de s'organiser.

   Conséquence à assumer : réordonner ne déplace une todo QUE dans son groupe de priorité. La
   sortir de son groupe demanderait de changer sa priorité, ce qui est un autre geste, et
   l'écran ne propose donc pas de l'y emmener.

   Une todo SANS position est neuve : elle se range en tête de SON groupe, là où on vient de la
   taper. L'échéance ne trie plus rien ici — elle reste affichée, et c'est elle qui pilote le
   brief et les rappels. */
const ORDRE_MANUEL = `ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
  (position IS NULL) DESC, position, id DESC`;

/* Trois vues, et une seule règle à retenir : les archivées ne se mélangent JAMAIS aux
   autres. « open » et « done » sont des états de travail, « archived » est un tiroir.
   Seule « à faire » se réordonne : on n'arrange pas son tiroir. */
function listerTodos(statut = 'open') {
  const s = String(statut || 'open');
  if (s === 'archived') return db.prepare(`SELECT * FROM todo WHERE archived_at IS NOT NULL ${ORDRE_TODO}`).all();
  if (s === 'done') return db.prepare(`SELECT * FROM todo WHERE status = 'done' AND archived_at IS NULL ${ORDRE_TODO}`).all();
  if (s === 'all') return db.prepare(`SELECT * FROM todo WHERE archived_at IS NULL ${ORDRE_MANUEL}`).all();
  return db.prepare(`SELECT * FROM todo WHERE status = 'open' AND archived_at IS NULL ${ORDRE_MANUEL}`).all();
}

/* Réordonner : l'écran envoie l'ordre COMPLET de ce qu'il affiche, on numérote 1..n. Envoyer
   « telle todo passe avant telle autre » obligerait à recalculer les voisines côté serveur et
   à gérer les égalités ; la liste entière est courte, non ambiguë, et rejouable telle quelle.
   Une todo inconnue ou archivée est ignorée plutôt que de faire échouer le tout. */
function reordonnerTodos(ids) {
  const liste = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const maj = db.prepare('UPDATE todo SET position = ? WHERE id = ? AND archived_at IS NULL');
  const tout = db.transaction((l) => { l.forEach((id, i) => maj.run(i + 1, id)); });
  tout(liste);
  return liste.length;
}

const lireTodo = (id) => db.prepare('SELECT * FROM todo WHERE id = ?').get(Number(id) || 0);

function creerTodo(body = {}, msgs) {
  const now = nowIso();
  const lien = lireLien(body.link_kind, body.link_ref, msgs.lienInvalide);
  const info = db.prepare(`INSERT INTO todo
    (title, priority, status, note, link_kind, link_ref, due_at, created_at, updated_at)
    VALUES (?,?,'open',?,?,?,?,?,?)`).run(
    lireTitre(body.title, msgs.titreVide),
    lirePriorite(body.priority, msgs.prioriteInvalide),
    lireNote(body.note),
    lien.link_kind, lien.link_ref,
    lireDate(body.due_at, msgs.dateInvalide),
    now, now,
  );
  return lireTodo(info.lastInsertRowid);
}

/* Cocher/décocher, éditer, snoozer : une seule route, parce que ce sont les mêmes colonnes.
   Deux effets de bord non évidents, tous deux voulus :
     — passer à « fait » pose `done_at` (c'est lui qui fait courir les 7 jours) et
       décocher l'efface, sinon une todo rouverte s'archiverait toute seule ;
     — toucher `due_at` remet `reminded_at` à NULL : c'est ce qui fait qu'un snooze
       re-sonne (cf. l'en-tête du module). */
function majTodo(id, patch = {}, msgs) {
  const todo = lireTodo(id);
  if (!todo) throw erreur(msgs.inconnue, 404);
  const champs = [];
  const vals = [];
  const set = (col, val) => { champs.push(`${col} = ?`); vals.push(val); };

  if (patch.title !== undefined) set('title', lireTitre(patch.title, msgs.titreVide));
  if (patch.priority !== undefined) set('priority', lirePriorite(patch.priority, msgs.prioriteInvalide));
  if (patch.note !== undefined) set('note', lireNote(patch.note));
  if (patch.link_kind !== undefined || patch.link_ref !== undefined) {
    const lien = lireLien(
      patch.link_kind === undefined ? todo.link_kind : patch.link_kind,
      patch.link_ref === undefined ? todo.link_ref : patch.link_ref,
      msgs.lienInvalide,
    );
    set('link_kind', lien.link_kind); set('link_ref', lien.link_ref);
  }
  if (patch.due_at !== undefined) {
    set('due_at', lireDate(patch.due_at, msgs.dateInvalide));
    set('reminded_at', null);      // toute nouvelle échéance re-sonne
  }
  if (patch.status !== undefined) {
    const st = String(patch.status);
    if (st !== 'open' && st !== 'done') throw erreur(msgs.statutInvalide);
    set('status', st);
    set('done_at', st === 'done' ? nowIso() : null);
    // Rouvrir une todo la sort du tiroir : sinon elle resterait invisible dans les listes.
    if (st === 'open') set('archived_at', null);
  }
  if (champs.length) {
    set('updated_at', nowIso());
    db.prepare(`UPDATE todo SET ${champs.join(', ')} WHERE id = ?`).run(...vals, todo.id);
  }
  return lireTodo(todo.id);
}

function supprimerTodo(id, { inconnue }) {
  const todo = lireTodo(id);
  if (!todo) throw erreur(inconnue, 404);
  db.prepare('DELETE FROM todo WHERE id = ?').run(todo.id);
  return { ok: true };
}

/* Les deux snoozes proposés, et pourquoi ceux-là. « +1 h » sert quand on est en train de
   faire autre chose ; « demain 9 h » quand la journée est finie. Un sélecteur de date
   complet existe déjà dans l'édition — les boutons sont là pour le cas où l'on ne veut
   justement pas ouvrir un formulaire. */
function calculerSnooze(mode, maintenant = new Date()) {
  if (mode === 'hour') return new Date(maintenant.getTime() + 3600 * 1000).toISOString();
  if (mode === 'tomorrow') {
    /* Prochain jour CALENDAIRE à 09:00 locale. On construit la date par ses composants
       plutôt qu'en ajoutant 24 h : un changement d'heure ferait sinon dériver le rendez-vous
       d'une heure, et « demain 9 h » veut dire 9 h au cadran. */
    const d = new Date(maintenant.getTime());
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

/* ------------------------------------------------------------- rappels ---- */

/* Ce qui est dû et pas encore annoncé. `archived_at IS NULL` exclut le tiroir : une todo
   archivée avec une échéance passée n'a plus rien à réclamer. */
function rappelsDus(maintenant = new Date()) {
  return db.prepare(`SELECT * FROM todo
    WHERE status = 'open' AND archived_at IS NULL
      AND due_at IS NOT NULL AND due_at <= ? AND reminded_at IS NULL
    ORDER BY due_at`).all(maintenant.toISOString());
}

/* Le marquage est fait par le CLIENT, après affichage, et non au moment où le serveur
   répond. Marquer à la lecture perdrait le rappel quand la notification échoue (permission
   refusée, onglet fermé entre deux) : on aurait consommé l'unique occasion de prévenir. */
function marquerNotifie(id, { inconnue }) {
  const todo = lireTodo(id);
  if (!todo) throw erreur(inconnue, 404);
  db.prepare('UPDATE todo SET reminded_at = ? WHERE id = ?').run(nowIso(), todo.id);
  return lireTodo(todo.id);
}

/* ------------------------------------------------------------ archivage ---- */

function archiver(maintenant = new Date(), jours = JOURS_AVANT_ARCHIVE) {
  const limite = new Date(maintenant.getTime() - jours * JOUR_MS).toISOString();
  return db.prepare(`UPDATE todo SET archived_at = ?
    WHERE status = 'done' AND archived_at IS NULL AND done_at IS NOT NULL AND done_at < ?`)
    .run(maintenant.toISOString(), limite).changes;
}

/* Au démarrage puis une fois par jour — comme la rétention. `unref()` pour qu'un minuteur
   de ménage n'empêche jamais le processus de s'arrêter. */
function demarrerArchivage(onLog = () => {}) {
  const passe = () => {
    try {
      const n = archiver();
      if (n) onLog(`todos : ${n} archivée(s) après ${JOURS_AVANT_ARCHIVE} jours`);
    } catch (e) { onLog(`archivage des todos : ${e.message}`); }
  };
  passe();
  const t = setInterval(passe, JOUR_MS);
  if (t.unref) t.unref();
  return t;
}

/* ------------------------------------------------------------- autolink ---- */

/* L'index dont le RENDU a besoin pour transformer `!214` en lien. Il est calculé côté
   serveur parce que lui seul sait quelles MR existent — et il est volontairement maigre
   (iid → dépôts), pas la liste des MR : c'est une table de résolution, pas des données.
   Un même iid peut exister sur plusieurs dépôts ; on rend donc TOUS les candidats et le
   client décide quoi en faire (lien direct ou recherche pré-remplie). */
// Au-delà, une merge request fermée n'est plus une référence qu'on écrit dans une note.
const JOURS_AUTOLINK = 180;

function indexAutolink({ maintenant = Date.now() } = {}) {
  const mrs = {};
  /* BORNÉ, et il faut qu'il le soit : sans clause, la requête sérialisait la table `mr`
     ENTIÈRE à chaque ouverture de l'onglet — celui sur lequel l'application atterrit chaque
     matin — pour résoudre trois `!214` dans une note. Sur une instance qui tourne depuis des
     années avec vingt dépôts, cela fait des milliers de lignes recopiées dans le navigateur ;
     et la rétention ne borne pas la table (elle ne purge que jobs et journaux, et `0` vaut
     « sans limite »).
     Ce qu'on garde : tout ce qui est encore OUVERT, plus ce qui a bougé dans les six derniers
     mois. Une merge request fermée il y a deux ans reste écrite en clair dans la note plutôt
     que liée — un lien de moins, jamais un lien faux. */
  const depuis = new Date(maintenant - JOURS_AUTOLINK * JOUR_MS).toISOString();
  const rows = db.prepare(`SELECT m.id, m.iid, r.project FROM mr m
    JOIN repo r ON r.id = m.repo_id
    WHERE COALESCE(m.closed_seen, 0) = 0 OR COALESCE(m.updated_at, '') >= ?
    ORDER BY m.iid, m.id`).all(depuis);
  for (const r of rows) {
    (mrs[r.iid] = mrs[r.iid] || []).push({ id: r.id, project: r.project });
  }
  return mrs;
}

module.exports = {
  reordonnerTodos,
  MAX_TITLE, MAX_NOTE, MAX_PAGE, PRIORITES, LINK_KINDS, JOURS_AVANT_ARCHIVE, JOURS_AUTOLINK,
  listerPages, lirePage, creerPage, majPage, supprimerPage, slugifier,
  listerTodos, lireTodo, creerTodo, majTodo, supprimerTodo, calculerSnooze,
  rappelsDus, marquerNotifie, archiver, demarrerArchivage, indexAutolink,
};
