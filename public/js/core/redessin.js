'use strict';
/* La carte visée survit au redessin. */
/* LA CARTE VISÉE SURVIT AU REDESSIN. Les listes se redessinent d'elles-mêmes (sondage, fin de
   job, synchro, case cochée) et l'anneau partait avec l'ancien DOM : `x` cochait, puis un second
   `x` ne trouvait plus rien à décocher. On retient donc l'identité de la carte visée, et on la
   retrouve dans la liste redessinée. */
let carteVisee = null;   // { liste: id du conteneur, id: data-id }
/* …et l'anneau se REVOIT aussitôt la liste redessinée, pas seulement à la touche suivante :
   sinon il disparaissait de l'écran à chaque rafraîchissement, alors que la carte restait visée. */
(() => {
  if (typeof MutationObserver !== 'function') return;
  const obs = new MutationObserver((muts) => {
    if (!carteVisee) return;
    for (const m of muts) {
      const liste = m.target.closest ? m.target.closest(`#${carteVisee.liste}`) : null;
      if (liste && !liste.querySelector('.card.focused')) { carteFocus(); return; }
    }
  });
  for (const id of ['toReviewList', 'reportList', 'taskList', 'localList', 'askList', 'lotList']) {
    const el = document.getElementById(id);
    if (el) obs.observe(el, { childList: true, subtree: true });
  }
})();
function carteFocus() {
  const c = $('.card.focused');
  if (c) return c;
  if (!carteVisee) return null;
  const liste = document.getElementById(carteVisee.liste);
  const retrouvee = liste && [...liste.querySelectorAll('.card[data-id]')].find((x) => x.dataset.id === carteVisee.id);
  if (!retrouvee || retrouvee.offsetParent === null) return null;
  retrouvee.classList.add('focused');
  return retrouvee;
}
/* Le bouton d'une action SUR LA CARTE AU FOCUS — y compris quand il vit dans le menu « ⋯ »,
   présent dans le DOM même replié. On clique le BOUTON RENDU, jamais une route en double : ce
   qui est désactivé le reste (« Vérifier » sans vérificateur couvrant), et ce qui n'existe pas
   sur cette carte-là ne fait rien. */
function boutonDeCarte(sel) {
  const c = carteFocus();
  if (!c) return null;
  const b = c.querySelector(sel);
  return b && !b.disabled ? b : null;
}

/* AUCUN anneau au départ : il n'apparaît qu'à la première pression de `j` ou `k`. Un
   raccourci invisible qui agit sur un élément qu'on n'a pas désigné est un piège. */
function bougerFocusCarte(pas) {
  const liste = listeCourante();
  if (!liste) return;
  /* Les listes n'ont pas toutes des `.card` : les todos sont des `.todo-row`, les tickets des
     `.jira-item`. On prend ce que la liste contient réellement, sinon `j` reste muet là où on
     l'attend le plus. */
  const cartes = $$('.card, .todo-row, .jira-item', liste).filter((el) => el.offsetParent !== null);
  if (!cartes.length) return;
  const cur = cartes.indexOf(carteFocus());
  const next = cur === -1 ? (pas > 0 ? 0 : cartes.length - 1) : Math.min(cartes.length - 1, Math.max(0, cur + pas));
  cartes.forEach((c) => c.classList.remove('focused'));
  cartes[next].classList.add('focused');
  carteVisee = cartes[next].dataset.id && liste.id ? { liste: liste.id, id: cartes[next].dataset.id } : null;
  cartes[next].scrollIntoView({ block: 'nearest' });
}

