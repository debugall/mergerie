'use strict';
/* Modale contexte de la review. */
/* ---------- Modale contexte de la review ---------- */
let ticketState = { id: null, imageDataUrl: null, removeImage: false };

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function ticketSetPreview(src) {
  const wrap = $('#ticketDrop .ticket-preview-wrap');
  if (src) { $('#ticketPreview').src = src; wrap.hidden = false; }
  else { $('#ticketPreview').removeAttribute('src'); wrap.hidden = true; }
}

async function openTicket(id, title) {
  ticketState = { id, imageDataUrl: null, removeImage: false };
  $('#ticketMrTitle').textContent = title || '';
  await loadRepoOptions(); // nécessaire au combo dépôt des projets liés
  try {
    const d = await api(`/mrs/${id}`);
    $('#ticketText').value = (d.ticket && d.ticket.text) || '';
    ticketSetPreview(d.ticket && d.ticket.has_image ? `/api/mrs/${id}/ticket-image?t=${Date.now()}` : null);
    renderTicketJira(d.ticket || {});
    ticketState.repoId = d.mr ? d.mr.repo_id : (d.repo_id || null);
    // Liens de la MR si elle en a ; sinon on pré-remplit avec les défauts du dépôt.
    const links = (d.links && d.links.length) ? d.links : (d.repo_links || []);
    renderLinkRows(links.map((l) => ({ repo_id: l.repo_id, branch: l.branch || '' })));
  } catch (e) { toast(e.message, true); return; }
  $('#ticketModal').hidden = false;
}

/* Projets liés : une ligne = un dépôt (combo avec recherche, réutilisé) + une branche
   (combo alimenté par branchesFor, comme la modale de session). Sauvés avec le contexte. */
function linkRowHtml(idx, sel = {}) {
  return `<div class="link-grid-row" data-row="${idx}">
    ${repoComboHtml(sel.repo_id, { idClass: 'link-repo', defaultFirst: false })}
    <div class="combo link-branch-combo">
      <input class="link-branch" data-pick-link="1" autocomplete="off" value="${esc(sel.branch || '')}" placeholder="${tr('context.links.branch-ph')}" />
      <div class="combo-options" hidden></div>
    </div>
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-rmlink="${idx}" title="${tr('context.links.remove')}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}
function renderLinkRows(list) {
  const el = $('#linkRows');
  if (!el) return;
  el.innerHTML = (list || []).map((l, i) => linkRowHtml(i, l)).join('');
  wireRepoCombos(el);
  wireLinkBranchPickers();
  $$('#linkRows [data-rmlink]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.link-row').remove();
  }));
}
// Sélecteur de branche des projets liés (liste déroulante avec recherche), calqué
// sur wireBranchPickers mais lisant le dépôt de la MÊME ligne.
function wireLinkBranchPickers() {
  $$('#linkRows .link-row').forEach((row) => {
    const input = row.querySelector('[data-pick-link]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    const box = row.querySelector('.link-branch-combo .combo-options');
    const repoHidden = row.querySelector('.link-repo');
    const open = async () => {
      const repoId = Number(repoHidden.value);
      if (!repoId) { box.innerHTML = `<div class="combo-opt muted">${tr('context.links.pick-repo-first')}</div>`; box.hidden = false; return; }
      box.innerHTML = `<div class="combo-opt muted">${tr('task.combo.loading')}</div>`; box.hidden = false;
      let data;
      try { data = await branchesFor(repoId); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(errorHint(e.message) || e.message)}</div>`; return; }
      const q = input.value.toLowerCase();
      const list = data.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
      const defOpt = data.def ? `<div class="combo-opt" data-b="">${tr('task.combo.default', { branch: esc(data.def) })}</div>` : '';
      box.innerHTML = defOpt + (list.map((b) => `<div class="combo-opt" data-b="${esc(b)}">${esc(b)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-branch')}</div>`);
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-b]');
      if (!o) return;
      input.value = o.dataset.b;
      box.hidden = true;
    });
  });
}
function readLinkRows() {
  return $$('#linkRows .link-row').map((row) => ({
    repo_id: Number(row.querySelector('.link-repo').value),
    branch: (row.querySelector('.link-branch').value || '').trim(),
  })).filter((l) => l.repo_id);
}

// Section « Contexte Jira » : le contenu récupéré (lecture), la fraîcheur, et
// l'erreur éventuelle (pour dire POURQUOI le contexte est vide plutôt que laisser
// croire à un oubli). Cachée si ni contenu ni erreur.
function renderTicketJira(ticket) {
  const box = $('#ticketJira');
  const hasContent = !!ticket.jira_text;
  const hasError = !!ticket.jira_error;
  // On montre la section — et donc le bouton Rafraîchir — dès qu'un ticket est
  // RÉCUPÉRABLE : Jira configuré + une clé détectée. Ça couvre les MR découvertes
  // AVANT que Jira soit configuré (jamais fetchées) : sinon aucun moyen de la tirer.
  const canFetch = ticket.jira_configured && ticket.jira_key;
  if (!hasContent && !hasError && !canFetch) { box.hidden = true; return; }
  box.hidden = false;
  $('#ticketJiraKey').textContent = ticket.jira_key || '';
  $('#ticketJiraAt').textContent = ticket.jira_at
    ? tr('context.jira.fetched', { when: fmtDateTime(ticket.jira_at) })
    : (hasContent ? '' : tr('context.jira.not-fetched'));
  $('#ticketJiraBody').innerHTML = hasContent ? mdToHtml(ticket.jira_text) : '';
  $('#ticketJiraBody').hidden = !hasContent;
  const err = $('#ticketJiraError');
  err.hidden = !hasError;
  if (hasError) err.textContent = tr('context.jira.error', { key: ticket.jira_key || '', error: ticket.jira_error });
}
function closeTicket() { $('#ticketModal').hidden = true; }

// Rafraîchir le contexte Jira depuis la modale (ne touche jamais au complément manuel).
const ticketJiraRefresh = $('#ticketJiraRefresh');
if (ticketJiraRefresh) ticketJiraRefresh.addEventListener('click', () => {
  if (!ticketState.id) return;
  busy(ticketJiraRefresh, () => api(`/mrs/${ticketState.id}/jira-refresh`, { method: 'POST' }))
    .then(() => api(`/mrs/${ticketState.id}`))
    .then((d) => { renderTicketJira(d.ticket || {}); toast(tr('toast.jira-refreshed')); })
    .catch((e) => {
      toast(explainError(e.message), true);
      api(`/mrs/${ticketState.id}`).then((d) => renderTicketJira(d.ticket || {})).catch(() => {});
    });
});

async function ticketPickFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const dataUrl = await readFileAsDataURL(file);
  ticketState.imageDataUrl = dataUrl;
  ticketState.removeImage = false;
  ticketSetPreview(dataUrl);
}

$('#ticketFile').addEventListener('change', (e) => { if (e.target.files[0]) ticketPickFile(e.target.files[0]); });
$('#ticketRemoveImg').addEventListener('click', () => {
  ticketState.imageDataUrl = null; ticketState.removeImage = true; ticketSetPreview(null); $('#ticketFile').value = '';
});
// collage d'une capture (Ctrl+V) quand la modale est ouverte
document.addEventListener('paste', (e) => {
  if ($('#ticketModal').hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (item) { e.preventDefault(); ticketPickFile(item.getAsFile()); }
});
const linkSetDefault = $('#linkSetDefault');
if (linkSetDefault) linkSetDefault.addEventListener('click', () => {
  if (!ticketState.repoId) return;
  busy(linkSetDefault, () => api('/repos/' + ticketState.repoId + '/links', { method: 'POST', body: { links: readLinkRows() } }))
    .then((r) => toast(tr('toast.repo-links-set', { n: r.count, count: r.count })))
    .catch((e) => toast(explainError(e.message), true));
});
const linkAdd = $('#linkAdd');
if (linkAdd) linkAdd.addEventListener('click', () => {
  const cur = readLinkRows();
  cur.push({});
  renderLinkRows(cur);
});
$('#ticketCancel').addEventListener('click', closeTicket);
fermerAuFond('#ticketModal', closeTicket);
$('#ticketSave').addEventListener('click', async () => {
  const btn = $('#ticketSave'); btn.disabled = true;
  try {
    await api(`/mrs/${ticketState.id}/ticket`, { method: 'POST', body: {
      text: $('#ticketText').value,
      image: ticketState.imageDataUrl || undefined,
      removeImage: ticketState.removeImage || undefined,
    } });
    // Projets liés : enregistrés dans le même geste que le contexte.
    await api(`/mrs/${ticketState.id}/links`, { method: 'POST', body: { links: readLinkRows() } });
    toast(tr('toast.contexte-enregistre'));
    const savedId = ticketState.id;
    closeTicket();
    loadToReview();
    if (selectedMr && selectedMr === savedId) openReport(selectedMr, { keep: true }); // maj du ✓ dans le détail
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

