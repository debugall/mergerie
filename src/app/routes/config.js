'use strict';
/* Les réglages : les lire sans leurs secrets (/api/footer, GET /api/config), les écrire (PUT), et le souvenir des tests de connexion.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const datasync = require('../../data/datasync');
const approbation = require('../../data/approbation');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { wrap } = require('../http');
const { oublierChampSprint, restartJiraWatch, statutsParProjet } = require('../lib/jira');
const { restartAutoRefresh } = require('../planification');

// Télémétrie du footer : tokens, activité perso, paliers, et activité de l'équipe
// (MR entrantes) — de la matière fraîche même quand l'utilisateur ne fait rien.
app.get('/api/footer', wrap((req, res) => {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.toISOString();
  const dayKey = (d) => { const jour = new Date(d); return `${jour.getFullYear()}-${String(jour.getMonth() + 1).padStart(2, '0')}-${String(jour.getDate()).padStart(2, '0')}`; };
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
  const weekKey = (d) => { const jour = new Date(d); const off = (jour.getDay() + 6) % 7; jour.setHours(0, 0, 0, 0); jour.setDate(jour.getDate() - off); return dayKey(jour); };
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
/* Aucun jeton ne redescend au front : '***' dit « il y en a un », '' dit « il n'y en a
   pas », et le front renvoie le masque tel quel quand il n'y a pas touché. La clé de dictée
   suit la même règle que les jetons de forge et de Jira — c'en est un. */
function sansSecrets(c) {
  return {
    ...c,
    access_token: c.access_token ? '***' : '',
    jira_token: c.jira_token ? '***' : '',
    github_token: c.github_token ? '***' : '',
    jenkins_token: c.jenkins_token ? '***' : '',
    dictation_api_key: c.dictation_api_key ? '***' : '',
  };
}
app.get('/api/config', wrap((req, res) => {
  const c = getConfig();
  /* `scopes` dit, champ par champ, ce qu'un changement ENGAGE : « equipe » (le réglage vit dans
     `config` et partira dans le dépôt de données partagé) ou « poste » (il reste sur cette
     machine — les jetons, le chemin des clones, la langue, le moteur de dictée). L'écran en fait
     un badge à côté de chaque champ. La liste vient du registre, pas d'une copie côté client :
     dupliquée, elle mentirait au premier réglage déplacé, et un badge qui ment sur un jeton est
     pire que pas de badge du tout. */
  const scopes = {};
  for (const champ of Object.keys(c)) scopes[champ] = configModule.destinationDe(champ);
  /* LES RÉGLAGES D'AUTOMATISME QUI ATTENDENT : changés par la synchro, pas encore vus ici. */
  const autoApproval = {
    pending: !approbation.configApprouvee(c),
    before: approbation.configApprouveeAvant(),
    signature: approbation.signature(approbation.empreinteConfig(c)),
  };
  res.json({ ...sansSecrets(c), scopes, auto_approval: autoApproval });
}));
/* Ce que l'écran des réglages relit à l'ouverture. */
app.get('/api/conn-tests', wrap((req, res) => {
  const out = {};
  for (const r of db.prepare('SELECT service, ok, detail, tested_at FROM conn_test').all()) {
    out[r.service] = { ok: !!r.ok, detail: r.detail || '', tested_at: r.tested_at };
  }
  res.json(out);
}));
app.put('/api/config', wrap((req, res) => {
  const patch = { ...req.body };
  // ne pas écraser un secret si le front renvoie le masque
  if (patch.access_token === '***') delete patch.access_token;
  if (patch.jira_token === '***') delete patch.jira_token;
  if (patch.github_token === '***') delete patch.github_token;
  if (patch.jenkins_token === '***') delete patch.jenkins_token;
  if (patch.dictation_api_key === '***') delete patch.dictation_api_key;
  const avant = getConfig();
  const c = updateConfig(patch);
  i18n.setLang(c.language);   // les messages d'erreur suivent la nouvelle langue
  /* La cadence de synchro s'applique tout de suite, comme celle du rafraîchissement : la boucle
     gardait l'ancienne jusqu'au redémarrage, pendant que l'écran annonçait la nouvelle. */
  if (String(avant.data_sync_seconds) !== String(c.data_sync_seconds)) datasync.demarrer();
  restartAutoRefresh(); // prend en compte le nouvel intervalle
  restartJiraWatch(); // idem pour la surveillance Jira (et le compteur du menu)
  oublierChampSprint(); // l'instance Jira visée a pu changer : on re-cherchera le champ sprint
  statutsParProjet.clear();
  res.json(sansSecrets(c));
}));
