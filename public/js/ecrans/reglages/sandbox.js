'use strict';
/* Réglages → Session IA : « Tester le sandbox » (plan_secure.md, lot A). */
/* ---------- Réglages → Session IA : sandbox de l'agent en écriture ---------- */
async function renderSandboxSettings() {
  const btn = $('#sandboxTest');
  if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', runSandboxTest); }
  await afficherEtatSandbox();
}
async function afficherEtatSandbox() {
  const box = $('#sandboxTestResult');
  if (!box) return;
  const c = await api('/config');
  box.innerHTML = sandboxEtatHtml(c);
}
function sandboxEtatHtml(c) {
  if (!c.agent_sandbox_tested_at) {
    return `<p class="muted">${esc(tr('settings.sandbox.jamais-teste'))}</p>`;
  }
  const verdict = c.agent_sandbox_verified === '1' || c.agent_sandbox_verified === 1
    ? `<div class="ai-verdict ok">${svgIco('check')} ${esc(tr('settings.sandbox.verifie'))}</div>`
    : `<div class="ai-verdict bad">${svgIco('close')} ${esc(tr('settings.sandbox.non-verifie'))}</div>`;
  return `${verdict}
    <p class="muted ai-meta">${esc(tr('settings.sandbox.teste-le', { date: new Date(c.agent_sandbox_tested_at).toLocaleString() }))}</p>
    <pre class="ai-output">${esc(c.agent_sandbox_detail || '—')}</pre>`;
}
async function runSandboxTest() {
  const btn = $('#sandboxTest');
  const box = $('#sandboxTestResult');
  $('#sandboxTestInfo').textContent = tr('settings.sandbox.running');
  box.innerHTML = skeleton(2);
  try {
    const d = await busy(btn, () => api('/agent/sandbox-test', { method: 'POST' }));
    box.innerHTML = sandboxEtatHtml({
      agent_sandbox_tested_at: new Date().toISOString(),
      agent_sandbox_verified: d.ok ? '1' : '0',
      agent_sandbox_detail: d.detail,
    });
  } catch (e) {
    box.innerHTML = errorBox(e.message);
  } finally {
    $('#sandboxTestInfo').textContent = '';
  }
}
