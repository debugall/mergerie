'use strict';
/* Dev IA : l'état des sessions, les sous-onglets codage / exploration, miennes / équipe / toutes. */
// @expose allTasks, fmtDateTime, questions, renderTasks, taskKind
/* ---------- Dev IA : sessions de codage et d'exploration ----------
   Une session porte sur UN OU PLUSIEURS projets, chacun avec sa branche.
   - Codage    : l'IA modifie le code de chaque projet → commit / push / MR PAR PROJET.
   - Exploration : lecture seule, l'IA répond à une question sur l'ensemble des projets
     et sa réponse est enregistrée dans un .md consultable. Ni diff ni merge. */
let taskNewImages = [];        // captures du formulaire (data URLs)
let piecesNoteProposees = [];   // B6 : captures d'une page de notes proposées à la session
let taskKind = 'code';         // sous-onglet courant : 'code' | 'local' | 'explore'
// Sessions rangées : masquées par défaut, la préférence est relue au démarrage.
let showHiddenTasks = (() => { try { return localStorage.getItem('aidevtools_show_hidden') === '1'; } catch { return false; } })();
let allTasks = [];             // dernier chargement (sessions code/explore)
let localTasks = [];           // sessions « Codage hors dépôt »
let questions = [];            // « Question libre » : ni dépôt ni dossier
let localRootId = '';          // répertoire local choisi dans le formulaire local
let localPicks = [''];         // projets choisis dans ce répertoire (noms de dossier)
const KIND_LABEL = {
  code: { title: tr('task.kind.code.title'), btn: tr('task.kind.code.btn'), hint: tr('task.kind.code.hint') },
  local: { title: tr('task.kind.local.title'), btn: tr('task.kind.local.btn'), hint: tr('task.kind.local.hint') },
  explore: { title: tr('task.kind.explore.title'), btn: tr('task.kind.explore.btn'), hint: tr('task.kind.explore.hint') },
  ask: { title: tr('task.kind.ask.title'), btn: tr('task.kind.ask.btn'), hint: tr('task.kind.ask.hint') },
};

/* ---- Sous-onglets Codage / Exploration ---- */
$$('#tab-task .subnav [data-kind]').forEach((b) => b.addEventListener('click', () => {
  taskKind = b.dataset.kind;
  try { localStorage.setItem('aidevtools_task_kind', taskKind); } catch { /* ignore */ }
  // La recherche est remise à zéro en changeant de sous-onglet : les compteurs des onglets
  // affichent des TOTAUX, une liste filtrée à côté d'un « Codage 3 » se contredirait.
  const sq = $('#taskSearch');
  if (sq) sq.value = '';
  // …et le filtre par agent avec elle, pour la même raison — il survivait d'un onglet à l'autre.
  poserFiltreAgent(0);
  renderTasks();
}));

const TASK_STATUS = {
  new: { label: tr('task.status.new'), cls: 'to_review' },
  running: { label: tr('task.status.running'), cls: 'reviewed' },
  committed: { label: tr('task.status.committed'), cls: 'reviewed' },
  pushed: { label: tr('task.status.pushed'), cls: 'done' },
  done: { label: tr('task.status.done'), cls: 'done' },
  needs_input: { label: tr('task.status.needs-input'), cls: 'needs-input' },
  error: { label: tr('task.status.error'), cls: 'stale' },
};
const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(I18Nrt.currentLocale(), { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' });
};
/* Une date ISO → la valeur d'un `<input type="datetime-local">`, en heure LOCALE : c'est l'heure
   du poste qui lancera, et « 7:00 » veut dire 7:00 ici. Vide si pas de date. */
function versDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/* LE BADGE « PROGRAMMÉE POUR LE … » sur la carte, avec sa croix : la date se voit là où l'on
   regarde la session, et s'annule d'un geste — sans rouvrir la modale. */
function badgeProgrammation(t, pre) {
  if (!t || !t.scheduled_at) return '';
  const quand = fmtDateTime(t.scheduled_at);
  return `<span class="tag tag-programme" title="${esc(tr('task.scheduled-for', { when: quand }))}">${svgIco('clock')} ${esc(quand)}</span>`
    + `<button type="button" class="tag-x" data-${pre}unschedule="${t.id}" title="${esc(tr('task.title.unschedule'))}" aria-label="${esc(tr('task.title.unschedule'))}">${svgIco('close')}</button>`;
}
async function annulerProgrammation(b, route) {
  try {
    await busy(b, () => api(route, { method: 'PUT', body: { at: null } }));
    toast(tr('toast.programmation-annulee'));
    loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}

/* Sauvegarde/restaure les formulaires inline ouverts avant un re-rendu. Une session qui tourne
   se re-rend toutes les secondes et demie : sans ça, un suivi qu'on est en train d'écrire
   disparaît sous les doigts. La liste hors dépôt y a droit autant que les autres — c'est
   justement pendant que ça tourne qu'on écrit un suivi. */
const CLES_FORM = ['mrform', 'followform', 'lfollowform', 'qfollowform'];
function captureTaskForms(racine = '#taskList') {
  const state = {};
  $$(`${racine} .mr-create`).forEach((f) => {
    const cle = CLES_FORM.find((k) => f.dataset[k]);
    if (!cle || f.hidden) return;
    const field = f.querySelector('textarea, input');
    const auto = f.querySelector('.followup-auto');
    const at = f.querySelector('.followup-at');
    state[`${cle}:${f.dataset[cle]}`] = { v: field ? field.value : '', auto: auto ? auto.checked : null, at: at ? at.value : null };
  });
  return state;
}
function restoreTaskForms(state, racine = '#taskList') {
  for (const [key, value] of Object.entries(state)) {
    const i = key.indexOf(':');   // l'identifiant peut contenir un préfixe (« tg12 »)
    const f = $(`${racine} .mr-create[data-${key.slice(0, i)}="${key.slice(i + 1)}"]`);
    if (!f) continue;
    f.hidden = false;
    const field = f.querySelector('textarea, input');
    if (field) field.value = value.v;
    const auto = f.querySelector('.followup-auto');
    if (auto && value.auto !== null) auto.checked = value.auto;
    const at = f.querySelector('.followup-at');
    if (at && value.at !== null) at.value = value.at;
    renderSuiviPreviews(f);      // les captures collées survivent au re-rendu, comme le texte
  }
}

/* LES MIENNES / L'ÉQUIPE / TOUTES. Dès qu'on partage, la liste mêle son propre travail et celui
   des autres — et la question du matin est « où en est CE que je fais ? ». Le filtre n'existe
   qu'en mode partagé : en mono-poste, tout est à soi. Mémorisé dans le navigateur, comme le
   filtre d'auteur des merge requests. */
let filtreProprio = 'toutes';
try { filtreProprio = localStorage.getItem('mergerie_task_owner') || 'toutes'; } catch { /* ignore */ }

function renderFiltreProprio() {
  const box = $('#taskOwnerFiltre');
  if (!box) return;
  box.hidden = !(partageEtMoi && partageEtMoi.partage);
  if (box.hidden) return;
  const opts = [['toutes', 'session.filter.all'], ['miennes', 'session.filter.mine'], ['equipe', 'session.filter.team']];
  box.innerHTML = opts.map(([v, k]) => `<button type="button" class="chip${filtreProprio === v ? ' active' : ''}" data-task-proprio="${v}">${esc(tr(k))}</button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-task-proprio]');
  if (!b) return;
  filtreProprio = b.dataset.taskProprio;
  try { localStorage.setItem('mergerie_task_owner', filtreProprio); } catch { /* ignore */ }
  renderTasks();
});

/* « Les miennes » = ce que personne d'autre n'a écrit : une session sans auteur n'est jamais
   partie dans le dépôt, elle est donc à moi. */
function duProprio(t) {
  if (!partageEtMoi || !partageEtMoi.partage || filtreProprio === 'toutes') return true;
  const mienne = estAMoi(t);
  return filtreProprio === 'miennes' ? mienne : !mienne;
}

// Une session rangée ne sort que si la case le demande.
const taskVisible = (t) => (showHiddenTasks || !t.hidden) && duProprio(t);

/* Combien de sessions le rangement retire de la vue. Affiché à côté de la case : une
   session qui disparaît sans laisser de trace se croit supprimée, et on la recrée. */
function reportHiddenCount(n) {
  const el = $('#taskHiddenCount');
  if (!el) return;
  el.textContent = n ? tr('task.hidden.count', { n, count: n }) : '';
}

function renderTasks() {
  renderFiltreProprio();
  const isLocal = taskKind === 'local';
  const isAsk = taskKind === 'ask';
  const el = $('#taskList');
  const openForms = (isLocal || isAsk) ? {} : captureTaskForms();
  $$('#tab-task .subnav [data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === taskKind));
  // La barre d'outils (bouton « Nouvelle session ») reste visible pour tous les kinds —
  // en local elle ouvre la MÊME modale que le codage. Seule la liste change.
  el.hidden = isLocal || isAsk;
  $('#localPanel').hidden = !isLocal;
  $('#askPanel').hidden = !isAsk;
  // Un lot regroupe des merge requests : il n'a rien à faire sous le codage hors dépôt
  // ni sous l'exploration, qui ne produisent pas de MR.
  $('#lotPanel').hidden = taskKind !== 'code';
  $('#btnNewTaskLabel').textContent = KIND_LABEL[taskKind].btn;
  $('#taskKindHint').textContent = KIND_LABEL[taskKind].hint;
  /* Le champ de recherche est partagé par les quatre saveurs, mais son texte d'aide promettait
     « projet, branche, dossier » — trois choses qu'une question libre n'a pas. */
  const rech = $('#taskSearch');
  if (rech) rech.placeholder = tr(isAsk ? 'ask.search.ph' : 'task.search.ph');

  const counts = { code: 0, explore: 0 };
  allTasks.forEach((t) => { counts[t.kind === 'explore' ? 'explore' : 'code'] += 1; });
  $('#kindCountAsk').textContent = questions.length;
  $('#kindCountCode').textContent = counts.code;
  $('#kindCountExplore').textContent = counts.explore;
  $('#kindCountLocal').textContent = localTasks.length;
  // Le badge du menu signale le TRAVAIL EN ATTENTE (sessions jamais lancées, tous types),
  // comme celui de « Reviews » qui compte les MR à traiter — pas un total.
  const nav = $('#navCountTask');
  if (nav) {
    const pending = allTasks.filter((t) => t.status === 'new').length
      + localTasks.filter((t) => t.status === 'new').length
      + questions.filter((q) => q.status === 'new').length;
    nav.textContent = pending;
    nav.hidden = !pending;
    nav.title = tr('task.nav.pending', { n: pending, count: pending });
  }

  if (isLocal) { renderLocalTasks(); return; }
  if (isAsk) { renderQuestions(); return; }

  rendreComboFiltreAgent();
  const q = taskQuery();
  const all = allTasks
    .filter((t) => (t.kind === 'explore' ? 'explore' : 'code') === taskKind)
    // Les runs d'UN agent : c'est ce que « Ses sessions » ouvre depuis sa carte.
    .filter((t) => !agentFiltreSessions || Number(t.agent_id) === Number(agentFiltreSessions));
  const visible = all.filter(taskVisible);
  reportHiddenCount(all.length - visible.length);
  const rows = visible.filter((t) => taskMatches(t, q, (t.targets || []).flatMap((x) => [x.project, x.branch])));
  if (!rows.length && q) {
    el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(q) })}</p>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = taskKind === 'code'
      ? emptyState({ icon: 'bot', title: tr('task.empty.code.title'),
        text: tr('task.empty.code.text'),
        actions: [{ act: 'new-task', label: tr('task.kind.code.btn'), primary: true }] })
      : emptyState({ icon: 'search', title: tr('task.empty.explore.title'),
        text: tr('task.empty.explore.text'),
        actions: [{ act: 'new-task', label: tr('task.kind.explore.btn'), primary: true }] });
    return;
  }

  el.innerHTML = rows.map((t) => (t.kind === 'explore' ? exploreCard(t) : codeCard(t))).join('');
  stagger('#taskList .card');
  wirePromptToggles('#taskList');
  wireTaskActions();
  restoreTaskForms(openForms);
  remplirLiensDifferes(el);      // les boutons contextuels des lignes de projet
}

