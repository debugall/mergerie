'use strict';
/* Mettre une fenêtre de côté, le dernier champ touché. */
/* ---------- METTRE UNE FENÊTRE DE CÔTÉ ---------------------------------------------------
   Une modale prend tout l'écran et cache tout le reste. On ouvre « Nouvelle session », on
   veut vérifier le nom exact d'une branche dans Git ou l'état d'un ticket dans Jira, et il
   n'y avait que deux issues : renoncer à aller voir, ou fermer en perdant la saisie. La
   fenêtre se RÉDUIT donc dans le menu, comme dans une barre des tâches : l'écran redevient
   entier, et on la reprend là où on l'avait laissée.

   « Là où on l'avait laissée » veut dire trois choses, et les trois comptent :
   — les CHAMPS. La modale est masquée, jamais reconstruite : rien à sauvegarder ni à relire.
   — le CURSEUR. Il retourne dans le champ qu'on quittait, pas au premier du formulaire.
   — l'ONGLET. On est parti vérifier quelque chose ailleurs ; en reprenant, on veut retrouver
     l'écran d'où la fenêtre était partie — c'est là que son résultat s'affichera.

   CE QUI EST RÉDUCTIBLE : exactement les modales dont on protège déjà la saisie
   (`salissable`). Une confirmation ou un choix qui rend une PROMESSE n'en est pas — la
   réduire laisserait son appelant en attente pour toujours, et ces modales-là passent déjà
   `salissable: false`. La règle est donc une conséquence de ce qui existe, pas une liste à
   tenir à jour au fil des modales qu'on ajoutera. */
const REDUITES = new Map();   // id de la modale -> { titre, onglet, focus, fermer }
/* LE DERNIER CHAMP TOUCHÉ, suivi au fil de la frappe. À l'instant du clic sur « Réduire »,
   l'élément actif est le BOUTON : rendre le curseur là-dessus ramènerait sur une commande,
   pas dans le formulaire qu'on était en train de remplir. */
const DERNIER_CHAMP = new WeakMap();

function ongletCourant() { const b = $('nav button[data-tab].active'); return b ? b.dataset.tab : ''; }

function titreModale(modal) {
  const h = modal.querySelector('.modal-box > h3');
  const t = h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
  return t || tr('dock.window');
}

/* Le bouton se pose dans un bandeau COLLANT de hauteur nulle, en tête de la boîte : il reste
   donc au coin haut-droit même quand le formulaire est long et qu'on l'a fait défiler — une
   fenêtre dont on ne peut plus atteindre la commande de réduction n'est pas réductible. */
function poserBoutonReduire(modal, fermer) {
  const boite = modal.querySelector('.modal-box');
  if (!boite || boite.querySelector('.modal-reduire')) return;
  boite.classList.add('modal-reduisible');
  const rangee = document.createElement('div');
  rangee.className = 'modal-outils';
  modal.addEventListener('focusin', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) DERNIER_CHAMP.set(modal, e.target);
  });
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'modal-reduire';
  b.dataset.i18nTitle = 'dock.reduce.title';
  b.dataset.i18nAria = 'dock.reduce';
  b.title = tr('dock.reduce.title');
  b.setAttribute('aria-label', tr('dock.reduce'));
  b.innerHTML = '<svg class="ico ico-sm"><use href="#i-minimize"/></svg>';
  b.addEventListener('click', () => reduireModale(modal, fermer));
  rangee.appendChild(b);
  boite.prepend(rangee);
}

function reduireModale(modal, fermer) {
  if (!modal || modal.hidden) return;
  const actif = document.activeElement;
  const champ = DERNIER_CHAMP.get(modal);
  REDUITES.set(modal.id, {
    titre: titreModale(modal),
    onglet: ongletCourant(),
    focus: (champ && champ.isConnected) ? champ
      : (modal.contains(actif) && !actif.classList.contains('modal-reduire') ? actif : null),
    fermer,
  });
  modal.dataset.reduite = '1';
  modal.hidden = true;
  /* Une dictée en cours visait un champ qui vient de disparaître : elle parlerait dans le vide,
     et son micro resterait posé sur un formulaire qui n'est plus là. (Un clic sur un bouton non
     dictable range déjà le micro — sauf justement quand une dictée tourne, cas où il est gardé
     exprès pour ne pas être perdu en cours de route.) */
  if (window.mergerieDictation) {
    window.mergerieDictation.arreter();
    const mic = $('#dictationMic'); if (mic) mic.hidden = true;
  }
  rendreDock();
}

function restaurerModale(id) {
  const modal = $(`#${id}`); const e = REDUITES.get(id);
  if (!modal || !e) return;
  if (e.onglet && ongletCourant() !== e.onglet) navTab(e.onglet);
  modal.hidden = false;            // l'observateur de `fermerAuFond` la sort du dock
  const cible = e.focus && e.focus.isConnected ? e.focus : null;
  if (cible) setTimeout(() => { try { cible.focus(); } catch { /* champ devenu inatteignable */ } }, 0);
}

// Reparue par n'importe quel chemin : elle n'est plus une fenêtre réduite.
function sortirDuDock(modal) {
  delete modal.dataset.reduite;
  if (REDUITES.delete(modal.id)) rendreDock();
}

/* Abandonner une fenêtre SANS la rouvrir. On passe par sa vraie fonction de fermeture : elle
   seule remet à zéro ce qui vit en dehors du DOM (contexte de MR, cible de convergence…). */
function fermerReduite(id) {
  const e = REDUITES.get(id); if (!e) return;
  const modal = $(`#${id}`);
  REDUITES.delete(id);
  if (modal) delete modal.dataset.reduite;
  rendreDock();
  try { e.fermer(); } catch { /* la modale était déjà défaite */ }
}

function rendreDock() {
  const dock = $('#modalDock'); if (!dock) return;
  dock.hidden = REDUITES.size === 0;
  if (dock.hidden) { dock.innerHTML = ''; return; }
  dock.innerHTML = `<div class="dock-titre muted"><span>${esc(tr('dock.title', { n: REDUITES.size, count: REDUITES.size }))}</span></div>`
    + [...REDUITES.entries()].map(([id, e]) => `<div class="dock-chip">
        <button type="button" class="dock-open" data-dock-open="${esc(id)}" title="${esc(tr('dock.restore', { titre: e.titre }))}">
          <svg class="ico ico-sm"><use href="#i-expand"/></svg><span>${esc(e.titre)}</span>
        </button>
        <button type="button" class="dock-close" data-dock-close="${esc(id)}" title="${esc(tr('dock.close', { titre: e.titre }))}" aria-label="${esc(tr('dock.close', { titre: e.titre }))}">
          <svg class="ico ico-sm"><use href="#i-close"/></svg>
        </button>
      </div>`).join('');
}

document.addEventListener('click', (e) => {
  const o = e.target.closest && e.target.closest('[data-dock-open]');
  if (o) { restaurerModale(o.dataset.dockOpen); return; }
  const c = e.target.closest && e.target.closest('[data-dock-close]');
  if (c) fermerReduite(c.dataset.dockClose);
});

function refuserFermeture(modal) {
  const boite = modal.querySelector('.modal-box') || modal;
  boite.classList.remove('modal-refus');
  void boite.offsetWidth; // relance l'animation quand on clique deux fois de suite
  boite.classList.add('modal-refus');
  boite.addEventListener('animationend', () => boite.classList.remove('modal-refus'), { once: true });
  toast(tr('ui.modal.protegee'));
}

// Cible de la convergence : soit une MR (rapport), soit une session de dev (du prompt
// à la MR convergée). La même modale sert les deux ; seul l'endpoint et l'avertissement changent.
let convergeTarget = null; // { type: 'mr' | 'task', id }
/* Confirmation générique — remplace les `confirm()` natifs, qui ne suivaient ni le
   thème, ni la langue du navigateur, ni le vocabulaire de l'app, et dont le bouton
   « OK » ne disait jamais CE QU'ON VALIDE. Renvoie une promesse booléenne, donc les
   appelants deviennent `async`.

   `danger` (par défaut) rend l'action de confirmation reconnaissable AU REPOS : une
   suppression ne doit pas ressembler à un bouton neutre. */
let confirmResolve = null;
/* `check` : { label, checked, danger } ajoute une CASE À COCHER à la confirmation, et la
   promesse rend alors `{ ok, checked }` au lieu d'un booléen. Sert au push forcé — une décision
   qui appartient à celui qui pousse, et qui n'a pas à se cacher dans un second bouton. */
/* `html` : un corps STRUCTURÉ à la place de la phrase. Un récapitulatif qui aligne des
   comptes de fichiers et deux colonnes ne se lit pas en paragraphe — et `white-space:
   pre-line` sur un `<p>` ne fait pas un tableau. Le texte reste l'usage courant ; `wide`
   élargit la modale quand ce corps porte deux colonnes. */
function confirmDialog({
  title, text, html = '', detail, confirmLabel, danger = true, check = null, wide = false,
} = {}) {
  $('#confirmTitle').textContent = title || tr('confirm.default-title');
  $('#confirmText').textContent = text || '';
  $('#confirmText').hidden = !text;
  const corps = $('#confirmBody');
  corps.hidden = !html;
  corps.innerHTML = html || '';
  $('#confirmModal').querySelector('.modal-box').classList.toggle('modal-confirm-lg', !!wide);
  const d = $('#confirmDetail');
  d.hidden = !detail;
  d.textContent = detail || '';
  const row = $('#confirmCheckRow');
  const box = $('#confirmCheck');
  row.hidden = !check;
  box.checked = !!(check && check.checked);
  if (check) row.querySelector('span').textContent = check.label || '';
  const ok = $('#confirmOk');
  ok.textContent = confirmLabel || tr('confirm.default-ok');
  ok.className = danger ? 'btn btn-danger btn-solid' : 'btn btn-primary';
  $('#confirmModal').hidden = false;
  setTimeout(() => ok.focus(), 0);
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(answer) {
  $('#confirmModal').hidden = true;
  /* Une confirmation SANS case rend un booléen, comme avant : les dizaines d'appels existants
     ne changent pas. Avec case, elle rend un objet — l'appelant qui a demandé la case sait
     qu'il doit le lire. Rendre toujours un objet aurait fait passer tous les `if (!await …)`
     à « toujours vrai », et une suppression se serait confirmée toute seule. */
  const avecCase = !$('#confirmCheckRow').hidden;
  const coche = $('#confirmCheck').checked;
  $('#confirmCheckRow').hidden = true;
  const r = confirmResolve; confirmResolve = null;
  if (r) r(avecCase ? { ok: !!answer, checked: !!answer && coche } : answer);
}
$('#confirmCancel') && $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
$('#confirmOk') && $('#confirmOk').addEventListener('click', () => closeConfirm(true));
fermerAuFond('#confirmModal', () => closeConfirm(false), { salissable: false });

/* ── C8 · UN CHAMP QUI SE SOUVIENT, ET QUI S'ENVOIE AU CLAVIER ─────────────────────────────
   Trois champs de l'application demandent d'écrire plusieurs phrases : le commentaire de
   merge request, le commentaire Jira et « Demander une modification » du rapport. Les trois
   perdaient tout à un rechargement, un onglet fermé ou un clic à côté — et les trois
   obligeaient à viser un bouton pour envoyer, alors que le champ de surveillance Jira, lui,
   partait déjà à Ctrl+Entrée.

   Le brouillon vit dans le NAVIGATEUR : c'est un filet, pas une donnée. Il est effacé à
   l'envoi réussi — un brouillon qui survit à son envoi ferait renvoyer deux fois. */
const BROUILLON_PREFIXE = 'aidevtools_brouillon_';
const lireBrouillon = (cle) => { try { return localStorage.getItem(BROUILLON_PREFIXE + cle) || ''; } catch { return ''; } };
const ecrireBrouillon = (cle, v) => {
  try {
    if (v) localStorage.setItem(BROUILLON_PREFIXE + cle, v);
    else localStorage.removeItem(BROUILLON_PREFIXE + cle);
  } catch { /* stockage indisponible : on perd le filet, pas le champ */ }
};
/* `envoyer` est appelé à Ctrl/⌘+Entrée. On ne vide PAS le brouillon ici : c'est l'appelant
   qui sait si l'envoi a réussi — vider avant la réponse perdrait le texte sur une panne
   réseau, c'est-à-dire exactement le jour où le filet sert. */
function champAvecBrouillon(champ, cle, envoyer) {
  if (!champ || champ.dataset.brouillon === cle) return;
  champ.dataset.brouillon = cle;
  const garde = lireBrouillon(cle);
  if (garde && !champ.value) champ.value = garde;
  champ.addEventListener('input', () => ecrireBrouillon(cle, champ.value.trim()));
  champ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); envoyer(); }
  });
}

/* B2 — « prévenir Jira au merge », mémorisé PAR PROJET JIRA (le préfixe de la clé). */
const MEMO_JIRA_MERGE = 'aidevtools_merge_jira';
const memoJiraMerge = () => { try { return JSON.parse(localStorage.getItem(MEMO_JIRA_MERGE) || '{}'); } catch { return {}; } };
function memoriserJiraMerge(cle, valeur) {
  const projet = String(cle || '').split('-')[0].toUpperCase();
  if (!projet) return;
  try {
    const m = memoJiraMerge(); m[projet] = !!valeur;
    localStorage.setItem(MEMO_JIRA_MERGE, JSON.stringify(m));
  } catch { /* stockage indisponible */ }
}

