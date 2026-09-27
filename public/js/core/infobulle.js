'use strict';
/* La bulle ⓘ des champs : `#tip`, pour qui elle est ouverte. */
// ---------- Info-bulles des champs de formulaire ----------
const tipEl = document.createElement('div');
tipEl.id = 'tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
/* POUR QUI LA BULLE EST OUVERTE. Presque toutes disent une chose fixe ; une seule change pendant
   qu'on la regarde — le compte à rebours du pied de page. Sans ce repère, la réécrire reviendrait
   à réécrire la bulle de n'importe qui. */
let tipPour = null;

function showTip(el) {
  tipPour = el;
  // `data-when` : le texte est calculé maintenant, pas au rendu (cf. `dateHtml`).
  tipEl.textContent = el.dataset.tip || (el.dataset.when ? depuis(el.dataset.when) : '');
  if (!tipEl.textContent) return;
  // Tooltip « code » (large, monospace, multi-ligne) pour le contenu d'une commande Makefile.
  tipEl.classList.toggle('tip-code', el.classList.contains('hint-code'));
  tipEl.classList.add('on');
  const r = el.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  // Sous l'icône par défaut ; au-dessus s'il n'y a pas la place en bas.
  const below = r.bottom + 8 + t.height <= innerHeight;
  tipEl.style.top = `${below ? r.bottom + 8 : r.top - 8 - t.height}px`;
  // Recentrée sur l'icône, en restant dans la fenêtre.
  const left = r.left + r.width / 2 - t.width / 2;
  tipEl.style.left = `${Math.max(8, Math.min(left, innerWidth - t.width - 8))}px`;
}
const hideTip = () => { tipPour = null; tipEl.classList.remove('on'); };

/** Change le texte d'une bulle, ouverte ou non — l'attribut fait foi, l'affichage suit. */
function majTip(el, texte) {
  if (!el) return;
  el.dataset.tip = texte;
  if (tipPour === el) tipEl.textContent = texte;
}

/* Délégation : couvre aussi les champs rendus dynamiquement (lignes de projet).
   Le sélecteur vise TOUT porteur de `data-tip` et pas seulement les icônes `.hint` :
   des éléments non cliquables (badges de santé du menu) ont aussi besoin d'expliquer
   ce qu'ils affichent. */
document.addEventListener('mouseover', (e) => {
  const h = e.target.closest && e.target.closest('[data-tip], [data-when]');
  if (h) showTip(h);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest && e.target.closest('[data-tip], [data-when]')) hideTip();
});
/* LA BULLE NE S'OUVRE QUE SUR SON ⓘ — au survol, au clic, ou quand l'icône elle-même prend le
   focus. Une version l'ouvrait aussi au focus du CHAMP, pour compenser les icônes sorties du
   parcours de tabulation : elle s'affichait alors par-dessus le champ qu'on venait de cliquer,
   masquant ce qu'on allait y écrire. Une explication qu'on n'a pas demandée et qui cache la
   saisie coûte plus qu'elle n'apporte. */
document.addEventListener('focusin', (e) => {
  const h = e.target.closest && e.target.closest('[data-tip], [data-when]');
  if (h) showTip(h); else hideTip();
});
document.addEventListener('focusout', hideTip);
// L'icône vit à l'intérieur d'un <label> : sans ça, cliquer dessus activerait
// le champ associé (la case Auto-push se cocherait toute seule).
document.addEventListener('click', (e) => {
  const h = e.target.closest && e.target.closest('.hint');
  if (!h) return;
  e.preventDefault();
  e.stopPropagation();
  showTip(h);          // clic = affichage persistant, utile sur tablette
});
// La bulle est en position fixe : au défilement elle se décrocherait de l'icône.
addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason || 'erreur inconnue');
  toast(tr('toast.erreur-inattendue', { msg: msg }), true);
});

