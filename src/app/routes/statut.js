'use strict';
/* /api/status, /api/stats, /api/notifications, le tableau de bord et /api/whoami — ce que l’écran demande pour se peindre, sans rien lancer.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { extractNote } = require('../../review/note');
const store = require('../../data/store');
const identite = require('../../core/identite');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const jira = require('../../integrations/jira');
const notify = require('../../core/notify');
const notes = require('../../notes/notes');
const jobs = require('../../jobs');
const forge = require('../../forge');
const copilot = require('../../agent/copilot');
const tasks = require('../../agent/tasks');
const { readFileSafe, wrap } = require('../http');

/* ---------- Statut / config ---------- */
// Flux d'événements notifiables : le client passe le dernier id vu (?after=), on
// renvoie les nouveaux + le dernier id (pour ne rejouer aucun événement).
app.get('/api/notifications', wrap((req, res) => {
  res.json({ events: notify.since(req.query.after), latest: notify.latestId() });
}));
app.get('/api/status', wrap((req, res) => {
  res.json({
    demo: process.env.MERGERIE_DEMO === '1', // mode démo : données fictives, bannière affichée
    dryRun: copilot.isDryRun(),
    copilotAvailable: copilot.binaryAvailable(),
    copilotBin: copilot.COPILOT_BIN,
    copilotArgs: copilot.EXTRA_ARGS,
    copilotCmdPreview: `${copilot.COPILOT_BIN} ${[...copilot.EXTRA_ARGS, '-p', '"<prompt>"'].join(' ')}`,
    job: jobs.currentJob(),
    running: jobs.isRunning(),
    // Objets en cours de traitement : le front marque la carte concernée (cf. P9).
    targets: jobs.runningTargets(),
    queued: jobs.queueCount(),
    autoRefreshMinutes: Number(getConfig().auto_refresh_minutes) || 0,
    jenkinsRefreshMinutes: Number(getConfig().jenkins_refresh_minutes) || 0,
    jiraConfigured: jira.isConfigured(getConfig()), // pilote l'UI « enrichir depuis Jira »
    githubConfigured: forge.isConfigured(getConfig(), 'github'), // pilote l'UI « ajout en masse depuis GitHub »
    /* CE QUI ATTEND UNE DÉCISION CHEZ LES AGENTS : les versions de connaissance produites par
       un rafraîchissement et jamais validées. Le badge de l'onglet existait dans le HTML et
       n'était jamais rempli — un compteur mort, invisible pour toujours. Une version en
       attente est exactement ce qu'on doit voir sans ouvrir l'onglet : l'agent continue de
       travailler sur l'ANCIENNE carte tant que personne ne relit la nouvelle. */
    agentsPending: (db.prepare("SELECT COUNT(*) c FROM agent_knowledge WHERE status = 'pending'").get() || {}).c || 0,
    /* LE NUMÉRO DES DONNÉES REÇUES D'UNE SYNCHRO : quand il change, la page recharge l'écran
       affiché — un collègue a reviewé, coché, écrit. Voir `store.versionDonnees`. */
    dataVersion: store.versionDonnees(),
  });
}));
/* A37 — LE DÉLAI DE CYCLE : ouverture → première review → merge.
 *
 * C'est la métrique PRODUIT qui manquait à un outil qui s'annonce « from prompt to merge » :
 * toutes les autres disent ce que l'IA a fait, aucune ne dit si les merge requests avancent
 * plus vite. Les trois dates sont en base — `gitlab_created_at` (ouverture),
 * `review_version.created_at` (première review), `feed.mr_merged` (merge) — et personne ne les
 * rapprochait.
 *
 * MÉDIANE et non moyenne : une merge request oubliée trois mois fausse une moyenne et ne dit
 * rien du quotidien. Et on ne compte que ce qui est ALLÉ AU BOUT : une MR encore ouverte n'a
 * pas de délai, elle a un âge — les mélanger ferait baisser le chiffre à chaque nouvelle MR. */
function delaiDeCycle(projet, depuis) {
  /* LA DATE DE MERGE VIENT DE LA FORGE quand on l'a : c'est l'instant réel, le même pour toute
     l'équipe. Le journal d'activité reste en secours pour l'existant — il ne dit que « quand CE
     poste s'en est aperçu », ce qui ne vaut rien chez le voisin et n'existe pas du tout sur un
     poste qui vient de rejoindre. */
  const lignes = db.prepare(`SELECT mr.id, repo.project, mr.iid, mr.gitlab_created_at,
      (SELECT MIN(rv.created_at) FROM review_version rv WHERE rv.mr_id = mr.id) AS first_review,
      COALESCE(mr.merged_at,
        (SELECT MAX(f.at) FROM feed f WHERE f.type = 'mr_merged' AND f.mr_iid = mr.iid AND f.project = repo.project)) AS merged_at
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?)`).all(projet, projet)
    .filter((r) => r.gitlab_created_at && r.merged_at && (!depuis || r.merged_at >= depuis));
  if (!lignes.length) return null;

  const heures = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
  const mediane = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
  };
  const parProjet = {};
  for (const r of lignes) {
    const p = parProjet[r.project] || (parProjet[r.project] = { project: r.project, total: [], review: [], apres: [] });
    p.total.push(heures(r.gitlab_created_at, r.merged_at));
    if (r.first_review) {
      p.review.push(heures(r.gitlab_created_at, r.first_review));
      p.apres.push(heures(r.first_review, r.merged_at));
    }
  }
  const projets = Object.values(parProjet).map((p) => ({
    project: p.project, n: p.total.length,
    total_h: mediane(p.total), to_review_h: mediane(p.review), to_merge_h: mediane(p.apres),
  })).sort((a, b) => (b.total_h || 0) - (a.total_h || 0));
  return {
    n: lignes.length,
    total_h: mediane(lignes.map((r) => heures(r.gitlab_created_at, r.merged_at))),
    to_review_h: mediane(lignes.filter((r) => r.first_review).map((r) => heures(r.gitlab_created_at, r.first_review))),
    to_merge_h: mediane(lignes.filter((r) => r.first_review).map((r) => heures(r.first_review, r.merged_at))),
    projets,
  };
}
// Statistiques pour le dashboard (agrégées localement).
/* A36 — UNE PÉRIODE, ET UN DÉPÔT. La route ne lisait AUCUN paramètre : chaque bloc avait sa
 * propre fenêtre, figée et différente des autres — huit semaines ici, vingt-huit jours là,
 * toute l'histoire ailleurs. On ne pouvait donc ni comparer deux blocs entre eux, ni répondre
 * à « et le mois dernier ? », ni isoler un dépôt.
 *
 * `days` (0 = tout l'historique) et `project` s'appliquent à ce qui se DATE et à ce qui se
 * rattache à un dépôt. Les compteurs d'état (le funnel) restent globaux : « à traiter » n'a pas
 * d'âge, c'est un état courant, et le borner dans le temps ne voudrait rien dire. */
app.get('/api/stats', wrap((req, res) => {
  const jours = Math.max(0, Number(req.query.days) || 0);
  const projet = String(req.query.project || '').trim();
  const depuis = jours ? new Date(Date.now() - jours * 86400000).toISOString() : null;
  const dansPeriode = (iso) => !depuis || (iso && String(iso) >= depuis);
  const duProjet = (p) => !projet || p === projet;

  // Funnel des statuts de MR
  const funnel = { to_review: 0, reviewed: 0, done: 0 };
  db.prepare(`SELECT mr.status, COUNT(*) c FROM mr
    JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?) GROUP BY mr.status`).all(projet, projet)
    .forEach((r) => { if (r.status in funnel) funnel[r.status] = r.c; });

  // Reviews + projet + note (note_value, sinon extraite du .md pour les anciennes)
  const reviews = db.prepare(`
    SELECT review.md_path, review.note_value, review.created_at, repo.project AS project
    FROM review JOIN mr ON mr.id = review.mr_id JOIN repo ON repo.id = mr.repo_id`).all()
    .filter((r) => duProjet(r.project) && dansPeriode(r.created_at));
  const rows = reviews.map((r) => {
    let v = (r.note_value != null) ? r.note_value : null;
    if (v == null) { const n = extractNote(readFileSafe(r.md_path)); v = n ? n.value : null; }
    return { project: r.project, created_at: r.created_at, note10: v == null ? null : Math.round(v * 1000) / 100 };
  });

  // Distribution des notes (échelle /10)
  const buckets = [
    { label: '0–2', min: 0, max: 2, count: 0 },
    { label: '2–4', min: 2, max: 4, count: 0 },
    { label: '4–6', min: 4, max: 6, count: 0 },
    { label: '6–8', min: 6, max: 8, count: 0 },
    { label: '8–10', min: 8, max: 10.01, count: 0 },
  ];
  let noNote = 0; let sum = 0; let nb = 0;
  for (const r of rows) {
    if (r.note10 == null) { noNote += 1; continue; }
    sum += r.note10; nb += 1;
    (buckets.find((x) => r.note10 >= x.min && r.note10 < x.max) || buckets[buckets.length - 1]).count += 1;
  }
  const notes = {
    buckets: buckets.map(({ label, count }) => ({ label, count })),
    noNote, total: rows.length, avg: nb ? Math.round((sum / nb) * 10) / 10 : null,
  };

  // Par projet
  const pending = {};
  db.prepare(`SELECT repo.project p, COUNT(*) c FROM mr JOIN repo ON repo.id=mr.repo_id
    WHERE mr.status='to_review' AND (? = '' OR repo.project = ?) GROUP BY repo.project`).all(projet, projet)
    .forEach((r) => { pending[r.p] = r.c; });
  const byProj = {};
  for (const r of rows) {
    const p = byProj[r.project] || (byProj[r.project] = { project: r.project, reviewed: 0, sum: 0, n: 0, worst: null });
    p.reviewed += 1;
    if (r.note10 != null) { p.sum += r.note10; p.n += 1; p.worst = p.worst == null ? r.note10 : Math.min(p.worst, r.note10); }
  }
  for (const p of Object.keys(pending)) if (!byProj[p]) byProj[p] = { project: p, reviewed: 0, sum: 0, n: 0, worst: null };
  const projects = Object.values(byProj).map((x) => ({
    project: x.project, reviewed: x.reviewed, pending: pending[x.project] || 0,
    avg: x.n ? Math.round((x.sum / x.n) * 10) / 10 : null, worst: x.worst,
  })).sort((a, b) => (a.avg == null) - (b.avg == null) || (a.avg - b.avg));

  /* Taux de résolution : sur tous les constats d'une passe qui, à la passe
     suivante, ont eu une chance d'être corrigés, la part git-vérifiée « résolu ».
     Dénominateur = résolus + persistants + disparus (tous les constats antérieurs) ;
     les « disparus » (non vérifiés) comptent au dénominateur mais jamais au
     numérateur — c'est tout l'intérêt du garde-fou. */
  const resRows = db.prepare(`SELECT repo.project project,
      SUM(COALESCE(rv.n_resolved,0)) resolved,
      SUM(COALESCE(rv.n_persistent,0)) persistent,
      SUM(COALESCE(rv.n_disappeared,0)) disappeared
    FROM review_version rv JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE rv.n_resolved IS NOT NULL GROUP BY repo.project`).all();
  const resByProject = {};
  let gRes = 0, gPrior = 0;
  for (const r of resRows) {
    const prior = r.resolved + r.persistent + r.disappeared;
    resByProject[r.project] = prior ? { resolved: r.resolved, prior, rate: Math.round((r.resolved / prior) * 100) } : null;
    gRes += r.resolved; gPrior += prior;
  }
  for (const p of projects) p.resolution = resByProject[p.project] || null;

  /* Tendance de note par projet : moyenne des 28 derniers jours vs les 28 d'avant.
     ▲ / ▼ / → répond « la qualité de CE projet progresse-t-elle ? ». null si trop
     peu de données de part et d'autre (on ne montre pas une tendance sur 1 review). */
  const D28 = 28 * 86400000;
  const nowMs = Date.now();
  const trendAcc = {};
  for (const r of db.prepare(`SELECT rv.note_value nv, rv.created_at ca, repo.project pr
      FROM review_version rv JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
      WHERE rv.note_value IS NOT NULL`).all()) {
    if (!r.ca) continue;
    const age = nowMs - Date.parse(r.ca);
    const bucket = age <= D28 ? 'recent' : age <= 2 * D28 ? 'prev' : null;
    if (!bucket) continue;
    const a = trendAcc[r.pr] || (trendAcc[r.pr] = { recent: { s: 0, n: 0 }, prev: { s: 0, n: 0 } });
    a[bucket].s += r.nv * 10; a[bucket].n += 1;
  }
  for (const p of projects) {
    const a = trendAcc[p.project];
    if (!a || !a.recent.n || !a.prev.n) { p.trend = null; continue; }
    const delta = Math.round((a.recent.s / a.recent.n - a.prev.s / a.prev.n) * 10) / 10;
    p.trend = { delta, dir: delta > 0.2 ? 'up' : delta < -0.2 ? 'down' : 'flat' };
  }
  const resolution = gPrior ? { resolved: gRes, prior: gPrior, rate: Math.round((gRes / gPrior) * 100) } : null;

  /* Activité hebdo (8 dernières semaines), LUE SUR LES MÊMES LIGNES QUE LA TENDANCE DE LA NOTE.
     Elle comptait la table `review`, qui garde UNE ligne par merge request, écrasée à chaque
     passe et datée de la première : trois re-reviews d'une même MR n'y faisaient qu'un point,
     posé la semaine où tout avait commencé. Deux graphes côte à côte racontaient donc deux
     histoires — l'un disait « semaine calme », l'autre affichait quatre notes cette
     semaine-là. `review_version` porte une ligne par passe, datée de la passe : c'est le
     travail réellement fait, et c'est la source de son voisin. */
  const weekStart = (d) => { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() - day); return dt; };
  const wc = {};
  for (const r of db.prepare(`SELECT rv.created_at FROM review_version rv
    JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?)`).all(projet, projet)) {
    if (!r.created_at || !dansPeriode(r.created_at)) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    wc[k] = (wc[k] || 0) + 1;
  }
  const weekly = [];
  const cur = weekStart(new Date());
  for (let i = 7; i >= 0; i -= 1) { const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10); weekly.push({ week: k, count: wc[k] || 0 }); }

  /* Tendance de la note : moyenne par semaine (8 dernières). C'est l'évolution qui
     répond à « la qualité progresse-t-elle ? », plus parlante que la distribution
     statique. On garde le compte par semaine pour ne pas surinterpréter un point
     issu d'une seule review. Source : review_version (une note datée par passe). */
  const rvNotes = db.prepare(`SELECT rv.note_value, rv.created_at FROM review_version rv
    JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE rv.note_value IS NOT NULL AND (? = '' OR repo.project = ?)`).all(projet, projet)
    .filter((r) => dansPeriode(r.created_at));
  const wsum = {};
  for (const r of rvNotes) {
    if (!r.created_at) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    (wsum[k] || (wsum[k] = { sum: 0, n: 0 })).sum += r.note_value * 10; wsum[k].n += 1;
  }
  const scoreTrend = [];
  for (let i = 7; i >= 0; i -= 1) {
    const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10);
    const w = wsum[k];
    scoreTrend.push({ week: k, avg: w ? Math.round((w.sum / w.n) * 10) / 10 : null, count: w ? w.n : 0 });
  }

  /* Coût en tokens (table usage). Le total est un MINORANT — le travail interne de
     l'agent reste invisible — mais la RÉPARTITION par type et l'évolution disent
     déjà où part le quota. Regroupement des kinds en libellés lisibles côté front. */
  // La période vaut ici comme ailleurs : le total d'une semaine ne compte pas la session d'il y a cent jours.
  const byKind = db.prepare(`SELECT kind, SUM(tokens_est) tokens, COUNT(*) calls FROM usage
    WHERE (? IS NULL OR created_at >= ?) GROUP BY kind`).all(depuis, depuis)
    .filter((r) => r.tokens > 0)
    .map((r) => ({ kind: r.kind, tokens: r.tokens, calls: r.calls }));
  const tokTotal = byKind.reduce((s, r) => s + r.tokens, 0);
  const twc = {};
  for (const r of db.prepare(`SELECT tokens_est, created_at FROM usage WHERE tokens_est > 0
    AND (? IS NULL OR created_at >= ?)`).all(depuis, depuis)) {
    if (!r.created_at) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    twc[k] = (twc[k] || 0) + r.tokens_est;
  }
  const tokWeekly = [];
  for (let i = 7; i >= 0; i -= 1) { const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10); tokWeekly.push({ week: k, tokens: twc[k] || 0 }); }
  // Coût moyen par MR reviewée : tokens des reviews ÷ nb de MR distinctes reviewées.
  const reviewTokens = (byKind.find((r) => r.kind === 'review') || {}).tokens || 0;
  const reviewedCount = db.prepare("SELECT COUNT(DISTINCT mr_id) c FROM review_version WHERE kind = 'review'").get().c
    || db.prepare("SELECT COUNT(*) c FROM mr WHERE reviewed_sha IS NOT NULL").get().c;
  const tokens = {
    total: tokTotal,
    byKind,
    weekly: tokWeekly,
    avgPerReviewedMr: reviewedCount ? Math.round(reviewTokens / reviewedCount) : null,
    isFloor: true, // le total est un minorant (travail interne de l'agent invisible)
  };

  // Dev sessions
  const taskByStatus = {};
  db.prepare('SELECT status, COUNT(*) c FROM task GROUP BY status').all().forEach((r) => { taskByStatus[r.status] = r.c; });
  const tasks = {
    byStatus: taskByStatus,
    total: db.prepare('SELECT COUNT(*) c FROM task').get().c,
    mrCreated: db.prepare('SELECT COUNT(*) c FROM task_target WHERE mr_iid IS NOT NULL').get().c,
    mrMerged: db.prepare('SELECT COUNT(*) c FROM task_target WHERE mr_merged = 1').get().c,
  };

  /* Rapports FAIBLES encore à traiter — ce que le badge orange du menu Reviews annonce.
     Restreint au stade « reviewées » : les badges de Mergerie comptent du travail en attente,
     pas des totaux. Une merge request déjà classée traitée ne demande plus rien, même si sa
     note était mauvaise ; la compter ferait un chiffre qui ne redescend jamais.
     `note_value` est normalisée sur [0,1] — 0,7 vaut donc 7/10. */
  const faibles = db.prepare(`SELECT COUNT(*) c
    FROM review JOIN mr ON mr.id = review.mr_id
    WHERE mr.status = 'reviewed' AND review.note_value IS NOT NULL AND review.note_value < 0.7`).get().c;

  /* LES SESSIONS LES PLUS COÛTEUSES. « Le coût par famille » disait combien coûtent les
     sessions ; il ne disait pas LESQUELLES. Depuis que chaque dépense porte son propriétaire,
     le classement est une requête — et un prompt qui fait relire trois dépôts pour rien se
     voit avant de se voir sur la facture. */
  /* `cost_usd` : le coût ANNONCÉ par le backend quand il en annonce un, à côté de l'estimation
     en tokens qui, elle, existe toujours. `SUM` d'une colonne nulle vaut NULL : le classement
     reste ordonné sur les tokens, seul chiffre disponible partout. */
  const topTasks = db.prepare(`SELECT u.owner_kind AS kind, u.owner_id AS id, SUM(u.tokens_est) AS tokens,
      SUM(u.cost_usd) AS cost_usd
    FROM usage u WHERE u.owner_kind IN ('task','local','ask') AND u.owner_id IS NOT NULL
      AND (? IS NULL OR u.created_at >= ?)
    GROUP BY u.owner_kind, u.owner_id ORDER BY tokens DESC LIMIT 5`).all(depuis, depuis)
    .map((r) => {
      const table = r.kind === 'ask' ? 'question' : (r.kind === 'local' ? 'local_task' : 'task');
      // Une exploration se compte comme une session `task` : sa saveur dit dans quelle liste l'ouvrir.
      const row = db.prepare(`SELECT label, prompt${table === 'task' ? ', kind AS saveur' : ''} FROM ${table} WHERE id = ?`).get(r.id) || {};
      return {
        ...r, saveur: row.saveur || null, label: row.label || '', prompt: String(row.prompt || '').slice(0, 120),
      };
    })
    .filter((r) => r.prompt || r.label);

  /* A/Stats 1 — LES REVIEWS LES PLUS CHÈRES. Les sessions portaient leur coût depuis 1.4.0,
     les reviews non : une review coûtait « la moyenne », et on ne pouvait pas dire laquelle
     avait mangé le budget. Elles portent maintenant leur propriétaire, comme les sessions —
     même requête, autre famille. */
  /* LE COÛT PAR AGENT. Un agent tourne plusieurs fois — à la main, puis sur horaire — et
     c'est la SOMME qui compte : « le documentaliste coûte trois euros par mois » est une
     phrase qu'aucune ligne de session ne donne. Vide tant qu'aucun agent n'a tourné : une
     section à zéro n'apprend rien. */
  const parAgent = db.prepare(`SELECT t.agent_name AS name, SUM(u.tokens_est) AS tokens,
      SUM(u.cost_usd) AS cost_usd, COUNT(DISTINCT t.id) AS runs
    FROM usage u JOIN task t ON t.id = u.owner_id
    WHERE u.owner_kind = 'task' AND t.agent_name IS NOT NULL
      AND (@depuis IS NULL OR u.created_at >= @depuis)
    GROUP BY t.agent_name ORDER BY tokens DESC LIMIT 10`).all({ depuis });

  const topReviews = db.prepare(`SELECT u.owner_id AS id, SUM(u.tokens_est) AS tokens
    FROM usage u WHERE u.owner_kind = 'mr' AND u.owner_id IS NOT NULL
      AND (? IS NULL OR u.created_at >= ?)
    GROUP BY u.owner_id ORDER BY tokens DESC LIMIT 5`).all(depuis, depuis)
    .map((r) => {
      const m = db.prepare(`SELECT mr.iid, mr.title, repo.project FROM mr
        JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(r.id) || {};
      return { ...r, iid: m.iid || null, title: String(m.title || '').slice(0, 120), project: m.project || '' };
    })
    .filter((r) => r.iid);

  /* A/Stats 2 — CE QU'ON ENVOIE CONTRE CE QU'ON REÇOIT. `prompt_chars` et `output_chars` sont
     écrits depuis toujours et n'étaient lus par personne. Le rapport entrée/sortie dit ce
     qu'aucun total ne dit : un gabarit obèse, ou un dépôt lié qui triple chaque prompt, se
     voient à un ratio qui s'envole — la facture, elle, ne dit que « c'est cher ». */
  const ratio = db.prepare(`SELECT kind,
      SUM(prompt_chars) AS entree, SUM(output_chars) AS sortie, COUNT(*) AS n
    FROM usage WHERE (? IS NULL OR created_at >= ?)
    GROUP BY kind HAVING SUM(output_chars) > 0 ORDER BY entree DESC`).all(depuis, depuis)
    .map((r) => ({ ...r, ratio: r.sortie ? Math.round((r.entree / r.sortie) * 10) / 10 : null }));

  /* A/Stats 3 — LES VÉRIFICATIONS, PAR DÉPÔT. Un verdict rouge se lit une MR à la fois ; la
     question « quel dépôt casse le plus ? » n'avait pas de réponse. Cousin des constats
     récurrents, et lui aussi une simple lecture de ce qui est déjà écrit. */
  const verifsParDepot = (() => {
    /* Les cibles d'une vérification vivent en JSON (`targets_json`), pas en colonnes : une
       jointure SQL n'existe pas ici. On agrège donc en JS, comme le brief le fait pour la
       péremption — et on compte UNE FOIS par dépôt et par vérification, sinon un lot de cinq
       merge requests d'un même dépôt pèserait cinq fois. */
    const parProjet = new Map();
    const nomDe = new Map();
    for (const r of db.prepare('SELECT project, id FROM repo').all()) nomDe.set(r.id, r.project);
    for (const v of db.prepare('SELECT verdict, targets_json FROM verification WHERE verdict IS NOT NULL').all()) {
      let cibles = [];
      try { cibles = JSON.parse(v.targets_json || '[]'); } catch { cibles = []; }
      const depots = [...new Set(cibles.map((c) => c.repo_id).filter(Boolean))];
      for (const id of depots) {
        const nom = nomDe.get(id);
        if (!nom || !duProjet(nom)) continue;
        const acc = parProjet.get(nom) || { project: nom, total: 0, verts: 0 };
        acc.total += 1;
        if (v.verdict === 'verified_pass') acc.verts += 1;
        parProjet.set(nom, acc);
      }
    }
    return [...parProjet.values()]
      .filter((r) => r.total >= 2)
      .map((r) => ({ ...r, taux: Math.round((r.verts / r.total) * 100) }))
      .sort((a, b) => (a.taux - b.taux) || (b.total - a.total))
      .slice(0, 8);
  })();

  /* LES CONSTATS QUI REVIENNENT. Le même constat relevé sur au moins trois merge requests d'un
     même dépôt : c'est la matière première d'une règle de review, qu'on retapait jusque-là
     dans le contexte manuel de chaque merge request. Le titre est normalisé (minuscules,
     ponctuation de fin retirée) pour que « Le numéro de carte est loggé » et « le numéro de
     carte est loggé. » comptent pour un. */
  const recurrents = db.prepare(`SELECT repo.project AS project,
      LOWER(TRIM(RTRIM(f.title, '. '))) AS titre,
      COUNT(DISTINCT f.mr_id) AS n,
      GROUP_CONCAT(DISTINCT f.file) AS fichiers,
      MAX(f.title) AS exemple
    FROM finding f JOIN mr ON mr.id = f.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE f.title IS NOT NULL AND f.title != '' AND (? = '' OR repo.project = ?)
    GROUP BY repo.id, titre HAVING n >= 3
    ORDER BY n DESC, project LIMIT 10`).all(projet, projet)
    .map((r) => ({
      project: r.project, title: r.exemple, count: r.n,
      files: String(r.fichiers || '').split(',').filter(Boolean).slice(0, 6),
    }));

  /* B14 — CE QUE GIT A FAIT, agrégé. `git_op` était la seule table de trace que Statistiques
     ignorait : « combien de branches ai-je supprimées ce mois-ci, et combien ont échoué ? »
     n'avait pas de réponse, alors que chaque ligne est écrite depuis toujours. Le taux d'échec
     est le chiffre qui sert : une suppression sur trois qui échoue dit qu'on s'attaque à des
     branches protégées, et c'est un réglage, pas une fatalité. */
  const gitOps = (() => {
    const par = new Map();
    for (const r of db.prepare(`SELECT action, status, COUNT(*) n FROM git_op
      WHERE (? IS NULL OR created_at >= ?) AND (? = '' OR project = ?)
      GROUP BY action, status`).all(depuis, depuis, projet, projet)) {
      const a = par.get(r.action) || { action: r.action, n: 0, errors: 0 };
      a.n += r.n;
      if (r.status === 'error') a.errors += r.n;
      par.set(r.action, a);
    }
    const lignes = [...par.values()].sort((a, b) => b.n - a.n);
    return {
      total: lignes.reduce((x, r) => x + r.n, 0),
      errors: lignes.reduce((x, r) => x + r.errors, 0),
      byAction: lignes.slice(0, 8),
    };
  })();

  res.json({
    funnel, notes, projects, weekly, scoreTrend, tokens, tasks, resolution,
    topTasks, topReviews, ratio, verifsParDepot, recurrents, gitOps,
    cycle: delaiDeCycle(projet, depuis),
    agentCosts: parAgent,
    lowScores: faibles,
    commentsPosted: db.prepare('SELECT COUNT(*) c FROM comment_log').get().c,
  });
}));
/* Dernier commit de chaque dépôt SUIVI, toutes branches confondues. Live et best-effort :
   un dépôt injoignable est simplement omis. Endpoint SÉPARÉ de /stats (qui reste local et
   instantané) — le dashboard le charge en asynchrone.

   « Suivi » exclut les dépôts désactivés, mais aussi ceux dont la récupération des MR est
   coupée : on ne les regarde plus, ils n'ont donc rien à faire en tête de l'activité
   récente — et l'appel à la forge qu'ils coûtaient est justement ce qu'on voulait éviter
   en les décochant. */
app.get('/api/dashboard/commits', wrap(async (req, res) => {
  const cfg = getConfig();
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) { res.json({ configured: false, commits: [] }); return; }
  // IFNULL : les dépôts créés avant la colonne `fetch_mrs` la portent à NULL, et sont suivis.
  const repos = db.prepare('SELECT project, forge FROM repo WHERE enabled = 1 AND IFNULL(fetch_mrs, 1) = 1').all();
  const commits = await Promise.all(repos.map(async (r) => {
    try {
      const c = await forge.clientFor(r).latestCommit(cfg, r.project);
      if (!c) return null;
      return {
        project: r.project,
        sha: c.short_id || String(c.id || '').slice(0, 8),
        title: c.title || '',
        author: c.author_name || '',
        date: c.committed_date || c.created_at || null,
        url: c.web_url || '',
      };
    } catch { return null; } // dépôt injoignable / sans droits : omis
  }));
  res.json({ configured: true, commits: commits.filter(Boolean) });
}));
/* QUI SUIS-JE ? L'identité git de ce poste — pas de compte Mergerie, pas de mot de passe : le
   jour où une équipe partage un dépôt, l'auteur d'une review est celui qui a commité le fichier,
   et git le sait déjà. Inventer une identité à côté, ce serait deux vérités à tenir alignées
   pour ne rien gagner. `runners` liste les exécutants déjà désignés, pour que le formulaire
   d'agent propose une liste plutôt qu'une saisie libre. */
/* `/api/whoami`, ET NON `/api/me` : une route de ce nom existait déjà — l'identité sur les
   forges, qui sert au filtre « mes merge requests / les autres ». Express sert la PREMIÈRE
   déclarée ; celle-ci masquait donc l'autre, et le filtre avait disparu sans que rien ne casse.
   Deux routes d'un même nom, c'est une panne muette qui attend son écran. */
app.get('/api/whoami', wrap((req, res) => {
  const moi = identite.identite();
  const connus = db.prepare("SELECT DISTINCT runner FROM agent WHERE runner IS NOT NULL AND runner <> ''")
    .all().map((r) => r.runner);
  res.json({
    ...moi,
    runners: [...new Set([...(moi.ok ? [moi.name] : []), ...connus])].sort(),
    partage: Boolean(String(getConfig().data_repo_url || '').trim()),
  });
}));
