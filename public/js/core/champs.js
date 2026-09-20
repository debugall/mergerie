'use strict';
/* L'erreur d'un champ s'affiche sous le champ : `signalerChamp`, `viderErreursChamps`. */
/* ---------- L'ERREUR D'UN CHAMP S'AFFICHE SOUS LE CHAMP ----------
   Vingt-deux formulaires validaient par toast, en bas à droite, à sept cents pixels du champ
   fautif et sans rien surligner : on lisait « nom de branche requis pour chaque projet » et il
   fallait chercher lequel. La règle est maintenant : une erreur de CHAMP se dit sous le champ,
   un toast n'annonce qu'un RÉSULTAT d'action (« session créée », « job mis en file »).
   `aria-describedby` relie le message au champ pour les lecteurs d'écran ; il s'efface à la
   première frappe, sinon il contredit ce qu'on vient de corriger. */
function erreurChamp(champ, message) {
  if (!champ) return;
  const id = champ.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  champ.id = id;
  const idErr = `${id}-err`;
  let p = document.getElementById(idErr);
  if (!p) {
    p = document.createElement('p');
    p.className = 'field-error';
    p.id = idErr;
    /* OÙ SE POSE LE MESSAGE. Après le champ, ou après son enveloppe quand il en a une (un
       combo, une case dans un label) : glissé DANS le combo, il serait rogné par son
       `overflow`.
       SAUF DANS UNE RANGÉE DE PROJET, qui est une ligne flex : inséré au milieu, le message
       devenait une COLONNE de plus — il écrasait « Branche de départ » de 285 à 157 px et
       renvoyait le « × » à la ligne suivante. Il va donc à la FIN de la rangée, où il occupe
       sa propre ligne sous les champs qu'il concerne (le champ fautif reste bordé de rouge et
       lié par `aria-describedby`). */
    const rangee = champ.closest('.target-row');
    const apres = champ.closest('.combo, .inline-check') || champ;
    if (rangee) rangee.appendChild(p); else apres.insertAdjacentElement('afterend', p);
  }
  p.textContent = message;
  champ.classList.add('is-invalid');
  champ.setAttribute('aria-describedby', idErr);
  champ.setAttribute('aria-invalid', 'true');
  const effacer = () => {
    p.remove();
    champ.classList.remove('is-invalid');
    champ.removeAttribute('aria-describedby');
    champ.removeAttribute('aria-invalid');
  };
  champ.addEventListener('input', effacer, { once: true });
  champ.addEventListener('change', effacer, { once: true });
}

/* Efface les messages d'un formulaire (ou de tout l'écran) avant de le revalider : sans ça,
   corriger un champ laisserait l'ancien message des autres. */
function viderErreursChamps(racine) {
  const r = racine || document;
  $$('.field-error', r).forEach((p) => p.remove());
  $$('.is-invalid', r).forEach((c) => {
    c.classList.remove('is-invalid');
    c.removeAttribute('aria-describedby');
    c.removeAttribute('aria-invalid');
  });
}

/* Signale le PREMIER champ fautif : message dessous, focus dedans, remonté à l'écran. Rend
   `false` pour que l'appelant s'arrête d'une ligne — `if (!signalerChamp(…)) return;`. */
function signalerChamp(champ, message) {
  erreurChamp(champ, message);
  if (champ) {
    champ.focus({ preventScroll: true });
    champ.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return false;
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  t.appendChild(span);
  if (isErr) {
    // erreur : texte sélectionnable + copier, et une fermeture manuelle toujours possible
    const copy = document.createElement('button');
    copy.className = 'toast-btn'; copy.textContent = tr('ui.copy');
    copy.addEventListener('click', () => copyText(msg, copy));
    const close = document.createElement('button');
    close.className = 'toast-btn'; close.innerHTML = svgIco('close');
    close.addEventListener('click', () => t.remove());
    t.appendChild(copy); t.appendChild(close);
    /* UN TOAST D'ERREUR NE S'INSTALLE PLUS À DEMEURE. Il ne partait qu'à la main : on en
       empilait quatre, ils survivaient au changement d'onglet et à la fermeture de la modale
       qui les avait produits, et ils cachaient l'écran qu'on venait corriger. Huit secondes —
       et le compte s'arrête tant que la souris ou le clavier est dessus, le temps de lire une
       pile Node ou de la copier. */
    let minuteur = setTimeout(() => dismissToast(t), 8000);
    const suspendre = () => { clearTimeout(minuteur); minuteur = null; };
    const reprendre = () => { if (!minuteur) minuteur = setTimeout(() => dismissToast(t), 8000); };
    t.addEventListener('mouseenter', suspendre);
    t.addEventListener('mouseleave', reprendre);
    t.addEventListener('focusin', suspendre);
    t.addEventListener('focusout', reprendre);
  } else {
    setTimeout(() => dismissToast(t), 3500);
  }
  toastHost().appendChild(t);
  return t;
}
/* … ET IL MEURT AVEC LE FORMULAIRE QUI L'A PRODUIT. Une modale qu'on ferme emporte l'erreur
   qu'elle avait levée : la garder sur l'écran suivant, c'est accuser un écran qui n'y est pour
   rien. L'observateur couvre TOUS les chemins de fermeture (bouton, Échap, clic au fond),
   qu'aucune fonction unique ne centralise. */
function viderToastsErreur() { $$('.toast.err').forEach((t) => t.remove()); }
(() => {
  const obs = new MutationObserver((muts) => {
    for (const m of muts) { if (!m.target.hidden) auPremierPlan(m.target); }
    for (const m of muts) { if (m.target.hidden) { viderToastsErreur(); return; } }
  });
  /* LA DERNIÈRE MODALE OUVERTE PASSE DEVANT. À z-index égal, c'est l'ordre du HTML qui
     tranchait : « Ajouter aux todos » ou « Enquêter » depuis la fiche d'un job Jenkins ouvraient
     leur fenêtre DERRIÈRE la fiche, déclarée plus bas dans la page, et son bouton n'était plus
     cliquable. Sous la confirmation (150), qui reste au-dessus de tout. */
  function auPremierPlan(modale) {
    if (modale.id === 'confirmModal') return;
    const autres = $$('.modal:not([hidden])').filter((x) => x !== modale && x.id !== 'confirmModal');
    const haut = Math.max(110, ...autres.map((x) => Number(x.style.zIndex) || 110));
    modale.style.zIndex = autres.length ? String(Math.min(149, haut + 1)) : '';
  }
  /* Le script est en fin de <body> : le DOM est déjà là, et `DOMContentLoaded` peut être
     passé. On branche tout de suite, en gardant le repli pour un chargement plus tôt. */
  const brancher = () => $$('.modal').forEach((m) => obs.observe(m, { attributes: true, attributeFilter: ['hidden'] }));
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', brancher);
  else brancher();
})();
// B3 : les toasts s'empilent dans un conteneur au lieu de se superposer au même pixel.
function toastHost() {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  return host;
}
