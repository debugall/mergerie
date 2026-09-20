'use strict';
/* Réglages · Git : palette de commandes (CRUD). */
/* ============ Réglages · Git : palette de commandes (CRUD) ============ */
let gitCmdEditId = null;
async function loadGitConfig() {
  await loadConfig();           // peuple URL GitLab / token / clone (rattachés à #configForm)
  await renderGitCmdList();
}
async function renderGitCmdList() {
  const box = $('#gitCmdList'); if (!box) return;
  let list = [];
  try { list = await api('/git-commands'); } catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  if (!list.length) { box.innerHTML = `<p class="muted">${esc(tr('settings.gitcmd.empty'))}</p>`; return; }
  box.innerHTML = list.map((c) => `<div class="gitcmd-item">
    <div class="gitcmd-main"><strong>${esc(c.label)}</strong> <code>git ${esc(c.command)}</code></div>
    <div class="gitcmd-actions">
      <button class="btn btn-sm" data-gcedit="${c.id}" data-label="${esc(c.label)}" data-command="${esc(c.command)}" title="${esc(tr('settings.gitcmd.edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg></button>
      <button class="btn btn-sm btn-danger" data-gcdel="${c.id}" title="${esc(tr('settings.gitcmd.delete'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg></button>
    </div>
  </div>`).join('');
}
function gitCmdResetForm() {
  gitCmdEditId = null;
  $('#gitCmdLabel').value = ''; $('#gitCmdCommand').value = '';
  $('#gitCmdSubmitLabel').textContent = tr('settings.gitcmd.add');
  $('#gitCmdCancel').hidden = true;
}
$('#gitCmdForm') && $('#gitCmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = $('#gitCmdLabel').value.trim();
  const command = $('#gitCmdCommand').value.trim().replace(/^git\s+/i, ''); // « git » de tête toléré
  if (!label || !command) { toast(tr('err.gitcmd.label-command-required'), true); return; }
  try {
    if (gitCmdEditId) await api(`/git-commands/${gitCmdEditId}`, { method: 'PUT', body: { label, command } });
    else await api('/git-commands', { method: 'POST', body: { label, command } });
    gitCmdResetForm(); renderGitCmdList();
    $('#gitCmdInfo').textContent = tr('ui.saved'); setTimeout(() => { $('#gitCmdInfo').textContent = ''; }, 2000);
  } catch (err) { toast(explainError(err.message), true); }
});
$('#gitCmdCancel') && $('#gitCmdCancel').addEventListener('click', gitCmdResetForm);
$('#gitCmdList') && $('#gitCmdList').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-gcedit]');
  const del = e.target.closest('[data-gcdel]');
  if (edit) {
    gitCmdEditId = Number(edit.dataset.gcedit);
    $('#gitCmdLabel').value = edit.dataset.label; $('#gitCmdCommand').value = edit.dataset.command;
    $('#gitCmdSubmitLabel').textContent = tr('settings.gitcmd.save'); $('#gitCmdCancel').hidden = false;
    $('#gitCmdLabel').focus();
  } else if (del) {
    if (!await confirmDialog({ text: tr('settings.gitcmd.confirm-delete'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/git-commands/${del.dataset.gcdel}`, { method: 'DELETE' }); renderGitCmdList(); }
    catch (err) { toast(explainError(err.message), true); }
  }
});


