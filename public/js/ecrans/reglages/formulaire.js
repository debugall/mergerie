'use strict';
/* Le formulaire de réglages : saisie vs chargement, « non enregistrées », Entrée enregistre, `CONFIG_FIELDS`, `loadConfig`, n'envoyer que ce qui a changé. */
/* ---------- Admin ---------- */
// Liste unique des champs texte du formulaire — chargement ET enregistrement
// itèrent dessus (une divergence entre les deux = un champ qui ne s'enregistre pas,
// exactement le bug qu'ont connu jira_email / jira_token).
const CONFIG_FIELDS = ['gitlab_url', 'jira_url', 'jira_email', 'jira_token', 'access_token',
  'github_url', 'github_token', 'jenkins_url', 'jenkins_user', 'jenkins_token', 'jenkins_refresh_minutes',
  'clone_path', 'prompt_review', 'prompt_explain', 'prompt_modify', 'prompt_fix', 'ai_extra_instructions',
  'converge_threshold', 'converge_max_passes', 'jira_watch_minutes', 'retention_days',
  'verif_auto_max', 'verif_auto_authors', 'review_auto_max', 'todo_close_on_merge', 'jira_test_key', 'agent_auto_max',
  'agent_max_turns', 'agent_daily_budget_usd',
  'task_default_auto_push', 'task_default_ask_questions',
  'task_default_notify_jira', 'task_default_converge', 'verify_jira_comment',
  'stale_mr_days', 'auto_runner', 'auto_post_review_link', 'review_link_template',
  /* Dictée vocale (whisper.md §6.3). `dictation_silence_ms` et `dictation_idle_minutes` sont
     ici comme `retention_days` : envoyés par cette liste, mais BORNÉS côté serveur, où ils
     n'appartiennent pas à `ALLOWED`. La case `dictation_final_pass`, elle, est traitée à
     part comme les autres cases. */
  'dictation_provider', 'dictation_model', 'dictation_vad_model', 'dictation_command',
  'dictation_url', 'dictation_api_key', 'dictation_remote_model', 'dictation_language',
  'dictation_vocabulary', 'dictation_replacements',
  'dictation_silence_ms', 'dictation_idle_minutes',
  /* Données partagées : l'adresse du dépôt d'équipe, sa branche, la cadence. De POSTE — c'est
     par là que cette machine rejoint l'équipe, et la mettre dans les réglages d'équipe serait
     circulaire : il faudrait déjà être rattaché pour savoir où se rattacher. */
  'data_repo_url', 'data_repo_branch', 'data_sync_seconds', 'usage_share'];
/* CE QUI EST TAPÉ NE DOIT PAS ÊTRE EFFACÉ PAR UN CHARGEMENT EN RETARD.
 *
 * `loadConfig()` part à chaque ouverture d'un sous-onglet de réglages, et sa réponse revient
 * quelques dizaines de millisecondes plus tard. Entre les deux, l'utilisateur peut déjà avoir
 * commencé à taper : la réponse écrase alors ses champs avec ce que le serveur avait, sans un
 * mot. Sur une machine chargée, la fenêtre s'élargit — c'est ainsi qu'un test collait son
 * jeton Jenkins et cliquait « Tester » sur trois champs redevenus vides.
 *
 * On note donc l'instant de la dernière frappe : si elle est postérieure au DÉPART de la
 * requête, on ne touche à rien.
 *
 * Le rechargement qui SUIT une sauvegarde passe naturellement : la dernière frappe est alors
 * antérieure à son départ. Et s'il se trouve que l'utilisateur tape PENDANT l'enregistrement,
 * s'abstenir est encore le bon geste — c'est sa saisie la plus récente, pas celle du serveur,
 * qu'il faut garder. */
let configFrappe = 0;
document.addEventListener('input', (e) => {
  if (e.target && e.target.form && e.target.form.id === 'configForm') configFrappe = Date.now();
}, true);

/* ---------- « Modifications non enregistrées » ----------
   Neuf réglages, un seul bouton, aucun indicateur : on changeait un plafond, on passait à un
   autre sous-onglet, et rien ne disait que rien n'était parti. Les champs de #configForm sont
   éclatés sur six sous-onglets — chacun a son bouton « Enregistrer » et sa mention : on les
   marque TOUS, pour que l'avertissement suive celui qui change d'écran. */
let configSale = false;
const boutonsConfig = () => $$('button[form="configForm"][type="submit"]');
const mentionsConfig = () => $$('#configInfo, #configInfoGeneral, #configInfoMr, #configInfoGit, #configInfoGithub, #configInfoJira, #configInfoJenkins, #configInfoAi, #configInfoVerif').filter(Boolean);

function marquerConfig(sale) {
  configSale = sale;
  for (const b of boutonsConfig()) b.classList.toggle('is-dirty', sale);
  for (const m of mentionsConfig()) {
    if (sale) { m.textContent = tr('settings.unsaved'); m.classList.add('form-info-dirty'); }
    else if (m.classList.contains('form-info-dirty')) { m.textContent = ''; m.classList.remove('form-info-dirty'); }
  }
}
/* `change` autant qu'`input` : une case à cocher et un <select> ne produisent que le premier. */
for (const ev of ['input', 'change']) {
  document.addEventListener(ev, (e) => {
    if (e.target && e.target.form && e.target.form.id === 'configForm') marquerConfig(true);
  }, true);
}

/* ENTRÉE ENREGISTRE, ET LE DIT. Les champs de réglages vivent HORS de #configForm (ils s'y
   rattachent par `form=`), et le bouton « Enregistrer » aussi : le navigateur ne trouve alors
   aucun bouton par défaut dans le formulaire et la soumission implicite n'arrive jamais. On
   tapait son jeton, on appuyait sur Entrée, et il ne se passait rien — ni enregistrement, ni
   message. Les zones de texte gardent Entrée pour aller à la ligne. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
  const c = e.target;
  if (!c || !c.form || c.form.id !== 'configForm') return;
  if (c.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  c.form.requestSubmit();
});

/* Le plafond des reviews automatiques ne veut rien dire quand l'automatisme est éteint :
   il s'indente sous sa case et se désactive avec elle. */
function syncReviewAutoMax() {
  const c = $('#configForm') && $('#configForm').auto_review_new;
  const rang = $('#reviewAutoMaxRow');
  if (!c || !rang) return;
  rang.classList.toggle('is-off', !c.checked);
  const n = rang.querySelector('input');
  if (n) n.disabled = !c.checked;
}
/* Le filtre « uniquement s'il y a des points bloquants » ne veut rien dire quand la
   publication automatique est éteinte : il n'est pas grisé, il DISPARAÎT. Le plafond des
   reviews automatiques, lui, reste visible parce qu'il porte une valeur qu'on veut relire ;
   celui-ci n'est qu'un oui/non, et une case inerte dans un écran de neuf réglages se lit
   comme un réglage qu'on aurait oublié de cocher. */
/* Y a-t-il un dépôt de données ? Relu à chaque `loadConfig` : sans lui, « publier le lien »
   n'aurait nulle part où pointer, et la ligne ne s'affiche pas. */
let depotDonneesConfigure = false;
function syncAutoPostBlocking() {
  const f = $('#configForm');
  const c = f && f.auto_post_review;
  const rang = $('#autoPostBlockingRow');
  if (!c) return;
  if (rang) rang.hidden = !c.checked;
  const rangLien = $('#autoPostLinkRow');
  if (rangLien) rangLien.hidden = !c.checked || !depotDonneesConfigure;
  /* Le gabarit ne sert que si un lien part : il suit la case « publier le lien », pas seulement
     la case du dessus. Un champ de texte inutile coûte plus cher qu'une case inutile.
     MAIS UN CHAMP REMPLI RESTE VISIBLE, quoi qu'en disent les cases : le serveur refuse un
     gabarit sans `{url}`, et ce refus arrête l'enregistrement de TOUT le formulaire. Caché, il
     bloquerait les réglages en parlant d'un champ que personne ne peut plus atteindre. */
  const rangGabarit = $('#reviewLinkTemplateRow');
  const lien = f && f.auto_post_review_link;
  const gabaritRempli = !!(f && f.review_link_template && String(f.review_link_template.value || '').trim());
  if (rangGabarit) {
    rangGabarit.hidden = !gabaritRempli
      && (!c.checked || !depotDonneesConfigure || !(lien && lien.checked));
  }
}
document.addEventListener('change', (e) => {
  if (!e.target) return;
  if (e.target.name === 'auto_review_new') syncReviewAutoMax();
  if (e.target.name === 'auto_post_review' || e.target.name === 'auto_post_review_link'
    || e.target.name === 'review_link_template') syncAutoPostBlocking();
});

/* CE QUE LE FORMULAIRE ENVERRAIT, champ par champ. Lu deux fois : au chargement (la référence)
   et à l'enregistrement (ce qui a changé depuis). */
function corpsConfig(f) {
  const body = {};
  /* UNE CASE À COCHER N'A PAS DE `.value` UTILE. `input[type=checkbox].value` vaut « on »
     qu'elle soit cochée ou non — c'est le nom HTML de la valeur ENVOYÉE par un formulaire
     classique quand elle est cochée, pas son état. Les quatre cases « cochées d'office » d'une
     nouvelle session partaient donc en base avec la chaîne « on », que tout le monde relit
     ensuite en `=== '1'` : la case revenait décochée au rechargement, et le réglage n'était
     jamais appliqué. On lit donc `.checked` dès que le champ EST une case — la règle vaut pour
     celles qui existent et pour celles qu'on ajoutera. */
  for (const k of CONFIG_FIELDS) {
    if (!f[k]) continue;
    body[k] = f[k].type === 'checkbox' ? (f[k].checked ? '1' : '0') : f[k].value;
  }
  body.auto_refresh_minutes = f.auto_refresh_minutes.value;
  if (f.review_explain) body.review_explain = f.review_explain.checked ? '1' : '0';
  if (f.auto_post_review) body.auto_post_review = f.auto_post_review.checked ? '1' : '0';
  if (f.auto_post_blocking_only) body.auto_post_blocking_only = f.auto_post_blocking_only.checked ? '1' : '0';
  if (f.auto_review_new) body.auto_review_new = f.auto_review_new.checked ? '1' : '0';
  if (f.auto_rereview_stale) body.auto_rereview_stale = f.auto_rereview_stale.checked ? '1' : '0';
  if (f.brief_on_open) body.brief_on_open = f.brief_on_open.checked ? '1' : '0';
  if (f.todo_close_on_merge) body.todo_close_on_merge = f.todo_close_on_merge.checked ? '1' : '0';
  if (f.dictation_final_pass) body.dictation_final_pass = f.dictation_final_pass.checked ? '1' : '0';
  // '***' = champ non touché (on n'écrase pas le secret) ; '' = effacement volontaire.
  if (body.access_token === '***') delete body.access_token;
  if (body.jira_token === '***') delete body.jira_token;
  if (body.github_token === '***') delete body.github_token;
  if (body.jenkins_token === '***') delete body.jenkins_token;
  if (body.dictation_api_key === '***') delete body.dictation_api_key;
  return body;
}
/* N'ENVOYER QUE CE QUI A CHANGÉ. Le formulaire renvoyait TOUS ses champs : resté ouvert pendant
   qu'un collègue changeait un réglage d'équipe (reçu par la synchro), enregistrer un autre champ
   réécrivait l'ancienne valeur par-dessus la sienne, sans un mot. La référence est ce que le
   formulaire montrait en se chargeant. */
let configReference = null;
$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const complet = corpsConfig(f);
  const body = {};
  for (const [k, v] of Object.entries(complet)) {
    if (!configReference || configReference[k] !== v) body[k] = v;
  }
  try {
    await api('/config', { method: 'PUT', body });
    // Le formulaire est éclaté sur deux sous-onglets (Général / Merge Request) : on affiche
    // la confirmation dans l'onglet visible (chaque onglet a son propre `configInfo*`).
    const info = $('#sub-config').classList.contains('active') ? $('#configInfoGeneral')
      : $('#sub-mr').classList.contains('active') ? $('#configInfoMr')
      : $('#sub-verifiers').classList.contains('active') ? $('#configInfoVerif')
      : $('#sub-gitcfg').classList.contains('active') ? $('#configInfoGit')
      : $('#sub-jiracfg').classList.contains('active') ? $('#configInfoJira')
      : $('#sub-aisession').classList.contains('active') ? $('#configInfoAi')
      : $('#sub-dictation').classList.contains('active') ? $('#configInfoDictation')
      : $('#configInfo');
    /* Ce qui vient de partir est la nouvelle référence : le rechargement qui suit peut s'abstenir
       (frappe en cours), et remettre ensuite un champ à sa valeur d'avant ne partirait pas. */
    configReference = complet;
    marquerConfig(false);   // avant la mention : elle porterait sinon la classe « non enregistré »
    f.dispatchEvent(new Event('mergerie:config-saved'));   // « Enregistrer et tester » enchaîne
    info.textContent = tr('ui.saved'); setTimeout(() => { info.textContent = ''; }, 2000);
    loadConfig(); refreshStatus();
    /* L'ASSISTANT DE DÉMARRAGE SUIT. Il coche ses étapes depuis `setupState`, qui n'était lu
       qu'au chargement de la page : on connectait la forge, on revenait sur Reviews, et
       l'étape 1 était toujours à faire. Trois boutons sans progression ne sont pas un
       assistant. */
    rafraichirDemarrage();
    /* Le micro vit hors d'app.js et lit son état une fois : sans ce rappel, activer la
       dictée n'aurait fait apparaître le bouton qu'au rechargement de la page. Le verdict du
       dernier test, lui, est PÉRIMÉ dès qu'un champ change — il parlait d'une autre
       configuration. */
    if (window.mergerieDictation) window.mergerieDictation.relireStatut();
    marquerDictationPerime();
  } catch (err) { toast(err.message, true); }
});

/* Section Réglages → Notifications : reflète l'état de la permission navigateur
   (le piège classique de cette API étant un refus silencieux) et les préférences
   par type. Tout est local (localStorage) — aucun aller-retour serveur. */
function renderNotifSettings() {
  const p = notifPrefs();
  $$('#sub-notif [data-notif]').forEach((cb) => { cb.checked = !!p[cb.dataset.notif]; });
  const th = $('#notifThreshold'); if (th) th.value = p.threshold;
  const status = $('#notifPermStatus');
  const reqBtn = $('#notifRequest');
  const perm = notifPermission();
  const map = { granted: 'settings.notif.perm-granted', denied: 'settings.notif.perm-denied', default: 'settings.notif.perm-default', unsupported: 'settings.notif.perm-unsupported' };
  if (status) status.textContent = tr(map[perm] || map.default);
  if (status) status.className = 'notif-status notif-' + perm;
  if (reqBtn) reqBtn.hidden = perm !== 'default';
}
$$('#sub-notif [data-notif]').forEach((cb) => cb.addEventListener('change', () => {
  const p = notifPrefs(); p[cb.dataset.notif] = cb.checked; setNotifPrefs(p); updateMuteBtn();
}));
{
  const th = $('#notifThreshold');
  if (th) th.addEventListener('change', () => { const p = notifPrefs(); const v = Number(th.value); p.threshold = Number.isFinite(v) ? v : NOTIF_DEFAULTS.threshold; setNotifPrefs(p); });
}
$('#notifRequest') && $('#notifRequest').addEventListener('click', async () => {
  if (!notifSupported()) return;
  try { await Notification.requestPermission(); } catch { /* refus */ }
  renderNotifSettings();
});
$('#notifTest') && $('#notifTest').addEventListener('click', async () => {
  if (!notifSupported()) { toast(tr('settings.notif.perm-unsupported'), true); return; }
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* refus */ } renderNotifSettings(); }
  if (Notification.permission !== 'granted') { toast(tr('settings.notif.test-blocked'), true); return; }
  showNotif(tr('settings.notif.test-title'), tr('settings.notif.test-body'));
});


// Badge de forge : deux dépôts homonymes sur GitLab et GitHub doivent se distinguer.
function forgeBadge(forge) {
  const f = forge === 'github' ? 'github' : 'gitlab';
  return `<svg class="ico forge-ico" title="${tr(`repo.forge.${f}`)}"><use href="#i-${f}"/></svg> `;
}

/* Re-cloner : geste destructeur pour ce qui n'a pas été poussé, donc confirmation explicite
   qui le DIT. Le serveur ne touche qu'au répertoire de clonage qu'il calcule lui-même. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-reclone]');
  if (!b) return;
  if (!await confirmDialog({
    title: tr('settings.repo.reclone'),
    text: tr('settings.repo.reclone.confirm', { project: b.dataset.project }),
    confirmLabel: tr('settings.repo.reclone'),
  })) return;
  try {
    await busy(b, () => api(`/repos/${b.dataset.reclone}/reclone`, { method: 'POST' }));
    toast(tr('settings.repo.reclone.done', { project: b.dataset.project }));
    loadRepos();
  } catch (err) { toast(explainError(err.message), true); }
});

