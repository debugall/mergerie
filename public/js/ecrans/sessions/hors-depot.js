'use strict';
/* Codage hors dépôt (projets d'un répertoire local, sans git). */
/* ---------- Codage hors dépôt (projets d'un répertoire local, sans git) ----------
   Le dossier de travail n'est plus SAISI mais CHOISI : un répertoire local, puis un
   projet parmi les siens. Le chemin absolu en découle — un chemin tapé à la main est
   une faute de frappe silencieuse, découverte au milieu du traitement. */
function renderLocalRootPicker() {
  const box = $('#localRootBox');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('local.no-root'))}</span>`; return; }
  const cur = localRoots.find((r) => String(r.id) === String(localRootId)) || localRoots[0];
  localRootId = String(cur.id);
  box.innerHTML = comboHtml('local-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'local-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.local-root', box).addEventListener('change', (e) => {
    // Les projets sélectionnés appartenaient à l'autre répertoire : on repart à vide.
    localRootId = e.target.value; localPicks = [''];
    renderLocalDirRows();
  });
}

// Éditeur de projets de la modale (lignes ajoutables). Re-rendu à chaque ajout/retrait.
function renderLocalDirRows() {
  const box = $('#taskLocalDirRows');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<p class="muted">${esc(tr('local.no-root'))}</p>`; return; }
  box.innerHTML = localPicks.map((name, i) => `<div class="local-dir-row" data-row="${i}">`
    + comboHtml('local-project', { value: name, label: name, ph: tr('local.dir-ph'), wrapClass: 'local-dir' })
    + `<button type="button" class="btn btn-icon btn-sm btn-danger" data-rmdir="${i}" title="${esc(tr('local.remove-dir'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>`).join('');
  // Ici on propose TOUS les sous-dossiers, git ou non : l'IA code en place, un dossier
  // sans dépôt est un cas d'usage normal de cet écran. La branche n'est qu'un repère.
  wireCombo(box, 'local-project', async () => (await localProjectsOf(localRootId))
    .map((p) => ({ value: p.name, label: p.name, hint: p.git && p.branch ? `· ${p.branch}` : '' })));
  $$('.local-project', box).forEach((h) => h.addEventListener('change', () => {
    localPicks[Number(h.closest('[data-row]').dataset.row)] = h.value;
  }));
  $$('[data-rmdir]', box).forEach((b) => b.addEventListener('click', () => {
    localPicks.splice(Number(b.dataset.rmdir), 1);
    if (!localPicks.length) localPicks = [''];
    renderLocalDirRows();
  }));
}
$('#taskLocalAddDir') && $('#taskLocalAddDir').addEventListener('click', () => {
  localPicks.push(''); renderLocalDirRows();
});

function localDirLine(d, t) {
  const st = TASK_STATUS[d.status] || { label: d.status, cls: '' };
  return `<div class="target-line"><span class="tag ${st.cls}">${st.label}</span>`
    + `<code class="local-dir-path">${esc(d.path)}</code>`
    + `${d.last_error ? `<span class="muted" title="${esc(d.last_error)}">${svgIco('alert')}</span>` : ''}`
    + `<span class="spacer"></span>`
    /* RELANCER CE DOSSIER-LÀ. Les dossiers d'une session sont indépendants : refaire les
       quatre qui ont réussi pour rattraper le cinquième coûte quatre passes d'agent. Pas
       proposé pendant que ça tourne, ni sur un dossier qui attend une réponse. */
    + `${['new', 'done', 'error'].includes(d.status) && t
      ? `<button class="btn btn-sm" data-ldrun="${d.id}" data-ltask="${t.id}" title="${esc(tr('local.title.run-dir'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${tr('task.btn.run-target')}</button>` : ''}`
    // Retour de l'agent : la seule fenêtre sur son travail quand le dossier n'a pas bougé.
    + `${d.has_output ? `<button class="btn btn-sm" data-ldout="${d.id}" data-ltask="${d.task_id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : ''}`
    + `${resumeCmdBtn(d.resume_cmd)}</div>`
    /* Hors dépôt, CHAQUE DOSSIER a sa session d'agent : ses questions sont les siennes, et
       la réponse ne repart que dans celui-là. Un formulaire par dossier, donc. */
    + `${d.status === 'needs_input' && d.questions && d.questions.length && t
      ? questionsForm(t, d, `/local-tasks/${t.id}/dirs/${d.id}/answer`) : ''}`;
}

function localCard(t) {
  const st = TASK_STATUS[t.status] || { label: t.status, cls: '' };
  const canRun = ['new', 'error', 'done'].includes(t.status);
  // Une correction n'a de sens que sur un dossier DÉJÀ traité : sinon il n'y a rien à corriger.
  /* … ou sur une session QUI TOURNE : là on ne corrige pas, on prépare. La remarque se voit
     pendant le travail, pas vingt minutes après. */
  const enCours = t.status === 'running';
  const canFollow = enCours || (canRun && (t.dirs || []).some((d) => d.status === 'done'));
  const n = (t.dirs || []).length;
  return `<div class="card task-row${t.hidden ? ' is-hidden' : ''}" data-local="${t.id}">
    <div style="min-width:0;flex:1">
      <div class="title">
        <span class="tag ${st.cls}">${st.label}</span>
        <span class="task-projects">${tr('local.dirs-count', { n, count: n })}</span>${badgeProgrammation(t, 'l')}${shareMark(t)}
        <span class="task-date" title="${tr('task.created-at')}" data-when="${esc(t.created_at || '')}">${esc(fmtDateTime(t.created_at))}</span>
      </div>
      ${libelleBlock(t, 'local')}
      ${promptBlock(t.prompt)}
      ${chapeauCarte(t)}
      ${coutCarte(t)}${badgeTodoAttente(t)}
      ${toggleProjetsHtml('local', t.id, n)}
      <div class="targets"${projetsVisibles('local', t.id, n) ? '' : ' hidden'}>${(t.dirs || []).map((d) => localDirLine(d, t)).join('')}</div>
      ${suiviBlock(t, 'l')}
      <div class="mr-create followup" data-lfollowform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('local.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
        ${suiviCapturesHtml()}
        ${autoSuiviCase(t)}
        <button class="btn" data-lfollowcancel="${t.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-lfollowsave="${t.id}">${tr('task.btn.save-followup')}</button>
        ${enCours ? '' : `<button class="btn btn-primary" data-lfollowsubmit="${t.id}">${tr('task.btn.run-iteration')}</button>`}
      </div>
    </div>
    ${taskActions([
    canRun ? `<button class="btn" data-lrun="${t.id}" title="${esc(tr('local.run-title'))}"><svg class="ico"><use href="#i-play"/></svg>${t.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    /* Ne refaire QUE ce qui a cassé — le geste d'après un échec partiel. Proposé seulement
       s'il y a de quoi : un bouton qui relancerait zéro dossier n'apprend rien. */
    canRun && (t.dirs || []).some((d) => d.status === 'error')
      ? `<button class="btn" data-lrunfailed="${t.id}" title="${esc(tr('local.title.run-failed'))}"><svg class="ico"><use href="#i-repeat"/></svg>${tr('task.btn.rerun-failed')}</button>` : '',
    /* Le retour de l'agent au niveau de la SESSION : les boutons par dossier existent aussi,
       mais ils vivent dans la liste repliée — et c'est « qu'a fait l'IA ? » qu'on se demande
       en regardant la carte, pas « qu'a-t-elle fait dans ce dossier-là ». */
    (t.dirs || []).some((d) => d.has_output)
      ? `<button class="btn" data-lout="${t.id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : '',
    canFollow ? followBtn(t, 'lfollow', 'local.followup.title') : '',
  ], [
    `<button class="btn btn-icon btn-sm" data-ledit="${t.id}" title="${esc(tr('local.edit-title'))}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    `<button class="btn btn-icon btn-sm" data-lcopy="${t.id}" title="${esc(tr('local.title.duplicate'))}"><svg class="ico"><use href="#i-copy"/></svg></button>`,
    shareBtn('local', t),
    hideBtn('local', t),
    estAMoi(t) ? `<button class="btn btn-icon btn-sm btn-danger" data-ldel="${t.id}" title="${esc(tr('local.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button>` : '',
  ])}
    ${t.last_error ? errorBox(t.last_error, null, null, t.id) : ''}
  </div>`;
}

function renderLocalTasks() {
  const el = $('#localList');
  const ouverts = captureTaskForms('#localList');
  const q = taskQuery();
  const visible = localTasks.filter(taskVisible);
  reportHiddenCount(localTasks.length - visible.length);
  const shown = visible.filter((t) => taskMatches(t, q, (t.dirs || []).map((d) => d.path)));
  if (!shown.length && q) {
    el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(q) })}</p>`;
    return;
  }
  if (!localTasks.length) {
    el.innerHTML = emptyState({ icon: 'bot', title: tr('local.empty.title'), text: tr('local.empty.text'),
      actions: [{ act: 'new-task', label: tr('task.kind.local.btn'), primary: true }] });
    return;
  }
  el.innerHTML = shown.map(localCard).join('');
  restoreTaskForms(ouverts, '#localList');
  stagger('#localList .card');
  wirePromptToggles('#localList');
  /* Le codage hors dépôt a sa propre liste : `wireTaskActions` ne porte que sur `#taskList`,
     le repli doit donc être câblé ici aussi. */
  $$('#localList [data-tfold]').forEach((b) => b.addEventListener('click', () => basculerProjets(b.dataset.tfold)));
  $$('#localList [data-lrun]').forEach((b) => b.addEventListener('click', async () => {
    const t2 = localTasks.find((x) => String(x.id) === b.dataset.lrun);
    if (!await confirmerRelance(t2 && t2.status !== 'new')) return;
    busy(b, () => api(`/local-tasks/${b.dataset.lrun}/run`, { method: 'POST' }))
      .then(() => { toast(tr('local.started')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  }));
  /* RELANCE CIBLÉE. Les dossiers d'une session sont indépendants : refaire les quatre qui ont
     réussi pour rattraper le cinquième coûte quatre passes d'agent pour rien. Même
     confirmation que la relance complète — une relance est une relance. */
  $$('#localList [data-ldrun]').forEach((b) => b.addEventListener('click', async () => {
    const t2 = localTasks.find((x) => String(x.id) === b.dataset.ltask);
    const d = ((t2 && t2.dirs) || []).find((x) => String(x.id) === b.dataset.ldrun);
    if (!await confirmerRelance(d && d.status !== 'new')) return;
    busy(b, () => api(`/local-tasks/${b.dataset.ltask}/run`, { method: 'POST', body: { dirs: [Number(b.dataset.ldrun)] } }))
      .then(() => { toast(tr('local.started')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  }));
  $$('#localList [data-lrunfailed]').forEach((b) => b.addEventListener('click', async () => {
    const t2 = localTasks.find((x) => String(x.id) === b.dataset.lrunfailed);
    const dirs = ((t2 && t2.dirs) || []).filter((d) => d.status === 'error').map((d) => d.id);
    if (!dirs.length || !await confirmerRelance(true)) return;
    busy(b, () => api(`/local-tasks/${b.dataset.lrunfailed}/run`, { method: 'POST', body: { dirs } }))
      .then(() => { toast(tr('local.started')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  }));
  $$('#localList [data-ldout]').forEach((b) => b.addEventListener('click',
    () => openLocalDirOutput(b.dataset.ltask, b.dataset.ldout)));
  // Depuis la carte : on ouvre le premier dossier ayant un retour, les autres sont au sélecteur.
  $$('#localList [data-lout]').forEach((b) => b.addEventListener('click', () => {
    const t = localTasks.find((x) => String(x.id) === b.dataset.lout);
    const premier = ((t && t.dirs) || []).find((d) => d.output_path);
    if (premier) openLocalDirOutput(b.dataset.lout, premier.id);
  }));
  // Itération sur la MÊME session : le formulaire se déplie sous les dossiers.
  $$('#localList [data-lfollow]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollow}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  }));
  $$('#localList [data-lfollowcancel]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollowcancel}"]`);
    if (form) form.hidden = true;
  }));
  $$('#localList [data-lfollowsubmit]').forEach((b) => b.addEventListener('click', async () => {
    const form = b.closest('.followup');
    const field = form.querySelector('.followup-text');
    const instruction = field.value.trim();
    if (!instruction) return;
    const cle = cleFormSuivi(form);
    const images = suiviImages.get(cle) || [];
    try {
      await busy(b, () => api(`/local-tasks/${b.dataset.lfollowsubmit}/followup`, {
        method: 'POST', body: { instruction, ...(images.length ? { files: images } : {}) },
      }));
      suiviImages.delete(cle);
      field.value = '';
      form.hidden = true;
      toast(tr('local.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  // Suivi préparé pendant que la session tourne : enregistré ici, envoyé plus tard, par nous.
  $$('#localList [data-lfollowsave]').forEach((b) => b.addEventListener('click',
    () => enregistrerSuivi(b, `/local-tasks/${b.dataset.lfollowsave}/followup-draft`)));
  $$('#localList [data-lunschedule]').forEach((b) => b.addEventListener('click',
    () => annulerProgrammation(b, `/local-tasks/${b.dataset.lunschedule}/schedule`)));
  $$('#localList [data-lfollowedit]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollowedit}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  }));
  $$('#localList [data-lfollowdrop]').forEach((b) => b.addEventListener('click',
    () => supprimerSuivi(b, `/local-tasks/${b.dataset.lfollowdrop}/followup-draft`)));
  $$('#localList [data-lfollowsend]').forEach((b) => b.addEventListener('click',
    () => envoyerSuivi(b, `/local-tasks/${b.dataset.lfollowsend}/followup`)));
  $$('#localList [data-ledit]').forEach((b) => b.addEventListener('click',
    () => openLocalTaskEdit(Number(b.dataset.ledit)).catch((e) => toast(explainError(e.message), true))));
  $$('#localList [data-lcopy]').forEach((b) => b.addEventListener('click',
    () => dupliquerLocalTask(Number(b.dataset.lcopy)).catch((e) => toast(explainError(e.message), true))));
  $$('#localList [data-ldel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('local.confirm-delete'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/local-tasks/${b.dataset.ldel}`, { method: 'DELETE' }); toast(tr('local.deleted')); loadTasks(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
}


