'use strict';
/* Jira : les tickets ANALYSÉS (leur précision technique) — l'onglet « Analysés » et le filtre de « Mes tickets ».
   Un ticket analysé est un ticket dont la précision technique existe : lancée, proposée, éditée ou postée. La liste vient du serveur
   (`/jira/specs/all`, sans appel à Jira : le titre est celui de la photo prise à l'analyse). `JIRA.analyses` en garde la table par clé,
   que le filtre de « Mes tickets » lit sans rien redemander à chaque frappe. */
const JIRA_ANA = { rows: [], selectedKey: null };
const JIRA_SPECFILTRE_CLE = 'aidevtools_jira_specfilter';
function jiraSpecFiltre() { try { const v = localStorage.getItem(JIRA_SPECFILTRE_CLE); return ['done', 'todo'].includes(v) ? v : 'all'; } catch { return 'all'; } }

/** Le filtre « Analyse » de « Mes tickets » : `done` = déjà analysés (une proposition existe), `todo` = les autres. */
function jiraPasseFiltreAnalyse(it) {
  const f = jiraSpecFiltre();
  if (f === 'all') return true;
  const analyse = !!(JIRA.analyses && JIRA.analyses[it.key] && JIRA.analyses[it.key].analysed);
  return f === 'done' ? analyse : !analyse;
}

const jiraAnaDepots = (r) => (r.repos || []).map((d) => `${d.project}${d.branch ? `@${d.branch}` : ''}`).join(', ');

function renderJiraAnalysed() {
  const box = $('#jiraAnaList'); if (!box) return;
  const q = (($('#jiraAnaSearch') || {}).value || '').toLowerCase().trim();
  const rows = JIRA_ANA.rows.filter((r) => !q || `${r.key} ${r.summary} ${jiraAnaDepots(r)}`.toLowerCase().includes(q));
  const analyses = JIRA_ANA.rows.filter((r) => r.analysed).length;
  const pastille = $('#jiraAnalysedCount'); if (pastille) { pastille.textContent = analyses; pastille.hidden = !analyses; }
  const info = $('#jiraAnaInfo'); if (info) info.textContent = tr('jira.count', { n: rows.length, count: rows.length });
  if (!JIRA_ANA.rows.length) { box.innerHTML = emptyState({ icon: 'search', title: tr('jira.ana.empty.title'), text: tr('jira.ana.empty.text') }); return; }
  if (!rows.length) { box.innerHTML = `<p class="muted jira-empty">${esc(tr('jira.no-match'))}</p>`; return; }
  box.innerHTML = rows.map((r) => {
    const etat = r.stale ? 'stale' : r.status;
    const lus = (r.repos || []).map((d) => `${esc(d.project)} <code>${esc(d.branch || tr('jira.ana.default-branch'))}</code>`).join(' · ');
    return `<button class="jira-item${r.key === JIRA_ANA.selectedKey ? ' active' : ''}" data-jiraanaopen="${esc(r.key)}">
      <div class="jira-item-row1"><code class="jira-key">${esc(r.key)}</code>
        <span class="jira-spec-chip is-${esc(etat)}">${esc(tr('jira.spec.badge', { status: tr(`jira.spec.status.${etat}`) }))}</span>
        ${r.version ? `<span class="jira-chip">${esc(tr('jira.spec.version', { n: r.version }))}</span>` : ''}
        ${r.unposted && r.version ? `<span class="jira-chip jira-spec-unposted">${esc(tr('jira.spec.unposted'))}</span>` : ''}</div>
      <div class="jira-item-summary">${esc(r.summary || '')}</div>
      ${lus ? `<div class="jira-ana-repos muted">${esc(tr('jira.ana.read', { repos: '' }))}${lus}</div>` : ''}
      <div class="jira-item-foot muted">${esc(fmtDate(r.updated_at))}</div>
    </button>`;
  }).join('');
}

/** Relit la liste et la table des clés. Rend vrai si elle a changé de contenu (pour redessiner « Mes tickets » quand son filtre en dépend). */
async function chargerAnalyses() {
  let d;
  try { d = await api('/jira/specs/all'); } catch { return false; }
  const avant = JSON.stringify(Object.entries(JIRA.analyses || {}).map(([k, v]) => [k, !!v.analysed]).sort());
  JIRA_ANA.rows = d.specs || [];
  JIRA.analyses = Object.fromEntries(JIRA_ANA.rows.map((r) => [r.key, r]));
  const apres = JSON.stringify(Object.entries(JIRA.analyses).map(([k, v]) => [k, !!v.analysed]).sort());
  renderJiraAnalysed();
  return avant !== apres;
}

$('#jiraAnaRefresh') && $('#jiraAnaRefresh').addEventListener('click', (e) => busy(e.currentTarget, chargerAnalyses));
$('#jiraAnaSearch') && $('#jiraAnaSearch').addEventListener('input', renderJiraAnalysed);
$('#jiraAnaList') && $('#jiraAnaList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jiraanaopen]');
  if (b) selectJiraIssue(b.dataset.jiraanaopen, 'analysed');
});

// Le filtre « Analyse » de « Mes tickets » : un menu comme ses voisins (Statuts, Sprints…), mémorisé, appliqué sans rien redemander à Jira.
function majResumeFiltreAnalyse() {
  const f = jiraSpecFiltre();
  const c = $('#jiraSpecFilterCount'); if (c) c.textContent = f === 'all' ? '' : `· ${tr(`jira.specfilter.${f}`)}`;
  $$('input[name="jiraSpecFilter"]').forEach((r) => { r.checked = r.value === f; });
}
(function brancherFiltreAnalyse() {
  const corps = $('#jiraSpecFilterBody'); if (!corps) return;
  majResumeFiltreAnalyse();
  corps.addEventListener('change', (e) => {
    const r = e.target.closest('input[name="jiraSpecFilter"]'); if (!r) return;
    try { localStorage.setItem(JIRA_SPECFILTRE_CLE, r.value); } catch { /* stockage indisponible */ }
    majResumeFiltreAnalyse();
    $('#jiraSpecFilterBox').open = false;
    renderJiraList();
    const vis = jiraVisibleIssues();
    if (vis.length && !vis.some((x) => x.key === JIRA.selectedKey)) selectJiraIssue(vis[0].key, 'mine');
    else if (!vis.length) $('#jiraDetail').innerHTML = `<div class="jira-empty muted">${esc(tr('jira.no-match'))}</div>`;
  });
}());
