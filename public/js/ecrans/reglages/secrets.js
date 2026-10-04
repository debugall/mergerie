'use strict';
/* « COPIER » UN JETON — un bouton à côté de chaque champ de jeton (Réglages, et l'écran d'un plugin qui le demande).
   Les jetons ne redescendent JAMAIS dans la page : le champ affiche « *** » (« il y en a un »). Copier est donc un geste
   explicite qui va chercher la valeur et l'écrit dans le presse-papiers, sans la poser dans le DOM :
     — un jeton TAPÉ mais pas encore enregistré se copie tel quel, sans appel ;
     — « *** » : un POST (`data-secret-url`, `data-secret-key`) rend la valeur, une fois ;
     — un champ vide : on le dit, rien n'est copié.
   Le bouton porte ses deux attributs : un plugin met le même bouton dans son HTML, sans script. */
async function copierSecret(btn) {
  const champ = btn.closest('.secret-row') && btn.closest('.secret-row').querySelector('input');
  if (!champ) return;
  let valeur = champ.value;
  try {
    if (valeur === '***') valeur = String((await api(btn.dataset.secretUrl, { method: 'POST', body: { field: btn.dataset.secretKey, key: btn.dataset.secretKey } })).value || '');
    if (!valeur) { toast(tr('settings.copy.empty'), true); return; }
    await navigator.clipboard.writeText(valeur);
  } catch (e) { toast(explainError(e.message), true); return; } finally { valeur = ''; }
  btn.classList.add('copied');
  btn.title = tr('ui.copied');
  toast(tr('settings.copy.done'));
  setTimeout(() => { btn.classList.remove('copied'); btn.title = tr('settings.copy-token'); }, 1500);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.secret-copy');
  if (b) copierSecret(b);
});
