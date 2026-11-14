'use strict';
/* Statistiques → Vue d'ensemble : le bandeau d'indicateurs, le Top 5 de la forge, l'activité des projets. */
/* ---------- Vue d'ensemble ----------
   « Où en est l'équipe ? » en un écran : six tuiles, puis ce que la forge dit de l'activité
   récente. Les trois premières sont l'entonnoir — un état courant, jamais borné par la période —,
   les trois suivantes résument chacune un sous-onglet et y mènent : la note moyenne et la part
   de merge requests retouchées (Qualité), les tokens de la période (Coût). */
function dashApercuHtml(s) {
  /* Une tuile-porte est un bouton — focalisable, Entrée l'active — avec les mêmes classes qu'une
     tuile ordinaire, pour que la lecture et les tests ne voient qu'une tuile. */
  const porte = (label, value, cls, data, title) => `<button type="button" class="stat-tile stat-tile-porte ${cls}" ${data} title="${esc(title)}"><span class="stat-val">${value}</span><span class="stat-lbl">${esc(label)}</span></button>`;
  const fx = s.fixLinks || null;
  const partFix = fx && fx.enabled && fx.merged
    ? `${Number(fx.share || 0).toLocaleString(I18Nrt.currentLocale(), { maximumFractionDigits: 1 })} %` : '—';
  const tk = s.tokens || { total: 0 };
  const kpi = `<div class="stat-row dash-kpi" id="dashKpi">
    ${porte(tr('stats.funnel.to-review'), s.funnel.to_review, 'amber', 'data-kpi-seg="to_review"', tr('stats.kpi.go-reviews'))}
    ${porte(tr('stats.funnel.reviewed'), s.funnel.reviewed, 'accent', 'data-kpi-seg="reviewed"', tr('stats.kpi.go-reviews'))}
    ${porte(tr('stats.funnel.done'), s.funnel.done, 'green', 'data-kpi-seg="done"', tr('stats.kpi.go-reviews'))}
    ${porte(tr('stats.kpi.avg'), s.notes && s.notes.avg != null ? `${s.notes.avg}/10` : '—', '', 'data-stats-go="qualite"', tr('stats.sub.qualite-title'))}
    ${porte(tr('stats.kpi.fix'), partFix, '', 'data-stats-go="qualite"', tr('stats.sub.qualite-title'))}
    ${porte(tr('stats.kpi.tokens'), tk.total ? fmtNum(tk.total) : '—', '', 'data-stats-go="cout"', tr('stats.sub.cout-title'))}
  </div>`;
  return kpi
    + `<div id="dashTop5" class="dash-card">${skeleton(2)}</div>`
    + `<div id="dashActivity" class="dash-card">${skeleton(3)}</div>`;
}

/* Les deux cartes de la forge se chargent à part : elles ne doivent ni ralentir l'écran ni le
   faire échouer quand GitLab est injoignable — et six mois d'historique se paginent. */
function dashApercuBrancher() {
  fillDashboardCommits();
  fillDashboardActivity();
}

/* Activité des projets sur six mois — un petit graphe PAR PROJET plutôt qu'un empilement.

   Le nombre de commits ne se compare pas d'un projet à l'autre : celui qui squash en fait un
   par merge request, celui qui ne squash pas en fait quarante pour le même travail. Ce qui se
   lit, c'est la FORME de chaque projet dans le temps — et un empilement écraserait de toute
   façon tous les petits derrière le plus gros. Chaque ligne a donc sa propre échelle, et
   l'ordre (du plus actif au plus calme) porte la comparaison. */
async function fillDashboardActivity() {
  const el = $('#dashActivity');
  if (!el) return;
  let d;
  try { d = await api('/dashboard/activity'); }
  catch { el.innerHTML = `<h3>${tr('stats.activity.title')}</h3><p class="muted">${tr('stats.top5.unavailable')}</p>`; return; }
  if (!$('#dashboard')) return;

  const mois = d.months || [];
  const projets = d.projects || [];
  const entete = `<h3>${tr('stats.activity.title')}</h3><p class="dash-help">${tr('stats.activity.help')}</p>`;
  if (!d.configured) { el.innerHTML = `${entete}<p class="muted">${tr('stats.top5.not-configured')}</p>`; return; }
  if (!projets.length) { el.innerHTML = `${entete}<p class="muted">${tr('stats.activity.empty')}</p>`; return; }

  const libelleMois = (m) => {
    const [a, mm] = m.split('-');
    return new Date(Date.UTC(Number(a), Number(mm) - 1, 1))
      .toLocaleDateString(I18Nrt.currentLocale(), { month: 'short', timeZone: 'UTC' });
  };
  /* Endormi : rien sur les DEUX derniers mois. Un seul mois creux arrive à tout le monde
     (congés, mise en production), deux dessinent une pente. Ils restent à l'écran — c'est
     précisément ce qu'on vient chercher, et une barre au ras du sol le dit mieux qu'un texte. */
  const endormi = (p) => p.counts.slice(-2).every((n) => n === 0);

  /* UNE barre par projet, hauteur = JOURS ACTIFS des six mois — les journées où au moins un
     commit est tombé. Le nombre de commits mesurerait surtout le style : squasher ou non
     change le compte du simple au quarantuple pour le même travail, et un dépôt gonflé
     écraserait tous les autres. Une journée travaillée, elle, veut dire la même chose
     partout, et la mesure est bornée (une vingtaine de jours ouvrés par mois) donc
     comparable d'un dépôt à l'autre. Les commits restent dans l'infobulle.

     La barre est EMPILÉE par mois, du plus ancien (pâle) au plus récent (plein) : la hauteur
     donne le volume, le dégradé dit si l'activité est récente ou ancienne — un projet actif
     cinq mois plus tôt n'est pas dans le même état qu'un projet actif aujourd'hui. */
  const maxi = Math.max(1, ...projets.map((p) => p.totalDays));
  const court = (nom) => (nom.includes('/') ? nom.slice(nom.lastIndexOf('/') + 1) : nom);

  const barre = (p) => {
    const dort = endormi(p);
    // Le détail montre les deux : les jours portent la barre, les commits éclairent.
    const detail = mois.map((m, i) => `${libelleMois(m)} ${tr('stats.activity.tip-line', { days: p.days[i], commits: p.counts[i] })}`).join('\n');
    const infobulle = `${p.project} — ${tr('stats.activity.total-tip', { n: p.totalDays, count: p.totalDays })}`
      + `\n${tr('stats.activity.commits-tip', { n: p.total, count: p.total })}`
      + (p.contributeurs ? ` · ${tr('stats.activity.authors-tip', { n: p.contributeurs, count: p.contributeurs })}` : '')
      + `\n\n${detail}`
      + (p.erreur ? `\n\n⚠ ${p.erreur}` : '')
      + (dort ? `\n\n${tr('stats.activity.asleep-tip')}` : '');
    /* Barres HORIZONTALES : le temps se lit de gauche à droite, du plus ancien au plus récent.
       Une couleur par mois — repérer « avril » demandait sinon de compter les segments. */
    const segments = p.days.map((n, i) => (n === 0 ? '' : `<span class="pab-seg" style="width:${(n / maxi) * 100}%;--c:var(--mois-${i + 1})"
        title="${esc(`${libelleMois(mois[i])} — ${tr('stats.activity.tip-line', { days: n, commits: p.counts[i] })}`)}"></span>`)).join('');
    /* TOUTE la colonne est le bouton — barre comprise, pas seulement le nom : viser trois
       lignes de texte de dix pixels est un geste inutilement précis quand la barre au-dessus
       désigne déjà le projet. Un `<button>` natif plutôt qu'un div cliquable : il se
       focalise au clavier, s'active à Entrée, et se lit correctement à voix haute — d'où
       l'`aria-label`, qui porte ce que l'infobulle ne dit qu'à la souris. */
    const resume = `${p.project} — ${tr('stats.activity.total-tip', { n: p.totalDays, count: p.totalDays })}, `
      + `${tr('stats.activity.commits-tip', { n: p.total, count: p.total })}`
      + (dort ? `. ${tr('stats.activity.asleep-tip')}` : '');
    /* Une LIGNE par projet : le nom tient en entier à gauche, ce qu'une colonne de 65 px ne
       permettait pas — à vingt projets, tous les libellés finissaient tronqués. La hauteur du
       graphe est bornée et défile : la liste peut s'allonger sans repousser le reste de la page. */
    return `<button type="button" class="pab${dort ? ' dort' : ''}" data-pab-detail="${p.repo_id}"
      title="${esc(infobulle)}" aria-label="${esc(`${resume}. ${tr('stats.activity.detail-title', { project: p.project })}`)}">
      <span class="pab-name" title="${esc(p.project)}">${esc(court(p.project))}</span>
      <span class="pab-stack">${segments}</span>
      <span class="pab-val">${p.totalDays ? fmtNum(p.totalDays) : '0'}</span>
    </button>`;
  };

  const dormants = projets.filter(endormi).length;
  const partiels = projets.filter((p) => p.partiel).length;
  el.innerHTML = entete
    + `<div class="pab-chart" role="group" aria-label="${esc(tr('stats.activity.title'))}">${projets.map(barre).join('')}</div>`
    // Légende : chaque mois avec sa pastille, dans l'ordre du graphe.
    + `<div class="pab-legend">
        ${mois.map((m, i) => `<span class="pab-mois"><span class="pab-key" style="--c:var(--mois-${i + 1})"></span>${esc(libelleMois(m))}${i === mois.length - 1 ? '*' : ''}</span>`).join('')}
        ${dormants ? `<span class="pab-legend-sleep"><span class="pab-key dort"></span>${esc(tr('stats.activity.asleep-group', { n: dormants, count: dormants }))}</span>` : ''}
      </div>`
    + (partiels ? `<p class="muted dash-floor">${tr('stats.activity.truncated', { n: partiels, count: partiels })}</p>` : '')
    + `<p class="muted dash-floor">* ${tr('stats.activity.partial-month')} · ${tr('stats.activity.note')}</p>`;

  // Le graphe est reconstruit à chaque visite de l'onglet : les écouteurs se reposent ici.
  $$('#dashActivity [data-pab-detail]', el).forEach((b2) =>
    b2.addEventListener('click', () => ouvrirActiviteProjet(Number(b2.dataset.pabDetail))));
}
