'use strict';
/* Jira → Stats : les comptes d'un ensemble de tickets (bugs, US, US liées à un bug, par statut), avec ses propres filtres. */
/* ============ Jira → Stats ============
   Les MÊMES filtres que « Mes tickets » — assignés, statuts, sprints, filtres de champ, terminés —
   mais À PART : ce qu'on coche ici ne touche pas la liste, et inversement (au premier passage,
   l'écran hérite des choix de la liste, puis chacun vit sa vie). Les comptes viennent du serveur,
   sur l'ensemble ENTIER — il pagine la recherche jusqu'à un plafond, et le dit s'il l'atteint —
   là où la liste s'arrête à cent tickets : une statistique sur un extrait trié par date de mise
   à jour ne dirait rien du backlog. Les valeurs proposées par les filtres, elles, viennent d'un
   échantillon (la même requête que la liste) : proposer une valeur qui ne compte rien n'aide pas. */
const JSTATS = { me: null, people: [], echantillon: [], connus: {}, seq: 0 };
const JSTATS_CLES = {
  assignees: 'aidevtools_jira_stats_assignees', hidden: 'aidevtools_jira_stats_status_hidden',
  sprints: 'aidevtools_jira_stats_sprints', filtres: 'aidevtools_jira_stats_filtres', done: 'aidevtools_jira_stats_done',
  dates: 'aidevtools_jira_stats_dates',   // la plage de mouvement — propre aux stats, la liste n'en a pas
};
// Les clés de « Mes tickets », d'où l'on hérite une seule fois.
const JSTATS_ORIGINE = {
  assignees: 'aidevtools_jira_assignees', hidden: 'aidevtools_jira_status_hidden',
  sprints: JIRA_SPRINT_KEY, filtres: JIRA_FF_KEY, done: 'aidevtools_jira_done',
};
function jsLire(cle, defaut) { try { const v = localStorage.getItem(JSTATS_CLES[cle]); return v == null ? defaut : JSON.parse(v); } catch { return defaut; } }
function jsEcrire(cle, v) { try { localStorage.setItem(JSTATS_CLES[cle], JSON.stringify(v)); } catch { /* stockage indisponible */ } }
function jsHeriter() {
  try {
    if (Object.values(JSTATS_ORIGINE).map((_, i) => Object.values(JSTATS_CLES)[i]).some((k) => localStorage.getItem(k) != null)) return;
    for (const [cle, src] of Object.entries(JSTATS_ORIGINE)) {
      const v = localStorage.getItem(src);
      if (v == null) continue;
      localStorage.setItem(JSTATS_CLES[cle], cle === 'done' ? JSON.stringify(v === '1') : v);   // la liste range « terminés » en '1'/'0'
    }
  } catch { /* stockage indisponible */ }
}
function jsCoches() {
  const v = jsLire('assignees', null);
  if (Array.isArray(v)) return new Set(v);
  return new Set(JSTATS.me && JSTATS.me.accountId ? [JSTATS.me.accountId] : []);   // défaut : moi seul
}
const jsMasques = () => new Set(Array.isArray(jsLire('hidden', [])) ? jsLire('hidden', []) : []);
const jsSprints = () => (Array.isArray(jsLire('sprints', [])) ? jsLire('sprints', []).map(String) : []);
const JOUR_ISO = /^\d{4}-\d{2}-\d{2}$/;
function jsDates() {
  const v = jsLire('dates', {}) || {};
  return { depuis: JOUR_ISO.test(v.depuis || '') ? v.depuis : '', jusqua: JOUR_ISO.test(v.jusqua || '') ? v.jusqua : '' };
}
function jsPoserDates() {
  const d = jsDates();
  $('#jiraStatsDepuis').value = d.depuis; $('#jiraStatsJusqua').value = d.jusqua;
  $('#jiraStatsDatesClear').hidden = !d.depuis && !d.jusqua;
}
function jsFiltres() {
  const v = jsLire('filtres', {});
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  if (Array.isArray(v.project)) v.project = v.project.map((x) => String(x).split(' — ')[0]);   // ancienne forme « CLÉ — Nom »
  return v;
}
function jsMemorise(cle, vues) {
  const memo = new Map((JSTATS.connus[cle] || []).map((x) => [x.v, x]));
  for (const x of vues) memo.set(x.v, { ...x, n: undefined });
  JSTATS.connus[cle] = [...memo.values()];
}
function jsUnion(cle, vues) {
  const par = new Map((JSTATS.connus[cle] || []).map((x) => [x.v, { ...x, n: 0 }]));
  for (const x of vues) par.set(x.v, x);
  return [...par.values()];
}
function jsValeursDe(cle) {
  const ch = JIRA_CHAMPS.find((c) => c.cle === cle); if (!ch) return [];
  const par = new Map();
  for (const it of JSTATS.echantillon) for (const { v, l } of ch.vals(it)) { const e = par.get(v) || { v, l, n: 0 }; e.n += 1; par.set(v, e); }
  return jsUnion(cle, [...par.values()]).sort((a, b) => a.l.localeCompare(b.l, undefined, { numeric: true }));
}

/* ---------- Chargement : les personnes, l'échantillon, puis les comptes ---------- */
async function chargerJiraStats() {
  const corps = $('#jiraStatsCorps'); const err = $('#jiraStatsError'); if (!corps) return;
  err.innerHTML = ''; corps.innerHTML = skeleton(3);
  jsHeriter();
  $('#jiraStatsIncludeDone').checked = !!jsLire('done', false);
  jsPoserDates();
  const seq = ++JSTATS.seq;
  if (!JSTATS.people.length) {
    let a;
    try { a = await api('/jira/assignees'); } catch (e) { corps.innerHTML = ''; err.innerHTML = errorBox(explainError(e.message)); return; }
    if (seq !== JSTATS.seq) return;
    if (!a.configured) {
      $$('#jiraSubStats .jira-status-filter').forEach((d) => { d.hidden = true; });
      corps.innerHTML = emptyState({ icon: 'tag', title: tr('jira.not-configured.title'), text: tr('jira.not-configured'),
        actions: [{ act: 'go-jira-config', label: tr('jira.not-configured.cta'), primary: true }] });
      return;
    }
    JSTATS.me = a.me; JSTATS.people = a.people || [];
  }
  jsRenderAssignees();
  await jsEchantillon();
  if (seq !== JSTATS.seq) return;
  jsRenderStatuts(); jsRenderSprints(); jsRenderChamps();
  await jsCompter(seq);
}
// La même requête que la liste, pour les VALEURS des filtres (sprints, statuts, champs), sans les
// contraintes qui réduiraient ces valeurs à ce qui est déjà coché.
async function jsEchantillon() {
  const projects = (jsFiltres().project || []).join(',');
  const assignees = [...jsCoches()].join(',');
  const done = $('#jiraStatsIncludeDone').checked ? 1 : 0;
  try {
    const d = await api(`/jira/tickets?assignees=${encodeURIComponent(assignees)}&includeDone=${done}&projects=${encodeURIComponent(projects)}`);
    JSTATS.echantillon = d.issues || [];
  } catch { JSTATS.echantillon = []; }
  jsMemorise('sprint', JSTATS.echantillon.flatMap((i) => i.sprints || []));
  jsMemorise('status', JSTATS.echantillon.filter((i) => i.status).map((i) => ({ v: i.status, l: i.status, cat: i.statusCategory })));
  if (!projects) jsMemorise('project', JSTATS.echantillon.filter((i) => i.projectKey).map((i) => ({ v: i.projectKey, l: i.project || i.projectKey })));
  // Les statuts du workflow, en plus de ceux portés par l'échantillon : un statut vide reste filtrable.
  const cles = [...new Set(projects ? projects.split(',') : JSTATS.echantillon.map((i) => i.projectKey).filter(Boolean))].sort().join(',');
  if (cles) {
    try {
      const d = await api(`/jira/statuses?projects=${encodeURIComponent(cles)}`);
      jsMemorise('status', (d.statuses || []).map((st) => ({ v: st.name, l: st.name, cat: st.cat })));
    } catch { /* filtre : jamais bloquant */ }
  }
}
async function jsCompter(seq = JSTATS.seq) {
  const corps = $('#jiraStatsCorps'); const err = $('#jiraStatsError');
  const done = $('#jiraStatsIncludeDone').checked ? 1 : 0;
  const f = jsFiltres(); const dates = jsDates();
  const q = `assignees=${encodeURIComponent([...jsCoches()].join(','))}&includeDone=${done}`
    + `&depuis=${encodeURIComponent(dates.depuis)}&jusqua=${encodeURIComponent(dates.jusqua)}`
    + `&projects=${encodeURIComponent((f.project || []).join(','))}&sprints=${encodeURIComponent(jsSprints().join(','))}`
    + `&hideStatuses=${encodeURIComponent([...jsMasques()].join('\u001f'))}&filtres=${encodeURIComponent(JSON.stringify(f))}`;
  let d;
  try { d = await api(`/jira/stats?${q}`); }
  catch (e) { if (seq !== JSTATS.seq) return; corps.innerHTML = ''; err.innerHTML = errorBox(explainError(e.message)); return; }
  if (seq !== JSTATS.seq) return;
  jsRendre(d);
}

/* ---------- Le rendu des comptes ---------- */
function jsRendre(d) {
  const corps = $('#jiraStatsCorps');
  const pct = (n, t) => (t ? `${Math.round((n / t) * 1000) / 10} %` : '—');
  const tuile = (cls, val, lbl, sous = '', cle = '') => `<div class="stat-tile ${cls}" data-stats="${cle}"><div class="stat-val">${esc(String(val))}</div><div class="stat-lbl">${esc(lbl)}</div>${sous ? `<div class="jira-stats-sous muted">${esc(sous)}</div>` : ''}</div>`;
  const dates = jsDates();
  const plage = (dates.depuis || dates.jusqua) ? ` · ${tr('jira.stats.dates.scope', { from: dates.depuis ? fmtDate(dates.depuis) : '…', to: dates.jusqua ? fmtDate(dates.jusqua) : '…' })}` : '';
  $('#jiraStatsInfo').textContent = tr('jira.stats.scope', { n: d.lus, count: d.lus }) + plage;
  if (!d.total) { corps.innerHTML = `<p class="muted jira-empty">${esc(tr('jira.stats.empty'))}</p>`; return; }
  const notes = [];
  if (d.tronque) notes.push(`<p class="jira-stats-note warn">${esc(d.total != null && d.total > d.lus ? tr('jira.stats.truncated', { max: d.plafond, total: d.total }) : tr('jira.stats.truncated-nototal', { max: d.plafond }))}</p>`);
  for (const ig of (d.ignores || [])) notes.push(`<p class="jira-stats-note warn">${esc(tr('jira.stats.ignored', { field: tr(`jira.meta.${ig.champ}`), value: ig.valeur }))}</p>`);
  corps.innerHTML = `${notes.join('')}
    <div class="stat-row jira-stats-tuiles" data-stats-total="${d.total}">
      ${tuile('', d.total, tr('jira.stats.total'), '', 'total')}
      ${tuile('amber', d.bugs, tr('jira.stats.bugs'), pct(d.bugs, d.total), 'bugs')}
      ${tuile('accent', d.us, tr('jira.stats.us'), pct(d.us, d.total), 'us')}
      ${tuile('green', d.usLieesBug, tr('jira.stats.us-linked'), tr('jira.stats.of-us', { pct: pct(d.usLieesBug, d.us) }), 'us-linked')}
      ${d.autres ? tuile('', d.autres, tr('jira.stats.others'), pct(d.autres, d.total), 'others') : ''}
    </div>
    <h3 class="jira-stats-h">${esc(tr('jira.stats.by-status'))}</h3>
    <table class="jira-stats-table">
      <thead><tr><th>${esc(tr('jira.stats.col.status'))}</th><th class="num">${esc(tr('jira.stats.col.n'))}</th><th class="num">${esc(tr('jira.stats.col.pct'))}</th><th class="bar"></th></tr></thead>
      <tbody>${(d.statuts || []).map((s) => `<tr data-stats-status="${esc(s.name)}">
          <td><span class="jira-status jira-status-${JIRA_CAT[s.cat] || 'todo'}">${esc(s.name)}</span></td>
          <td class="num">${s.n}</td><td class="num">${esc(String(s.pct))} %</td>
          <td class="bar"><div class="jira-stats-bar"><div class="jira-stats-bar-fill jira-stats-bar-${JIRA_CAT[s.cat] || 'todo'}" style="width:${Math.max(0, Math.min(100, s.pct))}%"></div></div></td>
        </tr>`).join('')}</tbody>
    </table>
    <h3 class="jira-stats-h">${esc(tr('jira.stats.by-assignee'))}</h3>
    <table class="jira-stats-table">
      <thead><tr><th>${esc(tr('jira.stats.col.assignee'))}</th><th class="num">${esc(tr('jira.stats.col.n'))}</th><th class="num">${esc(tr('jira.stats.col.pct'))}</th><th class="bar"></th></tr></thead>
      <tbody>${(d.assignes || []).map((a) => `<tr data-stats-assignee="${esc(a.accountId)}">
          <td>${a.accountId ? `<span class="jira-avatar jira-avatar-sm" aria-hidden="true">${esc(jiraInitials(a.name))}</span> ${esc(a.name)}${JSTATS.me && a.accountId === JSTATS.me.accountId ? ` <span class="muted">(${esc(tr('jira.me'))})</span>` : ''}` : `<span class="muted">${esc(tr('jira.stats.unassigned'))}</span>`}</td>
          <td class="num">${a.n}</td><td class="num">${esc(String(a.pct))} %</td>
          <td class="bar"><div class="jira-stats-bar"><div class="jira-stats-bar-fill jira-stats-bar-progress" style="width:${Math.max(0, Math.min(100, a.pct))}%"></div></div></td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="muted jira-stats-types">${esc(tr('jira.stats.types-hint', { bug: (d.types && d.types.bug) || '', us: (d.types && d.types.us) || '' }))}</p>`;
}

/* ---------- Les quatre panneaux de filtres ---------- */
function jsRenderAssignees() {
  const det = $('#jiraStatsAssigneeFilter'); const body = $('#jiraStatsAssigneeFilterBody');
  if (!JSTATS.people.length) { det.hidden = true; return; }
  det.hidden = false;
  const coches = jsCoches();
  body.innerHTML = JSTATS.people.map((p) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(p.accountId)}"${coches.has(p.accountId) ? ' checked' : ''} />
      <span class="jira-avatar jira-avatar-sm" aria-hidden="true">${esc(jiraInitials(p.name))}</span>
      <span>${esc(p.name)}${JSTATS.me && p.accountId === JSTATS.me.accountId ? ` <span class="muted">(${esc(tr('jira.me'))})</span>` : ''}</span></label>`).join('');
  $('#jiraStatsAssigneeFilterCount').textContent = tr('jira.status-filter-count', { shown: coches.size, total: JSTATS.people.length });
  jsRecherche('assignee');
}
function jsRenderStatuts() {
  const det = $('#jiraStatsStatusFilter'); const body = $('#jiraStatsStatusFilterBody');
  const statuts = jsUnion('status', []);
  if (statuts.length <= 1) { det.hidden = true; return; }
  det.hidden = false;
  const masques = jsMasques();
  body.innerHTML = statuts.map((s) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(s.v)}"${masques.has(s.v) ? '' : ' checked'} />
      <span class="jira-status jira-status-${JIRA_CAT[s.cat] || 'todo'}">${esc(s.l)}</span></label>`).join('');
  $('#jiraStatsStatusFilterCount').textContent = tr('jira.status-filter-count', { shown: statuts.filter((s) => !masques.has(s.v)).length, total: statuts.length });
  jsRecherche('status');
}
function jsRenderSprints() {
  const det = $('#jiraStatsSprintFilter'); const body = $('#jiraStatsSprintFilterBody');
  const choisis = jsSprints();
  // Le sprint EN COURS d'abord, puis les plus récents par date, puis par identifiant (croît avec le temps).
  const vals = jsUnion('sprint', []).sort((a, b) => {
    const enCours = (x) => (x.etat === 'active' ? 0 : 1);
    if (enCours(a) !== enCours(b)) return enCours(a) - enCours(b);
    if (a.d && b.d && a.d !== b.d) return a.d < b.d ? 1 : -1;
    if (a.d && !b.d) return -1;
    if (!a.d && b.d) return 1;
    return Number(b.v) - Number(a.v);
  });
  det.hidden = !vals.length && !choisis.length;
  if (det.hidden) return;
  body.innerHTML = vals.map((x) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(x.v)}"${choisis.includes(String(x.v)) ? ' checked' : ''} />
      <span>${esc(x.l)}</span>${x.etat === 'active' ? ` <span class="muted">${esc(tr('jira.sprint-active'))}</span>` : ''}</label>`).join('');
  $('#jiraStatsSprintFilterCount').textContent = choisis.length ? tr('jira.ff.picked', { n: choisis.length, total: vals.length }) : '';
  jsRecherche('sprint');
}
function jsCompteChamps() {
  const f = jsFiltres();
  const nb = Object.keys(f).filter((k) => JIRA_CHAMPS.some((c) => c.cle === k)).reduce((n, k) => n + (f[k] || []).length, 0);
  $('#jiraStatsFieldFilterCount').textContent = nb ? tr('jira.ff.count', { n: nb, count: nb }) : '';
}
function jsRenderChamps() {
  const det = $('#jiraStatsFieldFilter'); const body = $('#jiraStatsFieldFilterBody'); const pick = $('#jiraStatsFieldFilterPick');
  const f = jsFiltres();
  const actifs = Object.keys(f).filter((k) => JIRA_CHAMPS.some((c) => c.cle === k));
  const dispo = JIRA_CHAMPS.filter((c) => jsValeursDe(c.cle).length > 0 || actifs.includes(c.cle));
  det.hidden = !dispo.length;
  if (det.hidden) return;
  jsCompteChamps();
  pick.innerHTML = comboHtml('js-champ', { ph: tr('jira.ff.add') });
  wireCombo(pick, 'js-champ', () => dispo.filter((c) => !actifs.includes(c.cle))
    .map((c) => ({ value: c.cle, label: tr(c.i18n), hint: String(jsValeursDe(c.cle).length) })));
  body.innerHTML = actifs.map((cle) => {
    const ch = JIRA_CHAMPS.find((c) => c.cle === cle);
    const choisies = f[cle] || [];
    // Une valeur cochée reste proposée même absente de l'échantillon : sinon on ne pourrait plus la retirer.
    const vals = jsUnion(cle, jsValeursDe(cle).concat(choisies.filter((v) => !jsValeursDe(cle).some((x) => x.v === v)).map((v) => ({ v, l: v, n: 0 }))));
    return `<div class="jira-ff-crit" data-jscrit="${esc(cle)}">
      <div class="jira-ff-head">
        <b>${esc(tr(ch.i18n))}</b>
        <span class="muted" data-jspicked>${esc(tr('jira.ff.picked', { n: choisies.length, total: vals.length }))}</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-icon btn-sm" data-jsdel="${esc(cle)}" title="${esc(tr('jira.ff.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
      <input type="search" class="jira-sf-search" data-jssearch="${esc(cle)}" placeholder="${esc(tr('jira.ff.search'))}" />
      <div class="jira-status-filter-body">
        ${vals.map((x) => `<label class="jira-sf-item" data-jsrow="${esc(String(x.l).toLowerCase())}">
          <input type="checkbox" data-jsval="${esc(cle)}" value="${esc(x.v)}"${choisies.includes(x.v) ? ' checked' : ''} />
          <span>${esc(x.l)}</span>${x.n ? ` <span class="muted">${x.n}</span>` : ''}</label>`).join('')}
      </div>
    </div>`;
  }).join('');
}
/* La recherche MASQUE les lignes sans rien décocher — la règle de tous les filtres à cases. */
function jsRecherche(quel) {
  const champ = $(`#jiraSubStats [data-jss="${quel}"]`); if (!champ) return;
  const q = (champ.value || '').toLowerCase().trim();
  const body = { assignee: '#jiraStatsAssigneeFilterBody', status: '#jiraStatsStatusFilterBody', sprint: '#jiraStatsSprintFilterBody' }[quel];
  $$(`${body} .jira-sf-item`).forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
}

/* ---------- Les gestes ---------- */
$('#jiraSubStats') && (() => {
  $('#jiraStatsRefresh').addEventListener('click', () => { JSTATS.people = []; chargerJiraStats(); });
  $('#jiraStatsIncludeDone').addEventListener('change', (e) => { jsEcrire('done', e.target.checked); chargerJiraStats(); });
  // La plage ne change que les comptes, pas les valeurs proposées par les filtres : on recompte seulement.
  const recompter = () => { $('#jiraStatsCorps').innerHTML = skeleton(3); jsCompter(++JSTATS.seq); };
  for (const id of ['jiraStatsDepuis', 'jiraStatsJusqua']) {
    $(`#${id}`).addEventListener('change', () => {
      jsEcrire('dates', { depuis: $('#jiraStatsDepuis').value || '', jusqua: $('#jiraStatsJusqua').value || '' });
      jsPoserDates(); recompter();
    });
  }
  $('#jiraStatsDatesClear').addEventListener('click', () => { jsEcrire('dates', {}); jsPoserDates(); recompter(); });
  $$('#jiraSubStats [data-jss]').forEach((i) => i.addEventListener('input', () => jsRecherche(i.dataset.jss)));
  $('#jiraStatsAssigneeFilterBody').addEventListener('change', () => {
    jsEcrire('assignees', $$('#jiraStatsAssigneeFilterBody input:checked').map((c) => c.value));
    chargerJiraStats();
  });
  $('#jiraStatsStatusFilterBody').addEventListener('change', () => {
    jsEcrire('hidden', $$('#jiraStatsStatusFilterBody input:not(:checked)').map((c) => c.value));
    chargerJiraStats();
  });
  $('#jiraStatsSprintFilterBody').addEventListener('change', () => {
    jsEcrire('sprints', $$('#jiraStatsSprintFilterBody input:checked').map((c) => c.value));
    chargerJiraStats();
  });
  $$('#jiraSubStats [data-jsall]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.jsall === 'assignee') jsEcrire('assignees', JSTATS.people.map((p) => p.accountId));
    else jsEcrire('hidden', []);
    chargerJiraStats();
  }));
  $$('#jiraSubStats [data-jsnone]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.jsnone === 'assignee') jsEcrire('assignees', []);
    else if (b.dataset.jsnone === 'status') jsEcrire('hidden', jsUnion('status', []).map((s) => s.v));
    else jsEcrire('sprints', []);
    chargerJiraStats();
  }));
  // Ajout d'un critère : le combo signale son choix par un `change` sur son input caché.
  $('#jiraStatsFieldFilterPick').addEventListener('change', (e) => {
    const h = e.target.closest('.js-champ'); if (!h || !h.value) return;
    const f = jsFiltres(); if (!f[h.value]) f[h.value] = [];
    jsEcrire('filtres', f);
    jsRenderChamps();
  });
  $('#jiraStatsFieldFilterBody').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-jsval]'); if (!cb) return;
    const f = jsFiltres(); const cle = cb.dataset.jsval;
    const set = new Set(f[cle] || []);
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    f[cle] = [...set];
    jsEcrire('filtres', f);
    if (cle === 'project') { chargerJiraStats(); return; }   // le projet change l'échantillon, pas seulement le compte
    // On ne redessine PAS le critère : cela replierait la recherche en cours et ferait sauter le focus.
    const tete = cb.closest('.jira-ff-crit').querySelector('[data-jspicked]');
    if (tete) tete.textContent = tr('jira.ff.picked', { n: f[cle].length, total: $$('[data-jsval]', cb.closest('.jira-ff-crit')).length });
    jsCompteChamps();
    $('#jiraStatsCorps').innerHTML = skeleton(3);
    jsCompter(++JSTATS.seq);
  });
  $('#jiraStatsFieldFilterBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jsdel]'); if (!b) return;
    const f = jsFiltres(); const avaitProjet = b.dataset.jsdel === 'project' && (f.project || []).length;
    delete f[b.dataset.jsdel];
    jsEcrire('filtres', f);
    if (avaitProjet) { chargerJiraStats(); return; }
    jsRenderChamps();
    $('#jiraStatsCorps').innerHTML = skeleton(3);
    jsCompter(++JSTATS.seq);
  });
  $('#jiraStatsFieldFilterBody').addEventListener('input', (e) => {
    const s = e.target.closest('[data-jssearch]'); if (!s) return;
    const q = (s.value || '').toLowerCase().trim();
    for (const row of $$('[data-jsrow]', s.closest('.jira-ff-crit'))) row.hidden = !!q && !row.dataset.jsrow.includes(q);
  });
})();
