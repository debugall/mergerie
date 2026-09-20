'use strict';
/* Fermeture d'une modale au clic sur le fond : `fermerAuFond` (une modale réduite sort du dock). */
/* ---------- Fermeture d'une modale au clic sur le fond ----------
   Deux gestes se ressemblaient et n'ont rien à voir l'un avec l'autre.

   Un `click` naît sur l'ANCÊTRE COMMUN du mousedown et du mouseup. Sélectionner du texte dans
   un champ et relâcher trois pixels en dehors vise donc le FOND, tout comme tirer la poignée
   de redimensionnement d'un textarea : la modale se fermait — et emportait la saisie — alors
   que personne n'avait cliqué à côté. On exige donc que la pression AIT COMMENCÉ sur le fond.

   Reste le vrai clic à côté. Tant que rien n'a été saisi il ferme, et c'est ce qu'on veut :
   on ouvre une modale, on change d'avis, ça doit rester rapide. Dès qu'il y a une saisie il
   ne l'emporte plus ; la modale bat une fois et rappelle Échap, plutôt qu'une deuxième modale
   par-dessus la première. Le drapeau se lève sur `input`/`change`, qui ne partent QUE d'une
   action humaine : remplir les champs à l'ouverture ne salit donc rien. */
function fermerAuFond(sel, close, { salissable = true } = {}) {
  const modal = $(sel);
  if (!modal) return;
  // Sans fonction de fermeture, masquer SUFFIT — et un clic au fond ne doit pas jeter une
  // erreur parce que l'appelant n'en avait pas à donner.
  const fermer = close || (() => { modal.hidden = true; });
  let depart = null;
  modal.addEventListener('pointerdown', (e) => { depart = e.target; });
  if (salissable) {
    const marquer = (e) => {
      /* Un champ de recherche filtre la vue, il ne se saisit pas : le protéger empêcherait
         de fermer une modale qu'on a seulement parcourue. Le `.cb-search` d'un combo est
         dans ce cas — le choix, lui, atterrit dans l'input caché, qui émet son `change`
         et compte donc bien comme une saisie. */
      const el = e.target;
      if (el.type === 'search' || el.classList.contains('search') || el.classList.contains('cb-search')) return;
      modal.dataset.saisi = '1';
    };
    modal.addEventListener('input', marquer);
    modal.addEventListener('change', marquer);
    /* Chaque ouverture repart d'une modale vierge — et chaque fermeture aussi, au cas où
       elle serait rouverte sans repasser par sa fonction d'ouverture. Une RÉDUCTION, elle,
       n'est ni l'une ni l'autre : la saisie est toujours là, et son drapeau doit l'être
       aussi, sinon la fenêtre reprise se laisserait fermer d'un clic au fond avec tout ce
       qu'on y avait écrit. Reparaître, en revanche, la sort du dock quel que soit le chemin
       (la puce, ou son ouvreur qui la remplit à neuf). */
    new MutationObserver(() => {
      if (modal.dataset.reduite) { if (!modal.hidden) sortirDuDock(modal); return; }
      delete modal.dataset.saisi;
    }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  }
  modal.addEventListener('click', (e) => {
    if (e.target !== modal || depart !== modal) return;
    depart = null;
    if (modal.dataset.saisi) { refuserFermeture(modal); return; }
    fermer();
  });
  /* Réductible = « saisissable ». Voir le bloc qui suit : la règle est une conséquence, pas
     une liste à tenir à jour. */
  if (salissable) poserBoutonReduire(modal, fermer);
}

