'use strict';
const path = require('path');
const fs = require('fs');

// Charge le .env du projet par chemin ABSOLU, AVANT tout require qui lit l'env
// (copilot lit COPILOT_ARGS, gitlab lit GITLAB_*). Robuste quel que soit le
// répertoire de lancement, la façon de lancer (npm/node), ET la version de Node
// (process.loadEnvFile n'existe qu'à partir de Node 20.12 -> parseur de secours).
function loadEnv(file) {
  if (!fs.existsSync(file)) { console.log(`.env absent (${file}) — variables d'environnement uniquement`); return; }
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
    console.log(`.env chargé (natif) depuis ${file}`);
    return;
  }
  // Parseur minimal pour Node < 20.12
  const txt = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) { process.env[key] = val; n += 1; }
  }
  console.log(`.env chargé (fallback, ${n} variables) depuis ${file}`);
}
loadEnv(path.join(__dirname, '..', '.env'));

const express = require('express');
const db = require('./db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, ensureDir } = require('./paths');
const { extractNote } = require('./note');
const { getConfig, updateConfig } = require('./config');
const i18n = require('../public/i18n-runtime.js');
const gitops = require('./gitops');
const jira = require('./jira');
const glob = require('./glob');
const notify = require('./notify');
const gitgraph = require('./gitgraph');
const { t } = i18n;
const { discoverAll } = require('./discover');
const jobs = require('./jobs');
const reviewer = require('./reviewer');
const converge = require('./converge');
const forge = require('./forge');
const git = require('./git');
const demoGit = require('./demo-git');
const docker = require('./docker');
const demoDocker = require('./demo-docker');
const demoJira = require('./demo-jira');
const demoComments = require('./demo-comments');
const { StringDecoder } = require('node:string_decoder');
const aisession = require('./aisession');
const agentsession = require('./agentsession');
const agentpass = require('./agentpass');
const localrepos = require('./localrepos');
const copilot = require('./copilot');

const app = express();
app.use(express.json({ limit: '20mb' })); // marge pour les captures de ticket (base64)
/* Fichiers statiques. `no-cache` = le navigateur peut mettre en cache mais DOIT
   revalider avant chaque usage (requête conditionnelle → 304 si inchangé, contenu
   frais sinon). Évite le piège « je ne vois pas mes changements » sans forcer un
   rechargement complet à chaque fois : un simple refresh récupère la dernière version. */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  const status = e.code === 'BUSY' ? 409 : 400;
  res.status(status).json({ error: e.message });
});

// Options de convergence depuis un body : réglages globaux par défaut, surcharge
// ponctuelle (seuil /10 et plafond de passes), bornés à [1,10]. Partagé MR + session.
function parseConvergeOpts(body) {
  const def = converge.convergeDefaults();
  const opts = { threshold: def.threshold, maxPasses: def.maxPasses };
  const b = body || {};
  if (b.threshold != null && b.threshold !== '') {
    const th = parseFloat(String(b.threshold).replace(',', '.'));
    if (Number.isFinite(th)) opts.threshold = Math.min(10, Math.max(1, th));
  }
  if (b.maxPasses != null && b.maxPasses !== '') {
    const mp = parseInt(b.maxPasses, 10);
    if (Number.isFinite(mp)) opts.maxPasses = Math.min(10, Math.max(1, mp));
  }
  return opts;
}

function repoById(id) {
  return db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
}
function mrById(id) {
  return db.prepare(`
    SELECT mr.*, repo.project AS project, repo.url AS url, repo.branch_pattern AS branch_pattern, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(id);
}
function readFileSafe(p) {
  try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

function ticketUrl(cfg, key) {
  return (cfg.jira_url && key) ? `${cfg.jira_url}/browse/${key}` : null;
}

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
    queued: jobs.queueCount(),
    autoRefreshMinutes: Number(getConfig().auto_refresh_minutes) || 0,
    jiraConfigured: jira.isConfigured(getConfig()), // pilote l'UI « enrichir depuis Jira »
    githubConfigured: forge.isConfigured(getConfig(), 'github'), // pilote l'UI « ajout en masse depuis GitHub »
  });
}));

// Statistiques pour le dashboard (agrégées localement).
app.get('/api/stats', wrap((req, res) => {
  // Funnel des statuts de MR
  const funnel = { to_review: 0, reviewed: 0, done: 0 };
  db.prepare('SELECT status, COUNT(*) c FROM mr GROUP BY status').all()
    .forEach((r) => { if (r.status in funnel) funnel[r.status] = r.c; });

  // Reviews + projet + note (note_value, sinon extraite du .md pour les anciennes)
  const reviews = db.prepare(`
    SELECT review.md_path, review.note_value, review.created_at, repo.project AS project
    FROM review JOIN mr ON mr.id = review.mr_id JOIN repo ON repo.id = mr.repo_id`).all();
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
  db.prepare("SELECT repo.project p, COUNT(*) c FROM mr JOIN repo ON repo.id=mr.repo_id WHERE mr.status='to_review' GROUP BY repo.project").all()
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

  // Activité hebdo (8 dernières semaines, par date de review)
  const weekStart = (d) => { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() - day); return dt; };
  const wc = {};
  for (const r of rows) { if (!r.created_at) continue; const k = weekStart(r.created_at).toISOString().slice(0, 10); wc[k] = (wc[k] || 0) + 1; }
  const weekly = [];
  const cur = weekStart(new Date());
  for (let i = 7; i >= 0; i -= 1) { const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10); weekly.push({ week: k, count: wc[k] || 0 }); }

  /* Tendance de la note : moyenne par semaine (8 dernières). C'est l'évolution qui
     répond à « la qualité progresse-t-elle ? », plus parlante que la distribution
     statique. On garde le compte par semaine pour ne pas surinterpréter un point
     issu d'une seule review. Source : review_version (une note datée par passe). */
  const rvNotes = db.prepare('SELECT note_value, created_at FROM review_version WHERE note_value IS NOT NULL').all();
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
  const byKind = db.prepare('SELECT kind, SUM(tokens_est) tokens, COUNT(*) calls FROM usage GROUP BY kind').all()
    .filter((r) => r.tokens > 0)
    .map((r) => ({ kind: r.kind, tokens: r.tokens, calls: r.calls }));
  const tokTotal = byKind.reduce((s, r) => s + r.tokens, 0);
  const twc = {};
  for (const r of db.prepare('SELECT tokens_est, created_at FROM usage WHERE tokens_est > 0').all()) {
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

  res.json({
    funnel, notes, projects, weekly, scoreTrend, tokens, tasks, resolution,
    commentsPosted: db.prepare('SELECT COUNT(*) c FROM comment_log').get().c,
  });
}));

/* Dernier commit de chaque dépôt actif (branche par défaut), via GitLab. Live et
   best-effort : un dépôt injoignable est simplement omis. Endpoint SÉPARÉ de /stats
   (qui reste local et instantané) — le dashboard le charge en asynchrone. */
app.get('/api/dashboard/commits', wrap(async (req, res) => {
  const cfg = getConfig();
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) { res.json({ configured: false, commits: [] }); return; }
  const repos = db.prepare('SELECT project, forge FROM repo WHERE enabled = 1').all();
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

// Télémétrie du footer : tokens, activité perso, paliers, et activité de l'équipe
// (MR entrantes) — de la matière fraîche même quand l'utilisateur ne fait rien.
app.get('/api/footer', wrap((req, res) => {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.toISOString();
  const dayKey = (d) => { const t = new Date(d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const daysBetween = (iso) => (iso ? Math.floor((now - new Date(iso)) / 86400000) : null);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // Tokens (cumul + aujourd'hui)
  const tokens = {
    total: one('SELECT COALESCE(SUM(tokens_est),0) v FROM usage').v,
    today: one('SELECT COALESCE(SUM(tokens_est),0) v FROM usage WHERE created_at >= ?', todayStart).v,
    calls: one('SELECT COUNT(*) v FROM usage').v,
  };

  // Reviews perso
  const reviews = {
    total: one('SELECT COUNT(*) v FROM review').v,
    today: one('SELECT COUNT(*) v FROM review WHERE created_at >= ?', todayStart).v,
    avgNote: (() => { const r = one('SELECT AVG(note_value) a FROM review WHERE note_value IS NOT NULL'); return r.a == null ? null : Math.round(r.a * 100) / 10; })(),
    bestNoteToday: (() => { const r = one('SELECT MAX(note_value) m FROM review WHERE note_value IS NOT NULL AND created_at >= ?', todayStart); return r.m == null ? null : Math.round(r.m * 100) / 10; })(),
    bestNoteAllTime: (() => { const r = one('SELECT MAX(note_value) m FROM review WHERE note_value IS NOT NULL'); return r.m == null ? null : Math.round(r.m * 100) / 10; })(),
  };

  // Dev sessions
  const commits = one("SELECT COUNT(*) v FROM task_target WHERE commit_sha IS NOT NULL").v;
  const mrMerged = one('SELECT COUNT(*) v FROM task_target WHERE mr_merged = 1').v;

  // Streak : jours consécutifs (finissant aujourd'hui ou hier) avec ≥1 review
  const reviewDays = new Set(db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all().map((r) => dayKey(r.created_at)));
  let streak = 0; const cur = new Date(midnight);
  if (!reviewDays.has(dayKey(cur))) cur.setDate(cur.getDate() - 1); // tolère : dernière review = hier
  while (reviewDays.has(dayKey(cur))) { streak += 1; cur.setDate(cur.getDate() - 1); }

  // Activité de l'équipe (MR entrantes)
  const toReview = one("SELECT COUNT(*) v FROM mr WHERE status = 'to_review'").v;
  const team = {
    toReview,
    newToday: one('SELECT COUNT(*) v FROM mr WHERE gitlab_created_at >= ?', todayStart).v,
    oldestWaitingDays: daysBetween(one("SELECT MIN(gitlab_created_at) m FROM mr WHERE status = 'to_review' AND gitlab_created_at IS NOT NULL").m),
    recent: db.prepare(`SELECT mr.iid, mr.title, mr.author, mr.gitlab_created_at, repo.project
        FROM mr JOIN repo ON repo.id = mr.repo_id
        WHERE mr.status = 'to_review' AND mr.gitlab_created_at IS NOT NULL
        ORDER BY mr.gitlab_created_at DESC LIMIT 5`).all()
      .map((m) => ({ iid: m.iid, title: m.title, author: m.author, project: m.project, ageDays: daysBetween(m.gitlab_created_at) })),
    topAuthorToday: one(`SELECT author, COUNT(*) c FROM mr
        WHERE gitlab_created_at >= ? AND author IS NOT NULL
        GROUP BY author ORDER BY c DESC LIMIT 1`, todayStart) || null,
  };

  // Événements récents (pour le ticker)
  const recentReviews = db.prepare(`SELECT mr.id, mr.iid, repo.project, review.note_value, review.created_at
      FROM review JOIN mr ON mr.id = review.mr_id JOIN repo ON repo.id = mr.repo_id
      ORDER BY review.created_at DESC LIMIT 40`).all()
    .map((r) => ({ id: r.id, iid: r.iid, project: r.project, note10: r.note_value == null ? null : Math.round(r.note_value * 100) / 10, at: r.created_at }));
  const recentTasks = db.prepare("SELECT branch, status, updated_at FROM task_target WHERE status IN ('committed','pushed') ORDER BY updated_at DESC LIMIT 30").all();

  // Journal d'événements « frais » (MR arrivée / mergée, par auteur)
  const feed = db.prepare(`SELECT feed.type, feed.mr_iid, feed.project, feed.author, feed.title, feed.at, mr.id AS mr_id
      FROM feed
      LEFT JOIN repo ON repo.project = feed.project
      LEFT JOIN mr ON mr.repo_id = repo.id AND mr.iid = feed.mr_iid
      ORDER BY feed.at DESC LIMIT 40`).all();

  // --- Matière détaillée : 1 frame par entité côté footer (variété sur 15+ min) ---

  // Toutes les MR en attente (pas seulement les 5 dernières)
  const toReviewList = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, repo.project
      FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.status = 'to_review' ORDER BY mr.gitlab_created_at DESC LIMIT 60`).all()
    .map((m) => ({ id: m.id, iid: m.iid, title: m.title, author: m.author, project: m.project, ageDays: daysBetween(m.gitlab_created_at) }));

  // Par projet : reviewées, note moyenne, en attente
  const projects = db.prepare(`SELECT repo.project project,
        SUM(CASE WHEN mr.status = 'to_review' THEN 1 ELSE 0 END) pending,
        COUNT(review.id) reviewed,
        AVG(review.note_value) avgNote,
        MAX(review.note_value) bestNote,
        MIN(review.note_value) worstNote
      FROM repo LEFT JOIN mr ON mr.repo_id = repo.id LEFT JOIN review ON review.mr_id = mr.id
      GROUP BY repo.project`).all()
    .map((p) => ({ project: p.project, pending: p.pending || 0, reviewed: p.reviewed || 0, avgNote: p.avgNote == null ? null : Math.round(p.avgNote * 100) / 10, bestNote: p.bestNote == null ? null : Math.round(p.bestNote * 100) / 10, worstNote: p.worstNote == null ? null : Math.round(p.worstNote * 100) / 10 }));

  // Par auteur : nombre de MR ouvertes suivies
  const authors = db.prepare(`SELECT author, COUNT(*) c FROM mr
      WHERE author IS NOT NULL AND author <> '' AND status = 'to_review'
      GROUP BY author ORDER BY c DESC LIMIT 40`).all();

  // Activité des 14 derniers jours (reviews + tokens par jour)
  const revByDay = {};
  db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all()
    .forEach((r) => { const k = dayKey(r.created_at); revByDay[k] = (revByDay[k] || 0) + 1; });
  const tokByDay = {};
  db.prepare('SELECT created_at, tokens_est FROM usage WHERE created_at IS NOT NULL').all()
    .forEach((u) => { const k = dayKey(u.created_at); tokByDay[k] = (tokByDay[k] || 0) + (u.tokens_est || 0); });
  const daily = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(midnight); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    if (revByDay[k] || tokByDay[k]) daily.push({ day: k, reviews: revByDay[k] || 0, tokens: tokByDay[k] || 0, daysAgo: i });
  }

  // Activité par semaine (8 dernières semaines)
  const weekKey = (d) => { const t = new Date(d); const off = (t.getDay() + 6) % 7; t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - off); return dayKey(t); };
  const revByWeek = {}; const tokByWeek = {};
  db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all()
    .forEach((r) => { const k = weekKey(r.created_at); revByWeek[k] = (revByWeek[k] || 0) + 1; });
  db.prepare('SELECT created_at, tokens_est FROM usage WHERE created_at IS NOT NULL').all()
    .forEach((u) => { const k = weekKey(u.created_at); tokByWeek[k] = (tokByWeek[k] || 0) + (u.tokens_est || 0); });
  const weekly = [];
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(midnight); d.setDate(d.getDate() - i * 7);
    const k = weekKey(d);
    if (revByWeek[k] || tokByWeek[k]) weekly.push({ week: k, reviews: revByWeek[k] || 0, tokens: tokByWeek[k] || 0, weeksAgo: i });
  }

  // Distribution des notes (matière + parlant)
  const noteVals = db.prepare('SELECT note_value v FROM review WHERE note_value IS NOT NULL').all().map((r) => r.v * 10);
  const noteBuckets = [
    { label: '0–2', min: 0, max: 2 }, { label: '2–4', min: 2, max: 4 }, { label: '4–6', min: 4, max: 6 },
    { label: '6–8', min: 6, max: 8 }, { label: '8–10', min: 8, max: 10.01 },
  ].map((b) => ({ label: b.label, count: noteVals.filter((v) => v >= b.min && v < b.max).length }));

  // Note moyenne des MR par auteur (qui reçoit quelles notes)
  const authorNotes = db.prepare(`SELECT mr.author author, COUNT(review.id) reviewed, AVG(review.note_value) avgNote
      FROM mr JOIN review ON review.mr_id = mr.id
      WHERE mr.author IS NOT NULL AND mr.author <> ''
      GROUP BY mr.author ORDER BY reviewed DESC LIMIT 40`).all()
    .map((a) => ({ author: a.author, reviewed: a.reviewed, avgNote: a.avgNote == null ? null : Math.round(a.avgNote * 100) / 10 }));

  // Tokens : répartition par type d'appel + quelques repères
  const tokensByKind = db.prepare('SELECT kind, SUM(tokens_est) v, COUNT(*) c FROM usage GROUP BY kind').all()
    .map((r) => ({ kind: r.kind || 'autre', tokens: r.v || 0, calls: r.c || 0 }));
  const tokenStats = {
    avgPerCall: tokens.calls ? Math.round(tokens.total / tokens.calls) : 0,
    maxCall: one('SELECT COALESCE(MAX(tokens_est),0) v FROM usage').v,
  };

  res.json({
    now: now.toISOString(), tokens, reviews, commits, mrMerged, streak, team,
    recentReviews, recentTasks, feed, toReviewList, projects, authors, daily, tokensByKind, tokenStats,
    weekly, noteBuckets, authorNotes,
  });
}));

app.get('/api/config', wrap((req, res) => {
  const c = getConfig();
  res.json({ ...c, access_token: c.access_token ? '***' : '', jira_token: c.jira_token ? '***' : '', github_token: c.github_token ? '***' : '' });
}));

// Test de la connexion Jira : récupère un ticket témoin pour valider URL/email/token.
app.post('/api/jira/test', wrap(async (req, res) => {
  const cfg = getConfig();
  // Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
  const test = { ...cfg };
  if (req.body && req.body.jira_url) test.jira_url = req.body.jira_url;
  if (req.body && req.body.jira_email) test.jira_email = req.body.jira_email;
  if (req.body && req.body.jira_token && req.body.jira_token !== '***') test.jira_token = req.body.jira_token;
  if (!jira.isConfigured(test)) throw new Error(t('err.jira.not-configured'));
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  const issue = await jira.fetchIssue(test, key);
  res.json({ ok: true, key: issue.key, summary: issue.summary });
}));

// Onglet Jira → filtre par assigné : « moi » + les personnes ayant des tickets assignés récents
// (pour cocher qui afficher). `not-configured` renvoie { configured:false } (pas une 400).
app.get('/api/jira/assignees', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.assignees() });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, me: null, people: [] });
  res.json({ configured: true, ...(await jira.listAssignees(cfg)) });
}));

// Tickets assignés aux personnes cochées (`assignees` = accountIds séparés par des virgules ;
// vide = mes tickets). Filtre statut fait côté client.
app.get('/api/jira/tickets', wrap(async (req, res) => {
  const accountIds = String(req.query.assignees || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.tickets(accountIds, req.query.includeDone === '1') });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, issues: [], total: 0 });
  res.json({ configured: true, ...(await jira.searchByAssignees(cfg, { accountIds, includeDone: req.query.includeDone === '1' })) });
}));

// Détail d'un ticket Jira : métadonnées + description + commentaires + pièces jointes.
app.get('/api/jira/issue/:key', wrap(async (req, res) => {
  const key = String(req.params.key || '').trim();
  if (demoDocker.isDemo()) return res.json({ issue: demoJira.issue(key) });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ issue: await jira.issueDetail(cfg, key) });
}));

// Poster un commentaire sur un ticket Jira.
app.post('/api/jira/issue/:key/comment', wrap(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) throw new Error(t('err.jira.comment-empty'));
  if (demoDocker.isDemo()) return res.json({ comment: { author: 'Toi (démo)', created: new Date().toISOString(), bodyMd: text } });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ comment: await jira.addComment(cfg, String(req.params.key || '').trim(), text) });
}));

// Changer l'ÉTAT d'un ticket : applique une transition Jira (les transitions possibles sont
// dans le détail du ticket).
app.post('/api/jira/issue/:key/transition', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ ok: true, demo: true });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const id = String((req.body && req.body.transitionId) || '');
  res.json(await jira.transitionIssue(cfg, String(req.params.key || '').trim(), id));
}));

// Téléchargement PROXY d'une pièce jointe Jira (le lien direct exigerait l'auth Basic dans le
// navigateur) : le serveur récupère le fichier avec le token et le renvoie tel quel.
app.get('/api/jira/attachment/:id', wrap(async (req, res) => {
  let file;
  if (demoDocker.isDemo()) file = demoJira.attachmentFile(req.params.id);
  else {
    const cfg = getConfig();
    if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
    file = await jira.downloadAttachment(cfg, req.params.id);
  }
  // Content-Disposition robuste unicode : ASCII de repli + filename*=UTF-8''… pour le vrai nom.
  // SÉCURITÉ : on ne sert `inline` QUE les images matricielles NON scriptables (png/jpeg/gif/…).
  // Une image `image/svg+xml` — qui peut contenir du <script> — ouverte en navigation top-level
  // sur NOTRE origine exécuterait ce script (XSS avec accès à l'API locale). Elle est donc forcée
  // en `attachment` (l'aperçu <img> l'affiche quand même, sans exécuter de script). `nosniff` + CSP
  // sandbox en défense en profondeur pour toute réponse pièce jointe.
  const ascii = String(file.filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const inlineOk = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.mimeType || '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.send(file.buffer);
}));

// Récupère un ticket Jira par son numéro et renvoie son contexte prêt à injecter
// (titre + description en Markdown). Utilisé pour enrichir une session de dev.
app.post('/api/jira/fetch', wrap(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  // En démo, comme les autres routes Jira : le contexte vient du jeu fictif, sinon
  // « Faire coder l'IA » et « Récupérer » seraient les seuls boutons Jira inertes.
  if (demoDocker.isDemo()) {
    const d = demoJira.issue(key);
    const body = [`# ${d.summary}`, '', d.descriptionMd || ''].join('\n');
    return res.json({ key: d.key, summary: d.summary, context: body });
  }
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const issue = await jira.fetchIssue(cfg, key);
  res.json({ key: issue.key, summary: issue.summary, context: jira.issueToContext(issue) });
}));

// Rafraîchir le contexte Jira d'une MR à la demande (bonus des champs séparés :
// ne touche jamais au contexte manuel).
// Projets liés d'une MR : remplace l'ensemble des liens (comme le save du contexte).
// Liens PAR DÉFAUT d'un dépôt : remplace l'ensemble. Utilisés pour pré-remplir
// automatiquement les projets liés des futures MR de ce dépôt.
app.post('/api/repos/:id/links', wrap((req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM repo_link WHERE repo_id = ?');
  const ins = db.prepare('INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(repo.id);
    for (const l of links) {
      const lid = Number(l.repo_id);
      if (!lid || lid === repo.id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(lid)) continue;
      ins.run(repo.id, lid, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM repo_link WHERE repo_id = ?').get(repo.id).c });
}));

app.post('/api/mrs/:id/links', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM mr_link WHERE mr_id = ?');
  const ins = db.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(mr.id);
    for (const l of links) {
      const repoId = Number(l.repo_id);
      if (!repoId || repoId === mr.repo_id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) continue;
      ins.run(mr.id, repoId, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM mr_link WHERE mr_id = ?').get(mr.id).c });
}));

app.post('/api/mrs/:id/jira-refresh', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const key = jira.ticketKey(mr.title, mr.source_branch);
  if (!key) throw new Error(t('err.jira.no-key'));
  const now = new Date().toISOString();
  try {
    const issue = await jira.fetchIssue(cfg, key);
    const text = jira.issueToContext(issue);
    db.prepare('UPDATE mr SET ticket_jira_text = ?, ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = NULL WHERE id = ?')
      .run(text || null, issue.key, now, mr.id);
    res.json({ ok: true, key: issue.key, text });
  } catch (e) {
    db.prepare('UPDATE mr SET ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = ? WHERE id = ?')
      .run(key, now, String(e.message).slice(0, 300), mr.id);
    throw e;   // remonte l'erreur au front pour l'afficher
  }
}));

app.put('/api/config', wrap((req, res) => {
  const patch = { ...req.body };
  // ne pas écraser un secret si le front renvoie le masque
  if (patch.access_token === '***') delete patch.access_token;
  if (patch.jira_token === '***') delete patch.jira_token;
  if (patch.github_token === '***') delete patch.github_token;
  const c = updateConfig(patch);
  i18n.setLang(c.language);   // les messages d'erreur suivent la nouvelle langue
  restartAutoRefresh(); // prend en compte le nouvel intervalle
  res.json({ ...c, access_token: c.access_token ? '***' : '', jira_token: c.jira_token ? '***' : '', github_token: c.github_token ? '***' : '' });
}));

/* ---------- Repos (admin) ---------- */
app.get('/api/repos', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM repo ORDER BY id').all());
}));

app.post('/api/repos', wrap((req, res) => {
  const { url, branch_pattern } = req.body || {};
  if (!url) throw new Error(t('err.l-url-du-depot-est'));
  // Forge du dépôt : explicite, sinon déduite de l'URL (github.com → github).
  const forgeName = req.body.forge ? forge.normalizeForge(req.body.forge)
    : (/github/i.test(String(url)) ? 'github' : 'gitlab');
  // project optionnel : déduit de l'URL si non fourni, avec le normalizer de la forge
  const project = (req.body.project || '').trim() || forge.clientFor({ forge: forgeName }).normalizeProject(url);
  if (!project) throw new Error(t('err.impossible-de-deduire-le-chemin'));
  // pattern vide autorisé = toutes les MR (on ne force plus 'PROJ-')
  const pattern = (branch_pattern ?? '').trim();
  const dup = db.prepare('SELECT id FROM repo WHERE project = ? AND COALESCE(forge, ?) = ?').get(project, 'gitlab', forgeName);
  if (dup) throw new Error(t('err.repo-already-added', { project, forge: forge.label(forgeName) }));
  const info = db.prepare(`INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge)
    VALUES (?, ?, ?, 1, ?, ?)`).run(project, url.trim(), pattern, new Date().toISOString(), forgeName);
  res.json(repoById(info.lastInsertRowid));
}));

app.put('/api/repos/:id', wrap((req, res) => {
  const cur = repoById(Number(req.params.id));
  if (!cur) throw new Error(t('err.repo-introuvable'));
  const { url, branch_pattern, enabled } = req.body || {};
  const nextUrl = url != null ? String(url).trim() : cur.url;
  // project : fourni explicitement, sinon déduit de l'URL, sinon inchangé
  let project = (req.body.project || '').trim();
  if (!project) project = url != null ? forge.clientFor(cur).normalizeProject(nextUrl) : cur.project;
  // pattern : vide autorisé (= toutes les MR)
  const pattern = branch_pattern != null ? String(branch_pattern).trim() : cur.branch_pattern;
  db.prepare(`UPDATE repo SET project = ?, url = ?, branch_pattern = ?, enabled = ? WHERE id = ?`)
    .run(project || cur.project, nextUrl, pattern,
         enabled == null ? cur.enabled : (enabled ? 1 : 0), cur.id);
  res.json(repoById(cur.id));
}));

app.delete('/api/repos/:id', wrap((req, res) => {
  db.prepare('DELETE FROM repo WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------- Répertoires locaux (Réglages → Dépôts) ----------
   Un répertoire local = une racine contenant un sous-dossier par projet git. La
   liste des projets n'est jamais mise en base : elle se relit du disque, sinon un
   dépôt cloné entre deux visites resterait invisible et un dépôt supprimé
   continuerait d'être proposé. */
app.get('/api/local-roots', wrap((req, res) => {
  // Le nombre de projets accompagne chaque racine : c'est ce qui dit d'un coup d'œil
  // que le chemin saisi désigne bien le dossier attendu (et non son parent).
  res.json(localrepos.roots().map((r) => {
    try {
      const list = localrepos.projects(r.id);
      // On renvoie AUSSI la liste (nom, git, branche courante) : l'écran des réglages
      // affiche les projets trouvés sous chaque répertoire, pas seulement leur nombre.
      return {
        ...r,
        count: list.length,
        git_count: list.filter((p) => p.git).length,
        projects: list.map((p) => ({ name: p.name, git: p.git, branch: p.branch })),
        error: null,
      };
    } catch (e) { return { ...r, count: 0, git_count: 0, projects: [], error: e.message }; }
  }));
}));

app.post('/api/local-roots', wrap((req, res) => {
  const { path: p, label } = req.body || {};
  res.json(localrepos.addRoot(p, label));
}));

app.delete('/api/local-roots/:id', wrap((req, res) => {
  res.json(localrepos.removeRoot(Number(req.params.id)));
}));

// Projets d'un répertoire : sous-dossiers directs, avec leur branche courante.
app.get('/api/local-roots/:id/projects', wrap((req, res) => {
  res.json({ root_id: Number(req.params.id), projects: localrepos.projects(Number(req.params.id)) });
}));

// Branches DISTANTES d'un projet local (fetch préalable) + branche courante.
app.get('/api/local-projects/branches', wrap(async (req, res) => {
  res.json(await localrepos.branches(Number(req.query.root_id), req.query.name, { fetch: req.query.fetch !== '0' }));
}));

/* Positionne chaque projet sur sa branche. Appel SYNCHRONE (hors file de jobs) :
   le résultat est un bilan par projet — quel dépôt est passé, lequel a échoué, quels
   fichiers étaient déjà modifiés — et c'est ce bilan que l'écran affiche. Le faire
   passer par un job obligerait à le reconstituer depuis un journal de texte. */
app.post('/api/navigate/checkout', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  res.json(await localrepos.checkout(targets));
}));

/* ---------- Commandes Git (palette + exécution multi-projets) ---------- */
const DEMO_GIT_COMMANDS = [
  { id: 1, label: 'Récupérer tout (fetch)', command: 'fetch --all --prune', sort_order: 0 },
  { id: 2, label: 'Statut court', command: 'status --short --branch', sort_order: 1 },
  { id: 3, label: 'Tirer (fast-forward only)', command: 'pull --ff-only', sort_order: 2 },
  { id: 4, label: '10 derniers commits', command: 'log --oneline -10', sort_order: 3 },
];

// Palette (Réglages → Git) : CRUD. Le `command` = arguments git figés (sans le mot « git »).
app.get('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json(DEMO_GIT_COMMANDS);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command ORDER BY sort_order, id').all());
}));
app.post('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const label = String((req.body && req.body.label) || '').trim();
  const command = String((req.body && req.body.command) || '').trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM git_command').get().m;
  const info = db.prepare('INSERT INTO git_command (label, command, sort_order, created_at) VALUES (?, ?, ?, ?)')
    .run(label, command, max + 1, new Date().toISOString());
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(info.lastInsertRowid));
}));
app.put('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const cur = db.prepare('SELECT * FROM git_command WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.gitcmd.unknown'));
  const label = String((req.body && req.body.label) != null ? req.body.label : cur.label).trim();
  const command = String((req.body && req.body.command) != null ? req.body.command : cur.command).trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  db.prepare('UPDATE git_command SET label = ?, command = ? WHERE id = ?').run(label, command, cur.id);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(cur.id));
}));
app.delete('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  db.prepare('DELETE FROM git_command WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Exécute la commande git à la racine de chaque projet local sélectionné → bilan par projet.
app.post('/api/git-run', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  const command = String((req.body && req.body.command) || '');
  res.json(await localrepos.runCommand(targets, command));
}));

/* ---------- Docker (onglet Docker) ----------
   Deux sources : projets COMPOSE (scan des répertoires locaux) et containers HORS-COMPOSE.
   Cœur : le drift .env, comparé sur l'effectif (docker inspect) vs l'attendu (docker compose
   config). Les actions passent par la file de jobs (log streamé). En démo : données statiques. */
app.get('/api/docker/status', wrap(async (req, res) => {
  res.json(demoDocker.isDemo() ? demoDocker.status() : await docker.status());
}));

app.get('/api/docker/compose', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ projects: demoDocker.composeProjects() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, projects: [] });
  res.json({ projects: await docker.composeProjects(localrepos.roots()) });
}));

// Affichage PROGRESSIF : d'abord la liste légère des fichiers compose (rapide), puis le détail
// de chacun à la demande (/compose/one) → les cartes s'affichent au fur et à mesure.
app.get('/api/docker/compose/list', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ files: demoDocker.composeList() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, files: [] });
  res.json({ files: await docker.composeFileList(localrepos.roots()) });
}));
app.get('/api/docker/compose/one', wrap(async (req, res) => {
  const dir = String(req.query.dir || '');
  const file = String(req.query.file || '');
  if (demoDocker.isDemo()) return res.json({ project: demoDocker.composeProjects().find((p) => p.dir === dir) || null });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, project: null });
  res.json({ project: await docker.composeOne(localrepos.roots(), dir, file) });
}));

app.get('/api/docker/orphans', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ orphans: demoDocker.orphans() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, orphans: [] });
  res.json({ orphans: await docker.orphans() });
}));

// Aperçu d'un `down` (rien n'est exécuté ; les volumes ne sont JAMAIS touchés).
app.post('/api/docker/compose/preview-down', wrap(async (req, res) => {
  const dir = String(req.body && req.body.dir || '');
  if (demoDocker.isDemo()) return res.json(demoDocker.previewDown(req.body && req.body.project));
  if (!dir) throw new Error(t('err.docker.dir-required'));
  res.json(await docker.previewDown(dir));
}));

// Actions compose (up / restart / pull / recreate / down) → file de jobs, log streamé.
app.post('/api/docker/compose/action', wrap((req, res) => {
  const { dir, action, services } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build', 'down'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  res.json(jobs.startDockerJob({ op: 'compose', dir, action, services: Array.isArray(services) ? services : [] }));
}));

// Exécute une commande (cible) du Makefile situé à côté du compose → file de jobs, log streamé.
app.post('/api/docker/make/run', wrap((req, res) => {
  const { dir, target } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!target) throw new Error(t('err.docker.target-required'));
  res.json(jobs.startDockerJob({ op: 'make', dir, target }));
}));

// Action groupée : UNE action (up/restart/stop/pull/recreate) appliquée aux services compose
// COCHÉS, groupés par répertoire de projet → un `docker compose` par projet, dans un seul job.
app.post('/api/docker/bulk-action', wrap((req, res) => {
  const { action, targets } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  const list = Array.isArray(targets) ? targets.filter((x) => x && x.dir && x.service) : [];
  if (!list.length) throw new Error(t('err.docker.no-target'));
  const byDir = new Map();
  for (const x of list) { if (!byDir.has(x.dir)) byDir.set(x.dir, []); byDir.get(x.dir).push(String(x.service)); }
  const groups = [...byDir.entries()].map(([dir, services]) => ({ dir, services }));
  res.json(jobs.startDockerJob({ op: 'compose-bulk', action, groups }));
}));

// Commande `docker run` reconstituée depuis l'inspect d'un container hors-compose.
app.get('/api/docker/orphan/:id/reconstitute', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json(demoDocker.reconstituteDemo(id));
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  res.json({ command: docker.reconstructRunCommand(det) });
}));

// Arrêt d'un container hors-compose (sans le supprimer).
app.post('/api/docker/orphan/:id/stop', wrap((req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  res.json(jobs.startDockerJob({ op: 'orphan-stop', id }));
}));

// Suppression d'un container hors-compose : on SAUVEGARDE d'abord son inspect (restauration),
// puis on supprime via la file de jobs.
app.post('/api/docker/orphan/:id/remove', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  db.prepare('INSERT INTO docker_backup (container_id, name, image, inspect_json, run_command, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, String(det.Name || '').replace(/^\//, ''), det.Config && det.Config.Image, JSON.stringify(det), docker.reconstructRunCommand(det), new Date().toISOString());
  res.json(jobs.startDockerJob({ op: 'orphan-remove', id }));
}));

// Sauvegardes d'inspect (restauration des orphelins supprimés).
app.get('/api/docker/backups', wrap((req, res) => {
  res.json(db.prepare('SELECT id, container_id, name, image, run_command, created_at FROM docker_backup ORDER BY id DESC LIMIT 100').all());
}));

// Résumé santé (badge de menu) : nb en erreur (restarting/dead) + nb unhealthy.
app.get('/api/docker/summary', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json(demoDocker.summary());
  const st = await docker.status();
  if (!st.ok) return res.json({ error: 0, unhealthy: 0, total: 0, running: 0, down: true });
  res.json(await docker.summary());
}));

// Liste plate des containers (pour choisir lesquels tailer dans l'onglet Logs).
app.get('/api/docker/containers', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ containers: demoDocker.containers() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, containers: [] }); // démon absent → liste vide, pas un 400
  res.json({ containers: await docker.listContainers() });
}));

// Tail LIVE (SSE) des logs de plusieurs containers. Le filtrage inclure/exclure est fait
// CÔTÉ CLIENT (dynamique, sans relancer le flux). On spawn un `docker logs -f` par container
// et on les TUE dès que le client se déconnecte (fermeture d'onglet, Stop, changement de vue).
app.get('/api/docker/logs/stream', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const tail = req.query.tail;
  if (!ids.length) { res.status(400).end('no containers'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // pas de buffering proxy : les lignes arrivent en direct
  });
  res.write(': ok\n\n');

  if (demoDocker.isDemo()) { demoDocker.streamLogs(ids, res); return; }

  const children = [];
  let closed = false;
  let hb = null;
  const send = (obj) => { if (!closed) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket fermé */ } } };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* déjà mort */ } }
  };
  req.on('close', cleanup);
  hb = setInterval(() => { if (closed) return; try { res.write(': hb\n\n'); } catch { cleanup(); } }, 20000);

  ids.forEach(async (id) => {
    try {
      const child = await docker.spawnLogs(id, tail);
      if (closed) { try { child.kill('SIGKILL'); } catch { /* course : client déjà parti */ } return; }
      children.push(child);
      /* Un StringDecoder par flux, et non `String(chunk)` : un caractère UTF-8 multi-octets
         à cheval sur deux chunks serait sinon décodé en deux moitiés invalides, et chaque
         accent tombant sur une frontière deviendrait un « ￰ ». Le decoder garde l'octet
         orphelin pour le chunk suivant. */
      const dec = { o: new StringDecoder('utf8'), e: new StringDecoder('utf8') };
      const buf = { o: '', e: '' };
      const pump = (chunk, which) => {
        const parts = (buf[which] + dec[which].write(chunk)).split('\n');
        buf[which] = parts.pop();
        /* La ligne part BRUTE, séquences de couleur comprises : c'est le client qui décide
           d'afficher du texte nu (par défaut) ou des couleurs, sans relancer le flux.
           Nettoyer ici interdirait la case à cocher. */
        for (const line of parts) send({ c: id, m: line });
      };
      child.stdout.on('data', (d) => pump(d, 'o'));
      child.stderr.on('data', (d) => pump(d, 'e'));
      child.on('error', (e) => send({ c: id, sys: 'error', m: e.message }));
      child.on('close', () => send({ c: id, sys: 'closed' }));
    } catch (e) {
      send({ c: id, sys: 'error', m: docker.explainDockerError ? docker.explainDockerError(e.message) : e.message });
    }
  });
});

// Liste les projets GitLab accessibles, en marquant ceux déjà ajoutés.
app.get('/api/gitlab/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.gitlab.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare('SELECT project FROM repo').all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));

// Liste les branches d'un dépôt (pour choisir la branche de base d'une tâche).
app.get('/api/gitlab/branches', wrap(async (req, res) => {
  const repo = repoById(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const r = await forge.clientFor(repo).listBranches(getConfig(), repo.project);
  res.json(r);
}));

// Liste les dépôts GitHub accessibles, en marquant ceux déjà ajoutés.
app.get('/api/github/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.github.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare("SELECT project FROM repo WHERE forge = 'github'").all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));

// Test de la connexion GitHub : renvoie le compte associé au token.
// Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
app.post('/api/github/test', wrap(async (req, res) => {
  const cfg = getConfig();
  const test = { ...cfg };
  if (req.body && req.body.github_url != null) test.github_url = req.body.github_url;
  if (req.body && req.body.github_token && req.body.github_token !== '***') test.github_token = req.body.github_token;
  if (!forge.github.isConfigured(test)) throw new Error(t('err.token-github-non-configure'));
  res.json({ ok: true, ...(await forge.github.testConnection(test)) });
}));

// Ajout en masse de dépôts sélectionnés (ignore les doublons).
app.post('/api/repos/bulk', wrap((req, res) => {
  const { projects, branch_pattern } = req.body || {};
  if (!Array.isArray(projects) || !projects.length) throw new Error(t('err.aucun-projet-selectionne'));
  // `forge` absent = gitlab : le contrat de l'API ne change pas pour l'existant.
  const forgeName = forge.normalizeForge(req.body && req.body.forge);
  const api = forge.clientFor({ forge: forgeName });
  const pattern = (branch_pattern ?? '').trim();
  const now = new Date().toISOString();
  // Unicité par COUPLE (forge, projet) : « acme/web » peut exister sur les deux forges.
  const key = (f, p) => `${f}:${p}`;
  const existing = new Set(db.prepare('SELECT project, forge FROM repo').all()
    .map((r) => key(forge.forgeOf(r), r.project)));
  const ins = db.prepare('INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge) VALUES (?,?,?,1,?,?)');
  let added = 0; let skipped = 0;
  const tx = db.transaction((list) => {
    for (const p of list) {
      const proj = api.normalizeProject(p.project || p.url);
      if (!proj || existing.has(key(forgeName, proj))) { skipped += 1; continue; }
      ins.run(proj, String(p.url || '').trim(), pattern, now, forgeName);
      existing.add(key(forgeName, proj)); added += 1;
    }
  });
  tx(projects);
  res.json({ added, skipped });
}));

/* Liste des passes d'une unité + la passe demandée (la dernière par défaut). Commun aux
   sessions sur dépôt et au codage hors dépôt : une seule forme de réponse à afficher. */
function passesPayload(scope, unitId, taskId, wantedN, title, legacyOutputPath) {
  const passes = agentpass.list(scope, taskId, unitId)
    .map((p) => ({ n: p.n, kind: p.kind, created_at: p.created_at, has_output: !!p.output_path }));

  /* Sessions antérieures à l'historique des passes : elles n'ont aucune ligne
     `agent_pass`, mais leur `output_path` pointe toujours un retour valide. On le
     présente comme une passe unique — sans lui, « Retour de l'IA » deviendrait vide
     sur tout l'existant. Le prompt de l'époque, lui, n'a pas été conservé. */
  if (!passes.length) {
    const output = legacyOutputPath ? readFileSafe(legacyOutputPath) : null;
    if (!output) return { title, passes: [], current: null };
    return {
      title,
      passes: [{ n: 1, kind: 'legacy', created_at: null, has_output: true }],
      current: { n: 1, kind: 'legacy', created_at: null, prompt: '', output },
    };
  }

  const n = Number(wantedN) || passes[passes.length - 1].n;
  const current = agentpass.get(scope, taskId, unitId, n);
  return {
    title,
    passes,
    current: current ? { n: current.n, kind: current.kind, created_at: current.created_at, prompt: current.prompt, output: current.output } : null,
  };
}

/* ---------- Tasks (tâches de dev pilotées par l'IA) ---------- */
function taskById(id) {
  return db.prepare(`SELECT task.*, repo.project AS project, repo.forge AS forge FROM task JOIN repo ON repo.id = task.repo_id WHERE task.id = ?`).get(id);
}
function taskImages(id) {
  return db.prepare('SELECT id, path FROM task_image WHERE task_id = ? ORDER BY id').all(id);
}
// Les projets d'une session, avec leur état d'exécution propre (commit, diff, MR…).
function taskTargets(taskId) {
  const rows = db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge,
      mr.iid AS existing_mr_iid, mr.web_url AS existing_mr_url
    FROM task_target tt
    JOIN repo ON repo.id = tt.repo_id
    LEFT JOIN mr ON mr.repo_id = tt.repo_id AND mr.source_branch = tt.branch
      AND (mr.closed_seen IS NULL OR mr.closed_seen = 0)
    WHERE tt.task_id = ? ORDER BY tt.id`).all(taskId);
  // `questions_json` (bloc <<<QUESTIONS>>>) exposé parsé pour le formulaire de réponses.
  // `resume_cmd` : commande à copier pour reprendre la session d'agent dans un terminal.
  return rows.map((r) => {
    let questions = null;
    try { questions = r.questions_json ? JSON.parse(r.questions_json) : null; } catch { questions = null; }
    return { ...r, questions, resume_cmd: agentsession.resumeCommand(r.session_backend, r.session_key, r.session_cwd) };
  });
}
// MR effectivement rattachée à un projet de session : celle créée par l'app, sinon
// une MR ouverte déjà connue sur la même branche.
function effectiveMr(tg) {
  if (!tg) return null;
  if (tg.mr_iid) return { iid: tg.mr_iid, fromApp: true };
  const found = db.prepare(`SELECT iid FROM mr
    WHERE repo_id = ? AND source_branch = ? AND (closed_seen IS NULL OR closed_seen = 0)
    LIMIT 1`).get(tg.repo_id, tg.branch);
  return found ? { iid: found.iid, fromApp: false } : null;
}
function targetById(taskId, targetId) {
  return db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge
    FROM task_target tt JOIN repo ON repo.id = tt.repo_id
    WHERE tt.id = ? AND tt.task_id = ?`).get(targetId, taskId);
}
// Valide la liste des projets. En codage la branche de travail est obligatoire ;
// en exploration elle est facultative (défaut : branche par défaut du dépôt).
function normalizeTargets(targets, kind) {
  if (!Array.isArray(targets) || !targets.length) throw new Error(t('err.selectionne-au-moins-un-projet'));
  const seen = new Set();
  return targets.map((t) => {
    const repoId = Number(t.repo_id);
    if (!repoId || !repoById(repoId)) throw new Error(t('err.projet-inconnu'));
    if (seen.has(repoId)) throw new Error(t('err.un-meme-projet-est-selectionne'));
    seen.add(repoId);
    const raw = (t.branch || '').trim();
    if (kind === 'code' && !raw) throw new Error(t('err.nom-de-branche-requis-pour'));
    // branche de départ facultative : vide = branche par défaut du dépôt
    const base = (t.base_branch || '').trim();
    return {
      repo_id: repoId,
      branch: raw ? assertValidBranch(raw) : null,
      base_branch: base ? assertValidBranch(base) : null,
    };
  });
}
function insertTargets(taskId, list, sessionId) {
  /* `sessionId` : session d'agent EXISTANTE fournie à la création. On la range comme si la
     première passe l'avait créée — les exécutants reprennent déjà une session dès qu'un
     handle est présent, il n'y a donc rien à changer chez eux. `session_cwd` reste NULL à
     dessein : on ignore d'où vient cette session, et le garde-fou « même cwd » ne doit pas
     refuser ce que l'utilisateur a explicitement demandé. Si la reprise échoue, le repli
     existant repart sur une session neuve avec le contexte réinjecté. */
  const ins = db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, session_key, session_backend, updated_at)
    VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`);
  const now = new Date().toISOString();
  const backend = sessionId ? agentsession.backendName() : null;
  for (const t of list) ins.run(taskId, t.repo_id, t.branch, t.base_branch || null, sessionId || null, backend, now);
}

/* Un identifiant de session est passé TEL QUEL à l'agent : `--resume <id>` pour claude,
   `COPILOT_HOME=<chemin>` pour copilot. Il ne doit donc jamais pouvoir passer pour un flag,
   et pour claude il a une forme connue — autant refuser tout de suite plutôt que d'échouer
   au milieu d'un job, une fois les dépôts clonés. */
/* Applique une session fournie aux unités d'une session (projets ou dossiers). N'écrit QUE
   si la valeur change vraiment : rouvrir la modale pour corriger un prompt ne doit pas
   réécrire des handles corrects, ni effacer le `session_cwd` qui protège la reprise.
   Un champ VIDE ne signifie jamais « efface » — on ne perd pas une session d'un formulaire
   simplement soumis ; pour repartir à neuf, on change les unités, ce qui les recrée. */
function applySessionId(table, key, taskId, sessionId, units) {
  if (!sessionId) return;
  const commun = units.length && units.every((u) => u.session_key && u.session_key === units[0].session_key)
    ? units[0].session_key : null;
  if (sessionId === commun) return;
  db.prepare(`UPDATE ${table} SET session_key = ?, session_backend = ?, session_cwd = NULL WHERE ${key} = ?`)
    .run(sessionId, agentsession.backendName(), taskId);
}

function normalizeSessionId(raw) {
  const id = String(raw || '').trim();
  if (!id) return null;
  if (id.startsWith('-')) throw new Error(t('err.session-id-invalide'));
  if (agentsession.backendName() === 'claude'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(t('err.session-id-uuid-attendu'));
  }
  return id;
}
// Nom de branche sûr : pas de flag (pas de `-` en tête), pas de `..`, caractères limités.
// Empêche l'injection d'arguments dans les commandes git.
function assertValidBranch(branch) {
  const b = String(branch || '').trim();
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(b)) {
    throw new Error(t('err.nom-de-branche-invalide-lettres'));
  }
  return b;
}
function decodeDataUrlImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { ext, buf: Buffer.from(m[2], 'base64') };
}
function saveTaskImages(taskId, images) {
  if (!Array.isArray(images)) return;
  const dir = ensureDir(path.join(TASKS_DIR, String(taskId)));
  const ins = db.prepare('INSERT INTO task_image (task_id, path) VALUES (?, ?)');
  for (const dataUrl of images) {
    const { ext, buf } = decodeDataUrlImage(dataUrl);
    const n = db.prepare('SELECT COUNT(*) c FROM task_image WHERE task_id = ?').get(taskId).c + 1;
    const file = path.join(dir, `img_${n}.${ext}`);
    fs.writeFileSync(file, buf);
    ins.run(taskId, file);
  }
}

// Captures d'un codage hors dépôt : mêmes règles, table dédiée (dossier local/<id>).
function saveLocalImages(taskId, images) {
  if (!Array.isArray(images)) return;
  const dir = ensureDir(path.join(TASKS_DIR, 'local', String(taskId)));
  const ins = db.prepare('INSERT INTO local_task_image (task_id, path) VALUES (?, ?)');
  for (const dataUrl of images) {
    const { ext, buf } = decodeDataUrlImage(dataUrl);
    const n = db.prepare('SELECT COUNT(*) c FROM local_task_image WHERE task_id = ?').get(taskId).c + 1;
    const file = path.join(dir, `img_${n}.${ext}`);
    fs.writeFileSync(file, buf);
    ins.run(taskId, file);
  }
}

app.get('/api/tasks', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM task ORDER BY id DESC').all();
  res.json(rows.map((t) => ({
    ...t,
    image_count: db.prepare('SELECT COUNT(*) c FROM task_image WHERE task_id = ?').get(t.id).c,
    targets: taskTargets(t.id),
  })));
}));

app.get('/api/tasks/:id', wrap((req, res) => {
  const t = taskById(Number(req.params.id));
  if (!t) throw new Error(t('err.session-introuvable'));
  res.json({
    task: { ...t, targets: taskTargets(t.id) },
    images: taskImages(t.id).map((im, i) => ({ id: im.id, idx: i })),
  });
}));

// Crée une session : `kind` = 'code' (l'IA modifie le code) ou 'explore' (lecture seule).
// `targets` = [{ repo_id, branch }] — une session peut porter sur plusieurs projets.
app.post('/api/tasks', wrap((req, res) => {
  const { kind, prompt, commit_message, auto_push, images, targets, ask_questions, session_id } = req.body || {};
  const k = kind === 'explore' ? 'explore' : 'code';
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = normalizeTargets(targets, k);
  const now = new Date().toISOString();
  // « L'IA peut poser des questions » : opt-in, uniquement pertinent en codage.
  const ask = (k === 'code' && ask_questions) ? 1 : 0;
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message, auto_push, ask_questions, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'new', ?, ?)`).run(
    // `task.branch` est un héritage mono-projet (la vérité est dans task_target) et
    // la colonne est NOT NULL : en exploration la branche est facultative, on y range
    // donc '' plutôt que NULL — sinon la création échoue sur une erreur SQL brute.
    list[0].repo_id, k, prompt.trim(), list[0].branch || '',
    (commit_message || '').trim() || null, auto_push ? 1 : 0, ask, now, now);
  const taskId = info.lastInsertRowid;
  insertTargets(taskId, list, sessionId);
  saveTaskImages(taskId, images);
  res.json({ ...taskById(taskId), targets: taskTargets(taskId) });
}));

app.put('/api/tasks/:id', wrap((req, res) => {
  const t = taskById(Number(req.params.id));
  if (!t) throw new Error(t('err.session-introuvable'));
  const { prompt, commit_message, auto_push, images, targets, ask_questions, session_id } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(targets) && targets.length) {
    const list = normalizeTargets(targets, t.kind);
    // on ne recrée que si la composition change, pour préserver l'état d'exécution
    const key = (x) => `${x.repo_id}:${x.branch}:${x.base_branch || ''}`;
    const cur = taskTargets(t.id).map(key).join('|');
    if (cur !== list.map(key).join('|')) {
      db.prepare('DELETE FROM task_target WHERE task_id = ?').run(t.id);
      insertTargets(t.id, list);
    }
  }
  db.prepare('UPDATE task SET prompt = ?, commit_message = ?, auto_push = ?, ask_questions = ?, updated_at = ? WHERE id = ?').run(
    prompt != null ? String(prompt).trim() : t.prompt,
    commit_message != null ? (String(commit_message).trim() || null) : t.commit_message,
    auto_push == null ? t.auto_push : (auto_push ? 1 : 0),
    // ask_questions ne concerne que le codage ; absent du body → on garde la valeur actuelle.
    ask_questions == null ? t.ask_questions : (t.kind === 'code' && ask_questions ? 1 : 0),
    new Date().toISOString(), t.id,
  );
  saveTaskImages(t.id, images);
  // Après une éventuelle recréation des cibles : celles-ci repartent sans handle.
  applySessionId('task_target', 'task_id', t.id, sessionId, taskTargets(t.id));
  res.json({ ...taskById(t.id), targets: taskTargets(t.id) });
}));

app.delete('/api/tasks/:id', wrap((req, res) => {
  db.prepare('DELETE FROM task_target WHERE task_id = ?').run(Number(req.params.id));
  agentpass.removeTask('task', Number(req.params.id));   // pas de FK : nettoyage explicite
  db.prepare('DELETE FROM task WHERE id = ?').run(Number(req.params.id));
  try { fs.rmSync(path.join(TASKS_DIR, String(Number(req.params.id))), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));

/* Ranger / ressortir une session. Volontairement séparé de PUT /tasks/:id : c'est un geste
   de rangement, qui doit rester possible sur une session en cours d'exécution — le PUT, lui,
   refuse d'éditer une session lancée. */
app.post('/api/tasks/:id/hidden', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  db.prepare('UPDATE task SET hidden = ?, updated_at = ? WHERE id = ?')
    .run(hidden, new Date().toISOString(), t2.id);
  res.json({ ok: true, hidden });
}));

app.delete('/api/tasks/:id/image/:imgId', wrap((req, res) => {
  const im = db.prepare('SELECT * FROM task_image WHERE id = ? AND task_id = ?').get(Number(req.params.imgId), Number(req.params.id));
  if (im) { try { fs.rmSync(im.path, { force: true }); } catch { /* rien */ } db.prepare('DELETE FROM task_image WHERE id = ?').run(im.id); }
  res.json({ ok: true });
}));

app.get('/api/tasks/:id/image/:idx', (req, res) => {
  const imgs = taskImages(Number(req.params.id));
  const im = imgs[Number(req.params.idx)];
  if (!im || !fs.existsSync(im.path)) return res.status(404).end();
  return res.sendFile(path.resolve(im.path));
});

// Diff d'UN projet de la session.
app.get('/api/tasks/:id/targets/:tid/diff', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ diff: tg.diff_path ? readFileSafe(tg.diff_path) : null, project: tg.project, branch: tg.branch });
}));

/* Viewer plein écran d'un projet de session : MÊMES trois routes que pour une MR
   (`viewerPayload` / `viewerFile` / `viewerFileDiff`), donc le front réutilise le
   même composant en changeant seulement la base d'URL. */
app.get('/api/tasks/:id/targets/:tid/diffview', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const ctx = targetCloneCtx(tg);
  // Le diff produit par la session est stocké ; s'il manque (session ancienne), on le
  // recalcule depuis la branche de départ.
  let diff = tg.diff_path ? readFileSafe(tg.diff_path) : null;
  if (!diff) { try { diff = await git.branchDiff(ctx.cwd, ctx.target); } catch { diff = ''; } }
  res.json({
    ...(await viewerPayload(ctx, { diff: diff || '', source: tg.branch })),
    project: tg.project, branch: tg.branch,
  });
}));
app.get('/api/tasks/:id/targets/:tid/file', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json(await viewerFile(targetCloneCtx(tg), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/targets/:tid/filediff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json(await viewerFileDiff(targetCloneCtx(tg), String(req.query.path || '')));
}));

/* Historique des ITÉRATIONS d'un projet de session : une entrée par passe, avec le
   prompt réellement envoyé et le retour de l'agent. `?n=` renvoie une passe précise. */
app.get('/api/tasks/:id/targets/:tid/passes', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json(passesPayload('task', tg.id, Number(req.params.id), req.query.n, `${tg.project} — ${tg.branch}`, tg.output_path));
}));

// Retour de l'agent pour un projet (ce qu'il dit avoir fait) — consultable en fin de session.
app.get('/api/tasks/:id/targets/:tid/output', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ output: tg.output_path ? readFileSafe(tg.output_path) : null, project: tg.project, branch: tg.branch });
}));

/* Historique des questions d'une exploration (niveau session, unité 0) : chaque
   question de suivi a écrasé la réponse précédente, mais la passe est archivée. */
app.get('/api/tasks/:id/passes', wrap((req, res) => {
  const tk = taskById(Number(req.params.id));
  if (!tk) throw new Error(t('err.session-introuvable'));
  res.json(passesPayload('task', 0, tk.id, req.query.n, tk.prompt || '', tk.md_path));
}));

// Réponse .md d'une exploration.
app.get('/api/tasks/:id/md', wrap((req, res) => {
  const t = taskById(Number(req.params.id));
  if (!t) throw new Error(t('err.session-introuvable'));
  res.json({ md: t.md_path ? readFileSafe(t.md_path) : null, prompt: t.prompt, created_at: t.created_at });
}));

app.post('/api/tasks/:id/run', wrap((req, res) => {
  const t = taskById(Number(req.params.id));
  if (!t) throw new Error(t('err.session-introuvable'));
  res.json(jobs.startTaskJob(t.id, 'run'));
}));

// « Converger » une session de dev : du prompt à la/les MR convergée(s). L'IA code,
// pousse, crée la MR, puis lance la boucle de convergence (par projet, en série).
app.post('/api/tasks/:id/converge', wrap((req, res) => {
  const task = taskById(Number(req.params.id));
  if (!task) throw new Error(t('err.session-introuvable'));
  if (task.kind !== 'code') throw new Error(t('err.converge-session-code-only'));
  res.json(jobs.startConvergeSessionJob(task.id, parseConvergeOpts(req.body)));
}));

/* ---- « Codage hors dépôt » : l'IA code dans des dossiers locaux, en place, sans git ---- */
// Dossiers d'une session hors dépôt + la commande de reprise de leur session d'agent.
function localDirsFor(taskId) {
  return db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId)
    .map((d) => ({ ...d, resume_cmd: agentsession.resumeCommand(d.session_backend, d.session_key, d.session_cwd) }));
}
function localTaskById(id) {
  const lt = db.prepare('SELECT * FROM local_task WHERE id = ?').get(id);
  if (!lt) return null;
  lt.dirs = localDirsFor(id);
  return lt;
}
app.get('/api/local-tasks', wrap((req, res) => {
  const list = db.prepare('SELECT * FROM local_task ORDER BY id DESC').all();
  for (const lt of list) lt.dirs = localDirsFor(lt.id);
  res.json(list);
}));
app.post('/api/local-tasks', wrap((req, res) => {
  const { prompt, dirs, images, session_id } = req.body || {};
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = (Array.isArray(dirs) ? dirs : []).map((d) => String(d || '').trim()).filter(Boolean);
  if (!list.length) throw new Error(t('err.local-dirs-required'));
  const now = new Date().toISOString();
  const id = db.prepare("INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES (?, 'new', ?, ?)")
    .run(prompt.trim(), now, now).lastInsertRowid;
  // Même principe que pour les sessions sur dépôt : la session fournie est rangée comme
  // si la première passe l'avait créée, `localcoder` la reprend alors sans rien savoir.
  const ins = db.prepare(`INSERT INTO local_task_dir (task_id, path, status, session_key, session_backend, updated_at)
    VALUES (?, ?, 'new', ?, ?, ?)`);
  const backend = sessionId ? agentsession.backendName() : null;
  for (const p of [...new Set(list)]) ins.run(id, p, sessionId || null, backend, now);
  saveLocalImages(id, images); // captures jointes au prompt (facultatif)
  res.json(localTaskById(id));
}));
// Détail d'une session hors dépôt (édition) — pendant de GET /api/tasks/:id.
app.get('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const images = db.prepare('SELECT id FROM local_task_image WHERE task_id = ? ORDER BY id').all(lt.id);
  res.json({ task: lt, images: images.map((im, i) => ({ id: im.id, idx: i })) });
}));

/* Édition d'une session hors dépôt — même contrat que PUT /api/tasks/:id.
   Les dossiers ne sont RECRÉÉS que si leur composition change : sinon on perdrait avec eux
   le statut de chaque dossier, le retour de l'agent et surtout le handle de session — une
   correction de faute de frappe dans le prompt repartirait de zéro. */
app.put('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const { prompt, dirs, images, session_id } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(dirs) && dirs.length) {
    const list = [...new Set(dirs.map((d) => String(d || '').trim()).filter(Boolean))];
    if (!list.length) throw new Error(t('err.local-dirs-required'));
    if (list.join('|') !== lt.dirs.map((d) => d.path).join('|')) {
      const now = new Date().toISOString();
      db.prepare('DELETE FROM local_task_dir WHERE task_id = ?').run(lt.id);
      const ins = db.prepare("INSERT INTO local_task_dir (task_id, path, status, updated_at) VALUES (?, ?, 'new', ?)");
      for (const p of list) ins.run(lt.id, p, now);
    }
  }
  if (prompt != null && !String(prompt).trim()) throw new Error(t('err.prompt-requis'));
  db.prepare('UPDATE local_task SET prompt = ?, updated_at = ? WHERE id = ?')
    .run(prompt != null ? String(prompt).trim() : lt.prompt, new Date().toISOString(), lt.id);
  saveLocalImages(lt.id, images);
  applySessionId('local_task_dir', 'task_id', lt.id, sessionId, localDirsFor(lt.id));
  res.json(localTaskById(lt.id));
}));

app.post('/api/local-tasks/:id/run', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  res.json(jobs.startLocalJob(lt.id));
}));
// Demande de correction : nouvelle passe de l'IA sur les mêmes dossiers, en REPRENANT
// la session de chacun (l'IA garde le contexte du travail qu'elle vient de produire).
app.post('/api/local-tasks/:id/followup', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  res.json(jobs.startLocalJob(lt.id, { instruction }));
}));

// Historique des itérations d'un dossier hors dépôt (même forme que côté session).
app.get('/api/local-tasks/:id/dirs/:did/passes', wrap((req, res) => {
  const d = db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json(passesPayload('local', d.id, Number(req.params.id), req.query.n, d.path, d.output_path));
}));

// Retour de l'agent pour UN dossier (ce qu'il dit avoir fait).
app.get('/api/local-tasks/:id/dirs/:did/output', wrap((req, res) => {
  const d = db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json({ output: d.output_path ? readFileSafe(d.output_path) : null, path: d.path });
}));

app.delete('/api/local-tasks/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  agentpass.removeTask('local', id);                     // pas de FK : nettoyage explicite
  db.prepare('DELETE FROM local_task WHERE id = ?').run(id); // cascade sur dirs + images
  try { fs.rmSync(path.join(TASKS_DIR, 'local', String(id)), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));

// Ranger / ressortir une session hors dépôt — pendant de POST /tasks/:id/hidden.
app.post('/api/local-tasks/:id/hidden', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  db.prepare('UPDATE local_task SET hidden = ?, updated_at = ? WHERE id = ?')
    .run(hidden, new Date().toISOString(), lt.id);
  res.json({ ok: true, hidden });
}));

// Itération : nouvelle passe de l'IA (codage) ou question de suivi (exploration).
app.post('/api/tasks/:id/followup', wrap((req, res) => {
  const t = taskById(Number(req.params.id));
  if (!t) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  res.json(jobs.startTaskJob(t.id, 'followup', { instruction }));
}));

// Réponses aux questions de l'agent (ask → stop → resume) : on enregistre les réponses sur
// la cible, puis on relance l'agent DANS LA MÊME session pour qu'il poursuive.
app.post('/api/tasks/:id/targets/:tid/answer', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'needs_input') throw new Error(t('err.session-pas-en-attente'));
  let qs = [];
  try { qs = tg.questions_json ? JSON.parse(tg.questions_json) : []; } catch { qs = []; }
  const answers = (req.body && req.body.answers) || {};
  let filled = 0;
  qs = qs.map((q) => {
    const a = answers[q.id];
    if (a != null && String(a).trim()) { filled += 1; return { ...q, answer: String(a).trim(), answeredAt: new Date().toISOString() }; }
    return q;
  });
  if (!filled) throw new Error(t('err.reponses-manquantes'));
  // On quitte `needs_input` DÈS l'envoi des réponses : sinon, tant que la reprise tourne,
  // le moindre rechargement ré-affiche le formulaire (déjà répondu). Passage direct en running.
  db.prepare("UPDATE task_target SET questions_json = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(qs), new Date().toISOString(), tg.id);
  res.json(jobs.startTaskJob(Number(req.params.id), 'answer', { targetId: tg.id }));
}));

// Push d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/push', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'committed') throw new Error(t('err.ce-projet-doit-etre-execute'));
  res.json(jobs.startTaskJob(Number(req.params.id), 'push', { targetId: tg.id }));
}));

// Crée la MR d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/mr', wrap(async (req, res) => {
  const t = taskById(Number(req.params.id));
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!t || !tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'pushed') throw new Error(t('err.la-branche-doit-etre-poussee'));
  const already = effectiveMr(tg);
  if (already) throw new Error(t('err.mr-already-open', { iid: already.iid }));
  const cfg = getConfig();
  const title = (req.body && req.body.title || '').trim() || t.commit_message || tg.branch;
  let target = tg.base_branch;
  if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = b.default || 'main'; }
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, {
    source_branch: tg.branch, target_branch: target, title, squash, removeSourceBranch,
  });
  db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
    .run(mr.iid, mr.web_url, target, new Date().toISOString(), tg.id);
  rememberMergeOpts(tg.repo_id, mr.iid, squash, removeSourceBranch);
  res.json({ iid: mr.iid, url: mr.web_url });
}));

// Merge la MR d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/merge', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const eff = effectiveMr(tg);
  if (!eff) throw new Error(t('err.aucune-mr-a-merger-pour'));
  const known = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
  const merged = await forge.clientFor(tg).mergeMergeRequest(getConfig(), tg.project, eff.iid, mergeOptsFor(known, req.body));
  // GitLab peut répondre 200 sans merge immédiat : on ne marque que si l'état est 'merged'.
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    db.prepare('UPDATE task_target SET mr_iid = COALESCE(mr_iid, ?), mr_merged = 1, updated_at = ? WHERE id = ?')
      .run(eff.iid, now, tg.id);
    const linked = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
    if (linked) {
      db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(linked.id);
      db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
        .run('mr_merged', linked.iid, tg.project, linked.author || '', linked.title || '', now);
    }
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));

/* ---------- Règles de review spécifiques ---------- */
app.get('/api/rules', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM review_rule ORDER BY id').all());
}));

app.post('/api/rules', wrap((req, res) => {
  const branch_match = (req.body && req.body.branch_match || '').trim();
  const path_match = (req.body && req.body.path_match || '').trim();
  const label = (req.body && req.body.label || '').trim();
  const content = (req.body && req.body.content || '').trim();
  // Une règle doit avoir au moins un déclencheur (branche OU chemin) et un contenu.
  if ((!branch_match && !path_match) || !content) throw new Error(t('err.rule-needs-trigger'));
  const info = db.prepare(`INSERT INTO review_rule (branch_match, path_match, label, content, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`).run(branch_match, path_match, label, content, new Date().toISOString());
  res.json(db.prepare('SELECT * FROM review_rule WHERE id = ?').get(info.lastInsertRowid));
}));

app.put('/api/rules/:id', wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM review_rule WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.regle-introuvable'));
  const { branch_match, path_match, label, content, enabled } = req.body || {};
  db.prepare('UPDATE review_rule SET branch_match = ?, path_match = ?, label = ?, content = ?, enabled = ? WHERE id = ?').run(
    branch_match != null ? String(branch_match).trim() : cur.branch_match,
    path_match != null ? String(path_match).trim() : (cur.path_match || ''),
    label != null ? String(label).trim() : (cur.label || ''),
    content != null ? String(content).trim() : cur.content,
    enabled == null ? cur.enabled : (enabled ? 1 : 0),
    cur.id,
  );
  res.json(db.prepare('SELECT * FROM review_rule WHERE id = ?').get(cur.id));
}));

app.delete('/api/rules/:id', wrap((req, res) => {
  db.prepare('DELETE FROM review_rule WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------- Découverte + jobs ---------- */
app.post('/api/discover', wrap(async (req, res) => {
  const result = await discoverAll();
  res.json(result);
}));

app.post('/api/jobs/review', wrap((req, res) => {
  const job = jobs.startJob('review');
  res.json(job);
}));

app.get('/api/jobs/current', wrap((req, res) => {
  res.json({ job: jobs.currentJob(), running: jobs.isRunning(), queued: jobs.queueCount() });
}));

// Sans id : tout arrêter (bouton du panneau). Avec un id : n'arrêter que ce job-là.
app.post('/api/jobs/stop', wrap((req, res) => {
  res.json(jobs.stopJob(req.body && req.body.job_id));
}));
app.post('/api/jobs/:id/stop', wrap((req, res) => {
  res.json(jobs.stopJob(Number(req.params.id)));
}));

/* Ce qui tourne et ce qui attend. Les jobs en attente portent leurs `keys` (dépôts et
   dossiers touchés) et les `conflicts` avec ce qui tourne : l'écran peut ainsi dire
   POURQUOI un job ne peut pas démarrer tout de suite, au lieu de griser un bouton. */
app.get('/api/jobs/queue', wrap((req, res) => {
  res.json({
    running: jobs.runningJobs(), queued: jobs.queuedJobs(),
    parallelBusy: jobs.parallelBusy(), maxRunning: jobs.MAX_RUNNING,
  });
}));

// Rejoue un job qui s'est arrêté ou a échoué, sur le même objet.
app.post('/api/jobs/:id/retry', wrap((req, res) => {
  res.json({ ok: true, job: jobs.retryJob(Number(req.params.id)) });
}));

// Sort un job de la file et le lance EN PARALLÈLE de celui en cours (refus si conflit).
app.post('/api/jobs/:id/start-now', wrap((req, res) => {
  res.json({ ok: true, job: jobs.startNow(Number(req.params.id)) });
}));

// Charge utile commune aux deux routes de log : le job, ses compteurs, ses lignes.
function jobLogPayload(job, after) {
  const lines = db.prepare(
    'SELECT id, mr_id, text, ts FROM job_log WHERE job_id = ? AND id > ? ORDER BY id LIMIT 3000',
  ).all(job.id, after);
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    running: jobs.isRunning(),
    // Les autres jobs EN COURS : le panneau en tire ses onglets sans requête de plus.
    running_ids: jobs.runningJobs().map((j) => j.id),
    queued: jobs.queueCount(),
    message: job.message,
    total: job.total,
    done_count: job.done_count,
    // Horodatages du job : le front en tire le temps écoulé. Il les calcule à partir de la
    // date SERVEUR plutôt que de compter les secondes depuis l'ouverture de la page — sinon
    // un onglet ouvert en cours de route afficherait un temps faux.
    started_at: job.started_at,
    finished_at: job.finished_at,
    // Le serveur décide de ce qui est rejouable — le front n'a pas à connaître la liste.
    can_retry: jobs.canRetry(job),
    lines,
  };
}

// Log incrémental du job courant (poll temps réel côté UI).
/* `expect` = le job que le client CROIT courant. Le job courant peut changer sous ses pieds
   (le principal se termine, un job parallèle devient le plus récent en cours) : si l'id ne
   correspond plus, son curseur ne vaut rien et on renvoie depuis le début, sinon il
   manquerait toutes les lignes déjà produites par ce job-là. */
app.get('/api/jobs/current/log', wrap((req, res) => {
  const job = jobs.currentJob();
  if (!job) return res.json({ job_id: null, lines: [], running: false });
  const expect = Number(req.query.expect || 0);
  const after = expect && expect === job.id ? Number(req.query.after || 0) : 0;
  res.json(jobLogPayload(job, after));
}));

// Log d'un job PRÉCIS — l'onglet du job lancé en parallèle s'en sert.
app.get('/api/jobs/:id/log', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM job WHERE id = ?').get(Number(req.params.id));
  if (!job) throw new Error(t('err.job-introuvable'));
  res.json(jobLogPayload(job, Number(req.query.after || 0)));
}));

// Réinitialise : supprime tous les rapports (fichiers + lignes review),
// remet toutes les MR en 'to_review', vide le journal des jobs. Conserve repos/config.
app.post('/api/reports/reset', wrap((req, res) => {
  if (jobs.isRunning()) throw new Error(t('err.un-job-est-en-cours'));
  try {
    fs.rmSync(REVIEWS_DIR, { recursive: true, force: true });
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  } catch { /* dossier absent : rien à faire */ }
  const del = db.prepare('DELETE FROM review').run();
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, last_error = NULL, updated_at = ?")
    .run(new Date().toISOString());
  db.prepare('DELETE FROM job_log').run();
  db.prepare('DELETE FROM job').run();
  res.json({ ok: true, deleted: del.changes });
}));

/* ---------- MRs ---------- */
app.get('/api/mrs', wrap((req, res) => {
  const { status } = req.query;
  let rows;
  // tri par date de création de la MR (GitLab), décroissante ; NULL en dernier
  const order = 'ORDER BY mr.gitlab_created_at IS NULL, mr.gitlab_created_at DESC, mr.iid DESC';
  if (status) {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.status = ? ${order}`).all(status);
  } else {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      ${order}`).all();
  }
  // marque celles qui ont un rapport + extrait la note globale du rapport
  const reviews = db.prepare('SELECT mr_id, md_path FROM review').all();
  const hasReview = new Set();
  const noteByMr = {};
  for (const rv of reviews) {
    hasReview.add(rv.mr_id);
    noteByMr[rv.mr_id] = extractNote(readFileSafe(rv.md_path));
  }
  const cfg = getConfig();
  // Badge « risque » : sans IA, juste sur les chemins du diff × les règles par chemin.
  // Chargées une fois pour toute la liste.
  const pathRules = db.prepare("SELECT id, path_match, label FROM review_rule WHERE enabled = 1 AND path_match IS NOT NULL AND path_match != ''").all();
  const riskOf = (changed) => {
    if (!changed || !pathRules.length) return [];
    const paths = String(changed).split('\n').filter(Boolean);
    return pathRules
      .filter((rule) => glob.matchingPaths(rule.path_match, paths).length > 0)
      .map((rule) => ({ label: rule.label || rule.path_match, path_match: rule.path_match }));
  };
  res.json(rows.map((r) => {
    const key = jira.ticketKey(r.title, r.source_branch);
    return {
      ...r,
      has_review: hasReview.has(r.id),
      note: noteByMr[r.id] || null,
      has_ticket: !!(r.ticket_text || r.ticket_image || r.ticket_jira_text),
      ticket_key: key,
      ticket_url: ticketUrl(cfg, key),
      risk: riskOf(r.changed_paths),
      stale: r.reviewed_sha && r.reviewed_sha !== r.current_sha,
    };
  }));
}));

app.get('/api/mrs/:id', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  const comments = db.prepare('SELECT * FROM comment_log WHERE mr_id = ? ORDER BY id DESC').all(mr.id);
  const tkey = jira.ticketKey(mr.title, mr.source_branch);
  res.json({
    mr,
    ticket_key: tkey,
    ticket_url: ticketUrl(getConfig(), tkey),
    // Commande pour reprendre la session d'agent de la review dans un terminal.
    resume_cmd: agentsession.resumeCommand(mr.review_session_backend, mr.review_session_key, mr.review_session_cwd),
    review: rev ? {
      md: readFileSafe(rev.md_path),
      explanation: readFileSafe(rev.explanation_path),
      updated_at: rev.updated_at,
    } : null,
    comments,
    ticket: {
      text: mr.ticket_text || '',
      has_image: !!(mr.ticket_image && fs.existsSync(mr.ticket_image)),
      jira_text: mr.ticket_jira_text || '',
      // Clé stockée (après un fetch) ou, à défaut, déduite du titre/branche — pour
      // qu'une MR jamais fetchée sache tout de même qu'un ticket est récupérable.
      jira_key: mr.ticket_jira_key || jira.ticketKey(mr.title, mr.source_branch) || '',
      jira_at: mr.ticket_jira_at || '',
      jira_error: mr.ticket_jira_error || '',
      jira_configured: jira.isConfigured(getConfig()),
    },
    convergence: converge.latestRun(mr.id), // dernière boucle « Converger » (panneau)
    links: db.prepare(`SELECT ml.repo_id, ml.branch, repo.project, repo.forge FROM mr_link ml JOIN repo ON repo.id = ml.repo_id WHERE ml.mr_id = ?`).all(mr.id),
    repo_links: db.prepare(`SELECT rl.linked_repo_id AS repo_id, rl.branch, repo.project FROM repo_link rl JOIN repo ON repo.id = rl.linked_repo_id WHERE rl.repo_id = ?`).all(mr.repo_id),
    stale: mr.reviewed_sha && mr.reviewed_sha !== mr.current_sha,
  });
}));

// Enregistre le contexte du ticket (texte + capture facultative en data URL).
function saveTicketImage(mrId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  ensureDir(TICKETS_DIR);
  for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    try { fs.rmSync(path.join(TICKETS_DIR, `${mrId}.${e}`), { force: true }); } catch { /* rien */ }
  }
  const file = path.join(TICKETS_DIR, `${mrId}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

app.post('/api/mrs/:id/ticket', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { text, image, removeImage } = req.body || {};
  let imgPath = mr.ticket_image;
  if (removeImage && imgPath) { try { fs.rmSync(imgPath, { force: true }); } catch { /* rien */ } imgPath = null; }
  if (image) imgPath = saveTicketImage(mr.id, image);
  const t = (text || '').trim();
  db.prepare('UPDATE mr SET ticket_text = ?, ticket_image = ?, updated_at = ? WHERE id = ?')
    .run(t || null, imgPath, new Date().toISOString(), mr.id);
  res.json({ ok: true, has_text: !!t, has_image: !!imgPath });
}));

app.get('/api/mrs/:id/ticket-image', (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr || !mr.ticket_image || !fs.existsSync(mr.ticket_image)) return res.status(404).end();
  return res.sendFile(path.resolve(mr.ticket_image));
});

app.post('/api/mrs/:id/review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  // explain absent → suit le réglage global ; présent → surcharge ponctuelle (true/false).
  const opts = {};
  if (req.body && req.body.explain != null) opts.explain = req.body.explain === true || req.body.explain === '1' || req.body.explain === 1;
  const job = jobs.startJob('review', [mr.id], opts);
  res.json(job);
}));

// Génère l'explication pédagogique à la demande pour une MR déjà reviewée (1 appel IA).
app.post('/api/mrs/:id/explain', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT id FROM review WHERE mr_id = ?').get(mr.id);
  if (!rev) throw new Error(t('err.explain-sans-review'));
  const job = jobs.startJob('explain', [mr.id]);
  res.json(job);
}));

app.get('/api/mrs/:id/diff', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  res.json({ diff: rev ? readFileSafe(rev.diff_path) : null });
}));

/* Diff d'une MR AVANT review : permet de juger une MR sans dépenser un appel IA
   (« si elle est triviale, je la classe direct »). Calculé en direct depuis le
   clone — qu'on s'assure d'abord d'avoir (clone/fetch à la demande, d'où le coût
   possible sur un premier accès à un gros dépôt). Sert aussi à réchauffer le clone
   pour que les endpoints /file et /filediff du viewer fonctionnent ensuite. */
app.get('/api/mrs/:id/diffview', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const cwd = await git.ensureRepo(cfg, repo, () => {});
  // Si la review a déjà stocké le diff, on le réutilise ; sinon calcul en direct.
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const stored = rev ? readFileSafe(rev.diff_path) : null;
  const diff = stored || await git.targetedDiff(cwd, mr.source_branch, mr.target_branch, () => {});
  const ctx = { cwd, ref: `origin/${mr.source_branch}`, target: mr.target_branch || 'main' };
  res.json(await viewerPayload(ctx, { diff, source: mr.source_branch }));
}));

// Ensemble des fichiers modifiés (chemins « b/ ») extraits d'un diff unifié.
function changedFilesFromDiff(diff) {
  const set = new Set();
  if (!diff) return set;
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(diff))) set.add(m[2]);
  return set;
}
function mrCloneCtx(mr) {
  const cfg = getConfig();
  const cwd = git.cloneDirFor(cfg, { project: mr.project, forge: mr.forge });
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    throw new Error(t('err.depot-non-clone-localement-lance'));
  }
  const ref = mr.reviewed_sha || `origin/${mr.source_branch}`;
  return { cwd, ref, target: mr.target_branch || 'main' };
}

/* Même contexte pour un PROJET DE SESSION : le viewer plein écran est identique,
   seule la source change (la branche produite par l'IA au lieu de la MR). On vise le
   commit exact produit par la session quand il existe — la branche a pu bouger depuis. */
function targetCloneCtx(tg) {
  const cfg = getConfig();
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cwd = git.cloneDirFor(cfg, repo);
  // Message propre à la session : parler de « relancer une review » n'aurait aucun sens ici.
  if (!fs.existsSync(path.join(cwd, '.git'))) throw new Error(t('err.depot-non-clone-session'));
  return { cwd, ref: tg.commit_sha || `origin/${tg.branch}`, target: tg.base_branch || 'main' };
}

/* --- Corps des trois routes du viewer, partagés MR / session ---------------
   Le chemin demandé est TOUJOURS validé contre l'arborescence de la ref : c'est
   ce qui empêche de lire un fichier hors du dépôt (traversal). */
async function viewerFile(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let content = await git.showFile(ctx.cwd, ctx.ref, p);
  if (content.indexOf(String.fromCharCode(0)) !== -1) content = '(fichier binaire, non affiche)';
  return { path: p, content };
}
async function viewerFileDiff(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let diff = '';
  try { diff = await git.fileDiffFull(ctx.cwd, ctx.target, ctx.ref, p); } catch { diff = ''; }
  return { diff };
}
// Charge utile d'ouverture du viewer : diff complet + arbre marqué + compteurs.
async function viewerPayload(ctx, { diff, source }) {
  const changed = changedFilesFromDiff(diff);
  let files = [];
  try { files = await git.lsTree(ctx.cwd, ctx.ref); } catch { /* arbre indisponible */ }
  return {
    diff,
    source,
    target: ctx.target,
    files: files.map((f) => ({ path: f, changed: changed.has(f) })),
    stats: {
      files: changed.size,
      added: (diff.match(/^\+(?!\+\+)/gm) || []).length,
      removed: (diff.match(/^-(?!--)/gm) || []).length,
    },
  };
}

// Arborescence du projet à la version reviewée + marquage des fichiers modifiés.
app.get('/api/mrs/:id/tree', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { cwd, ref } = mrCloneCtx(mr);
  let files;
  try { files = await git.lsTree(cwd, ref); }
  catch { files = await git.lsTree(cwd, `origin/${mr.source_branch}`); }
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const changed = changedFilesFromDiff(rev ? readFileSafe(rev.diff_path) : null);
  res.json({ ref, target: mr.target_branch, files: files.map((f) => ({ path: f, changed: changed.has(f) })) });
}));

// Contenu complet d'un fichier à la version reviewée (validé contre l'arborescence).
app.get('/api/mrs/:id/file', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(await viewerFile(mrCloneCtx(mr), String(req.query.path || '')));
}));

// Diff d'un fichier à contexte complet (fichier entier + changements surlignés).
app.get('/api/mrs/:id/filediff', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(await viewerFileDiff(mrCloneCtx(mr), String(req.query.path || '')));
}));

app.post('/api/mrs/:id/rereview', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  // incremental : ne reviewer que le delta depuis le dernier SHA reviewé (best-effort :
  // reviewMr retombe sur une review complète s'il n'y a pas de delta exploitable).
  const incremental = !!(req.body && (req.body.incremental === true || req.body.incremental === '1'));
  const job = jobs.startJob('rereview', [mr.id], { incremental });
  res.json(job);
}));

// « Converger » : boucle autonome review → correction IA (commit + push) → re-review
// incrémentale, jusqu'au seuil / à la régression / au plafond. JAMAIS de merge.
// seuil et plafond : réglage global par défaut, surchargeables au lancement.
app.post('/api/mrs/:id/converge', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  const job = jobs.startConvergeJob(mr.id, parseConvergeOpts(req.body));
  res.json(job);
}));

// « Corriger la review » : crée une Dev session qui applique les corrections de la
// review sur la branche de la MR, et la lance.
app.post('/api/mrs/:id/fix-review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mr.id);
  const reviewMd = rev ? readFileSafe(rev.md_path) : null;
  if (!reviewMd) throw new Error(t('err.aucune-review-a-corriger-pour'));
  const branch = assertValidBranch(mr.source_branch);
  const prompt =
    `Voici une revue de code de la branche ${mr.source_branch}. Applique directement dans les fichiers `
    + `les corrections et suggestions PERTINENTES de cette revue (concentre-toi sur les vrais problèmes : `
    + `bugs, sécurité, robustesse, correction fonctionnelle ; ignore le purement cosmétique ou ambigu).\n\n`
    + `=== RAPPORT DE REVUE ===\n${reviewMd}`;
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message, auto_push, status, created_at, updated_at)
    VALUES (?, 'code', ?, ?, ?, ?, 0, 'new', ?, ?)`).run(
    mr.repo_id, prompt, branch, mr.target_branch || null, `${branch}: corrections review !${mr.iid}`, now, now);
  const taskId = info.lastInsertRowid;
  // la session porte sur UN projet : la branche de la MR à corriger
  insertTargets(taskId, [{ repo_id: mr.repo_id, branch }]);
  jobs.startTaskJob(taskId, 'run');
  res.json({ ok: true, task_id: taskId });
}));

// Historique des reviews d'une MR : chaque passe est conservée.
app.get('/api/mrs/:id/versions', wrap((req, res) => {
  const rows = db.prepare(`SELECT version, note_value, reviewed_sha, kind, created_at, instruction,
    n_new, n_persistent, n_resolved, n_disappeared
    FROM review_version WHERE mr_id = ? ORDER BY version DESC`).all(Number(req.params.id));
  res.json(rows.map((v) => ({
    version: v.version,
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    sha: v.reviewed_sha ? String(v.reviewed_sha).slice(0, 8) : null,
    kind: v.kind,
    created_at: v.created_at,
    instruction: v.instruction || null,   // demande à l'origine d'une régénération
    // Delta de résolution (renseigné dès la 2e passe) pour le bandeau du rapport.
    resolution: v.n_resolved == null ? null
      : { resolved: v.n_resolved, persistent: v.n_persistent, new: v.n_new, disappeared: v.n_disappeared },
  })));
}));

// Constats structurés d'une version (par défaut la dernière), avec leur statut.
// Alimente la liste détaillée sous le bandeau du rapport.
app.get('/api/mrs/:id/findings', wrap((req, res) => {
  const id = Number(req.params.id);
  const version = req.query.v
    ? Number(req.query.v)
    : (db.prepare('SELECT MAX(version) v FROM finding WHERE mr_id = ?').get(id) || {}).v;
  if (!version) return res.json({ version: null, findings: [] });
  const rows = db.prepare(`SELECT file, line, severity, title, status
    FROM finding WHERE mr_id = ? AND version = ?
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'persistent' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
             CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END,
             file`).all(id, version);
  res.json({ version, findings: rows });
}));

// Contenu d'une version précise (pour relire une review antérieure).
app.get('/api/mrs/:id/versions/:v', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM review_version WHERE mr_id = ? AND version = ?')
    .get(Number(req.params.id), Number(req.params.v));
  if (!v) throw new Error(t('err.version-introuvable'));
  res.json({
    version: v.version,
    md: readFileSafe(v.md_path),
    explanation: readFileSafe(v.explanation_path),
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    created_at: v.created_at,
  });
}));

app.post('/api/mrs/:id/modify', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) throw new Error(t('err.instruction-requise'));
  // même pipeline que la review (job de fond + log en direct + sortie fichier)
  const job = jobs.startJob('modify', [mr.id], { instruction });
  res.json(job);
}));

// B6 : symétrique de /mrs/:id/clear-error — sinon l'erreur d'une tâche revient à chaque refresh.
app.post('/api/tasks/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE task SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE mr SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/done', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  db.prepare(`UPDATE mr SET status = 'done', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/reopen', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT 1 FROM review WHERE mr_id = ?').get(mr.id);
  db.prepare(`UPDATE mr SET status = ?, updated_at = ? WHERE id = ?`)
    .run(rev ? 'reviewed' : 'to_review', new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

// Supprime le rapport d'une MR (fichiers + ligne en base) et la remet « à reviewer ».
app.post('/api/mrs/:id/delete-review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  if (rev) {
    for (const p of [rev.md_path, rev.explanation_path, rev.diff_path]) {
      try { if (p && fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
    db.prepare('DELETE FROM review WHERE mr_id = ?').run(mr.id);
  }
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/comment', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, note_id: demoComments.post(mr.id, body, null).notes[0].id });
  const cfg = getConfig();
  const note = await forge.clientFor(mr).postMrNote(cfg, mr.project, mr.iid, body);
  db.prepare('INSERT INTO comment_log (mr_id, body, gitlab_note_id, sent_at) VALUES (?,?,?,?)')
    .run(mr.id, body, note && note.id, new Date().toISOString());
  res.json({ ok: true, note_id: note && note.id });
}));

/* Compte associé au jeton d'une forge. Sert à reconnaître MES commentaires, donc ceux que
   je peux modifier. Mis en cache : sans cela, chaque ouverture de rapport ajouterait un
   aller-retour réseau pour une réponse qui ne change jamais. Un échec n'est pas une erreur —
   il rend simplement les commentaires non modifiables, ce qui est le repli sûr. */
const meCache = new Map();               // forge -> { username, at }
const ME_TTL_MS = 30 * 60 * 1000;
async function forgeUsername(mr) {
  const f = forge.forgeOf(mr);
  const hit = meCache.get(f);
  if (hit && Date.now() - hit.at < ME_TTL_MS) return hit.username;
  try {
    const { username } = await forge.clientFor(mr).currentUser(getConfig());
    meCache.set(f, { username: username || '', at: Date.now() });
    return username || '';
  } catch { return ''; }
}

// Liste les discussions (commentaires) de la MR : inline (avec position) + générales.
app.get('/api/mrs/:id/discussions', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const [discs, me] = demoDocker.isDemo()
    ? [demoComments.list(mr.id), demoComments.ME]
    : await Promise.all([
      forge.clientFor(mr).listMrDiscussions(getConfig(), mr.project, mr.iid),
      forgeUsername(mr),
    ]);
  const simplified = discs.map((d) => ({
    id: d.id,
    notes: (d.notes || []).filter((n) => !n.system).map((n) => ({
      id: n.id,
      author: (n.author && (n.author.name || n.author.username)) || '',
      // Modifiable si le compte du jeton est l'auteur. On compare sur le `username`
      // (identifiant) et jamais sur le nom affiché, qui n'est pas unique.
      editable: !!(me && n.author && n.author.username === me),
      body: n.body,
      created_at: n.created_at,
      resolved: !!n.resolved,
      position: n.position ? {
        new_path: n.position.new_path, old_path: n.position.old_path,
        new_line: n.position.new_line, old_line: n.position.old_line,
      } : null,
    })),
  })).filter((d) => d.notes.length);
  res.json({ discussions: simplified });
}));

/* Modifie un commentaire déjà posté. `inline` dit s'il s'agit d'un commentaire de ligne :
   GitHub range les deux familles sous des ressources différentes (GitLab n'en a qu'une).
   Les droits ne sont pas re-vérifiés ici : c'est la forge qui les détient, et elle refuse
   la modification du commentaire d'un autre. Le bouton, lui, n'apparaît que sur les miens. */
app.put('/api/mrs/:id/notes/:noteId', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) {
    const n = demoComments.update(mr.id, req.params.noteId, body);
    return res.json({ ok: true, id: n.id, body: n.body });
  }
  const note = await forge.clientFor(mr).updateNote(
    getConfig(), mr.project, mr.iid, req.params.noteId, body, { inline: !!(req.body && req.body.inline) },
  );
  res.json({ ok: true, id: note && note.id, body: (note && note.body) || body });
}));

// Répond à une discussion existante.
app.post('/api/mrs/:id/discussions/:discussionId/reply', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.reponse-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, id: demoComments.reply(mr.id, req.params.discussionId, body).id });
  const note = await forge.clientFor(mr).replyToDiscussion(getConfig(), mr.project, mr.iid, req.params.discussionId, body);
  res.json({ ok: true, id: note && note.id });
}));

// Commentaire inline sur une ligne précise d'un fichier de la MR.
app.post('/api/mrs/:id/discussion', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { body, old_path, new_path, old_line, new_line } = req.body || {};
  if (!(body || '').trim()) throw new Error(t('err.commentaire-vide-2'));
  if (!new_path && !old_path) throw new Error(t('err.fichier-requis'));
  if (demoDocker.isDemo()) {
    const d = demoComments.post(mr.id, body.trim(), { new_path, old_path, new_line, old_line });
    return res.json({ ok: true, id: d.id });
  }
  const cfg = getConfig();
  const full = await forge.clientFor(mr).getMergeRequest(cfg, mr.project, mr.iid);
  const dr = full && full.diff_refs;
  if (!dr || !dr.head_sha) throw new Error(t('err.references-de-diff-introuvables-la'));
  const position = {
    base_sha: dr.base_sha, start_sha: dr.start_sha, head_sha: dr.head_sha,
    position_type: 'text',
    old_path: old_path || new_path, new_path: new_path || old_path,
  };
  if (new_line != null && new_line !== '') position.new_line = Number(new_line);
  if (old_line != null && old_line !== '') position.old_line = Number(old_line);
  const disc = await forge.clientFor(mr).postMrDiscussion(cfg, mr.project, mr.iid, body.trim(), position);
  res.json({ ok: true, id: disc && disc.id });
}));

// Merge une MR (depuis l'onglet Rapports de review).
/* Options de merge : ce que demande l'appel, sinon ce qui avait été choisi à la
   création de la MR (colonnes `mr.squash` / `mr.remove_source_branch`). */
function mergeOptsFor(mr, body) {
  const pick = (v, fallback) => (v === undefined ? fallback : !!(v === true || v === 'true' || v === 1 || v === '1'));
  return {
    squash: pick(body && body.squash, !!(mr && mr.squash)),
    removeSourceBranch: pick(body && body.removeSourceBranch, !!(mr && mr.remove_source_branch)),
  };
}

/* Mémorise les options choisies à la création. Indispensable pour GitHub, dont l'API de
   création ne sait pas les exprimer : c'est ici qu'on retrouve l'intention au merge. */
function rememberMergeOpts(repoId, iid, squash, removeSourceBranch) {
  db.prepare('UPDATE mr SET squash = ?, remove_source_branch = ? WHERE repo_id = ? AND iid = ?')
    .run(squash ? 1 : 0, removeSourceBranch ? 1 : 0, repoId, iid);
}

app.post('/api/mrs/:id/merge', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const opts = mergeOptsFor(mr, req.body);
  const merged = await forge.clientFor(mr).mergeMergeRequest(getConfig(), mr.project, mr.iid, opts);
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    // événement frais pour le footer + flag pour que discover ne re-signale pas
    db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
      .run('mr_merged', mr.iid, mr.project, mr.author || '', mr.title || '', now);
    db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mr.id);
    // si cette MR vient d'une Dev session, la tâche doit aussi passer « mergée »
    db.prepare('UPDATE task_target SET mr_merged = 1, updated_at = ? WHERE repo_id = ? AND mr_iid = ?')
      .run(now, mr.repo_id, mr.iid);
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));

const PORT = Number(process.env.PORT || 4319);
// Rafraîchissement automatique des MR : (re)démarre le timer selon la config.
// 0 = désactivé. Un seul timer actif à la fois ; ne se superpose pas aux découvertes.
let autoRefreshTimer = null;
let autoRefreshBusy = false;
function restartAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const min = Number(getConfig().auto_refresh_minutes) || 0;
  if (min <= 0) { console.log('[auto-refresh] désactivé'); return; }
  autoRefreshTimer = setInterval(async () => {
    if (autoRefreshBusy) return; // évite le chevauchement si une découverte est déjà en cours
    autoRefreshBusy = true;
    try {
      const r = await discoverAll();
      console.log(`[auto-refresh] ${r.found} MR · ${r.created} nouvelles · ${r.updated} maj${r.errors && r.errors.length ? ` · ${r.errors.length} erreur(s)` : ''}`);
    } catch (e) {
      console.error(`[auto-refresh] échec : ${e.message}`);
    } finally { autoRefreshBusy = false; }
  }, min * 60 * 1000);
  console.log(`[auto-refresh] activé : toutes les ${min} min`);
}


/* ---------- Onglet Git : opérations multi-dépôts + explorateur de branches ---------- */

// Refs d'un dépôt, pour alimenter les sélecteurs. Les branches protégées et la
// branche par défaut sont marquées : le front les rend non sélectionnables à la
// suppression plutôt que de laisser l'aperçu les rejeter ensuite.
app.get('/api/git/refs', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const kind = req.query.kind === 'tags' ? 'tags' : 'branches';
  if (demoGit.isDemo()) return res.json(demoGit.refs(repo.project, kind));
  if (kind === 'tags') {
    const api = forge.clientFor(repo);
    const [tags, prot] = await Promise.all([api.listTags(cfg, repo.project), api.listProtectedTags(cfg, repo.project)]);
    return res.json({ kind, refs: tags.map((x) => ({ name: x.name, sha: x.sha, protected: prot.includes(x.name), annotated: x.annotated, date: x.committed_date })) });
  }
  const apiB = forge.clientFor(repo);
  const [branches, prot] = await Promise.all([apiB.listBranchesFull(cfg, repo.project), apiB.listProtectedBranches(cfg, repo.project)]);
  res.json({
    kind,
    default: (branches.find((b) => b.default) || {}).name || null,
    refs: branches.map((b) => ({ name: b.name, sha: b.sha, default: b.default, protected: b.protected || prot.includes(b.name), merged: b.merged, date: b.committed_date, author: b.author })),
  });
}));

// Aperçu : ne modifie rien, sert de confirmation.
app.post('/api/git/preview', wrap(async (req, res) => {
  res.json(await gitops.preview(req.body || {}));
}));

// Exécution : passe par la file de jobs, car le fetch de sécurité qui précède
// chaque suppression peut être long (clonage initial d'un gros dépôt).
app.post('/api/git/execute', wrap(async (req, res) => {
  // En démo, les écritures sont purement décoratives : on ne touche à rien (pas de job).
  if (demoGit.isDemo()) return res.json({ demo: true });
  res.json(jobs.startGitJob(req.body || {}));
}));

// Historique, avec ce qu'il faut pour proposer la restauration.
app.get('/api/git/ops', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM git_op ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map((o) => ({
    ...o,
    restorable: gitops.isDestructive(o.action) && o.status === 'done' && !!o.ref_sha && !o.restored_at,
  })));
}));

app.post('/api/git/ops/:id/restore', wrap(async (req, res) => {
  res.json(jobs.startGitJob({ restoreOpId: Number(req.params.id) }));
}));

/* Explorateur de branches. Exige un clone local : l'analyse du graphe
   (ahead/behind, merge-base) a besoin de l'historique, que l'API ne donne pas. */
app.get('/api/git/branches', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  if (demoGit.isDemo()) return res.json(demoGit.branches(repo.project, repo.id));
  const cfg = getConfig();
  const [branches, mrs, tags] = await Promise.all([
    forge.clientFor(repo).listBranchesFull(cfg, repo.project),
    forge.clientFor(repo).listAllMRs(cfg, repo.project).catch(() => []),
    forge.clientFor(repo).listTags(cfg, repo.project).catch(() => []),
  ]);
  const defaultBranch = (branches.find((b) => b.default) || {}).name || 'main';
  await git.ensureRepo(cfg, repo, () => {});
  const cwd = git.cloneDirFor(cfg, repo);
  await gitgraph.fetchRepo(cwd, () => {});
  const rows = await gitgraph.analyzeBranches(cwd, { branches, defaultBranch, mrs });
  // Tags triés par date de création décroissante. GitLab n'expose pas de date de
  // création de tag distincte : on trie sur committed_date (date du commit pointé),
  // le meilleur proxy disponible — exact pour un tag léger, très proche pour un annoté.
  const tagsSorted = tags.slice().sort((a, b) => (Date.parse(b.committed_date || 0) || 0) - (Date.parse(a.committed_date || 0) || 0));
  // Branche(s) portant chaque tag (commit contenu). Local, best-effort ; borné pour
  // ne pas transformer un dépôt à millier de tags en millier de « git branch --contains ».
  await Promise.all(tagsSorted.slice(0, 200).map(async (tg) => {
    tg.branches = await git.branchesForCommit(cwd, tg.sha, defaultBranch);
  }));
  res.json({ project: repo.project, repo_id: repo.id, forge: forge.forgeOf(repo), default: defaultBranch, branches: rows, tags: tagsSorted });
}));

// Auteur PRÉCIS d'un tag, à la demande (l'API GitLab n'expose pas le tagger d'un tag
// annoté). Lu dans le clone local via git ; le clone est déjà présent quand on est
// dans l'explorateur, on le (re)fetch au besoin.
app.get('/api/git/tag-author', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const tag = String(req.query.tag || '').trim();
  if (!tag || /[\s\x00-\x1f~^:?*[\\]/.test(tag)) throw new Error(t('err.tag-invalide'));
  if (demoGit.isDemo()) return res.json(demoGit.tagAuthor(repo.project, tag));
  const cwd = await git.ensureRepo(getConfig(), repo, () => {});
  res.json(await git.tagAuthor(cwd, tag));
}));

// Recherche d'une ref (tag ou branche, saisie libre) À TRAVERS tous les dépôts actifs.
// Renvoie, par dépôt, les correspondances trouvées (avec commit + lien GitLab). Live et
// best-effort : un dépôt injoignable est marqué `error`, pas confondu avec « absente ».
function refUrl(cfg, project, kind, name) {
  const base = String(cfg.gitlab_url || '').replace(/\/+$/, '');
  const seg = kind === 'tag' ? '-/tags/' : '-/tree/';
  return `${base}/${project}/${seg}${encodeURIComponent(name)}`;
}
app.get('/api/git/find-ref', wrap(async (req, res) => {
  const cfg = getConfig();
  const name = String(req.query.name || '').trim();
  if (!name) throw new Error(t('err.ref-name-required'));
  const type = ['branch', 'tag'].includes(req.query.type) ? req.query.type : 'both';
  const kinds = type === 'both' ? ['branch', 'tag'] : [type];
  if (demoGit.isDemo()) return res.json(demoGit.findRef(name, type, db.prepare('SELECT id, project FROM repo WHERE enabled = 1').all()));
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) throw new Error(t('err.aucune-forge-configuree'));
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1').all();
  const results = await Promise.all(repos.map(async (r) => {
    const matches = [];
    let error = null;
    for (const kind of kinds) {
      try {
        const ref = await forge.clientFor(r).getRef(cfg, r.project, kind, name);
        if (ref) matches.push({
          kind,
          sha: (ref.commit && (ref.commit.short_id || String(ref.commit.id).slice(0, 8))) || '',
          fullSha: (ref.commit && ref.commit.id) || '',
          date: (ref.commit && ref.commit.committed_date) || null,
          author: (ref.commit && ref.commit.author_name) || '',
          url: forge.refUrl(cfg, r, kind, name),
        });
      } catch (e) { error = String(e.message).slice(0, 200); }
    }
    // Pour un tag trouvé, on renseigne aussi la (les) branche(s) qui le portent — via le
    // clone local, comme dans l'explorateur. Best-effort : ne bloque jamais le résultat.
    const tagMatch = matches.find((m) => m.kind === 'tag');
    if (tagMatch && tagMatch.fullSha) {
      try {
        const cwd = await git.ensureRepo(cfg, r, () => {});
        tagMatch.branches = await git.branchesForCommitDetailed(cwd, tagMatch.fullSha);
      } catch { /* clone injoignable : on garde le tag sans sa branche */ }
    }
    matches.forEach((m) => { delete m.fullSha; });
    return { project: r.project, repo_id: r.id, matches, error };
  }));
  res.json({ name, type, repos: results });
}));

// Banc d'essai « reprise de session IA » (Réglages → AI sessions). Enchaîne deux passes
// dans la même session d'agent pour vérifier que la reprise conserve le contexte. Appel
// direct (hors file de jobs) : c'est un diagnostic manuel, lancé à la demande.
app.post('/api/ai-sessions/test', wrap(async (req, res) => {
  const logs = [];
  const result = await aisession.runSessionTest((m) => logs.push(m));
  res.json({ ...result, logs });
}));

// Création d'une MR depuis l'explorateur : générique (pas liée à une session).
// La même mécanique que Dev IA — titre + création via l'API GitLab — mais entre
// une branche et sa branche source (déduite dans l'explorateur), pas un task_target.
app.post('/api/git/mr', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.body && req.body.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const source = String(req.body.source || '').trim();
  const target = String(req.body.target || '').trim();
  const title = String(req.body.title || '').trim() || source;
  if (!source || !target) throw new Error(t('err.git.mr-missing-refs'));
  if (source === target) throw new Error(t('err.git.mr-same-ref'));
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(repo).createMergeRequest(getConfig(), repo.project, {
    source_branch: source, target_branch: target, title, squash, removeSourceBranch,
  });
  rememberMergeOpts(repo.id, mr.iid, squash, removeSourceBranch);
  res.json({ iid: mr.iid, url: mr.web_url });
}));

// La langue est posée avant la première requête : les messages d’erreur du serveur
// sont de l’interface, ils doivent sortir dans la bonne langue dès le démarrage.
i18n.setLang(getConfig().language);

// Bind sûr par défaut : localhost SEULEMENT. HOST=0.0.0.0 est un opt-in explicite pour exposer
// sur le réseau (voir la section Sécurité du README).
const HOST = process.env.HOST || '127.0.0.1';
// L'avertissement porte sur « ce n'est PAS une boucle locale », pas sur l'égalité à 0.0.0.0 :
// HOST est un nom très répandu (tcsh, PaaS, images CI) et n'importe quelle valeur héritée de
// l'environnement (`::`, une IP de LAN…) expose l'app, qui n'a aucune authentification.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const HOST_EXPOSED = !LOOPBACK.includes(HOST);
// IPv6 : l'hôte doit être crocheté dans l'URL (http://[::1]:4319).
const HOST_SHOWN = HOST === '0.0.0.0' ? 'localhost' : (HOST.includes(':') ? `[${HOST}]` : HOST);
const server = app.listen(PORT, HOST, () => {
  console.log(`Mergerie sur http://${HOST_SHOWN}:${server.address().port}`);
  if (HOST_EXPOSED) console.log(`  ⚠ exposé hors de localhost (HOST=${HOST}) — aucune authentification, voir README § Sécurité`);
  console.log(`  copilot : ${copilot.COPILOT_BIN} ${[...copilot.EXTRA_ARGS, '-p', '"<prompt>"'].join(' ')}`);
  console.log(`  dry-run : ${copilot.isDryRun()}  |  COPILOT_ARGS=${JSON.stringify(process.env.COPILOT_ARGS || '')}`);
  restartAutoRefresh();
});

/* Exporté pour les tests de bout en bout : ils lancent le serveur EN PROCESSUS
   (PORT=0 → port libre attribué par l'OS) et l'arrêtent proprement à la fin.
   Le démarrage reste identique en usage normal (`node src/server.js`). */
module.exports = {
  app,
  server,
  close() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    return new Promise((resolve) => server.close(resolve));
  },
};
