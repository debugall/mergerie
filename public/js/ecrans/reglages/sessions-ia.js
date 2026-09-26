'use strict';
/* Réglages → AI sessions : banc d'essai « reprise de session ». */
/* ---------- Réglages → AI sessions : banc d'essai « reprise de session » ---------- */
function renderAiSessionSettings() {
  const btn = $('#aiSessionTest');
  if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', runAiSessionTest); }
  const bt = $('#agentTest');
  if (bt && !bt.dataset.bound) { bt.dataset.bound = '1'; bt.addEventListener('click', runAgentTest); }
  afficherEtatAgent();
}
/* L'ÉTAT DU BINAIRE, relu à chaque ouverture : trouvé, introuvable, ou simulé exprès. */
async function afficherEtatAgent() {
  const p = $('#agentEtat');
  if (!p) return;
  try {
    const s = await api('/status');
    const etat = s.dryRunForced ? tr('settings.agent.etat.dryrun') : s.copilotAvailable ? tr('settings.agent.etat.ok') : tr('settings.agent.etat.missing');
    /* Le niveau de garantie, en clair, à côté du nom : ce que ce backend peut promettre. */
    const niveau = s.agentLevel ? ` · ${tr(`settings.agent.level.${s.agentLevel}`)}` : '';
    p.textContent = tr('settings.agent.etat', { bin: s.copilotBin || '—', backend: s.agentBackendLabel || s.agentBackend || '?', etat }) + niveau;
    p.classList.toggle('is-invalid-text', !s.copilotAvailable && !s.dryRunForced);
  } catch { p.textContent = ''; }
}
async function runAgentTest() {
  const btn = $('#agentTest');
  const box = $('#agentTestResult');
  $('#agentTestInfo').textContent = tr('settings.agent.running');
  box.innerHTML = skeleton(1);
  try {
    const d = await busy(btn, () => api('/agent/test', { method: 'POST' }));
    const verdict = d.ok
      ? `<div class="ai-verdict ok">${svgIco('check')} ${esc(tr('settings.agent.ok', { ms: d.ms }))}</div>`
      : `<div class="ai-verdict bad">${svgIco('close')} ${esc(tr('settings.agent.ko'))}</div>`;
    box.innerHTML = `${verdict}
      <p class="muted ai-meta">${esc(`${d.bin} ${(d.args || []).join(' ')}`)} ${d.dryRun ? `<span class="tag">${esc(tr('settings.agent.dryrun-note'))}</span>` : ''}</p>
      <pre class="ai-output">${esc(d.error || d.output || '—')}</pre>`;
    afficherEtatAgent();
    if (typeof refreshStatus === 'function') refreshStatus();
  } catch (e) {
    box.innerHTML = errorBox(e.message);
  } finally {
    $('#agentTestInfo').textContent = '';
  }
}
async function runAiSessionTest() {
  const btn = $('#aiSessionTest');
  const box = $('#aiSessionResult');
  $('#aiSessionInfo').textContent = tr('settings.aisession.running');
  box.innerHTML = skeleton(2);
  try {
    const d = await busy(btn, () => api('/ai-sessions/test', { method: 'POST' }));
    box.innerHTML = aiSessionResultHtml(d);
  } catch (e) {
    box.innerHTML = errorBox(e.message);
  } finally {
    $('#aiSessionInfo').textContent = '';
  }
}
function aiSessionResultHtml(d) {
  const verdict = d.recalled
    ? `<div class="ai-verdict ok">${svgIco('check')} ${esc(tr('settings.aisession.ok'))}</div>`
    : `<div class="ai-verdict bad">${svgIco('close')} ${esc(tr('settings.aisession.ko'))}</div>`;
  const flags = [
    d.dryRun ? `<span class="tag">${esc(tr('settings.aisession.dryrun'))}</span>` : '',
    d.sameSession === true ? `<span class="tag done">${esc(tr('settings.aisession.same-session'))}</span>` : '',
    d.sameSession === false ? `<span class="tag stale">${esc(tr('settings.aisession.diff-session'))}</span>` : '',
  ].filter(Boolean).join(' ');
  const pass = (title, prompt, output) => `<div class="ai-pass"><h4>${esc(title)}</h4>
      <div class="ai-prompt"><span class="muted">${esc(tr('settings.aisession.prompt'))}</span> ${esc(prompt)}</div>
      <pre class="ai-output">${esc(output || '—')}</pre></div>`;
  return `${verdict}
    <p class="muted ai-meta">${esc(tr('settings.aisession.meta', { backend: d.backend, marker: d.marker }))} ${flags}</p>
    ${pass(tr('settings.aisession.pass1'), d.prompt1, d.output1)}
    ${pass(tr('settings.aisession.pass2'), d.prompt2, d.output2)}`;
}

