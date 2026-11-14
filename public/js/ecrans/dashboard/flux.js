'use strict';
/* Statistiques → Flux : reviews par semaine, délai de cycle, tableau par projet (et son export), sessions de dev, opérations Git. */
/* ---------- Flux ----------
   « Qu'est-ce qui passe, et à quelle vitesse ? » Ce qui se compte et se date : le volume de
   passes, le temps qu'une merge request met à traverser, l'état de chaque dépôt, ce que les
   sessions ont produit, ce que git a fait. */
function dashFluxHtml(s) {
  const maxW = Math.max(1, ...s.weekly.map((w) => w.count));
  const weeklyHtml = `<div class="dash-card"><h3>${tr('stats.weekly.title')}</h3>${dashCap('stats.help.weekly')}
    <div class="vbars">${s.weekly.map((w) => `<div class="vbar" title="${tr('stats.weekly.tooltip', { week: w.week, count: w.count })}"><div class="vbar-fill${w.count ? '' : ' is-zero'}" style="height:${(w.count / maxW) * 100}%"></div><span class="vbar-val">${w.count || ''}</span></div>`).join('')}</div>
    <div class="vbars-x">${s.weekly.map((w) => `<span>${w.week.slice(8, 10)}-${w.week.slice(5, 7)}</span>`).join('')}</div></div>`;

  // Taux de résolution : la mesure la plus parlante de ce que l'outil apporte.
  const rateCell = (res) => (res && res.rate != null)
    ? `<span class="res-rate ${res.rate >= 70 ? 'good' : res.rate >= 40 ? 'mid' : 'bad'}" title="${esc(tr('stats.resolution.detail', { resolved: res.resolved, prior: res.prior }))}">${res.rate}%</span>`
    : '<span class="note none">—</span>';
  const trendCell = (pt) => !pt ? '<span class="note none">—</span>'
    : `<span class="proj-trend ${pt.dir}" title="${esc(tr('stats.trend.delta', { delta: (pt.delta > 0 ? '+' : '') + pt.delta }))}">${pt.dir === 'up' ? '▲' : pt.dir === 'down' ? '▼' : '→'} ${pt.delta > 0 ? '+' : ''}${pt.delta}</span>`;
  const projHtml = `<div class="dash-card"><h3>${tr('stats.proj.title')} <span class="muted">${tr('stats.proj.subtitle')}</span>
    ${/* CE TABLEAU FINIT SOUVENT DANS UN TABLEUR : « où en est-on par projet » se présente, se
          trie autrement, se garde d'un mois sur l'autre. Il n'existait aucun export dans tout
          l'onglet — on recopiait à la main ou on faisait une capture d'écran. */''}
    <button type="button" id="statsExport" class="btn btn-sm btn-ghost" title="${esc(tr('stats.export.title'))}">${svgIco('download')}<span>${esc(tr('stats.export.btn'))}</span></button></h3>${dashCap('stats.help.proj')}
    <div class="md-tablewrap"><table class="md-table"><thead><tr><th>${tr('stats.col.project')}</th><th>${tr('stats.col.reviewed')}</th><th>${tr('stats.col.pending')}</th><th>${tr('stats.col.avg')}</th><th>${tr('stats.col.worst')}</th><th title="${esc(tr('stats.col.resolution-hint'))}">${tr('stats.col.resolution')}</th><th title="${esc(tr('stats.col.trend-hint'))}">${tr('stats.col.trend')}</th><th>${tr('stats.col.last-commit')}</th></tr></thead>
    ${/* CHAQUE NOMBRE EST UNE PORTE. Un tableau qui décrit sans donner de chemin fait relire
          des chiffres qu'on ne peut pas suivre : « pire 5,5 » et « en attente 3 » ouvrent
          Reviews sur CE projet, au bon stade. Les statistiques déclenchent le travail. */''}
    <tbody>${s.projects.length ? s.projects.map((p) => `<tr><td>${esc(p.project)}</td><td>${p.reviewed}</td><td>${p.pending ? `<button type="button" class="stat-porte" data-stat-projet="${esc(p.project)}" data-stat-seg="to_review" title="${esc(tr('stats.go.pending'))}">${p.pending}</button>` : ''}</td><td>${dashNoteBadge(p.avg)}</td><td>${p.worst != null ? `<button type="button" class="stat-porte" data-stat-projet="${esc(p.project)}" data-stat-seg="reviewed" title="${esc(tr('stats.go.worst'))}">${dashNoteBadge(p.worst)}</button>` : dashNoteBadge(p.worst)}</td><td>${rateCell(p.resolution)}</td><td>${trendCell(p.trend)}</td><td class="dash-lastcommit" data-project="${esc(p.project)}"><span class="muted">…</span></td></tr>`).join('') : `<tr><td colspan="8" class="muted">${tr('stats.empty')}</td></tr>`}</tbody></table></div>
    ${s.resolution ? `<p class="muted stats-res-global">${tr('stats.resolution.global', { rate: s.resolution.rate, resolved: s.resolution.resolved, prior: s.resolution.prior })}</p>` : ''}</div>`;

  const t = s.tasks;
  const devHtml = `<div class="dash-card"><h3>${tr('stats.dev.title')}</h3>${dashCap('stats.help.dev')}<div class="stat-row">
    ${dashTile(tr('stats.dev.tasks'), t.total)}
    ${dashTile(tr('stats.dev.mr-created'), t.mrCreated, 'accent')}
    ${dashTile(tr('stats.dev.mr-merged'), t.mrMerged, 'green')}
    ${dashTile(tr('stats.dev.comments'), s.commentsPosted)}
  </div></div>`;

  /* A37 — LE DÉLAI DE CYCLE : combien de temps une merge request met à passer, et OÙ le temps
     part — avant la première review, ou après. C'est la seule mesure qui répond à « est-ce que
     l'outil me fait aller plus vite ? », et les trois dates étaient en base depuis toujours.
     Médiane, et seulement sur les MR ALLÉES AU BOUT : une moyenne se fait emporter par la MR
     oubliée trois mois, et compter les MR encore ouvertes ferait baisser le chiffre à chaque
     nouvelle arrivée. */
  const cyc = s.cycle;
  const dureeH = (h) => (h == null ? '—' : (h < 48 ? tr('stats.cycle.hours', { n: Math.round(h) }) : tr('stats.cycle.days', { n: Math.round(h / 24 * 10) / 10 })));
  const cycHtml = !cyc ? '' : `<div class="dash-card"><h3>${tr('stats.cycle.title')}</h3>${dashCap('stats.cycle.help')}
    <div class="stat-row">
      ${dashTile(tr('stats.cycle.total'), dureeH(cyc.total_h), 'accent')}
      ${dashTile(tr('stats.cycle.to-review'), dureeH(cyc.to_review_h))}
      ${dashTile(tr('stats.cycle.to-merge'), dureeH(cyc.to_merge_h))}
    </div>
    <p class="muted">${esc(tr('stats.cycle.count', { n: cyc.n, count: cyc.n }))}</p>
    ${(cyc.projets || []).length > 1 ? `<div class="md-tablewrap"><table class="md-table"><thead><tr>
        <th>${esc(tr('stats.col.project'))}</th><th>${esc(tr('stats.cycle.total'))}</th>
        <th>${esc(tr('stats.cycle.to-review'))}</th><th>${esc(tr('stats.cycle.to-merge'))}</th><th>${esc(tr('stats.cycle.n'))}</th></tr></thead>
      <tbody>${cyc.projets.map((p) => `<tr><td>${esc(p.project)}</td><td>${esc(dureeH(p.total_h))}</td>
        <td>${esc(dureeH(p.to_review_h))}</td><td>${esc(dureeH(p.to_merge_h))}</td><td>${p.n}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;

  /* B14 — CE QUE GIT A FAIT. La dernière table de trace que cet écran ignorait. On montre le
     volume par action ET les échecs : c'est le rapport entre les deux qui apprend quelque
     chose — supprimer trente branches sans un échec est une routine saine, dix suppressions
     dont quatre refusées disent qu'on vise des branches protégées. Chaque ligne mène à
     l'historique, filtré sur son action. */
  const go = s.gitOps || { total: 0, errors: 0, byAction: [] };
  const goHtml = `<div class="dash-card"><h3>${tr('stats.gitops.title')}</h3>${dashCap('stats.gitops.help')}
    ${go.total ? `<p class="muted">${esc(tr('stats.gitops.total', { n: go.total, count: go.total }))}${go.errors ? ` · ${esc(tr('stats.gitops.errors', { n: go.errors, count: go.errors }))}` : ''}</p>
      <div class="md-tablewrap"><table class="md-table"><tbody>${go.byAction.map((a) => `<tr>
        <td>${esc(GIT_ACTION_LABEL()[a.action] || a.action)}</td>
        <td class="stats-top-tok">${esc(String(a.n))}</td>
        <td class="muted">${a.errors ? esc(tr('stats.gitops.errors', { n: a.errors, count: a.errors })) : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.gitops.empty'))}</p>`}</div>`;


  return `<div class="dash-grid">${weeklyHtml}${cycHtml}</div>` + projHtml + `<div class="dash-grid">${devHtml}${goHtml}</div>`;
}

/* L'export et la colonne « dernier commit » se branchent après le rendu : l'un lit le tableau à
   l'écran, l'autre l'alimente depuis la forge, à part et best-effort. */
function dashFluxBrancher(s) {
  /* L'EXPORT PORTE CE QUI EST À L'ÉCRAN, colonnes comprises : un CSV dont les en-têtes ne sont
     pas ceux du tableau oblige à deviner. Séparateur « ; » et BOM : c'est ce qu'Excel ouvre
     sans poser de question sur une machine française, et ce fichier finit dans Excel. */
  const csvStats = () => {
    const entetes = ['stats.col.project', 'stats.col.reviewed', 'stats.col.pending', 'stats.col.avg',
      'stats.col.worst', 'stats.col.resolution', 'stats.col.trend'].map((k) => tr(k));
    const cellule = (v) => {
      const x = v == null ? '' : String(v);
      return /[";\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    };
    const lignes = s.projects.map((p) => [p.project, p.reviewed, p.pending || 0,
      p.avg == null ? '' : p.avg, p.worst == null ? '' : p.worst,
      p.resolution && p.resolution.rate != null ? `${p.resolution.rate}%` : '',
      p.trend ? `${p.trend.delta > 0 ? '+' : ''}${p.trend.delta}` : ''].map(cellule).join(';'));
    return `\uFEFF${[entetes.map(cellule).join(';'), ...lignes].join('\n')}\n`;
  };
  onEl($('#statsExport'), 'click', () => {
    telecharger(new Blob([csvStats()], { type: 'text/csv;charset=utf-8' }),
      `mergerie-projets-${new Date().toISOString().slice(0, 10)}.csv`);
  });
  fillDashboardCommits();
}
