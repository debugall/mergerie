'use strict';
/* Réglages → Général : la jauge d'occupation disque et « Nettoyer maintenant ». */
/* Une taille lisible : les octets ne parlent à personne au-delà du kilo. */
function tailleLisible(o) {
  const n = Number(o) || 0;
  if (n < 1024) return `${n} o`;
  const u = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
async function mesurerDisque(force) {
  const box = $('#diskUsage');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p class="muted">${esc(tr('settings.disk.measuring'))}</p>`;
  try {
    const d = await api(`/stats/disk${force ? '?force=1' : ''}`);
    const total = d.total || 1;
    box.innerHTML = `<table class="disk-table"><tbody>${(d.categories || []).map((c) => `<tr>
        <td>${esc(tr(`settings.disk.cat.${c.key}`))}</td>
        <td class="disk-size">${esc(tailleLisible(c.octets))}</td>
        <td class="disk-files muted">${esc(tr('settings.disk.files', { n: c.fichiers, count: c.fichiers }))}</td>
        <td class="disk-bar"><span style="width:${Math.max(1, Math.round((c.octets / total) * 100))}%"></span></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td>${esc(tr('settings.disk.total'))}</td><td class="disk-size">${esc(tailleLisible(d.total))}</td><td colspan="2" class="muted">${esc(d.data_dir || '')}</td></tr></tfoot></table>`;
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
}
onEl($('#btnDiskMeasure'), 'click', () => mesurerDisque(true));
onEl($('#btnRetentionRun'), 'click', async () => {
  const b = $('#btnRetentionRun');
  const note = $('#retentionBilan');
  try {
    const r = await busy(b, () => api('/retention/run', { method: 'POST' }));
    const bl = r.bilan || {};
    const morceaux = [];
    if (bl.retention) morceaux.push(tr('settings.disk.bilan.jobs', { n: bl.retention.job, count: bl.retention.job, logs: bl.retention.job_log }));
    if (bl.mrs) morceaux.push(tr('settings.disk.bilan.mrs', { n: bl.mrs.mrs, count: bl.mrs.mrs }));
    if (bl.gc) morceaux.push(tr('settings.disk.bilan.gc', { n: bl.gc, count: bl.gc }));
    note.textContent = morceaux.length ? morceaux.join(' · ') : tr('settings.disk.bilan.rien');
    note.hidden = false;
    if (!$('#diskUsage').hidden) mesurerDisque(true);
  } catch (e) { toast(explainError(e.message), true); }
});
