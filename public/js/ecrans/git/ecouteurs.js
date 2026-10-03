'use strict';
/* Git : les écouteurs de la zone « créer / supprimer des refs » (noms par projet, aperçu, cibles), câblés une fois les fonctions de l'explorateur chargées. */
$('#gitSameName').addEventListener('change', () => {
  $('#gitNameRow').hidden = !gitSameName();
  gitDropPreview();                    // l'aperçu ne correspond plus à la saisie
  gitRenderTargets();
});
$('#gitAddTarget').addEventListener('click', () => { gitTargets.push({}); gitDropPreview(); gitRenderTargets(); });
$('#gitPreview').addEventListener('click', gitDoPreview);
$('#gitExploreGo').addEventListener('click', gitAnalyze);
document.addEventListener('change', (e) => {
  // L'index vient de la LIGNE, pas de l'élément : l'input caché du combo dépôt
  // ne porte pas data-row (il vit dans le combo, pas directement sur la ligne).
  const gitRow = e.target.closest && e.target.closest('.git-row');
  if (!gitRow) return;
  const i = Number(gitRow.dataset.row);
  if (e.target.classList.contains('git-repo')) {
    // Changer de dépôt invalide la ref choisie, pas le nom saisi pour la ligne.
    gitTargets[i] = { repo_id: Number(e.target.value), name: (gitTargets[i] || {}).name };
    gitFillRow(i);
  }
  if (e.target.classList.contains('git-ref')) {
    gitTargets[i] = { ...gitTargets[i], ref: e.target.value };
  }
  gitDropPreview();   // dépôt ou ref source changés : l'aperçu ne les décrit plus
});
// Les noms par projet sont mémorisés à la frappe : ajouter ou retirer une ligne
// redessine TOUTES les lignes, et une saisie restée dans le DOM serait perdue.
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-name')) return;
  const i = Number(e.target.dataset.row);
  gitTargets[i] = { ...gitTargets[i], name: e.target.value };
  gitDropPreview();
});
/* Filtre de la liste de refs à supprimer. Purement visuel : on masque des lignes, on n'en
   décoche aucune — la sélection appartient à l'utilisateur, pas au filtre. */
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-ref-filter')) return;
  const list = e.target.closest('.git-refs').querySelector('.git-ref-list');
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const it of list.querySelectorAll('.git-ref-item')) {
    const hit = !q || it.dataset.name.includes(q);
    it.hidden = !hit;
    if (hit) shown += 1;
  }
  list.querySelector('.git-ref-nomatch').hidden = shown > 0;
});
/* Retoucher un nom APRÈS l'aperçu périme celui-ci : l'exécution relit les champs,
   pas le tableau affiché. Sans ça on prévisualise v2.3.0, on corrige en v2.4.0, et
   c'est v2.4.0 qui part sous un tableau qui annonce toujours v2.3.0 — alors que
   l'aperçu est censé ÊTRE la confirmation. */
$('#gitRefName').addEventListener('input', gitDropPreview);
$('#gitTagMsg').addEventListener('input', gitDropPreview);
document.addEventListener('click', (e) => {
  const rm = e.target.closest && e.target.closest('[data-gitrm]');
  if (!rm) return;
  const i = Number(rm.dataset.gitrm);
  if (gitTargets.length > 1) { gitTargets.splice(i, 1); gitDropPreview(); gitRenderTargets(); }
});

