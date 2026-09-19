'use strict';
/* Onglet Jira : mes tickets affectés, les statuts. */
/* ============ Onglet Jira : mes tickets affectés (liste → détail) ============ */
const JIRA = { me: null, people: [], issues: [], selectedKey: null, current: null, currentBox: null, total: null, connus: {}, cible: null };
const JIRA_CAT = { new: 'todo', indeterminate: 'progress', done: 'done' };

function jiraStatusChip(it) {
  const cls = JIRA_CAT[it.statusCategory] || 'todo';
  return `<span class="jira-status jira-status-${cls}">${esc(it.status || '—')}</span>`;
}
function jiraInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function jiraSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} Ko`;
  return `${(b / 1024 / 1024).toFixed(1)} Mo`;
}

// Filtre par statut (persisté) : on mémorise les statuts MASQUÉS (décochés).
function jiraHiddenStatuses() { try { return new Set(JSON.parse(localStorage.getItem('aidevtools_jira_status_hidden') || '[]')); } catch { return new Set(); } }
function setJiraHiddenStatuses(set) { try { localStorage.setItem('aidevtools_jira_status_hidden', JSON.stringify([...set])); } catch { /* ignore */ } }
/* Les statuts masqués sont exclus PAR Jira : ils disparaîtraient donc de la liste, et on ne
   pourrait plus les recocher. On garde en mémoire ceux déjà vus, comme pour les sprints. */
/* Statuts du WORKFLOW des projets concernés, en plus de ceux portés par les tickets chargés :
   un statut peut exister sans qu'aucun ticket rapporté ne l'ait — il doit rester filtrable.
   On interroge les projets sélectionnés, sinon ceux des tickets affichés : demander tous les
   statuts de l'instance donnerait des dizaines d'entrées sans rapport. */
let jiraStatutsDemandes = '';
async function chargerStatutsDuWorkflow() {
  const choisis = jiraFiltres().project || [];
  const cles = [...new Set(choisis.length ? choisis : JIRA.issues.map((i) => i.projectKey).filter(Boolean))].sort();
  const signature = cles.join(',');
  if (!signature || signature === jiraStatutsDemandes) return;
  jiraStatutsDemandes = signature;
  try {
    const d = await api(`/jira/statuses?projects=${encodeURIComponent(signature)}`);
    if (!(d.statuses || []).length) return;
    jiraMemoriseValeurs('status', d.statuses.map((st) => ({ v: st.name, l: st.name, cat: st.cat })));
    renderJiraStatusFilter();
  } catch { /* filtre : jamais bloquant */ }
}

function jiraDistinctStatuses() {
  const seen = new Map();
  for (const it of JIRA.issues) if (it.status && !seen.has(it.status)) seen.set(it.status, it.statusCategory);
  const vus = [...seen.entries()].map(([status, cat]) => ({ v: status, l: status, cat }));
  return jiraUnionValeurs('status', vus).map((x) => ({ status: x.v, cat: x.cat }));
}
