'use strict';
/* L'assistant de démarrage : les trois étapes, ce qui les fait basculer, les portes des états vides. */
// Onboarding : tant que GitLab n'est pas connecté ou qu'aucun dépôt n'est suivi,
// on remplace la liste par les 3 étapes de démarrage, chacune avec son action directe.
let setupState = { configured: false, hasRepos: false, hasMrs: false, checked: false };
async function checkSetup() {
  try {
    /* `hasMrs` couvre la TROISIÈME étape. Sans elle, l'assistant disparaissait dès la
       deuxième franchie — on connectait la forge, on ajoutait un dépôt, et l'écran passait à
       « aucune merge request » sans jamais montrer qu'il restait un geste à faire ni que les
       deux premiers avaient réussi. Une progression qui s'évanouit aux deux tiers ne se lit
       pas comme une progression.
       Le compte porte sur TOUS les stades : une file vide après une découverte est un état
       légitime (« tout est traité »), à ne pas confondre avec « on n'a jamais cherché ». */
    const [cfg, repos, stats] = await Promise.all([api('/config'), api('/repos'), api('/stats')]);
    const f = (stats && stats.funnel) || {};
    setupState = {
      configured: !!(cfg.gitlab_url && cfg.access_token),
      hasRepos: Array.isArray(repos) && repos.length > 0,
      hasMrs: ((f.to_review || 0) + (f.reviewed || 0) + (f.done || 0)) > 0,
      checked: true,
    };
  } catch { setupState.checked = true; }
  return setupState;
}

/* Relit l'état du démarrage et redessine l'assistant s'il est à l'écran. Appelé au chargement,
   après un enregistrement de configuration et après un ajout de dépôt — les trois moments où
   une étape peut basculer de « à faire » à « fait ». */
function rafraichirDemarrage() {
  return checkSetup().then(() => { if (currentSeg === 'to_review') renderToReview(); });
}

// Jira configuré côté serveur ? Pilote l'affichage du bloc « enrichir depuis Jira »
// de la modale de session. Mis à jour à chaque /status.
function onboardingHtml() {
  const s = setupState;
  const step = (n, done, t, sub, act, label) => `
    <div class="step ${done ? 'done' : ''}">
      <span class="step-n">${done ? svgIco('check') : n}</span>
      <span class="step-txt"><span class="step-t">${t}</span><br><span class="step-s">${sub}</span></span>
      ${done ? '' : `<button class="btn btn-sm ${n === 1 || (n === 2 && s.configured) ? 'btn-primary' : ''}" data-empty-act="${act}">${label}</button>`}
    </div>`;
  return `<div class="empty">
    <svg class="ico"><use href="#i-bot"/></svg>
    <div class="empty-t">${tr('onboard.title')}</div>
    <p class="empty-s">${tr('onboard.subtitle')}</p>
    <div class="steps">
      ${step(1, s.configured, tr('onboard.s1.title'), tr('onboard.s1.text'), 'go-config', tr('onboard.s1.btn'))}
      ${step(2, s.hasRepos, tr('onboard.s2.title'), tr('onboard.s2.text'), 'go-repos', tr('onboard.s2.btn'))}
      ${/* La troisième se coche quand des merge requests sont VRAIMENT arrivées : c'est la
             seule des trois dont on connaît le résultat sans rien redemander au serveur —
             si cet écran s'affiche avec des cartes, c'est que la recherche a rapporté. */''}
      ${step(3, s.hasMrs, tr('onboard.s3.title'), tr('onboard.s3.text'), 'discover', tr('onboard.s3.btn'))}
    </div>
  </div>`;
}
// Actions des états vides / de l'onboarding (délégation : le HTML est régénéré souvent).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-empty-act]');
  if (!b) return;
  const go = (tab) => { const t = $(`nav button[data-tab="${tab}"]`); if (t) t.click(); };
  /* ARRIVER QUELQUE PART, C'EST ARRIVER SUR UN CHAMP. L'assistant envoyait sur Réglages → Git
     sans focus : l'écran change, le curseur reste sur un bouton qui n'existe plus, et il faut
     viser à la souris le premier champ d'un formulaire qu'on vient de demander. */
  const viser = (sel) => { const c = $(sel); if (c) c.focus({ preventScroll: true }); };
  switch (b.dataset.emptyAct) {
    case 'go-config': closeBulk(); go('admin'); showAdminSub('gitcfg'); viser('[name="gitlab_url"]'); break;
    /* La même porte, mais sur le champ de L'AUTRE forge : envoyer sur l'URL GitLab quelqu'un à
       qui il manque un jeton GitHub, c'est le faire chercher. */
    case 'go-config-github': closeBulk(); go('admin'); showAdminSub('gitcfg'); viser('[name="github_token"]'); break;
    case 'go-repos': go('admin'); showAdminSub('repos'); viser('#repoForm [name="url"]'); break;
    case 'go-rules': go('admin'); showAdminSub('rules'); break;
    case 'discover': go('review'); $('#btnDiscover').click(); break;
    case 'new-task': go('task'); $('#btnNewTask').click(); break;
    case 'seg-to-review': loadSegment('to_review'); break;
    case 'seg-reviewed': loadSegment('reviewed'); break;
    case 'go-jira-config': go('admin'); showAdminSub('jiracfg'); viser('[name="jira_url"]'); break;
    case 'jenkins-config': go('admin'); showAdminSub('jenkinscfg'); viser('[name="jenkins_url"]'); break;
    case 'clear-search': $('#searchReview').value = ''; loadSegment(currentSeg); break;
    case 'clear-auteur': filtreAuteur = 'tous'; try { localStorage.setItem('aidevtools_mr_auteur', 'tous'); } catch { /* ignore */ } renderFiltreAuteur(); loadSegment(currentSeg); break;
    case 'clear-note-filter': reinitFiltreNote(); break;
    default: break;
  }
});

