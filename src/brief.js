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
  const out = db.prepare(`SELECT t.id, t.prompt, t.kind, COUNT(*) n
    FROM task_target tt JOIN task t ON t.id = tt.task_id
    WHERE tt.status = 'needs_input'
    GROUP BY t.id ORDER BY t.id DESC LIMIT ?`).all(limite)
    .map((r) => ({ task_id: r.id, prompt: r.prompt, kind: r.kind, targets: r.n }));
  /* TOP 20 — ET LES SESSIONS HORS DÉPÔT, qui attendent exactement de la même façon. La requête
     ne lisait que `task_target` : une session hors dépôt arrêtée sur une question n'a pas de
     projet, elle n'apparaissait donc nulle part — alors que c'est la plus facile à oublier,
     puisqu'elle ne laisse ni branche ni merge request pour la rappeler. Une question libre
     bloquée compte pour la même raison. */
  const autres = (table, kind) => {
    try {
      return db.prepare(`SELECT id, prompt FROM ${table} WHERE status = 'needs_input'
        ORDER BY id DESC LIMIT ?`).all(limite).map((r) => ({ task_id: r.id, prompt: r.prompt, kind, targets: 0 }));
    } catch { return []; }
  };
  return [...out, ...autres('local_task', 'local'), ...autres('question', 'ask')].slice(0, limite);
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

/* 8. PRÊTES À MERGER (B11) — pas une section, un NOMBRE. « Qu'est-ce que je peux merger
   maintenant ? » se lisait en parcourant onze cartes et trois badges chacune. Trois colonnes
   déjà en base suffisent : la note de la dernière review, le verdict de la dernière
   vérification, l'état du ticket. L'outil ne merge rien — il compte ce qui ne demande plus
   rien, et la file porte la même puce pour aller les voir. */
function pretesAMerger(seuil) {
  /* LE SEUIL EST DONNÉ SUR 10, LA NOTE EST STOCKÉE SUR 1. `review.note_value` vaut 0,84 pour
     une note de 8,4 — c'est la convention de toute la base (`note_value * 10` partout à
     l'affichage). La comparaison se faisait sans conversion : `0,84 >= 8` est faux, et le
     compte rendait donc TOUJOURS zéro, quelle que soit la file. Le défaut se cachait derrière
     le précédent, qui, lui, élargissait à tort — les deux se compensaient en silence. */
  const n = (Number(seuil) > 0 ? Number(seuil) : 8) / 10;
  /* La PÉREMPTION d'un verdict ne se lit pas en SQL : les cibles d'une vérification vivent en
     JSON (`targets_json`), et « périmé » veut dire que le SHA testé n'est plus le SHA courant.
     On applique donc la règle de l'écran, mot pour mot — un second critère de péremption ici
     ferait dire deux choses différentes au même mot. */
  /* LA DERNIÈRE VÉRIFICATION D'UNE MR NE SE JOINT PAS EN SQL. `verification` n'a pas de
     colonne `mr_id` — ses cibles vivent dans `targets_json`. La sous-requête qui l'essayait
     (`WHERE mr_id = mr.id`) ne portait donc pas sur `verification` : SQLite résolvait `mr_id`
     sur le `review` de la requête externe, la condition devenait tautologique, et TOUTES les
     merge requests héritaient de la dernière vérification de la base. Une seule verte quelque
     part suffisait à déclarer « prête à merger » tout ce qui était noté au-dessus du seuil.
     On relit donc les vérifications du plus récent au plus ancien et on retient la première
     rencontrée pour chaque MR — le même geste que le reste du brief, qui lit déjà ses cibles
     en JSON. Le volume est celui d'un outil mono-utilisateur : quelques centaines de lignes. */
  const derniere = new Map();
  for (const v of db.prepare("SELECT id, verdict, targets_json FROM verification WHERE status = 'done' ORDER BY id DESC").all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    for (const c of cibles) {
      if (c.mr_id && !derniere.has(c.mr_id)) derniere.set(c.mr_id, { verdict: v.verdict, cibles });
    }
  }
  const lignes = db.prepare(`SELECT mr.id, mr.current_sha, review.note_value
    FROM mr
    JOIN review ON review.mr_id = mr.id
    WHERE COALESCE(mr.closed_seen, 0) = 0
      AND COALESCE(mr.has_conflicts, 0) = 0
      AND mr.status IN ('to_review','reviewed')
      AND review.note_value >= ?
      AND (mr.ticket_jira_category IS NULL OR mr.ticket_jira_category = ''
           OR mr.ticket_jira_category = 'indeterminate')`).all(n);
  return lignes.filter((r) => {
    const v = derniere.get(r.id);
    if (!v || v.verdict !== 'verified_pass') return false;
    const perime = v.cibles.some((c) => c.mr_id === r.id && r.current_sha && c.head_sha && c.head_sha !== r.current_sha);
    return !perime;
  }).length;
}

/* TOP 1 — LES BROUILLONS DE COMMENTAIRES QUI DORMENT. Groupés par merge request, les plus
   anciens d'abord : c'est l'ancienneté qui inquiète — trois remarques écrites hier se
   retrouvent, trois remarques écrites il y a deux semaines sont perdues. */
function brouillonsEnAttente(limite = MAX_PAR_SECTION) {
  return db.prepare(`SELECT d.mr_id, COUNT(*) AS n, MIN(d.created_at) AS depuis,
      mr.iid, mr.title, repo.project
    FROM mr_comment_draft d
    JOIN mr ON mr.id = d.mr_id
    JOIN repo ON repo.id = mr.repo_id
    WHERE COALESCE(mr.closed_seen, 0) = 0
    GROUP BY d.mr_id ORDER BY depuis ASC LIMIT ?`).all(limite)
    .map((r) => ({ mr_id: r.mr_id, iid: r.iid, title: r.title || '', project: r.project, n: r.n, depuis: r.depuis }));
}

/* TOP 20 — LES SUIVIS ÉCRITS ET JAMAIS ENVOYÉS, pour les trois saveurs qui en ont un. La
   colonne existe depuis longtemps sur `task`, `local_task` et `question` ; personne ne la
   relisait ailleurs que sur la carte elle-même. */
function suivisEnAttente(limite = MAX_PAR_SECTION) {
  const out = [];
  const ajouter = (rows, kind) => {
    for (const r of rows) {
      out.push({
        kind, id: r.id, label: r.label || String(r.prompt || '').slice(0, 60),
        texte: String(r.followup_draft || '').split('\n')[0].slice(0, 120),
        auto: !!r.followup_auto, at: r.updated_at,
      });
    }
  };
  const req = (table) => {
    try {
      return db.prepare(`SELECT id, label, prompt, followup_draft, followup_auto, updated_at FROM ${table}
        WHERE followup_draft IS NOT NULL AND TRIM(followup_draft) <> ''
          AND status <> 'running'
        ORDER BY updated_at DESC LIMIT ?`).all(limite);
    } catch { return []; }
  };
  ajouter(req('task'), 'task');
  ajouter(req('local_task'), 'local');
  ajouter(req('question'), 'ask');
  return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limite);
}

/* B14 — CE QUE GIT A LAISSÉ EN PLAN. Un merge résolu à moitié la veille au soir est le seul
   travail de l'outil qui vit dans un DOSSIER de travail et nulle part ailleurs : ni onglet
   avec un badge, ni file de jobs, rien qui le rappelle le lendemain matin. Et une opération
   git en échec (une branche non supprimée, un tag refusé) n'était visible qu'en rouvrant
   l'historique du lot. Les deux réclament un geste : ils appartiennent au brief.

   Un merge « pushed » est fini ; les autres états — `conflict`, `ready`, `committed` — disent
   tous « le dossier attend quelque chose de toi ». */
function gitEnSuspens(maintenant, limite = MAX_PAR_SECTION) {
  const out = [];
  for (const r of db.prepare(`SELECT m.id, m.source_branch, m.target_branch, m.status, m.updated_at, repo.project
      FROM git_merge m JOIN repo ON repo.id = m.repo_id
      WHERE m.status <> 'pushed' ORDER BY m.updated_at DESC LIMIT ?`).all(limite)) {
    out.push({
      kind: 'merge', merge_id: r.id, project: r.project, status: r.status,
      source: r.source_branch, target: r.target_branch, at: r.updated_at,
    });
  }
  const depuis = new Date(maintenant.getTime() - JOUR_MS).toISOString();
  for (const r of db.prepare(`SELECT batch_id, action, project, ref_name, error, created_at, COUNT(*) AS n
      FROM git_op WHERE status = 'error' AND created_at >= ?
      GROUP BY batch_id ORDER BY created_at DESC LIMIT ?`).all(depuis, limite)) {
    out.push({
      kind: 'op', batch_id: r.batch_id, action: r.action, project: r.project, ref: r.ref_name,
      n: r.n, error: String(r.error || '').slice(0, 120), at: r.created_at,
    });
  }
  return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limite);
}

/* Le brief complet. `sections` porte l'ordre ET le vide : le front n'a qu'à sauter ce qui
   est vide, sans avoir à connaître la règle de composition — elle est ici, en un endroit. */
/* CE QUE LES AGENTS ONT PRODUIT DEPUIS HIER. Le documentaliste planifié tourne à 7:00 : sans
   cette section, personne ne saurait qu'il a mis à jour « Carte des services » — et une page
   dont on ignore qu'elle vient de changer ne sert à rien. On dit aussi ce qui ATTEND : un run
   arrêté sur une question, une connaissance en attente de validation. */
function agentsRecents(maintenant, limite = MAX_PAR_SECTION) {
  const depuis = new Date(maintenant.getTime() - 24 * 3600 * 1000).toISOString();
  const out = [];
  for (const r of db.prepare(`SELECT t.id, t.agent_id, t.agent_name, t.status, t.md_path,
      COALESCE(t.finished_at, t.updated_at) AS at, a.output_kind, a.output_ref
    FROM task t LEFT JOIN agent a ON a.id = t.agent_id
    WHERE t.agent_id IS NOT NULL AND COALESCE(t.finished_at, t.updated_at) >= ?
    ORDER BY at DESC LIMIT ?`).all(depuis, limite * 2)) {
    if (r.status === 'needs_input') { out.push({ agent_id: r.agent_id, name: r.agent_name, kind: 'needs_input', task_id: r.id, title: '', at: r.at }); continue; }
    if (r.status !== 'done') continue;
    if (r.output_kind === 'note_page' && r.output_ref) {
      const page = db.prepare('SELECT title FROM note_page WHERE id = ?').get(Number(r.output_ref));
      if (page) { out.push({ agent_id: r.agent_id, name: r.agent_name, kind: 'note_page', task_id: r.id, page_id: Number(r.output_ref), title: page.title, at: r.at }); continue; }
    }
    out.push({ agent_id: r.agent_id, name: r.agent_name, kind: 'report', task_id: r.id, title: '', at: r.at });
  }
  for (const k of db.prepare(`SELECT k.agent_id, k.version, k.created_at, a.name FROM agent_knowledge k
      JOIN agent a ON a.id = k.agent_id WHERE k.status = 'pending' ORDER BY k.created_at DESC LIMIT ?`).all(limite)) {
    out.push({ agent_id: k.agent_id, name: k.name, kind: 'pending', version: k.version, title: '', at: k.created_at });
  }
  return out.slice(0, limite);
}

function construire({ maintenant = new Date(), staleDays = 5, seuilPret = 8, dockerDown = null } = {}) {
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
    ready_to_merge: pretesAMerger(seuilPret),
    ready_threshold: Number(seuilPret) > 0 ? Number(seuilPret) : 8,
    agents: agentsRecents(maintenant),
    /* TOP 1 — LES REMARQUES ÉCRITES ET JAMAIS ENVOYÉES. C'est la perte de travail la plus
       silencieuse de l'outil : trois commentaires inline rédigés dans le viewer, la fenêtre
       refermée, et la merge request qui se merge sans eux. Le brief est le bon endroit pour
       les rattraper — c'est l'écran qui dit ce qui attend un geste. */
    drafts: brouillonsEnAttente(),
    /* TOP 20 — ET LES SUIVIS ÉCRITS, JAMAIS ENVOYÉS. Même famille : on rédige une correction
       pendant que la session tourne, on passe à autre chose, et elle attend pour toujours si
       la case « automatiquement » n'était pas cochée. */
    followups: suivisEnAttente(),
    /* B14 — les merges à finir et les opérations git en échec. */
    git: gitEnSuspens(maintenant),
    /* TOP 14 — LES CONTENEURS TOMBÉS, tels que la veille de fond les a vus au dernier tour.
       Le brief n'interroge pas Docker lui-même : il reste sans réseau et sans attente, et ce
       qu'il montre est daté (`at`) pour que personne ne prenne un relevé d'il y a une minute
       pour un état live. Rien mesuré (Docker absent, serveur qui vient de démarrer) → pas de
       section, plutôt qu'un « 0 conteneur tombé » qui prétendrait avoir regardé. */
    docker: dockerDown && dockerDown.at
      ? { at: dockerDown.at, containers: (dockerDown.containers || []).slice(0, MAX_PAR_SECTION) }
      : null,
  };
}

module.exports = { construire, MAX_PAR_SECTION, ECARTABLES };
