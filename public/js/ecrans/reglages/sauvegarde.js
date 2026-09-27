'use strict';
/* Sauvegarde des données. */
// @expose fillDashboardCommits
/* ---------- Sauvegarde des données ----------
   Une archive de tout ce que Mergerie ne sait pas reconstruire : la base, les rapports, les
   retours d'agent, les captures. Pas les clones — ils se retrouvent avec un `git clone`.
   On dit ce que l'archive contient APRÈS l'avoir produite : « c'est fait » n'apprend rien,
   « 1 base, 34 rapports, 2,1 Mo » se vérifie. */
$('#btnBackup') && $('#btnBackup').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const info = $('#backupInfo');
  if (info) { info.className = 'muted'; info.textContent = tr('settings.backup.running'); }
  try {
    // POST : l'archive porte la base entière, jetons compris — elle ne part que sur un geste de l'application.
    const res = await fetch('/api/backup', { method: 'POST' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || res.statusText);
    const blob = await res.blob();
    // Le nom vient du serveur (daté) : deux sauvegardes ne doivent pas s'écraser.
    const nom = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    telecharger(blob, nom ? nom[1] : 'mergerie-backup.zip');
    let detail = '';
    try {
      const brut = res.headers.get('X-Mergerie-Backup');
      if (brut) {
        detail = JSON.parse(atob(brut))
          .filter((c) => c.fichiers)
          .map((c) => `${c.nom} ${c.fichiers}`).join(' · ');
      }
    } catch { /* l'en-tête est un confort : son absence ne change rien au fichier */ }
    if (info) {
      info.className = 'muted ok';
      info.textContent = tr('settings.backup.done', { size: Math.max(1, Math.round(blob.size / 1024)) })
        + (detail ? ` — ${detail}` : '');
    }
  } catch (err) {
    if (info) { info.className = 'muted err'; info.textContent = explainError(err.message); }
  }
}));

const fermerActivite = () => { $('#activityModal').hidden = true; };
$('#activityClose') && $('#activityClose').addEventListener('click', fermerActivite);
fermerAuFond('#activityModal', fermerActivite, { salissable: false });

// Cellule « dernier commit » : date (lien vers le commit GitLab) + auteur.
function lastCommitCell(c) {
  const when = c.date ? fmtDate(c.date) : '—';
  const link = c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" title="${esc(`${c.title || ''}${c.sha ? ` · ${c.sha}` : ''}`)}">${when}</a>` : when;
  return `${link}${c.author ? ` · <span class="muted">${esc(c.author)}</span>` : ''}`;
}

async function fillDashboardCommits() {
  let d;
  try { d = await api('/dashboard/commits'); }
  catch {
    // Best-effort : si l'activité GitLab est injoignable, ne pas laisser le squelette du Top 5
    // tourner en boucle — basculer sur un état « indisponible » explicite.
    const box0 = $('#dashboard'); if (!box0) return;
    const t5f = $('#dashTop5');
    if (t5f) t5f.innerHTML = `<h3>${tr('stats.top5.title')}</h3><p class="muted">${tr('stats.top5.unavailable')}</p>`;
    $$('.dash-lastcommit[data-project]', box0).forEach((td) => { td.innerHTML = '<span class="note none">—</span>'; });
    return;
  }
  const box = $('#dashboard'); if (!box) return;
  const byProject = Object.fromEntries((d.commits || []).map((c) => [c.project, c]));
  $$('.dash-lastcommit[data-project]', box).forEach((td) => {
    const c = byProject[td.dataset.project];
    td.innerHTML = c ? lastCommitCell(c) : '<span class="note none">—</span>';
  });
  // Top 5 : dépôts au commit le plus récent d'abord.
  const top = [...(d.commits || [])].filter((c) => c.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const t5 = $('#dashTop5'); if (!t5) return;
  t5.innerHTML = `<h3>${tr('stats.top5.title')}</h3><p class="dash-help">${tr('stats.top5.help')}</p>`
    + (top.length
      ? `<div class="md-tablewrap"><table class="md-table"><thead><tr><th>${tr('stats.col.project')}</th><th>${tr('stats.col.last-commit')}</th><th>${tr('stats.col.author')}</th></tr></thead>
          <tbody>${top.map((c) => `<tr><td>${esc(c.project)}</td><td>${c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" title="${esc(c.title)}"><code>${esc(c.sha)}</code></a>` : `<code>${esc(c.sha)}</code>`} · ${c.date ? `${fmtDate(c.date)} ${fmtHour(c.date)}` : '—'}</td><td class="muted">${esc(c.author)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">${d.configured ? tr('stats.top5.empty') : tr('stats.top5.not-configured')}</p>`);
}
$('#dashRefresh').addEventListener('click', loadDashboard);

