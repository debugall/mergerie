'use strict';
/* Statistiques → Qualité : distribution et tendance des notes, retouches, taux de vert, constats qui reviennent. */
/* ---------- Qualité ----------
   « Ce qu'on dit est-il juste et utile ? » Les notes et leur évolution, ce que les retouches
   disent de la confiance qu'on peut leur faire, les vérifications, et les constats qui reviennent
   assez pour devenir une règle. */
function dashQualiteHtml(s) {
  const noteColors = ['#e05a5a', '#e0863a', '#e0a838', '#8fce7f', '#35c07f'];
  const maxB = Math.max(1, ...s.notes.buckets.map((b) => b.count), s.notes.noNote);
  const notesHtml = `<div class="dash-card"><h3>${tr('stats.notes.title')} ${s.notes.avg != null ? `<span class="muted">${tr('stats.notes.avg', { avg: s.notes.avg })}</span>` : ''}</h3>${dashCap('stats.help.notes')}
    <div class="hbars">
      ${/* `is-zero` retire le `min-width` : à 0, la barre dessinait un moignon coloré de 2 px,
           qui se lit comme « il y en a un peu » alors qu'il n'y en a aucun. */''}
      ${s.notes.buckets.map((b, i) => `<div class="hbar"><span class="hbar-lbl">${b.label}</span><div class="hbar-track"><div class="hbar-fill${b.count ? '' : ' is-zero'}" style="width:${(b.count / maxB) * 100}%;background:${noteColors[i]}"></div></div><span class="hbar-val">${b.count}</span></div>`).join('')}
      <div class="hbar"><span class="hbar-lbl muted">${tr('stats.notes.none')}</span><div class="hbar-track"><div class="hbar-fill${s.notes.noNote ? '' : ' is-zero'}" style="width:${(s.notes.noNote / maxB) * 100}%;background:var(--line)"></div></div><span class="hbar-val">${s.notes.noNote}</span></div>
    </div></div>`;

  // Tendance de la note : l'évolution hebdo, la question « la qualité progresse-t-elle ? ».
  // Défensif : si le serveur ne renvoie pas encore ce champ (version antérieure),
  // le bloc est simplement omis plutôt que de faire planter tout le dashboard.
  const scoreTrend = s.scoreTrend || [];
  const trendHtml = !scoreTrend.length ? '' : `<div class="dash-card"><h3>${tr('stats.trend.title')}</h3>${dashCap('stats.help.trend')}
    <div class="vbars">${scoreTrend.map((w) => w.avg == null
      ? `<div class="vbar vbar-empty" title="${tr('stats.trend.no-data', { week: w.week })}"></div>`
      : `<div class="vbar" title="${tr('stats.trend.tooltip', { week: w.week, avg: w.avg, count: w.count })}"><div class="vbar-fill ${w.avg >= 7 ? 'vf-good' : w.avg >= 4 ? 'vf-mid' : 'vf-bad'}" style="height:${(w.avg / 10) * 100}%"></div><span class="vbar-val">${w.avg}</span></div>`).join('')}</div>
    ${/* Une semaine sans review n'est pas une semaine à zéro : sa date passe en gris pâle et
          le dit avec des mots, plutôt que de laisser une colonne vide se lire comme un creux. */''}
    <div class="vbars-x">${scoreTrend.map((w) => `<span${w.avg == null ? ` class="no-data" title="${esc(tr('stats.trend.no-data', { week: w.week }))}"` : ''}>${w.week.slice(8, 10)}-${w.week.slice(5, 7)}</span>`).join('')}</div></div>`;

  /* LES RETOUCHES — « combien de défauts passent malgré un rapport au vert », avec un chiffre : par
     tranche de note, la part des MR mergées dont une autre MR a réécrit le code dans les N jours. La
     phrase d'en-tête dit sa fenêtre et sa nature de plancher ; le dénominateur exclut les MR mergées
     depuis moins de N jours ; jamais une colonne par auteur. Chaque ligne de la liste est une porte. */
  const fx = s.fixLinks || null;
  const pct = (v) => (v == null ? '—' : `${Number(v).toLocaleString(I18Nrt.currentLocale(), { maximumFractionDigits: 1 })} %`);
  const nombre = (v) => (v == null ? '—' : String(v));
  const joursF = (d) => (d == null ? '—' : tr('stats.cycle.days', { n: d }));
  const ligneFix = (r, libelle) => `<tr><td>${libelle}</td><td>${r.merged}</td><td>${r.touched}</td><td>${r.bug}</td><td>${pct(r.share)}</td><td>${joursF(r.median_days)}</td><td>${nombre(r.median_lines)}</td></tr>`;
  const enteteFix = `<thead><tr><th>${esc(tr('stats.fix.col.tranche'))}</th><th>${esc(tr('stats.fix.col.merged'))}</th><th>${esc(tr('stats.fix.col.touched'))}</th><th>${esc(tr('stats.fix.col.bug'))}</th><th>${esc(tr('stats.fix.col.share'))}</th><th>${esc(tr('stats.fix.col.median-days'))}</th><th>${esc(tr('stats.fix.col.median-lines'))}</th></tr></thead>`;
  const refFix = (p) => (p.fix.id ? `!${p.fix.iid}` : `${String(p.fix.sha || '').slice(0, 7)} · ${tr('stats.fix.list.hotfix')}`);
  const kindFix = (p) => (p.status === 'dismissed' ? tr('mr.fix.dismissed') : p.kind === 'revert' ? tr('mr.fix.signal.revert') : p.kind === 'manual' ? tr('mr.fix.signal.manual') : tr('mr.fix.signal.rewrites'));
  const fixHtml = !fx ? '' : `<div class="dash-card" id="dashFix"><h3>${tr('stats.fix.title')}</h3>${dashCap('stats.fix.help')}
    ${!fx.enabled ? `<p class="muted">${esc(tr('stats.fix.disabled'))}</p>` : !fx.merged ? `<p class="muted">${esc(tr('stats.fix.empty'))}</p>` : `
    <p class="stats-fix-summary">${esc(tr('stats.fix.summary', {
    merged: fx.merged, touched: fx.touched, bug: fx.bug, window: fx.window,
    share: Number(fx.share || 0).toLocaleString(I18Nrt.currentLocale(), { maximumFractionDigits: 1 }),
    bugShare: Number(fx.bug_share || 0).toLocaleString(I18Nrt.currentLocale(), { maximumFractionDigits: 1 }),
    period: statsJours ? tr('stats.fix.summary-period', { from: fmtDate(new Date(Date.now() - statsJours * 86400000).toISOString()) }) : tr('stats.fix.summary-all'),
  }))}</p>
    <p class="muted dash-floor">${esc(tr('stats.fix.floor'))}${fx.pending ? ` ${esc(tr('stats.fix.pending', { n: fx.pending, count: fx.pending, window: fx.window }))}` : ''}${fx.unscanned ? ` ${esc(tr('stats.fix.unscanned', { n: fx.unscanned, count: fx.unscanned }))}` : ''}</p>
    <h4>${esc(tr('stats.fix.table.title'))}</h4>
    <div class="md-tablewrap"><table class="md-table stats-fix-table">${enteteFix}<tbody>${fx.tranches.map((r) => ligneFix(r, esc(tr(`stats.fix.tranche.${r.tranche}`)))).join('')}</tbody></table></div>
    ${fx.repos.length ? `<details class="stats-fix-repos"><summary>${esc(tr('stats.fix.by-repo'))}</summary>
      <div class="md-tablewrap"><table class="md-table">${enteteFix}<tbody>${fx.repos.map((r) => ligneFix(r, `<button type="button" class="stat-porte" data-stat-projet="${esc(r.project)}" data-stat-seg="reviewed" title="${esc(tr('stats.fix.go'))}">${esc(r.project)}</button>`)).join('')}</tbody></table></div></details>` : ''}
    <h4>${esc(tr('stats.fix.list.title'))}</h4>
    ${fx.links.length ? `<div class="md-tablewrap"><table class="md-table stats-fix-list"><tbody>${fx.links.map((p) => `<tr>
        <td><button type="button" class="lien-reglage" data-stat-mr="${p.origin.id}" title="${esc(tr('stats.fix.go'))}">!${esc(String(p.origin.iid))}</button> ${esc(p.origin.title)}<div class="muted">${esc(p.origin.project)}${p.origin.note != null ? ` · ${esc(fmtNote10(p.origin.note * 10))}` : ''}</div></td>
        <td>${esc(refFix(p))}<div class="fix-kind">${esc(kindFix(p))}${p.bug_qualified ? ` · ${esc(tr('stats.fix.col.bug'))}` : ''}${p.large ? ` · ${esc(tr('mr.fix.large'))}` : ''}</div></td>
        <td class="stats-top-tok">${esc(joursF(p.days))}</td>
        <td class="muted">${p.lines ? esc(tr('mr.fix.panel.lines', { n: p.lines, files: p.files, count: p.lines })) : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : `<p class="muted">${esc(tr('stats.fix.list.empty'))}</p>`}`}
  </div>`;

  /* A/Stats 3 — LE TAUX DE VERT PAR DÉPÔT. Un verdict se lit une merge request à la fois ;
     « quel dépôt casse le plus ? » n'avait pas de réponse. Les moins verts en tête : c'est
     là qu'il y a quelque chose à faire. */
  const vpd = s.verifsParDepot || [];
  const vpdHtml = `<div class="dash-card"><h3>${tr('stats.verifs.title')}</h3>${dashCap('stats.verifs.help')}
    ${vpd.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${vpd.map((v) => `<tr>
        <td>${esc(v.project)}</td>
        <td class="stats-top-tok">${esc(String(v.taux))} %</td>
        <td class="muted">${esc(tr('stats.verifs.detail', { verts: v.verts, total: v.total }))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.verifs.empty'))}</p>`}</div>`;

  /* LES CONSTATS QUI REVIENNENT — et le geste qui les fait cesser : en faire une règle de
     review, écrite une fois, plutôt que de la retaper dans chaque merge request. */
  const rec = s.recurrents || [];
  const recHtml = `<div class="dash-card"><h3>${tr('stats.recurring.title')}</h3>${dashCap('stats.recurring.help')}
    ${rec.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${rec.map((r) => `<tr>
        <td>${esc(r.project)}</td>
        <td>${esc(r.title)}<div class="muted stats-rec-files">${r.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div></td>
        <td>${esc(tr('stats.recurring.count', { n: r.count, count: r.count }))}</td>
        <td><button type="button" class="btn btn-sm" data-rec-rule="${esc(r.title)}" data-rec-files="${esc(r.files.join(','))}" data-rec-project="${esc(r.project)}">${esc(tr('stats.recurring.rule'))}</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.recurring.empty'))}</p>`}</div>`;

  /* LES MÊMES CONSTATS, TOUS DÉPÔTS CONFONDUS — un constat qui n'atteint 3 dans AUCUN dépôt
     pris seul mais s'y répète collectivement. Pas de fichiers ni de `path_match` proposé (ils
     n'ont pas de préfixe commun entre deux dépôts) : le bouton prépare une règle GLOBALE. */
  const recCross = s.recurrentsCross || [];
  const recCrossHtml = `<div class="dash-card"><h3>${tr('stats.recurring-cross.title')}</h3>${dashCap('stats.recurring-cross.help')}
    ${recCross.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${recCross.map((r) => `<tr>
        <td>${esc(r.title)}<div class="muted stats-rec-files">${r.projects.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div></td>
        <td>${esc(tr('stats.recurring.count', { n: r.count, count: r.count }))} · ${esc(tr('stats.recurring-cross.repos', { n: r.projects.length, count: r.projects.length }))}</td>
        <td><button type="button" class="btn btn-sm" data-rec-rule="${esc(r.title)}">${esc(tr('stats.recurring.rule'))}</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.recurring-cross.empty'))}</p>`}</div>`;

  return `<div class="dash-grid">${notesHtml}${trendHtml}</div>` + fixHtml
    + `<div class="dash-grid">${vpdHtml}${recHtml}${recCrossHtml}</div>`;
}
