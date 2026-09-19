'use strict';
/* Rapports : filtre couleur, sélecteur de version, B7, B2, B3, conflit, TOP 1, « périmé ». */
// @expose assurerJenkinsPourCI, badgeCI, badgeTicket, ciDeLaBranche, loadReports, passeFiltreNote, reinitFiltreNote, reportRows, selectedMr, seuilPret
/* ---------- Rapports ---------- */
let selectedMr = null;
let reportRows = [];

/* ---- Filtre par couleur de note (stades « Reviewées » et « Traitées ») ----
   Trois cases indépendantes : on cherche « les rouges ET les oranges », pas une tranche.
   Tout coché = pas de filtre, et c'est l'état par défaut — un filtre resté actif d'une
   session à l'autre ferait croire à une liste vide. Il survit quand même au rechargement :
   décocher à chaque visite serait pire.

   Une carte SANS note (rapport dont aucune note n'a pu être extraite) n'appartient à aucune
   des trois couleurs. Elle reste visible tant qu'on ne filtre pas ; dès qu'on choisit des
   couleurs, elle sort — demander « les rouges » ne doit pas ramener des cartes grises. */
/* `none` = rapport dont AUCUNE note n'a pu être lue. C'est une classe comme les autres, sans
   quoi ces rapports quittaient la liste au premier filtre posé — sans case pour les rappeler,
   et sans que rien ne dise qu'ils existaient. */
const NOTE_CLASSES = ['good', 'mid', 'bad', 'none'];
const ANCIENNES_NOTE_CLASSES = ['good', 'mid', 'bad'];
let noteFilter = new Set(NOTE_CLASSES);
try {
  const brut = JSON.parse(localStorage.getItem('aidevtools_note_filter') || 'null');
  if (Array.isArray(brut)) {
    const garde = brut.filter((c) => NOTE_CLASSES.includes(c));
    /* Un filtre enregistré AVANT l'arrivée de « sans note » et qui portait les trois couleurs
       voulait dire « tout » : le relire à la lettre décocherait la nouvelle case et masquerait
       ces rapports sans que personne l'ait demandé. */
    const toutAvant = ANCIENNES_NOTE_CLASSES.every((c) => garde.includes(c));
    // Un filtre vide n'afficherait rien et n'aurait pas d'issue évidente : on revient à tout.
    if (garde.length && !toutAvant) noteFilter = new Set(garde);
  }
} catch { /* stockage indisponible ou valeur illisible : filtre par défaut */ }

const filtreNoteActif = () => noteFilter.size < NOTE_CLASSES.length;
const passeFiltreNote = (m) => !filtreNoteActif() || noteFilter.has(noteClass(m.note) || 'none');

/* « PRÊTE À MERGER » : les quatre critères du brief, mot pour mot. Deux règles ailleurs pour la
   même phrase finiraient par ne plus compter la même chose — et c'est justement le nombre
   annoncé le matin qu'on vient vérifier ici. Le seuil vient du brief (réglable), 8 à défaut. */
let seuilPret = 8;
function estPreteAMerger(m) {
  if (!m || m.closed_seen) return false;
  if (note10(m) === 99 || note10(m) < seuilPret) return false;
  if (m.has_conflicts) return false;
  const cat = m.ticket_category;
  if (cat && cat !== 'indeterminate') return false;
  const v = m.verification;
  if (!v || v.verdict !== 'verified_pass' || v.stale) return false;
  return true;
}
let filtrePretActif = false;

async function loadReports(status = 'reviewed') {
  /* SQUELETTE AU PREMIER AFFICHAGE DE CE STADE. « Reviewées » et « Traitées » n'en avaient
     pas : sous latence, la colonne restait un blanc muet — impossible de distinguer « ça
     charge » de « il n'y a rien ». Un drapeau PAR STADE, parce qu'on passe de l'un à l'autre
     et que chacun a son premier affichage. */
  if (!stadeDejaCharge.has(status)) $('#reportList').innerHTML = skeleton(3);
  reportRows = await api(`/mrs?status=${status}`);
  stadeDejaCharge.add(status);
  listeChargee = true;
  renderFiltreAuteur();
  renderReports();
}
function renderReports() {
  const el = $('#reportList');
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  majFiltreNote();
  if (!reportRows.length) {
    rendreVide(el, emptyState({ icon: 'doc',
      title: currentSeg === 'done' ? tr('report.empty.done.title') : tr('report.empty.none.title'),
      text: currentSeg === 'done' ? tr('report.empty.done.text') : tr('report.empty.none.text'),
      actions: [{ act: 'seg-to-review', label: tr('report.empty.action'), primary: true }] }));
    return;
  }
  const cherchees = ordonnerFile(filtrerPret(filtrerAuteur(q ? reportRows.filter((m) => matchMr(m, q)) : reportRows)));
  if (!cherchees.length) {
    rendreVide(el, emptyState({
      icon: 'search',
      title: tr('report.search.none', { q: esc(q) }),
      text: tr('report.search.count', { n: reportRows.length, total: reportRows.length }),
      actions: [{ act: 'clear-search', label: tr('report.search.clear') }],
    }));
    return;
  }
  const rows = cherchees.filter(passeFiltreNote);
  /* Tout masqué par les couleurs : le dire, et proposer la sortie. Une liste vide sans
     explication au-dessus de trois cases décochées se lit comme « il n'y a rien ». */
  if (!rows.length) {
    rendreVide(el, emptyState({
      icon: 'search',
      title: tr('review.filter.empty.title'),
      text: tr('review.filter.empty.text', { n: cherchees.length, count: cherchees.length }),
      actions: [{ act: 'clear-note-filter', label: tr('review.filter.clear'), primary: true }],
    }));
    return;
  }
  const sig = [selectedMr, ...rows.map((m) => [m.id, m.status, m.iid, m.title, m.project, m.author,
    m.gitlab_created_at, m.ticket_key, m.ticket_url, m.forge, m.note && m.note.raw, m.closed_seen,
    m.note_detail && [m.note_detail.version, m.note_detail.n_resolved, m.note_detail.n_persistent, m.note_detail.n_new].join(','),
    m.size && [m.size.files, m.size.additions, m.size.deletions].join(','), m.updated_at,
    m.stale, m.verifiable, (m.cards || []).map((c) => c.agent_id).join(','),
    (m.lots || []).map((l) => l.id).join(','),
    m.verification && [m.verification.id, m.verification.verdict, m.verification.stale,
      m.verification.failed_count, m.verification.detail_source].join(',')].join('\u0001'))].join('\u0002');
  const html = rows.map((m) => `
    <div class="card selectable report-card ${selectedMr === m.id ? 'active' : ''}" data-id="${m.id}">
      ${noteBadge(m.note, m)}
      <div class="report-main">
        <div class="title">${titreMr(m)}</div>
        <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}${m.gitlab_created_at ? ` · ${dateHtml(m.gitlab_created_at, fmtDate(m.gitlab_created_at))}` : ''}${ticketLink(m.ticket_url, m.ticket_key)}</div>
        ${/* A13 — LA TAILLE ET LES LOTS, comme sur une carte à traiter. Le tri « petites
              d'abord » s'applique à ce stade aussi, et il triait sur une donnée que la carte
              ne montrait pas : on lisait une liste réordonnée sans voir selon quoi. Un lot,
              lui, dit que cette merge request ne se merge pas seule. */''}
        ${tailleMr(m)}
        <div class="report-tags">
          ${(m.lots || []).slice(0, 2).map((l) => `<span class="tag" title="${esc(tr('mr.lot.title', { name: l.name }))}">${svgIco('inbox')} ${esc(l.name)}</span>`).join('')}
          <span class="tag ${mrStatus(m.status).cls}">${mrStatus(m.status).label}</span>
          ${badgeDraft(m)}
          ${fenteBrouillons(m)}
          ${badgeSeverites(m)}
          ${badgeCartes(m)}
          ${badgeTicket(m)}
          ${badgeConflit(m)}
          ${badgeCI(m.source_branch)}
          ${verifyBadge(m.verification)}
          ${/* Une MR déjà reviewée se vérifie aussi : la review est un avis, le verdict un fait. */''}
          ${m.verifiable ? `<button class="btn btn-sm" data-verify-report="${m.id}" title="${tr('verify.btn.verify-title')}">${svgIco('check')}${tr('verify.btn.verify')}</button>` : ''}
          ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
          ${m.stale ? `<span class="tag stale" data-stale-mr="${m.id}">${tr('mr.tag.stale')}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
  if (!renderIfChanged(el, sig, html)) return;
  stagger('#reportList .card');
  $$('#reportList .card').forEach((c) => c.addEventListener('click', () => openReport(Number(c.dataset.id))));
  // Le bouton vit DANS une carte cliquable : sans cette coupure, vérifier ouvrirait aussi le rapport.
  $$('#reportList [data-verify-report]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    busy(b, () => lancerVerification([Number(b.dataset.verifyReport)]));
  }));
  if (!selectedMr) renderReportPlaceholder();
}
// la recherche est partagée : #searchReview rafraîchit le stade courant

/* Cases et compteurs du filtre de note. Le compteur porte sur ce que la RECHERCHE a laissé,
   pas sur tout le stade : sinon « 3 rouges » resterait affiché à côté d'une liste filtrée
   qui n'en montre aucun. Il se lit donc « en cochant ceci, voilà ce qui apparaît ». */
function majFiltreNote() {
  const boite = $('#noteFilters');
  if (!boite) return;
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  const base = q ? reportRows.filter((m) => matchMr(m, q)) : reportRows;
  const parCouleur = {};
  for (const m of base) {
    const c = noteClass(m.note) || 'none';   // les sans-note se comptent aussi : ils existent
    parCouleur[c] = (parCouleur[c] || 0) + 1;
  }
  $$('.note-pick', boite).forEach((c) => { c.checked = noteFilter.has(c.value); });
  const nPret = base.filter(estPreteAMerger).length;
  parCouleur.ready = nPret;
  $$('[data-nf-count]', boite).forEach((s) => { s.textContent = parCouleur[s.dataset.nfCount] || 0; });
  /* La case ne s'affiche que dans « Reviewées » : à traiter, aucune MR n'a de note, et une case
     qui ne peut rien cocher n'aide personne. */
  const pret = $('#filtrePret');
  if (pret) {
    pret.checked = filtrePretActif;
    const item = pret.closest('.nf-item');
    if (item) item.hidden = currentSeg !== 'reviewed';
  }
  boite.classList.toggle('is-filtering', filtreNoteActif());
  /* Rien à filtrer, rien à montrer : sur un stade vide, trois cases au-dessus d'un message
     « aucun rapport » n'aident personne. (Le stade « À traiter » masque toute la colonne :
     ses cartes n'ont pas de note — une MR n'y revient qu'après suppression de son rapport.) */
  boite.hidden = !reportRows.length;
}

function ecrireFiltreNote() {
  try { localStorage.setItem('aidevtools_note_filter', JSON.stringify([...noteFilter])); } catch { /* ignore */ }
}

function reinitFiltreNote() {
  noteFilter = new Set(NOTE_CLASSES);
  ecrireFiltreNote();
  renderReports();
}

onEl($('#filtrePret'), 'change', () => {
  filtrePretActif = !!$('#filtrePret').checked;
  renderReports();
});

$$('#noteFilters .note-pick').forEach((c) => c.addEventListener('change', () => {
  if (c.checked) noteFilter.add(c.value); else noteFilter.delete(c.value);
  /* Tout décocher afficherait une liste vide dont la sortie n'est pas évidente — la case
     qu'on vient de décocher est la seule à pouvoir la rouvrir. On revient donc à « tout ». */
  if (!noteFilter.size) noteFilter = new Set(NOTE_CLASSES);
  ecrireFiltreNote();
  renderReports();
}));

/* Couleur d'une note. Une seule définition des seuils, partagée par la pastille et par le
   filtre : deux tables de seuils finiraient par diverger, et une carte verte se retrouverait
   masquée en cochant « vert ». `null` = pas de note extraite du rapport. */
function noteClass(note) {
  if (!note || note.value == null) return null;
  return note.value >= 0.7 ? 'good' : (note.value >= 0.4 ? 'mid' : 'bad');
}

// Pastille de note globale colorée (vert = bon, orange = moyen, rouge = mauvais).
/* CE QUE LE SÉLECTEUR DE VERSION DIT UNE FOIS LE RAPPORT OUVERT. Le badge portait la note et
   rien d'autre : pour savoir de quelle passe elle vient, ce qu'elle a résolu et si elle porte
   encore sur le code actuel, il fallait ouvrir. Le survol le dit — c'est déjà dans la charge
   utile de la liste, aucune requête de plus. */
function detailNote(m) {
  const d = m && m.note_detail;
  const bouts = [];
  if (d && d.version) bouts.push(`v${d.version}`);
  if (d && d.at) bouts.push(fmtDate(d.at));
  /* « par Claire », quand l'équipe partage un dépôt de données. Le nom vient de git — celui qui
     a commité le fichier du rapport —, donc aucune colonne à tenir et rien à saisir. En
     mono-poste il n'y en a pas, et « par moi » sur chaque ligne n'apprendrait rien. */
  if (d && d.author) bouts.push(tr('share.by', { name: d.author }));
  if (d && d.n_resolved) bouts.push(tr('review.note.detail.resolved', { n: d.n_resolved, count: d.n_resolved }));
  if (d && d.n_persistent) bouts.push(tr('review.note.detail.persistent', { n: d.n_persistent, count: d.n_persistent }));
  if (d && d.n_new) bouts.push(tr('review.note.detail.new', { n: d.n_new, count: d.n_new }));
  if (m && m.stale) bouts.push(tr('review.note.detail.stale'));
  return bouts.join(' · ');
}
/* Un nombre est une porte, ici aussi : la review la plus chère s'ouvre. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-stat-mr]');
  if (!b) return;
  navTab('review'); openReport(Number(b.dataset.statMr));
});

document.addEventListener('click', (e) => {
  if (!(e.target.closest && e.target.closest('[data-brief-pretes]'))) return;
  /* Le brief COMPTE ce qui ne demande plus rien ; la file, elle, n'a plus de puce pour les
     isoler. On mène donc au stade où elles vivent — « Reviewées » — et c'est là qu'on lit
     les badges carte par carte. */
  navReviews('reviewed');
});

/* B7 — UNE MR EN CONFLIT QUI N'EST PAS NÉE D'UNE SESSION. « Mettre à jour avec main » n'existe
   que pour les branches que l'outil a écrites : pour celle d'un collègue, il n'y avait rien —
   on allait la résoudre dans un terminal alors que l'écran de résolution vit deux onglets plus
   loin. Le badge y mène, pré-rempli dans le sens qui débloque : on fusionne la branche CIBLE
   (`main`) DANS la branche de la merge request, ce qui est exactement le rattrapage. Rien
   n'est lancé : le formulaire est posé, « Préparer le merge » reste à cliquer. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-mr-conflit]');
  if (!b) return;
  const m = (toReviewRows.concat(reportRows)).find((x) => String(x.id) === b.dataset.mrConflit);
  if (!m) return;
  mergeMemoriser({ repo_id: m.repo_id, source: m.target_branch, target: m.source_branch });
  navTab('git');
  showGitSub('merge');
  toast(tr('toast.conflict-to-merge', { iid: m.iid, base: m.target_branch || '' }));
});

/* B8 — ouvrir le job Jenkins avec la branche de la merge request. On ouvre la FICHE (jamais
   un lancement direct) : les paramètres se lisent, et le bouton « Lancer avec ces paramètres »
   reste à cliquer. Le paramètre qui reçoit la branche est celui déclaré dans le lien ; sans
   lui, la fiche s'ouvre telle quelle — mieux qu'un pré-remplissage deviné. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-mr-jenkins]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  navTab('jenkins');
  await openJenkinsJob(b.dataset.mrJenkins);
  const nom = b.dataset.param;
  if (!nom) return;
  const champ = $(`#jenkinsModalBody [data-jkparam="${CSS.escape(nom)}"]`);
  if (champ) jkPoserParams([{ name: nom, value: b.dataset.branch }]);
});

/* ---------- B2 : le dernier build Jenkins qui porte CETTE branche ----------
   On pousse depuis la session, `front-build` casse sur la branche, et la carte de !219 dit
   « vérifié » — le vérificateur de Mergerie est vert, Jenkins fait autre chose. On le
   découvrait une heure plus tard en ouvrant l'onglet.

   Aucun appel de plus : la liste Jenkins est déjà chargée (ouverture de l'onglet ou intervalle
   réglé), et chaque job porte la branche de son dernier build. On croise sur le NOM DE BRANCHE,
   et on l'écrit sur la carte — sans jamais le confondre avec le verdict objectif, qui est un
   autre badge, d'une autre couleur, avec un autre mot. */
/* La liste Jenkins est chargée à l'ouverture de SON onglet. Pour que le badge existe sur une
   carte de merge request sans y être passé, on la demande UNE FOIS par chargement de page —
   et seulement si Jenkins est configuré. C'est le même appel que fait l'onglet, fait plus tôt :
   pas un sondage, et rien de plus quand on ouvre ensuite Jenkins (la liste est déjà là). */
let jenkinsPourCI = false;
async function assurerJenkinsPourCI() {
  if (jenkinsPourCI || (JENKINS.jobs || []).length) return;
  jenkinsPourCI = true;
  try {
    const d = await api('/jenkins/jobs');
    if (!d || !d.configured) return;
    JENKINS.jobs = d.jobs || [];
    JENKINS.configured = true;
    // La file est peut-être déjà affichée : elle se redessine avec les badges.
    if ($('#tab-review').classList.contains('active')) loadSegment(currentSeg);
  } catch { /* Jenkins injoignable : pas de badge, et rien à signaler ici */ }
}

function ciDeLaBranche(branche) {
  const b = String(branche || '').trim();
  if (!b || !(JENKINS.jobs || []).length) return null;
  const j = (JENKINS.jobs || []).find((x) => String(x.ref || '').trim() === b);
  if (!j || !j.lastNumber) return null;
  return { path: j.path, number: j.lastNumber, statut: j.statut, enCours: !!j.enCours };
}
function badgeCI(branche) {
  const ci = ciDeLaBranche(branche);
  if (!ci) return '';
  /* LE VOCABULAIRE DE JENKINS, PAS UN AUTRE. `jenkins.js` normalise les couleurs de l'API en
     `succes` / `echec` / `instable` / `desactive` / `inconnu` ; comparer à « ok » et « ko »
     ne matchait JAMAIS — un build vert portait donc une croix, et sans couleur. */
  const ok = ci.statut === 'succes';
  const rouge = ci.statut === 'echec';
  const cls = ci.enCours ? 'to_review' : (ok ? 'done' : (rouge ? 'stale' : (ci.statut === 'instable' ? 'to_review' : '')));
  const signe = ci.enCours ? '⋯' : (ok ? '✓' : (rouge ? '✗' : '~'));
  return `<button type="button" class="tag ${cls}" data-ci-job="${esc(ci.path)}" title="${esc(tr('mr.ci.title', { job: ci.path }))}">CI #${ci.number} ${signe}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-ci-job]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  navTab('jenkins');
  openJenkinsJob(b.dataset.ciJob);
});

/* ---------- B3 : ce que le TICKET dit de cette merge request ----------
   Vendredi la QA passe PROJ-1408 en « En revue » : la merge request attend depuis trois jours
   au milieu de onze cartes, et personne ne fait le lien. Deux situations méritent un mot, et
   deux seulement :
     — le ticket est passé EN REVUE et la merge request est encore à traiter : elle remonte ;
     — le ticket est TERMINÉ et la merge request est encore ouverte : quelque chose cloche.
   L'état vient des tickets SURVEILLÉS, la seule liste que le serveur connaisse hors ligne :
   aucun appel à Jira n'est fait pour dessiner une liste. */
/* EN CONFLIT — lu de `mr.has_conflicts`, que la forge a dit et que l'outil écrivait déjà
   (à la découverte, et à l'ouverture de la modale de merge). Personne ne le relisait entre
   deux ouvertures : on ouvrait la modale pour apprendre qu'on ne pouvait pas merger. Le badge
   porte le geste qui débloque — résoudre dans Git → Merge — parce qu'un badge qui constate
   sans offrir de suite ne fait qu'ajouter une mauvaise nouvelle. */
function badgeConflit(m) {
  if (!m || !m.has_conflicts) return '';
  return `<button type="button" class="tag conflit" data-mr-conflit="${m.id}"`
    + ` title="${esc(tr('mr.tag.conflict-title', { target: m.target_branch || '' }))}">`
    + `${svgIco('alert')} ${esc(tr('mr.tag.conflict'))}</button>`;
}
/* BROUILLON : « je n'ai pas fini ». Le badge ne bloque rien — le bouton « Reviewer » reste là,
   relire un brouillon exprès est une décision — mais il change ce qu'on attend du rapport, et
   il explique pourquoi la review automatique a laissé cette merge request de côté. */
/* TOP 1 — LES REMARQUES ÉCRITES ET JAMAIS ENVOYÉES, sur la carte. Trois commentaires inline
   rédigés dans le viewer puis oubliés ne laissaient aucune trace hors du viewer : la merge
   request se mergeait sans eux, et personne ne savait qu'ils avaient existé. Le badge mène au
   viewer, là où ils s'envoient. */
function badgeBrouillons(m) {
  const d = m && m.drafts;
  if (!d || !d.n) return '';
  return `<button type="button" class="tag draft-pending" data-drafts-mr="${m.id}"
    title="${esc(tr('mr.drafts.title', { n: d.n, count: d.n, when: d.depuis ? fmtDateTime(d.depuis) : '' }))}">`
    + `${svgIco('doc')} ${esc(tr('mr.drafts', { n: d.n, count: d.n }))}</button>`;
}

/* LE MÊME FAIT À DEUX ENDROITS. Le compteur du viewer et le badge de la carte comptent les
   mêmes remarques ; seul le premier se redessinait. On en supprimait une, le viewer disait
   « 2 » et la carte continuait d'annoncer « 3 remarques en attente » — et comme le badge sert
   justement à ne pas oublier ce travail, il envoyait relire un lot déjà vidé. Le badge est
   donc posé dans une FENTE nommée : le viewer la réécrit sur place, sans recharger la liste
   (et sans perdre le filtre, le tri ni la position de lecture). */
function fenteBrouillons(m) {
  return `<span class="draft-slot" data-drafts-slot="${m.id}">${badgeBrouillons(m)}</span>`;
}
/* Les lignes de liste gardées en mémoire portent la même donnée : sans elles, le prochain rendu
   (un filtre, une recherche) ressusciterait le compte périmé. */
function majCartesBrouillons(id, liste) {
  if (!id) return;
  const n = (liste || []).length;
  const dates = (liste || []).map((d) => d.created_at).filter(Boolean).sort();
  const d = n ? { n, depuis: dates[0] || null } : null;
  for (const rows of [toReviewRows, reportRows]) {
    const m = (rows || []).find((x) => x.id === id);
    if (m) m.drafts = d;
  }
  for (const fente of $$(`[data-drafts-slot="${id}"]`)) fente.innerHTML = badgeBrouillons({ id, drafts: d });
}
/* Quand des remarques sont créées AILLEURS que dans le viewer (« Mettre en brouillons » depuis
   le rapport), on relit le lot : la carte et le compteur tiennent le même compte. */
async function rafraichirBrouillons(mrId) {
  if (split.mrId === mrId) { await chargerBrouillons(); return; }
  try {
    const d = await api(`/mrs/${mrId}/comment-drafts`);
    majCartesBrouillons(mrId, d.drafts || []);
  } catch { /* le badge se remettra d'aplomb au prochain chargement de la liste */ }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-drafts-mr]');
  if (!b) return;
  const id = Number(b.dataset.draftsMr);
  navMrReport(id);
  await openSplit(id);
});

function badgeDraft(m) {
  if (!m || !m.is_draft) return '';
  return `<span class="tag draft" title="${esc(tr('mr.tag.draft-title'))}">${svgIco('edit')} ${esc(tr('mr.tag.draft'))}</span>`;
}

function badgeTicket(m) {
  if (!m || !m.ticket_category) return '';
  if (m.ticket_category === 'indeterminate' && m.status === 'to_review') {
    return `<span class="tag to_review" title="${esc(tr('mr.ticket.in-review.title', { key: m.ticket_key || '', status: m.ticket_status || '' }))}">${esc(tr('mr.ticket.in-review'))}</span>`;
  }
  if (m.ticket_category === 'done' && !m.closed_seen) {
    return `<span class="tag stale" title="${esc(tr('mr.ticket.done-open.title', { key: m.ticket_key || '', status: m.ticket_status || '' }))}">${esc(tr('mr.ticket.done-open'))}</span>`;
  }
  return '';
}
/* Le classement de la file : une merge request dont le ticket est passé en revue passe DEVANT.
   Tri stable — à état de ticket égal, l'ordre du serveur est conservé. */
const rangTicket = (m) => (m && m.ticket_category === 'indeterminate' && m.status === 'to_review' ? 0 : 1);

/* ---------- « Périmé », mais de combien ? ----------
   Le badge portait un mot sans mesure. Le compte des commits arrivés depuis la review, et
   leurs messages, disent si la re-review incrémentale coûtera trois lignes ou un refactoring.
   Demandé AU SURVOL seulement — c'est un appel à la forge par merge request — et mis en cache
   pour la durée de la page : on survole le même badge dix fois en parcourant une liste. */
const cacheStale = new Map();
async function chargerStale(id) {
  if (cacheStale.has(id)) return cacheStale.get(id);
  let d = { known: false, count: 0, commits: [] };
  try { d = await api(`/mrs/${id}/stale-commits`); } catch { /* forge injoignable : on ne sait pas */ }
  cacheStale.set(id, d);
  return d;
}
document.addEventListener('mouseover', async (e) => {
  const b = e.target.closest && e.target.closest('[data-stale-mr]');
  if (!b || b.dataset.staleFait === '1') return;
  b.dataset.staleFait = '1';
  const d = await chargerStale(Number(b.dataset.staleMr));
  if (!d.known || !d.count) return;
  b.textContent = `${tr('mr.tag.stale')} · ${tr('mr.stale.commits', { n: d.count, count: d.count })}`;
  /* Les messages en info-bulle : c'est ce qui dit la NATURE du changement, pas seulement son
     volume. Dix au plus — au-delà, la réponse est de toute façon « il faut relire ». */
  b.dataset.tip = d.commits.map((c) => `${c.sha} ${c.title}`).join('\n');
  showTip(b);            // on survole déjà : la bulle doit apparaître maintenant, pas au suivant
});

/* B2 — LA SESSION QUI A PRODUIT CETTE BRANCHE, sur le rapport. Le chemin inverse (session →
   MR) est partout ; celui-ci manquait, et c'est pourtant celui qu'on suit après « Faire
   corriger » : « est-ce que ça tourne ? ». La puce mène à la carte, où « Envoyer un suivi » et
   « Reprendre le rapport » existent déjà — on ne refait pas leur geste ici. */
function origineHtml(t) {
  if (!t || !t.id) return '';
  const enCours = t.status === 'running';
  return `<button type="button" class="tag${enCours ? ' run' : ''}" data-go-session="${t.id}" data-go-kind="${esc(t.kind || 'code')}"
    title="${esc(tr('report.origin.title', { label: t.label || '' }))}">${svgIco('bot')} ${esc(tr(enCours ? 'report.origin.running' : 'report.origin', { id: t.id }))}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-go-session]');
  if (b) ouvrirSession(b.dataset.goSession, b.dataset.goKind);
});

