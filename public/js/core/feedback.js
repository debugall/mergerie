'use strict';
/* Feedback des actions : `copyText`, `busy`, `toast`, `toastUndo`, supprimer avec six secondes, favicon, `svgIco`, `debounce`, `stagger`, textes tronqués. */
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const o = btn.textContent; btn.textContent = tr('ui.copied'); setTimeout(() => { btn.textContent = o; }, 1500); }
  } catch {
    // clipboard indisponible : on sélectionne le texte pour un copier manuel
    if (btn) { const o = btn.textContent; btn.textContent = 'Ctrl+C'; setTimeout(() => { btn.textContent = o; }, 2000); }
  }
}

/* ---------- Feedback des actions ----------
   Un bouton qui déclenche un appel réseau doit le montrer : sans ça l'utilisateur
   reclique, ou croit que rien ne s'est passé. */
async function busy(btn, fn) {
  if (!btn) return fn();
  btn.dataset.busy = '1';
  btn.disabled = true;
  try { return await fn(); }
  finally { delete btn.dataset.busy; btn.disabled = false; }
}

// Squelettes de chargement : évite le saut de mise en page et le « chargement… » gris.
const skeleton = (n = 4) => `<div class="sk-wrap">${'<div class="sk"></div>'.repeat(n)}</div>`;

// Toast avec annulation : remplace avantageusement un confirm() sur les actions
// réversibles (l'utilisateur n'est pas interrompu, et peut revenir en arrière).
// Un seul exemplaire de cette fonction : une seconde définition du même nom écraserait
// silencieusement celle-ci (hoisting), et tous les appels partiraient sur l'autre signature.
function toastUndo(msg, onUndo, ms = 6000) {
  const t = document.createElement('div');
  t.className = 'toast';
  const span = document.createElement('span');
  span.className = 'toast-msg'; span.textContent = msg;
  const b = document.createElement('button');
  b.className = 'toast-btn'; b.innerHTML = `${svgIco('reset')} ${esc(tr('ui.undo'))}`;
  const timer = setTimeout(() => dismissToast(t), ms);
  b.addEventListener('click', () => { clearTimeout(timer); dismissToast(t); onUndo(); });
  t.appendChild(span); t.appendChild(b);
  toastHost().appendChild(t);
}

/* SUPPRIMER, AVEC SIX SECONDES POUR SE RAVISER.
 *
 * Une confirmation demande « êtes-vous sûr ? » à l'instant où l'on est sûr — et le regret, lui,
 * arrive une seconde après le clic. Le geste est donc DIFFÉRÉ : la ligne disparaît tout de
 * suite (l'écran dit la vérité de l'intention), l'appel part six secondes plus tard, et le
 * bandeau offre « Annuler » pendant ce temps. Même durée que le bandeau lui-même : une offre
 * qui survivrait à son message serait un piège.
 *
 * ⚠ Le prix, assumé : fermer l'onglet dans ces six secondes ANNULE la suppression. C'est le
 * compromis habituel de ce geste (et le bon sens : dans le doute, on garde). Un « annuler » qui
 * recréerait l'objet après coup, lui, mentirait — les fichiers sur disque, eux, sont partis. */
function supprimerAvecAnnulation({ element, message, supprimer, apres, annuler }) {
  if (element) element.hidden = true;
  let annule = false;
  const minuteur = setTimeout(async () => {
    if (annule) return;
    try { await supprimer(); if (apres) await apres(); }
    catch (e) { if (element) element.hidden = false; toast(explainError(e.message), true); }
  }, 6000);
  toastUndo(message, async () => {
    annule = true;
    clearTimeout(minuteur);
    if (element) element.hidden = false;
    // `annuler` : ce qu'il faut REMETTRE quand l'écran a déjà tourné la page (l'éditeur de notes).
    if (annuler) await annuler();
  });
}

// Favicon dynamique : on suit l'avancement même dans un autre onglet.
let faviconState = '';
// Favicon = marque Mergerie : glyphe de « merge » (deux branches qui convergent, comme #i-merge)
// blanc sur une tuile arrondie. La TUILE porte l'état (bleu au repos, ambre en cours, rouge en erreur),
// le GLYPHE porte l'identité. SVG pur (aucun emoji ni police) → rendu fiable partout, WSL compris.
const FAVICON_TILE = { idle: '#2f6fe0', busy: '#a16207', error: '#c62828' };
/* Le glyphe est le logo du produit (public/images/mergerie-logo.svg) : le même « M » en graphe
   de commits, dessiné en blanc sur la tuile. Le fichier lui-même ne peut pas servir de favicon :
   son encre est sombre et transparente autour, donc invisible sur une barre d'onglets sombre —
   d'où la tuile, qui garantit le contraste ET porte l'état. */
function faviconHref(state) {
  const color = FAVICON_TILE[state] || FAVICON_TILE.idle;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + `<rect x="6" y="6" width="88" height="88" rx="22" fill="${color}"/>`
    + `<g transform="translate(14 10) scale(0.72)">`
    + `<path d="M14,84 L14,26 L50,62 L86,26 L86,84" fill="none" stroke="#fff" stroke-width="9"`
    + ` stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="14" cy="26" r="7.5" fill="#fff"/><circle cx="86" cy="26" r="7.5" fill="#fff"/>`
    // vert plus clair que celui du logo sur fond blanc : il doit tenir sur les trois tuiles.
    + `<circle cx="50" cy="62" r="11" fill="#2da44e"/><circle cx="50" cy="62" r="4.5" fill="#fff"/>`
    + `</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function setFavicon(state) {
  if (faviconState === state) return;
  faviconState = state;
  const link = $('#favicon');
  if (link) link.href = faviconHref(state);
}

// Petite icône SVG inline (hérite de currentColor → se teinte selon l'état). Utilisée là où on
// mettait un emoji comme marqueur d'état : fiable sur toutes les plateformes, thème compris.
const svgIco = (name) => `<svg class="ico ico-sm"><use href="#i-${name}"/></svg>`;

// Apparition échelonnée des cartes (plafonnée : sur 80 MR on n'attend pas 2 s).
/* Regroupe les appels rapprochés (frappe au clavier) en un seul : un champ de recherche
   qui reconstruit une liste entière à CHAQUE caractère rame dès que la liste s'allonge. */
function debounce(fn, ms = 120) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* L'animation d'entrée n'appartient qu'à un VRAI chargement de données. Un filtrage ou un
   rafraîchissement réécrivent aussi le DOM, mais ils ne sont pas un événement : les animer
   revenait à faire clignoter la liste à chaque frappe.
   Le drapeau est posé par les fonctions de CHARGEMENT et consommé ici — c'est le seul endroit
   qui sait distinguer « les données sont arrivées » de « on a re-rendu ». */
let listeChargee = false;
// « La file n'a jamais été peuplée » — distinct de `listeChargee` ci-dessus, qui est un
// drapeau d'ANIMATION consommé à chaque rendu. Sert au squelette du premier affichage.
let fileJamaisChargee = true;
// Les stades déjà peuplés au moins une fois : voir le squelette de `loadReports`.
const stadeDejaCharge = new Set();
function stagger(sel) {
  const nodes = $$(sel);
  nodes.forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10)));
  const list = nodes[0] && nodes[0].parentElement;
  const animer = listeChargee;
  listeChargee = false;
  if (!list) return;
  list.classList.remove('animate-in');
  if (!animer) return;
  void list.offsetWidth;                 // redémarre l'animation même si la classe y était déjà
  list.classList.add('animate-in');
}

/* Écrire dans le DOM seulement si le contenu a VRAIMENT changé. Le rafraîchissement
   automatique et la frappe dans une recherche rejouaient sinon toute la liste — position de
   défilement perdue, menus refermés, cartes qui clignotent. La signature doit décrire tout
   ce qui est AFFICHÉ : si elle en oublie une part, l'écran se fige sur une donnée périmée. */
const domSig = new Map();
/* La ligne d'identité d'une carte (projet · auteur · date) est tronquée à la largeur de la
   carte : sur un chemin de projet long, la fin devient illisible. On pose donc une info-bulle —
   mais UNIQUEMENT quand le texte est réellement coupé. Une bulle qui répète ce qu'on lit déjà
   est du bruit, et elle s'ouvrirait sous la souris à chaque survol d'une carte.
   Le test coûte une lecture de mise en page par ligne : on le fait en un seul passage juste
   après le rendu (donc rarement, cf. renderIfChanged) et au redimensionnement, jamais en boucle. */
function titrerTextesTronques(racine = document) {
  /* Sélecteur RELATIF à la racine : `renderIfChanged` passe la liste elle-même (#toReviewList
     porte la classe `list`), donc chercher `.list .card .meta` ne trouverait rien — il faudrait
     un `.list` DANS la liste. On part donc de `.card`. Les cartes hors liste ne risquent rien :
     seule `.list .card .meta` est tronquée en CSS, ailleurs le texte tient et aucune bulle
     n'est posée. */
  for (const el of racine.querySelectorAll('.card .meta:not(.branches):not(.links)')) {
    if (el.scrollWidth > el.clientWidth + 1) el.title = el.textContent.trim();
    else if (el.title) el.removeAttribute('title');
  }
}
// La troncature dépend de la largeur : ce qui tenait dans une fenêtre large est coupé dans une
// fenêtre étroite, et inversement. On repasse donc à chaque redimensionnement, groupé.
window.addEventListener('resize', debounce(() => titrerTextesTronques(), 200));

function dismissToast(t) {
  t.classList.add('leaving');
  t.addEventListener('animationend', () => t.remove(), { once: true });
  setTimeout(() => t.remove(), 400); // filet si l'animation est désactivée
}

