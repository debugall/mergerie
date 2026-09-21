'use strict';
/* Todos. */
// @expose loadTodos, refreshOpenTodos, todoDueHtml, todoPrioBadge, todoQuickAdd
/* ---------- Todos ---------- */

function todoPrioBadge(p) {
  if (p === 'normal') return '';   // la normale est le cas courant : la baliser serait du bruit
  return `<span class="prio prio-${esc(p)}">${esc(tr(`notes.prio.${p}`))}</span>`;
}

/* L'échéance en RELATIF. « 2026-08-09 09:00 » oblige à calculer ; « demain 9 h » se lit.
   Le rouge est réservé au dépassé : une échéance à venir n'est pas une alarme. */
function todoDueLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { texte: '', enRetard: false };
  const now = new Date();
  const jour = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dj = Math.round((jour(d) - jour(now)) / 86400000);
  if (d.getTime() < now.getTime()) {
    const retard = -dj;
    return {
      texte: retard >= 1 ? tr('notes.todo.due.overdue', { n: retard, count: retard }) : tr('notes.todo.due.now'),
      enRetard: true,
    };
  }
  if (dj === 0) return { texte: tr('notes.todo.due.today', { time: fmtHour(iso) }), enRetard: false };
  if (dj === 1) return { texte: tr('notes.todo.due.tomorrow', { time: fmtHour(iso) }), enRetard: false };
  return { texte: tr('notes.todo.due.in-days', { n: dj, count: dj }), enRetard: false };
}

function todoDueHtml(t) {
  if (!t.due_at) return '';
  const { texte, enRetard } = todoDueLabel(t.due_at);
  return `<span class="todo-due${enRetard ? ' late' : ''}" title="${esc(`${fmtDate(t.due_at)} ${fmtHour(t.due_at)}`)}">${svgIco('clock')} ${esc(texte)}</span>`;
}

const todoSnoozeHtml = (id) => `<span class="todo-snooze">
  <button type="button" class="btn btn-sm btn-ghost" data-snooze="hour" data-todo-id="${id}" title="${esc(tr('notes.todo.snooze.hour-title'))}">${esc(tr('notes.todo.snooze.hour'))}</button>
  <button type="button" class="btn btn-sm btn-ghost" data-snooze="tomorrow" data-todo-id="${id}" title="${esc(tr('notes.todo.snooze.tomorrow-title'))}">${esc(tr('notes.todo.snooze.tomorrow'))}</button>
</span>`;

/* Le lien vers l'objet suivi. Une MR dont l'id ne résout plus (rapport supprimé, dépôt
   retiré) reste affichée comme telle plutôt que de disparaître : la todo, elle, existe. */
/* CE QUE LA MERGE REQUEST LIÉE EST DEVENUE. « Suivre !201 » restait à l'écran des jours après
   le merge : on ouvrait Reviews pour vérifier, puis on revenait cocher. La ligne le dit —
   note, verdict, âge, et « mergée » quand elle l'est : on sait si la todo a encore une raison
   d'exister sans quitter la liste. */
function todoEtatMr(t) {
  const m = t && t.mr;
  if (!m) return '';
  const bouts = [];
  if (m.note != null) bouts.push(esc(fmtNote10(m.note * 10)));
  if (m.verdict) bouts.push(esc(tr(`mr.ref.verdict.${m.verdict}`)));
  if (m.closed) bouts.push(esc(tr('notes.todo.mr.closed')));
  else if (m.created_at) bouts.push(esc(tr('notes.todo.mr.open-since', { when: depuis(m.created_at) })));
  return bouts.length ? ` <span class="todo-mr-etat muted">${bouts.join(' · ')}</span>` : '';
}

/* A/Notes 1 — CE QUE LE TICKET LIÉ EST DEVENU. Sa sœur liée à une merge request disait tout ;
   celle-ci ne disait rien, et on rouvrait Jira pour savoir si elle avait encore une raison
   d'exister. Rien n'est demandé au réseau : l'état vient de la surveillance ou de ce que la
   découverte a rangé sur les merge requests portant la clé. */
function todoEtatTicket(t) {
  const k = t && t.ticket;
  if (!k) return '';
  const bouts = [];
  if (k.status) bouts.push(esc(k.status));
  for (const m of (k.mrs || [])) bouts.push(esc(tr('notes.todo.ticket.mr', { iid: m.iid, project: m.project })));
  return bouts.length ? ` <span class="todo-mr-etat muted">${bouts.join(' · ')}</span>` : '';
}

function todoLinkHtml(t) {
  if (!t.link_kind || !t.link_ref) return '';
  if (t.link_kind === 'mr') {
    return `<a href="#" class="note-link" data-note-mr="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('merge')} ${esc(tr('notes.todo.link.mr', { iid: todoMrIid(t.link_ref) }))}</a>`;
  }
  if (t.link_kind === 'ticket') {
    return `<a href="#" class="note-link" data-note-ticket="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('tag')} ${esc(tr('notes.todo.link.ticket', { key: t.link_ref }))}</a>`;
  }
  /* B16 — LES QUATRE NOUVEAUX OBJETS. Chacun mène à l'endroit où il vit : une todo qui
     nomme un build sans pouvoir l'ouvrir laisse exactement le travail qu'elle prétendait
     éviter. La référence porte ce qu'il faut pour y retourner, et rien de plus. */
  if (t.link_kind === 'verification') {
    return `<button type="button" class="note-link" data-vreport="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('check')} ${esc(tr('notes.todo.link.verification'))}</button>`;
  }
  if (t.link_kind === 'build') {
    // `chemin/du/job#42` — le job seul suffit à ouvrir la fiche, le numéro dit lequel.
    const [chemin, num] = String(t.link_ref).split('#');
    return `<button type="button" class="note-link" data-todo-build="${esc(chemin)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('pipeline')} ${esc(tr('notes.todo.link.build', { job: chemin, n: num || '' }))}</button>`;
  }
  if (t.link_kind === 'branch') {
    // `<id de dépôt>:<branche>` — l'explorateur se pose dessus.
    const [repoId, ...reste] = String(t.link_ref).split(':');
    const branche = reste.join(':');
    return `<button type="button" class="note-link" data-todo-branch="${esc(repoId)}" data-todo-branch-name="${esc(branche)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('branch')} ${esc(branche)}</button>`;
  }
  if (t.link_kind === 'container') {
    return `<button type="button" class="note-link" data-todo-container="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('inbox')} ${esc(t.link_ref)}</button>`;
  }
  return `<span class="muted">${svgIco('branch')} ${esc(tr('notes.todo.link.repo', { project: t.link_ref }))}</span>`;
}

/* Les portes des trois liens qui ne sont pas de simples ancres. `data-vreport` est déjà
   écouté ailleurs (le badge d'une carte ouvre le même rapport) : on ne le recâble pas. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-todo-build]');
  if (b) { navTab('jenkins'); await loadJenkins(); openJenkinsJob(b.dataset.todoBuild); return; }
  /* Une branche : l'explorateur, son dépôt COCHÉ et l'analyse lancée — c'est là qu'on voit
     ce qu'une branche a d'écart, de dernier commit et de merge request. On coche la vraie
     case et on clique le vrai bouton : pas de second chemin d'analyse à maintenir. */
  const br = e.target.closest && e.target.closest('[data-todo-branch]');
  if (br) {
    navTab('git');
    showGitSub('explore');
    const c = $(`#gitExploreRepoBox .git-multi-pick[value="${Number(br.dataset.todoBranch)}"]`);
    if (c) {
      $$('#gitExploreRepoBox .git-multi-pick:checked').forEach((x) => { x.checked = false; });
      c.checked = true;
      gitExploreMajCompte();   // cocher par le code ne déclenche pas `change`
    }
    const go = $('#gitExploreGo');
    if (go) go.click();
    toast(tr('notes.todo.branch-go', { branch: br.dataset.todoBranchName || '' }));
    return;
  }
  const c = e.target.closest && e.target.closest('[data-todo-container]');
  if (c) { navTab('docker'); showDockerSub('compose'); return; }
});

// L'iid affiché vient de l'index d'autolink : la todo ne stocke que l'id interne, et un
// numéro interne n'a jamais rien dit à personne.
function todoMrIid(mrId) {
  for (const [iid, cands] of Object.entries(NOTES.index.mrs || {})) {
    if (cands.some((c) => String(c.id) === String(mrId))) return iid;
  }
  return '?';
}

async function loadTodos() {
  const box = $('#todoList');
  if (!box) return;
  /* Le filtre restauré doit se VOIR : afficher « Faites » avec « À faire » en surbrillance
     ferait douter de la liste avant de douter du bouton. */
  $$('#tab-notes .todo-filter button').forEach((x) => x.classList.toggle('active', x.dataset.tfilter === NOTES.filter));
  box.innerHTML = skeleton(4);
  /* Le bouton « partager » dépend de l'état du partage : sans lui, une première visite
     directe des todos ne le montrait pas. */
  await Promise.all([notesIndex(), partageActif().catch(() => null)]);
  let d;
  try { d = await api(`/todos?status=${encodeURIComponent(NOTES.filter)}`); }
  catch (e) { box.innerHTML = `<p class="err">${esc(explainError(e.message))}</p>`; return; }
  renderTodos(d.todos || []);
}

function renderTodos(rows) {
  NOTES.affichees = rows;   // le crayon existe aussi sous « Faites » et « Archivées »
  const box = $('#todoList');
  const info = $('#todoInfo');
  if (info) info.textContent = rows.length ? tr('notes.todo.count', { n: rows.length, count: rows.length }) : '';
  /* La pastille du sous-onglet ne bouge QUE sur la vue « à faire » : sur les faites ou les
     archivées, elle annoncerait un travail en attente qui n'existe pas. */
  if (NOTES.filter === 'open') {
    const b = $('#notesTodoCount');
    if (b) { b.hidden = !rows.length; b.textContent = String(rows.length); }
  }
  if (!rows.length) {
    const texte = NOTES.filter === 'archived'
      ? tr('notes.todo.empty.archived', { n: 7 })
      : NOTES.filter === 'done' ? tr('notes.todo.empty.done') : tr('notes.todo.empty.text');
    box.innerHTML = emptyState({ icon: 'check', title: esc(tr('notes.todo.empty.title')), text: esc(texte) });
    return;
  }
  /* On ne réordonne que « à faire » : les faites et les archivées ont un ordre chronologique
     qui leur est propre, et les arranger à la main n'aurait aucun sens. */
  const ordonnable = NOTES.filter === 'open';
  /* On ne réordonne qu'À L'INTÉRIEUR d'une priorité : la liste est d'abord triée par priorité,
     donc emmener une todo dans un autre groupe la ferait revenir aussitôt — un geste qui
     n'aboutit pas est pire que pas de geste. Les flèches s'éteignent donc aux bords du groupe. */
  const memeGroupe = (a, b2) => a && b2 && a.priority === b2.priority;
  box.innerHTML = rows.map((t, i) => `<div class="todo-row card${t.status === 'done' ? ' done' : ''}${ordonnable ? ' todo-move' : ''}" data-todo="${t.id}" data-prio="${esc(t.priority)}"${ordonnable ? ' draggable="true"' : ''}>
      ${ordonnable ? `<span class="todo-grip" aria-hidden="true" title="${esc(tr('notes.todo.reorder-title'))}">${svgIco('grip')}</span>` : ''}
      <input type="checkbox" class="todo-check" data-todo-check="${t.id}"${t.status === 'done' ? ' checked' : ''} aria-label="${esc(tr('notes.todo.done'))}" />
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(t.title)}${t.shared ? ` <span class="note-partagee" title="${esc(tr('todo.shared-mark'))}">${svgIco('users')}</span>${auteurPartage(t)}` : ''}</div>
        <div class="meta">${todoPrioBadge(t.priority)}${todoDueHtml(t)}${todoLinkHtml(t)}${todoEtatMr(t)}${todoEtatTicket(t)}
          ${t.archived_at ? `<span class="muted">${esc(tr('notes.todo.archived-at', { date: fmtDate(t.archived_at) }))}</span>` : ''}</div>
        ${t.note ? `<div class="todo-note md-body">${renderNoteMd(t.note)}</div>` : ''}
      </div>
      ${t.due_at && t.status === 'open' ? todoSnoozeHtml(t.id) : ''}
      ${ordonnable ? `<button type="button" class="btn btn-sm btn-ghost" data-todo-up="${t.id}"${memeGroupe(rows[i - 1], t) ? '' : ' disabled'} title="${esc(tr('notes.todo.up'))}" aria-label="${esc(tr('notes.todo.up'))}">${svgIco('up')}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-todo-down="${t.id}"${memeGroupe(rows[i + 1], t) ? '' : ' disabled'} title="${esc(tr('notes.todo.down'))}" aria-label="${esc(tr('notes.todo.down'))}">${svgIco('down')}</button>` : ''}
      ${/* A42 — UNE TODO DEVIENT UNE SESSION. Le chemin inverse existe depuis longtemps (une
            session pose une todo) ; celui-ci manquait, alors que c'est le geste du matin :
            « corriger le cache Redis » est écrit, il n'y a plus qu'à le faire faire. Le titre
            et la note deviennent la demande, le lien (MR ou dépôt) devient la cible. */''}
      ${t.status === 'open' ? `<button type="button" class="btn btn-sm btn-ghost" data-todo-code="${t.id}" title="${esc(tr('notes.todo.to-session-title'))}">${svgIco('bot')}</button>` : ''}
      ${/* UNE TODO EST PERSONNELLE PAR NATURE : elle ne part à l'équipe que si on le dit. Les
            todos AUTOMATIQUES (veille Jira, question d'un agent) n'ont pas de bouton du tout —
            elles ne partent jamais, et proposer la bascule serait mentir. */''}
      ${partageEtMoi && partageEtMoi.partage && !t.auto_kind
    ? `<button type="button" class="btn btn-sm btn-ghost${t.shared ? ' active' : ''}" data-todo-share="${t.id}" data-on="${t.shared ? 1 : 0}" title="${esc(tr(t.shared ? 'todo.unshare' : 'todo.share'))}">${svgIco('users')}</button>` : ''}
      <button type="button" class="btn btn-sm btn-ghost" data-todo-edit="${t.id}" title="${esc(tr('notes.todo.edit-title'))}">${svgIco('edit')}</button>
      <button type="button" class="btn btn-sm btn-ghost btn-danger" data-todo-del="${t.id}" title="${esc(tr('notes.todo.delete-title'))}">${svgIco('trash')}</button>
    </div>`).join('');
}

/* Partager une todo, ou cesser de la partager. Délégué une fois, comme pour les sessions. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-todo-share]');
  if (!b) return;
  const shared = b.dataset.on !== '1';
  try {
    await api(`/todos/${b.dataset.todoShare}`, { method: 'PUT', body: { shared: shared ? 1 : 0 } });
    toast(tr(shared ? 'todo.shared' : 'todo.unshared'));
    loadTodos();
  } catch (err) { toast(explainError(err.message), true); }
});

/* A42 — « FAIRE FAIRE CETTE TODO ». On ouvre la modale de codage remplie de ce que la todo
   sait : son titre et sa note deviennent la demande, et son lien la cible — une todo liée à
   une merge request ouvre la session SUR cette branche (le chemin que « Faire corriger »
   emprunte déjà), une todo liée à un dépôt le pré-sélectionne. Rien n'est lancé : c'est un
   formulaire qu'on relit, comme partout ailleurs. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-todo-code]');
  if (!b) return;
  const t2 = (NOTES.affichees || []).find((x) => String(x.id) === b.dataset.todoCode);
  if (!t2) return;
  const demande = [t2.title, t2.note].filter(Boolean).join('\n\n');
  /* La colonne s'appelle `link_ref` — c'est elle que le serveur sert. `link_id` n'a jamais
     existé : le lien d'une todo était donc silencieusement ignoré, et « faire faire cette
     todo » ouvrait une session sans cible. */
  if (t2.link_kind === 'mr' && t2.link_ref) {
    let m = reportRows.find((x) => x.id === Number(t2.link_ref)) || toReviewRows.find((x) => x.id === Number(t2.link_ref));
    if (!m) { try { m = (await api(`/mrs/${t2.link_ref}`)).mr; } catch { m = null; } }
    if (m) { await openTaskForMr(m, { prompt: demande, title: tr('notes.todo.to-session-title') }); return; }
  }
  navTab('task');
  await openTaskModal('code');
  const f = $('#taskForm');
  f.prompt.value = demande;
  if (f.label) f.label.value = String(t2.title || '').slice(0, 120);
  if (t2.link_kind === 'repo' && t2.link_ref) renderTargetRows([{ repo_id: Number(t2.link_ref), branch: '' }]);
  proposerBranche();
  f.prompt.focus();
});

/* RÉORDONNER. Deux gestes pour le même résultat : le glisser-déposer, naturel à la souris,
   et deux flèches — qui existent pour le clavier et le tactile, où « glisser » n'est ni
   annonçable ni fiable. Les deux passent par la même route : l'écran envoie l'ordre COMPLET
   qu'il affiche, le serveur numérote. */
async function enregistrerOrdreTodos(ids) {
  try {
    await api('/todos/reorder', { method: 'POST', body: { ids } });
    NOTES.affichees = ids.map((id) => NOTES.affichees.find((t) => t.id === id)).filter(Boolean);
    renderTodos(NOTES.affichees);
  } catch (e) { toast(explainError(e.message), true); loadTodos(); }
}

function deplacerTodo(id, delta) {
  const liste = NOTES.affichees;
  const i = liste.findIndex((t) => t.id === Number(id));
  const j = i + delta;
  if (i === -1 || j < 0 || j >= liste.length) return;
  // Jamais hors du groupe de priorité : la todo reviendrait à sa place au rendu suivant.
  if (liste[j].priority !== liste[i].priority) return;
  const ids = liste.map((t) => t.id);
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  enregistrerOrdreTodos(ids);
}

$('#todoList') && $('#todoList').addEventListener('click', (e) => {
  const up = e.target.closest('[data-todo-up]');
  if (up) { deplacerTodo(up.dataset.todoUp, -1); return; }
  const down = e.target.closest('[data-todo-down]');
  if (down) deplacerTodo(down.dataset.todoDown, 1);
});

/* Glisser-déposer natif. On déplace la ligne DANS le DOM pendant le geste — sans ça, on
   déplace à l'aveugle et on ne sait pas où l'on va lâcher. L'ordre n'est enregistré qu'au
   lâcher : une liste qui appelle le serveur à chaque survol le ferait cent fois. */
let todoTire = null;
$('#todoList') && $('#todoList').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.todo-row.todo-move');
  if (!row) return;
  todoTire = row;
  row.classList.add('dragging');
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.todo); } catch { /* refusé */ } }
});
$('#todoList') && $('#todoList').addEventListener('dragover', (e) => {
  if (!todoTire) return;
  e.preventDefault();
  const cible = e.target.closest('.todo-row.todo-move');
  // Même règle que les flèches : on ne traverse pas une frontière de priorité.
  if (!cible || cible === todoTire || cible.dataset.prio !== todoTire.dataset.prio) return;
  const r = cible.getBoundingClientRect();
  // Au-dessus ou en dessous, selon le côté de la ligne où l'on est : le geste se voit.
  cible.parentNode.insertBefore(todoTire, e.clientY < r.top + r.height / 2 ? cible : cible.nextSibling);
});
$('#todoList') && $('#todoList').addEventListener('drop', (e) => { if (todoTire) e.preventDefault(); });
$('#todoList') && $('#todoList').addEventListener('dragend', () => {
  if (!todoTire) return;
  todoTire.classList.remove('dragging');
  todoTire = null;
  enregistrerOrdreTodos($$('#todoList .todo-row').map((r) => Number(r.dataset.todo)));
});

$$('#tab-notes .todo-filter button').forEach((b) => b.addEventListener('click', () => {
  NOTES.filter = b.dataset.tfilter;
  try { localStorage.setItem('aidevtools_todo_filtre', NOTES.filter); } catch { /* ignore */ }
  $$('#tab-notes .todo-filter button').forEach((x) => x.classList.toggle('active', x === b));
  loadTodos();
}));

// Ajout inline : le champ et le bouton font la même chose, parce qu'on tape puis on
// valide — sans quitter le clavier.
async function todoQuickAdd() {
  const input = $('#todoQuickAdd');
  const titre = (input.value || '').trim();
  if (!titre) return;
  /* La barre affiche la syntaxe courte (`@demain`, `!!`, `!217`, `PROJ-12`) : elle la lit donc,
     comme la capture. Elle envoyait la phrase brute — ni échéance, ni priorité, ni lien. */
  const court = lireCaptureCourte(titre);
  const body = { title: court.title || titre };
  if (court.priority) body.priority = court.priority;
  if (court.due_at) body.due_at = court.due_at;
  if (court.link_kind) {
    const ref = court.link_kind === 'mr' ? idMrDepuisIid(court.link_ref) : court.link_ref;
    if (ref) { body.link_kind = court.link_kind; body.link_ref = ref; } else body.title = titre;
  }
  try {
    await api('/todos', { method: 'POST', body });
    input.value = '';
    await refreshOpenTodos();
    loadTodos();
  } catch (e) { toast(explainError(e.message), true); }
}
$('#todoQuickBtn') && $('#todoQuickBtn').addEventListener('click', () => todoQuickAdd());
$('#todoQuickAdd') && $('#todoQuickAdd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); todoQuickAdd(); }
});

/* Cocher, snoozer, éditer, supprimer — par délégation, parce que ces lignes sont rendues
   à trois endroits (brief, liste, et le brief se re-rend tout seul). */
document.addEventListener('change', async (e) => {
  const cb = e.target.closest && e.target.closest('[data-todo-check]');
  if (!cb) return;
  const id = Number(cb.dataset.todoCheck);
  try {
    await api(`/todos/${id}`, { method: 'PUT', body: { status: cb.checked ? 'done' : 'open' } });
    toast(tr(cb.checked ? 'notes.todo.done' : 'notes.todo.reopened'));
    await refreshOpenTodos();
    if (NOTES.sub === 'todos') loadTodos(); else loadBrief();
  } catch (err) { cb.checked = !cb.checked; toast(explainError(err.message), true); }
});

document.addEventListener('click', async (e) => {
  const sn = e.target.closest && e.target.closest('[data-snooze]');
  if (sn) {
    try {
      await api(`/todos/${Number(sn.dataset.todoId)}`, { method: 'PUT', body: { snooze: sn.dataset.snooze } });
      toast(tr('notes.todo.snoozed'));
      if (NOTES.sub === 'todos') loadTodos(); else loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const del = e.target.closest && e.target.closest('[data-todo-del]');
  if (del) {
    if (!await confirmDialog({
      title: tr('notes.todo.delete'),
      text: tr('notes.todo.confirm-delete', { n: 7 }),
      confirmLabel: tr('notes.todo.delete'),
    })) return;
    try {
      await api(`/todos/${Number(del.dataset.todoDel)}`, { method: 'DELETE' });
      toast(tr('notes.todo.deleted'));
      await refreshOpenTodos();
      loadTodos();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const ed = e.target.closest && e.target.closest('[data-todo-edit]');
  if (ed) openCapture({ editId: Number(ed.dataset.todoEdit) });
});

// Les todos ouvertes en cache : elles servent à savoir si un objet est DÉJÀ suivi, pour ne
// pas proposer d'en créer une seconde qui dirait la même chose.
async function refreshOpenTodos() {
  try { NOTES.open = (await api('/todos?status=open')).todos || []; }
  catch { /* liste indisponible : le bouton proposera simplement de créer */ }
  majBadgeNotes();   // une seule porte d'entrée : qui relit la liste remet les pastilles à jour
}

