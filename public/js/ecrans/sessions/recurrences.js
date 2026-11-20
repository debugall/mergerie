'use strict';
/* Dev IA → Récurrentes : le bloc « Répéter » de la modale de session, la liste des modèles, leurs
   gestes (▶ maintenant, pause, modifier, supprimer) et « Rendre récurrente » depuis une carte.

   UN MODÈLE, PAS UNE SESSION. Avec « Répéter », la modale ne crée pas de session : elle enregistre
   un modèle, et le serveur (`jobs/recurrences.js`) en fait naître une session neuve à chaque
   échéance. Le formulaire reste celui d'une session — mêmes champs, même validation côté serveur. */

let editingRecurrenceId = null;
/* L'onglet où revenir quand la modale se ferme. Ouvrir la modale pose `taskKind` à la saveur de
   la session (« code », « explore ») : depuis Récurrentes, la fermer ramènerait sinon sur Codage. */
let ongletAuRetour = null;
const JOURS_REPET = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let repetition = { freq: '', jours: [], dom: 1 };

// Le bloc ne vaut que pour une CRÉATION de codage ou d'exploration, ou l'édition d'un modèle.
const repetitionPossible = () => ['code', 'explore'].includes(taskKind) && !editingTaskId;
const repetitionActive = () => repetitionPossible() && (!!repetition.freq || !!editingRecurrenceId);

function specRepetition() {
  const h = ($('#taskRepeatTime') || {}).value || '07:00';
  if (repetition.freq === 'daily') return `daily ${h}`;
  if (repetition.freq === 'weekly') return repetition.jours.length ? `weekly ${JOURS_REPET.filter((j) => repetition.jours.includes(j)).join(',')} ${h}` : '';
  if (repetition.freq === 'monthly') return `monthly ${repetition.dom} ${h}`;
  return '';
}

/* `daily 07:00`, `weekly mon,thu 07:00`, `monthly 1 07:00` → l'état du bloc. Vide = « Jamais ». */
function poserRepetition(spec) {
  const m = String(spec || '').trim().match(/^(daily|weekly|monthly)\s+(?:([a-z,]+|\d{1,2})\s+)?(\d{1,2}:\d{2})$/);
  repetition = { freq: '', jours: [], dom: 1 };
  if (m) {
    repetition.freq = m[1];
    if (m[1] === 'weekly') repetition.jours = String(m[2] || '').split(',').filter((j) => JOURS_REPET.includes(j));
    if (m[1] === 'monthly') repetition.dom = Number(m[2]) || 1;
    const [hh, mm] = m[3].split(':');
    const champ = $('#taskRepeatTime'); if (champ) champ.value = `${hh.padStart(2, '0')}:${mm}`;
  }
  const dom = $('#taskRepeatDom'); if (dom) dom.value = String(repetition.dom);
  majRepetition();
}
function oublierRepetition() {
  editingRecurrenceId = null;
  repetition = { freq: '', jours: [], dom: 1 };
  const row = $('#taskRepeatRow'); if (row) row.hidden = true;
}

function majVisibiliteRepetition() {
  const row = $('#taskRepeatRow');
  if (row) row.hidden = !repetitionPossible();
  majRepetition();
}

/* L'état du bloc → l'écran : la fréquence choisie, les jours, le jour du mois, les boutons de la
   modale (« Créer la récurrence »), « Lancer plus tard » et « puis converger » masqués — l'un et
   l'autre n'ont pas de sens pour un modèle —, la branche datée et la phrase. */
function majRepetition() {
  const row = $('#taskRepeatRow');
  if (!row) return;
  const actif = repetitionActive();
  $$('[data-repeat]', row).forEach((b) => {
    b.classList.toggle('active', b.dataset.repeat === repetition.freq);
    // À l'édition d'un modèle, « Jamais » n'a pas de sens : on supprime le modèle pour ça.
    if (b.dataset.repeat === '') b.hidden = !!editingRecurrenceId;
  });
  $('#taskRepeatDetail').hidden = !actif;
  $('#taskRepeatDays').hidden = repetition.freq !== 'weekly';
  $('#taskRepeatDomRow').hidden = repetition.freq !== 'monthly';
  $$('.task-repeat-day', row).forEach((b) => {
    const on = repetition.jours.includes(b.dataset.dow);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('#taskRepeatRunNowRow').hidden = !!editingRecurrenceId;
  const sr = $('#taskScheduleRow'); if (sr && repetitionPossible()) sr.hidden = actif;
  const cv = $('#taskConvergeRow'); if (cv && taskKind === 'code' && !editingTaskId) cv.hidden = actif;
  if (actif) {
    const f = $('#taskForm');
    if (f.scheduled_at_date) f.scheduled_at_date.value = '';
    if (f.scheduled_at_time) f.scheduled_at_time.value = '';
    if (f.converge_after) f.converge_after.checked = false;
    $('#taskSubmit').innerHTML = `${svgIco('repeat')}${esc(tr(editingRecurrenceId ? 'ui.save' : 'recur.btn.create'))}`;
    $('#taskSubmitOnly').hidden = true;
  } else if (repetitionPossible() && $('#taskSubmit').textContent.trim() === tr('recur.btn.create')) {
    boutonsCreation();
  }
  majBrancheRepetition();
  majPhraseRepetition();
}

/* LA BRANCHE D'UNE ÉCHÉANCE, dite avant d'enregistrer : le serveur ajoute `-{date}` à un nom qui
   ne l'a pas, et c'est ici qu'on le découvre — pas sur la première merge request. */
function majBrancheRepetition() {
  const note = $('#taskRepeatBranch');
  if (!note) return;
  const premiere = repetitionActive() && taskKind === 'code' ? readTargetRows().find((x) => x.branch) : null;
  note.hidden = !premiere;
  if (!premiere) { note.textContent = ''; return; }
  const gabarit = premiere.branch.includes('{date}') ? premiere.branch : `${premiere.branch}-{date}`;
  note.textContent = tr('recur.branch-note', { branch: gabarit.split('{date}').join(jourLocalRepetition()) });
}
const jourLocalRepetition = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* La phrase et la prochaine échéance viennent du SERVEUR : c'est lui qui lancera, et une règle
   recopiée ici (le 28 du mois, les jours multiples) finirait par dire autre chose que lui. */
let phraseSeq = 0;
const majPhraseRepetition = debounce(async () => {
  const el = $('#taskRepeatSaid');
  if (!el) return;
  const spec = repetitionActive() ? specRepetition() : '';
  const seq = ++phraseSeq;
  if (!spec) { el.textContent = repetitionActive() && repetition.freq === 'weekly' ? tr('recur.err.days') : ''; el.classList.toggle('is-error', !!el.textContent); return; }
  try {
    const d = await api(`/recurrences/preview?schedule=${encodeURIComponent(spec)}`);
    if (seq !== phraseSeq) return;
    el.classList.remove('is-error');
    el.textContent = tr('recur.said', { said: d.said, next: d.next_at ? fmtDateTime(d.next_at) : '—' });
  } catch (e) { if (seq === phraseSeq) { el.textContent = explainError(e.message); el.classList.add('is-error'); } }
}, 200);

(() => {
  const row = $('#taskRepeatRow');
  if (!row) return;
  row.addEventListener('click', (e) => {
    const freq = e.target.closest('[data-repeat]');
    if (freq) {
      repetition.freq = freq.dataset.repeat;
      // Une semaine sans jour ne part jamais : on propose le jour d'aujourd'hui.
      if (repetition.freq === 'weekly' && !repetition.jours.length) repetition.jours = [JOURS_REPET[(new Date().getDay() + 6) % 7]];
      majRepetition();
      return;
    }
    const jour = e.target.closest('.task-repeat-day');
    if (jour) {
      const j = jour.dataset.dow;
      repetition.jours = repetition.jours.includes(j) ? repetition.jours.filter((x) => x !== j) : [...repetition.jours, j];
      majRepetition();
      return;
    }
    const preset = e.target.closest('[data-repeat-preset]');
    if (preset) {
      const p = preset.dataset.repeatPreset;
      if (p === 'weekdays') poserRepetition('weekly mon,tue,wed,thu,fri 07:00');
      if (p === 'monday') poserRepetition('weekly mon 09:00');
      if (p === 'first') poserRepetition('monthly 1 07:00');
    }
  });
  $('#taskRepeatTime').addEventListener('input', () => majPhraseRepetition());
  $('#taskRepeatDom').addEventListener('input', (e) => {
    repetition.dom = Math.min(28, Math.max(1, Number(e.target.value) || 1));
    majPhraseRepetition();
  });
  // La branche d'exemple suit ce qu'on tape dans les lignes de projets.
  const lignes = $('#targetRows');
  if (lignes) lignes.addEventListener('input', () => { if (repetitionActive()) majBrancheRepetition(); });
})();

/* L'ENVOI D'UN MODÈLE. Le corps est celui d'une session, que le submit commun vient d'assembler ;
   on y ajoute l'horaire et ses options. Rend `true` si le submit doit s'arrêter là. */
async function soumettreRecurrence(f, body) {
  const spec = specRepetition();
  if (!spec) { signalerChamp($('#taskRepeatTime'), tr('recur.err.days')); return true; }
  if (body.kind === 'code' && !body.auto_push) { signalerChamp(f.auto_push, tr('err.recur.push')); return true; }
  const corps = {
    ...body,
    schedule: spec,
    skip_unchanged: f.repeat_skip_unchanged ? f.repeat_skip_unchanged.checked : false,
    keep_last: f.repeat_keep_last ? Number(f.repeat_keep_last.value) || 10 : 10,
    run_now: !editingRecurrenceId && f.repeat_run_now ? f.repeat_run_now.checked : false,
  };
  // Ce qui ne vaut que pour UNE session : un modèle ne reprend pas de session d'agent, et ses
  // pièces jointes appartiendraient à la première session seulement.
  for (const cle of ['files', 'session_id', 'agent_id', 'agent_draft', 'force_push']) delete corps[cle];
  const btn = $('#taskSubmit');
  try {
    if (editingRecurrenceId) {
      await busy(btn, () => api(`/recurrences/${editingRecurrenceId}`, { method: 'PUT', body: corps }));
      toast(tr('recur.toast.saved'));
    } else {
      const r = await busy(btn, () => api('/recurrences', { method: 'POST', body: corps }));
      toast(r.started ? tr('recur.toast.created-started', { said: r.said }) : tr('recur.toast.created', { said: r.said }));
      if (r.started) refreshStatus();
    }
    ongletAuRetour = 'recur';
    resetTaskFiles(); closeTaskModal(); loadTasks();
  } catch (err) { toast(explainError(err.message), true); }
  return true;
}
// À la fermeture de la modale (envoi, annulation, clic au fond) : l'onglet d'où l'on venait.
function retourOngletRecurrence() {
  oublierRepetition();
  if (!ongletAuRetour) return;
  taskKind = ongletAuRetour;
  ongletAuRetour = null;
  try { localStorage.setItem('aidevtools_task_kind', taskKind); } catch { /* ignore */ }
  renderTasks();
}

/* ---------- Ouvrir la modale sur un modèle ---------- */

// « Codage récurrent » / « Exploration récurrente » depuis l'onglet : la modale, Répéter ouvert.
async function nouvelleRecurrence(kind) {
  await openTaskModal(kind);
  ongletAuRetour = 'recur';
  poserRepetition(`weekly ${JOURS_REPET[(new Date().getDay() + 6) % 7]} 07:00`);
  $('#taskModalTitle').textContent = tr(kind === 'explore' ? 'recur.title.new-explore' : 'recur.title.new-code');
}

/* MODIFIER UN MODÈLE : le formulaire de session, rempli depuis ce que le modèle garde (les champs
   de `creerTask`, en camelCase), la branche AVEC son `{date}`. */
async function modifierRecurrence(r) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  editingTaskId = null; launchAfterCreate = false;
  taskKind = r.kind;
  await loadRepoOptions();
  applyKindToModal(taskKind);
  const p = r.payload || {};
  renderTargetRows((p.targets || []).map((x) => ({ repo_id: x.repo_id, branch: x.branch || '', base_branch: x.base_branch || '' })));
  if (taskKind === 'code') renderCtxRepoRows((p.contextRepos || []).map((x) => ({ repo_id: x.repo_id, branch: x.branch })));
  setupTaskJira('');
  f.prompt.value = p.prompt || '';
  if (f.label) f.label.value = r.label || '';
  if (f.commit_message) f.commit_message.value = p.commitMessage || '';
  if (f.auto_push) f.auto_push.checked = !!p.autoPush;
  if (f.ask_questions) f.ask_questions.checked = !!p.askQuestions;
  if (f.notify_jira) f.notify_jira.checked = !!p.notifyJira;
  if (f.review_after) f.review_after.checked = !!p.reviewAfter;
  if (f.plan_first) f.plan_first.checked = !!p.planFirst;
  if (f.shared) f.shared.checked = !!p.shared;
  if (f.repeat_skip_unchanged) f.repeat_skip_unchanged.checked = !!r.skip_unchanged;
  if (f.repeat_keep_last) f.repeat_keep_last.value = String(r.keep_last || 10);
  cliPreselection = p.cliId || '';
  await majVerificateursSession(p.verifierId || '', { autoPick: false });
  $('#taskModalTitle').textContent = tr('recur.title.edit');
  $('#taskExistingImgs').textContent = '';
  showTaskModal();
  editingRecurrenceId = r.id;
  ongletAuRetour = 'recur';
  majVisibiliteRepetition();
  poserRepetition(r.spec);
  f.prompt.focus();
}

/* RENDRE RÉCURRENTE une session déjà faite : la duplication remplit tout, puis la branche reprend
   son nom d'origine — sans le « -2 » de la copie — et Répéter s'ouvre sur la semaine. */
async function rendreRecurrente(id) {
  const d = await api(`/tasks/${id}`);
  await dupliquerTask(id);
  const t = d.task;
  if (t.kind === 'code') {
    renderTargetRows((t.targets || []).map((x) => ({
      repo_id: x.repo_id, branch: String(x.branch || '').replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, '').replace(/-\d+$/, ''), base_branch: x.base_branch,
    })));
    const f = $('#taskForm');
    if (f.auto_push) f.auto_push.checked = true;
  }
  $('#taskExistingImgs').textContent = tr('recur.from-session');
  $('#taskModalTitle').textContent = tr('recur.title.from-session');
  poserRepetition(`weekly ${JOURS_REPET[(new Date().getDay() + 6) % 7]} 07:00`);
}

/* ---------- La liste ---------- */

const SAUT = { busy: 'recur.skip.busy', unchanged: 'recur.skip.unchanged' };
function ligneDerniere(r) {
  const saut = r.last_skip && (!r.last_task || !r.last_run_at || (r.last_skip_at || '') > (r.last_run_at || ''));
  if (saut) {
    const raison = String(r.last_skip).startsWith('error:')
      ? tr('recur.skip.error', { message: String(r.last_skip).slice(6) })
      : tr(SAUT[r.last_skip] || 'recur.skip.error', { message: r.last_skip });
    return `<div class="meta task-recur-skip">${svgIco('alert')} ${esc(tr('recur.last-skip', { when: fmtDateTime(r.last_skip_at), reason: raison }))}</div>`;
  }
  if (!r.last_task) return `<div class="meta muted">${esc(tr('recur.never'))}</div>`;
  const st = TASK_STATUS[r.last_task.status] || { label: r.last_task.status, cls: '' };
  const mrs = (r.last_task.targets || []).filter((x) => x.mr_url)
    .map((x) => `<a href="${esc(safeUrl(x.mr_url))}" target="_blank" rel="noopener noreferrer">!${esc(String(x.mr_iid))}</a>`).join(' ');
  return `<div class="meta">${esc(tr('recur.last', { when: fmtDateTime(r.last_task.created_at) }))}
    <span class="tag ${st.cls}">${esc(st.label)}</span>
    <button type="button" class="croise-go" data-recur-open="${r.last_task.id}" data-recur-kind="${esc(r.kind)}">${esc(tr('recur.open-session', { id: r.last_task.id }))}</button>
    ${mrs}</div>`;
}
function carteRecurrence(r) {
  const projets = (r.projects || []).map((x) => `${esc(x.project || `#${x.repo_id}`)}${x.branch ? ` <code>${esc(x.branch)}</code>` : ''}`).join(' · ');
  return `<div class="card task-row task-recur${r.paused ? ' is-paused' : ''}" data-recur="${r.id}">
    <div style="min-width:0;flex:1">
      <div class="title">
        <span class="tag">${esc(tr(r.kind === 'explore' ? 'task.kind.explore' : 'task.kind.code'))}</span>
        ${r.paused ? `<span class="tag stale">${esc(tr('recur.paused'))}</span>` : ''}
        ${r.skip_unchanged ? `<span class="tag" title="${esc(tr('recur.lbl.skip-unchanged'))}">${esc(tr('recur.tag.if-changed'))}</span>` : ''}
      </div>
      <div class="task-label">${svgIco('repeat')} <span class="task-label-txt">${esc(r.label)}</span></div>
      <div class="meta task-recur-when">${esc(r.said)}${r.next_at ? ` — ${esc(tr('recur.next', { when: fmtDateTime(r.next_at) }))}` : ''}</div>
      <div class="meta">${projets}</div>
      ${ligneDerniere(r)}
      <div class="meta muted">${esc(tr('recur.kept', { n: r.sessions, count: r.sessions, keep: r.keep_last }))}</div>
    </div>
    ${taskActions([
    `<button class="btn btn-primary" data-recur-run="${r.id}" title="${esc(tr('recur.title.run'))}">${svgIco('play')}${esc(tr('recur.btn.run'))}</button>`,
    `<button class="btn" data-recur-pause="${r.id}" data-on="${r.paused ? 0 : 1}">${svgIco(r.paused ? 'play' : 'pause')}${esc(tr(r.paused ? 'recur.btn.resume' : 'recur.btn.pause'))}</button>`,
  ], [
    `<button class="btn btn-icon btn-sm" data-recur-edit="${r.id}" title="${esc(tr('recur.title.edit'))}">${svgIco('edit')}</button>`,
    `<button class="btn btn-icon btn-sm btn-danger" data-recur-del="${r.id}" title="${esc(tr('recur.title.delete'))}">${svgIco('close')}</button>`,
  ])}
  </div>`;
}
function renderRecurrences() {
  const el = $('#recurList');
  if (!el) return;
  const q = taskQuery();
  const rows = recurrencesListe.filter((r) => taskMatches({ label: r.label, prompt: (r.payload || {}).prompt }, q, (r.projects || []).flatMap((x) => [x.project, x.branch])));
  if (!rows.length && q) { el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(q) })}</p>`; return; }
  if (!rows.length) {
    el.innerHTML = emptyState({ icon: 'repeat', title: tr('recur.empty.title'), text: tr('recur.empty.text'),
      actions: [{ act: 'new-task', label: tr('recur.new-code'), primary: true }] });
    return;
  }
  el.innerHTML = rows.map(carteRecurrence).join('');
  stagger('#recurList .card');
}

/* Le badge ↻ sur une session née d'un modèle : un clic ramène au modèle. Un modèle supprimé depuis
   (ou celui d'un collègue, qui n'existe pas ici) ne laisse pas de badge mort. */
function badgeRecurrence(t) {
  const r = t && t.recurrence_uid ? recurrencesListe.find((x) => x.uid === t.recurrence_uid) : null;
  if (!r) return '';
  return `<button type="button" class="tag task-recur-badge" data-recur-goto="${r.id}" title="${esc(tr('recur.badge-title', { label: r.label }))}">${svgIco('repeat')} ${esc(r.label)}</button>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-recur-run], [data-recur-pause], [data-recur-edit], [data-recur-del], [data-recur-open], [data-recur-goto], [data-trecur], #btnNewRecurExplore');
  if (!b) return;
  try {
    if (b.id === 'btnNewRecurExplore') { await nouvelleRecurrence('explore'); return; }
    if (b.dataset.trecur) { await rendreRecurrente(Number(b.dataset.trecur)); return; }
    if (b.dataset.recurRun) {
      const d = await busy(b, () => api(`/recurrences/${b.dataset.recurRun}/run`, { method: 'POST' }));
      toast(tr('recur.toast.started', { id: d.task_id })); refreshStatus(); loadTasks();
      return;
    }
    if (b.dataset.recurPause) {
      await busy(b, () => api(`/recurrences/${b.dataset.recurPause}/pause`, { method: 'POST', body: { paused: b.dataset.on === '1' } }));
      loadTasks();
      return;
    }
    if (b.dataset.recurEdit) {
      const r = recurrencesListe.find((x) => x.id === Number(b.dataset.recurEdit));
      if (r) await modifierRecurrence(r);
      return;
    }
    if (b.dataset.recurDel) {
      const r = recurrencesListe.find((x) => x.id === Number(b.dataset.recurDel));
      if (!r || !await confirmDialog({ text: tr('recur.confirm-delete', { label: r.label }), confirmLabel: tr('ui.delete') })) return;
      await api(`/recurrences/${r.id}`, { method: 'DELETE' });
      toast(tr('recur.toast.deleted')); loadTasks();
      return;
    }
    if (b.dataset.recurOpen) {
      taskKind = b.dataset.recurKind === 'explore' ? 'explore' : 'code';
      renderTasks();
      if (revelerSession(Number(b.dataset.recurOpen))) {
        const carte = $(`#taskList .card[data-task="${Number(b.dataset.recurOpen)}"]`);
        if (carte) carte.scrollIntoView({ block: 'center' });
      }
      return;
    }
    if (b.dataset.recurGoto) {
      taskKind = 'recur';
      renderTasks();
      const carte = $(`#recurList .card[data-recur="${Number(b.dataset.recurGoto)}"]`);
      if (carte) carte.scrollIntoView({ block: 'center' });
    }
  } catch (err) { toast(explainError(err.message), true); }
});
