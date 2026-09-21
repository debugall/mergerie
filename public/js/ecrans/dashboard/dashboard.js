'use strict';
/* Dashboard : d'un constat qui revient à une règle de review, A36 la période et le dépôt, activité par projet. */
// @expose loadDashboard
/* ---------- Dashboard ---------- */
/* ---------- D'un constat qui revient à une règle de review ----------
   Quatrième merge request d'affilée où l'IA relève « le numéro de carte est loggé » : on
   retapait la consigne dans le contexte manuel de chacune. La règle s'écrit une fois. Le
   formulaire s'ouvre PRÉ-REMPLI et rien n'est enregistré sans clic — un `path_match` déduit de
   trois fichiers est une proposition, pas une vérité. */
function motifDepuisFichiers(fichiers) {
  const liste = (fichiers || []).filter(Boolean);
  if (!liste.length) return '';
  // Le plus long préfixe de RÉPERTOIRE commun : `src/checkout/**` plutôt que trois chemins.
  const parts = liste.map((f) => f.split('/').slice(0, -1));
  let commun = parts[0] || [];
  for (const p of parts.slice(1)) {
    let i = 0;
    while (i < commun.length && i < p.length && commun[i] === p[i]) i += 1;
    commun = commun.slice(0, i);
  }
  return commun.length ? `${commun.join('/')}/**` : liste.map((f) => f.split('/').pop()).join(',');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-rec-rule]');
  if (!b) return;
  navTab('admin');
  showAdminSub('rules');
  const f = $('#ruleForm');
  if (!f) return;
  f.reset();
  /* SANS FICHIERS (`data-rec-files` absent : un constat cross-dépôt), aucun préfixe ne se
     déduit — mais une règle a besoin d'AU MOINS un déclencheur (branche ou chemin), sans quoi
     le serveur la refuse. `**` (tout fichier, tout dossier) est le déclencheur honnête d'une
     règle qui ne s'est jamais voulue limitée à un chemin. */
  if (f.path_match) {
    f.path_match.value = 'recFiles' in b.dataset
      ? motifDepuisFichiers(String(b.dataset.recFiles || '').split(','))
      : '**';
  }
  if (f.label) f.label.value = b.dataset.recRule.slice(0, 60);
  if (f.content) f.content.value = b.dataset.recRule;
  f.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (f.content) f.content.focus({ preventScroll: true });
  /* LE CONSTAT CROSS-DÉPÔT NE NOMME AUCUN PROJET (`data-rec-project` absent) : la règle qu'il
     prépare vaut pour tous, et le dit plutôt que d'afficher un projet inventé. */
  toast(b.dataset.recProject
    ? tr('stats.recurring.prefilled', { project: b.dataset.recProject })
    : tr('stats.recurring-cross.prefilled'));
});

/* La porte d'un chiffre de statistiques : Reviews, au bon stade, filtré sur ce projet. On
   réutilise le champ de recherche de la file — c'est la même recherche, avec le même
   comportement, et l'on voit d'où vient le filtre plutôt que d'atterrir sur une liste
   mystérieusement raccourcie. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-stat-projet]');
  if (!b) return;
  navReviews(b.dataset.statSeg || 'to_review');
  const champ = $('#searchReview');
  if (champ) { champ.value = b.dataset.statProjet; champ.dispatchEvent(new Event('input')); }
});

/* A36 — LA PÉRIODE ET LE DÉPÔT du tableau de bord. Chaque bloc avait sa propre fenêtre, figée
   et différente des autres : huit semaines ici, vingt-huit jours là, tout l'historique
   ailleurs — donc rien de comparable, et aucune réponse à « et le mois dernier ? ». Le choix
   est une préférence d'écran, gardée par le navigateur comme le thème. */
const STATS_PERIODES = [0, 7, 30, 90];
let statsJours = (() => { try { return Number(localStorage.getItem('aidevtools_stats_jours')) || 0; } catch { return 0; } })();
let statsProjet = (() => { try { return localStorage.getItem('aidevtools_stats_projet') || ''; } catch { return ''; } })();

async function loadDashboard() {
  const el = $('#dashboard');
  el.innerHTML = skeleton(4);
  let s;
  const q = `?days=${statsJours}${statsProjet ? `&project=${encodeURIComponent(statsProjet)}` : ''}`;
  try { s = await api(`/stats${q}`); } catch (e) { el.innerHTML = errorBox(e.message); return; }
  /* Le combo des dépôts lit `repoOptions`, que d'autres écrans chargent : ouvert en premier,
     Stats n'offrait que « Tous les dépôts ». */
  if (!repoOptions.length) await loadRepoOptions();

  const tile = (label, value, cls = '') => `<div class="stat-tile ${cls}"><div class="stat-val">${value}</div><div class="stat-lbl">${esc(label)}</div></div>`;
  const noteBadge = (v) => (v == null ? '<span class="note none">—</span>' : `<span class="note ${v >= 7 ? 'good' : v >= 4 ? 'mid' : 'bad'}">${v}</span>`);
  // Légende d'utilité sous chaque titre : « à quelle question ce graphe répond ».
  const cap = (key) => `<p class="dash-help">${tr(key)}</p>`;

  const funnelHtml = `<div class="stat-row">
    ${tile(tr('stats.funnel.to-review'), s.funnel.to_review, 'amber')}
    ${tile(tr('stats.funnel.reviewed'), s.funnel.reviewed, 'accent')}
    ${tile(tr('stats.funnel.done'), s.funnel.done, 'green')}
  </div>`;

  const noteColors = ['#e05a5a', '#e0863a', '#e0a838', '#8fce7f', '#35c07f'];
  const maxB = Math.max(1, ...s.notes.buckets.map((b) => b.count), s.notes.noNote);
  const notesHtml = `<div class="dash-card"><h3>${tr('stats.notes.title')} ${s.notes.avg != null ? `<span class="muted">${tr('stats.notes.avg', { avg: s.notes.avg })}</span>` : ''}</h3>${cap('stats.help.notes')}
    <div class="hbars">
      ${/* `is-zero` retire le `min-width` : à 0, la barre dessinait un moignon coloré de 2 px,
           qui se lit comme « il y en a un peu » alors qu'il n'y en a aucun. */''}
      ${s.notes.buckets.map((b, i) => `<div class="hbar"><span class="hbar-lbl">${b.label}</span><div class="hbar-track"><div class="hbar-fill${b.count ? '' : ' is-zero'}" style="width:${(b.count / maxB) * 100}%;background:${noteColors[i]}"></div></div><span class="hbar-val">${b.count}</span></div>`).join('')}
      <div class="hbar"><span class="hbar-lbl muted">${tr('stats.notes.none')}</span><div class="hbar-track"><div class="hbar-fill${s.notes.noNote ? '' : ' is-zero'}" style="width:${(s.notes.noNote / maxB) * 100}%;background:var(--line)"></div></div><span class="hbar-val">${s.notes.noNote}</span></div>
    </div></div>`;

  const maxW = Math.max(1, ...s.weekly.map((w) => w.count));
  const weeklyHtml = `<div class="dash-card"><h3>${tr('stats.weekly.title')}</h3>${cap('stats.help.weekly')}
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
    <button type="button" id="statsExport" class="btn btn-sm btn-ghost" title="${esc(tr('stats.export.title'))}">${svgIco('download')}<span>${esc(tr('stats.export.btn'))}</span></button></h3>${cap('stats.help.proj')}
    <div class="md-tablewrap"><table class="md-table"><thead><tr><th>${tr('stats.col.project')}</th><th>${tr('stats.col.reviewed')}</th><th>${tr('stats.col.pending')}</th><th>${tr('stats.col.avg')}</th><th>${tr('stats.col.worst')}</th><th title="${esc(tr('stats.col.resolution-hint'))}">${tr('stats.col.resolution')}</th><th title="${esc(tr('stats.col.trend-hint'))}">${tr('stats.col.trend')}</th><th>${tr('stats.col.last-commit')}</th></tr></thead>
    ${/* CHAQUE NOMBRE EST UNE PORTE. Un tableau qui décrit sans donner de chemin fait relire
          des chiffres qu'on ne peut pas suivre : « pire 5,5 » et « en attente 3 » ouvrent
          Reviews sur CE projet, au bon stade. Les statistiques déclenchent le travail. */''}
    <tbody>${s.projects.length ? s.projects.map((p) => `<tr><td>${esc(p.project)}</td><td>${p.reviewed}</td><td>${p.pending ? `<button type="button" class="stat-porte" data-stat-projet="${esc(p.project)}" data-stat-seg="to_review" title="${esc(tr('stats.go.pending'))}">${p.pending}</button>` : ''}</td><td>${noteBadge(p.avg)}</td><td>${p.worst != null ? `<button type="button" class="stat-porte" data-stat-projet="${esc(p.project)}" data-stat-seg="reviewed" title="${esc(tr('stats.go.worst'))}">${noteBadge(p.worst)}</button>` : noteBadge(p.worst)}</td><td>${rateCell(p.resolution)}</td><td>${trendCell(p.trend)}</td><td class="dash-lastcommit" data-project="${esc(p.project)}"><span class="muted">…</span></td></tr>`).join('') : `<tr><td colspan="8" class="muted">${tr('stats.empty')}</td></tr>`}</tbody></table></div>
    ${s.resolution ? `<p class="muted stats-res-global">${tr('stats.resolution.global', { rate: s.resolution.rate, resolved: s.resolution.resolved, prior: s.resolution.prior })}</p>` : ''}</div>`;

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

  const t = s.tasks;
  const devHtml = `<div class="dash-card"><h3>${tr('stats.dev.title')}</h3>${cap('stats.help.dev')}<div class="stat-row">
    ${tile(tr('stats.dev.tasks'), t.total)}
    ${tile(tr('stats.dev.mr-created'), t.mrCreated, 'accent')}
    ${tile(tr('stats.dev.mr-merged'), t.mrMerged, 'green')}
    ${tile(tr('stats.dev.comments'), s.commentsPosted)}
  </div></div>`;

  // Tendance de la note : l'évolution hebdo, la question « la qualité progresse-t-elle ? ».
  // Défensif : si le serveur ne renvoie pas encore ce champ (version antérieure),
  // le bloc est simplement omis plutôt que de faire planter tout le dashboard.
  const scoreTrend = s.scoreTrend || [];
  const trendHtml = !scoreTrend.length ? '' : `<div class="dash-card"><h3>${tr('stats.trend.title')}</h3>${cap('stats.help.trend')}
    <div class="vbars">${scoreTrend.map((w) => w.avg == null
      ? `<div class="vbar vbar-empty" title="${tr('stats.trend.no-data', { week: w.week })}"></div>`
      : `<div class="vbar" title="${tr('stats.trend.tooltip', { week: w.week, avg: w.avg, count: w.count })}"><div class="vbar-fill ${w.avg >= 7 ? 'vf-good' : w.avg >= 4 ? 'vf-mid' : 'vf-bad'}" style="height:${(w.avg / 10) * 100}%"></div><span class="vbar-val">${w.avg}</span></div>`).join('')}</div>
    ${/* Une semaine sans review n'est pas une semaine à zéro : sa date passe en gris pâle et
          le dit avec des mots, plutôt que de laisser une colonne vide se lire comme un creux. */''}
    <div class="vbars-x">${scoreTrend.map((w) => `<span${w.avg == null ? ` class="no-data" title="${esc(tr('stats.trend.no-data', { week: w.week }))}"` : ''}>${w.week.slice(8, 10)}-${w.week.slice(5, 7)}</span>`).join('')}</div></div>`;

  // Tokens : où part le quota. Camembert par type (conic-gradient, pas de calcul d'arc)
  // + coût moyen par MR reviewée. Le total est un MINORANT, dit dans la légende.
  /* TOUTES les familles d'appel ont leur couleur et leur nom. `ask` (une question libre) et
     `question` (une question posée sur une revue) tombaient à côté des deux tables : le donut
     les affichait en gris, sous leur nom technique, à côté de familles nommées en clair. */
  const KIND_COLOR = { review: '#4f8cff', explain: '#35c07f', task: '#b47ce6', explore: '#e0a838', modify: '#e0863a', ask: '#3aa0e0', question: '#5ec8c0' };
  // Clés littérales (et non tr('stats.kind.'+k)) pour rester greppables — cf. i18n-check.
  const KIND_KEY = { review: 'stats.kind.review', explain: 'stats.kind.explain', modify: 'stats.kind.modify', task: 'stats.kind.task', explore: 'stats.kind.explore', ask: 'stats.kind.ask', question: 'stats.kind.question' };
  const kindLabel = (k) => (KIND_KEY[k] ? tr(KIND_KEY[k]) : k);
  const tk = s.tokens || { total: 0, byKind: [] };
  let accP = 0;
  const segs = tk.byKind.map((r) => { const from = (accP / tk.total) * 100; accP += r.tokens; const to = (accP / tk.total) * 100; return `${KIND_COLOR[r.kind] || '#8b97ad'} ${from}% ${to}%`; }).join(', ');
  const tokHtml = tk.total ? `<div class="dash-card"><h3>${tr('stats.tokens.title')}</h3>${cap('stats.help.tokens')}
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${segs})"></div>
      <div class="donut-legend">${tk.byKind.map((r) => `<div class="donut-leg"><span class="dot" style="background:${KIND_COLOR[r.kind] || '#8b97ad'}"></span>${esc(kindLabel(r.kind))}<span class="spacer"></span><span class="muted">${fmtNum(r.tokens)} · ${Math.round((r.tokens / tk.total) * 100)}%</span></div>`).join('')}</div>
    </div>
    <div class="stat-row">${tile(tr('stats.tokens.avg-per-mr'), tk.avgPerReviewedMr != null ? fmtNum(tk.avgPerReviewedMr) : '—', 'accent')}${tile(tr('stats.tokens.total-label'), fmtNum(tk.total))}</div>
    <p class="muted dash-floor">${tr('stats.tokens.floor')}</p></div>` : '';

  /* LES SESSIONS LES PLUS COÛTEUSES. « Combien coûtent les sessions » ne dit pas lesquelles :
     ce classement-là se lit en une ligne par session, prompt tronqué, du plus cher au moins. */
  const top = s.topTasks || [];
  const topHtml = `<div class="dash-card"><h3>${tr('stats.top-tasks.title')}</h3>${cap('stats.top-tasks.help')}
    ${/* A36 — CHAQUE LIGNE EST UNE PORTE. Les cinq sessions les plus chères se lisaient sans
          pouvoir les OUVRIR : on retenait le début du prompt et on allait le chercher dans
          Dev IA. Le classement se lit en TOKENS, comme l'écran Agents : un montant en dollars
          n'existe que sur les backends qui l'annoncent et ne se compare pas d'un mois à
          l'autre quand les tarifs bougent. */''}
    ${top.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${top.map((x) => `<tr>
        <td class="stats-top-tok">${esc(fmtNum(x.tokens))}</td>
        <td><button type="button" class="stat-porte" data-go-session="${x.id}" data-go-kind="${esc(x.kind === 'local' ? 'local' : (x.kind === 'ask' ? 'ask' : (x.saveur === 'explore' ? 'explore' : 'code')))}"
          title="${esc(tr('stats.go.session'))}">${esc(x.label || x.prompt)}</button></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.top-tasks.empty'))}</p>`}</div>`;

  /* LE COÛT PAR AGENT. Un agent tourne plusieurs fois — à la main, puis sur horaire — et
     c'est la SOMME qui compte : « le documentaliste coûte tant par mois » est une phrase
     qu'aucune ligne de session ne donne. La carte n'existe que s'il y a eu des runs d'agent :
     une section à zéro n'apprend rien à qui n'en utilise pas. */
  const ag = s.agentCosts || [];
  const agHtml = ag.length ? `<div class="dash-card"><h3>${tr('agents.stats.title')}</h3>
    <div class="md-tablewrap"><table class="md-table"><tbody>${ag.map((x) => `<tr>
        <td class="stats-top-tok">${esc(fmtNum(x.tokens))}</td>
        <td><button type="button" class="stat-porte" data-go-agent="${esc(x.name)}" title="${esc(tr('stats.go.agent'))}">${esc(x.name)}</button>
          <div class="muted">${esc(tr('agents.stats.runs', { n: x.runs, count: x.runs }))}</div></td>
      </tr>`).join('')}</tbody></table></div></div>` : '';

  /* A37 — LE DÉLAI DE CYCLE : combien de temps une merge request met à passer, et OÙ le temps
     part — avant la première review, ou après. C'est la seule mesure qui répond à « est-ce que
     l'outil me fait aller plus vite ? », et les trois dates étaient en base depuis toujours.
     Médiane, et seulement sur les MR ALLÉES AU BOUT : une moyenne se fait emporter par la MR
     oubliée trois mois, et compter les MR encore ouvertes ferait baisser le chiffre à chaque
     nouvelle arrivée. */
  const cyc = s.cycle;
  const dureeH = (h) => (h == null ? '—' : (h < 48 ? tr('stats.cycle.hours', { n: Math.round(h) }) : tr('stats.cycle.days', { n: Math.round(h / 24 * 10) / 10 })));
  const cycHtml = !cyc ? '' : `<div class="dash-card"><h3>${tr('stats.cycle.title')}</h3>${cap('stats.cycle.help')}
    <div class="stat-row">
      ${tile(tr('stats.cycle.total'), dureeH(cyc.total_h), 'accent')}
      ${tile(tr('stats.cycle.to-review'), dureeH(cyc.to_review_h))}
      ${tile(tr('stats.cycle.to-merge'), dureeH(cyc.to_merge_h))}
    </div>
    <p class="muted">${esc(tr('stats.cycle.count', { n: cyc.n, count: cyc.n }))}</p>
    ${(cyc.projets || []).length > 1 ? `<div class="md-tablewrap"><table class="md-table"><thead><tr>
        <th>${esc(tr('stats.col.project'))}</th><th>${esc(tr('stats.cycle.total'))}</th>
        <th>${esc(tr('stats.cycle.to-review'))}</th><th>${esc(tr('stats.cycle.to-merge'))}</th><th>${esc(tr('stats.cycle.n'))}</th></tr></thead>
      <tbody>${cyc.projets.map((p) => `<tr><td>${esc(p.project)}</td><td>${esc(dureeH(p.total_h))}</td>
        <td>${esc(dureeH(p.to_review_h))}</td><td>${esc(dureeH(p.to_merge_h))}</td><td>${p.n}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;

  /* LES CONSTATS QUI REVIENNENT — et le geste qui les fait cesser : en faire une règle de
     review, écrite une fois, plutôt que de la retaper dans chaque merge request. */
  const rec = s.recurrents || [];
  const recHtml = `<div class="dash-card"><h3>${tr('stats.recurring.title')}</h3>${cap('stats.recurring.help')}
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
  const recCrossHtml = `<div class="dash-card"><h3>${tr('stats.recurring-cross.title')}</h3>${cap('stats.recurring-cross.help')}
    ${recCross.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${recCross.map((r) => `<tr>
        <td>${esc(r.title)}<div class="muted stats-rec-files">${r.projects.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div></td>
        <td>${esc(tr('stats.recurring.count', { n: r.count, count: r.count }))} · ${esc(tr('stats.recurring-cross.repos', { n: r.projects.length, count: r.projects.length }))}</td>
        <td><button type="button" class="btn btn-sm" data-rec-rule="${esc(r.title)}">${esc(tr('stats.recurring.rule'))}</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.recurring-cross.empty'))}</p>`}</div>`;

  /* A/Stats 1 — LES REVIEWS LES PLUS CHÈRES, à côté des sessions : même question, autre
     famille. Chaque ligne mène à son rapport, comme partout ailleurs un nombre est une porte. */
  const tr5 = s.topReviews || [];
  const trevHtml = `<div class="dash-card"><h3>${tr('stats.top-reviews.title')}</h3>${cap('stats.top-reviews.help')}
    ${tr5.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${tr5.map((x) => `<tr>
        <td class="stats-top-tok">${esc(fmtNum(x.tokens))}</td>
        <td><button type="button" class="lien-reglage" data-stat-mr="${x.id}">!${esc(String(x.iid))}</button> ${esc(x.title)}
          <div class="muted">${esc(x.project)}</div></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.top-reviews.empty'))}</p>`}</div>`;

  /* Les familles d'appels que le tableau sait nommer. */
  // Les familles qu'on sait nommer ; une inconnue s'affiche telle quelle (cf. plus bas).
  const STATS_KIND = ['review', 'task', 'explore', 'ask', 'explain', 'modify', 'question'];

  /* A/Stats 2 — CE QU'ON ENVOIE CONTRE CE QU'ON REÇOIT. Deux colonnes écrites depuis toujours,
     lues par personne : un ratio qui s'envole désigne un gabarit ou un dépôt lié, pas une
     dépense inévitable. */
  const rat = s.ratio || [];

  const ratHtml = `<div class="dash-card"><h3>${tr('stats.ratio.title')}</h3>${cap('stats.ratio.help')}
    ${rat.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${rat.map((r) => `<tr>
        ${/* Une famille inconnue (une future saveur d'appel) doit s'afficher telle quelle :
              `tr` rend la CLÉ quand elle manque, ce qui donnerait « stats.kind.xxx » à
              l'écran. On ne traduit donc que ce qu'on connaît. */''}
        <td>${esc(STATS_KIND.includes(r.kind) ? tr(`stats.kind.${r.kind}`) : r.kind)}</td>
        <td class="stats-top-tok">${esc(String(r.ratio))}×</td>
        <td class="muted">${esc(tr('stats.ratio.detail', { entree: fmtNum(r.entree), sortie: fmtNum(r.sortie), n: r.n }))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.ratio.empty'))}</p>`}</div>`;

  /* A/Stats 3 — LE TAUX DE VERT PAR DÉPÔT. Un verdict se lit une merge request à la fois ;
     « quel dépôt casse le plus ? » n'avait pas de réponse. Les moins verts en tête : c'est
     là qu'il y a quelque chose à faire. */
  const vpd = s.verifsParDepot || [];
  const vpdHtml = `<div class="dash-card"><h3>${tr('stats.verifs.title')}</h3>${cap('stats.verifs.help')}
    ${vpd.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${vpd.map((v) => `<tr>
        <td>${esc(v.project)}</td>
        <td class="stats-top-tok">${esc(String(v.taux))} %</td>
        <td class="muted">${esc(tr('stats.verifs.detail', { verts: v.verts, total: v.total }))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.verifs.empty'))}</p>`}</div>`;

  /* B14 — CE QUE GIT A FAIT. La dernière table de trace que cet écran ignorait. On montre le
     volume par action ET les échecs : c'est le rapport entre les deux qui apprend quelque
     chose — supprimer trente branches sans un échec est une routine saine, dix suppressions
     dont quatre refusées disent qu'on vise des branches protégées. Chaque ligne mène à
     l'historique, filtré sur son action. */
  const go = s.gitOps || { total: 0, errors: 0, byAction: [] };
  const goHtml = `<div class="dash-card"><h3>${tr('stats.gitops.title')}</h3>${cap('stats.gitops.help')}
    ${go.total ? `<p class="muted">${esc(tr('stats.gitops.total', { n: go.total, count: go.total }))}${go.errors ? ` · ${esc(tr('stats.gitops.errors', { n: go.errors, count: go.errors }))}` : ''}</p>
      <div class="md-tablewrap"><table class="md-table"><tbody>${go.byAction.map((a) => `<tr>
        <td>${esc(GIT_ACTION_LABEL()[a.action] || a.action)}</td>
        <td class="stats-top-tok">${esc(String(a.n))}</td>
        <td class="muted">${a.errors ? esc(tr('stats.gitops.errors', { n: a.errors, count: a.errors })) : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.gitops.empty'))}</p>`}</div>`;

  /* La barre de période, en tête : c'est elle qui donne son sens à tout ce qui suit. Le
     dépôt vient de la liste déjà chargée — pas d'appel de plus pour remplir un menu. */
  const barre = `<div class="dash-periode">
    <span class="muted">${esc(tr('stats.period.label'))}</span>
    ${STATS_PERIODES.map((j) => `<button type="button" class="chip${statsJours === j ? ' active' : ''}" data-stats-jours="${j}">${esc(j ? tr('stats.period.days', { n: j }) : tr('stats.period.all'))}</button>`).join('')}
    <span class="spacer"></span>
    ${/* Un combo À RECHERCHE, pas un `select` : la règle du projet vaut ici comme partout —
          une installation peut suivre quarante dépôts, et `npm run check` refuse la liste nue. */''}
    <div id="statsProjetBox" class="dash-projet">${comboHtml('statsProjetVal', {
    value: statsProjet, label: statsProjet, ph: tr('stats.period.all-projects'),
  })}</div>
  </div>`;

  el.innerHTML = barre + `<div id="dashTop5" class="dash-card">${skeleton(2)}</div>`
    + funnelHtml + `<div class="dash-grid">${notesHtml}${trendHtml}${weeklyHtml}${tokHtml}</div>`
    + `<div id="dashActivity" class="dash-card">${skeleton(3)}</div>` + projHtml + devHtml
    + cycHtml
    + `<div class="dash-grid">${topHtml}${trevHtml}${agHtml}${ratHtml}${vpdHtml}${goHtml}${recHtml}${recCrossHtml}</div>`;

  /* Les portes des statistiques : une ligne de tableau mène à l'objet qu'elle décrit. Sans
     elles, on relisait des chiffres qu'on ne pouvait pas suivre. */
  $$('#dashboard [data-go-agent]').forEach((b) => b.addEventListener('click', async () => {
    if (!agents.length) await chargerAgents();
    const a = agents.find((x) => x.name === b.dataset.goAgent);
    if (a) ouvrirSessionsAgent(a);
    else { navTab('task'); poserFiltreAgent(0); loadTasks(); }
  }));

  $$('#dashboard [data-stats-jours]').forEach((b) => b.addEventListener('click', () => {
    statsJours = Number(b.dataset.statsJours) || 0;
    try { localStorage.setItem('aidevtools_stats_jours', String(statsJours)); } catch { /* stockage indisponible */ }
    loadDashboard();
  }));
  const boxProjet = $('#statsProjetBox');
  if (boxProjet) {
    wireCombo(boxProjet, 'statsProjetVal', () => [
      { value: '', label: tr('stats.period.all-projects') },
      ...repoOptions.map((r) => ({ value: r.project, label: r.project })),
    ]);
    boxProjet.addEventListener('change', (e) => {
      if (!e.target.classList.contains('statsProjetVal')) return;
      statsProjet = e.target.value || '';
      try { localStorage.setItem('aidevtools_stats_projet', statsProjet); } catch { /* stockage indisponible */ }
      loadDashboard();
    });
  }

  onEl($('#statsExport'), 'click', () => {
    telecharger(new Blob([csvStats()], { type: 'text/csv;charset=utf-8' }),
      `mergerie-projets-${new Date().toISOString().slice(0, 10)}.csv`);
  });

  // Activité GitLab en direct (dernier commit par projet) : chargée à part pour ne pas
  // ralentir le dashboard ni le faire échouer si GitLab est injoignable.
  fillDashboardCommits();
  // Même raison, en plus marqué : six mois d'historique se paginent depuis la forge.
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

