'use strict';
/* Onglet Reviews : les statuts d'une MR, le libellé du bouton (A14), les 3 stades, recherche, à reviewer, miennes / autres, reviewers, note, constats. */
// @expose aReviewerTotal, closeSplitMenus, currentSeg, estDeMoi, filtreAuteur, loadSegment, loadToReview, majBoutonReview, matchMr, moiSurLesForges, renderFiltreAuteur, renderToReview, toReviewRows
// Statuts de MR : la base stocke de l'anglais snake_case, l'UI parle français
// (symétrique de TASK_STATUS, qui le faisait déjà pour les tâches).
const MR_STATUS = {
  to_review: { label: tr('mr.status.to-review'), cls: 'to_review' },
  reviewed: { label: tr('mr.status.reviewed'), cls: 'reviewed' },
  done: { label: tr('mr.status.done'), cls: 'done' },
};
const mrStatus = (s) => MR_STATUS[s] || { label: s, cls: '' };

// Compteurs des segments + libellé du bouton de review globale (dit ce qui sera consommé).
/* A14 — LE LIBELLÉ DU BOUTON DIT CE QUI VA PARTIR. « Reviewer les 3 sélectionnées » n'est pas
   « Reviewer les 40 MR » : un bouton qui annonce un nombre et en lance un autre est pire que
   muet. Il suit donc trois choses — la file (par les compteurs), ce que la recherche et les
   filtres LAISSENT à l'écran, et la sélection quand il y en a une. D'où une fonction appelée
   aussi après un rendu de liste et un changement de sélection : le compteur, lui, ne repasse
   que toutes les quelques secondes. */
let aReviewerTotal = 0;
function majBoutonReview() {
  const lbl = $('#btnReviewLabel'); const btn = $('#btnReview');
  if (!lbl || !btn) return;
  const n = aReviewerTotal;
  const affichees = $$('#toReviewList .card[data-id]').length;
  const vise = mrSelection.size || affichees || n;
  lbl.textContent = n
    ? tr(mrSelection.size ? 'review.btn.review-selection' : 'review.btn.review-all', { n: vise, count: vise })
    : tr('review.btn.none');
  btn.disabled = !n;
}

/* ---------- Onglet Reviews : 3 stades d'une même MR ----------
   « À traiter » = liste simple ; « Reviewées » / « Traitées » = liste + rapport.
   Un seul champ de recherche, partagé par les trois stades. */
/* Le segment de Reviews est mémorisé comme l'onglet l'était déjà : sur un outil relancé
   plusieurs fois par jour, repartir systématiquement sur « à traiter » est une taxe.
   On ne restaure QUE l'onglet et le segment — jamais une recherche, une modale, une vue
   plein écran ni un rapport ouvert : restaurer un état périmé est pire qu'un démarrage
   propre, et c'est le seul risque réel de cette idée. */
const SEGS = ['to_review', 'reviewed', 'done'];
let currentSeg = (() => {
  try { const v = localStorage.getItem('aidevtools_seg'); return SEGS.includes(v) ? v : 'to_review'; }
  catch { return 'to_review'; }
})();
function loadSegment(seg = currentSeg) {
  currentSeg = seg;
  try { localStorage.setItem('aidevtools_seg', seg); } catch { /* stockage indisponible */ }
  $$('.segmented [data-seg]').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
  const isToReview = seg === 'to_review';
  $('#toReviewList').hidden = !isToReview;
  $('#reportSplit').hidden = isToReview;
  // La sélection multiple n'existe que dans la file « à traiter » : ailleurs elle traînerait
  // une barre d'actions sans cases à cocher pour la défaire.
  if (!isToReview) { mrSelection.clear(); renderMrBulkBar(); }
  refreshCounts();
  return isToReview ? loadToReview() : loadReports(seg);
}
$$('.segmented [data-seg]').forEach((b) => b.addEventListener('click', () => loadSegment(b.dataset.seg)));

/* ---------- Recherche (filtre client sur titre / auteur / projet / ticket) ---------- */
function matchMr(m, q) {
  return [m.title, m.author, m.project, m.ticket_key, m.source_branch]
    .some((v) => (v || '').toLowerCase().includes(q));
}

/* ---------- À reviewer ---------- */
let toReviewRows = [];
async function loadToReview() {
  /* SQUELETTE AU PREMIER AFFICHAGE SEULEMENT. Sans lui, sous latence, l'écran reste vide et
     dit « aucune merge request » alors que la requête est encore en vol. Aux rafraîchissements
     suivants on garde la liste affichée : la remplacer par un squelette toutes les minutes
     ferait clignoter ce qu'on est en train de lire.
     ⚠ `listeChargee` ne convient PAS ici : il ne dit pas « déjà chargée » mais « anime la
     prochaine entrée », et `stagger()` le remet à false à chaque rendu — s'en servir reposait
     un squelette par-dessus la liste à chaque rafraîchissement. */
  if (fileJamaisChargee) $('#toReviewList').innerHTML = skeleton(3);
  toReviewRows = await api('/mrs?status=to_review');
  fileJamaisChargee = false;
  listeChargee = true;
  renderFiltreAuteur();
  renderToReview();
}
/* ---------- « Mes merge requests » / « Les autres » ----------
   Onze cartes à traiter dont quatre à soi : ce que l'équipe attend, ce sont les sept autres, et
   on les repérait à l'auteur, carte par carte. Le compte du jeton est lu UNE fois au démarrage
   (`/api/me`, jamais depuis `/status` qui est sondé toutes les deux secondes) ; sans réponse —
   jeton absent, forge injoignable — les pastilles ne s'affichent pas du tout plutôt que de
   proposer un tri qui trierait mal. */
let moiSurLesForges = null;
let filtreAuteur = 'tous';
try { filtreAuteur = localStorage.getItem('aidevtools_mr_auteur') || 'tous'; } catch { /* ignore */ }

/* La forge stocke tantôt le pseudo, tantôt le nom affiché : on reconnaît les deux, pour les
   deux forges — une installation peut suivre des dépôts GitLab ET GitHub. */
function estDeMoi(m) {
  if (!moiSurLesForges) return false;
  const a = String(m.author || '').trim().toLowerCase();
  if (!a) return false;
  return Object.values(moiSurLesForges).some((id) => id
    && [id.username, id.name].filter(Boolean).some((v) => String(v).trim().toLowerCase() === a));
}

function renderFiltreAuteur() {
  const box = $('#mrAuteurFiltre');
  if (!box) return;
  box.hidden = !moiSurLesForges;
  if (!moiSurLesForges) return;
  /* « À RELIRE PAR MOI » n'est pas « les autres » : sur une file de trente merge requests, la
     question du matin est « lesquelles m'attendent ? », et la forge le sait — elle porte la
     demande de review. La pastille ne s'affiche que s'il y en a, sinon elle proposerait un
     filtre toujours vide. */
  const opts = [['tous', 'review.auteur.tous'], ['moi', 'review.auteur.moi'], ['autres', 'review.auteur.autres']];
  /* Sur les lignes DU STADE AFFICHÉ : la file « À traiter » en était exclue, et la pastille
     n'y apparaissait jamais — là même où la demande de relecture attend. */
  const lignes = currentSeg === 'to_review' ? toReviewRows : reportRows;
  if (filtreAuteur === 'demandee' || (lignes || []).some(demandeeAMoi)) opts.push(['demandee', 'mr.filter.to-review-by-me']);
  box.innerHTML = opts.map(([v, k]) => `<button type="button" class="chip${filtreAuteur === v ? ' active' : ''}" data-mr-auteur="${v}"`
    + `${v === 'demandee' ? ` title="${esc(tr('mr.filter.to-review-by-me-title'))}"` : ''}>${esc(tr(k))}</button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-mr-auteur]');
  if (!b) return;
  filtreAuteur = b.dataset.mrAuteur;
  try { localStorage.setItem('aidevtools_mr_auteur', filtreAuteur); } catch { /* ignore */ }
  renderFiltreAuteur();
  loadSegment(currentSeg);
});
/* CE QU'ON M'A DEMANDÉ DE RELIRE. `reviewers` est relevé à la découverte (la liste de la forge
   le donne) ; on y cherche mon identité, exactement comme `estDeMoi` cherche l'auteur. */
function demandeeAMoi(m) {
  if (!moiSurLesForges || !m || !m.reviewers) return false;
  const noms = String(m.reviewers).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!noms.length) return false;
  return Object.values(moiSurLesForges).some((id) => id
    && [id.username, id.name].filter(Boolean).some((v) => noms.includes(String(v).trim().toLowerCase())));
}

const filtrerPret = (rows) => (filtrePretActif ? rows.filter(estPreteAMerger) : rows);
const filtrerAuteur = (rows) => (filtreAuteur === 'moi' ? rows.filter(estDeMoi)
  : (filtreAuteur === 'autres' ? rows.filter((m) => !estDeMoi(m))
    : (filtreAuteur === 'demandee' ? rows.filter(demandeeAMoi) : rows)));

/* ── PAR QUOI COMMENCER ────────────────────────────────────────────────────────────────────
   La taille et l'âge sont écrits sur chaque carte depuis 1.4.0 ; il manquait de pouvoir s'en
   servir pour choisir. Quatre ordres, UN SEUL actif : c'est un choix unique, donc une liste
   déroulante — une rangée de pastilles se lit comme des filtres cumulables, ce qu'un ordre
   n'est pas. Mémorisé : un tri qu'on repose à chaque visite ne sert qu'une fois. L'ordre par
   défaut reste celui d'avant (le ticket en revue passe devant), pour que ne rien choisir ne
   change rien. */
let triFile = (() => { try { return localStorage.getItem('aidevtools_mr_tri') || 'defaut'; } catch { return 'defaut'; } })();

const TRIS = {
  defaut: (a, b) => rangTicket(a) - rangTicket(b),
  // « Petites d'abord » : les lignes changées, à défaut les fichiers. Sans mesure, on passe après.
  petites: (a, b) => tailleNum(a) - tailleNum(b),
  anciennes: (a, b) => String(a.updated_at || a.gitlab_created_at || '').localeCompare(String(b.updated_at || b.gitlab_created_at || '')),
  note: (a, b) => note10(a) - note10(b),
  /* « Bloquants d'abord » : le nombre de bloquants, puis de majeurs, puis la note. Une merge
     request sans rapport n'a pas de constat — elle passe après, comme pour le tri par note. */
  bloquants: (a, b) => (nbSeverite(b, 'blocker') - nbSeverite(a, 'blocker'))
    || (nbSeverite(b, 'major') - nbSeverite(a, 'major'))
    || (note10(a) - note10(b)),
};
/* LA NOTE SUR 10, OU 99 SANS NOTE (elle passe après). `m.note` est un objet `{ raw, value }`,
   `value` sur 1 : `Number(m.note)` donnait NaN, et un tri sur NaN ne trie rien. */
const note10 = (m) => (m && m.note && m.note.value != null ? m.note.value * 10 : 99);
const nbSeverite = (m, cle) => ((m && m.severites && m.severites[cle]) || 0);

/* LES CONSTATS QUI RESTENT, PAR GRAVITÉ. Le détail d'une carte disait « 1 résolu · 1
   persistant » — combien, jamais de quelle gravité. Deux pastilles suffisent : les bloquants
   et les majeurs. Le reste (mineur, info) ne change pas l'ordre de la journée. */
/* B7 — « TOUCHE LA CARTE <domaine> ». Les agents de domaine écrivent une carte qui cite des
   chemins ; une merge request porte les siens. Le croisement dit, avant d'ouvrir le diff, que
   ce travail entre dans un domaine dont quelqu'un a déjà fait le tour — et le badge mène à la
   carte, qui est justement ce qu'on voudrait relire à ce moment-là. */
function badgeCartes(m) {
  return (m.cards || []).slice(0, 3).map((c) => `<button type="button" class="tag" data-mr-card="${c.agent_id}"
    title="${esc(tr('mr.card-title', { name: c.name }))}">${svgIco('zap')} ${esc(c.name)}</button>`).join('');
}

function badgeSeverites(m) {
  const b = nbSeverite(m, 'blocker');
  const j = nbSeverite(m, 'major');
  if (!b && !j) return '';
  return (b ? `<span class="tag sev-blocker" title="${esc(tr('mr.sev.blocker-title', { n: b, count: b }))}">${b} ${esc(tr('mr.sev.blocker'))}</span>` : '')
    + (j ? `<span class="tag sev-major" title="${esc(tr('mr.sev.major-title', { n: j, count: j }))}">${j} ${esc(tr('mr.sev.major'))}</span>` : '');
}
function tailleNum(m) {
  const s = m && m.size;
  if (!s) return Number.MAX_SAFE_INTEGER;
  if (s.additions != null || s.deletions != null) return (s.additions || 0) + (s.deletions || 0);
  return s.files != null ? s.files : Number.MAX_SAFE_INTEGER;
}
const ordonnerFile = (rows) => rows.slice().sort(TRIS[triFile] || TRIS.defaut);

/* Le tri restauré doit SE VOIR dans la liste déroulante : une file rangée autrement que ce
   que le contrôle affiche ferait douter de la liste avant de douter du contrôle. */
(() => {
  const sel = $('#mrTri');
  if (!sel) return;
  /* L'ordre ACTIF se marque, comme une pastille : une file rangée par « note la plus basse »
     ressemble sinon à une file en désordre, et on cherche pourquoi la première carte n'est pas
     celle qu'on attendait. L'ordre habituel, lui, ne marque rien — c'est le défaut. */
  const marquer = () => { const l = sel.closest('.mr-tri'); if (l) l.classList.toggle('actif', sel.value !== 'defaut'); };
  if ([...sel.options].some((o) => o.value === triFile)) sel.value = triFile;
  marquer();
  sel.addEventListener('change', () => {
    triFile = sel.value;
    try { localStorage.setItem('aidevtools_mr_tri', triFile); } catch { /* stockage indisponible */ }
    marquer();
    loadSegment(currentSeg);
  });
})();

(async () => {
  try {
    const d = await api('/me');
    if (d && Object.keys(d).length && Object.values(d).some((i) => i && (i.username || i.name))) {
      moiSurLesForges = d;
    }
  } catch { /* pas d'identité : pas de filtre, et rien à signaler */ }
  renderFiltreAuteur();
})();

function renderToReview() {
  const el = $('#toReviewList');
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  /* TANT QUE LA FILE N'A JAMAIS RÉPONDU, on ne conclut rien. `renderToReview` est aussi
     appelée par l'assistant de démarrage, qui relit l'état de la configuration : sur une
     instance lente, cette réponse-là arrive AVANT celle des merge requests, et elle
     remplaçait le squelette par « aucune merge request » — un état vide affirmé sur une
     liste qu'on n'avait pas encore reçue. */
  if (fileJamaisChargee) return;
  if (!toReviewRows.length) {
    // pas encore configuré → onboarding ; configuré et vide → file à jour
    el.innerHTML = (setupState.checked && (!setupState.configured || !setupState.hasRepos || !setupState.hasMrs))
      ? onboardingHtml()
      : emptyState({
        icon: 'check',
        title: tr('review.empty.none.title'),
        text: tr('review.empty.all-done'),
        actions: [
          { act: 'discover', label: tr('review.btn.discover'), primary: true },
          { act: 'seg-reviewed', label: tr('review.btn.see-reports') },
        ],
      });
    return;
  }
  assurerJenkinsPourCI();          // une fois par page : le badge CI a besoin de la liste
  const rows = ordonnerFile(filtrerAuteur(q ? toReviewRows.filter((m) => matchMr(m, q)) : toReviewRows));
  if (!rows.length) {
    /* Filtrer sur « les autres » quand tout est à soi donne une liste vide qui n'est pas une
       recherche infructueuse : on dit laquelle des deux, sinon on croit avoir tout traité. */
    if (!q && filtreAuteur !== 'tous') {
      rendreVide(el, emptyState({ icon: 'search', title: tr(`review.auteur.vide.${filtreAuteur}`),
        text: tr('review.search.count', { n: toReviewRows.length, total: toReviewRows.length }),
        actions: [{ act: 'clear-auteur', label: tr('review.auteur.tous') }] }));
      return;
    }
    rendreVide(el, emptyState({ icon: 'search', title: tr('report.search.none', { q: esc(q) }),
      text: tr('review.search.count', { n: toReviewRows.length, total: toReviewRows.length }),
      actions: [{ act: 'clear-search', label: tr('report.search.clear') }] }));
    return;
  }
  /* Signature : tout ce que la carte affiche. Si le rendu est identique on ne touche pas au
     DOM — donc pas de clignotement au rafraîchissement automatique, et les écouteurs déjà
     posés restent valides (d'où le `return` : les recâbler serait du travail pour rien). */
  /* La signature doit couvrir TOUT ce que la carte affiche, sinon un champ modifié reste à
     l'écran dans son ancienne valeur — un dépôt renommé, un ticket rattaché après coup, une
     branche cible changée passeraient inaperçus. */
  const sig = rows.map((m) => [m.id, m.status, m.iid, m.title, m.project, m.author, m.gitlab_created_at,
    m.has_ticket, m.ticket_key, m.ticket_url, m.web_url, m.forge, m.source_branch, m.target_branch,
    m.size && [m.size.files, m.size.additions, m.size.deletions].join(','), m.updated_at,
    (m.risk || []).map((r) => r.label).join(','), m.closed_seen, m.stale, m.last_error, m.ticket_category,
    // B7 : les cartes touchées font partie de ce que la carte affiche.
    (m.cards || []).map((c) => c.agent_id).join(','),
    /* Le badge de vérification fait partie de ce que la carte affiche : sans lui dans la
       signature, un verdict qui vient de tomber resterait invisible jusqu'au prochain
       changement d'un autre champ. */
    m.verification && [m.verification.id, m.verification.verdict, m.verification.stale,
      m.verification.failed_count, m.verification.detail_source].join(','),
    m.verifiable, mrSelection.has(m.id)].join('\u0001')).join('\u0002');
  if (!renderIfChanged(el, sig, rows.map(mrCard).join(''))) { majBoutonReview(); return; }
  stagger('#toReviewList .card');
  majBoutonReview();       // la recherche et les filtres viennent peut-être de changer la liste
  $$('#toReviewList .mr-pick').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) mrSelection.add(Number(c.value)); else mrSelection.delete(Number(c.value));
    renderMrBulkBar();
  }));
  $$('#toReviewList [data-verify]').forEach((b) => b.addEventListener('click', () => {
    busy(b, () => lancerVerification([Number(b.dataset.verify)]));
  }));
  $$('#toReviewList [data-review]').forEach((b) => b.addEventListener('click', async () => {
    try { await busy(b, () => api(`/mrs/${b.dataset.review}/review`, { method: 'POST' })); toast(tr('toast.review-de-lancee', { iid: b.dataset.iid })); refreshStatus(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
  $$('#toReviewList [data-more]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement.querySelector('.split-menu');
    const ouvrir = menu.hidden;
    closeSplitMenus();
    menu.hidden = !ouvrir;
    b.setAttribute('aria-expanded', String(ouvrir));
    /* LE MENU EST ANCRÉ PAR LE CSS, pas replacé à la main. `placerMenu` est écrit pour les
       COMBOS : il repasse la boîte en `fixed`, lui donne le `left` ET la largeur du
       déclencheur. Sur un champ de recherche large c'est juste ; sur un bouton « ⋯ » de
       39 px collé au bord droit d'une carte, la boîte part de x = 1420, réclame ses 210 px
       de `min-width` et se termine à 1630 — hors d'une fenêtre de 1500. Le menu s'ouvrait
       donc vraiment, invisible, et le clic paraissait sans effet. Sur une fenêtre étroite il
       rentrait : d'où l'intermittence. `.btn-split` est `position: relative` et
       `.split-menu` est `absolute; right: 0` — l'ancrage était déjà correct, il suffisait de
       ne pas l'écraser. C'est ce que fait déjà le menu du caret « Reviewer ▾ », juste à côté.

       Et on débloque l'overflow de la LISTE, comme lui : sans ça, `overflow: hidden` (les
       coins arrondis) rogne le menu par le bas. */
    if (ouvrir) {
      b.closest('.card').classList.add('menu-open');
      const liste = b.closest('.list'); if (liste) liste.classList.add('menu-open');
    }
  }));
  // Split-button : le caret ouvre le menu de surcharge ponctuelle (avec/sans explication).
  $$('#toReviewList [data-review-menu]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement.querySelector('.split-menu');
    const open = menu.hidden;
    closeSplitMenus();
    menu.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    if (open) {
      // La liste a `overflow: hidden` (coins arrondis) → elle rognerait le menu : on
      // débloque son overflow, et on élève la carte au-dessus des suivantes (l'animation
      // card-in crée un contexte d'empilement par carte, sinon le menu passerait dessous).
      b.closest('.card').classList.add('menu-open');
      const list = b.closest('.list'); if (list) list.classList.add('menu-open');
    }
  }));
  $$('#toReviewList [data-review-run]').forEach((b) => b.addEventListener('click', async () => {
    closeSplitMenus();
    try {
      await busy(b, () => api(`/mrs/${b.dataset.reviewRun}/review`, { method: 'POST', body: { explain: b.dataset.explain } }));
      toast(tr(b.dataset.explain === '1' ? 'toast.review-explain-lancee' : 'toast.review-seule-lancee', { iid: b.dataset.iid }));
      refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('#toReviewList [data-done]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const id = b.dataset.done;
      await busy(b, () => api(`/mrs/${id}/done`, { method: 'POST' }));
      toastUndo(tr('toast.classee-sans-review', { iid: b.dataset.iid }), async () => {
        try { await api(`/mrs/${id}/reopen`, { method: 'POST' }); loadSegment(currentSeg); refreshCounts(); } catch (e) { toast(e.message, true); }
      });
      loadToReview(); refreshCounts();
    }
    catch (e) { toast(explainError(e.message), true); }
  }));
  $$('#toReviewList [data-diff]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.diff));
    if (m) busy(b, () => openDiffPreview(m));
  }));
  $$('#toReviewList [data-merge]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.merge));
    if (m) mergeMrFromQueue(m, () => { loadToReview(); refreshCounts(); });
  }));
  $$('#toReviewList [data-ticket]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.ticket), b.dataset.title)));
  $$('#toReviewList [data-dev]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.dev));
    if (!m) { toast(tr('toast.mr-introuvable-dans-la-liste'), true); return; }
    openTaskForMr(m).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true));
  }));
}
// une seule recherche pour les trois stades
/* Debouncé : chaque frappe reconstruisait la liste entière. `debounce` existait déjà et
   servait pour les autres recherches — celle-ci avait été oubliée. */
$('#searchReview').addEventListener('input', debounce(() => (currentSeg === 'to_review' ? renderToReview() : renderReports())));

/* Merge d'une MR depuis la file (sans passer par une review) — pour une MR
   triviale. Confirmation obligatoire (action irréversible et visible par l'équipe).
   Ne marque la MR « traitée » que si le merge a RÉELLEMENT eu lieu : une forge qui
   répond « en attente du pipeline » ne l'a pas encore mergée, on la laisse en file.
   Renvoie true si la MR a été mergée (l'appelant peut alors rafraîchir). */
function mergeMrFromQueue(m, onMerged) {
  openMergeModal({
    url: `/mrs/${m.id}/merge`,
    label: `!${m.iid}`,
    target: m.target_branch,
    forge: m.forge,
    check: `/mrs/${m.id}/merge-check`,
    project: m.project,
    // B2 : de quoi proposer la case Jira — la clé telle que l'écran la connaît déjà.
    mrId: m.id, ticketKey: m.ticket_key || jiraCleDe(m),
    squash: m.squash, removeSourceBranch: m.remove_source_branch,
    onDone: async (r) => {
      if (!r.merged) return;                                  // pipeline en attente : reste en file
      await api(`/mrs/${m.id}/done`, { method: 'POST' }).catch(() => {}); // sort de la file
      if (onMerged) onMerged();
    },
  });
}

// Ferme tous les menus déroulants des split-buttons (review avec/sans explication).
function closeSplitMenus() {
  $$('.split-menu').forEach((m) => { m.hidden = true; });
  $$('[data-review-menu], [data-more], #aMore, #taskMdExport').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  // Retire l'élévation (carte) et le déblocage d'overflow (liste) posés à l'ouverture.
  $$('.menu-open').forEach((el) => el.classList.remove('menu-open'));
}
// Un clic n'importe où ailleurs referme les menus ouverts (enregistré une seule fois).
// `.split-menu-wrap` aussi : sans lui, le clic qui OUVRE le menu d'export le refermerait aussitôt.
document.addEventListener('click', (e) => { if (!e.target.closest('.btn-split, .split-menu-wrap')) closeSplitMenus(); });

function mrCard(m) {
  return `<div class="card" data-id="${m.id}">
    ${/* Case à cocher : vérifier ENSEMBLE des MR qui ne valent qu'ensemble (§8). */''}
    <label class="mr-pick-box" title="${esc(tr('verify.pick.mr-title'))}"><input type="checkbox" class="mr-pick" value="${m.id}" ${mrSelection.has(m.id) ? 'checked' : ''} /></label>
    <div class="card-main">
      <div class="title">${titreMr(m)}</div>
      <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}${m.gitlab_created_at ? ` · ${dateHtml(m.gitlab_created_at, fmtDate(m.gitlab_created_at))}` : ''}</div>
      ${mrLinks(m)}
      <div class="meta branches">${chipBranche(m.source_branch)} <span class="branch-arrow">→</span> ${chipBranche(m.target_branch, { cible: true })}</div>
      ${tailleMr(m)}
      ${/* Les tags sont des MÉTADONNÉES, pas des actions : les laisser dans la rangée de
            boutons décalait celle-ci d'une carte à l'autre selon le nombre de tags. */''}
      <div class="card-tags">
        ${(m.risk || []).map((r) => `<span class="tag risk" title="${esc(tr('mr.risk-title', { pattern: r.path_match }))}">${svgIco('alert')} ${esc(r.label)}</span>`).join('')}
        <span class="tag ${mrStatus(m.status).cls}">${mrStatus(m.status).label}</span>
        ${badgeDraft(m)}
        ${fenteBrouillons(m)}
        ${badgeSeverites(m)}
        ${badgeCartes(m)}
        ${badgeTicket(m)}
        ${badgeConflit(m)}
        ${(m.lots || []).slice(0, 2).map((l) => `<span class="tag" title="${esc(tr('mr.lot.title', { name: l.name }))}">${svgIco('inbox')} ${esc(l.name)}</span>`).join('')}
        ${badgeCI(m.source_branch)}
        ${verifyBadge(m.verification)}
        ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
        ${m.last_error ? `<span class="tag stale">${tr('mr.tag.error')}</span>` : ''}
      </div>
    </div>
    <div class="card-actions">
    <div class="btn-group">
    <button class="btn" data-diff="${m.id}" title="${tr('mr.btn.diff-title')}"><svg class="ico"><use href="#i-eye"/></svg>${tr('mr.btn.diff')}</button>
    <button class="btn" data-ticket="${m.id}" data-title="!${m.iid} — ${esc(m.title || '')}" title="${tr('mr.btn.context-title')}"><svg class="ico"><use href="#i-doc"/></svg>${m.has_ticket ? tr('mr.btn.context-done') : tr('mr.btn.context')}</button>
    </div>
    <div class="btn-group">
    <span class="btn-split">
      <button class="btn btn-primary" data-review="${m.id}" data-iid="${esc(m.iid)}" title="${tr('mr.btn.review-title')}"><svg class=\"ico\"><use href=\"#i-play\"/></svg>${tr('mr.btn.review')}</button>
      <button class="btn btn-primary btn-split-caret" data-review-menu="${m.id}" title="${tr('mr.btn.review-opts-title')}" aria-haspopup="true" aria-expanded="false">▾</button>
      <div class="split-menu" hidden role="menu">
        <button role="menuitem" data-review-run="${m.id}" data-iid="${esc(m.iid)}" data-explain="1">${tr('mr.btn.review-with-explain')}</button>
        <button role="menuitem" data-review-run="${m.id}" data-iid="${esc(m.iid)}" data-explain="0">${tr('mr.btn.review-no-explain')}</button>
      </div>
    </span>
    </div>
    ${/* LE RESTE DANS UN MENU. La carte portait sept actions de même poids, dont un bouton
          conditionnel : « Vérifier », « Classer » et « Merger » changeaient d'abscisse d'une
          carte à l'autre, et la liste devenait une suite de rangées à relire au lieu d'une
          colonne à balayer. Trois actions fixes + « ⋯ » : la colonne redevient un rail, et
          rien n'est perdu — tout est à un clic, dans un ordre stable.
          Les attributs `data-*` sont IDENTIQUES à ceux d'avant : les écouteurs délégués les
          retrouvent dans le menu comme ils les trouvaient sur la carte. */''}
    <span class="btn-split">
      <button class="btn" data-more="${m.id}" title="${esc(tr('mr.btn.more-title'))}" aria-haspopup="true" aria-expanded="false">⋯</button>
      <div class="split-menu" hidden role="menu">
        <button role="menuitem" data-dev="${m.id}" data-branch="${esc(m.source_branch)}">${tr('mr.btn.code')}</button>
        <button role="menuitem" data-verify="${m.id}" ${m.verifiable ? '' : 'disabled'} title="${m.verifiable ? '' : esc(tr('err.verify.no-verifier'))}">${tr('verify.btn.verify')}</button>
        ${m.verification ? `<button role="menuitem" data-vresults="${m.id}">${tr('verify.btn.results')}</button>` : ''}
        ${/* LE MESSAGE SLACK TOUT FAIT. « Où en est !217 ? » se répond en collant une ligne
              qui porte l'essentiel : le numéro, le titre, la note, le verdict, l'adresse. */''}
        ${/* B8 — LA QA VEUT !217 EN RECETTE. Le job est déclaré pour ce dépôt : il apparaît
              quand la merge request est VÉRIFIÉE VERTE, avec sa branche pré-remplie. Ni avant
              (on ne déploie pas ce qui n'est pas vérifié), ni sans confirmation. */''}
        ${(m.verification && m.verification.verdict === 'verified_pass' && !m.verification.stale)
    ? (m.jenkins_jobs || []).map((j) => `<button role="menuitem" data-mr-jenkins="${esc(j.path)}" data-param="${esc(j.param || '')}" data-branch="${esc(m.source_branch)}" title="${esc(tr('mr.title.jenkins-run'))}">${esc(tr('mr.btn.jenkins-run', { job: j.path }))}</button>`).join('')
    : ''}
        <button role="menuitem" data-copy-ref="${m.id}">${tr('mr.btn.copy-ref')}</button>
        ${/* C11 — SURVEILLER LE TICKET DE CETTE MR. La clé est déjà déduite (elle est écrite
              sur la carte) ; il fallait pourtant aller dans Jira → Surveillés et la retaper.
              L'entrée n'apparaît que si Jira est connecté et qu'une clé a été trouvée. */''}
        ${jiraConfigured && (m.ticket_key || jiraCleDe(m))
    ? `<button role="menuitem" data-jira-watch="${esc(m.ticket_key || jiraCleDe(m))}">${tr('mr.btn.watch-ticket', { key: m.ticket_key || jiraCleDe(m) })}</button>`
    : ''}
        <button role="menuitem" data-done="${m.id}" data-iid="${esc(m.iid)}">${tr('mr.btn.dismiss')}</button>
        ${m.closed_seen ? '' : `<button role="menuitem" class="danger" data-merge="${m.id}">${tr('task.btn.merge')}</button>`}
      </div>
    </span>
    </div>
    </div>
  </div>${m.last_error ? errorBox(m.last_error, m.id) : ''}`;
}

/* La référence se compose de ce que la LISTE porte déjà — aucune requête : la note et le
   verdict sont dans la charge utile de la carte, l'adresse aussi. */
function refMr(m) {
  const bouts = [];
  if (m.note && m.note.value != null) bouts.push(fmtNote(m.note));
  const v = m.verification && m.verification.verdict;
  if (v) bouts.push(tr(`mr.ref.verdict.${v}`));
  const qualif = bouts.length ? ` (${bouts.join(' · ')})` : '';
  /* TOP 5 — ET LE LIEN MERGERIE, à côté de celui de la forge. Ce ne sont pas les mêmes
     destinations : la forge montre le diff, Mergerie montre le rapport, la note, le verdict et
     les remarques. Coller la référence dans une note ou un message donne donc les deux — le
     lien interne n'existe que depuis que les objets ont une adresse. */
  const ici = `${window.location.origin}${window.location.pathname}#/reviews/${m.id}`;
  return `!${m.iid} — ${m.title || ''}${qualif} ${m.web_url || ''} ${ici}`.trim();
}
/* La clé de ticket d'une merge request, telle que l'écran la connaît déjà : le serveur la
   pose (`ticket_key`), et à défaut on la relit dans la branche — la même règle que partout. */
function jiraCleDe(m) {
  /* LE SERVEUR LA POSE, on la lit. L'écran la redéduisait ici avec sa propre expression — une
     règle de plus, qui ne disait pas la même chose que celle du serveur (`jira.ticketKey` :
     les crochets du titre d'abord, la branche ensuite) sur un titre qui cite deux clés. */
  return String((m && m.ticket_key) || (m && m.ticket_jira_key) || '').toUpperCase();
}
/* C11 — surveiller depuis la carte. On NAVIGUE vers la liste des surveillés après coup :
   ajouter en silence laisserait douter que quelque chose se soit passé. */
document.addEventListener('click', async (e) => {
  const w = e.target.closest && e.target.closest('[data-jira-watch]');
  if (!w) return;
  const cle = w.dataset.jiraWatch;
  try {
    await api('/jira/watch', { method: 'POST', body: { key: cle } });
    toast(tr('jira.watch.added', { key: cle }));
  } catch (err) { toast(explainError(err.message), true); return; }
  navTab('jira');
  showJiraSub('watch');
});

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-copy-ref]');
  if (!b) return;
  /* La carte peut venir de l'une ou l'autre file : « à traiter » et « reviewées / traitées »
     sont deux tableaux distincts, et le menu ⋯ existe dans les deux. */
  const id = Number(b.dataset.copyRef);
  const m = (toReviewRows || []).concat(reportRows || []).find((x) => x.id === id);
  if (!m) return;
  copyText(refMr(m), null);
  toast(tr('mr.ref.copied'));
});

$('#btnDiscover').addEventListener('click', async () => {
  const db_ = $('#btnDiscover');
  $('#discoverInfo').textContent = tr('review.discovering');
  db_.dataset.busy = '1'; db_.disabled = true;
  try {
    const r = await api('/discover', { method: 'POST' });
    $('#discoverInfo').textContent = tr('review.discover.result', { found: r.found, created: r.created, updated: r.updated })
      + (r.errors.length ? tr('review.discover.errors', { n: r.errors.length, count: r.errors.length }) : '');
    $('#reviewErrors').innerHTML = r.errors.length
      ? r.errors.map((er) => errorBox(`${er.repo} : ${er.error}`)).join('')
      : '';
    /* Les compteurs et « Reviewer » suivent la file : sans eux, une file vide qui se remplit
       gardait « 0 » et un bouton grisé au-dessus des cartes qu'on venait de découvrir. */
    await loadToReview();
    refreshCounts();
  } catch (e) { $('#discoverInfo').textContent = ''; $('#reviewErrors').innerHTML = errorBox(e.message); }
  finally { delete db_.dataset.busy; db_.disabled = false; }
});

/* A14 — « REVIEWER » PORTE SUR CE QU'ON VOIT, PAS SUR LA FILE ENTIÈRE. Le bouton lançait les
   quarante merge requests de la file quels que soient la recherche et les filtres : on
   cherchait « paiement », on cliquait, et trente-sept reviews sans rapport partaient avec. Il
   suit donc ce qui est à l'écran — et la SÉLECTION quand il y en a une, puisque cocher des
   cartes est déjà la façon de désigner un sous-ensemble ici. */
function mrsAReviewer() {
  if (mrSelection.size) return [...mrSelection];
  const affichees = $$('#toReviewList .card[data-id]').map((c) => Number(c.dataset.id)).filter(Boolean);
  return affichees.length ? affichees : toReviewRows.map((m) => m.id);
}

$('#btnReview').addEventListener('click', async () => {
  const ids = mrsAReviewer();
  const n = ids.length;
  /* LE TITRE PORTE LA QUESTION. « Confirmer l'action » ne dit ni quoi ni combien : sur une
     action en masse, c'est le nombre qui fait hésiter, et il était noyé dans le paragraphe. */
  if (n > 5 && !await confirmDialog({
    title: tr('confirm.review-all.title', { n, count: n }),
    text: tr('confirm.review-all', { n }), confirmLabel: tr('mr.btn.review'), danger: false,
  })) return;
  const b = $('#btnReview');
  try {
    /* Toute la file → aucun corps (le serveur la recompose, c'est le comportement d'origine) ;
       un sous-ensemble → la liste, parce que « ce qui est affiché » n'a de sens que côté
       écran : une recherche et un filtre d'auteur ne se rejouent pas en SQL. */
    const tout = n === toReviewRows.length;
    await busy(b, () => api('/jobs/review', { method: 'POST', body: tout ? undefined : { mr_ids: ids } }));
    toast(tr('toast.review-de-mr-lancee', { n: n }));
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
});

