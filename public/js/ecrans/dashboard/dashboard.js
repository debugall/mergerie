'use strict';
/* Dashboard : d'un constat qui revient à une règle de review, A36 la période et le dépôt, les quatre sous-onglets. */
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

/* QUATRE SOUS-ONGLETS, UNE QUESTION CHACUN. Dix-neuf cartes empilées dans l'ordre où elles
   avaient été écrites : un indicateur pesait autant qu'un tableau de trente lignes, et « où en
   est l'équipe ? » demandait de tout faire défiler. Le découpage suit la question qu'on vient
   poser — où en est-on (vue d'ensemble), qu'est-ce qui passe et à quelle vitesse (flux), ce
   qu'on dit est-il juste (qualité), combien ça coûte (coût) — et le serveur ne calcule que le
   quart demandé. La barre de période et de dépôt vaut pour les quatre ; le sous-onglet ouvert
   est une préférence de navigateur, comme eux. Clés littérales : i18n-check les lit. */
const STATS_SOUS_ONGLETS = {
  apercu: { label: 'stats.sub.apercu', title: 'stats.sub.apercu-title' },
  flux: { label: 'stats.sub.flux', title: 'stats.sub.flux-title' },
  qualite: { label: 'stats.sub.qualite', title: 'stats.sub.qualite-title' },
  cout: { label: 'stats.sub.cout', title: 'stats.sub.cout-title' },
};
let statsSousOnglet = (() => {
  try { const v = localStorage.getItem('aidevtools_stats_sub'); return STATS_SOUS_ONGLETS[v] ? v : 'apercu'; } catch { return 'apercu'; }
})();

/* Les briques communes aux quatre sous-onglets — une tuile, un badge de note, la légende
   d'utilité sous chaque titre (« à quelle question ce graphe répond »). */
const dashTile = (label, value, cls = '') => `<div class="stat-tile ${cls}"><div class="stat-val">${value}</div><div class="stat-lbl">${esc(label)}</div></div>`;
const dashNoteBadge = (v) => (v == null ? '<span class="note none">—</span>' : `<span class="note ${v >= 7 ? 'good' : v >= 4 ? 'mid' : 'bad'}">${v}</span>`);
const dashCap = (key) => `<p class="dash-help">${tr(key)}</p>`;
const dashRequete = (section) => `?days=${statsJours}${statsProjet ? `&project=${encodeURIComponent(statsProjet)}` : ''}${section ? `&section=${section}` : ''}`;

async function loadDashboard() {
  const el = $('#dashboard');
  el.innerHTML = skeleton(4);
  let s;
  try { s = await api(`/stats${dashRequete(statsSousOnglet)}`); } catch (e) { el.innerHTML = errorBox(e.message); return; }
  /* Le combo des dépôts lit `repoOptions`, que d'autres écrans chargent : ouvert en premier,
     Stats n'offrait que « Tous les dépôts ». */
  if (!repoOptions.length) await loadRepoOptions();
  if (!$('#dashboard')) return;

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
  const sousNav = `<div class="segmented dash-subnav" role="tablist">${Object.entries(STATS_SOUS_ONGLETS).map(([id, k]) =>
    `<button type="button" role="tab" data-stats-sub="${id}" class="${id === statsSousOnglet ? 'active' : ''}" title="${esc(tr(k.title))}">${esc(tr(k.label))}</button>`).join('')}</div>`;

  el.innerHTML = barre + sousNav + '<div id="dashPanel"></div>';
  dashRendreSection(statsSousOnglet, s);

  $$('#dashboard [data-stats-jours]').forEach((b) => b.addEventListener('click', () => {
    statsJours = Number(b.dataset.statsJours) || 0;
    try { localStorage.setItem('aidevtools_stats_jours', String(statsJours)); } catch { /* stockage indisponible */ }
    loadDashboard();
  }));
  $$('#dashboard [data-stats-sub]').forEach((b) => b.addEventListener('click', () => showStatsSub(b.dataset.statsSub)));
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
}

/* Changer de sous-onglet ne reconstruit pas la barre : le choix se voit tout de suite, le
   panneau passe en squelette, et seule la section demandée est recalculée. Un sous-onglet
   choisi pendant qu'un autre charge encore gagne : la réponse en retard est ignorée. */
let dashChargement = 0;
async function showStatsSub(sub) {
  if (!STATS_SOUS_ONGLETS[sub]) sub = 'apercu';
  statsSousOnglet = sub;
  try { localStorage.setItem('aidevtools_stats_sub', sub); } catch { /* stockage indisponible */ }
  $$('#dashboard [data-stats-sub]').forEach((b) => b.classList.toggle('active', b.dataset.statsSub === sub));
  const panneau = $('#dashPanel');
  if (!panneau) { loadDashboard(); return; }
  panneau.innerHTML = skeleton(3);
  const jeton = ++dashChargement;
  let s;
  try { s = await api(`/stats${dashRequete(sub)}`); } catch (e) {
    if (jeton === dashChargement && $('#dashPanel')) $('#dashPanel').innerHTML = errorBox(e.message);
    return;
  }
  if (jeton !== dashChargement || !$('#dashPanel')) return;
  dashRendreSection(sub, s);
}

function dashRendreSection(sub, s) {
  const panneau = $('#dashPanel');
  if (!panneau) return;
  if (sub === 'flux') { panneau.innerHTML = dashFluxHtml(s); dashFluxBrancher(s); }
  else if (sub === 'qualite') { panneau.innerHTML = dashQualiteHtml(s); }
  else if (sub === 'cout') { panneau.innerHTML = dashCoutHtml(s); dashCoutBrancher(); }
  else { panneau.innerHTML = dashApercuHtml(s); dashApercuBrancher(); }
}

/* Les tuiles du bandeau sont des portes : un stade de l'entonnoir ouvre Reviews à ce stade (et
   sur le dépôt choisi, s'il y en a un) ; un indicateur ouvre le sous-onglet qui le détaille. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-kpi-seg]');
  if (!b) return;
  navReviews(b.dataset.kpiSeg);
  const champ = $('#searchReview');
  if (champ) { champ.value = statsProjet; champ.dispatchEvent(new Event('input')); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-stats-go]');
  if (!b) return;
  showStatsSub(b.dataset.statsGo);
});
