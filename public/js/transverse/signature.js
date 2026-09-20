'use strict';
/* Un état vide est un rendu comme un autre — et il doit poser sa signature : ce qui se redessine sans sauter. */
/* UN ÉTAT VIDE EST UN RENDU COMME UN AUTRE — et il doit poser sa signature. Les branches
   « rien à afficher » écrivaient le DOM directement puis sortaient : la signature mémorisée
   restait celle du DERNIER rendu non vide. Filtrer sur « celles des autres » jusqu'à une liste
   vide, puis revenir à « toutes », recalculait donc exactement cette signature-là — et
   `renderIfChanged` concluait « identique, on ne touche à rien ». La liste restait vide, sans
   erreur, sans rien à cliquer pour s'en sortir.

   On signe donc l'état vide par son HTML : deux vides différents (recherche infructueuse,
   filtre d'auteur, filtre de note) se distinguent, un même vide ne clignote pas, et tout
   retour à une liste non vide redessine. */
function rendreVide(el, html) {
  if (domSig.get(el.id) === `vide\u0003${html}`) return;
  domSig.set(el.id, `vide\u0003${html}`);
  el.innerHTML = html;
}

function renderIfChanged(el, sig, html) {
  if (domSig.get(el.id) === sig) return false;
  domSig.set(el.id, sig);
  el.innerHTML = html;
  titrerTextesTronques(el);
  // Le repère « ça tourne » vit sur les cartes : un re-rendu l'effacerait jusqu'au
  // prochain sondage de statut. On le repose tout de suite (cf. marquerEnCours).
  if (ciblesEnCours) marquerEnCours(ciblesEnCours);
  return true;
}

