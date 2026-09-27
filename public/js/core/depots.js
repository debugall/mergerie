'use strict';
/* La liste des dépôts (`repoOptions`, `loadRepoOptions`), le mode démo et le dépôt par défaut, Jira configuré. */
let jiraConfigured = false;

/* MODE DÉMO : le décor ne contient qu'un seul dépôt réellement clonable — celui qui vit sur
   le disque. Les autres pointent vers `gitlab.demo`, qui n'existe pas : une session créée
   dessus mourait en 1,6 s sur une pile Node `git clone git@gitlab.demo…`, et c'était le dépôt
   proposé par défaut, donc le premier essai de qui découvre l'outil. */
let modeDemo = false;
const depotClonableEnDemo = (r) => /^(\/|file:)/.test(String((r && r.url) || ''));
/* Hors démo rien ne change — le premier de la liste. En démo, celui qui peut vraiment tourner. */
function depotParDefaut() {
  if (modeDemo) { const local = repoOptions.find(depotClonableEnDemo); if (local) return local; }
  return repoOptions[0] || null;
}

// Bannière « mode démo » : affichée si le serveur tourne en mode démo (npm run demo).
(async () => {
  try {
    const s = await api('/status');
    if (s && s.demo) { modeDemo = true; const b = $('#demoBanner'); if (b) b.hidden = false; }
    if (s) jiraConfigured = !!s.jiraConfigured;
  } catch { /* status indisponible : pas de bannière */ }
})();
let repoOptions = [];          // dépôts disponibles pour les sélecteurs
async function loadRepoOptions() {
  try { repoOptions = await api('/repos'); } catch { repoOptions = []; }
  return repoOptions;
}

/* En démo, un dépôt injoignable reste choisissable — mais il le dit. Promettre une session
   qui mourra au clonage est pire que de l'annoncer avant le clic. */
const marqueDemo = (r) => (modeDemo && !depotClonableEnDemo(r)
  ? `<span class="combo-hint">${esc(tr('demo.repo.not-runnable'))}</span>` : '');

/* ---------- Les groupes de dépôts (ameliorations_proposal.md, §4.5) ----------
   Une liste courte — une équipe en a trois, pas trente —, chargée avec les dépôts, et des
   PASTILLES posées à côté de chaque sélecteur multi-dépôts : cliquer « backend » ajoute ou
   coche tous ses membres. Le geste est le même partout ; ce que « ajouter » veut dire (une
   ligne de session, une ligne d'action Git, une case de couverture) est à chaque écran. */
let groupeOptions = [];
async function loadGroupeOptions() {
  try { groupeOptions = await api('/repo-groups'); } catch { groupeOptions = []; }
  return groupeOptions;
}
/* Les pastilles d'un sélecteur : `data-groupe-chip` porte l'id, `data-groupe-zone` dit à quel
   écran elles parlent. Rien sans groupe : une rangée vide n'apprend rien. */
function groupeChipsHtml(zone) {
  if (!groupeOptions.length) return '';
  return `<span class="groupe-chips" data-groupe-zone="${esc(zone)}" title="${esc(tr('ui.groupes.chips-title'))}">${groupeOptions
    .map((g) => `<button type="button" class="groupe-chip" data-groupe-chip="${g.id}" title="${esc((g.repos || []).map((r) => r.project).join(', '))}">${esc(g.name)} <span class="groupe-n">${(g.repos || []).length}</span></button>`).join('')}</span>`;
}
const membresDuGroupe = (id) => ((groupeOptions.find((g) => g.id === Number(id)) || {}).repos || []).map((r) => r.repo_id);
