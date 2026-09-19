'use strict';
/* Réglages → AI sessions : banc d'essai « reprise de session ». */
/* ---------- Réglages → AI sessions : banc d'essai « reprise de session » ---------- */
function renderAiSessionSettings() {
  const btn = $('#aiSessionTest');
  if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', runAiSessionTest); }
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

