'use strict';
/* Notes → Période : le rattrapage d'une fenêtre de dates — « qu'est-ce qui s'est passé pendant mon absence ? ». */
/* ============ Le rattrapage d'une période ============
   L'écran est une LISTE QU'ON VIDE, pas un rapport qu'on lit : chaque ligne porte « vu », l'état
   survit au recalcul. Rien n'est calculé ici — tout vient d'un job (la forge et le clone de chaque
   dépôt), et l'écran se redessine à sa fin. Les cartes de merge request sont des lignes
   compactes, dans la grammaire du brief ; les gestes mènent aux écrans qui savent les faire. */
const PERIODE = {
  id: null,            // la période affichée
  data: null,          // sa charge utile (`GET /api/periode/:id`)
  mrs: new Map(),      // mr_id → ligne de `/api/mrs` (note, rapport, forge…)
  moi: null,           // l'identité, pour le filtre « moi »
  absence: null,       // `GET /api/periode/absence` : « Je pars » et son état
  poll: null,
  seq: 0,              // le dernier chargement demandé gagne : un plus ancien qui finit après se tait
  filtres: { repo: '', author: 'all', bots: true, seen: false },
};

const pBox = () => $('#periodeBox');
const pJourIso = (d) => new Date(d).toISOString().slice(0, 10);
const JOB_FINI_P = ['done', 'error', 'stopped'];

/* ---------- Chargement ---------- */

async function loadPeriode() {
  const box = pBox();
  if (!box) return;
  const seq = ++PERIODE.seq;
  let liste;
  try { liste = await api('/periode'); } catch (err) { box.innerHTML = `<p class="err">${esc(explainError(err.message))}</p>`; return; }
  if (seq !== PERIODE.seq) return;                       // une construction a pris la main entre-temps
  try { PERIODE.absence = await api('/periode/absence'); } catch { PERIODE.absence = null; }
  if (seq !== PERIODE.seq) return;
  PERIODE.filtres.bots = !!liste.hide_bots;
  if (PERIODE.id == null && liste.periodes.length) PERIODE.id = liste.periodes[0].id;
  if (PERIODE.id == null) { renderPeriodeBarre(liste.periodes, null); renderPeriodeCorps(null); return; }
  await chargerPeriode(PERIODE.id, liste.periodes);
}

async function chargerPeriode(id, periodes = null) {
  PERIODE.id = id;
  const seq = ++PERIODE.seq;
  let d;
  try { d = await api(`/periode/${id}`); } catch (err) { toast(explainError(err.message), true); return; }
  if (seq !== PERIODE.seq) return;
  PERIODE.data = d;
  PERIODE.filtres.bots = !!d.hide_bots;
  if (!periodes) { try { periodes = (await api('/periode')).periodes; } catch { periodes = []; } }
  renderPeriodeBarre(periodes, d);
  if (d.job && !JOB_FINI_P.includes(d.job.status)) { renderPeriodeCorps(d, { enCours: true }); suivreJobPeriode(id); return; }
  if (!d.built_at) { renderPeriodeCorps(d, { enCours: !!d.job }); if (d.job) suivreJobPeriode(id); return; }
  await enrichirMrs(d);
  renderPeriodeCorps(d);
  majBadgePeriode(d.unseen);
  if (d.resume_job && !JOB_FINI_P.includes(d.resume_job.status)) suivreJobPeriode(id, 'resume_job');
}

/* Le job tourne (la construction, ou le résumé IA) : on relit la période jusqu'à sa fin —
   l'effet, jamais un délai. */
function suivreJobPeriode(id, champ = 'job') {
  if (PERIODE.poll) clearInterval(PERIODE.poll);
  PERIODE.poll = setInterval(async () => {
    if (PERIODE.id !== id || !$('#tab-notes').classList.contains('active')) return;
    let d;
    try { d = await api(`/periode/${id}`); } catch { return; }
    if (d[champ] && !JOB_FINI_P.includes(d[champ].status)) return;
    clearInterval(PERIODE.poll); PERIODE.poll = null;
    await chargerPeriode(id);
  }, 1500);
}

/* Les lignes de `/api/mrs` pour les merge requests de la période : note, rapport, forge, « nouveau
   pour toi ». Une requête, pas une par carte. */
async function enrichirMrs(d) {
  const ids = new Set(d.items.map((it) => it.mr_id).filter(Boolean));
  PERIODE.mrs = new Map();
  if (!ids.size) return;
  try {
    const rows = await api('/mrs');
    for (const m of rows) if (ids.has(m.id)) PERIODE.mrs.set(m.id, m);
  } catch { /* la liste reste lisible sans la note */ }
  if (!PERIODE.moi) { try { PERIODE.moi = await api('/whoami'); } catch { PERIODE.moi = {}; } }
}

function majBadgePeriode(n) {
  const el = $('#notesPeriodeCount');
  if (!el) return;
  el.hidden = !n;
  el.textContent = String(n || 0);
}

/* ---------- La barre : dates, historique, construire ---------- */

function renderPeriodeBarre(periodes, d) {
  const box = pBox();
  const depuis = d ? pJourIso(d.depuis) : pJourIso(Date.now() - 10 * 86400e3);
  const jusqua = d ? pJourIso(d.jusqua) : pJourIso(Date.now());
  const hist = (periodes || []).map((p) => `<option value="${p.id}" ${d && p.id === d.id ? 'selected' : ''}>${esc(fmtDate(p.depuis))} → ${esc(fmtDate(p.jusqua))}${p.unseen ? ` · ${esc(tr('notes.periode.history.unseen', { n: p.unseen, count: p.unseen }))}` : ''}</option>`).join('');
  let barre = $('#periodeBarre');
  if (!barre) {
    box.innerHTML = '<div id="periodeBarre" class="notes-periode-bar"></div><div id="periodeCorps"></div>';
    barre = $('#periodeBarre');
  }
  /* Deux rangées : la FENÊTRE (dates, construire, l'historique à droite), puis les GESTES sur la
     période affichée (recalculer, tout marquer vu, résumer — et « je pars » à part, à droite). */
  const construite = !!(d && d.built_at);
  barre.innerHTML = `
    <div class="notes-periode-bar-row">
      <label>${esc(tr('notes.periode.from'))} <input type="date" id="periodeFrom" value="${depuis}" /></label>
      <label>${esc(tr('notes.periode.to'))} <input type="date" id="periodeTo" value="${jusqua}" /></label>
      <button type="button" class="btn btn-primary" id="periodeBuild" title="${esc(tr('notes.periode.build-title'))}">${svgIco('play')}${esc(tr('notes.periode.build'))}</button>
      <span class="spacer"></span>
      ${hist ? `<label class="notes-periode-history">${svgIco('clock')}<span>${esc(tr('notes.periode.history'))}</span> <select id="periodeHist">${hist}</select></label>` : ''}
    </div>
    ${construite || pDepartHtml() ? `<div class="notes-periode-bar-row notes-periode-bar-actions">
      ${construite ? `<button type="button" class="btn btn-sm" id="periodeRebuild">${svgIco('refresh')}${esc(tr('notes.periode.rebuild'))}</button>` : ''}
      ${construite ? `<button type="button" class="btn btn-sm" id="periodeSeenAll">${svgIco('check')}${esc(tr('notes.periode.seen-all'))}</button>` : ''}
      ${construite ? `<button type="button" class="btn btn-sm" id="periodeResume" title="${esc(tr('notes.periode.resume-title'))}">${svgIco('bot')}${esc(tr('notes.periode.resume'))}</button>` : ''}
      <span class="spacer"></span>
      ${pDepartHtml()}
    </div>` : ''}`;
  $('#periodeBuild').addEventListener('click', () => construirePeriode($('#periodeFrom').value, $('#periodeTo').value));
  brancherDepart(periodes, d);
  const rs = $('#periodeResume');
  if (rs) rs.addEventListener('click', async () => {
    try { await busy(rs, () => api(`/periode/${d.id}/resume`, { method: 'POST' })); toast(tr('toast.periode-resume-lance')); refreshStatus(); await chargerPeriode(d.id); }
    catch (err) { toast(explainError(err.message), true); }
  });
  const sel = $('#periodeHist');
  if (sel) sel.addEventListener('change', () => chargerPeriode(Number(sel.value)));
  const rb = $('#periodeRebuild');
  if (rb) rb.addEventListener('click', async () => {
    try { await busy(rb, () => api(`/periode/${d.id}/rebuild`, { method: 'POST' })); toast(tr('toast.periode-lancee')); refreshStatus(); await chargerPeriode(d.id); }
    catch (err) { toast(explainError(err.message), true); }
  });
  const sa = $('#periodeSeenAll');
  if (sa) sa.addEventListener('click', async () => {
    try { await busy(sa, () => api(`/periode/${d.id}/seen`, { method: 'POST', body: { all: true } })); toast(tr('toast.periode-vu')); await chargerPeriode(d.id); }
    catch (err) { toast(explainError(err.message), true); }
  });
}

/* « JE PARS » : l'absence commence maintenant, à la minute — un confort, la présence mesurée sur
   un geste suffit à la bannière, mais la fenêtre est alors exacte. Parti, le bouton dit depuis
   quand et propose d'annuler. */
function pDepartHtml() {
  const a = PERIODE.absence;
  if (a && a.explicit) {
    return `<span class="notes-periode-depart muted">${svgIco('clock')} ${esc(tr('notes.periode.depart.since', { date: fmtDate(a.depart || a.last_seen) }))}
      <button type="button" class="btn btn-sm" id="periodeDepartCancel">${esc(tr('notes.periode.depart.cancel'))}</button></span>`;
  }
  return `<button type="button" class="btn btn-sm" id="periodeDepart" title="${esc(tr('notes.periode.depart-title'))}">${svgIco('clock')}${esc(tr('notes.periode.depart'))}</button>`;
}
function brancherDepart(periodes, d) {
  const dp = $('#periodeDepart');
  if (dp) dp.addEventListener('click', async () => {
    try { PERIODE.absence = await busy(dp, () => api('/periode/depart', { method: 'POST' })); toast(tr('toast.periode-depart')); renderPeriodeBarre(periodes, d); }
    catch (err) { toast(explainError(err.message), true); }
  });
  const an = $('#periodeDepartCancel');
  if (an) an.addEventListener('click', async () => {
    try { await busy(an, () => api('/periode/absence/dismiss', { method: 'POST' })); PERIODE.absence = await api('/periode/absence'); renderPeriodeBarre(periodes, d); }
    catch (err) { toast(explainError(err.message), true); }
  });
}

async function construirePeriode(depuis, jusqua, { repoIds = null } = {}) {
  const b = $('#periodeBuild');
  const lancer = () => api('/periode', { method: 'POST', body: { depuis, jusqua, repo_ids: repoIds } });
  try {
    const r = b ? await busy(b, lancer) : await lancer();
    toast(tr('toast.periode-lancee'));
    if (r.long) toast(tr('notes.periode.long'));
    refreshStatus();
    await chargerPeriode(r.periode.id);
  } catch (err) { toast(explainError(err.message), true); }
}

/* Depuis la bannière du brief : la fenêtre de l'absence, pré-remplie ET construite — un clic
   suffit. Une période déjà construite sur ces dates est réutilisée. */
async function ouvrirPeriodeDepuis(lastSeen, lastPeriode) {
  api('/periode/absence/dismiss', { method: 'POST' }).catch(() => {});   // la bannière a servi
  showNotesSub('periode');
  const depuis = pJourIso(lastSeen);
  const jusqua = pJourIso(Date.now());
  if (lastPeriode && pJourIso(lastPeriode.depuis) === depuis && pJourIso(lastPeriode.jusqua) === jusqua && lastPeriode.built_at) {
    await chargerPeriode(lastPeriode.id);
    return;
  }
  await construirePeriode(depuis, jusqua);
}

/* ---------- Le corps ---------- */

function estMoiP(auteur) {
  const a = String(auteur || '').trim().toLowerCase();
  if (!a || !PERIODE.moi) return false;
  return [PERIODE.moi.name, PERIODE.moi.username, PERIODE.moi.email].filter(Boolean).some((v) => String(v).trim().toLowerCase() === a);
}

function pPasseFiltres(it) {
  const f = PERIODE.filtres;
  if (f.repo && String(it.repo_id || '') !== f.repo) return false;
  if (f.author === 'mine' && !estMoiP(it.author)) return false;
  if (f.author === 'others' && estMoiP(it.author)) return false;
  if (f.bots && it.extra && it.extra.bot) return false;
  if (!f.seen && it.seen) return false;
  return true;
}

function renderPeriodeCorps(d, { enCours = false } = {}) {
  const corps = $('#periodeCorps');
  if (!corps) return;
  if (!d) { corps.innerHTML = emptyState({ icon: 'clock', title: esc(tr('notes.periode.none.title')), text: esc(tr('notes.periode.none.text')) }); return; }
  const tete = `<div class="notes-periode-head">
      <span class="notes-periode-span">${esc(tr('notes.periode.from'))} ${esc(fmtDate(d.depuis))} ${esc(tr('notes.periode.to'))} ${esc(fmtDate(d.jusqua))}</span>
      <span class="muted">${esc(tr('notes.periode.days', { n: d.days, count: d.days }))}</span>
      <span class="muted">· ${esc(tr('notes.periode.repos', { n: pNbDepots(d), count: pNbDepots(d) }))}</span>
    </div>`;
  if (enCours) {
    corps.innerHTML = `${tete}<div class="notes-periode-building"><span class="spinner"></span> ${esc(tr('notes.periode.building'))}</div>${skeleton(3)}`;
    return;
  }
  if (d.job && d.job.status === 'error') {
    corps.innerHTML = `${tete}<p class="err">${esc(tr('notes.periode.failed', { message: d.job.message || '' }))}</p>`;
    return;
  }
  const repos = d.repos.filter((r) => d.items.some((it) => it.repo_id === r.id) || (r.partiel));
  /* Le dépôt se choisit dans un combo avec recherche (règle projet : un dépôt actif en a des
     dizaines) ; les auteurs dans un segmenté ; les deux options en pastilles cochables. */
  const repoChoisi = repos.find((r) => String(r.id) === PERIODE.filtres.repo);
  const nParDepot = (id) => d.items.filter((it) => it.repo_id === id).length;
  const filtres = `<div class="notes-periode-filtres">
      ${comboHtml('periodeFiltreRepoVal', { value: repoChoisi ? repoChoisi.id : '', label: repoChoisi ? repoChoisi.project : tr('notes.periode.filter.repo'), ph: tr('notes.periode.filter.repo'), wrapClass: 'notes-periode-filtre-repo' })}
      <div class="segmented" role="tablist">${['all', 'others', 'mine'].map((k) => `<button type="button" data-pauthor="${k}" class="${PERIODE.filtres.author === k ? 'active' : ''}">${esc(tr(`notes.periode.filter.author.${k}`))}</button>`).join('')}</div>
      <label class="notes-periode-filtre-case"><input type="checkbox" id="periodeFiltreBots" ${PERIODE.filtres.bots ? 'checked' : ''}/> ${esc(tr('notes.periode.filter.bots'))}</label>
      <label class="notes-periode-filtre-case"><input type="checkbox" id="periodeFiltreSeen" ${PERIODE.filtres.seen ? 'checked' : ''}/> ${esc(tr('notes.periode.filter.seen'))}</label>
    </div>`;
  // Ce que chaque dépôt n'a pas pu livrer : affiché, jamais caché.
  const partiels = d.repos.filter((r) => r.partiel).map((r) => (r.partiel.non_calcule && r.partiel.non_calcule.length
    ? `<p>${esc(tr('notes.periode.not-computed', { project: r.project }))}</p>`
    : `<p>${esc(tr('notes.periode.partial', { project: r.project, reasons: (r.partiel.raisons || []).join(' · ') }))}</p>`)).join('');
  const visibles = d.items.filter(pPasseFiltres);
  const caches = d.items.length - visibles.length;
  const par = (kind) => visibles.filter((it) => it.kind === kind);
  const sections = [
    pResumeHtml(d),
    sectionPushs(par('push')),
    sectionMergees(par('mr_merged')),
    sectionMrs('new', par('mr_new'), { icon: 'inbox', hint: tr('notes.periode.sec.new.hint') }),
    sectionMrs('closed', par('mr_closed'), { icon: 'close' }),
    sectionMrs('active', par('mr_active'), { icon: 'repeat', hint: tr('notes.periode.sec.active.hint'), replie: true }),
    sectionTags([...par('pipeline'), ...par('tag'), ...par('branch_gone')]),
    sectionEquipe(par('team')),
    sectionJira(par('jira'), d.partiel_jira),
    sectionMergerie(par('mergerie')),
  ].join('');
  corps.innerHTML = `${tete}${filtres}${partiels ? `<div class="notes-periode-partiel">${partiels}</div>` : ''}
    ${sections || emptyState({ icon: 'check', title: esc(tr('notes.periode.empty.title')), text: esc(tr('notes.periode.empty.text')) })}
    ${caches ? `<p class="notes-periode-hidden-foot">${esc(tr('notes.periode.hidden', { n: caches, count: caches }))}</p>` : ''}`;
  wireCombo(corps, 'periodeFiltreRepoVal', async () => [
    { value: '', label: tr('notes.periode.filter.repo') },
    ...repos.map((r) => ({ value: String(r.id), label: r.project, hint: String(nParDepot(r.id)) })),
  ]);
  $('.periodeFiltreRepoVal', corps).addEventListener('change', (e) => { PERIODE.filtres.repo = e.target.value; renderPeriodeCorps(d); });
  $$('#periodeCorps [data-pauthor]').forEach((b) => b.addEventListener('click', () => { PERIODE.filtres.author = b.dataset.pauthor; renderPeriodeCorps(d); }));
  $('#periodeFiltreBots').addEventListener('change', (e) => { PERIODE.filtres.bots = e.target.checked; renderPeriodeCorps(d); });
  $('#periodeFiltreSeen').addEventListener('change', (e) => { PERIODE.filtres.seen = e.target.checked; renderPeriodeCorps(d); });
  brancherGestesPeriode(d);
}

const pNbDepots = (d) => new Set(d.items.map((it) => it.repo_id).filter(Boolean)).size || (d.repo_ids ? d.repo_ids.length : d.repos.length);
const pProjetDe = (d, repoId) => ((d.repos.find((r) => r.id === repoId) || {}).project || '');

function pSectionHtml(cle, items, corps, { icon = 'inbox', hint = '', replie = false, vars = {}, avant = '' } = {}) {
  if (!items.length) return '';
  const n = items.length;
  return `<details class="notes-periode-sec notes-periode-${cle}" ${replie ? '' : 'open'}>
    <summary>${svgIco(icon)}<span>${esc(tr(`notes.periode.sec.${cle}`, { n, count: n, ...vars }))}</span></summary>
    ${hint ? `<p class="notes-periode-hint">${esc(hint)}</p>` : ''}${avant}${corps}
  </details>`;
}

const pVuBtn = (it) => `<label class="notes-periode-seen" title="${esc(tr('notes.periode.seen-title'))}"><input type="checkbox" data-pseen="${it.id}" ${it.seen ? 'checked' : ''}/> ${esc(tr('notes.periode.seen'))}</label>`;
const pQuand = (iso) => (iso ? `<span data-when="${esc(iso)}">${esc(fmtDate(iso))}</span>` : '');

/* 1. Les pushs directs — en tête, en rouge, jamais repliés. */
function sectionPushs(items) {
  const corps = items.map((it) => {
    const x = it.extra || {};
    const tags = [
      x.revert ? `<span class="tag stale">${esc(tr('notes.periode.push.revert'))}</span>` : '',
      x.merge_manuel ? `<span class="tag">${esc(tr('notes.periode.push.merge-manual'))}</span>` : '',
      x.bot ? `<span class="tag">${esc(tr('notes.periode.push.bot'))}</span>` : '',
      x.non_verifie ? `<span class="tag risk" title="${esc(tr('notes.periode.push.unverified-title'))}">${svgIco('alert')} ${esc(tr('notes.periode.push.unverified'))}</span>` : '',
    ].join('');
    const stat = x.stat ? `<span class="diffstat"><span class="plus">+${x.stat.additions || 0}</span> <span class="moins">−${x.stat.deletions || 0}</span></span>` : '';
    const commits = (x.commits || []).map((c) => `<li><code>${esc(String(c.sha || '').slice(0, 8))}</code> <span>${esc(c.title || '')}</span></li>`).join('');
    const n = (x.commits || []).length;
    return `<div class="notes-periode-item ${it.seen ? 'seen' : ''} ${x.non_verifie ? 'unverified' : ''}" data-pitem="${it.id}">
      <div class="notes-periode-main">
        <div class="notes-periode-title">${esc(pProjetDe(PERIODE.data, it.repo_id))} · ${chipBranche(x.branche || '', { cible: true })} ${tags}</div>
        <div class="meta">${esc(tr('notes.periode.push.by', { author: it.author || '', when: '' }))}${pQuand(it.at)} · ${esc(tr('notes.periode.push.commits', { n, count: n }))} ${stat}</div>
        <ul class="notes-periode-commits">${commits}</ul>
      </div>
      <div class="notes-periode-actions">
        <button type="button" class="btn btn-sm" data-pdiff="${it.id}">${svgIco('eye')}${esc(tr('notes.periode.btn.diff'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-pexplore="${it.id}" title="${esc(tr('notes.periode.btn.explore-title'))}">${svgIco('bot')}${esc(tr('notes.periode.btn.explore'))}</button>
        <button type="button" class="btn btn-sm" data-pverify="${it.id}">${esc(tr('notes.periode.btn.verify'))}</button>
        ${addTodoBtn('branch', `${it.repo_id}:${x.branche || ''}:${String(x.head_sha || '').slice(0, 8)}`, tr('notes.periode.todo.push', { author: it.author || '', branch: x.branche || '', project: pProjetDe(PERIODE.data, it.repo_id) }))}
        <button type="button" class="btn btn-sm" data-pfix="${it.id}" title="${esc(tr('notes.periode.btn.fix-title'))}">${esc(tr('notes.periode.btn.fix'))}</button>
        ${pVuBtn(it)}
      </div>
    </div>`;
  }).join('');
  return pSectionHtml('push', items, corps, { icon: 'alert', hint: tr('notes.periode.sec.push.hint') });
}

/* 2. Les mergées : la ligne dit si elle a déjà été relue (par moi, par un collègue) ou jamais. */
function pLigneMr(it, kind) {
  const m = PERIODE.mrs.get(it.mr_id) || null;
  const x = it.extra || {};
  const cle = { mr_merged: 'merged-at', mr_closed: 'closed-at', mr_new: 'opened-at', mr_active: 'active-at' }[kind];
  const statut = [];
  if (kind === 'mr_merged') {
    if (x.team_review) statut.push(`<span class="tag">${svgIco('users')} ${esc(tr('notes.periode.mr.team-review', { author: x.team_review.author || '', when: '' }))}${pQuand(x.team_review.at)}${x.team_review.note != null ? ` · ${esc(fmtNote10(Number(x.team_review.note) * 10))}` : ''}</span>`);
    else if (m && m.has_review) statut.push(`<span class="tag done">${esc(tr('notes.periode.mr.reviewed-before'))}</span>${noteBadge(m.note, m)}`);
    else statut.push(`<span class="tag">${esc(tr('notes.periode.mr.never-reviewed'))}</span>`);
  }
  if (m && m.new_for_me) statut.push(`<span class="tag new-for-me">${svgIco('users')} ${esc(tr('mr.tag.new-for-me'))}</span>`);
  const titre = `!${esc(it.ref)} — ${esc(it.title || '')}`;
  const url = x.web_url || (m && m.web_url) || '';
  const actions = [];
  if (kind === 'mr_merged' && m) {
    actions.push(`<button type="button" class="btn btn-sm" data-pmrdiff="${m.id}">${svgIco('eye')}${esc(tr('notes.periode.btn.diff'))}</button>`);
    if (m.has_review) actions.push(`<button type="button" class="btn btn-sm btn-primary" data-pmrreport="${m.id}">${esc(tr('notes.periode.btn.report'))}</button>`);
    actions.push(`<button type="button" class="btn btn-sm ${m.has_review ? '' : 'btn-primary'}" data-pmrreview="${m.id}" data-iid="${esc(it.ref)}" title="${esc(tr('notes.periode.btn.review-title'))}">${svgIco('play')}${esc(tr('notes.periode.btn.review'))}</button>`);
    actions.push(addTodoBtn('mr', String(m.id), `!${it.ref} — ${it.title || ''}`));
  } else if (m && kind !== 'mr_closed') {
    actions.push(`<button type="button" class="btn btn-sm" data-pmrreport="${m.id}" data-open="1">${esc(tr('notes.periode.btn.open-mr'))}</button>`);
  }
  if (url) actions.push(`<a class="btn btn-sm" href="${safeUrl(url)}" target="_blank" rel="noopener">${svgIco('external')}</a>`);
  return `<div class="notes-periode-item ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
    <div class="notes-periode-main">
      <div class="notes-periode-title">${titre}</div>
      <div class="meta">${esc(pProjetDe(PERIODE.data, it.repo_id))} · ${esc(tr(`notes.periode.mr.${cle}`, { author: it.author || '', when: '' }))}${pQuand(it.at)}
        ${x.source_branch ? ` · ${chipBranche(x.source_branch)} <span class="branch-arrow">→</span> ${chipBranche(x.target_branch, { cible: true })}` : ''} ${statut.join(' ')}</div>
    </div>
    <div class="notes-periode-actions">${actions.join('')}${pVuBtn(it)}</div>
  </div>`;
}
/* Le lot « Reviewer les N » : les jamais relues (ni par moi, ni par un collègue), bots exclus,
   dans l'ordre du RISQUE décroissant — fichiers sensibles d'abord, puis la taille du changement. */
const pRisque = (m) => ((m.risk || []).length * 1000) + Number(m.changed_files || 0);
function sectionMergees(items) {
  const nonRelues = items
    .filter((it) => { const m = PERIODE.mrs.get(it.mr_id); return m && !m.has_review && !(it.extra && it.extra.team_review) && !(it.extra && it.extra.bot); })
    .sort((a, b) => pRisque(PERIODE.mrs.get(b.mr_id)) - pRisque(PERIODE.mrs.get(a.mr_id)));
  const relues = items.length - nonRelues.length;
  const unseen = items.filter((it) => !it.seen).length;
  const lot = nonRelues.length ? `<p class="notes-periode-batch"><button type="button" class="btn btn-sm" id="periodeReviewBatch" data-ids="${nonRelues.map((it) => PERIODE.mrs.get(it.mr_id).id).join(',')}">${svgIco('play')}${esc(tr('notes.periode.btn.review-batch', { n: nonRelues.length, count: nonRelues.length }))}</button></p>` : '';
  return pSectionHtml('merged', items, items.map((it) => pLigneMr(it, 'mr_merged')).join(''), {
    icon: 'merge', hint: tr('notes.periode.sec.merged.hint', { unseen, reviewed: relues }), avant: lot,
  });
}
function sectionMrs(cle, items, opts) {
  const kind = { new: 'mr_new', closed: 'mr_closed', active: 'mr_active' }[cle];
  return pSectionHtml(cle, items, items.map((it) => pLigneMr(it, kind)).join(''), opts);
}

/* 3. Tags et branches supprimées : informatif, en pied. */
function sectionTags(items) {
  const corps = items.map((it) => (it.kind === 'pipeline' ? pLignePipeline(it) : `<div class="notes-periode-item ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
    <div class="notes-periode-main"><div class="notes-periode-title">${svgIco(it.kind === 'tag' ? 'tag' : 'branch')} ${esc(pProjetDe(PERIODE.data, it.repo_id))} · ${it.kind === 'tag'
    ? `${esc(tr('notes.periode.tag.at', { name: it.ref, when: '' }))}${pQuand(it.at)}`
    : esc(tr('notes.periode.branch-gone', { name: it.ref, iid: (it.extra || {}).iid || '' }))}</div>
    ${it.title && it.kind === 'tag' ? `<div class="meta">${esc(it.title)}</div>` : ''}</div>
    <div class="notes-periode-actions">${pVuBtn(it)}</div>
  </div>`)).join('');
  // Un pipeline rouge n'est pas un pied de page qu'on replie : la section s'ouvre dès qu'il y en a un.
  return pSectionHtml('tags', items, corps, { icon: 'tag', replie: !items.some((it) => it.kind === 'pipeline') });
}

/* 4. Ce que l'équipe a fait dans Mergerie (base partagée). */
function sectionEquipe(items) {
  const corps = items.map((it) => {
    const x = it.extra || {};
    let titre = ''; let meta = ''; let action = '';
    if (x.objet === 'review') {
      titre = tr('notes.periode.team.review', { iid: x.iid, author: it.author || '' });
      meta = [x.note != null ? tr('notes.periode.team.review.note', { note: fmtNote10(Number(x.note) * 10) }) : '',
        x.mergee ? tr('notes.periode.team.review.merged') : tr('notes.periode.team.review.open'),
        x.a_bouge ? tr('notes.periode.team.review.moved') : ''].filter(Boolean).join(' · ');
      action = `<button type="button" class="btn btn-sm btn-primary" data-pmrreport="${it.mr_id}">${esc(tr('notes.periode.btn.report'))}</button>`
        + (x.a_bouge && !x.mergee ? `<button type="button" class="btn btn-sm" data-pmrreview="${it.mr_id}" data-iid="${esc(x.iid)}" data-inc="1">${esc(tr('notes.periode.btn.rereview'))}</button>` : '');
    } else if (x.objet === 'task') {
      titre = tr('notes.periode.team.task', { title: it.title || '', author: it.author || '' });
      meta = (x.iids || []).map((i) => `!${i}`).join(', ');
      action = `<button type="button" class="btn btn-sm" data-psession="${x.task_id}" data-kind="${esc(x.task_kind || 'code')}">${esc(tr('notes.periode.btn.open-mr'))}</button>`;
    } else if (x.objet === 'todo') {
      titre = tr('notes.periode.team.todo', { title: it.title || '', author: it.author || '' });
      meta = x.status || '';
      action = `<button type="button" class="btn btn-sm" data-ptodo="1">${esc(tr('notes.periode.btn.open-mr'))}</button>`;
    } else if (x.objet === 'page') {
      titre = tr('notes.periode.team.page', { title: it.title || '', author: it.author || '' });
      action = `<button type="button" class="btn btn-sm" data-ppage="${x.page_id}">${esc(tr('notes.periode.btn.open-mr'))}</button>`;
    }
    const arrive = x.arrive ? `<span class="tag" title="${esc(tr('notes.periode.team.arrived-title'))}">${svgIco('refresh')} ${esc(tr('notes.periode.team.arrived', { when: '' }))}${pQuand(x.arrive)}</span>` : '';
    return `<div class="notes-periode-item ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
      <div class="notes-periode-main"><div class="notes-periode-title">${esc(titre)}</div><div class="meta">${esc(meta)}${meta ? ' · ' : ''}${pQuand(it.at)} ${arrive}</div></div>
      <div class="notes-periode-actions">${action}${pVuBtn(it)}</div>
    </div>`;
  }).join('');
  return pSectionHtml('team', items, corps, { icon: 'users', hint: tr('notes.periode.sec.team.hint') });
}

/* ---------- Les gestes ---------- */

const pItemDe = (d, id) => d.items.find((it) => it.id === Number(id));
const pTexteCommits = (x) => (x.commits || []).map((c) => `- ${String(c.sha || '').slice(0, 8)} ${c.title || ''}`).join('\n');

function brancherGestesPeriode(d) {
  const corps = $('#periodeCorps');
  // Vu / pas vu : on écrit, puis la ligne se grise ou disparaît selon le filtre.
  $$('[data-pseen]', corps).forEach((cb) => cb.addEventListener('change', async () => {
    try {
      const r = await api(`/periode/${d.id}/seen`, { method: 'POST', body: { item_ids: [Number(cb.dataset.pseen)], seen: cb.checked } });
      const it = pItemDe(d, cb.dataset.pseen);
      if (it) { it.seen = cb.checked; it.seen_at = cb.checked ? new Date().toISOString() : null; }
      d.unseen = r.unseen; majBadgePeriode(r.unseen);
      renderPeriodeCorps(d);
    } catch (err) { cb.checked = !cb.checked; toast(explainError(err.message), true); }
  }));
  // Le diff d'un push : deux SHA, dans une modale.
  $$('[data-pdiff]', corps).forEach((b) => b.addEventListener('click', () => busy(b, () => ouvrirDiffPush(d, pItemDe(d, b.dataset.pdiff)))));
  // Relire un push : une session d'exploration pré-remplie, rien n'est lancé sans le clic suivant.
  $$('[data-pexplore]', corps).forEach((b) => b.addEventListener('click', () => busy(b, () => sessionPourPush(d, pItemDe(d, b.dataset.pexplore), 'explore'))));
  $$('[data-pfix]', corps).forEach((b) => b.addEventListener('click', () => busy(b, () => sessionPourPush(d, pItemDe(d, b.dataset.pfix), 'code'))));
  $$('[data-pverify]', corps).forEach((b) => b.addEventListener('click', () => ouvrirVerifBranche().catch((e) => toast(explainError(e.message), true))));
  // Les merge requests : diff, rapport, review a posteriori.
  $$('[data-pmrdiff]', corps).forEach((b) => b.addEventListener('click', () => {
    const m = PERIODE.mrs.get(Number(b.dataset.pmrdiff));
    if (m) busy(b, () => openDiffPreview(m));
  }));
  $$('[data-pmrreport]', corps).forEach((b) => b.addEventListener('click', () => navMrReport(Number(b.dataset.pmrreport))));
  $$('[data-pmrreview]', corps).forEach((b) => b.addEventListener('click', async () => {
    try {
      const body = b.dataset.inc ? { incremental: true } : {};
      await busy(b, () => api(`/mrs/${b.dataset.pmrreview}/review`, { method: 'POST', body }));
      toast(tr('toast.review-de-lancee', { iid: b.dataset.iid })); refreshStatus();
    } catch (err) { toast(explainError(err.message), true); }
  }));
  const lot = $('#periodeReviewBatch');
  if (lot) lot.addEventListener('click', async () => {
    const ids = lot.dataset.ids.split(',').map(Number).filter(Boolean);
    try {
      await busy(lot, async () => { for (const id of ids) await api(`/mrs/${id}/review`, { method: 'POST' }); });
      toast(tr('toast.periode-reviews-lancees', { n: ids.length, count: ids.length })); refreshStatus();
    } catch (err) { toast(explainError(err.message), true); }
  });
  // L'équipe : la session, la page, la todo, là où elles vivent.
  $$('[data-psession]', corps).forEach((b) => b.addEventListener('click', () => ouvrirSession(Number(b.dataset.psession), b.dataset.kind || 'code')));
  $$('[data-ppage]', corps).forEach((b) => b.addEventListener('click', () => { showNotesSub('pages'); openNotePage(Number(b.dataset.ppage)); }));
  $$('[data-ptodo]', corps).forEach((b) => b.addEventListener('click', () => showNotesSub('todos')));
  brancherGestesPied(corps);
}

/* « Voir le diff » d'un push : le viewer plein écran des MR et des sessions — l'arborescence
   complète du commit, le fichier entier avec ses changements en place, la navigation — et non
   un diff brut dans une modale. Seule la base d'URL change ; le panneau de gauche rappelle
   ce que le push a apporté (auteur, commits), faute de rapport ou de retour d'IA à montrer. */
async function ouvrirDiffPush(d, it) {
  if (!it) return;
  const base = `/periode/${d.id}/items/${it.id}`;
  let dv;
  try { dv = await api(`${base}/diffview`); } catch (err) { toast(explainError(err.message), true); return; }
  const x = it.extra || {};
  split = {
    mrId: null, base, session: true,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('session-mode');
  $('#splitTitle').textContent = `${pProjetDe(d, it.repo_id)} · ${x.branche || ''} · ${String(dv.base || '').slice(0, 8)}..${String(dv.head || '').slice(0, 8)}`;
  const commits = (x.commits || []).map((c) => `<li><code>${esc(String(c.sha || '').slice(0, 8))}</code> <span>${esc(c.title || '')}</span></li>`).join('');
  const n = (x.commits || []).length;
  $('#splitMd').innerHTML = `<p class="muted">${esc(tr('notes.periode.push.by', { author: it.author || '', when: fmtDate(it.at) }))} · ${esc(tr('notes.periode.push.commits', { n, count: n }))}</p>
    <ul class="notes-periode-commits">${commits}</ul>`;
  renderTree();
  $('#splitView').hidden = false;
  const premier = split.files.find((f) => f.changed) || split.files[0];
  if (premier) selectFile(premier.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}

/* La session pré-remplie pour un push : exploration (relire) ou codage (corriger). On ouvre la
   modale de session comme « Nouvelle session » le ferait, puis on pose le dépôt, la branche et
   la consigne — pré-rempli, pas verrouillé. */
async function sessionPourPush(d, it, kind) {
  if (!it) return;
  const x = it.extra || {};
  const vars = {
    branch: x.branche || '', project: pProjetDe(d, it.repo_id), author: it.author || '',
    when: fmtDate(it.at), base: String(x.base_sha || '').slice(0, 12), head: String(x.head_sha || '').slice(0, 12), commits: pTexteCommits(x),
  };
  try {
    await openTaskModal(kind);
    renderTargetRows(kind === 'explore'
      ? [{ repo_id: it.repo_id, branch: x.branche || '' }]
      : [{ repo_id: it.repo_id, branch: '', base_branch: x.branche || '' }]);
    const f = $('#taskForm');
    f.prompt.value = tr(kind === 'explore' ? 'notes.periode.explore.prompt' : 'notes.periode.fix.prompt', vars);
    $('#taskModalTitle').textContent = tr(kind === 'explore' ? 'notes.periode.explore.title' : 'notes.periode.fix.title', vars);
    f.prompt.focus();
  } catch (err) { toast(tr('toast.ouverture-impossible', { message: err.message }), true); }
}
