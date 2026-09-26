'use strict';
/* Réglages : sous-onglets (Git · Dépôts · Merge Request · …). */
// @expose ADMIN_SUBS, showAdminSub
/* ---------- Réglages : sous-onglets (Git · Dépôts · Merge Request · …) ----------
   Chaque panneau charge ses données à l'ouverture (rien d'inutile au démarrage),
   et le dernier sous-onglet consulté est mémorisé — on revient dans Réglages pour finir ce
   qu'on y faisait. Le repli, lui, est `gitcfg` : rien de mémorisé = installation neuve, et
   sans jeton aucun autre réglage ne sert à quoi que ce soit. C'est déjà là que l'onboarding
   envoie sa première étape. */
// `mr` partage la logique de `config` : ses champs sont rattachés à #configForm (attribut form=),
// donc loadConfig les peuple et le submit les enregistre — un seul /config pour les deux onglets.
const ADMIN_SUBS = { rules: loadRules, repos: loadRepos, notif: renderNotifSettings, config: loadGeneralSettings, mr: loadConfig, gitcfg: loadGitConfig, jiracfg: loadConfig, jenkinscfg: loadJenkinsConfig, verifiers: loadVerifiersEtPlafond, aisession: loadAiSessionSettings, datasync: loadConfig };
/* Ce panneau porte à la fois un réglage du formulaire global (les consignes permanentes) et un
   banc d'essai. Il lui faut donc `loadConfig` comme aux autres, sinon le champ s'affiche vide
   quoi qu'il y ait en base — et le premier « Enregistrer » l'efface sans rien demander. */
function loadAiSessionSettings() { loadConfig(); renderAiSessionSettings(); renderSandboxSettings(); }
/* « Général » porte les réglages de l'outil ET l'arrangement de la barre de menus, qui vit dans
   le navigateur : deux sources, un seul panneau, donc les deux chargements. */
function loadGeneralSettings() { loadConfig(); renderNavPrefs(); }
/* Le panneau Jenkins porte AUSSI la liste des jobs liés aux dépôts (B8) : deux sources, un
   seul écran, donc les deux chargements — comme « Général » et sa barre de menus. */
function loadJenkinsConfig() { loadConfig(); loadJenkinsLinks(); }
/* Le panneau des vérificateurs porte AUSSI un champ de #configForm (le plafond des
   vérifications automatiques, venu de Merge Request rejoindre son interrupteur) : sans
   `loadConfig` il s'afficherait vide quoi qu'il y ait en base. */
function loadVerifiersEtPlafond() { loadConfig(); loadVerifiers(); }
function showAdminSub(sub) {
  if (!sub) { try { sub = localStorage.getItem('aidevtools_admin_sub') || 'gitcfg'; } catch { sub = 'gitcfg'; } }
  if (!ADMIN_SUBS[sub]) sub = 'gitcfg';
  $$('#tab-admin .subnav [data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $$('#tab-admin .subtab').forEach((p) => p.classList.toggle('active', p.id === `sub-${sub}`));
  try { localStorage.setItem('aidevtools_admin_sub', sub); } catch { /* ignore */ }
  try { ADMIN_SUBS[sub](); } catch { /* chargement best-effort */ }
  // Le souvenir des tests de connexion : il ne coûte qu'une lecture en base, et il répond à
  // « est-ce que ça marchait, la dernière fois que quelqu'un a regardé ? ».
  if (sub === 'gitcfg' || sub === 'jiracfg' || sub === 'jenkinscfg') majEtatsConnexions();
}
$$('#tab-admin .subnav [data-sub]').forEach((b) => b.addEventListener('click', () => showAdminSub(b.dataset.sub)));

