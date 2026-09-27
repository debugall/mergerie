'use strict';
/* Lots (Dev IA). */
// @expose loadLots, lots
/* ---------- Lots (Dev IA) ---------- */

let lots = [];

async function loadLots() {
  await loadRepoOptions();
  try { lots = await api('/lots'); } catch { lots = []; }
  renderLots();
}

function renderLots() {
  const el = $('#lotList');
  if (!el) return;
  if (!lots.length) {
    el.innerHTML = emptyState({ icon: 'inbox', title: tr('verify.lots.empty.title'), text: tr('verify.lots.empty.text') });
    return;
  }
  el.innerHTML = lots.map((l) => `<div class="card" data-id="${l.id}">
    <div class="card-main">
      <div class="title">${esc(l.name)}</div>
      <div class="meta">${(l.members || []).map((m) => `<span class="tag">${esc(m.project || '')} !${esc(String(m.iid || m.ref_id))}</span>`).join(' ')}</div>
      <div class="card-tags">${verifyBadge(l.last_verification ? { ...l.last_verification, failed_count: (l.last_verification.imputable || []).length } : null)}</div>
    </div>
    <div class="card-actions"><div class="btn-group">
      <button class="btn btn-primary" data-lotverify="${l.id}">${svgIco('play')}${esc(tr('verify.btn.verify-lot'))}</button>
      <button class="btn btn-danger" data-lotdel="${l.id}">${svgIco('trash')}${esc(tr('ui.delete'))}</button>
    </div></div>
  </div>`).join('');
  $$('#lotList [data-lotverify]').forEach((b) => b.addEventListener('click', () => {
    const l = lots.find((x) => x.id === Number(b.dataset.lotverify));
    if (!l) return;
    const membres = (l.members || []).filter((m) => m.kind === 'mr');
    lancerVerification(membres.map((m) => m.ref_id), { lotId: l.id, repoIds: membres.map((m) => m.repo_id).filter(Boolean) });
  }));
  $$('#lotList [data-lotdel]').forEach((b) => b.addEventListener('click', async () => {
    const l = lots.find((x) => x.id === Number(b.dataset.lotdel));
    if (!await confirmDialog({ title: tr('verify.lot.del.title'), text: tr('verify.lot.del.text', { name: (l && l.name) || '' }), confirmLabel: tr('ui.delete') })) return;
    try { await busy(b, () => api(`/lots/${b.dataset.lotdel}`, { method: 'DELETE' })); loadLots(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
}

