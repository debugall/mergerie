'use strict';
/* La carte d'une session : partager, qui a partagé, A22 renommer, reprendre le rapport. */
// @expose auteurPartage, estDeplie, partageEtMoi
/* PARTAGER OU NON CETTE SESSION, depuis sa carte. Le bouton n'apparaît qu'en mode partagé et
   qu'à son AUTEUR : la session d'un collègue se range, elle ne se retire pas du dépôt.
   `partageEtMoi` est rempli une fois par `partageActif()` ; tant qu'il ne l'est pas, on ne rend
   rien plutôt que de faire clignoter un bouton qui disparaîtrait. */
let partageEtMoi = null;
function shareBtn(scope, t) {
  if (!partageEtMoi || !partageEtMoi.partage) return '';
  if (t.author && partageEtMoi.name && t.author !== partageEtMoi.name) return '';
  const on = t.shared ? 1 : 0;
  return `<button class="btn btn-icon btn-sm${on ? ' active' : ''}" data-share="${t.id}" data-scope="${scope}" data-on="${on}"`
    + ` title="${esc(tr(on ? 'session.unshare' : 'session.share'))}">`
    + `<svg class="ico"><use href="#i-users"/></svg></button>`;
}
/* QUI A PARTAGÉ. Tout objet qu'on a choisi de partager (session, question, page, todo) dit par
   qui : l'auteur est celui qui a commité son fichier, donc connu dès la première synchro. Avant
   elle, l'objet n'est parti de nulle part ailleurs que d'ici : c'est « moi ». */
function texteAuteurPartage(o) {
  if (!o || !(o.shared || o.author)) return '';
  const moi = partageEtMoi && partageEtMoi.name;
  return o.author && o.author !== moi ? tr('shared.by', { who: o.author }) : tr('shared.by-me');
}
const auteurPartage = (o) => {
  const txt = texteAuteurPartage(o);
  return txt ? ` <span class="auteur-partage muted">${esc(txt)}</span>` : '';
};
/* …et le pictogramme qui dit, sans cliquer, que cette session est chez tout le monde. */
const shareMark = (t) => (t.shared
  ? ` <span class="note-partagee" title="${esc(tr('session.shared-mark'))}">${svgIco('users')}</span>` : '');
/* La session d'un collègue ne se supprime pas : on la range. Le serveur refuse de toute façon
   (403), mais proposer un bouton qui refuse est une promesse qu'on ne tient pas. */
const estAMoi = (t) => !t.author || !partageEtMoi || !partageEtMoi.name || t.author === partageEtMoi.name;

function taskActions(work, meta) {
  const w = work.filter(Boolean).join('');
  const m = meta.filter(Boolean).join('');
  return `<div class="task-actions">${w ? `<div class="ta-work">${w}</div>` : ''}${m ? `<div class="ta-meta">${m}</div>` : ''}</div>`;
}

// En-tête commun : statut, date de création, prompt.
/* Le libellé passe AVANT le prompt et le domine visuellement : c'est lui qu'on parcourt des
   yeux. Le prompt reste dessous — il dit ce qu'il faut faire, le libellé dit de quoi il s'agit. */
/* A22 — LE LIBELLÉ SE RENOMME SUR PLACE. Il fallait ouvrir la modale d'édition entière —
   prompt, dépôts, branches, cases — pour corriger trois mots d'un nom de session. Même geste
   que le nom d'une itération : Entrée valide, Échap renonce, le champ remplace le texte.
   Une session SANS libellé porte le bouton quand même : c'est là qu'on lui en donne un. */
const libelleBlock = (t, scope = 'task') => `<div class="task-label${t.label ? '' : ' muted'}">`
  + `<span class="task-label-txt">${esc(t.label || tr('task.label.none'))}</span>`
  + `<button type="button" class="task-label-edit" data-label-edit="${t.id}" data-label-scope="${esc(scope)}"`
  + ` title="${esc(tr('task.label.rename'))}">${svgIco('edit')}</button></div>`;

/* Le renommage, pour les trois saveurs qui ont un libellé (session, hors dépôt, question) :
   chacune a sa route, mais le geste est le même — d'où une seule fonction. */
const ROUTE_LIBELLE = { task: (id) => `/tasks/${id}`, local: (id) => `/local-tasks/${id}`, ask: (id) => `/questions/${id}` };
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-label-edit]');
  if (!b) return;
  const bloc = b.closest('.task-label');
  if (bloc.querySelector('input')) return;
  const txt = bloc.querySelector('.task-label-txt');
  const actuel = bloc.classList.contains('muted') ? '' : txt.textContent;
  const champ = document.createElement('input');
  champ.className = 'task-label-input';
  champ.value = actuel;
  champ.maxLength = 120;
  champ.placeholder = tr('task.ph.label');
  txt.hidden = true;
  bloc.insertBefore(champ, b);
  champ.focus(); champ.select();

  let fini = false;
  const finir = async (garder) => {
    if (fini) return;
    fini = true;
    const valeur = champ.value.trim();
    champ.remove();
    txt.hidden = false;
    if (!garder || valeur === actuel.trim()) return;
    const route = (ROUTE_LIBELLE[b.dataset.labelScope] || ROUTE_LIBELLE.task)(b.dataset.labelEdit);
    try { await api(route, { method: 'PUT', body: { label: valeur } }); loadTasks(); }
    catch (err) { toast(explainError(err.message), true); }
  };
  champ.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finir(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finir(false); }
  });
  champ.addEventListener('blur', () => finir(true));
});

function taskHead(t) {
  const st = TASK_STATUS[t.status] || { label: t.status, cls: '' };
  const nb = (t.targets || []).length;
  return `<div class="title">
      <span class="tag ${st.cls}">${st.label}</span>
      <span class="task-projects">${tr('task.projects', { n: nb, count: nb })}</span>
      ${t.agent_name ? `<span class="tag tag-agent" title="${esc(tr('agents.card.ran-by'))}">${svgIco('zap')} ${esc(t.agent_name)}</span>` : ''}
      ${t.triggered_by === 'schedule' ? `<span class="tag" title="${esc(tr('agents.card.by-schedule'))}">${svgIco('clock')}</span>` : ''}
      ${badgeProgrammation(t, '')}
      ${/* Chez tout le monde, ou à soi : la question se pose d'un coup d'œil, comme pour une
            page de notes. Le pictogramme est le même — c'est le même geste. */''}
      ${shareMark(t)}
      ${t.auto_push && t.kind !== 'explore' ? '<span class="tag">auto-push</span>' : ''}
      <span class="task-date" title="${tr('task.created-at')}" data-when="${esc(t.created_at || '')}">${esc(fmtDateTime(t.created_at))}</span>
    </div>
    ${libelleBlock(t)}
    ${promptBlock(t.prompt)}
    ${chapeauCarte(t)}
    ${coutCarte(t)}${badgeTodoAttente(t)}`;
}

/* Repli de la liste de projets, PARTAGÉ par les trois familles de sessions (codage,
   exploration, codage hors dépôt).
 *
 * On mémorise les sessions DÉPLIÉES, pas les repliées : le repli est l'état par défaut, et
 * au-delà de quelques dépôts une seule session occupe sinon tout l'écran — on ne voit plus
 * les autres, qui sont pourtant ce qu'on est venu regarder.
 *
 * La clé est PRÉFIXÉE par la famille : `task` et `local_task` sont deux tables, un « 3 » de
 * chacune se confondrait. (L'ancien stockage ne contenait que des identifiants de codage,
 * sans préfixe et avec la convention inverse : il n'est pas repris, le repli se refait d'un
 * clic.)
 *
 * En stockage local, parce que le rendu se refait à chaque rafraîchissement : un état vivant
 * seulement dans le DOM serait perdu toutes les secondes et demie pendant un job. */
const projetsDeplies = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('aidevtools_projets_deplies') || '[]').map(String)); }
  catch { return new Set(); }
})();
const cleRepli = (famille, id) => `${famille}:${id}`;
const estDeplie = (famille, id) => projetsDeplies.has(cleRepli(famille, id));

function basculerProjets(cle) {
  if (projetsDeplies.has(cle)) projetsDeplies.delete(cle); else projetsDeplies.add(cle);
  try { localStorage.setItem('aidevtools_projets_deplies', JSON.stringify([...projetsDeplies])); }
  catch { /* stockage indisponible : le repli reste valable pour cette page */ }
  renderTasks();
}

/* Le bouton de repli. Rien du tout en dessous de deux projets : il n'y aurait rien à replier,
   et une ligne d'interface qui ne sert jamais est une ligne de trop. */
function toggleProjetsHtml(famille, id, n) {
  if (n <= 1) return '';
  const deplie = estDeplie(famille, id);
  // Le codage hors dépôt manipule des DOSSIERS, pas des projets : le libellé le dit.
  const cle = famille === 'local' ? 'local.toggle' : 'task.toggle';
  return `<button class="targets-toggle" data-tfold="${cleRepli(famille, id)}" aria-expanded="${deplie}">
    <svg class="ico ico-sm"><use href="#i-right"/></svg>
    ${deplie ? tr(`${cle}.collapse`) : tr(`${cle}.expand`, { n, count: n })}
  </button>`;
}

// Les projets sont-ils visibles ? Dépliés explicitement, ou seuls (rien à replier).
const projetsVisibles = (famille, id, n) => n <= 1 || estDeplie(famille, id);

/* REPRENDRE LE RAPPORT DE REVIEW DANS UN SUIVI.
 *
 * Le trajet naturel après une review : la MR a un rapport, on veut que l'IA en traite les
 * constats. Le bouton « Faire corriger le code par l'IA » du rapport ouvre pour cela une
 * NOUVELLE session ; depuis la session qui a produit la branche, on veut au contraire un SUIVI
 * — l'agent reprend son propre fil au lieu de redécouvrir le code. Le bouton ne fait donc que
 * remplir le champ : ce qui part reste relu, et modifiable, avant d'être envoyé. */
const aUnRapport = (cibles) => (cibles || []).some((tg) => tg.has_review);
/* MÊME GESTE POUR LE RAPPORT DE VÉRIFICATION. La vérification a cassé des tests, et on veut
   que l'agent les répare — mais dans SA session, pas dans une nouvelle. « Corriger (session
   IA) », depuis le rapport, ouvre une session neuve ; ici on remplit un suivi avec le même
   prompt, qui porte les mêmes faits (tests cassés, messages, commits testés). */
const boutonSuiviVerif = (taskId, targetId = null) => `<button class="btn" data-followverif="${taskId}"`
  + (targetId ? ` data-followveriftarget="${targetId}"` : '')
  + ` title="${esc(tr('task.title.followup-verify'))}"><svg class="ico"><use href="#i-check"/></svg>`
  + `${tr('task.btn.followup-verify')}</button>`;
const boutonSuiviReview = (taskId, targetId = null) => `<button class="btn" data-followreview="${taskId}"`
  + (targetId ? ` data-followreviewtarget="${targetId}"` : '')
  + ` title="${esc(tr('task.title.followup-review'))}"><svg class="ico"><use href="#i-bot"/></svg>`
  + `${tr('task.btn.followup-review')}</button>`;

// Carte CODAGE : une ligne par projet, avec ses propres actions.
function codeCard(t) {
  const cibles = t.targets || [];
  const enCours = t.status === 'running';
  const canFollow = enCours || cibles.some((x) => ['committed', 'pushed'].includes(x.status));
  const canRun = ['new', 'error', 'committed', 'pushed'].includes(t.status);
  /* Repli de la liste de projets. Au-delà de quelques dépôts, une session occupe tout l'écran et
     on ne voit plus les autres. L'état est PERSISTÉ : sans ça, il se rouvrirait à chaque
     rafraîchissement automatique, c'est-à-dire toutes les secondes et demie pendant un job. */
  const ouvert = projetsVisibles('code', t.id, cibles.length);
  const aPousser = cibles.filter((x) => x.status === 'committed').length;
  const aOuvrir = cibles.filter((x) => x.status === 'pushed' && !(x.mr_iid || x.existing_mr_iid)).length;
  return `<div class="card task-row${t.hidden ? ' is-hidden' : ''}" data-task="${t.id}">
    <div style="min-width:0;flex:1">
      ${taskHead(t)}
      ${toggleProjetsHtml('code', t.id, cibles.length)}
      <div class="targets"${ouvert ? '' : ' hidden'}>
        ${cibles.map((tg) => targetLine(t, tg)).join('')}
      </div>
      ${suiviBlock(t, '')}
      <div class="mr-create followup" data-followform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('task.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
        ${suiviCapturesHtml()}
        ${autoSuiviCase(t)}
        ${aUnRapport(cibles) ? boutonSuiviReview(t.id) : ''}
        ${(cibles || []).some((tg) => tg.has_verify_fail) ? boutonSuiviVerif(t.id) : ''}
        <button class="btn" data-followcancel="${t.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-followsave="${t.id}">${tr('task.btn.save-followup')}</button>
        ${enCours ? '' : `<button class="btn btn-primary" data-followsubmit="${t.id}">${tr('task.btn.run-iteration')}</button>`}
      </div>
    </div>
    ${taskActions([
    /* LE CHEMIN NORMAL EST LE BOUTON FORT. « Lancer » était en secondaire gris juste au-dessus
       d'un « Converger » violet plein : le chemin avancé pesait plus lourd que celui qu'on
       prend neuf fois sur dix, et le violet était une TROISIÈME couleur d'action dans un
       système qui n'en connaît que deux (accent, destructif). */
    canRun ? `<button class="btn btn-primary" data-trun="${t.id}" title="${t.status === 'new' ? tr('task.title.run-all') : tr('task.title.rerun-all')}"><svg class="ico"><use href="#i-play"/></svg>${t.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    canRun ? `<button class="btn" data-tconverge="${t.id}" data-label="${esc(tr('task.projects', { n: (t.targets || []).length, count: (t.targets || []).length }))}" title="${tr('task.title.converge')}"><svg class="ico"><use href="#i-zap"/></svg>${tr('report.btn.converge')}</button>` : '',
    canFollow ? followBtn(t, 'tfollow', 'task.title.request-fix') : '',
    /* N'apparaît que s'il y a quelque chose à réparer : un projet en erreur dont le travail
       peut très bien être déjà commité. Relancer coûterait un appel IA par dépôt pour refaire
       du travail fait — ce bouton ne fait que relire les branches. */
    aPousser > 1 ? `<button class="btn btn-primary" data-tpushall="${t.id}" title="${esc(tr('task.title.push-all'))}"><svg class="ico"><use href="#i-upload"/></svg>${tr('task.btn.push-all', { n: aPousser, count: aPousser })}</button>` : '',
    aOuvrir > 1 ? `<button class="btn btn-primary" data-tmrall="${t.id}" title="${esc(tr('task.title.mr-all'))}"><svg class="ico"><use href="#i-branch"/></svg>${tr('task.btn.mr-all', { n: aOuvrir, count: aOuvrir })}</button>` : '',
    (t.targets || []).filter((tg) => tg.status === 'error').length > 1
      ? `<button class="btn" data-trunfailed="${t.id}" title="${esc(tr('task.title.rerun-failed'))}"><svg class="ico"><use href="#i-repeat"/></svg>${tr('task.btn.rerun-failed')}</button>` : '',
    /* B1 — TOUS LES PROJETS SONT MERGÉS : la session a fini sa vie. Elle restait en tête de
       la liste, terminée, à côté de celles qui attendent encore quelque chose. « Ranger » est
       le geste qui existe déjà (masquer) — il est simplement PROPOSÉ ici, au moment où il a
       un sens, et rien ne se range tout seul. */
    (!t.hidden && (t.targets || []).length && (t.targets || []).every((tg) => tg.mr_merged))
      ? `<button class="btn" data-hide="${t.id}" data-scope="task" data-on="0" title="${esc(tr('task.title.archive-merged'))}"><svg class="ico"><use href="#i-archive"/></svg>${esc(tr('task.btn.archive-merged'))}</button>` : '',
    (t.targets || []).some((tg) => tg.status === 'error')
      ? `<button class="btn" data-treconcile="${t.id}" title="${esc(tr('task.title.reconcile'))}"><svg class="ico"><use href="#i-branch"/></svg>${tr('task.btn.reconcile')}</button>` : '',
  ], [
    `<button class="btn btn-icon btn-sm" data-tedit="${t.id}" title="${tr('task.title.edit')}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    `<button class="btn btn-icon btn-sm" data-tcopy="${t.id}" title="${esc(tr('task.title.duplicate'))}"><svg class="ico"><use href="#i-copy"/></svg></button>`,
    shareBtn('task', t),
    hideBtn('task', t),
    // La session d'un collègue ne se supprime pas : on la range, et le bouton disparaît.
    estAMoi(t) ? `<button class="btn btn-icon btn-sm btn-danger" data-tdel="${t.id}" title="${tr('task.title.delete')}"><svg class="ico"><use href="#i-close"/></svg></button>` : '',
  ])}
    ${t.last_error ? errorBox(t.last_error, null, t.id) : ''}
  </div>`;
}

// Ligne d'UN projet dans une session de codage : état + actions propres.
// Fil d'étape compact (pips) du parcours d'un projet : créée → commit → push → MR.
// Dérivé de l'état du projet (tg.status) et de l'existence d'une MR — un coup d'œil suffit
// à situer où en est chaque projet d'une session multi-projets, sans lire le libellé.
function targetStepper(tg) {
  const mrIid = tg.mr_iid || tg.existing_mr_iid;
  let done = 1; // « créée » : le projet existe dans la session
  if (['committed', 'pushed'].includes(tg.status) || mrIid) done = 2; // commit
  if (tg.status === 'pushed' || mrIid) done = 3;                       // push
  if (mrIid) done = 4;                                                 // MR
  const labels = [tr('task.step.created'), tr('task.step.commit'), tr('task.step.push'), tr('task.step.mr')];
  const merged = !!tg.mr_merged;
  const pips = labels.map((lb, i) => {
    const cls = i < done ? 'done' : (i === done ? 'current' : '');
    return `<span class="tstep-pip ${cls}" title="${esc(lb)}"></span>`;
  }).join('');
  return `<span class="tstepper${merged ? ' merged' : ''}" aria-label="${esc(labels.slice(0, done).join(' → '))}">${pips}</span>`;
}
