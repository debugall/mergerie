'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » — où en est-on, qui attend quoi, depuis quand.
 *
 * Le brief est « moi, ce matin » ; cette page est « nous, maintenant ». Elle est calculée en SQL sur
 * ce que l'équipe partage DÉJÀ par le dépôt de données (reviews, vérifications, sessions partagées,
 * croisements, empilements) et sur l'historique git de ce dépôt (qui a écrit quoi, quand) — sans rien
 * partager de plus, sans table nouvelle, sans aucun appel d'IA ni de forge.
 *
 * Règle produit, non négociable : LA PAGE N'AFFICHE QUE DES FAITS DÉJÀ PARTAGÉS, et RIEN SUR UNE
 * PERSONNE QUI NE SOIT L'ÉTAT D'UN TRAVAIL. Une merge request attend une décision, une question attend
 * une réponse, une session tourne, un poste n'a pas synchronisé depuis trois jours — oui. Combien de
 * tokens Claire consomme, combien de merge requests Ali a mergées, qui est « le plus rapide » — jamais,
 * même si la base le sait. Un test parcourt la sortie et refuse toute métrique par personne.
 *
 * L'identité d'une personne est l'auteur git du fichier dans le dépôt de données (`datasync.auteursDe`) ;
 * l'auteur d'une merge request reste celui de la forge. Une session non partagée n'existe pas ici — ni
 * dans une section, ni dans un compteur. Ce module n'importe rien de `agent/` ni de `forge/`. */
const db = require('../db');
const datasync = require('../data/datasync');
const store = require('../data/store');
const groupes = require('../data/groupes');
const identite = require('../core/identite');
const croisements = require('../review/croisements');
const empilees = require('../review/empilees');
const reprise = require('../session/reprise');

const MAX_PAR_SECTION = 12;
const JOUR = 86400000;

/* ---------- Petits outils ---------- */
const attache = () => datasync.estConfigure() || process.env.MERGERIE_DEMO === '1';
const jours = (iso, maintenant) => (iso && Number.isFinite(Date.parse(iso)) ? Math.max(0, (maintenant.getTime() - Date.parse(iso)) / JOUR) : null);
/* Les jours OUVRÉS écoulés depuis une date : le week-end ne compte pas — un poste muet du vendredi
   soir au lundi matin n'est pas silencieux. */
function joursOuvres(iso, maintenant) {
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) return null;
  let n = 0;
  const d = new Date(t0);
  d.setUTCHours(0, 0, 0, 0);
  const fin = new Date(maintenant); fin.setUTCHours(0, 0, 0, 0);
  while (d < fin) {
    d.setUTCDate(d.getUTCDate() + 1);
    const j = d.getUTCDay();
    if (j !== 0 && j !== 6) n += 1;
  }
  return n;
}
const borner = (liste, limite = MAX_PAR_SECTION) => ({ items: liste.slice(0, limite), more: Math.max(0, liste.length - limite) });

/* L'auteur d'une ligne partagée : celui qui a commité son fichier ; une ligne d'ici pas encore poussée
   a pour auteur l'identité locale. */
function auteursDes(table, rows) {
  const moi = identite.nom() || null;
  const chemins = new Map();
  for (const r of rows) { const c = store.cheminSur(table, r); if (c) chemins.set(r.id, c); }
  const parFichier = datasync.auteursDe([...new Set(chemins.values())]);
  return new Map(rows.map((r) => [r.id, (chemins.has(r.id) && parFichier.get(chemins.get(r.id))) || moi]));
}
const premiereQuestion = (json) => {
  try {
    const qs = JSON.parse(json || '[]') || [];
    const q = qs.find((x) => x && (x.answer == null || !String(x.answer).trim())) || qs[0];
    return q ? String(q.question || '').trim() : '';
  } catch { return ''; }
};

/* ---------- Les sections ---------- */

/* 1. DÉCISIONS EN ATTENTE : une merge request ouverte dont le dernier rapport atteint le seuil d'équipe,
   et que personne n'a encore classée (statut « traitée ») ni mergée. Attente = depuis le rapport. */
function decisionsEnAttente(maintenant, seuil, reposFiltre) {
  const n = (Number(seuil) > 0 ? Number(seuil) : 8) / 10;
  const rows = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.repo_id, mr.status, repo.project,
      rv.id AS review_id, rv.uid AS review_uid, rv.note_value, COALESCE(rv.updated_at, rv.created_at) AS review_at
    FROM mr JOIN repo ON repo.id = mr.repo_id JOIN review rv ON rv.mr_id = mr.id
    WHERE COALESCE(mr.closed_seen, 0) = 0 AND mr.status IN ('to_review', 'reviewed') AND mr.merged_at IS NULL
      AND rv.note_value >= ?`).all(n).filter((r) => !reposFiltre || reposFiltre.has(r.repo_id));
  // Le chemin du fichier de review se calcule sur la ligne ENTIÈRE (forge, projet, iid) : on la relit.
  const reviewsRows = rows.length ? db.prepare(`SELECT * FROM review WHERE id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.review_id)) : [];
  const reviewers = auteursDes('review', reviewsRows);
  return rows.map((r) => ({
    mr_id: r.id, iid: r.iid, title: r.title || '', project: r.project, status: r.status, author: r.author || null,
    score: Math.round(Number(r.note_value) * 100) / 10, reviewer: reviewers.get(r.review_id) || null,
    since: r.review_at || null, waiting_days: jours(r.review_at, maintenant),
  })).sort((a, b) => (b.waiting_days || 0) - (a.waiting_days || 0));
}

/* Les sessions partagées, avec leur auteur et leur premier dépôt — la base des sections 2, 3 et 4. */
function sessionsPartagees() {
  const rows = db.prepare(`SELECT task.*, repo.project AS project FROM task JOIN repo ON repo.id = task.repo_id
    WHERE task.shared = 1 AND task.kind IN ('code', 'explore')`).all();
  const auteurs = auteursDes('task', rows);
  return rows.map((t) => ({ ...t, auteur: auteurs.get(t.id) || null }));
}

/* 2. QUESTIONS SANS RÉPONSE : les cibles de sessions PARTAGÉES en attente d'une réponse. Si une reprise
   l'a prise en charge, la ligne le dit. */
function questionsSansReponse(maintenant, sessions, reposFiltre) {
  const parId = new Map(sessions.map((s) => [s.id, s]));
  const rows = db.prepare(`SELECT tt.id, tt.uid, tt.task_id, tt.repo_id, tt.branch, tt.questions_json, tt.updated_at, repo.project
    FROM task_target tt JOIN repo ON repo.id = tt.repo_id JOIN task ON task.id = tt.task_id
    WHERE tt.status = 'needs_input' AND task.shared = 1`).all().filter((r) => parId.has(r.task_id) && (!reposFiltre || reposFiltre.has(r.repo_id)));
  const reprises = reprise.reprisesDe([...new Set(rows.map((r) => parId.get(r.task_id).uid).filter(Boolean))]);
  return rows.map((r) => {
    const s = parId.get(r.task_id);
    const rep = (reprises.get(s.uid) || []).filter((x) => x.target_uid === r.uid);
    return {
      task_id: r.task_id, target_id: r.id, author: s.auteur, project: r.project, branch: r.branch, since: r.updated_at,
      waiting_days: jours(r.updated_at, maintenant), question: premiereQuestion(r.questions_json),
      answered_in: rep.length ? rep[0].id : null,
    };
  }).sort((a, b) => (!!a.answered_in - !!b.answered_in) || (b.waiting_days || 0) - (a.waiting_days || 0));   // celles qui attendent encore d'abord
}

/* 3. SESSIONS EN COURS : partagées et marquées `running` à la dernière synchronisation — la fraîcheur
   de la synchro de leur auteur est toujours dite. */
function sessionsEnCours(maintenant, sessions, fraicheur, reposFiltre) {
  return sessions.filter((s) => s.status === 'running' && (!reposFiltre || reposFiltre.has(s.repo_id))).map((s) => ({
    task_id: s.id, author: s.auteur, project: s.project, label: s.label || null, since: s.updated_at || s.created_at,
    running_minutes: jours(s.updated_at || s.created_at, maintenant) != null ? Math.round(jours(s.updated_at || s.created_at, maintenant) * 24 * 60) : null,
    synced_at: (s.auteur && fraicheur.get(s.auteur)) || null,
  })).sort((a, b) => String(b.since || '').localeCompare(String(a.since || '')));
}

/* 4. REPRISES : les sessions reprises par quelqu'un d'autre que leur auteur, en cours ou terminées depuis
   moins de N jours. */
function reprises(maintenant, sessions, fenetreJours, reposFiltre) {
  const parUid = new Map(sessions.map((s) => [s.uid, s]));
  const rows = db.prepare(`SELECT task.*, repo.project AS project FROM task JOIN repo ON repo.id = task.repo_id
    WHERE task.resumed_from_uid IS NOT NULL`).all();
  const auteurs = auteursDes('task', rows);
  return rows.map((t) => {
    const origine = parUid.get(t.resumed_from_uid) || null;
    const qui = auteurs.get(t.id) || null;
    return { t, origine, qui };
  }).filter(({ t, origine, qui }) => origine && origine.auteur && qui && origine.auteur !== qui
    && (!reposFiltre || reposFiltre.has(t.repo_id))
    && (t.status === 'running' || (jours(t.finished_at || t.updated_at || t.created_at, maintenant) ?? Infinity) <= fenetreJours))
    .map(({ t, origine, qui }) => ({
      from_task_id: origine.id, from_author: origine.auteur, task_id: t.id, author: qui, project: t.project,
      status: t.status, at: t.finished_at || t.updated_at || t.created_at,
    })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/* 5. VÉRIFICATIONS EN ÉCHEC : la dernière vérification de chaque merge request ouverte, quand elle a
   cassé sur la tête et passait sur la base (`verified_fail`) — une base déjà rouge n'accuse pas la MR. */
function verificationsEnEchec(maintenant, reposFiltre) {
  const derniere = new Map();
  for (const v of db.prepare("SELECT id, verdict, targets_json, imputable_json, finished_at, verifier_name FROM verification WHERE status IN ('done', 'error') ORDER BY id DESC LIMIT 500").all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    for (const c of cibles) if (c.mr_id && !derniere.has(c.mr_id)) derniere.set(c.mr_id, { v, c });
  }
  const out = [];
  for (const [mrId, { v, c }] of derniere) {
    if (v.verdict !== 'verified_fail') continue;
    const mr = db.prepare('SELECT mr.id, mr.iid, mr.author, mr.repo_id, mr.status, mr.current_sha, repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ? AND COALESCE(mr.closed_seen, 0) = 0').get(mrId);
    if (!mr || (reposFiltre && !reposFiltre.has(mr.repo_id))) continue;
    if (mr.current_sha && c.head_sha && c.head_sha !== mr.current_sha) continue;   // périmée : le code a bougé
    let imputable = [];
    try { imputable = JSON.parse(v.imputable_json || '[]'); } catch { imputable = []; }
    out.push({ mr_id: mr.id, iid: mr.iid, project: mr.project, status: mr.status, author: mr.author || null, verification_id: v.id, failed: imputable.length, at: v.finished_at, days: jours(v.finished_at, maintenant) });
  }
  return out.sort((a, b) => (a.days || 0) - (b.days || 0));
}

/* 6. CROISEMENTS ET EMPILEMENTS : les paires déjà calculées, vues pour toute l'équipe, avec les auteurs
   des deux côtés. Aucun recalcul. */
function croisementsEtEmpilements(cfg, reposFiltre) {
  const auteurDe = db.prepare('SELECT author FROM mr WHERE id = ?');
  const nom = (id) => ((auteurDe.get(id) || {}).author || null);
  const paires = croisements.paires(cfg, 0).filter((p) => !reposFiltre || reposFiltre.has(p.repo_id)).map((p) => ({
    kind: 'overlap', project: p.project, a_id: p.a_id, a_iid: p.a_iid, a_author: nom(p.a_id), b_id: p.b_id, b_iid: p.b_iid, b_author: nom(p.b_id), shared: p.shared,
  }));
  const cartes = empilees.pourCartes(cfg);
  const piles = [];
  for (const [id, c] of Object.entries(cartes)) {
    for (const inner of (c.contains || [])) {
      const outer = db.prepare('SELECT mr.id, mr.iid, mr.author, mr.repo_id, repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?').get(Number(id));
      if (!outer || (reposFiltre && !reposFiltre.has(outer.repo_id))) continue;
      piles.push({ kind: 'stack', project: outer.project, a_id: outer.id, a_iid: outer.iid, a_author: outer.author || null, b_id: inner.id, b_iid: inner.iid, b_author: inner.author || null, shared: inner.shared });
    }
  }
  return [...paires, ...piles];
}

/* 7. FRAÎCHEUR DES POSTES : une ligne par auteur connu du dépôt de données — sa dernière synchro, le
   nombre de décisions attendues de lui (les siennes), « silencieux » au-delà de N jours ouvrés. Rien d'autre. */
function fraicheurDesPostes(maintenant, fraicheur, decisions, silencieuxJours, autresAuteurs = []) {
  const noms = new Set([...fraicheur.keys(), ...autresAuteurs.filter(Boolean)]);
  return [...noms].map((nom) => {
    const last = fraicheur.get(nom) || null;
    const ouvres = last ? joursOuvres(last, maintenant) : null;
    return {
      name: nom, synced_at: last, quiet: ouvres == null ? false : ouvres > silencieuxJours,
      decisions_awaited: decisions.filter((d) => memePersonne(d.author, nom)).length,
    };
  }).sort((a, b) => String(b.synced_at || '').localeCompare(String(a.synced_at || '')) || a.name.localeCompare(b.name));
}

/* ---------- Une personne, deux noms ----------
   L'auteur d'une merge request est son identifiant de forge (`amady`, `noah`) ; l'auteur d'un fichier du
   dépôt de données est son nom git (`Amady`, `Claire`). La même personne porte donc deux noms, et le
   filtre « Personne » ne retrouvait pas ses merge requests. On rapproche par une clé sans casse ni
   accents ni ponctuation : `amady` = `Amady`, `ines` = `Inès`. Rien n'est stocké, rien n'est deviné de
   plus — deux noms vraiment différents (`noah` sur la forge, `Noé` dans git) restent deux personnes. */
const cleNom = (nom) => String(nom || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const memePersonne = (a, b) => !!a && !!b && cleNom(a) === cleNom(b);
/* Les auteurs de merge requests dont le nom git est connu s'affichent sous ce nom : une seule graphie par
   personne sur la page. */
function harmoniserNoms(d) {
  const parCle = new Map(d.workstations.map((w) => [cleNom(w.name), w.name]));
  const nom = (x) => (x && parCle.get(cleNom(x))) || x || null;
  return {
    ...d,
    decisions: d.decisions.map((x) => ({ ...x, author: nom(x.author) })),
    failing: d.failing.map((x) => ({ ...x, author: nom(x.author) })),
    pairs: d.pairs.map((x) => ({ ...x, a_author: nom(x.a_author), b_author: nom(x.b_author) })),
  };
}
/* Le filtre « Personne » propose chaque nom une fois : les postes du dépôt de données d'abord, puis les
   auteurs de merge requests qui n'y figurent sous aucune graphie. */
function personnes(d) {
  const vues = new Map(d.workstations.map((w) => [cleNom(w.name), w.name]));
  for (const x of [...d.decisions, ...d.failing]) if (x.author && !vues.has(cleNom(x.author))) vues.set(cleNom(x.author), x.author);
  for (const x of d.pairs) for (const a of [x.a_author, x.b_author]) if (a && !vues.has(cleNom(a))) vues.set(cleNom(a), a);
  return [...vues.values()];
}

/* ---------- La page ---------- */

/* `personne` : « ce qui l'attend, elle » — ses décisions, ses questions, ses sessions, ses reprises, les
   vérifications de ses merge requests, les paires où elle figure, sa ligne de fraîcheur. */
function filtrerPersonne(d, p) {
  if (!p) return d;
  const est = (x) => memePersonne(x, p);
  return {
    ...d,
    decisions: d.decisions.filter((x) => est(x.author)),
    questions: d.questions.filter((x) => est(x.author)),
    running: d.running.filter((x) => est(x.author)),
    takeovers: d.takeovers.filter((x) => est(x.author) || est(x.from_author)),
    failing: d.failing.filter((x) => est(x.author)),
    pairs: d.pairs.filter((x) => est(x.a_author) || est(x.b_author)),
    workstations: d.workstations.filter((x) => est(x.name)),
  };
}

function construire(cfg = {}, { maintenant = new Date(), seuilPret = 8, silencieuxJours = 2, repriseJours = 7, groupId = null, personne = null } = {}) {
  if (!attache()) return { attached: false };
  const reposFiltre = groupId ? new Set(groupes.membres(groupId)) : null;
  const fraicheur = datasync.fraicheurAuteurs();
  const sessions = sessionsPartagees();
  const decisions = decisionsEnAttente(maintenant, seuilPret, reposFiltre);
  const brut = {
    attached: true,
    decisions,
    questions: questionsSansReponse(maintenant, sessions, reposFiltre),
    running: sessionsEnCours(maintenant, sessions, fraicheur, reposFiltre),
    takeovers: reprises(maintenant, sessions, Number(repriseJours) >= 0 ? Number(repriseJours) : 7, reposFiltre),
    failing: verificationsEnEchec(maintenant, reposFiltre),
    pairs: croisementsEtEmpilements(cfg, reposFiltre),
    workstations: fraicheurDesPostes(maintenant, fraicheur, decisions, Number(silencieuxJours) >= 0 ? Number(silencieuxJours) : 2, sessions.map((s) => s.auteur)),
  };
  const d = filtrerPersonne(harmoniserNoms(brut), personne);
  const sections = {};
  for (const k of ['decisions', 'questions', 'running', 'takeovers', 'failing', 'pairs', 'workstations']) sections[k] = borner(d[k]);
  return {
    attached: true,
    /* Une question qu'une reprise a prise en charge reste listée, annotée — mais elle n'attend plus
       personne : le compteur ne la compte pas. */
    counts: { decisions: d.decisions.length, questions: d.questions.filter((q) => !q.answered_in).length, running: d.running.length },
    people: personnes(harmoniserNoms(brut)),
    single_person: brut.workstations.length <= 1,
    threshold: Number(seuilPret) > 0 ? Number(seuilPret) : 8,
    empty: Object.values(sections).every((s) => !s.items.length || s === sections.workstations) && !d.decisions.length && !d.questions.length && !d.running.length && !d.takeovers.length && !d.failing.length && !d.pairs.length,
    ...sections,
  };
}

module.exports = { construire, joursOuvres, cleNom, memePersonne, MAX_PAR_SECTION, decisionsEnAttente, questionsSansReponse, sessionsEnCours, reprises, verificationsEnEchec, croisementsEtEmpilements, fraicheurDesPostes };
