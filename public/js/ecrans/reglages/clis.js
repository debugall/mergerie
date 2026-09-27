'use strict';
/* Réglages → Session IA : LES BINAIRES DE L'AGENT — le défaut (`/api/config`) et les autres
   (`/api/agent-clis`) dans une seule liste, un seul formulaire pour les deux. Le formulaire est
   replié tant qu'on n'ajoute ni ne modifie rien ; `cliEditId` dit ce qu'il édite : null (un
   nouveau), 'default' (le défaut), ou l'id d'une ligne. */
let cliEditId = null;
let cliDonnees = { defaut: null, items: [] };
function cliLigneHtml(c, estDefaut, dryRunForced) {
  const id = estDefaut ? 'default' : c.id;
  const etat = dryRunForced ? `<span class="tag">${esc(tr('settings.agent.etat.dryrun'))}</span>`
    : c.available ? `<span class="tag done">${esc(tr('settings.agent.etat.ok'))}</span>`
      : `<span class="tag stale" title="${esc(tr('settings.agent.etat.missing'))}">${esc(tr('settings.cli.missing'))}</span>`;
  const nVars = c.env ? c.env.split('\n').filter(Boolean).length : 0;
  return `<div class="agentcli-item${estDefaut ? ' is-default' : ''}" data-cli="${id}">
    <div class="agentcli-main">
      <div><strong>${esc(c.name)}</strong> ${estDefaut ? `<span class="tag tag-accent" title="${esc(tr('settings.cli.default-tip'))}">${esc(tr('settings.cli.default-badge'))}</span>` : ''} ${etat}</div>
      <code>${esc(c.bin || '—')}${c.args ? ` ${esc(c.args)}` : ''}</code>
      <span class="muted agentcli-meta">${esc(c.backend && c.backend !== 'auto' ? c.backend : tr('settings.agent.backend.auto'))}${nVars ? ` · ${esc(tr('settings.cli.env-count', { n: nVars, count: nVars }))}` : ''}${c.timeout_ms ? ` · ${esc(tr('settings.cli.timeout', { s: Math.round(c.timeout_ms / 1000) }))}` : ''}</span>
    </div>
    <div class="agentcli-actions">
      <button class="btn btn-sm" data-clitest="${id}" title="${esc(tr('settings.agent.test-title'))}"><svg class="ico ico-sm"><use href="#i-zap"/></svg><span>${esc(tr('settings.cli.test'))}</span></button>
      <button class="btn btn-sm" data-cliedit="${id}" title="${esc(tr('settings.gitcmd.edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg><span>${esc(tr('settings.gitcmd.edit'))}</span></button>
      ${estDefaut ? '' : `<button class="btn btn-sm" data-clidefault="${c.id}" title="${esc(tr('settings.cli.default-title'))}"><svg class="ico ico-sm"><use href="#i-check"/></svg><span>${esc(tr('settings.cli.default'))}</span></button>
      <button class="btn btn-sm btn-danger" data-clidel="${c.id}" data-name="${esc(c.name)}" title="${esc(tr('settings.gitcmd.delete'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg></button>`}
    </div>
  </div>`;
}
async function renderCliList() {
  const box = $('#cliList'); if (!box) return;
  try { cliDonnees = await api('/agent-clis'); } catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  const { defaut, items, dryRunForced } = cliDonnees;
  box.innerHTML = cliLigneHtml(defaut, true, dryRunForced) + (items || []).map((c) => cliLigneHtml(c, false, dryRunForced)).join('')
    + (items && items.length ? '' : `<p class="muted agentcli-empty">${esc(tr('settings.cli.empty'))}</p>`);
}
function cliProfil(id) { return id === 'default' ? cliDonnees.defaut : (cliDonnees.items || []).find((x) => x.id === Number(id)); }
function cliOuvrirForm(id) {
  cliEditId = id;
  const c = id ? cliProfil(id) : null;
  $('#cliName').value = c ? c.name : ''; $('#cliBin').value = c ? c.bin : ''; $('#cliArgs').value = c ? (c.args || '') : '';
  $('#cliTimeout').value = c && c.timeout_ms ? c.timeout_ms : ''; $('#cliEnv').value = c ? (c.env || '') : ''; $('#cliBackend').value = c ? (c.backend || 'auto') : 'auto';
  $('#cliFormTitle').textContent = !id ? tr('settings.cli.form-add') : tr('settings.cli.form-edit', { name: c.name });
  $('#cliDefaultNote').hidden = id !== 'default';
  const f = $('#cliForm'); f.hidden = false;
  $('#cliAdd').hidden = true;
  $('#cliName').focus();
}
function cliFermerForm() {
  cliEditId = null;
  $('#cliForm').hidden = true; $('#cliAdd').hidden = false;
}
onEl($('#cliAdd'), 'click', () => cliOuvrirForm(null));
onEl($('#cliCancel'), 'click', cliFermerForm);
$('#cliForm') && $('#cliForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = {
    name: $('#cliName').value.trim(), bin: $('#cliBin').value.trim(), args: $('#cliArgs').value.trim(),
    timeout_ms: Number($('#cliTimeout').value) || 0, env: $('#cliEnv').value, backend: $('#cliBackend').value,
  };
  try {
    if (cliEditId === 'default') {
      /* Le défaut vit dans la config de poste : le même formulaire, une autre route. La preuve
         de sandbox tombe si le binaire change (le serveur s'en charge) ; l'état se relit. */
      await api('/config', { method: 'PUT', body: { agent_name: v.name, agent_bin: v.bin, agent_args: v.args, agent_timeout_ms: v.timeout_ms, agent_env: v.env, agent_backend: v.backend } });
      if (typeof refreshStatus === 'function') refreshStatus();
    } else if (cliEditId) await api(`/agent-clis/${cliEditId}`, { method: 'PUT', body: v });
    else await api('/agent-clis', { method: 'POST', body: v });
    cliFermerForm(); renderCliList();
    $('#cliInfo').textContent = tr('ui.saved'); setTimeout(() => { $('#cliInfo').textContent = ''; }, 2000);
  } catch (err) { toast(explainError(err.message), true); }
});
$('#cliList') && $('#cliList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cliedit],[data-clidel],[data-clidefault],[data-clitest]');
  if (!b) return;
  if (b.dataset.cliedit) {
    cliOuvrirForm(b.dataset.cliedit);
  } else if (b.dataset.clidel) {
    if (!await confirmDialog({ text: tr('settings.cli.confirm-delete', { name: b.dataset.name }), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/agent-clis/${b.dataset.clidel}`, { method: 'DELETE' }); if (String(cliEditId) === b.dataset.clidel) cliFermerForm(); renderCliList(); }
    catch (err) { toast(explainError(err.message), true); }
  } else if (b.dataset.clidefault) {
    /* L'échange : la ligne devient le défaut, l'ancien défaut prend sa place — et la bannière
       d'état de l'agent se relit, le binaire a changé. */
    try {
      await busy(b, () => api(`/agent-clis/${b.dataset.clidefault}/default`, { method: 'POST' }));
      toast(tr('settings.cli.default-done'));
      cliFermerForm(); renderCliList();
      if (typeof refreshStatus === 'function') refreshStatus();
    } catch (err) { toast(explainError(err.message), true); }
  } else if (b.dataset.clitest) {
    const box = $('#cliTestResult');
    box.innerHTML = skeleton(1);
    const c = cliProfil(b.dataset.clitest);
    try {
      const d = await busy(b, () => api(b.dataset.clitest === 'default' ? '/agent/test' : `/agent-clis/${b.dataset.clitest}/test`, { method: 'POST' }));
      box.innerHTML = `${d.ok
        ? `<div class="ai-verdict ok">${svgIco('check')} ${esc(tr('settings.cli.test-ok', { name: c ? c.name : '', ms: d.ms }))}</div>`
        : `<div class="ai-verdict bad">${svgIco('close')} ${esc(tr('settings.cli.test-ko', { name: c ? c.name : '' }))}</div>`}
        <p class="muted ai-meta">${esc(`${d.bin} ${(d.args || []).join(' ')}`)} ${d.dryRun ? `<span class="tag">${esc(tr('settings.agent.dryrun-note'))}</span>` : ''}</p>
        <pre class="ai-output">${esc(d.error || d.output || '—')}</pre>`;
      renderCliList();
      if (typeof refreshStatus === 'function') refreshStatus();
    } catch (err) { box.innerHTML = errorBox(explainError(err.message)); }
  }
});
