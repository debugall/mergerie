'use strict';
/* Explorateur de branches, trouver une ref, historique et restauration. */
// @expose GIT_ACTION_LABEL, filtrerHistoriqueGit, gitAnalyze
/* ---- Explorateur de branches ---- */
/* La session qui a créé la branche mène À ELLE, pas à l'onglet : on arrivait sur Dev IA, sur
   le sous-onglet consulté la dernière fois, à charge de retrouver la session parmi douze. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-git-sess]');
  if (!b) return;
  ouvrirSession(b.dataset.gitSess, b.dataset.gitSessKind || 'code');
});

function gitOriginCell(b) {
  if (!b.origin) return '<span class="muted">—</span>';
  const name = '<code>' + esc(b.origin) + '</code>';
  if (b.origin_confidence === 'certain') return name;
  // Une origine inférée ne doit JAMAIS avoir l'air d'un fait : italique + intitulé.
  const alt = b.origin_alternatives && b.origin_alternatives.length
    ? ' ' + tr('git.origin.alt', { list: b.origin_alternatives.join(', ') }) : '';
  const lbl = b.origin_confidence === 'ambiguous' ? tr('git.origin.ambiguous') : tr('git.origin.inferred');
  return '<em class="git-inferred" title="' + esc(lbl + alt) + '">' + name + ' <span class="muted">(' + esc(lbl) + ')</span></em>';
}

// Branche(s) portant un tag (commit contenu). Serveur = branche par défaut d'abord.
// On en montre quelques-unes en pastilles, le reste replié en « +N ».
function tagBranchesHtml(branches, all) {
  const list = Array.isArray(branches) ? branches : [];
  if (!list.length) return '<span class="muted">—</span>';
  if (all) return list.map((b) => `<span class="tag">${esc(b)}</span>`).join(' ');
  const shown = list.slice(0, 3).map((b) => `<span class="tag">${esc(b)}</span>`).join(' ');
  const extra = list.length - 3;
  return shown + (extra > 0 ? ` <span class="muted" title="${esc(list.join(', '))}">+${extra}</span>` : '');
}

// Liste des tags, triée par date de création décroissante (fournie triée par le serveur).
function gitTagsHtml(tags, repoId) {
  if (!tags.length) return `<div class="git-tags"><h4>${esc(tr('git.tags.title'))}</h4><p class="muted">${esc(tr('git.tags.none'))}</p></div>`;
  return `<div class="git-tags"><h4>${esc(tr('git.tags.title', { n: tags.length, count: tags.length }))}</h4>`
    + '<div class="md-tablewrap"><table class="md-table"><thead><tr>'
    + `<th>${esc(tr('git.tags.col.name'))}</th><th>${esc(tr('git.tags.col.date'))}</th><th>${esc(tr('git.tags.col.branches'))}</th><th>${esc(tr('git.tags.col.author'))}</th><th>${esc(tr('git.tags.col.type'))}</th><th>${esc(tr('git.tags.col.message'))}</th>`
    + '</tr></thead><tbody>'
    + tags.map((tg) => `<tr><td><code>${esc(tg.name)}</code></td>`
      + `<td class="muted">${tg.committed_date ? fmtDate(tg.committed_date) : '—'}</td>`
      + `<td class="git-tag-branches">${tagBranchesHtml(tg.branches)}</td>`
      + `<td class="git-tag-author"><span class="muted">${tg.author ? esc(tg.author) : '—'}</span> `
        + `<button type="button" class="btn btn-sm btn-ghost" data-tagauthor="${esc(tg.name)}" data-repo="${repoId}" title="${esc(tr('git.tags.fetch-author-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('git.tags.fetch-author'))}</button></td>`
      + `<td>${tg.annotated ? `<span class="tag">${esc(tr('git.tags.annotated'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`}</td>`
      + `<td class="muted git-tag-msg">${esc((tg.message || '').split('\n')[0].slice(0, 80))}</td></tr>`).join('')
    + '</tbody></table></div></div>';
}

// Rend l'explorateur d'UN dépôt dans le conteneur `box` (scopé : plusieurs dépôts
// peuvent être affichés en parallèle, chacun dans son bloc).
function gitRenderExplorer(d, box) {
  // Tri : dernier commit le plus récent d'abord (les branches sans date en dernier).
  const rows = [...d.branches].sort((a, b) => (b.committed_date ? new Date(b.committed_date).getTime() : -Infinity) - (a.committed_date ? new Date(a.committed_date).getTime() : -Infinity));
  /* Filtre au-dessus du tableau : c'est aussi une liste où l'on CHOISIT des branches
     (les cases servent à la suppression groupée), et un dépôt actif en compte des
     centaines. Comme ailleurs, il masque des lignes sans toucher aux cases cochées. */
  box.innerHTML = '<input type="search" class="search git-ex-filter" placeholder="' + esc(tr('git.refs.search-ph')) + '" aria-label="' + esc(tr('git.refs.search-ph')) + '" />' +
    '<div class="md-tablewrap"><table class="md-table git-explorer"><thead><tr>' +
    '<th></th><th>' + esc(tr('git.col.branch')) + '</th><th>' + esc(tr('git.col.vs-default')) + '</th>' +
    '<th>' + esc(tr('git.col.origin')) + '</th><th>' + esc(tr('git.col.merged-into')) + '</th><th>' + esc(tr('git.col.last-commit')) + '</th><th></th>' +
    '</tr></thead><tbody>' + rows.map((b) => {
      const stale = !b.default && b.committed_date && (Date.now() - new Date(b.committed_date).getTime()) > 90 * 86400000;
      const cleanable = !b.default && b.merged_into && (b.ahead === 0);
      const pick = b.default || b.protected ? '' :
        '<input type="checkbox" class="git-ex-pick" value="' + esc(b.name) + '" />';
      const ab = b.default ? '<span class="muted">—</span>'
        : '<span class="git-ab">' + (b.ahead ? '↑' + b.ahead : '') + (b.behind ? ' <strong class="git-behind">↓' + b.behind + '</strong>' : (b.ahead ? '' : '=')) + '</span>';
      const merged = b.merged_into
        ? '<code>' + esc(b.merged_into) + '</code>' + (b.merged_mr ? ' <a href="' + esc(safeUrl(b.merged_mr.url)) + '" target="_blank" rel="noopener noreferrer">!' + b.merged_mr.iid + '</a>' : '')
        : '<span class="muted">—</span>';
      // « Créer la MR » entre la branche et sa SOURCE : cible = l'origine déduite,
      // sinon la branche par défaut. Proposé seulement si la branche a des commits
      // d'avance, n'est pas la branche par défaut, ET n'a pas déjà une MR ouverte.
      // Si une MR ouverte existe, on montre le lien vers elle à la place du bouton.
      const mrTarget = (b.origin && b.origin !== b.name) ? b.origin : d.default;
      const canMr = !b.default && b.ahead > 0 && mrTarget && mrTarget !== b.name && !b.open_mr;
      /* A/Git 3 — DEUX GESTES QUI MANQUAIENT. La ligne dit déjà la note de la review de sa
         merge request et la session qui l'a créée : c'est un plan de travail, mais il n'y
         avait rien à faire depuis là. Vérifier une branche et coder dessus existent tous les
         deux ailleurs — ils partent d'ici avec le dépôt et la branche déjà renseignés. Pas
         sur la branche par défaut : on ne code pas « sur main » depuis un explorateur. */
      const gestes = b.default ? '' :
        '<button class="btn btn-sm btn-ghost" data-gitverif="' + esc(b.name) + '" data-repo="' + d.repo_id + '" title="'
        + esc(tr('git.br.verify-title', { branch: b.name })) + '">' + svgIco('check') + '</button>'
        + '<button class="btn btn-sm btn-ghost" data-gitcode="' + esc(b.name) + '" data-repo="' + d.repo_id + '" title="'
        + esc(tr('git.br.code-title', { branch: b.name })) + '">' + svgIco('bot') + '</button>'
        /* B16 — « rebaser cette branche avant lundi » n'avait nulle part où s'accrocher : le
           bouton « Ajouter aux todos » n'existait que sur une merge request et un ticket, et
           une branche sans merge request (le cas justement intéressant) restait hors de
           portée. La todo garde `<dépôt>:<branche>` et sait donc y revenir. */
        /* TOP 15 — ET LE JOB JENKINS DU DÉPÔT, avec la branche déjà posée. Le bouton n'existait
           que sur une merge request vérifiée verte : une branche qu'on veut justement déployer
           en recette AVANT d'en faire une merge request n'y avait pas droit. On ouvre la fiche,
           jamais un lancement. */
        + ((b.jenkins || []).slice(0, 1).map((j) => '<button class="btn btn-sm btn-ghost" data-mr-jenkins="' + esc(j.path)
          + '" data-param="' + esc(j.param) + '" data-branch="' + esc(b.name) + '" title="'
          + esc(tr('git.br.jenkins-title', { job: j.path, branch: b.name })) + '">' + svgIco('pipeline') + '</button>').join(''))
        + addTodoBtn('branch', d.repo_id + ':' + b.name, tr('notes.add-todo.branch', { branch: b.name }));
      const mrBtn = b.open_mr
        ? '<a class="btn btn-sm" href="' + esc(safeUrl(b.open_mr.url)) + '" target="_blank" rel="noopener noreferrer" title="' + esc(tr('git.mr.open-title', { target: b.open_mr.target })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>!' + b.open_mr.iid + ' ↗</a>'
        : (canMr
          ? '<button class="btn btn-sm" data-gitmr="' + esc(b.name) + '" data-target="' + esc(mrTarget) + '" title="' + esc(tr('git.mr.title', { target: mrTarget })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>' + esc(tr('git.btn.create-mr')) + '</button>'
          : '');
      return '<tr' + (b.default ? ' class="git-ex-default"' : '') + '><td>' + pick + '</td>' +
        '<td>' + chipBranche(b.name) + (b.default ? ' <span class="tag">' + esc(tr('git.tag.default')) + '</span>' : '') +
          (b.protected ? ' <span class="tag stale">' + esc(tr('git.tag.protected')) + '</span>' : '') +
          (cleanable ? ' ' + svgIco('trash') : '') + (stale && !b.merged_into ? ' ' + svgIco('alert') : '') +
          /* CE QUE LA BRANCHE PORTE. Le graphe disait « ahead 3, behind 12 » et rien d'autre :
             la note de la review de sa merge request et la session de codage qui l'a créée
             sont en base, et ce sont elles qui font d'une ligne un plan de travail. */
          (b.mr_note != null ? ' <span class="git-ex-note">' + esc(fmtNote10(b.mr_note * 10)) + '</span>' : '') +
          /* TOP 15 — …ET LE RESTE DE CE QUE LA BASE SAIT : le TITRE de la merge request (chargé
             puis jeté jusqu'ici), le ticket, le dernier verdict de vérification, le dernier
             build. Un nom de branche ne dit pas ce qu'elle fait ; son titre, si. */
          (b.mr && b.mr.title ? ' <span class="git-ex-titre muted" title="' + esc(b.mr.title) + '">' + esc(String(b.mr.title).slice(0, 60)) + '</span>' : '') +
          (b.mr && b.mr.draft ? ' <span class="tag draft">' + esc(tr('mr.tag.draft')) + '</span>' : '') +
          (b.mr && b.mr.conflicts ? ' <span class="tag conflit">' + esc(tr('mr.tag.conflict')) + '</span>' : '') +
          (b.ticket ? ' <span class="tag" title="' + esc(b.ticket.status || '') + '">' + esc(b.ticket.key) + '</span>' : '') +
          (b.verification ? ' ' + verifyBadge({ verdict: b.verification.verdict }) : '') +
          badgeCI(b.name) +
          (b.session ? ' <button type="button" class="lien-reglage git-ex-sess" data-git-sess="' + b.session.id + '" data-git-sess-kind="' + esc(b.session.kind || 'code') + '" title="'
            + esc(tr('git.branch.session-title')) + '">' + svgIco('bot') + ' ' + esc(String(b.session.label || '').slice(0, 40)) + '</button>' : '') + '</td>' +
        '<td>' + ab + '</td><td>' + gitOriginCell(b) + '</td><td>' + merged + '</td>' +
        '<td class="muted">' + (b.committed_date ? fmtDate(b.committed_date) : '—') + (b.author ? ' · ' + esc(b.author) : '') + '</td>' +
        '<td class="git-ex-actions">' + gestes + mrBtn + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<p class="muted git-ex-nomatch" hidden>' + esc(tr('git.refs.no-match')) + '</p>' +
    '<div class="form-actions"><button class="btn btn-danger git-ex-delete" disabled><svg class="ico"><use href="#i-trash"/></svg>' + esc(tr('git.btn.delete-selected')) + '</button>' +
    '<span class="muted git-ex-count"></span></div>' +
    gitTagsHtml(d.tags || [], d.repo_id);

  const filter = $('.git-ex-filter', box);
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const tr_ of $$('.git-explorer tbody tr', box)) {
      const name = (tr_.querySelector('code') || {}).textContent || '';
      const hit = !q || name.toLowerCase().includes(q);
      tr_.hidden = !hit;
      if (hit) shown += 1;
    }
    $('.git-ex-nomatch', box).hidden = shown > 0;
  });

  const refresh = () => {
    const n = $$('.git-ex-pick:checked', box).length;
    $('.git-ex-delete', box).disabled = !n;
    $('.git-ex-count', box).textContent = n ? tr('git.explorer.selected', { n, count: n }) : '';
  };
  $$('.git-ex-pick', box).forEach((cb) => cb.addEventListener('change', refresh));
  /* « Créer la MR » : même modale que Dev IA, mais entre la branche et sa source.
     L'intro rappelle source → cible, car la cible est une origine DÉDUITE : on la
     montre pour pouvoir renoncer. */
  $$('[data-gitmr]', box).forEach((b) => b.addEventListener('click', () => {
    const source = b.dataset.gitmr;
    const target = b.dataset.target;
    openMrModal({
      url: '/git/mr', body: { repo_id: d.repo_id, source, target },
      title: source, source, target, forge: d.forge, project: d.project || '',
      onDone: (r) => {
        // Remplace le bouton par le lien vers la MR : l'écran reflète la réalité
        // sans re-analyser tout le dépôt (coûteux).
        b.outerHTML = '<a class="btn btn-sm" href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer" title="' + esc(tr('git.mr.open-title', { target })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>!' + r.iid + ' ↗</a>';
      },
    });
  }));
  // Le pont entre les deux écrans : c'est le parcours réel du nettoyage.
  $('.git-ex-delete', box).addEventListener('click', () => {
    const refs = $$('.git-ex-pick:checked', box).map((c2) => c2.value);
    $('#gitAction').value = 'delete_branch';
    gitApplyAction();
    gitTargets = [{ repo_id: d.repo_id, refs }];
    showGitSub('actions');
    gitRenderTargets().then(gitDoPreview);   // les refs sont là : l'aperçu peut être lu
  });

  // « Auteur du tag » : appel dédié à la demande (le tagger d'un tag annoté).
  $$('[data-tagauthor]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      const info = await busy(b, () => api(`/git/tag-author?repo_id=${b.dataset.repo}&tag=${encodeURIComponent(b.dataset.tagauthor)}`));
      const author = (info.found && info.author) ? esc(info.author) : '—';
      const badge = info.found && info.author
        ? (info.annotated ? `<span class="tag">${esc(tr('git.tags.tagger'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`)
        : '';
      b.outerHTML = `<span class="git-tagger">${author} ${badge}</span>`;
    } catch (e) { toast(explainError(e.message), true); }
  }));
}

async function gitAnalyze() {
  // Multi-projets : on analyse tous les dépôts cochés. Chaque résultat va dans son
  // propre bloc <details>, REPLIÉ par défaut (on ouvre celui qu'on veut inspecter).
  const ids = $$('#gitExploreRepoBox .git-multi-pick:checked').map((c) => Number(c.value));
  retenirDepotsExplorer(ids);
  if (!ids.length) { toast(tr('git.explorer.pick-one'), true); return; }
  const btn = $('#gitExploreGo');
  const wrap = $('#gitExploreBox');
  $('#gitExploreInfo').textContent = tr('git.explorer.analyzing');
  /* Chaque dépôt annonce son ÉTAT dans son propre en-tête. Le squelette du corps ne se voyait
     pas : les blocs naissent repliés, et un clone peut durer une minute — on cliquait
     « Analyser » sans plus rien voir bouger. L'analyse étant séquentielle, on distingue ce
     qui ATTEND de ce qui TOURNE : sur trois dépôts cochés, on veut savoir lequel travaille. */
  wrap.innerHTML = ids.map((id) => {
    const repo = repoOptions.find((r) => r.id === id);
    return `<details class="git-ex-project" data-repo="${id}">
        <summary><span class="git-ex-proj-name">${esc(repo ? repo.project : id)}</span> <span class="git-ex-proj-info muted">${esc(tr('git.explorer.pending'))}</span></summary>
        <div class="git-ex-proj-body">${skeleton(2)}</div>
      </details>`;
  }).join('');
  try {
    // Séquentiel : un clone/fetch à la fois, comme le reste de l'app (ménage les I/O).
    await busy(btn, async () => {
      for (const id of ids) {
        const details = $(`.git-ex-project[data-repo="${id}"]`, wrap);
        const body = $('.git-ex-proj-body', details);
        const info = $('.git-ex-proj-info', details);
        info.innerHTML = `<span class="spin"></span> ${esc(tr('git.explorer.running'))}`;
        try {
          const d = await api('/git/branches?repo_id=' + id);
          info.textContent = tr('git.explorer.count', { n: d.branches.length, count: d.branches.length, def: d.default });
          body.innerHTML = '';
          gitRenderExplorer(d, body);
        } catch (e) {
          info.textContent = '';
          body.innerHTML = errorBox(e.message);
          // Une erreur reste invisible dans un bloc replié : on l'ouvre pour la montrer.
          details.open = true;
        }
      }
    });
  } finally {
    $('#gitExploreInfo').textContent = '';
  }
}

/* ---- Trouver une ref (tag ou branche) dans tous les dépôts ---- */
// Branches portant le tag, chacune avec la date de SON dernier commit. Un ✓ signale que
// le tag pointe justement ce dernier commit (comparé à la « Date » du tag, colonne voisine).
function findRefBranchesHtml(branches) {
  const list = Array.isArray(branches) ? branches : [];
  if (!list.length) return '<span class="muted">—</span>';
  return '<div class="findref-branches">' + list.map((b) => {
    const name = typeof b === 'string' ? b : (b && b.name) || '';
    const date = b && b.tipDate ? fmtDate(b.tipDate) : '—';
    const tip = b && b.isTip;
    return `<div class="findref-branch"><span class="tag">${esc(name)}</span>`
      + `<span class="muted" title="${esc(tr('git.findref.branch-tip-date'))}">${date}</span>`
      + (tip ? `<span class="findref-tip" title="${esc(tr('git.findref.on-tip'))}">${svgIco('check')}</span>` : '')
      + '</div>';
  }).join('') + '</div>';
}
/* CE QU'ON CHERCHAIT LA DERNIÈRE FOIS. « Trouver une ref » et l'explorateur étaient les deux
   seuls sous-onglets de Git sans mémoire : on retapait `v2.14.0` à chaque visite, alors qu'on y
   revient précisément pour suivre la même ref de dépôt en dépôt. */
const MEMO_FINDREF = 'aidevtools_findref';
/* …et les dépôts de l'EXPLORATEUR, pour la même raison : on y revient sur les mêmes deux ou
   trois dépôts, et il fallait les recocher à chaque visite. On ne recoche que ce qui existe
   encore — un dépôt retiré des réglages ne doit pas réapparaître en fantôme. */
const MEMO_EXPLORER = 'aidevtools_git_explorer';
function poserMemoireExplorer() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem(MEMO_EXPLORER) || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) return;
  const cases = $$('#gitExploreRepoBox .git-multi-pick');
  if (!cases.length || cases.some((c) => c.checked)) return;   // déjà un choix à l'écran : on n'y touche pas
  cases.forEach((c) => { if (ids.includes(Number(c.value))) c.checked = true; });
}
function retenirDepotsExplorer(ids) {
  try { localStorage.setItem(MEMO_EXPLORER, JSON.stringify(ids || [])); } catch { /* stockage indisponible */ }
}

function poserMemoireFindRef() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(MEMO_FINDREF) || '{}'); } catch { m = {}; }
  if (m.name && $('#findRefName') && !$('#findRefName').value) $('#findRefName').value = m.name;
  if (m.type && $('#findRefType')) $('#findRefType').value = m.type;
}

async function findRefSearch(e) {
  if (e) e.preventDefault();
  const name = $('#findRefName').value.trim();
  if (!name) return;
  const type = $('#findRefType').value;
  try { localStorage.setItem(MEMO_FINDREF, JSON.stringify({ name, type })); } catch { /* stockage indisponible */ }
  const btn = $('#findRefGo');
  $('#findRefInfo').textContent = tr('git.findref.searching');
  $('#findRefBox').innerHTML = skeleton(3);
  let d;
  try { d = await busy(btn, () => api(`/git/find-ref?name=${encodeURIComponent(name)}&type=${type}`)); }
  catch (err) { $('#findRefInfo').textContent = ''; $('#findRefBox').innerHTML = errorBox(err.message); return; }

  const found = d.repos.filter((r) => r.matches.length);
  const errored = d.repos.filter((r) => r.error && !r.matches.length);
  $('#findRefInfo').textContent = tr('git.findref.count', { found: found.length, total: d.repos.length, name: d.name });

  const typeBadge = (k) => `<span class="tag">${esc(k === 'tag' ? tr('git.findref.tag') : tr('git.findref.branch'))}</span>`;
  let html = found.length
    ? '<div class="md-tablewrap"><table class="md-table"><thead><tr>'
      + `<th>${esc(tr('stats.col.project'))}</th><th>${esc(tr('git.findref.col.type'))}</th><th>${esc(tr('git.findref.col.commit'))}</th><th>${esc(tr('git.findref.col.tagdate'))}</th><th>${esc(tr('git.findref.col.branchdate'))}</th><th>${esc(tr('git.tags.col.author'))}</th><th>${esc(tr('git.tags.fetch-author'))}</th></tr></thead><tbody>`
      + found.map((r) => r.matches.map((m) => `<tr><td>${esc(r.project)}</td>`
        + `<td>${typeBadge(m.kind)}</td>`
        + `<td>${m.url ? `<a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer"><code>${esc(m.sha || d.name)}</code> ↗</a>` : ''}`
        + `${m.sha ? ` <button type="button" class="muted git-sha git-sha-copy" data-copy-txt="${esc(m.sha)}" title="${esc(tr('git.copy-sha'))}">${esc(m.url ? tr('ui.copy') : m.sha)}</button>` : ''}</td>`
        + `<td class="muted">${m.date ? fmtDate(m.date) : '—'}</td>`
        + `<td>${m.kind === 'tag' ? findRefBranchesHtml(m.branches) : '<span class="muted">—</span>'}</td>`
        + `<td class="muted">${esc(m.author || '—')}</td>`
        + `<td class="git-tag-author">${m.kind === 'tag'
          ? `<button type="button" class="btn btn-sm btn-ghost" data-findref-author="${esc(d.name)}" data-repo="${r.repo_id}" title="${esc(tr('git.tags.fetch-author-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('git.tags.fetch-author'))}</button>`
          : '<span class="muted">—</span>'}</td></tr>`).join('')).join('')
      + '</tbody></table></div>'
    : emptyState({ icon: 'search', title: tr('git.findref.none.title', { name: esc(d.name) }), text: tr('git.findref.none.text') });
  /* A/Git 3 — « POSITIONNER MES PROJETS DESSUS ». Trouver une ref répond à « qui l'a ? » ;
     la question suivante est toujours « mets-moi dessus ». Elle vit dans Navigation, avec les
     mêmes dépôts et la même ref — on y va pré-rempli plutôt que de retaper les deux. Seulement
     s'il y a des branches trouvées : Navigation positionne des branches, pas des tags. */
  const branchesTrouvees = found.flatMap((r) => r.matches.filter((m) => m.kind === 'branch').map(() => r));
  if (branchesTrouvees.length) {
    html += `<p style="margin-top:10px"><button type="button" class="btn" id="findRefToNav"
      data-ref="${esc(d.name)}" title="${esc(tr('git.findref.to-nav.title', { name: d.name, n: branchesTrouvees.length }))}">${svgIco('repeat')}${esc(tr('git.findref.to-nav'))}</button></p>`;
  }
  if (errored.length) {
    html += `<p class="muted" style="margin-top:8px">${svgIco('alert')} ${tr('git.findref.errors', { n: errored.length, count: errored.length })} : ${errored.map((r) => esc(r.project)).join(', ')}</p>`;
  }
  $('#findRefBox').innerHTML = html;
  const versNav = $('#findRefToNav');
  if (versNav) {
    versNav.addEventListener('click', () => {
      /* On passe par la MÊME mémoire que Navigation lit à son ouverture : poser l'écran
         autrement ferait deux façons de dire « les projets et leur branche ». */
      /* Navigation garde ses PROJETS en mémoire ; la branche, elle, se pose sur les lignes
         affichées — c'est la même ref pour tous, c'est justement ce qu'on vient demander. */
      showGitSub('navigate');
      navTargets = navTargets.map((t) => ({ ...t, branch: versNav.dataset.ref }));
      navRenderTargets();
      toast(tr('git.findref.to-nav.done', { name: versNav.dataset.ref }));
    });
  }
  // Auteur PRÉCIS du tag à la demande (le tagger annoté n'est pas dans l'API GitLab).
  $$('[data-findref-author]', $('#findRefBox')).forEach((b) => b.addEventListener('click', async () => {
    try {
      const info = await busy(b, () => api(`/git/tag-author?repo_id=${b.dataset.repo}&tag=${encodeURIComponent(b.dataset.findrefAuthor)}`));
      const author = (info.found && info.author) ? esc(info.author) : '—';
      const badge = info.found && info.author
        ? (info.annotated ? `<span class="tag">${esc(tr('git.tags.tagger'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`)
        : '';
      b.outerHTML = `<span class="git-tagger">${author} ${badge}</span>`;
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#findRefForm') && $('#findRefForm').addEventListener('submit', findRefSearch);

/* ---- Historique et restauration ---- */
const GIT_ACTION_LABEL = () => ({
  new_branch: tr('git.action.new_branch'), create_tag: tr('git.action.create_tag'),
  delete_branch: tr('git.action.delete_branch'), delete_tag: tr('git.action.delete_tag'),
});
/* « Restaurable » et « fetché » n'ont de sens que pour une suppression : c'est la copie de
   sûreté qui en dépend. La règle est celle du serveur (`gitops.isDestructive`), recopiée ici
   sous forme de liste parce que le front n'importe pas le module — deux mots, un commentaire. */
const gitops_destructive = (action) => action === 'delete_branch' || action === 'delete_tag';

/* Le filtre MASQUE, il ne reconstruit pas : la ligne écartée reste à un caractère effacé près,
   et le rendu ne se rejoue pas à chaque frappe. Même geste que les autres listes de l'outil. */
function filtrerHistoriqueGit() {
  const q = ($('#gitHistFilter') || {}).value ? $('#gitHistFilter').value.trim().toLowerCase() : '';
  const errSeules = !!($('#gitHistErrOnly') || {}).checked;
  let vus = 0;
  $$('#gitHistoryBox .git-op').forEach((c) => {
    const ok = (!q || (c.dataset.cherche || '').includes(q)) && (!errSeules || c.dataset.err === '1');
    c.hidden = !ok;
    if (ok) vus += 1;
  });
  const vide = $('#gitHistNoMatch');
  if (vide) vide.hidden = vus > 0 || !$$('#gitHistoryBox .git-op').length;
}
onEl($('#gitHistFilter'), 'input', debounce(filtrerHistoriqueGit, 120));
onEl($('#gitHistErrOnly'), 'change', filtrerHistoriqueGit);

async function gitLoadHistory() {
  const el = $('#gitHistoryBox');
  let rows;
  try { rows = await api('/git/ops'); } catch (e) { el.innerHTML = errorBox(e.message); return; }
  if (!rows.length) { el.innerHTML = emptyState({ icon: 'clock', title: tr('git.history.empty.title'), text: tr('git.history.empty.text') }); return; }
  const L = GIT_ACTION_LABEL();
  /* L'HISTOIRE D'UNE OPÉRATION, PAS SON RÉSUMÉ. La ligne disait l'action, la ref, le projet et
     la date — et taisait tout le reste, pourtant en base : de quel LOT elle faisait partie (on
     supprime dix branches d'un coup, et on veut les revoir ensemble), d'où venait une branche
     créée (`source_ref`), le message d'un tag, si le clone avait bien été rafraîchi avant la
     copie de sûreté (`fetched` — c'est lui qui dit si une restauration a des chances), et le
     texte d'une erreur, jusque-là caché dans une info-bulle. */
  const lots = new Map();
  for (const o of rows) {
    const cle = o.batch_id || `op-${o.id}`;
    if (!lots.has(cle)) lots.set(cle, []);
    lots.get(cle).push(o);
  }
  const ligne = (o) => '<div class="git-op-l">' +
    '<div class="report-main"><div class="title">' + esc(L[o.action] || o.action) + ' · <code>' + esc(o.ref_name) + '</code>' +
    (o.source_ref ? ' <span class="muted">' + esc(tr('git.history.from', { ref: o.source_ref })) + '</span>' : '') + '</div>' +
    '<div class="meta">' + esc(o.project) + ' · ' + fmtDateTime(o.created_at) +
    (o.ref_sha ? ' · <button type="button" class="muted git-sha git-sha-copy" data-copy-txt="' + esc(o.ref_sha)
      + '" title="' + esc(tr('git.copy-sha')) + '">' + esc(String(o.ref_sha).slice(0, 8)) + '</button>' : '') +
    (o.tag_message ? ' · <span class="muted">« ' + esc(String(o.tag_message).slice(0, 80)) + ' »</span>' : '') +
    /* `fetched` ne vaut que pour une suppression : c'est la copie de sûreté qui en dépend. */
    (gitops_destructive(o.action) ? ' · <span class="muted">' + esc(tr(o.fetched ? 'git.history.fetched' : 'git.history.not-fetched')) + '</span>' : '') +
    '</div>' +
    (o.status === 'error' && o.error ? '<div class="git-op-err">' + esc(o.error) + '</div>' : '') +
    '</div>' +
    '<span class="spacer"></span>' +
    (o.status === 'error' ? '<span class="tag stale">' + esc(tr('git.op.failed')) + '</span>' : '') +
    (o.restored_at ? '<span class="tag done">' + esc(tr('git.op.restored')) + '</span>' : '') +
    (o.restorable ? '<button class="btn btn-sm" data-gitrestore="' + o.id + '" title="' + esc(tr('git.title.restore')) + '"><svg class="ico ico-sm"><use href="#i-reset"/></svg>' + esc(tr('git.btn.restore')) + '</button>' : '');

  el.innerHTML = [...lots.values()].map((ops) => {
    const cherche = ops.map((o) => `${L[o.action] || o.action} ${o.project} ${o.ref_name} ${o.source_ref || ''} ${o.error || ''}`).join(' ').toLowerCase();
    const erreur = ops.some((o) => o.status === 'error') ? '1' : '';
    // Un lot d'une seule opération n'a pas d'en-tête : ce serait un titre pour une ligne.
    const entete = ops.length > 1
      ? '<div class="git-op-lot muted">' + esc(tr('git.history.batch', { n: ops.length, count: ops.length })) + '</div>' : '';
    return '<div class="card git-op' + (ops.length > 1 ? ' git-op-groupe' : '') + '" data-cherche="' + esc(cherche)
      + '" data-err="' + erreur + '">' + entete + ops.map(ligne).join('') + '</div>';
  }).join('');
  filtrerHistoriqueGit();
  $$('#gitHistoryBox [data-gitrestore]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.git-restore'), confirmLabel: tr('git.op.restore'), danger: false })) return;
    try {
      await busy(b, () => api('/git/ops/' + b.dataset.gitrestore + '/restore', { method: 'POST' }));
      toast(tr('toast.git-restore-started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}

