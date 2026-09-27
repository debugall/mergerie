'use strict';
/* Ajout en masse de dépôts (GitLab ou GitHub). */
// @expose closeBulk
/* ---------- Ajout en masse de dépôts (GitLab ou GitHub) ----------
   Une seule modale, paramétrée par la forge : même recherche, même « tout cocher »,
   seules la source et l'étiquette changent. */
let bulkProjects = [];
let bulkForge = 'gitlab';
const bulkSelected = new Set();

async function openBulk(forge = 'gitlab') {
  bulkForge = forge === 'github' ? 'github' : 'gitlab';
  bulkProjects = [];
  bulkSelected.clear();
  $('#bulkSearch').value = '';
  $('#bulkList').innerHTML = skeleton(5);
  const title = $('#bulkTitle');
  if (title) title.textContent = tr(`settings.bulk.title.${bulkForge}`);
  $('#bulkModal').hidden = false;
  /* LE FOCUS SUIT LA MODALE. Il restait sur le bouton « Ajout en masse », derrière le voile :
     la première frappe ne filtrait rien, et Tab repartait du haut de la page. Une liste de
     cinquante dépôts s'aborde par son filtre. */
  $('#bulkSearch').focus({ preventScroll: true });
  try {
    /* SANS CONNEXION À LA FORGE, IL N'Y A PAS DE LISTE À CHERCHER. L'appel partait quand même
       et revenait avec le message de la forge — « 401 », « jeton manquant » — qui dit ce qui
       s'est passé, jamais quoi faire. Le bouton, lui, RESTE : il dit ce que l'outil sait faire,
       et c'est une information utile avant d'avoir un jeton. C'est la modale qui explique ce
       qui manque, et qui ouvre la porte — le même geste que les écrans vides ailleurs. */
    const cfg = await api('/config');
    const manque = bulkForge === 'github'
      ? !cfg.github_token
      : !(cfg.access_token && cfg.gitlab_url);
    if (manque) {
      /* Clés écrites en toutes lettres plutôt que composées : c'est ce qui les rend
         greppables, et `npm run i18n:check` les cherche telles quelles. */
      $('#bulkList').innerHTML = bulkForge === 'github'
        ? emptyState({ icon: 'alert',
          title: tr('settings.bulk.no-token.github.title'),
          text: tr('settings.bulk.no-token.github.text'),
          actions: [{ act: 'go-config-github', label: tr('settings.bulk.no-token.action') }] })
        : emptyState({ icon: 'alert',
          title: tr('settings.bulk.no-token.gitlab.title'),
          text: tr('settings.bulk.no-token.gitlab.text'),
          actions: [{ act: 'go-config', label: tr('settings.bulk.no-token.action') }] });
      return;
    }
    bulkProjects = await api(`/${bulkForge}/projects`);
    renderBulk();
  } catch (e) {
    $('#bulkList').innerHTML = errorBox(e.message);
  }
}
function closeBulk() { $('#bulkModal').hidden = true; }

function renderBulk() {
  const q = ($('#bulkSearch').value || '').toLowerCase().trim();
  const list = bulkProjects.filter((p) => !q || (p.project || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
  const el = $('#bulkList');
  if (!bulkProjects.length) {
    el.innerHTML = emptyState({ icon: 'alert', title: tr('settings.bulk.empty.title'),
      text: tr(bulkForge === 'github' ? 'settings.bulk.empty.github.text' : 'settings.bulk.empty.text'),
      actions: [{ act: 'go-config', label: tr('settings.bulk.empty.action') }] });
    return;
  }
  el.innerHTML = list.length ? list.map((p) => `
    <label class="bulk-item ${p.already ? 'already' : ''}">
      <input type="checkbox" data-proj="${esc(p.project)}" ${p.already ? 'checked disabled' : (bulkSelected.has(p.project) ? 'checked' : '')}/>
      <span class="bulk-path">${esc(p.project)}</span>
      ${p.already ? `<span class="tag done">${tr('settings.bulk.already')}</span>` : ''}
    </label>`).join('') : `<p class="muted">${tr('settings.bulk.no-match', { q: esc(q) })}</p>`;
  updateBulkCount();
}
function updateBulkCount() {
  $('#bulkCount').textContent = bulkSelected.size ? tr('settings.bulk.selected', { n: bulkSelected.size, count: bulkSelected.size }) : '';
  $('#bulkAdd').disabled = bulkSelected.size === 0;
}

$('#btnBrowseProjects').addEventListener('click', () => openBulk('gitlab'));
const btnBrowseGithub = $('#btnBrowseGithub');
if (btnBrowseGithub) btnBrowseGithub.addEventListener('click', () => openBulk('github'));
$('#bulkCancel').addEventListener('click', closeBulk);
fermerAuFond('#bulkModal', closeBulk);
$('#bulkSearch').addEventListener('input', renderBulk);
$('#bulkList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-proj]');
  if (!cb || cb.disabled) return;
  if (cb.checked) bulkSelected.add(cb.dataset.proj); else bulkSelected.delete(cb.dataset.proj);
  updateBulkCount();
});
$('#bulkAll').addEventListener('click', () => {
  const q = ($('#bulkSearch').value || '').toLowerCase().trim();
  bulkProjects.filter((p) => !p.already && (!q || (p.project || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)))
    .forEach((p) => bulkSelected.add(p.project));
  renderBulk();
});
$('#bulkNone').addEventListener('click', () => { bulkSelected.clear(); renderBulk(); });
$('#bulkAdd').addEventListener('click', async () => {
  const projects = bulkProjects.filter((p) => bulkSelected.has(p.project)).map((p) => ({ project: p.project, url: p.url }));
  if (!projects.length) return;
  const btn = $('#bulkAdd'); btn.disabled = true;
  try {
    const r = await api('/repos/bulk', { method: 'POST', body: { projects, branch_pattern: $('#bulkPattern').value, forge: bulkForge } });
    toast(tr('toast.repos-added', { n: r.added, added: r.added }) + (r.skipped ? tr('toast.repos-skipped', { n: r.skipped, skipped: r.skipped }) : ''));
    closeBulk();
    loadRepos();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

