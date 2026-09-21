'use strict';
/* Comparer le contenu de deux dépôts, A31 le diff du merge commité. */
// @expose loadGit, showGitSub
/* ---------- Comparer le contenu de deux dépôts ----------
   Deux dépôts, deux branches, et la question « qu'est-ce qui existe ici et pas là ? ». Les
   quatre sélecteurs passent par un combo à RECHERCHE : autant de dépôts qu'on veut, et un dépôt
   actif aligne des centaines de branches — `npm run check` refuse d'ailleurs une liste de refs
   sans champ de recherche. */
const COMPARE_MEMO = 'aidevtools_compare';
let compareDernier = null;

const compareMemo = () => { try { return JSON.parse(localStorage.getItem(COMPARE_MEMO) || '{}'); } catch { return {}; } };
const compareMemoriser = (etat) => {
  try { localStorage.setItem(COMPARE_MEMO, JSON.stringify(etat)); } catch { /* stockage indisponible */ }
};

function renderCompareCotes() {
  const el = $('#compareCotes');
  if (!el) return;
  const memo = compareMemo();
  const cote = (cle, titre) => `<div class="compare-cote" data-row data-cote="${cle}">
      <h4>${esc(titre)}</h4>
      <label><span>${esc(tr('git.compare.repo'))}</span>
        ${repoComboHtml(memo[`repo_${cle}`], { idClass: `cmp-repo-${cle}` })}</label>
      <label><span>${esc(tr('git.compare.ref'))}</span>
        ${comboHtml(`cmp-branch-${cle}`, { value: memo[`ref_${cle}`] || '', label: memo[`label_${cle}`] || '', ph: tr('git.compare.ref-ph') })}</label>
    </div>`;
  /* Le « ⟷ » n'est pas une décoration : il dit que les deux blocs sont les deux termes d'une
     MÊME question. Sans lui, quatre champs flottaient côte à côte sans qu'on voie les paires. */
  el.innerHTML = cote('a', tr('git.compare.left'))
    + `<div class="compare-vs" aria-hidden="true">⟷</div>`
    + cote('b', tr('git.compare.right'));
  wireRepoCombos(el);
  for (const cle of ['a', 'b']) {
    /* BRANCHES ET TAGS dans la même liste : comparer une version livrée à la suivante, c'est
       comparer deux tags. Un tag et une branche peuvent porter le même nom — le genre voyage
       donc avec la valeur (`tag:v1.2`), et l'écran l'affiche, plutôt que de laisser le serveur
       deviner lequel des deux on voulait. */
    wireCombo(el, `cmp-branch-${cle}`, async (row) => {
      const repoId = Number($(`.cmp-repo-${cle}`, row || el).value);
      if (!repoId) return [];
      const [branches, tags] = await Promise.all([
        gitLoadRefs(repoId, 'branches'),
        gitLoadRefs(repoId, 'tags').catch(() => ({ refs: [] })),
      ]);
      return [
        ...branches.refs.map((r) => ({ value: `branch:${r.name}`, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' })),
        ...tags.refs.map((r) => ({ value: `tag:${r.name}`, label: r.name, hint: tr('git.compare.tag') })),
      ];
    });
  }
  /* Changer de dépôt vide la branche : garder « develop » après être passé sur un dépôt qui ne
     l'a pas donnerait une erreur au lancement, plusieurs secondes plus tard.
     L'événement part du champ CACHÉ (`.rc-id`), pas du champ de recherche visible : c'est lui
     qui porte l'identifiant, et écouter le champ visible n'entend jamais rien. */
  $$('.rc-id', el).forEach((hidden) => hidden.addEventListener('change', () => {
    const cote2 = hidden.closest('[data-cote]');
    const branche = $(`.cmp-branch-${cote2.dataset.cote}`, cote2);
    if (branche) {
      branche.value = ''; branche.dataset.label = '';
      $('.cb-search', branche.closest('.combo')).value = '';
    }
  }));
}

function compareLecture() {
  const lire = (cle) => {
    const champ = $(`.cmp-branch-${cle}`);
    const brut = (champ.value || '').trim();          // « branch:main » ou « tag:v1.2 »
    const sep = brut.indexOf(':');
    return {
      repo_id: Number($(`.cmp-repo-${cle}`).value) || 0,
      ref: sep < 0 ? brut : brut.slice(sep + 1),
      kind: brut.startsWith('tag:') ? 'tag' : 'branch',
      label: champ.dataset.label || '',
      brut,
    };
  };
  return { a: lire('a'), b: lire('b') };
}

// « grp/api · v1.2 (tag) » — le genre est dit : deux refs homonymes ne montrent pas la même chose.
const compareCote = (x) => `${x.project} · ${x.ref}${x.kind === 'tag' ? ` (${tr('git.compare.tag')})` : ''}`;

/* Une colonne = une question. Le FILTRE porte sur les trois listes à la fois : on cherche un
   fichier, pas une colonne — et sur deux dépôts jumeaux, la liste des différences est longue. */
function compareColonne(cle, titre, fichiers, cote) {
  const n = fichiers.length;
  /* Chaque fichier est CLIQUABLE : « des deux côtés mais différent » appelle aussitôt la
     question « différent comment ? », et un fichier d'un seul côté se lit contre le vide. */
  return `<section class="compare-col" data-col="${cle}">
    <h4>${esc(titre)} <span class="tag">${n}</span></h4>
    ${cote ? `<p class="muted">${esc(cote)}</p>` : ''}
    ${n ? `<ul class="compare-list">${fichiers.map((f) => `<li><button type="button" class="cmp-file" data-file="${esc(f)}" title="${esc(tr('git.compare.file-title'))}"><code>${esc(f)}</code></button></li>`).join('')}</ul>`
    : `<p class="muted">${esc(tr('git.compare.none'))}</p>`}
  </section>`;
}

/* Le contenu d'un fichier des deux côtés. Le diff est calculé par git côté serveur — y
   compris quand les deux dépôts n'ont rien en commun, cas où `git diff a..b` ne sait rien
   faire. Ici on ne fait que l'afficher, avec le rendu déjà utilisé pour les merge requests. */
async function ouvrirCompareFichier(chemin, bouton) {
  if (!compareDernier) return;
  const { a, b } = compareDernier;
  const url = `/git/compare/file?repo_a=${compareDernier.repo_a}&ref_a=${encodeURIComponent(a.ref)}&kind_a=${a.kind}`
    + `&repo_b=${compareDernier.repo_b}&ref_b=${encodeURIComponent(b.ref)}&kind_b=${b.kind}`
    + `&path=${encodeURIComponent(chemin)}`;
  let d;
  try { d = await busy(bouton, () => api(url)); }
  catch (e) { toast(explainError(e.message), true); return; }

  /* LE CHEMIN SE COLLE : c'est ce qu'on emporte vers un éditeur, un `git log` ou un message.
     Il s'affichait en texte inerte, à resélectionner à la souris. */
  $('#compareFilePath').innerHTML = `<button type="button" class="git-cmd-copy" data-copy-txt="${esc(d.path)}" title="${esc(tr('ui.copy'))}"><code>${esc(d.path)}</code></button>`;
  /* QUEL CÔTÉ EST QUOI. Un diff en rouge et vert ne dit pas de lui-même que le rouge est le
     dépôt de gauche : on le rappelle avec les mêmes couleurs, sinon on lit le diff à l'envers. */
  const cote = (x, signe) => `<span class="cmp-side ${signe === '-' ? 'del' : 'add'}">${signe} ${esc(compareCote(x))}`
    + `${x.exists ? '' : ` — ${esc(tr('git.compare.absent'))}`}</span>`;
  $('#compareFileSides').innerHTML = cote(d.a, '-') + cote(d.b, '+');
  const message = (cle) => `<p class="muted" style="padding:12px">${esc(tr(cle))}</p>`;
  if (d.trop_gros) $('#compareFileBody').innerHTML = message('git.compare.too-big');
  else if (d.binaire) $('#compareFileBody').innerHTML = message('git.compare.binary');
  else if (d.identique) $('#compareFileBody').innerHTML = message('git.compare.identical');
  else $('#compareFileBody').innerHTML = renderDiffLines(d.diff).html;
  $('#compareFileModal').hidden = false;
}

/* A31 — LE DIFF DU MERGE COMMITÉ, dans la fenêtre qui sert déjà à lire un diff (Comparer).
   Deux visionneuses de diff pour la même chose finiraient par ne plus se ressembler ; celle-ci
   sait déjà colorer, copier un chemin et se fermer à Échap. */
async function ouvrirDiffMerge(id) {
  let d;
  try { d = await api(`/git/merges/${id}/diff`); }
  catch (e) { toast(explainError(e.message), true); return; }
  $('#compareFilePath').innerHTML = `<button type="button" class="git-cmd-copy" data-copy-txt="${esc(d.sha)}" title="${esc(tr('ui.copy'))}"><code>${esc(String(d.sha).slice(0, 8))}</code></button> ${esc(d.sujet || '')}`;
  $('#compareFileSides').innerHTML = `<span class="muted">${esc([d.auteur, d.date].filter(Boolean).join(' · '))}</span>`;
  $('#compareFileBody').innerHTML = d.diff
    ? renderDiffLines(d.diff).html
    : `<p class="muted" style="padding:12px">${esc(tr('git.merge.diff-empty'))}</p>`;
  $('#compareFileModal').hidden = false;
}

$('#compareFileClose') && $('#compareFileClose').addEventListener('click', () => { $('#compareFileModal').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#compareFileModal') && !$('#compareFileModal').hidden) $('#compareFileModal').hidden = true;
});

function renderCompare(d) {
  compareDernier = d;
  const gauche = compareCote(d.a);
  const droite = compareCote(d.b);
  $('#compareResult').innerHTML = `
    <div class="compare-head">
      <span>${esc(tr('git.compare.summary', {
    gauche, droite, a: d.a.files, b: d.b.files, same: d.same,
  }))}</span>
      <input id="compareFilter" class="search" type="search" placeholder="${esc(tr('git.compare.filter'))}" />
    </div>
    ${d.tronque ? `<p class="converge-note">${svgIco('alert')} <span>${esc(tr('git.compare.truncated'))}</span></p>` : ''}
    <div class="compare-grid">
      ${compareColonne('a', tr('git.compare.only-left'), d.only_a, gauche)}
      ${compareColonne('diff', tr('git.compare.differ'), d.differ, '')}
      ${compareColonne('b', tr('git.compare.only-right'), d.only_b, droite)}
    </div>`;
  $$('#compareResult .cmp-file').forEach((btn) => btn.addEventListener('click',
    () => ouvrirCompareFichier(btn.dataset.file, btn)));
  const filtre = $('#compareFilter');
  filtre.addEventListener('input', debounce(() => {
    const q = filtre.value.toLowerCase().trim();
    $$('#compareResult .compare-list li').forEach((li) => {
      li.hidden = !!q && !li.textContent.toLowerCase().includes(q);
    });
  }, 120));
}

$('#btnCompare') && $('#btnCompare').addEventListener('click', async (e) => {
  const { a, b } = compareLecture();
  if (!a.repo_id || !b.repo_id) { toast(tr('git.compare.pick-repos'), true); return; }
  if (!a.ref || !b.ref) { toast(tr('git.compare.pick-branches'), true); return; }
  if (a.repo_id === b.repo_id && a.brut === b.brut) { toast(tr('git.compare.same-side'), true); return; }
  $('#compareInfo').textContent = tr('git.compare.running');
  try {
    const d = await busy(e.currentTarget, () => api(
      `/git/compare?repo_a=${a.repo_id}&ref_a=${encodeURIComponent(a.ref)}&kind_a=${a.kind}`
      + `&repo_b=${b.repo_id}&ref_b=${encodeURIComponent(b.ref)}&kind_b=${b.kind}`,
    ));
    compareMemoriser({
      repo_a: a.repo_id, ref_a: a.brut, label_a: a.label,
      repo_b: b.repo_id, ref_b: b.brut, label_b: b.label,
    });
    /* Les identifiants de dépôt voyagent avec le résultat : la réponse du serveur ne porte que
       les NOMS de projet, et c'est l'id qu'il faut pour redemander un fichier. */
    renderCompare({ ...d, repo_a: a.repo_id, repo_b: b.repo_id });
  } catch (err) {
    $('#compareResult').innerHTML = errorBox(explainError(err.message));
  } finally { $('#compareInfo').textContent = ''; }
});

function showGitSub(name) {
  $$('#tab-git .subnav [data-gsub]').forEach((b) => b.classList.toggle('active', b.dataset.gsub === name));
  $$('#tab-git .subtab').forEach((s) => s.classList.toggle('active', s.id === 'gsub-' + name));
  try { localStorage.setItem('aidevtools_gitsub', name); } catch { /* stockage indisponible */ }
  /* A/Git 1 — l'action retenue s'applique à l'ouverture, une seule fois : la reposer à chaque
     visite écraserait un changement fait juste avant de partir dans un autre sous-onglet. */
  if (name === 'actions') {
    const sel = $('#gitAction');
    const m = gitActMemo();
    if (sel && m.action && !sel.dataset.restaure && [...sel.options].some((o) => o.value === m.action)) {
      sel.dataset.restaure = '1';
      sel.value = m.action;
      gitApplyAction();
    }
  }
  if (name === 'history') gitLoadHistory();
  if (name === 'findref') poserMemoireFindRef();
  if (name === 'explore') poserMemoireExplorer();
  if (name === 'commands') loadGitCommands();
  if (name === 'compare') renderCompareCotes();
  if (name === 'merge') mergeLoad();
}

// Le compte de dépôts cochés, comme partout ailleurs où l'on coche dans une longue liste
// (A/Git — « combien de dépôts vais-je analyser ? » ne se lisait qu'en comptant les cases).
// Fonction à part : `poserMemoireExplorer` (explorateur.js) coche des cases par le code, ce
// qui ne déclenche pas d'évènement `change`, et doit donc rafraîchir le compte lui aussi.
function gitExploreMajCompte() {
  const box = $('#gitExploreRepoBox');
  if (!box) return;
  const n = $$('.git-multi-pick:checked', box).length;
  const compte = $('.git-multi-count', box);
  if (compte) compte.textContent = n ? tr('git.explorer.repos-picked', { n, count: n }) : '';
}

// Explorateur : sélection MULTIPLE de dépôts (cases à cocher) avec recherche à la frappe
// (le nombre de dépôts peut être élevé). Pas de présélection : on n'analyse rien sans choix.
function renderGitExploreRepos() {
  const box = $('#gitExploreRepoBox');
  if (!box) return;
  const items = repoOptions.map((r) =>
    `<label class="repo-multi-item"><input type="checkbox" class="git-multi-pick" value="${r.id}" /> <span>${esc(r.project)}</span></label>`).join('');
  box.innerHTML = `<div class="repo-multi-toolbar">
      <input class="repo-multi-search" type="search" placeholder="${esc(tr('git.explorer.search-ph'))}" />
      <button type="button" class="btn btn-sm git-multi-all">${esc(tr('git.explorer.select-all'))}</button>
      <button type="button" class="btn btn-sm git-multi-none">${esc(tr('git.explorer.clear-all'))}</button>
    </div>
    <div class="repo-multi-list">${items || `<span class="muted">${esc(tr('settings.repo.empty.title'))}</span>`}</div>
    <p class="muted git-multi-count"></p>`;
  const search = $('.repo-multi-search', box);
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase().trim();
    $$('.repo-multi-item', box).forEach((it) => { it.hidden = !!q && !$('span', it).textContent.toLowerCase().includes(q); });
  });
  box.addEventListener('change', (e) => { if (e.target.classList.contains('git-multi-pick')) gitExploreMajCompte(); });
  // « Tout cocher » ne coche que ce que le filtre montre encore — cocher un dépôt masqué
  // par la recherche surprendrait plus qu'il n'aiderait.
  $('.git-multi-all', box).addEventListener('click', () => {
    $$('.repo-multi-item', box).forEach((it) => { if (!it.hidden) $('.git-multi-pick', it).checked = true; });
    gitExploreMajCompte();
  });
  $('.git-multi-none', box).addEventListener('click', () => {
    $$('.git-multi-pick', box).forEach((cb) => { cb.checked = false; });
    gitExploreMajCompte();
  });
  gitExploreMajCompte();
}

async function loadGit() {
  await loadRepoOptions();
  await loadLocalRoots();
  gitMajVide();
  majBranchesMergees();
  renderGitExploreRepos();
  poserMemoireExplorer();   // les dépôts du dernier passage, s'ils existent encore
  navRenderRoot();
  navRenderTargets();
  navRestaurer();          // les projets du dernier passage, s'ils existent encore
  gitRenderTargets();
  let sub = 'actions';
  try { sub = localStorage.getItem('aidevtools_gitsub') || 'actions'; } catch { /* stockage indisponible */ }
  showGitSub(sub);
}

/* SANS DÉPÔT SUIVI, CET ÉCRAN N'A RIEN À DIRE — et il le disait mal : une ligne de projet
   désactivée portant « (ajoute d'abord un dépôt) », un combo de branches bloqué sur
   « chargement… », et un bouton « Vérifier une branche » seul en haut. Le même vide guidé que
   partout ailleurs, avec la porte qui va avec. */
