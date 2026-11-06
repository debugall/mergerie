'use strict';
/* Jira : les tickets ANALYSÉS (leur précision technique) — l'onglet « Analysés » et le filtre de « Mes tickets ».
   Un ticket de l'onglet est un ticket dont la précision technique existe : enregistrée (brouillon à lancer), lancée, proposée, éditée ou postée. La liste vient du serveur
   (`/jira/specs/all`, sans appel à Jira : le titre est celui de la photo prise à l'analyse). `JIRA.analyses` en garde la table par clé,
   que le filtre de « Mes tickets » lit sans rien redemander à chaque frappe. */
const JIRA_ANA = { rows: [], selectedKey: null };
const JIRA_SPECFILTRE_CLE = 'aidevtools_jira_specfilter';
/* MASQUÉS : un ticket implémenté n'a plus rien à faire dans la liste, mais rien n'est perdu — la case
   « Afficher les tickets masqués » (mémorisée) les ramène, avec leur pastille, et chaque ligne se
   réaffiche d'un clic. */
const JIRA_ANA_MASQUES_CLE = 'aidevtools_jira_ana_hidden';
function jiraAnaMontrerMasques() { try { return localStorage.getItem(JIRA_ANA_MASQUES_CLE) === '1'; } catch { return false; } }
function jiraSpecFiltre() { try { const v = localStorage.getItem(JIRA_SPECFILTRE_CLE); return ['done', 'todo'].includes(v) ? v : 'all'; } catch { return 'all'; } }

/** Le filtre « Analyse » de « Mes tickets » : `done` = déjà analysés (une précision existe, même seulement enregistrée), `todo` = les autres. */
function jiraPasseFiltreAnalyse(it) {
  const f = jiraSpecFiltre();
  if (f === 'all') return true;
  const analyse = !!(JIRA.analyses && JIRA.analyses[it.key]);   // une précision enregistrée (brouillon) compte autant qu'une proposition
  return f === 'done' ? analyse : !analyse;
}

const jiraAnaDepots = (r) => (r.repos || []).map((d) => `${d.project}${d.branch ? `@${d.branch}` : ''}`).join(', ');

function renderJiraAnalysed() {
  const box = $('#jiraAnaList'); if (!box) return;
  const q = (($('#jiraAnaSearch') || {}).value || '').toLowerCase().trim();
  const montrerMasques = jiraAnaMontrerMasques();
  const visibles = JIRA_ANA.rows.filter((r) => montrerMasques || !r.hidden_at);
  const rows = visibles.filter((r) => !q || `${r.key} ${r.summary} ${jiraAnaDepots(r)}`.toLowerCase().includes(q));
  // La pastille compte ce qu'on verrait en ouvrant l'onglet : les masqués n'y sont pas, c'est le but.
  const nActifs = JIRA_ANA.rows.filter((r) => !r.hidden_at).length;
  const pastille = $('#jiraAnalysedCount'); if (pastille) { pastille.textContent = nActifs; pastille.hidden = !nActifs; }
  const nMasques = JIRA_ANA.rows.length - nActifs;
  const info = $('#jiraAnaInfo'); if (info) info.textContent = tr('jira.count', { n: rows.length, count: rows.length }) + (nMasques && !montrerMasques ? ` · ${tr('jira.ana.hidden-count', { n: nMasques, count: nMasques })}` : '');
  if (!JIRA_ANA.rows.length) { box.innerHTML = emptyState({ icon: 'search', title: tr('jira.ana.empty.title'), text: tr('jira.ana.empty.text') }); return; }
  if (!visibles.length) { box.innerHTML = `<p class="muted jira-empty">${esc(tr('jira.ana.all-hidden', { n: nMasques, count: nMasques }))}</p>`; return; }
  if (!rows.length) { box.innerHTML = `<p class="muted jira-empty">${esc(tr('jira.no-match'))}</p>`; return; }
  box.innerHTML = rows.map((r) => {
    const etat = r.stale ? 'stale' : r.status;
    const lus = (r.repos || []).map((d) => `${esc(d.project)} <code>${esc(d.branch || tr('jira.ana.default-branch'))}</code>`).join(' · ');
    const masque = !!r.hidden_at;
    /* La ligne est un bloc cliquable (pas un <button> : il porte lui-même le bouton Masquer, et un bouton dans un bouton n'est pas du HTML). */
    return `<div class="jira-item${r.key === JIRA_ANA.selectedKey ? ' active' : ''}${masque ? ' jira-ana-masque' : ''}" role="button" tabindex="0" data-jiraanaopen="${esc(r.key)}">
      <div class="jira-item-row1"><code class="jira-key">${esc(r.key)}</code>
        <span class="jira-spec-chip is-${esc(etat)}">${esc(tr('jira.spec.badge', { status: tr(`jira.spec.status.${etat}`) }))}</span>
        ${r.version ? `<span class="jira-chip">${esc(tr('jira.spec.version', { n: r.version }))}</span>` : ''}
        ${r.unposted && r.version ? `<span class="jira-chip jira-spec-unposted">${esc(tr('jira.spec.unposted'))}</span>` : ''}
        ${masque ? `<span class="jira-chip jira-ana-chip-masque">${esc(tr('jira.ana.hidden'))}</span>` : ''}
        <button type="button" class="btn btn-sm btn-icon jira-ana-hide" data-jiraanahide="${r.id}" data-hidden="${masque ? '1' : '0'}"
          title="${esc(tr(masque ? 'jira.ana.unhide-title' : 'jira.ana.hide-title'))}" aria-label="${esc(tr(masque ? 'jira.ana.unhide' : 'jira.ana.hide'))}"><svg class="ico"><use href="#i-${masque ? 'eye' : 'eye-off'}"/></svg></button></div>
      <div class="jira-item-summary">${esc(r.summary || '')}</div>
      ${lus ? `<div class="jira-ana-repos muted">${esc(tr('jira.ana.read', { repos: '' }))}${lus}</div>` : ''}
      <div class="jira-item-foot muted">${esc(fmtDate(r.updated_at))}</div>
    </div>`;
  }).join('');
}

/* Masquer ou réafficher UNE ligne : le serveur d'abord, puis la liste relue — la ligne masquée sort
   (ou reste, pastille « masqué », si la case est cochée) ; son détail ouvert se vide quand elle sort. */
async function basculerMasqueAnalyse(id, cacher) {
  await api(`/jira/spec/${id}/hidden`, { method: 'POST', body: { hidden: cacher } });
  const r = JIRA_ANA.rows.find((x) => String(x.id) === String(id));
  if (r) r.hidden_at = cacher ? new Date().toISOString() : null;
  if (r && cacher && !jiraAnaMontrerMasques() && JIRA_ANA.selectedKey === r.key) {
    JIRA_ANA.selectedKey = null;
    const det = $('#jiraAnalysedDetail'); if (det) det.innerHTML = '';
  }
  toast(tr(cacher ? 'jira.ana.hidden-toast' : 'jira.ana.unhidden-toast', { key: r ? r.key : '' }));
  renderJiraAnalysed();
}

/** Relit la liste et la table des clés. Rend vrai si elle a changé de contenu (pour redessiner « Mes tickets » quand son filtre en dépend). */
async function chargerAnalyses() {
  let d;
  try { d = await api('/jira/specs/all'); } catch { return false; }
  const avant = JSON.stringify(Object.entries(JIRA.analyses || {}).map(([k, v]) => [k, true]).sort());
  JIRA_ANA.rows = d.specs || [];
  JIRA.analyses = Object.fromEntries(JIRA_ANA.rows.map((r) => [r.key, r]));
  const apres = JSON.stringify(Object.entries(JIRA.analyses).map(([k]) => [k, true]).sort());
  renderJiraAnalysed();
  return avant !== apres;
}

$('#jiraAnaRefresh') && $('#jiraAnaRefresh').addEventListener('click', (e) => busy(e.currentTarget, chargerAnalyses));
$('#jiraAnaSearch') && $('#jiraAnaSearch').addEventListener('input', renderJiraAnalysed);
$('#jiraAnaList') && $('#jiraAnaList').addEventListener('click', (e) => {
  const h = e.target.closest('[data-jiraanahide]');
  if (h) { e.stopPropagation(); busy(h, () => basculerMasqueAnalyse(h.dataset.jiraanahide, h.dataset.hidden !== '1')).catch((err) => toast(err.message, true)); return; }
  const b = e.target.closest('[data-jiraanaopen]');
  if (b) selectJiraIssue(b.dataset.jiraanaopen, 'analysed');
});
// La ligne n'est plus un <button> : Entrée et Espace l'ouvrent quand même.
$('#jiraAnaList') && $('#jiraAnaList').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const b = e.target.closest && e.target.closest('[data-jiraanaopen]');
  if (!b || e.target.closest('[data-jiraanahide]')) return;
  e.preventDefault(); selectJiraIssue(b.dataset.jiraanaopen, 'analysed');
});
(function brancherMasquesAnalyse() {
  const c = $('#jiraAnaShowHidden'); if (!c) return;
  c.checked = jiraAnaMontrerMasques();
  c.addEventListener('change', () => {
    try { localStorage.setItem(JIRA_ANA_MASQUES_CLE, c.checked ? '1' : '0'); } catch { /* stockage indisponible */ }
    renderJiraAnalysed();
  });
}());

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
