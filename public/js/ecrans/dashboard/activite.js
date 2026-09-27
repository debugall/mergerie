'use strict';
/* Détail d'activité d'un projet sur 12 mois. */
/* ---------- Détail d'activité d'un projet sur 12 mois ----------
   Six mois répondent à « qui bouge ? », douze à « dans quel sens ? » : un dépôt calme depuis
   deux mois après dix mois soutenus ne raconte pas la même chose qu'un dépôt éteint depuis un
   an, et la vue d'ensemble ne peut pas les distinguer. */
async function ouvrirActiviteProjet(repoId) {
  const modale = $('#activityModal');
  const corps = $('#activityBody');
  if (!modale || !corps) return;
  $('#activityTitle').textContent = tr('stats.activity.detail.loading');
  corps.innerHTML = skeleton(3);
  modale.hidden = false;
  let d;
  try { d = await api(`/dashboard/activity/${repoId}`); }
  catch (e) { corps.innerHTML = errorBox(explainError(e.message)); return; }

  const libelle = (m) => {
    const [a, mm] = m.split('-');
    return new Date(Date.UTC(Number(a), Number(mm) - 1, 1))
      .toLocaleDateString(I18Nrt.currentLocale(), { month: 'short', year: '2-digit', timeZone: 'UTC' });
  };
  $('#activityTitle').textContent = tr('stats.activity.detail.title', { project: d.project });
  const maxi = Math.max(1, ...d.days);
  const barres = d.months.map((m, i) => {
    const encours = i === d.months.length - 1;
    const t = `${libelle(m)} — ${tr('stats.activity.tip-line', { days: d.days[i], commits: d.counts[i] })}`
      + (d.authors[i] ? ` · ${tr('stats.activity.authors-tip', { n: d.authors[i], count: d.authors[i] })}` : '')
      + (encours ? ` — ${tr('stats.activity.partial-month')}` : '');
    return `<div class="ad-col" title="${esc(t)}">
        <span class="ad-val">${d.days[i] || ''}</span>
        <span class="ad-bar${d.days[i] === 0 ? ' vide' : ''}${encours ? ' encours' : ''}" style="height:${(d.days[i] / maxi) * 100}%"></span>
        <span class="ad-x">${esc(libelle(m))}${encours ? '*' : ''}</span>
      </div>`;
  }).join('');

  const tuile = (val, lbl) => `<div class="stat-tile"><div class="stat-val">${val}</div><div class="stat-lbl">${esc(lbl)}</div></div>`;
  corps.innerHTML = `<div class="stat-row">
      ${tuile(fmtNum(d.totalDays), tr('stats.activity.detail.days'))}
      ${tuile(fmtNum(d.total), tr('stats.activity.detail.commits'))}
      ${tuile(d.contributeurs || '—', tr('stats.activity.detail.authors'))}
    </div>
    <div class="ad-chart">${barres}</div>
    ${/* Les repères, joints proprement : un projet sans activité n'a ni « mois le plus actif »
          ni « dernière activité », et la phrase ne doit pas commencer par un séparateur. */''}
    <p class="muted ad-facts">${[
    d.meilleurMois ? tr('stats.activity.detail.best', { month: libelle(d.meilleurMois) }) : '',
    d.dernierActif ? tr('stats.activity.detail.last', { month: libelle(d.dernierActif) }) : tr('stats.activity.detail.never'),
  ].filter(Boolean).join(' · ')}</p>
    ${d.erreur ? errorBox(d.erreur) : ''}
    <p class="muted dash-floor">* ${tr('stats.activity.partial-month')}${d.partiel ? ` · ${tr('stats.activity.truncated', { n: 1, count: 1 })}` : ''}</p>`;
}

