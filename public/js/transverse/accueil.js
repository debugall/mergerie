'use strict';
/* L'assistant de démarrage : les trois étapes, ce qui les fait basculer, les portes des états vides. */
// Onboarding : tant que GitLab n'est pas connecté ou qu'aucun dépôt n'est suivi,
// on remplace la liste par les 3 étapes de démarrage, chacune avec son action directe.
let setupState = { agent: null, configured: false, hasRepos: false, outils: false, hasMrs: false, checked: false };
/* CE QUE TON ÉQUIPE UTILISE : une préférence de NAVIGATEUR, comme la barre de menus qu'elle
   règle. Absente, l'étape reste à faire ; « skip » quand des merge requests existaient déjà à
   la première lecture — une installation en service n'a pas à repasser par l'assistant. */
const ONBOARD_OUTILS_KEY = 'mergerie_onboard_outils';
const outilsChoisis = () => { try { return !!localStorage.getItem(ONBOARD_OUTILS_KEY); } catch { return true; } };
async function checkSetup() {
  try {
    /* `hasMrs` couvre la DERNIÈRE étape. Sans elle, l'assistant disparaissait dès la
       deuxième franchie — on connectait la forge, on ajoutait un dépôt, et l'écran passait à
       « aucune merge request » sans jamais montrer qu'il restait un geste à faire ni que les
       deux premiers avaient réussi. Une progression qui s'évanouit aux deux tiers ne se lit
       pas comme une progression.
       Le compte porte sur TOUS les stades : une file vide après une découverte est un état
       légitime (« tout est traité »), à ne pas confondre avec « on n'a jamais cherché ». */
    const [cfg, repos, stats, statut] = await Promise.all([api('/config'), api('/repos'), api('/stats'), api('/status')]);
    const f = (stats && stats.funnel) || {};
    const hasMrs = ((f.to_review || 0) + (f.reviewed || 0) + (f.done || 0)) > 0;
    if (hasMrs && !outilsChoisis()) { try { localStorage.setItem(ONBOARD_OUTILS_KEY, 'skip'); } catch { /* ignore */ } }
    setupState = {
      /* L'AGENT : trouvé, ou simulé EXPRÈS (COPILOT_DRY_RUN=1 — démo, tests). Introuvable sans
         l'avoir voulu, l'étape reste ouverte, et la bannière en haut le dit aussi. */
      agent: { bin: statut.copilotBin || '', ok: !!statut.copilotAvailable, force: !!statut.dryRunForced },
      agentMode: statut.agentMode === 'secure' ? 'secure' : 'yolo',
      /* LA FORGE, L'UNE OU L'AUTRE. L'étape ne se cochait qu'avec GitLab : un utilisateur GitHub
         seul la gardait ouverte à vie. */
      configured: !!((cfg.gitlab_url && cfg.access_token) || cfg.github_token),
      hasRepos: Array.isArray(repos) && repos.length > 0,
      outils: outilsChoisis(),
      hasMrs,
      checked: true,
    };
  } catch { setupState.checked = true; }
  return setupState;
}
const agentPret = () => !!(setupState.agent && (setupState.agent.ok || setupState.agent.force));
/* L'assistant a-t-il encore quelque chose à montrer ? L'agent n'y entre pas : introuvable, il ne
   doit pas cacher une file pleine — la bannière s'en charge. */
const demarrageIncomplet = () => setupState.checked && (!setupState.configured || !setupState.hasRepos || !setupState.outils || !setupState.hasMrs);

/* Relit l'état du démarrage et redessine l'assistant s'il est à l'écran. Appelé au chargement,
   après un enregistrement de configuration et après un ajout de dépôt — les trois moments où
   une étape peut basculer de « à faire » à « fait ». */
function rafraichirDemarrage() {
  return checkSetup().then(() => { if (currentSeg === 'to_review') renderToReview(); });
}

function onboardingHtml() {
  const s = setupState;
  const step = (n, done, t, sub, boutons) => `
    <div class="step ${done ? 'done' : ''}" data-step="${n}">
      <span class="step-n">${done ? svgIco('check') : n + 1}</span>
      <span class="step-txt"><span class="step-t">${t}</span><br><span class="step-s">${sub}</span></span>
      ${done ? '' : boutons}
    </div>`;
  const btn = (act, label, primaire) => `<button class="btn btn-sm ${primaire ? 'btn-primary' : ''}" data-empty-act="${act}">${label}</button>`;
  const ag = s.agent || { bin: '', ok: false, force: false };
  const agentTexte = ag.force ? tr('onboard.s0.dryrun')
    : ag.ok ? tr('onboard.s0.found', { bin: ag.bin }) : tr('onboard.s0.missing', { bin: ag.bin || 'claude' });
  const forgeFaite = s.configured;
  const prochaine = !agentPret() ? 0 : !forgeFaite ? 1 : !s.hasRepos ? 2 : !s.outils ? 3 : 4;
  const outilsHtml = `
      <span class="onboard-outils">
        <label class="inline-check"><input type="checkbox" data-outil="jira" /> <span>${esc(tr('onboard.s3.jira'))}</span></label>
        ${pluginsOnboarding().map((o) => `<label class="inline-check"><input type="checkbox" data-outil="${esc(o.tab)}" /> <span>${esc(o.label)}</span></label>`).join('')}
        <label class="onboard-mode"><span>${esc(tr('onboard.s3.mode'))}</span>
          <select data-agent-mode>
            <option value="yolo" ${s.agentMode === 'secure' ? '' : 'selected'}>${esc(tr('onboard.s3.mode-yolo'))}</option>
            <option value="secure" ${s.agentMode === 'secure' ? 'selected' : ''}>${esc(tr('onboard.s3.mode-secure'))}</option>
          </select></label>
        ${btn('outils-ok', tr('onboard.s3.btn'), prochaine === 3)}
      </span>`;
  return `<div class="empty">
    <svg class="ico"><use href="#i-bot"/></svg>
    <div class="empty-t">${tr('onboard.title')}</div>
    <p class="empty-s">${tr('onboard.subtitle')}</p>
    <div class="steps">
      ${step(0, agentPret(), tr('onboard.s0.title'), esc(agentTexte),
    btn('go-agent', tr('onboard.s0.btn'), prochaine === 0) + btn('agent-retry', tr('onboard.s0.retry')))}
      ${step(1, forgeFaite, tr('onboard.s1.title'), tr('onboard.s1.text'),
    btn('go-config', tr('onboard.s1.btn'), prochaine === 1) + btn('go-config-github', tr('onboard.s1.btn-github')))}
      ${step(2, s.hasRepos, tr('onboard.s2.title'), tr('onboard.s2.text'), btn('go-repos', tr('onboard.s2.btn'), prochaine === 2))}
      ${step(3, s.outils, tr('onboard.s3.title'), tr('onboard.s3.text'), outilsHtml)}
      ${/* La dernière se coche quand des merge requests sont VRAIMENT arrivées : c'est la
             seule dont on connaît le résultat sans rien redemander au serveur —
             si cet écran s'affiche avec des cartes, c'est que la recherche a rapporté. */''}
      ${step(4, s.hasMrs, tr('onboard.s4.title'), tr('onboard.s4.text'), btn('discover', tr('onboard.s4.btn'), prochaine === 4))}
    </div>
  </div>`;
}
/* « CE QUE TON ÉQUIPE UTILISE » : ce qui est coché sort de la liste des menus repliés — et y
   reste, comme si l'utilisateur l'avait fait dans Réglages → Général → Menus. Rien n'est
   masqué de plus : décoché veut dire « je ne sais pas encore », pas « cache-le ». */
function validerOutils(racine) {
  const coches = $$('[data-outil]', racine).filter((c) => c.checked).map((c) => c.dataset.outil);
  try { localStorage.setItem(ONBOARD_OUTILS_KEY, coches.join(',') || 'none'); } catch { /* ignore */ }
  if (coches.length && typeof devoilerMenus === 'function') devoilerMenus(coches);
  /* « Sécurisé ou yolo ? » — posée ici, une fois, sans imposer : le choix part au serveur comme
     depuis Réglages → Session IA, et l'étape se coche dans les deux cas. */
  const sel = racine && racine.querySelector('[data-agent-mode]');
  const mode = sel && sel.value === 'secure' ? 'secure' : 'yolo';
  if (sel && mode !== setupState.agentMode) {
    api('/config', { method: 'PUT', body: { agent_mode: mode } }).then(() => { setupState.agentMode = mode; if (typeof refreshStatus === 'function') refreshStatus(); }).catch(() => {});
  }
  setupState.outils = true;
  if (currentSeg === 'to_review') renderToReview();
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
    case 'go-agent': go('admin'); showAdminSub('aisession'); viser('#cliAdd'); break;
    case 'agent-retry': api('/agent/redetect', { method: 'POST' }).then(() => rafraichirDemarrage()).catch(() => {}); break;
    case 'outils-ok': validerOutils(b.closest('.step')); break;
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
    case 'clear-search': $('#searchReview').value = ''; loadSegment(currentSeg); break;
    case 'clear-auteur': filtreAuteur = 'tous'; try { localStorage.setItem('aidevtools_mr_auteur', 'tous'); } catch { /* ignore */ } renderFiltreAuteur(); loadSegment(currentSeg); break;
    case 'clear-note-filter': reinitFiltreNote(); break;
    default: break;
  }
});

