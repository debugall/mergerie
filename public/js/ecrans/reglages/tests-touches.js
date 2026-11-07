'use strict';
/* Les zones de motifs des tests touchés — globales (Merge Request → Découverte), d'un dépôt (sa
   ligne dépliée) et d'un groupe (son formulaire) : « Remettre les défauts », l'aperçu « sur les MR
   ouvertes, ces motifs classent 41 fichiers en tests, 12 en neutres » (calculé en base, sans
   attendre une merge request), les défauts livrés en invite des champs vides, et la note de
   dépendance quand le relevé des fichiers est décoché. */

/* Les défauts livrés des trois listes — tests, neutres (tests touchés) et manifestes (dépendances) —
   en un objet, pour « Remettre les défauts » et les invites. */
let defautsMotifs = null;
async function chargerDefautsMotifs() {
  if (!defautsMotifs) {
    try {
      const [t, d] = await Promise.all([api('/tests-touches/defauts'), api('/dependances/defauts')]);
      defautsMotifs = { ...t, manifest_patterns: d.manifest_patterns };
    } catch { return null; }
  }
  return defautsMotifs;
}

/* La portée d'une zone : le dépôt de sa ligne, le groupe de son formulaire, sinon global. */
function porteeMotifs(zone) {
  const ligne = zone.closest('.repo-row');
  if (ligne) return { repo_id: Number(ligne.dataset.repo) };
  const form = zone.closest('#groupForm');
  if (form) return { group_id: Number(form.id.value) || 0 };
  return {};
}
const conteneurMotifs = (zone) => zone.closest('.repo-edit, #groupForm, #sub-mr') || document;
const champMotifs = (conteneur, nom) => conteneur.querySelector(`[name="${nom}"], [data-f="${nom}"]`);

/* L'aperçu d'un conteneur : les deux listes telles que saisies (vides = héritées), classées sur les
   MR ouvertes de la portée. Un motif invalide est dit ici, avec sa ligne, avant d'être enregistré. */
let seqApercu = 0;
async function majApercuMotifs(conteneur) {
  const cible = conteneur.querySelector('[data-patterns-apercu]');
  if (!cible) return;
  const zone = cible.closest('.patterns-zone');
  const mon = ++seqApercu;
  const body = {
    ...porteeMotifs(zone),
    test_patterns: (champMotifs(conteneur, 'test_patterns') || {}).value || '',
    neutral_patterns: (champMotifs(conteneur, 'neutral_patterns') || {}).value || '',
  };
  try {
    const d = await api('/tests-touches/apercu', { method: 'POST', body });
    if (mon !== seqApercu) return;
    cible.classList.remove('form-info-dirty');
    cible.textContent = d.mrs ? tr('settings.patterns.apercu', { mrs: d.mrs, tests: d.tests, neutral: d.neutral, code: d.code }) : tr('settings.patterns.apercu.none');
  } catch (e) {
    if (mon !== seqApercu) return;
    cible.classList.add('form-info-dirty');
    cible.textContent = explainError(e.message);
  }
}
/* L'aperçu des manifestes, même mécanique : « ces motifs désignent 3 manifestes sur 4 MR ouvertes ». */
async function majApercuManifestes(conteneur) {
  const cible = conteneur.querySelector('[data-manifests-apercu]');
  if (!cible) return;
  const zone = cible.closest('.patterns-zone');
  const body = { ...porteeMotifs(zone), manifest_patterns: (champMotifs(conteneur, 'manifest_patterns') || {}).value || '' };
  try {
    const d = await api('/dependances/apercu', { method: 'POST', body });
    cible.classList.remove('form-info-dirty');
    cible.textContent = d.mrs ? tr('settings.manifests.apercu', { mrs: d.mrs, manifests: d.manifests, with: d.with_manifest }) : tr('settings.patterns.apercu.none');
  } catch (e) {
    cible.classList.add('form-info-dirty');
    cible.textContent = explainError(e.message);
  }
}
const majApercuMotifsBientot = debounce((c) => { majApercuMotifs(c); majApercuManifestes(c); }, 400);

/* Les invites (défauts livrés) et l'aperçu d'un conteneur — au chargement des réglages, à
   l'ouverture d'une ligne de dépôt ou d'un formulaire de groupe. */
async function majMotifsTests(conteneur = $('#sub-mr')) {
  if (!conteneur) return;
  const dep = $('#testsTouchedDep');
  const relever = $('#sub-mr [name="mr_files_enabled"]');
  if (dep && relever) dep.hidden = relever.checked;
  const depCommits = $('#mrCommitsDep');
  if (depCommits && relever) depCommits.hidden = relever.checked;
  const d = await chargerDefautsMotifs();
  if (d && conteneur === $('#sub-mr')) {
    const t1 = champMotifs(conteneur, 'test_patterns'); const t2 = champMotifs(conteneur, 'neutral_patterns'); const t3 = champMotifs(conteneur, 'manifest_patterns');
    if (t1) t1.placeholder = d.test_patterns;
    if (t2) t2.placeholder = d.neutral_patterns;
    if (t3) t3.placeholder = d.manifest_patterns;
  }
  majApercuMotifs(conteneur);
  majApercuManifestes(conteneur);
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-patterns-reset]');
  if (!b) return;
  const zone = b.closest('.patterns-zone');
  const champ = zone && zone.querySelector('textarea');
  const d = await chargerDefautsMotifs();
  if (!champ || !d) return;
  champ.value = d[b.dataset.patternsReset] || '';
  champ.dispatchEvent(new Event('input', { bubbles: true }));
  champ.focus();
});
document.addEventListener('input', (e) => {
  const champ = e.target;
  if (!champ.closest || !champ.closest('.patterns-zone')) return;
  majApercuMotifsBientot(conteneurMotifs(champ));
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.matches && e.target.matches('#sub-mr [name="mr_files_enabled"]')) {
    const dep = $('#testsTouchedDep'); if (dep) dep.hidden = e.target.checked;
    const depCommits = $('#mrCommitsDep'); if (depCommits) depCommits.hidden = e.target.checked;
  }
});
