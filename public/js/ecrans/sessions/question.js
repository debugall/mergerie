'use strict';
/* Question libre. */
// @expose hideBtn
/* ---------- Question libre ----------
   La quatrième saveur de Dev IA : une question posée à l'IA sans dépôt ni dossier, et sa
   réponse gardée. La carte est celle d'une exploration débarrassée de ses projets — il n'y a
   ni liste de cibles, ni repli, ni relance ciblée : une question n'a qu'une réponse. */
function askCard(q) {
  const st = TASK_STATUS[q.status] || { label: q.status, cls: '' };
  const enCours = q.status === 'running';
  const canRun = !enCours;
  return `<div class="card task-row${q.hidden ? ' is-hidden' : ''}" data-ask="${q.id}">
    <div style="min-width:0;flex:1">
      <div class="title">
        <span class="tag ${st.cls}">${st.label}</span>${shareMark(q)}
        <span class="task-date" title="${tr('task.created-at')}" data-when="${esc(q.created_at || '')}">${esc(fmtDateTime(q.created_at))}</span>
      </div>
      ${libelleBlock(q, 'ask')}
      ${promptBlock(q.prompt)}
      ${chapeauCarte(q)}
      ${coutCarte(q)}${badgeTodoAttente(q)}
      ${suiviBlock(q, 'q')}
      <div class="mr-create followup" data-qfollowform="${q.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('ask.followup.ph'))}">${esc(q.followup_draft || '')}</textarea>
        ${suiviCapturesHtml()}
        ${autoSuiviCase(q, true)}
        <button class="btn" data-qfollowcancel="${q.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-qfollowsave="${q.id}">${tr('task.btn.save-followup')}</button>
        ${enCours ? '' : `<button class="btn btn-primary" data-qfollowsubmit="${q.id}">${tr('task.btn.ask')}</button>`}
      </div>
    </div>
    ${taskActions([
    q.md_path ? `<button class="btn btn-primary" data-qmd="${q.id}" title="${esc(tr('ask.title.view-answer'))}"><svg class="ico"><use href="#i-doc"/></svg>${tr('task.btn.view-answer')}</button>` : '',
    canRun ? `<button class="btn" data-qrun="${q.id}" title="${esc(tr(q.status === 'new' ? 'ask.title.run' : 'ask.title.rerun'))}"><svg class="ico"><use href="#i-play"/></svg>${q.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    /* Une question de suivi n'a de sens qu'une fois la première réponse obtenue — ou pendant
       qu'elle se prépare, comme partout ailleurs : la remarque vient en lisant, pas après. */
    (q.md_path || enCours) ? followBtn(q, 'qfollow', 'ask.followup.title', 'task.btn.follow-up') : '',
    /* B18 — UNE RÉPONSE MÈNE À UN GESTE. Une exploration peut devenir un codage depuis sa
       carte ; une question libre, non — alors que c'est le même enchaînement : on demande, on
       comprend, on fait faire. La question et sa réponse partent dans la demande, comme pour
       une exploration ; les dépôts, eux, restent à choisir — une question n'en a pas. */
    q.md_path ? `<button class="btn" data-qcode="${q.id}" title="${esc(tr('ask.to-code-title'))}">${svgIco('bot')}${esc(tr('ask.to-code'))}</button>` : '',
    resumeCmdBtn(q.resume_cmd),
  ], [
    `<button class="btn btn-icon btn-sm" data-qedit="${q.id}" title="${esc(tr('ask.edit-title'))}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    shareBtn('ask', q),
    hideBtn('ask', q),
    estAMoi(q) ? `<button class="btn btn-icon btn-sm btn-danger" data-qdel="${q.id}" title="${esc(tr('ask.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button>` : '',
  ])}
    ${q.last_error ? errorBox(q.last_error, null, null, null, q.id) : ''}
  </div>`;
}

function renderQuestions() {
  const el = $('#askList');
  const ouverts = captureTaskForms('#askList');
  const texte = taskQuery();
  const visible = questions.filter(taskVisible);
  reportHiddenCount(questions.length - visible.length);
  const shown = visible.filter((q) => taskMatches(q, texte));
  if (!shown.length && texte) {
    el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(texte) })}</p>`;
    return;
  }
  if (!questions.length) {
    el.innerHTML = emptyState({ icon: 'search', title: tr('ask.empty.title'), text: tr('ask.empty.text'),
      actions: [{ act: 'new-task', label: tr('task.kind.ask.btn'), primary: true }] });
    return;
  }
  el.innerHTML = shown.map(askCard).join('');
  restoreTaskForms(ouverts, '#askList');
  stagger('#askList .card');
  wirePromptToggles('#askList');

  const sur = (sel, fn) => $$(`#askList ${sel}`).forEach((b) => b.addEventListener('click', () => fn(b)));
  sur('[data-qmd]', (b) => openPasses(`/questions/${b.dataset.qmd}`));
  sur('[data-qrun]', async (b) => {
    const q = questions.find((x) => String(x.id) === b.dataset.qrun);
    if (!await confirmerRelance(q && q.status !== 'new')) return;
    busy(b, () => api(`/questions/${b.dataset.qrun}/run`, { method: 'POST' }))
      .then(() => { toast(tr('ask.started')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });
  sur('[data-qedit]', (b) => openQuestionEdit(Number(b.dataset.qedit)).catch((e) => toast(explainError(e.message), true)));
  sur('[data-qdel]', async (b) => {
    if (!await confirmDialog({ text: tr('ask.confirm-delete'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/questions/${b.dataset.qdel}`, { method: 'DELETE' }); toast(tr('ask.deleted')); loadTasks(); }
    catch (e) { toast(explainError(e.message), true); }
  });

  /* Suivi : les mêmes quatre gestes que partout ailleurs (préparer, enregistrer, supprimer,
     envoyer), avec les helpers communs — seule la route change. */
  const form = (id) => $(`#askList .followup[data-qfollowform="${id}"]`);
  const deplier = (id) => { const fm = form(id); if (fm) { fm.hidden = false; fm.querySelector('.followup-text').focus(); } };
  sur('[data-qfollow]', (b) => deplier(b.dataset.qfollow));
  sur('[data-qfollowedit]', (b) => deplier(b.dataset.qfollowedit));
  sur('[data-qfollowcancel]', (b) => { const fm = form(b.dataset.qfollowcancel); if (fm) fm.hidden = true; });
  sur('[data-qfollowsubmit]', async (b) => {
    const fm = b.closest('.followup');
    const champ = fm.querySelector('.followup-text');
    const instruction = champ.value.trim();
    if (!instruction) return;
    const cle = cleFormSuivi(fm);
    const pieces = suiviImages.get(cle) || [];
    try {
      await busy(b, () => api(`/questions/${b.dataset.qfollowsubmit}/followup`, {
        method: 'POST', body: { instruction, ...(pieces.length ? { files: pieces } : {}) },
      }));
      suiviImages.delete(cle);
      champ.value = '';
      fm.hidden = true;
      toast(tr('ask.started')); refreshStatus(); loadTasks();
    } catch (e) { toast(explainError(e.message), true); }
  });
  sur('[data-qfollowsave]', (b) => enregistrerSuivi(b, `/questions/${b.dataset.qfollowsave}/followup-draft`));
  sur('[data-qfollowdrop]', (b) => supprimerSuivi(b, `/questions/${b.dataset.qfollowdrop}/followup-draft`));
  sur('[data-qfollowsend]', (b) => envoyerSuivi(b, `/questions/${b.dataset.qfollowsend}/followup`));
}


/* Colonne d'actions d'une carte Dev IA, en deux familles : ce qu'on fait avec le TRAVAIL
   (lancer, converger, demander une correction) au-dessus, ce qu'on fait avec la FICHE
   (modifier, supprimer) en dessous. Mélangées dans une seule pile, la suppression se
   retrouvait tantôt sous « Converger », tantôt sous « Lancer » selon le sous-onglet.
   L'ordre des emplacements est le même partout ; ceux qui ne s'appliquent pas sont omis. */
/* Prompt d'une session dans la liste. Il était coupé à 220 caractères, ce qui suffit à perdre
   l'essentiel d'une consigne un peu longue — et rien ne permettait de lire la suite sans
   ouvrir la session. Le texte COMPLET est désormais dans le DOM, replié sur trois lignes par
   CSS ; « Voir plus » le déplie sur place. Le bouton n'est révélé qu'après mesure (voir
   wirePromptToggles) : un prompt de deux lignes n'a rien à déplier. */
function promptBlock(prompt) {
  const txt = String(prompt || '');
  if (!txt.trim()) return '';
  return `<div class="task-prompt-wrap">
      <div class="task-prompt clamped">${esc(txt)}</div>
      <button type="button" class="prompt-more" hidden>${tr('task.prompt.more')}</button>
    </div>`;
}

/* Révèle « Voir plus » sur les seuls prompts réellement tronqués. Toutes les LECTURES de
   mise en page d'abord, toutes les ÉCRITURES ensuite : intercalées, elles forceraient un
   recalcul par carte. */
function wirePromptToggles(root) {
  const wraps = $$(`${root} .task-prompt-wrap`);
  const overflowing = wraps.filter((w) => {
    const p = w.querySelector('.task-prompt');
    return p.scrollHeight > p.clientHeight + 2;
  });
  for (const w of overflowing) w.querySelector('.prompt-more').hidden = false;
  for (const w of wraps) {
    const btn = w.querySelector('.prompt-more');
    btn.addEventListener('click', () => {
      const p = w.querySelector('.task-prompt');
      const open = p.classList.toggle('clamped');   // `clamped` présent = replié
      btn.textContent = open ? tr('task.prompt.more') : tr('task.prompt.less');
    });
  }
}

/* Bouton « ranger / ressortir » : il vit avec les actions sur la FICHE, pas sur le travail.
   `scope` distingue la session sur dépôt du codage hors dépôt — deux tables, deux routes. */
function hideBtn(scope, t) {
  const on = t.hidden ? 1 : 0;
  return `<button class="btn btn-icon btn-sm" data-hide="${t.id}" data-scope="${scope}" data-on="${on}"`
    + ` title="${esc(tr(on ? 'task.hidden.unhide-title' : 'task.hidden.hide-title'))}">`
    + `<svg class="ico"><use href="#i-${on ? 'eye' : 'eye-off'}"/></svg></button>`;
}

