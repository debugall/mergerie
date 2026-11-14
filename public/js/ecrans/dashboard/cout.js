'use strict';
/* Statistiques → Coût : tokens par famille, sessions, reviews et agents les plus coûteux, envoyé contre reçu. */
/* ---------- Coût ----------
   « Combien ça coûte, et où ? » Le total est un minorant et le dit ; le reste désigne — la
   session, la review, l'agent, la famille d'appel — plutôt que de constater. */
function dashCoutHtml(s) {
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
  const tokHtml = tk.total ? `<div class="dash-card"><h3>${tr('stats.tokens.title')}</h3>${dashCap('stats.help.tokens')}
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${segs})"></div>
      <div class="donut-legend">${tk.byKind.map((r) => `<div class="donut-leg"><span class="dot" style="background:${KIND_COLOR[r.kind] || '#8b97ad'}"></span>${esc(kindLabel(r.kind))}<span class="spacer"></span><span class="muted">${fmtNum(r.tokens)} · ${Math.round((r.tokens / tk.total) * 100)}%</span></div>`).join('')}</div>
    </div>
    <div class="stat-row">${dashTile(tr('stats.tokens.avg-per-mr'), tk.avgPerReviewedMr != null ? fmtNum(tk.avgPerReviewedMr) : '—', 'accent')}${dashTile(tr('stats.tokens.total-label'), fmtNum(tk.total))}</div>
    <p class="muted dash-floor">${tr('stats.tokens.floor')}</p></div>` : '';

  /* LES SESSIONS LES PLUS COÛTEUSES. « Combien coûtent les sessions » ne dit pas lesquelles :
     ce classement-là se lit en une ligne par session, prompt tronqué, du plus cher au moins. */
  const top = s.topTasks || [];
  const topHtml = `<div class="dash-card"><h3>${tr('stats.top-tasks.title')}</h3>${dashCap('stats.top-tasks.help')}
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

  /* A/Stats 1 — LES REVIEWS LES PLUS CHÈRES, à côté des sessions : même question, autre
     famille. Chaque ligne mène à son rapport, comme partout ailleurs un nombre est une porte. */
  const tr5 = s.topReviews || [];
  const trevHtml = `<div class="dash-card"><h3>${tr('stats.top-reviews.title')}</h3>${dashCap('stats.top-reviews.help')}
    ${tr5.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${tr5.map((x) => `<tr>
        <td class="stats-top-tok">${esc(fmtNum(x.tokens))}</td>
        <td><button type="button" class="lien-reglage" data-stat-mr="${x.id}">!${esc(String(x.iid))}</button> ${esc(x.title)}
          <div class="muted">${esc(x.project)}</div></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.top-reviews.empty'))}</p>`}</div>`;

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

  /* Les familles d'appels que le tableau sait nommer. */
  // Les familles qu'on sait nommer ; une inconnue s'affiche telle quelle (cf. plus bas).
  const STATS_KIND = ['review', 'task', 'explore', 'ask', 'explain', 'modify', 'question'];

  /* A/Stats 2 — CE QU'ON ENVOIE CONTRE CE QU'ON REÇOIT. Deux colonnes écrites depuis toujours,
     lues par personne : un ratio qui s'envole désigne un gabarit ou un dépôt lié, pas une
     dépense inévitable. */
  const rat = s.ratio || [];

  const ratHtml = `<div class="dash-card"><h3>${tr('stats.ratio.title')}</h3>${dashCap('stats.ratio.help')}
    ${rat.length ? `<div class="md-tablewrap"><table class="md-table"><tbody>${rat.map((r) => `<tr>
        ${/* Une famille inconnue (une future saveur d'appel) doit s'afficher telle quelle :
              `tr` rend la CLÉ quand elle manque, ce qui donnerait « stats.kind.xxx » à
              l'écran. On ne traduit donc que ce qu'on connaît. */''}
        <td>${esc(STATS_KIND.includes(r.kind) ? tr(`stats.kind.${r.kind}`) : r.kind)}</td>
        <td class="stats-top-tok">${esc(String(r.ratio))}×</td>
        <td class="muted">${esc(tr('stats.ratio.detail', { entree: fmtNum(r.entree), sortie: fmtNum(r.sortie), n: r.n }))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">${esc(tr('stats.ratio.empty'))}</p>`}</div>`;

  return tokHtml + `<div class="dash-grid">${topHtml}${trevHtml}${agHtml}${ratHtml}</div>`;
}

/* Les portes du coût par agent : une ligne mène aux sessions de l'agent, sans quoi on relisait
   des chiffres qu'on ne pouvait pas suivre. */
function dashCoutBrancher() {
  $$('#dashboard [data-go-agent]').forEach((b) => b.addEventListener('click', async () => {
    if (!agents.length) await chargerAgents();
    const a = agents.find((x) => x.name === b.dataset.goAgent);
    if (a) ouvrirSessionsAgent(a);
    else { navTab('task'); poserFiltreAgent(0); loadTasks(); }
  }));
}
