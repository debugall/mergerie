'use strict';
/* La barre de menus : ordre et visibilité, ce qui est replié d'office, les pastilles (`refreshCounts`), la sidebar. */
/* Même parade que pour les sessions et la palette : plusieurs demandes de compteurs peuvent
   être en vol (fin de job, changement de stade, rafraîchissement périodique), et rien ne
   garantit l'ordre de retour. Sans ce rang, une réponse dépassée reposait les chiffres
   d'AVANT par-dessus les bons — l'écran affichait de nouveau « 4 à traiter » une seconde
   après être passé à 3. */
let countsSeq = 0;
async function refreshCounts() {
  const seq = ++countsSeq;
  try {
    const s = await api('/stats');
    if (seq !== countsSeq) return;          // une demande plus récente a déjà répondu
    const f = s.funnel || {};
    /* Un compteur qui saute de 12 à 13 ne se remarque pas ; un compteur qui COMPTE, si.
       C'est la seule part visible du travail qui vient de se terminer. Animation courte,
       coupée si l'onglet est masqué (rien à montrer) ou en mouvement réduit. */
    const set = (id, n) => {
      const el = $(id); if (!el) return;
      const cible = n || 0; const depart = Number(el.textContent) || 0;
      /* Le compteur naît VIDE et le reste jusqu'à sa donnée : affirmer « 0 » pendant que la
         requête est en vol, c'est dire « rien à traiter » à quelqu'un qui a onze merge
         requests — et sous latence, c'est ce qu'il lit en premier. */
      const premier = el.classList.contains('is-waiting');
      el.classList.remove('is-waiting');
      if (premier || cible === depart || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = cible; return;
      }
      const t0 = performance.now(); const dur = 600;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        el.textContent = Math.round(depart + (cible - depart) * (1 - (1 - k) ** 3));
        if (k < 1) requestAnimationFrame(step); else el.textContent = cible;
      };
      requestAnimationFrame(step);
    };
    set('#segCountToReview', f.to_review); set('#segCountReviewed', f.reviewed); set('#segCountDone', f.done);
    const nav = $('#navCountReview');
    if (nav) {
      const n = f.to_review || 0;
      nav.textContent = n;
      nav.hidden = !n;
      /* Le seul badge de la colonne qui ne disait pas ce qu'il comptait. Même bulle maison que
         ses voisins — et `title = ''`, sinon le navigateur remonterait à celui du bouton. */
      const bulle = tr('nav.reviews.to-review', { n, count: n });
      nav.dataset.tip = bulle;
      nav.title = '';
      nav.setAttribute('aria-label', bulle);
    }
    /* Badge ORANGE : les rapports faibles qui attendent encore une décision. Il complète le
       badge neutre (« à traiter ») sans le remplacer — l'un dit combien de merge requests
       n'ont pas été lues, l'autre lesquelles méritent d'être lues en premier. */
    const bas = $('#navLowScores');
    if (bas) {
      const n = s.lowScores || 0;
      bas.textContent = n;
      bas.hidden = !n;
      bas.title = tr('nav.low-scores', { n, count: n });
    }
    /* AGENTS : ce qui attend une relecture. Le badge existait dans le menu et n'était jamais
       rempli — donc jamais visible. Une carte de connaissance refaite pendant la nuit attendait
       qu'on pense à ouvrir l'onglet. */
    const ag = $('#navCountAgents');
    if (ag) {
      const n = s.agentsPending || 0;
      ag.textContent = n;
      ag.hidden = !n;
      const bulleAg = tr('nav.agents.pending', { n, count: n });
      ag.dataset.tip = bulleAg;
      ag.title = '';
      ag.setAttribute('aria-label', bulleAg);
    }
    aReviewerTotal = f.to_review || 0;
    majBoutonReview();
  } catch { /* compteurs : jamais bloquant */ }
}

/* CE QUE COMPTENT LES PASTILLES DU MENU. Deux nombres, un rouge et un bleu, sur cinq onglets :
   la bulle les explique au survol, mais il faut déjà avoir l'idée de survoler. Le panneau `?`
   est l'endroit où on cherche ce genre de chose — et il ne parlait que de touches. */
const PASTILLES = [
  ['nav.reviews', 'shortcuts.badge.reviews'],
  ['nav.tasks', 'shortcuts.badge.tasks'],
  ['nav.agents', 'shortcuts.badge.agents'],
  ['nav.notes', 'shortcuts.badge.notes'],
  ['nav.jira', 'shortcuts.badge.jira'],
  ['nav.docker', 'shortcuts.badge.docker'],
  ['nav.jenkins', 'shortcuts.badge.jenkins'],
];
/* ---------- La barre de menus : ordre et visibilité ----------
   Préférence de ce NAVIGATEUR, comme le thème et la densité : c'est un arrangement d'écran,
   pas un réglage de l'outil — deux postes n'ont pas les mêmes habitudes, et l'ordre des menus
   ne change rien à ce que l'application fait.

   Ce qu'on stocke est volontairement PARTIEL : la liste des onglets rangés à la main, et celle
   des masqués. Un onglet ajouté dans une version future n'est dans ni l'une ni l'autre — il
   apparaît donc à sa place d'origine, visible. Enregistrer la liste complète l'aurait rendu
   invisible chez tous ceux qui avaient touché à leur barre, sans que rien ne le signale.

   L'ordre est appliqué en DÉPLAÇANT les boutons existants, jamais en les reconstruisant : ils
   portent leurs écouteurs, leurs pastilles et leurs infobulles. Les raccourcis chiffrés lisent
   la barre, donc ils suivent tout seuls. */
const NAV_KEY = 'mergerie_nav';
// Réglages : toujours visible. C'est le chemin du retour — le masquer enfermerait dehors.
const NAV_TOUJOURS = 'admin';

/* CE QUI EST REPLIÉ D'OFFICE. Onze entrées, et la plupart des journées n'en demandent que
   quelques-unes : Git, Docker, Jenkins et Liens sont des COMMODITÉS — on y va le jour où on en
   a besoin, pas dix fois par jour —, tandis que Reviews, Dev IA, Agents, Notes et Jira sont le
   travail lui-même. La barre porte donc d'abord ce qui a de la valeur tous les jours, et une
   case des Réglages rend les autres. Rien n'est désactivé au passage : les écrans, les données
   et les fonctions restent entières, c'est la barre qui ne les affiche plus d'entrée.

   Ce défaut ne vaut que pour qui n'a JAMAIS touché sa barre. Une préférence enregistrée fait
   foi, fût-elle antérieure : on ne retire pas ses menus à quelqu'un qui les a rangés lui-même. */
const NAV_MASQUES_DEFAUT = ['git', 'docker', 'jenkins', 'links'];

function lireNav() {
  try {
    const brut = localStorage.getItem(NAV_KEY);
    if (brut == null) return { ordre: [], masques: [...NAV_MASQUES_DEFAUT] };
    const v = JSON.parse(brut) || {};
    return { ordre: Array.isArray(v.ordre) ? v.ordre : [], masques: Array.isArray(v.masques) ? v.masques : [] };
  } catch { return { ordre: [], masques: [...NAV_MASQUES_DEFAUT] }; }
}
function ecrireNav(v) {
  try { localStorage.setItem(NAV_KEY, JSON.stringify(v)); } catch { /* stockage indisponible */ }
}
const boutonsNav = () => $$('nav button[data-tab]');

/* L'ordre effectif : les onglets rangés à la main d'abord, dans l'ordre choisi, puis ceux
   qu'on n'a jamais touchés — à leur place d'origine. */
function ordreNav() {
  const { ordre } = lireNav();
  const presents = boutonsNav().map((b) => b.dataset.tab);
  const connus = ordre.filter((t) => presents.includes(t));
  return [...connus, ...presents.filter((t) => !connus.includes(t))];
}
const navMasque = (tab) => tab !== NAV_TOUJOURS && lireNav().masques.includes(tab);

function appliquerNav() {
  const barre = $('nav');
  if (!barre) return;
  const par = new Map(boutonsNav().map((b) => [b.dataset.tab, b]));
  /* On insère AVANT le premier élément qui n'est pas un onglet (le bouton de repli vit dans la
     barre sans `data-tab`) : sans ce repère, réordonner l'enverrait en tête. */
  const ancre = [...barre.children].find((el) => !el.dataset || !el.dataset.tab) || null;
  for (const tab of ordreNav()) {
    const b = par.get(tab);
    if (!b) continue;
    b.hidden = navMasque(tab);
    barre.insertBefore(b, ancre);
  }
  /* L'onglet courant vient d'être masqué : on ne laisse pas un écran ouvert sans son entrée de
     menu — on bascule sur le premier visible. */
  const actif = boutonsNav().find((b) => b.classList.contains('active'));
  if (actif && actif.hidden) {
    const premier = boutonsNav().find((b) => !b.hidden);
    if (premier) premier.click();
  }
}

/* La liste des Réglages. Les libellés sont LUS dans la barre, jamais recopiés : une seconde
   liste se désynchroniserait au premier onglet ajouté — et au premier changement de langue. */
function renderNavPrefs() {
  const box = $('#navPrefs');
  if (!box) return;
  const tabs = ordreNav();
  box.innerHTML = tabs.map((tab, i) => {
    const b = $(`nav button[data-tab="${tab}"]`);
    const libelle = b ? (b.querySelector('span[data-i18n]') || {}).textContent || tab : tab;
    const fige = tab === NAV_TOUJOURS;
    return `<div class="nav-prefs-row" data-navtab="${esc(tab)}" draggable="true">
      <span class="nav-grip" aria-hidden="true" title="${esc(tr('settings.nav.drag'))}">${svgIco('grip')}</span>
      <label class="inline-check">
        <input type="checkbox" class="nav-show" ${navMasque(tab) ? '' : 'checked'} ${fige ? 'disabled' : ''}
          title="${esc(tr(fige ? 'settings.nav.always' : 'settings.nav.show'))}" />
        <span>${esc(libelle)}</span>
      </label>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-ghost" data-navup="${esc(tab)}" ${i === 0 ? 'disabled' : ''}
        title="${esc(tr('settings.nav.up'))}" aria-label="${esc(tr('settings.nav.up'))}">${svgIco('up')}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-navdown="${esc(tab)}" ${i === tabs.length - 1 ? 'disabled' : ''}
        title="${esc(tr('settings.nav.down'))}" aria-label="${esc(tr('settings.nav.down'))}">${svgIco('down')}</button>
    </div>`;
  }).join('');
}

// Enregistre l'ordre tel qu'il est À L'ÉCRAN, applique, et redessine (flèches des bords).
function enregistrerNav(ordre, masques) {
  ecrireNav({ ordre, masques });
  appliquerNav();
  renderNavPrefs();
}
const ordreAffiche = () => $$('#navPrefs .nav-prefs-row').map((r) => r.dataset.navtab);
const masquesAffiches = () => $$('#navPrefs .nav-prefs-row')
  .filter((r) => !r.querySelector('.nav-show').checked)
  .map((r) => r.dataset.navtab);

$('#navPrefs') && $('#navPrefs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-navup], [data-navdown]');
  if (!b) return;
  const tab = b.dataset.navup || b.dataset.navdown;
  const ordre = ordreAffiche();
  const i = ordre.indexOf(tab);
  const j = b.dataset.navup ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ordre.length) return;
  [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  enregistrerNav(ordre, masquesAffiches());
});
$('#navPrefs') && $('#navPrefs').addEventListener('change', (e) => {
  if (!e.target.classList.contains('nav-show')) return;
  enregistrerNav(ordreAffiche(), masquesAffiches());
});
$('#navPrefsReset') && $('#navPrefsReset').addEventListener('click', () => {
  /* ON EFFACE LA PRÉFÉRENCE, on n'en écrit pas une vide : « rétablir » doit rendre l'état du
     DÉPART — l'ordre du fichier ET les quatre menus repliés —, et une liste de masqués vide
     serait au contraire « tout afficher », ce que personne n'a demandé en cliquant ici. */
  try { localStorage.removeItem(NAV_KEY); } catch { /* stockage indisponible */ }
  /* Rétablir ne suffit pas à remettre les boutons dans l'ordre d'origine : ils ont été
     DÉPLACÉS dans le DOM. On les repose donc dans l'ordre du fichier, qui est celui que
     `NAV_DEFAUT` a retenu au démarrage — avant toute application de préférence. */
  const barre = $('nav');
  const ancre = [...barre.children].find((el) => !el.dataset || !el.dataset.tab) || null;
  for (const tab of NAV_DEFAUT) {
    const b = $(`nav button[data-tab="${tab}"]`);
    if (b) barre.insertBefore(b, ancre);
  }
  appliquerNav();      // et la visibilité d'origine avec, en quittant un onglet qu'elle replie
  renderNavPrefs();
});

/* Glisser-déposer, même geste que les todos : la ligne se déplace DANS le DOM pendant le
   geste (sinon on range à l'aveugle), et l'ordre n'est enregistré qu'au lâcher. */
let navTire = null;
$('#navPrefs') && $('#navPrefs').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.nav-prefs-row');
  if (!row) return;
  navTire = row;
  row.classList.add('dragging');
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.navtab); } catch { /* refusé */ } }
});
$('#navPrefs') && $('#navPrefs').addEventListener('dragover', (e) => {
  if (!navTire) return;
  e.preventDefault();
  const cible = e.target.closest('.nav-prefs-row');
  if (!cible || cible === navTire) return;
  const r = cible.getBoundingClientRect();
  cible.parentNode.insertBefore(navTire, e.clientY < r.top + r.height / 2 ? cible : cible.nextSibling);
});
$('#navPrefs') && $('#navPrefs').addEventListener('drop', (e) => { if (navTire) e.preventDefault(); });
$('#navPrefs') && $('#navPrefs').addEventListener('dragend', () => {
  if (!navTire) return;
  navTire.classList.remove('dragging');
  navTire = null;
  enregistrerNav(ordreAffiche(), masquesAffiches());
});

// L'ordre du FICHIER, relevé avant toute application : c'est lui que « Rétablir » restaure.
const NAV_DEFAUT = boutonsNav().map((b) => b.dataset.tab);
appliquerNav();

/* ---------- Sidebar ---------- */

const SIDEBAR_KEY = 'mergerie_sidebar';
function appliquerSidebar(compacte) {
  document.body.classList.toggle('sidebar-compacte', compacte);
  /* Sous 1100 px, le CSS compacte de lui-même. `sidebar-large` dit « l'utilisateur a
     DEMANDÉ le format large » et lève cette compaction automatique — sans quoi son choix
     serait ignoré sur un écran moyen sans qu'il comprenne pourquoi. */
  document.body.classList.toggle('sidebar-large', !compacte);
  const b = $('#sidebarToggle');
  if (b) b.title = tr(compacte ? 'nav.expand' : 'nav.collapse');
}
$('#sidebarToggle') && $('#sidebarToggle').addEventListener('click', () => {
  const compacte = !document.body.classList.contains('sidebar-compacte');
  try { localStorage.setItem(SIDEBAR_KEY, compacte ? '1' : '0'); } catch { /* stockage indisponible */ }
  appliquerSidebar(compacte);
});
(function restaurerSidebar() {
  let v = null;
  try { v = localStorage.getItem(SIDEBAR_KEY); } catch { /* stockage indisponible */ }
  // Sans choix enregistré, on laisse le CSS décider selon la largeur.
  if (v !== null) appliquerSidebar(v === '1');
})();

