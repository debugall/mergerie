'use strict';
/* Jira : tickets surveillés, la pastille du menu, les menus de filtre, insérer une référence. */
// @expose showJiraSub
/* ---------- Jira : tickets surveillés ----------------------------------------
   Surveiller un ticket n'a rien à voir avec « m'être affecté » : on suit souvent un ticket
   tenu par quelqu'un d'autre parce qu'il débloque le sien. C'est précisément pour ça que
   cette liste est un SOUS-ONGLET et pas un filtre de la première : elle n'a ni la même
   source, ni le même sens, et les mélanger rendrait le compteur incompréhensible. */
const JIRA_WATCH = { rows: [], keys: new Set(), selectedKey: null };
const jiraIsWatched = (key) => JIRA_WATCH.keys.has(String(key || '').toUpperCase());

function renderJiraWatch() {
  const box = $('#jiraWatchList'); if (!box) return;
  const rows = JIRA_WATCH.rows;
  const pastille = $('#jiraWatchCount');
  if (pastille) { pastille.textContent = rows.length; pastille.hidden = !rows.length; }
  if (!rows.length) {
    box.innerHTML = emptyState({ icon: 'eye', title: tr('jira.watch.empty.title'), text: tr('jira.watch.empty.text') });
    return;
  }
  box.innerHTML = rows.map((r) => `<div class="jira-item jira-watch-item jira-cat-${JIRA_CAT[r.status_category] || 'todo'}${r.key === JIRA_WATCH.selectedKey ? ' active' : ''}" data-jirawatchopen="${esc(r.key)}">
      <div class="jira-item-row1">
        ${r.url
          ? `<a class="jira-key jira-key-link" href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jira.watch.open', { key: r.key }))}">${esc(r.key)} ↗</a>`
          : `<code class="jira-key">${esc(r.key)}</code>`}
        <span class="jira-status jira-status-${JIRA_CAT[r.status_category] || 'todo'}">${esc(r.status || '—')}</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-icon btn-sm btn-danger" data-jiraunwatch="${esc(r.key)}" title="${esc(tr('jira.watch.stop-title'))}"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
      <div class="jira-item-summary">${esc(r.summary || '')}</div>
      ${/* A/Jira 3 — L'ERREUR DE SURVEILLANCE ÉTAIT ÉCRITE ET JAMAIS AFFICHÉE : un ticket dont
            la vérification échoue (clé renommée, accès retiré, Jira injoignable) restait figé
            sur son dernier état connu, en silence, et on le croyait simplement immobile. */''}
      ${r.error ? `<div class="jira-watch-err"><svg class="ico ico-sm"><use href="#i-alert"/></svg> ${esc(tr('jira.watch.error', { detail: String(r.error).slice(0, 200) }))}</div>` : ''}
      ${/* La raison de surveiller. Absente, on propose de la dire : trois mois plus tard, une
            clé et un résumé ne rappellent plus pourquoi ce ticket est là. */''}
      ${/* B5 — la case qui transforme un changement d'état en todo. Décochée par défaut :
            une todo par mouvement de chaque ticket surveillé serait du bruit. */''}
      <label class="inline-check jira-watch-todo"><input type="checkbox" data-jiratodo="${esc(r.key)}"${r.todo_on_change ? ' checked' : ''} />
        <span>${esc(tr('jira.watch.todo-on-change'))}</span></label>
      <div class="jira-watch-note-row">
        ${r.note
    ? `<span class="jira-watch-note">${esc(r.note)}</span>`
    : `<span class="muted">${esc(tr('jira.watch.note-add'))}</span>`}
        <button type="button" class="btn btn-icon btn-sm" data-jiranote="${esc(r.key)}" title="${esc(tr('jira.watch.note-edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg></button>
      </div>
      <div class="jira-note-form" data-jiranoteform="${esc(r.key)}" hidden>
        <textarea class="jira-note-input" rows="3" maxlength="500" placeholder="${esc(tr('jira.watch.note-ph'))}" title="${esc(tr('jira.watch.note-hint'))}">${esc(r.note || '')}</textarea>
        <div class="jira-note-actions">
          <button type="button" class="btn btn-sm" data-jiranotecancel="${esc(r.key)}">${esc(tr('ui.cancel'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-jiranotesave="${esc(r.key)}">${esc(tr('jira.watch.note-save'))}</button>
        </div>
      </div>
      <div class="jira-item-foot muted">${r.changed_at
        ? esc(tr('jira.watch.changed-at', { at: fmtDate(r.changed_at) }))
        : esc(tr('jira.watch.no-change'))}${r.checked_at ? ` · ${esc(tr('jira.watch.checked-at', { at: fmtDate(r.checked_at) }))}` : ''}</div>
      ${r.error ? `<div class="jira-item-foot err">${esc(r.error)}</div>` : ''}
    </div>`).join('');
}

async function loadJiraWatch() {
  let d;
  try { d = await api('/jira/watch'); }
  catch { return; }   // la surveillance ne doit jamais casser l'onglet
  JIRA_WATCH.rows = d.watched || [];
  JIRA_WATCH.keys = new Set(JIRA_WATCH.rows.map((r) => String(r.key).toUpperCase()));
  renderJiraWatch();
}

async function jiraWatchAdd(key, note) {
  const k = String(key || '').trim().toUpperCase();
  if (!k) return;
  await api('/jira/watch', { method: 'POST', body: { key: k, note: note || '' } });
  await loadJiraWatch();
  toast(tr('toast.jira.watch-added', { key: k }));
}

$('#jiraWatchAdd') && $('#jiraWatchAdd').addEventListener('click', async (e) => {
  const inp = $('#jiraWatchKey');
  await busy(e.currentTarget, async () => {
    const note = $('#jiraWatchNote');
    try { await jiraWatchAdd(inp.value, note && note.value); inp.value = ''; if (note) note.value = ''; }
    catch (err) { toast(explainError(err.message), true); }
  });
});
$('#jiraWatchKey') && $('#jiraWatchKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#jiraWatchAdd').click(); }
});
/* La note est un textarea : Entrée y passe à la ligne, sinon on ne pourrait pas écrire les
   deux phrases pour lesquelles on l'a agrandie. C'est Ctrl/Cmd + Entrée qui valide. */
$('#jiraWatchNote') && $('#jiraWatchNote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#jiraWatchAdd').click(); }
});
$('#jiraWatchList') && $('#jiraWatchList').addEventListener('keydown', (e) => {
  const champ = e.target.closest && e.target.closest('.jira-note-input');
  if (!champ) return;
  const f = champ.closest('.jira-note-form');
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const b = $('[data-jiranotesave]', f); if (b) b.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const b = $('[data-jiranotecancel]', f); if (b) b.click();
  }
});
$('#jiraWatchList') && $('#jiraWatchList').addEventListener('change', async (e) => {
  const c = e.target.closest && e.target.closest('[data-jiratodo]');
  if (!c) return;
  try {
    await api(`/jira/watch/${encodeURIComponent(c.dataset.jiratodo)}`, { method: 'PATCH', body: { todo_on_change: c.checked } });
  } catch (err) { toast(explainError(err.message), true); c.checked = !c.checked; }
});
$('#jiraWatchList') && $('#jiraWatchList').addEventListener('click', async (e) => {
  const form = (key) => $(`#jiraWatchList .jira-note-form[data-jiranoteform="${key}"]`);

  const ouvrir = e.target.closest('[data-jiranote]');
  if (ouvrir) {
    const f = form(ouvrir.dataset.jiranote);
    if (f) { f.hidden = false; const i = $('.jira-note-input', f); i.focus(); i.select(); }
    return;
  }
  const annuler = e.target.closest('[data-jiranotecancel]');
  if (annuler) {
    const f = form(annuler.dataset.jiranotecancel);
    // On rétablit la valeur enregistrée : annuler doit vraiment annuler, y compris à la réouverture.
    const ligne = JIRA_WATCH.rows.find((r) => r.key === annuler.dataset.jiranotecancel);
    if (f) { $('.jira-note-input', f).value = (ligne && ligne.note) || ''; f.hidden = true; }
    return;
  }
  const enregistrer = e.target.closest('[data-jiranotesave]');
  if (enregistrer) {
    const key = enregistrer.dataset.jiranotesave;
    const f = form(key);
    try {
      await busy(enregistrer, () => api(`/jira/watch/${encodeURIComponent(key)}`, {
        method: 'PATCH', body: { note: $('.jira-note-input', f).value },
      }));
      await loadJiraWatch();
      toast(tr('jira.watch.note-saved', { key }));
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }

  const b = e.target.closest('[data-jiraunwatch]');
  if (b) {
    try {
      await api(`/jira/watch/${encodeURIComponent(b.dataset.jiraunwatch)}`, { method: 'DELETE' });
      // Le ticket retiré était peut-être celui affiché à droite : le panneau doit suivre.
      if (JIRA_WATCH.selectedKey === b.dataset.jiraunwatch) {
        JIRA_WATCH.selectedKey = null;
        $('#jiraWatchDetail').innerHTML = '';
      }
      await loadJiraWatch();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }

  /* Clic sur la carte : on ouvre le ticket à droite. Les contrôles de la carte (retirer,
     modifier la raison, lien vers Jira) gardent leur propre effet — sans cette exclusion,
     ouvrir le formulaire de note sélectionnerait aussi le ticket, ce qui n'est pas demandé. */
  const carte = e.target.closest('[data-jirawatchopen]');
  if (carte && !e.target.closest('button, a, input, textarea, .jira-note-form')) {
    selectJiraIssue(carte.dataset.jirawatchopen, 'watch');
  }
});
$('#jiraWatchCheck') && $('#jiraWatchCheck').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    const r = await api('/jira/watch/check', { method: 'POST' });
    await loadJiraWatch();
    // On dit ce qui a été VU, pas « c'est fait » : zéro changement est une information.
    toast(tr(r.changed ? 'toast.jira.watch-changed' : 'toast.jira.watch-none', { n: r.changed, count: r.changed }));
  } catch (err) { toast(explainError(err.message), true); }
}));

// Bouton « Surveiller » du détail d'un ticket : bascule, puis redessine l'en-tête.
/* Le détail vit dans deux panneaux (Mes tickets · Surveillés) et porte les mêmes actions.
   On câble donc chaque gestionnaire SUR LES DEUX, une fois pour toutes : dupliquer les
   écouteurs par sous-onglet, c'est se garantir qu'une action marchera d'un côté seulement. */
function surLeDetailJira(type, handler) {
  /* Le panneau est relevé AVANT le premier `await` : `e.currentTarget` n'est valable que pendant
     la distribution de l'événement, et relu après une requête il valait toujours null — toute
     action passait pour venir de « Mes tickets ». */
  $$('.js-jira-detail').forEach((el) => el.addEventListener(type, (e) => {
    e.panneauJira = el.id === 'jiraWatchDetail' ? 'watch' : 'mine';
    return handler(e);
  }));
}
// Dans quel panneau l'action a-t-elle eu lieu ? Ce qui est rechargé ensuite en dépend :
// recharger « Mes tickets » depuis le panneau des surveillés viderait celui qu'on regarde.
const ouDuDetail = (e) => e.panneauJira || 'mine';

surLeDetailJira('click', async (e) => {
  const b = e.target.closest('[data-jirawatch]'); if (!b) return;
  const key = b.dataset.jirawatch;
  try {
    if (jiraIsWatched(key)) { await api(`/jira/watch/${encodeURIComponent(key)}`, { method: 'DELETE' }); await loadJiraWatch(); toast(tr('toast.jira.watch-removed', { key })); }
    else await jiraWatchAdd(key);
    selectJiraIssue(key, ouDuDetail(e));
  } catch (err) { toast(explainError(err.message), true); }
});

// Sous-onglets de Jira.
function showJiraSub(sub) {
  $$('#tab-jira .subnav [data-jsub]').forEach((b) => b.classList.toggle('active', b.dataset.jsub === sub));
  $('#jiraSubMine').hidden = sub !== 'mine';
  $('#jiraSubWatch').hidden = sub !== 'watch';
  if (sub === 'watch') loadJiraWatch();
}
$$('#tab-jira .subnav [data-jsub]').forEach((b) => b.addEventListener('click', () => showJiraSub(b.dataset.jsub)));

/* Pastille du menu : combien de tickets me sont affectés ET en cours. La valeur vient d'un
   cache serveur, jamais d'un appel Jira direct — on peut donc l'interroger tranquillement
   sans dépendre de l'ouverture de l'onglet. */
async function refreshJiraBadge() {
  const el = $('#navCountJira'); if (!el) return;
  try {
    const d = await api('/jira/badge');
    const n = d.configured ? (d.inProgress || 0) : 0;
    el.textContent = n;
    el.hidden = !n;
    el.title = n ? tr('jira.badge.title', { n, count: n }) : '';
  } catch { /* pastille : jamais bloquante */ }
}
setInterval(refreshJiraBadge, 60000);
refreshJiraBadge();

$('#jiraRefresh') && $('#jiraRefresh').addEventListener('click', loadJira);
$('#jiraIncludeDone') && $('#jiraIncludeDone').addEventListener('change', (e) => {
  try { localStorage.setItem('aidevtools_jira_done', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  loadJiraTickets(); // re-fetch (le filtre terminés change la requête), garde le pool d'assignés
});
$('#jiraAssigneeFilterBody') && $('#jiraAssigneeFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  const set = jiraCheckedSet();
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  setJiraCheckedAssignees([...set]);
  jiraUpdateAssigneeCount(); // maj du compteur SANS reconstruire (préserve la recherche)
  loadJiraTickets();         // les assignés cochés changent la requête serveur
});
/* « Tout cocher » / « Tout décocher » des deux filtres. Les deux boutons vont ensemble : sans
   le premier, décocher tout devient un aller sans retour — il faudrait recocher une à une les
   quinze lignes qu'on vient de vider. */
/* Ciblage explicite : un `[data-jsfnone]` nu attrapait aussi le bouton du filtre par sprint,
   qui a son propre gestionnaire — et le faisait passer par la branche « statuts ». */
$$('[data-jsfall="assignee"], [data-jsfnone="assignee"], [data-jsfall="status"], [data-jsfnone="status"]').forEach((b) => b.addEventListener('click', () => {
  const quoi = b.dataset.jsfall || b.dataset.jsfnone;
  const tout = !!b.dataset.jsfall;
  if (quoi === 'assignee') {
    // Sélection vide = aucune contrainte d'assigné : le serveur renvoie tout ce que le compte voit.
    setJiraCheckedAssignees(tout ? JIRA.people.map((p) => p.accountId) : []);
    renderJiraAssigneeFilter();
    loadJiraTickets();          // les assignés cochés changent la requête serveur
  } else {
    const statuts = jiraDistinctStatuses().map((x) => x.status);
    setJiraHiddenStatuses(new Set(tout ? [] : statuts));
    renderJiraStatusFilter();
    renderJiraList();
    loadJiraTickets();
  }
}));

/* Un <details> ne se referme pas tout seul quand on clique ailleurs. Devenus des menus
   flottants au-dessus de la liste, ils masqueraient les tickets tant qu'on ne les rouvre pas. */
document.addEventListener('click', (e) => {
  /* Un bouton du menu qui se redessine (retirer un critère) n'est plus dans la page quand ce
     gestionnaire passe : il n'est pas « ailleurs », il est parti. Sans ce test, le menu se
     refermait sous le doigt. */
  if (!e.target.isConnected) return;
  for (const d of $$('.jira-filters > details[open]')) {
    if (!d.contains(e.target)) d.open = false;
  }
});

$('#jiraAssigneeSearch') && $('#jiraAssigneeSearch').addEventListener('input', jiraFilterAssigneeSearch);
$('#jiraStatusSearch') && $('#jiraStatusSearch').addEventListener('input', jiraFilterStatusSearch);
$('#jiraSearch') && $('#jiraSearch').addEventListener('input', renderJiraList);
$('#jiraStatusFilterBody') && $('#jiraStatusFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  const hidden = jiraHiddenStatuses();
  if (cb.checked) hidden.delete(cb.value); else hidden.add(cb.value);
  setJiraHiddenStatuses(hidden);
  jiraUpdateStatusFilterCount();
  renderJiraList();          // réponse immédiate, sans attendre le serveur
  loadJiraTickets();         // …puis on redemande : l'exclusion est appliquée par Jira
});
$('#jiraList') && $('#jiraList').addEventListener('click', (e) => {
  /* Dans la LISTE, l'epic n'est qu'une information : la carte est un bouton de sélection, et y
     loger une seconde cible de clic obligeait à viser. Le lien vers Jira vit dans le détail. */
  const b = e.target.closest('[data-jira]'); if (b) selectJiraIssue(b.dataset.jira);
});
// Lightbox : clic sur une vignette d'image → aperçu en grand (Échap/clic dehors ferme, cf. handler modales).
surLeDetailJira('click', (e) => {
  const code = e.target.closest('[data-jiracode]');
  if (code) { openTaskForJira(code.dataset.jiracode).catch((err) => toast(explainError(err.message), true)); return; }
  const img = e.target.closest('[data-jimg]'); if (!img) return; // vignettes ET images inline
  e.preventDefault();
  $('#jiraLightboxImg').src = img.dataset.jimg;
  $('#jiraLightboxImg').alt = img.dataset.jname || '';
  $('#jiraLightboxName').textContent = img.dataset.jname || '';
  $('#jiraLightboxOpen').href = safeUrl(img.dataset.jimg);
  $('#jiraLightbox').hidden = false;
});
$('#jiraLightbox') && $('#jiraLightbox').addEventListener('click', (e) => {
  // Clic sur le fond (pas sur l'image ni la légende) → fermer.
  if (e.target.id === 'jiraLightbox') e.currentTarget.hidden = true;
});
// Changer l'état du ticket : sélection d'une transition → POST → recharge le détail (+ la liste).
surLeDetailJira('change', async (e) => {
  const sel = e.target.closest('.jira-transition'); if (!sel || !sel.value) return;
  const key = sel.dataset.key; const transitionId = sel.value;
  /* A/Jira 2 (C9) — CHANGER L'ÉTAT D'UN TICKET EST UNE ÉCRITURE CHEZ LES AUTRES, et c'était
     la seule de l'outil sans confirmation : un `<select>` natif applique au `change`, donc
     une flèche du clavier suffisait à faire passer PROJ-1408 en « Terminé » devant toute
     l'équipe. Le lancement Jenkins, la publication d'un rapport et « Prévenir Jira »
     demandent tous ; celui-ci demande aussi, et NOMME le ticket et l'état visé. */
  const versEtat = (sel.options[sel.selectedIndex] || {}).textContent || '';
  if (!await confirmDialog({
    title: tr('jira.transition.confirm.title', { key }),
    text: tr('jira.transition.confirm.text', { key, etat: String(versEtat).replace(/^→\s*/, '') }),
    confirmLabel: tr('jira.transition.confirm.ok'), danger: false,
  })) { sel.value = ''; return; }
  sel.disabled = true;
  try {
    await api(`/jira/issue/${encodeURIComponent(key)}/transition`, { method: 'POST', body: { transitionId } });
    toast(tr('jira.status-changed'));
    await selectJiraIssue(key, ouDuDetail(e)); // détail re-fetché : nouvel état + nouvelles transitions possibles
    // La pastille du menu compte les tickets EN COURS : ce qu'on vient de faire la change.
    // Sans ça elle reste fausse jusqu'au prochain sondage, soit une minute d'affichage faux.
    refreshJiraBadge();
  } catch (err) { toast(explainError(err.message), true); sel.disabled = false; }
});
/* Insérer une référence AU CURSEUR, sans écraser ce qui est déjà écrit : on commente
   rarement avec un lien seul — « c'est parti en recette, voir !217 ». */
surLeDetailJira('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-jira-insert]');
  if (!b) return;
  const form = b.closest('.jira-comment-form');
  const ta = form && $('.jira-comment-input', form);
  if (!ta) return;
  const t = b.dataset.jiraInsert;
  const i = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const j = ta.selectionEnd == null ? i : ta.selectionEnd;
  const avant = ta.value.slice(0, i);
  const sep = avant && !/\s$/.test(avant) ? ' ' : '';
  ta.value = avant + sep + t + ta.value.slice(j);
  ta.focus();
  const pos = (avant + sep + t).length;
  ta.setSelectionRange(pos, pos);
  ecrireBrouillon(`jira:${form.dataset.key}`, ta.value.trim());
});

// Poster un commentaire : on l'ajoute au détail affiché sans tout recharger.
surLeDetailJira('submit', async (e) => {
  const form = e.target.closest('.jira-comment-form'); if (!form) return;
  e.preventDefault();
  const key = form.dataset.key;
  const ta = $('.jira-comment-input', form);
  const text = (ta.value || '').trim();
  if (!text) { toast(tr('err.jira.comment-empty'), true); return; }
  const btn = $('button[type="submit"]', form);
  try {
    const d = await busy(btn, () => api(`/jira/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { text } }));
    toast(tr('jira.comment-added'));
    ecrireBrouillon(`jira:${key}`, '');   // parti : le filet n'a plus lieu d'être
    if (JIRA.current && JIRA.current.key === key && d.comment) {
      JIRA.current.comments = [...(JIRA.current.comments || []), d.comment];
      renderJiraDetail(JIRA.current, JIRA.currentBox);
    } else { await selectJiraIssue(key, ouDuDetail(e)); }
  } catch (err) { toast(explainError(err.message), true); }
});
