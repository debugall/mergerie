'use strict';
/* Footer télémétrie « live », synchro, les promesses rejetées remontent à l'écran. */
/* ---------- Footer télémétrie « live » ----------
   Mode LIVE (défaut) : le bandeau reste CALME et n'affiche que l'actionnable —
   une MR qui vient d'arriver ou d'être mergée, une MR qui attend depuis trop
   longtemps. La frame apparaît en fondu, reste 8 s, disparaît. Elle est CLIQUABLE
   (ouvre la MR concernée) : c'est ce qui la distingue d'un économiseur d'écran.
   Mode STATS (optionnel) : rejoue l'ensemble des indicateurs dérivés des données.
   Pas de défilement : un mouvement continu en périphérie coûte de l'attention
   pendant la lecture d'un rapport, pour une valeur instantanée nulle. */
(function footer() {
  const frameEl = $('#footerFrame');
  const tokEl = $('#footerTokCount');
  if (!frameEl || !tokEl) return;

  let data = null;
  let dataTimer = null;
  let holdTimer = null;
  let tokShown = 0;
  let userHidden = false;
  let mode = 'live';
  const HOLD_MS = 8000;          // durée d'affichage d'une frame
  const NO_REPEAT_MS = 16 * 60 * 1000;
  const shownAt = new Map();
  const isPaused = () => document.hidden || userHidden;

  const fmt = (n) => Number(n || 0).toLocaleString(I18Nrt.currentLocale());
  const plur = (n) => (n > 1 ? 's' : '');
  const agoMin = (iso, nowIso) => Math.max(0, Math.floor((new Date(nowIso) - new Date(iso)) / 60000));
  const humanAgo = (m) => (m < 1 ? tr('footer.ago.now')
    : m < 60 ? tr('footer.ago.min', { n: m })
    : m < 1440 ? tr('footer.ago.hour', { n: Math.floor(m / 60) })
    : tr('footer.ago.day', { n: Math.floor(m / 1440) }));
  const feedText = (e, fresh) => {
    const who = e.author ? ` — ${e.author}` : '';
    if (e.type === 'mr_merged') return tr(fresh ? 'footer.feed.merged-fresh' : 'footer.feed.merged', { iid: e.mr_iid, who, project: e.project });
    return tr(fresh ? 'footer.feed.opened-fresh' : 'footer.feed.opened', { iid: e.mr_iid, who, project: e.project });
  };

  // Mode LIVE : uniquement ce sur quoi on peut AGIR, avec la cible du clic.
  function liveFrames(d) {
    const o = [];
    for (const e of (d.feed || [])) {
      const min = agoMin(e.at, d.now);
      if (min > 240) continue; // au-delà de 4 h ce n'est plus une actualité
      o.push({
        t: min <= 15 ? feedText(e, true) : `${feedText(e, false)} · ${humanAgo(min)}`,
        act: e.mr_id ? { mr: e.mr_id } : { seg: 'to_review' },
        w: min <= 15 ? 9 : 3,
      });
    }
    const t = d.team || {};
    if (t.oldestWaitingDays != null && t.oldestWaitingDays >= 2) {
      o.push({ t: tr('footer.oldest-waiting', { n: t.oldestWaitingDays }), act: { seg: 'to_review' }, w: 4 });
    }
    for (const m of (d.toReviewList || []).filter((x) => x.ageDays != null && x.ageDays >= 3).slice(0, 3)) {
      o.push({ t: tr('footer.mr-waiting', { iid: m.iid, n: m.ageDays, who: m.author ? ` — ${m.author}` : '' }), act: { mr: m.id }, w: 3 });
    }
    return o;
  }
  const providers = [
    // Événements FRAIS : « une MR vient d'arriver / vient d'être mergée par X »
    (d) => {
      const o = [];
      for (const e of (d.feed || [])) {
        const min = agoMin(e.at, d.now);
        if (min > 2880) continue; // > 2 j : trop vieux
        const fresh = min <= 15;
        o.push({ t: fresh ? feedText(e, true) : `${feedText(e, false)} · ${humanAgo(min)}`, w: fresh ? 9 : (min <= 120 ? 4 : 2) });
      }
      return o;
    },
    // Une frame PAR MR en attente (grosse source de variété)
    (d) => (d.toReviewList || []).map((m) => {
      const age = m.ageDays == null ? '' : ` · ${m.ageDays === 0 ? tr('footer.today') : tr('footer.ago.day', { n: m.ageDays })}`;
      return { t: tr('footer.mr-pending', { iid: m.iid, title: (m.title || '').slice(0, 60), who: m.author ? ` — ${m.author}` : '', project: m.project, age }), w: 3 };
    }),
    // Une frame PAR review récente
    (d) => (d.recentReviews || []).map((r) => ({
      t: tr('footer.reviewed', { iid: r.iid, note: r.note10 != null ? ` · ${fmtNote10(r.note10)}` : '', project: r.project, when: r.at ? ` · ${humanAgo(agoMin(r.at, d.now))}` : '' }),
      w: 2,
    })),
    // Plusieurs frames PAR projet (volume, note moyenne, meilleure, pire)
    (d) => (d.projects || []).flatMap((p) => {
      const f = [];
      if (p.reviewed > 0) f.push({ t: tr('footer.proj.reviewed', { n: p.reviewed, count: p.reviewed, project: p.project, avg: p.avgNote != null ? tr('footer.proj.avg', { avg: p.avgNote }) : '' }), w: 2 });
      if (p.pending > 0) f.push({ t: tr('footer.proj.pending', { n: p.pending, count: p.pending, project: p.project }), w: 2 });
      if (p.bestNote != null) f.push({ t: tr('footer.proj.best', { project: p.project, note: p.bestNote }), w: 1 });
      if (p.worstNote != null) f.push({ t: tr('footer.proj.worst', { project: p.project, note: p.worstNote }), w: 1 });
      return f;
    }),
    // Une frame PAR auteur (MR en attente)
    (d) => (d.authors || []).map((a) => ({ t: tr('footer.author.pending', { n: a.c, count: a.c, author: a.author }), w: 2 })),
    // Une frame PAR auteur (notes reçues sur ses MR)
    (d) => (d.authorNotes || []).filter((a) => a.avgNote != null)
      .map((a) => ({ t: tr('footer.author.notes', { n: a.reviewed, count: a.reviewed, author: a.author, avg: a.avgNote }), w: 2 })),
    // Une frame PAR semaine (8 dernières)
    (d) => (d.weekly || []).map((w) => {
      const label = w.weeksAgo === 0 ? tr('footer.week.this') : w.weeksAgo === 1 ? tr('footer.week.last') : tr('footer.week.ago', { n: w.weeksAgo });
      const bits = [];
      if (w.reviews) bits.push(tr('footer.bits.reviews', { n: w.reviews, count: w.reviews }));
      if (w.tokens) bits.push(`${fmt(w.tokens)} tokens`);
      return { t: `${label} · ${bits.join(' · ')}`, w: 2 };
    }),
    // Une frame PAR tranche de notes
    (d) => (d.noteBuckets || []).filter((b) => b.count > 0)
      .map((b) => ({ t: tr('footer.bucket', { n: b.count, count: b.count, label: b.label }), w: 1 })),
    // Comparaisons (aujourd'hui vs hier, semaine vs précédente)
    (d) => {
      const o = [];
      const today = (d.daily || []).find((x) => x.daysAgo === 0);
      const yest = (d.daily || []).find((x) => x.daysAgo === 1);
      if (today && yest) {
        if (today.reviews !== yest.reviews) o.push({ t: tr('footer.cmp.day', { n: today.reviews, count: today.reviews, yest: yest.reviews }), w: 2 });
        if (today.tokens && yest.tokens) o.push({ t: tr('footer.cmp.tokens', { today: fmt(today.tokens), yest: fmt(yest.tokens) }), w: 2 });
      }
      const w0 = (d.weekly || []).find((x) => x.weeksAgo === 0);
      const w1 = (d.weekly || []).find((x) => x.weeksAgo === 1);
      if (w0 && w1 && w0.reviews !== w1.reviews) o.push({ t: tr('footer.cmp.week', { n: w0.reviews, count: w0.reviews, prev: w1.reviews }), w: 2 });
      return o;
    },
    // Équivalences tangibles des tokens
    (d) => {
      const o = []; const tot = d.tokens.total || 0;
      if (tot > 1000) o.push({ t: tr('footer.eq.pages', { tokens: fmt(tot), n: fmt(Math.round(tot / 500)) }), w: 1 });
      if (tot > 1000) o.push({ t: tr('footer.eq.minutes', { tokens: fmt(tot), n: fmt(Math.round(tot / 200)) }), w: 1 });
      if (tot > 1000) o.push({ t: tr('footer.eq.novels', { n: tot >= 200000 ? 2 : 1, tokens: fmt(tot), count: (tot / 100000).toFixed(1) }), w: 1 });
      return o;
    },
    // Une frame PAR jour d'activité (14 derniers jours)
    (d) => (d.daily || []).map((x) => {
      let label;
      if (x.daysAgo === 0) label = tr('footer.today');
      else if (x.daysAgo === 1) label = tr('footer.yesterday');
      else label = new Date(`${x.day}T12:00:00`).toLocaleDateString(I18Nrt.currentLocale(), { weekday: 'long', day: '2-digit', month: '2-digit' });
      const bits = [];
      if (x.reviews) bits.push(tr('footer.bits.reviews', { n: x.reviews, count: x.reviews }));
      if (x.tokens) bits.push(`${fmt(x.tokens)} tokens`);
      return { t: `${label} · ${bits.join(' · ')}`, w: 2 };
    }),
    // Une frame PAR dev session récente
    (d) => (d.recentTasks || []).map((t) => ({
      t: tr(t.status === 'pushed' ? 'footer.task.pushed' : 'footer.task.committed', { branch: t.branch }), w: 2,
    })),
    // Tokens : répartition par type d'appel + repères
    (d) => {
      const o = [];
      const label = { review: tr('footer.kind.review'), explain: tr('footer.kind.explain'), task: tr('footer.kind.task') };
      for (const k of (d.tokensByKind || [])) {
        if (!k.tokens) continue;
        o.push({ t: tr('footer.tokens.by-kind', { n: k.calls, kind: label[k.kind] || k.kind, tokens: fmt(k.tokens), count: k.calls }), w: 2 });
      }
      const ts = d.tokenStats || {};
      if (ts.avgPerCall) o.push({ t: tr('footer.tokens.avg', { n: fmt(ts.avgPerCall) }), w: 1 });
      if (ts.maxCall) o.push({ t: tr('footer.tokens.max', { n: fmt(ts.maxCall) }), w: 1 });
      return o;
    },
    // Activité de l'équipe (agrégats)
    (d) => {
      const o = []; const t = d.team || {};
      if (t.newToday > 0) o.push({ t: tr('footer.team.new-today', { n: t.newToday, count: t.newToday }), w: 5 });
      if (t.toReview > 0) o.push({ t: tr('footer.team.to-review', { n: t.toReview, count: t.toReview }), w: 2 });
      if (t.oldestWaitingDays != null && t.oldestWaitingDays >= 2) o.push({ t: tr('footer.oldest-waiting', { n: t.oldestWaitingDays }), w: 3 });
      if (t.topAuthorToday && t.topAuthorToday.author) o.push({ t: tr('footer.team.top-author', { n: t.topAuthorToday.c, author: t.topAuthorToday.author, count: t.topAuthorToday.c }), w: 3 });
      return o;
    },
    // Records & cumuls — purement FACTUEL (pas d'objectif imposé)
    (d) => {
      const o = [];
      if (d.reviews.total > 0) o.push({ t: tr('footer.rec.total', { n: d.reviews.total, count: fmt(d.reviews.total) }), w: 2 });
      if (d.streak >= 2) o.push({ t: tr('footer.rec.streak', { n: d.streak }), w: 2 });
      if (d.reviews.bestNoteAllTime != null) o.push({ t: tr('footer.rec.best', { note: d.reviews.bestNoteAllTime }), w: 2 });
      if (d.reviews.today > 0) o.push({ t: tr('footer.rec.today', { n: d.reviews.today, count: d.reviews.today }), w: 2 });
      if (d.reviews.avgNote != null) o.push({ t: tr('footer.rec.avg', { avg: d.reviews.avgNote, total: d.reviews.total }), w: 2 });
      if (d.tokens.total > 0) o.push({ t: tr('footer.rec.tokens-total', { n: fmt(d.tokens.total) }), w: 1 });
      if (d.tokens.today > 0) o.push({ t: tr('footer.rec.tokens-today', { n: fmt(d.tokens.today) }), w: 2 });
      if (d.tokens.calls > 0) o.push({ t: tr('footer.rec.calls', { n: d.tokens.calls, count: fmt(d.tokens.calls) }), w: 1 });
      if (d.commits > 0) o.push({ t: tr('footer.rec.commits', { n: d.commits, count: fmt(d.commits) }), w: 2 });
      if (d.mrMerged > 0) o.push({ t: tr('footer.rec.merged', { n: d.mrMerged, count: d.mrMerged }), w: 2 });
      const coffees = Math.floor(d.tokens.total / 20000);
      if (coffees >= 1) o.push({ t: tr('footer.eq.coffee', { n: coffees, tokens: fmt(d.tokens.total), count: coffees }), w: 1 });
      return o;
    },
    // Contexte (heure / jour)
    (d) => {
      const dt = new Date(d.now); const h = dt.getHours(); const day = dt.getDay(); const o = [];
      if (h >= 22 || h < 6) o.push({ t: tr('footer.ctx.night'), w: 1 });
      else if (h < 10) o.push({ t: tr('footer.ctx.morning', { n: d.team.toReview || 0, count: d.team.toReview || 0 }), w: 1 });
      else if (h >= 12 && h < 14) o.push({ t: tr('footer.ctx.lunch'), w: 1 });
      if (day === 1) o.push({ t: tr('footer.ctx.monday'), w: 1 });
      else if (day === 5) o.push({ t: tr('footer.ctx.friday'), w: 1 });
      else if (day === 0 || day === 6) o.push({ t: tr('footer.ctx.weekend'), w: 1 });
      return o;
    },
  ];

  // Tirage pondéré, sans rejouer ce qui a été vu récemment. En mode live, s'il n'y
  // a rien de neuf à dire → null → le bandeau reste calme (c'est voulu).
  function pickFrame() {
    if (!data) return null;
    const now = Date.now();
    for (const [k, ts] of shownAt) if (now - ts > NO_REPEAT_MS * 3) shownAt.delete(k);
    let pool = [];
    if (mode === 'live') {
      pool = liveFrames(data);
    } else {
      for (const p of providers) {
        try { for (const f of p(data)) if (f && f.t) pool.push(f); } catch { /* provider tolérant */ }
      }
    }
    const unseen = pool.filter((f) => { const ts = shownAt.get(f.t); return ts == null || (now - ts) > NO_REPEAT_MS; });
    const from = unseen.length ? unseen : (mode === 'live' ? [] : pool);
    if (!from.length) return null;
    const total = from.reduce((s, f) => s + (f.w || 1), 0);
    let r = Math.random() * total; let chosen = from[0];
    for (const f of from) { r -= (f.w || 1); if (r <= 0) { chosen = f; break; } }
    shownAt.set(chosen.t, now);
    return chosen;
  }

  function runAct(act) {
    if (!act) return;
    const go = (tab) => { const t = $(`nav button[data-tab="${tab}"]`); if (t) t.click(); };
    if (act.mr) { go('review'); loadSegment('to_review').then(() => openReport(act.mr)).catch(() => {}); return; }
    if (act.seg) { go('review'); loadSegment(act.seg); }
  }

  function showFrame(f) {
    frameEl.innerHTML = '';
    if (!f) return;
    const el = document.createElement(f.act ? 'button' : 'span');
    el.className = 'footer-msg' + (f.act ? ' clickable' : '');
    el.textContent = f.t;
    if (f.act) {
      el.title = tr('ui.open');
      el.addEventListener('click', () => runAct(f.act));
    }
    frameEl.appendChild(el);
  }

  // Boucle : une frame, 8 s, puis silence. Rien à dire → on retente plus tard.
  function loop() {
    holdTimer = null;
    if (isPaused()) return;
    const f = pickFrame();
    if (!f) { showFrame(null); holdTimer = setTimeout(loop, 5000); return; }
    showFrame(f);
    holdTimer = setTimeout(() => {
      showFrame(null);
      holdTimer = setTimeout(loop, 900);
    }, HOLD_MS);
  }

  function animateTokens(target) {
    target = Number(target) || 0;
    const start = tokShown; const delta = target - start;
    if (!delta) { tokEl.textContent = fmt(target); return; }
    const t0 = performance.now(); const dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      tokShown = Math.round(start + delta * eased);
      tokEl.textContent = fmt(tokShown);
      if (k < 1 && !document.hidden) requestAnimationFrame(step);
      else { tokShown = target; tokEl.textContent = fmt(target); }
    };
    requestAnimationFrame(step);
  }

  async function refresh() {
    try {
      data = await api('/footer');
      animateTokens(data.tokens.total);
      if (!holdTimer && !isPaused()) loop(); // un événement frais peut sortir le bandeau du silence
    } catch { /* le footer ne doit jamais gêner */ }
  }
  function startData() { if (!dataTimer) dataTimer = setInterval(refresh, 20000); }
  function stopData() { if (dataTimer) { clearInterval(dataTimer); dataTimer = null; } }
  function pauseAll() { stopData(); if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } showFrame(null); }
  function resumeAll() { if (isPaused()) return; startData(); refresh(); if (!holdTimer) loop(); }

  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAll(); else resumeAll(); });

  // Bascule live / stats
  const modeBtn = $('#footerMode');
  function setMode(m) {
    mode = m;
    if (modeBtn) { modeBtn.textContent = m === 'live' ? 'live' : 'stats'; modeBtn.title = m === 'live' ? tr('footer.mode.live-title') : tr('footer.mode.stats-title'); }
    try { localStorage.setItem('aidevtools_footer_mode', m); } catch { /* ignore */ }
    shownAt.clear();
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!isPaused()) loop();
  }
  if (modeBtn) modeBtn.addEventListener('click', () => setMode(mode === 'live' ? 'stats' : 'live'));

  // Masquer / réafficher le bandeau (état conservé d'une session à l'autre)
  const FKEY = 'aidevtools_footer_hidden';
  const footerEl = $('#footer'); const showBtn = $('#footerShow');
  function setHidden(h) {
    userHidden = h;
    if (footerEl) footerEl.hidden = h;
    if (showBtn) showBtn.hidden = !h;
    document.body.classList.toggle('footer-hidden', h);
    try { localStorage.setItem(FKEY, h ? '1' : '0'); } catch { /* ignore */ }
    if (h) pauseAll(); else resumeAll();
  }
  const hideBtn = $('#footerHide');
  if (hideBtn) hideBtn.addEventListener('click', () => setHidden(true));
  if (showBtn) showBtn.addEventListener('click', () => setHidden(false));

  try { userHidden = localStorage.getItem(FKEY) === '1'; } catch { /* ignore */ }
  try { mode = localStorage.getItem('aidevtools_footer_mode') || 'live'; } catch { /* ignore */ }
  setMode(mode);
  setHidden(userHidden);
})();


// Filet de sécurité : une promesse rejetée non gérée passait totalement inaperçue
// (bouton qui « ne fait rien »). On la remonte à l'écran.
