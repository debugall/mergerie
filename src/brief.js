'use strict';
/* Le brief « Aujourd'hui » — ce qui ouvre la journée.
 *
 * Sept sections, ORDONNÉES ACTION D'ABORD : ce qui réclame un geste avant ce qui informe.
 * Une section vide n'est pas rendue — un écran qui affiche sept titres dont six sous-titrés
 * « rien » apprend qu'il ne s'est rien passé, ce qui n'était pas la question.
 *
 * ZÉRO IA, ZÉRO RÉSEAU. Tout vient de la base en quelques requêtes : le brief doit s'afficher
 * instantanément à l'ouverture, et coûter zéro token. Un résumé rédigé par un agent était
 * tentant ; il aurait fait payer un appel à chaque premier café, pour reformuler des faits
 * qui se lisent déjà.
 *
 * Chaque item porte de quoi NAVIGUER vers son objet (`kind` + identifiants). Le brief ne
 * fabrique pas d'URL : c'est le front qui sait où vivent les onglets.
 */

const db = require('./db');
const verifyLib = require('./verify');

const JOUR_MS = 24 * 60 * 60 * 1000;

/* Les sections dont une ligne peut être ÉCARTÉE, et sous quelle clé. Une todo n'y est pas :
   elle a déjà ses gestes propres (cocher, reporter), et un troisième verbe pour la faire
   disparaître d'un seul écran sèmerait la confusion sur ce qu'on vient de faire d'elle. */
const ECARTABLES = ['verification', 'session', 'mr', 'sess'];

function ecartes() {
  const par = {};
  for (const k of ECARTABLES) par[k] = new Set();
  for (const r of db.prepare('SELECT kind, ref FROM brief_hidden').all()) {
    if (par[r.kind]) par[r.kind].add(String(r.ref));
  }
  return par;
}
// Combien d'items au plus par section. Un brief se lit debout, café en main : au-delà, ce
// n'est plus un brief mais la liste elle-même, qui existe déjà dans son onglet.
const MAX_PAR_SECTION = 8;

/* Fin de la journée en cours, heure LOCALE. « Dû aujourd'hui » se juge au cadran de celui
   qui lit, pas en UTC : à 23 h à Paris, une échéance « aujourd'hui » n'est pas demain. */
function finDuJour(maintenant) {
  const d = new Date(maintenant.getTime());
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/* 1. RAPPELS — échus + dus aujourd'hui. En tête parce que c'est le seul contenu du brief
   que l'utilisateur a lui-même programmé : il a demandé qu'on le lui rappelle. */
function rappels(maintenant) {
  return db.prepare(`SELECT * FROM todo
    WHERE status = 'open' AND archived_at IS NULL AND due_at IS NOT NULL AND due_at <= ?
    ORDER BY due_at LIMIT ?`).all(finDuJour(maintenant), MAX_PAR_SECTION);
}

/* 2. TODOS DU JOUR — la priorité HAUTE SANS ÉCHÉANCE, et rien d'autre. « Important mais sans
   date » est exactement ce qui se perd : rien ne le remonte jamais tout seul, alors que ce
   qui porte une échéance finit par se signaler.

   Tout ce qui est daté pour aujourd'hui appartient à §1 — `rappels` prend déjà `due_at`
   jusqu'à la fin de la journée, pas seulement l'échu. La requête portait une seconde branche
   « ou échéance aujourd'hui » suivie d'un `NOT IN` qui excluait ce même ensemble : elle ne
   pouvait rien ramener, et le `NOT IN` retirait en prime les datées AU-DELÀ des huit lignes
   affichées par §1 — elles disparaissaient alors du brief entier. Une seule règle, écrite une
   fois : ce qui a une date est un rappel, ce qui n'en a pas et compte est une todo du jour. */
function todosDuJour() {
  return db.prepare(`SELECT * FROM todo
    WHERE status = 'open' AND archived_at IS NULL AND due_at IS NULL AND priority = 'high'
    ORDER BY id DESC LIMIT ?`).all(MAX_PAR_SECTION);
}

/* 3. SESSIONS EN ATTENTE DE RÉPONSE — l'agent s'est arrêté sur une question. Ce sont les
   items les plus coûteux à oublier : la session est bloquée, la file est libre, et rien ne
   repartira tant qu'on n'aura pas répondu. */
function sessionsEnAttente(limite = MAX_PAR_SECTION) {
  return db.prepare(`SELECT t.id, t.prompt, t.kind, COUNT(*) n
    FROM task_target tt JOIN task t ON t.id = tt.task_id
    WHERE tt.status = 'needs_input'
    GROUP BY t.id ORDER BY t.id DESC LIMIT ?`).all(limite)
    .map((r) => ({ task_id: r.id, prompt: r.prompt, kind: r.kind, targets: r.n }));
}

/* 4. VÉRIFICATIONS EN ÉCHEC — le dernier verdict rouge par lot / MR, périmés exclus.
   Périmé = la branche a bougé depuis : le verdict porte sur du code qui n'est plus là, et
   le montrer comme actionnable enverrait corriger un problème peut-être déjà corrigé.
   On ne garde que la DERNIÈRE vérification de chaque lot (ou de chaque MR seule) : les
   précédentes sont de l'histoire, pas du travail. */
function verificationsEnEchec(limite = MAX_PAR_SECTION) {
  const lignes = db.prepare(`SELECT * FROM verification
    WHERE status IN ('done','error') AND verdict = 'verified_fail'
    ORDER BY id DESC LIMIT 100`).all();
  const vues = new Set();
  const out = [];
  // Préparés UNE fois pour toute la boucle, comme partout ailleurs dans le projet.
  const lireMr = db.prepare('SELECT iid, current_sha, repo_id FROM mr WHERE id = ?');
  const lireRepo = db.prepare('SELECT project FROM repo WHERE id = ?');
  for (const v of lignes) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    // Une clé par lot ; une vérification de MR seule (lot_id NULL) est sa propre clé.
    /* Une clé par lot ; une MR seule est sa propre clé ; une vérification de BRANCHE se
       dédoublonne sur dépôt + branche — « develop est rouge » ne doit apparaître qu'une fois,
       même vérifié trois fois dans la nuit. */
    const premiere = cibles[0] || {};
    const cle = v.lot_id ? `lot:${v.lot_id}`
      : (premiere.mr_id ? `mr:${premiere.mr_id}` : `branche:${premiere.repo_id}:${premiere.branch || ''}`);
    if (vues.has(cle)) continue;
    vues.add(cle);
    const shaParMr = {};
    /* UNE CIBLE PEUT N'AVOIR AUCUNE MERGE REQUEST : c'est une vérification de BRANCHE (« est-ce
       que develop est encore vert ? »). Le dépôt se lit alors sur la cible elle-même, sinon la
       ligne du brief sort vide — et un rouge invisible ne sert à rien. */
    const enrichies = cibles.map((c) => {
      const mr = c.mr_id ? lireMr.get(c.mr_id) : null;
      if (mr) shaParMr[c.mr_id] = mr.current_sha;
      const repo = lireRepo.get(mr ? mr.repo_id : c.repo_id);
      return { ...c, iid: mr ? mr.iid : null, project: (repo && repo.project) || null };
    });
    if (verifyLib.estPerime(enrichies, shaParMr)) continue;
    let imputable = [];
    try { imputable = JSON.parse(v.imputable_json || '[]'); } catch { /* illisible */ }
    out.push({
      verification_id: v.id,
      verifier_name: v.verifier_name || '',
      lot_id: v.lot_id, lot_name: v.lot_name,
      finished_at: v.finished_at,
      failed: imputable.length,
      failed_label: (imputable[0] || {}).test || null,
      // `branch` voyage AVEC la cible : c'est ce qui permet à l'écran d'écrire « dépôt · branche ».
      targets: enrichies.map((c) => ({ mr_id: c.mr_id, iid: c.iid, project: c.project, branch: c.branch })),
    });
    if (out.length >= limite) break;
  }
  return out;
}

/* 4 bis. LES SESSIONS DE DEV QUI ATTENDENT UN GESTE. Trois attentes distinctes, et c'est
   toujours LE MÊME oubli : le travail est fait, il ne manque qu'un clic. Une session jamais
   lancée ne produira rien ; une branche commitée mais pas poussée n'existe pour personne ;
   une branche poussée sans MR ne sera jamais relue. On rend des NOMBRES et non des listes :
   c'est un rappel, le détail vit dans l'onglet Dev IA — et à trois lignes de plus par section,
   le brief cesserait d'être un brief. */
function sessionsEnAttente2() {
  const c = (sql, ...a2) => db.prepare(sql).get(...a2).c;
  return {
    to_run: c("SELECT COUNT(*) c FROM task WHERE status = 'new'")
      + c("SELECT COUNT(*) c FROM local_task WHERE status = 'new'"),
    to_push: c("SELECT COUNT(*) c FROM task_target WHERE status = 'committed'"),
    /* Poussée mais sans MR — ni celle qu'on a créée (`mr_iid`), ni celle qui existait DÉJÀ sur
       la branche : c'est une jointure et non une colonne, exactement comme dans la liste des
       sessions. Compter la première seule proposerait d'ouvrir une seconde MR sur une branche
       qui en a déjà une, ce qui est pire que de se taire. */
    to_mr: c(`SELECT COUNT(*) c FROM task_target tt
      WHERE tt.status = 'pushed' AND COALESCE(tt.mr_iid, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM mr
          WHERE mr.repo_id = tt.repo_id AND mr.source_branch = tt.branch
            AND COALESCE(mr.closed_seen, 0) = 0)`),
  };
}

/* 5. MR À TRAITER — arrivées dans les dernières 24 h. Le brief ne redit pas la file entière
   (elle a son onglet et son badge) : il signale ce qui est TOMBÉ depuis hier, c'est-à-dire
   ce qu'on n'a pas encore pu voir. */
function mrFraiches(maintenant, limite = MAX_PAR_SECTION) {
  const depuis = new Date(maintenant.getTime() - JOUR_MS).toISOString();
  return db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, r.project
    FROM mr JOIN repo r ON r.id = mr.repo_id
    WHERE mr.status = 'to_review' AND mr.gitlab_created_at IS NOT NULL AND mr.gitlab_created_at >= ?
    ORDER BY mr.gitlab_created_at DESC LIMIT ?`).all(depuis, limite);
}

/* 6. MR DORMANTES — reviewées il y a plus de N jours et toujours ouvertes. C'est le travail
   qu'on a fait et qui ne sert à rien tant que personne ne merge : le rapport existe, la
   décision manque. Le seuil est réglable parce qu'il dépend du rythme de l'équipe. */
function mrDormantes(maintenant, jours, limite = MAX_PAR_SECTION) {
  const n = Number(jours) > 0 ? Number(jours) : 5;
  const limite2 = new Date(maintenant.getTime() - n * JOUR_MS).toISOString();
  return db.prepare(`SELECT mr.id, mr.iid, mr.title, r.project, review.updated_at reviewed_at,
      review.note_value
    FROM mr JOIN repo r ON r.id = mr.repo_id JOIN review ON review.mr_id = mr.id
    WHERE mr.status = 'reviewed' AND COALESCE(mr.closed_seen, 0) = 0
      AND review.updated_at IS NOT NULL AND review.updated_at < ?
    ORDER BY review.updated_at LIMIT ?`).all(limite2, limite)
    .map((m) => ({ ...m, days: Math.floor((maintenant.getTime() - new Date(m.reviewed_at).getTime()) / JOUR_MS) }));
}

/* 7. ACTIVITÉ DEPUIS HIER — une ligne, trois nombres. Volontairement pauvre : c'est du
   contexte, pas une tâche. Le détail vit dans les Statistiques. */
function activite(maintenant) {
  const depuis = new Date(maintenant.getTime() - JOUR_MS).toISOString();
  const compte = (sql, ...args) => db.prepare(sql).get(...args).c;
  return {
    merged: compte("SELECT COUNT(*) c FROM feed WHERE type = 'mr_merged' AND at >= ?", depuis),
    opened: compte("SELECT COUNT(*) c FROM feed WHERE type = 'mr_opened' AND at >= ?", depuis),
    verified: compte(`SELECT COUNT(*) c FROM verification
      WHERE status IN ('done','error') AND finished_at IS NOT NULL AND finished_at >= ?`, depuis),
  };
}

/* Le brief complet. `sections` porte l'ordre ET le vide : le front n'a qu'à sauter ce qui
   est vide, sans avoir à connaître la règle de composition — elle est ici, en un endroit. */
function construire({ maintenant = new Date(), staleDays = 5 } = {}) {
  const act = activite(maintenant);
  /* Le filtrage est posé ICI, après le calcul : chaque section garde une requête qui dit ce
     qui est VRAI, et l'écart se lit d'un seul endroit. Les sections plafonnent à huit lignes,
     donc on écarte avant de couper — sinon retirer une ligne n'en ferait pas remonter une
     neuvième, et la section rétrécirait au lieu de se renouveler. */
  const hors = ecartes();
  // On demande MAX + ce qui est écarté : juste de quoi refaire le plein, jamais toute la table.
  const budget = (kind) => MAX_PAR_SECTION + hors[kind].size;
  const garder = (liste, kind, cle) => liste.filter((x) => !hors[kind].has(String(cle(x)))).slice(0, MAX_PAR_SECTION);
  return {
    date: maintenant.toISOString(),
    reminders: rappels(maintenant),
    todos: todosDuJour(),
    sessions: garder(sessionsEnAttente(budget('session')), 'session', (s) => s.task_id),
    verifications: garder(verificationsEnEchec(budget('verification')), 'verification', (v) => v.verification_id),
    /* Écartable comme le reste : quelqu'un qui laisse volontiers des sessions non lancées ne
       veut pas qu'on le lui rappelle tous les matins. */
    pending_sessions: Object.fromEntries(Object.entries(sessionsEnAttente2())
      .map(([k, v]) => [k, hors.sess.has(k) ? 0 : v])),
    fresh_mrs: garder(mrFraiches(maintenant, budget('mr')), 'mr', (m) => m.id),
    stale_mrs: garder(mrDormantes(maintenant, staleDays, budget('mr')), 'mr', (m) => m.id),
    hidden_count: db.prepare('SELECT COUNT(*) c FROM brief_hidden').get().c,
    stale_days: Number(staleDays) > 0 ? Number(staleDays) : 5,
    // Une activité toute à zéro est un vide : la section se masque comme les autres.
    activity: (act.merged || act.opened || act.verified) ? act : null,
  };
}

module.exports = { construire, MAX_PAR_SECTION, ECARTABLES };
