'use strict';
/* Jira : ce qui est déjà engagé sur chaque carte, les tickets liés, le détail, ouvrir un ticket depuis ailleurs. */
// @expose loadJira, ouvrirTicketJira
/* CE QUI EST DÉJÀ ENGAGÉ, SUR CHAQUE CARTE DE LA LISTE. En parcourant ses tickets on voit
   lesquels ont une merge request et lesquels ont une session en cours — sans les ouvrir un par
   un. Un seul appel pour la liste ; un ticket sans engagement n'affiche rien du tout. */
let engSeq = 0;
async function majEngagementsListe(cles) {
  if (!cles.length) return;
  const seq = ++engSeq;
  let d;
  try { d = await api(`/jira/engagements?keys=${encodeURIComponent(cles.join(','))}`); } catch { return; }
  if (seq !== engSeq) return;
  for (const el of $$('[data-eng-key]')) {
    const e2 = (d.engagements || {})[String(el.dataset.engKey).toUpperCase()];
    const bouts = [];
    if (e2 && e2.mr) {
      bouts.push(`!${e2.mr.iid}${e2.mr.note != null ? ` · ${fmtNote10(e2.mr.note * 10)}` : ''}`);
      if (e2.mrs > 1) bouts.push(tr('jira.eng.more-mrs', { n: e2.mrs - 1, count: e2.mrs - 1 }));
    }
    if (e2 && e2.running) bouts.push(tr('jira.eng.running'));
    else if (e2 && e2.tasks) bouts.push(tr('jira.eng.tasks', { n: e2.tasks, count: e2.tasks }));
    el.hidden = !bouts.length;
    el.textContent = bouts.join(' · ');
  }
}

function jiraMetaRow(label, valueHtml) {
  if (!valueHtml) return '';
  return `<div class="jira-meta-row"><span class="jira-meta-label muted">${esc(label)}</span><span class="jira-meta-val">${valueHtml}</span></div>`;
}

/* LES TICKETS LIÉS. « Bloque », « est bloqué par », « duplique » : ce sont eux qui disent ce
   qu'on ne peut pas livrer seul, et la fiche les taisait — il fallait rouvrir Jira pour les
   voir. Le libellé de la relation vient de l'instance (donc déjà dans sa langue) et fait le
   REGROUPEMENT : cinq « est bloqué par » sont une liste, pas cinq fois la même étiquette.
   La clé ouvre le ticket ICI, sans quitter l'onglet ; la flèche l'ouvre dans Jira. */
function jiraRelatedBlock(it) {
  const list = (it.related || []).filter((r) => r && r.key);
  if (!list.length) return '';
  const groupes = new Map();
  for (const r of list) {
    const cle = r.relation || tr('jira.rel.parent');
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(r);
  }
  const ligne = (r) => `<li class="jira-rel-row${r.statusCategory === 'done' ? ' jira-rel-done' : ''}">
      ${r.typeIcon ? `<img class="jira-rel-icon" src="${esc(safeImg(r.typeIcon))}" alt="${esc(r.type)}" title="${esc(r.type)}" loading="lazy" />` : ''}
      <button type="button" class="jira-rel-key" data-jira-open="${esc(r.key)}" title="${esc(tr('jira.related.open', { key: r.key, summary: r.summary }))}">${esc(r.key)}</button>
      <span class="jira-rel-sum">${esc(r.summary)}</span>
      <span class="spacer"></span>
      ${jiraStatusChip(r)}
      <a class="jira-rel-ext" href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jira.related.jira', { key: r.key }))}" aria-label="${esc(tr('jira.related.jira', { key: r.key }))}">↗</a>
    </li>`;
  const corps = [...groupes.entries()].map(([rel, rows]) => `<div class="jira-rel-group">
      <div class="jira-rel-rel muted">${esc(rel)}</div>
      <ul class="jira-rel-list">${rows.map(ligne).join('')}</ul>
    </div>`).join('');
  return `<div class="jira-section jira-related"><h4>${esc(tr('jira.related', { n: list.length, count: list.length }))}</h4>${corps}</div>`;
}

function jiraAttachmentsBlock(it) {
  const list = it.attachments || [];
  if (!list.length) return '';
  const src = (a) => `/api/jira/attachment/${encodeURIComponent(a.id)}`;
  const isImg = (a) => /^image\//i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.filename || '');
  // Les IMAGES s'affichent directement (aperçu chargé via le proxy) ; clic = plein écran.
  const images = list.filter(isImg).map((a) => `<a class="jira-img" href="${esc(safeUrl(src(a)))}" data-jimg="${esc(safeUrl(src(a)))}" data-jname="${esc(a.filename)}" title="${esc(a.filename)}">
      <img src="${esc(safeImg(src(a)))}" alt="${esc(a.filename)}" loading="lazy" />
      <span class="jira-img-name muted">${esc(a.filename)}</span>
    </a>`).join('');
  // Les autres fichiers restent en « chip » téléchargeable.
  const files = list.filter((a) => !isImg(a)).map((a) => `<a class="jira-attach" href="${esc(safeUrl(src(a)))}" download="${esc(a.filename)}" title="${esc(tr('jira.download'))}">
      <svg class="ico"><use href="#i-clip"/></svg>
      <span class="jira-attach-name">${esc(a.filename)}</span>
      <span class="jira-attach-size muted">${esc(jiraSize(a.size))}</span>
      <svg class="ico ico-sm jira-attach-dl"><use href="#i-download"/></svg>
    </a>`).join('');
  return `<div class="jira-section"><h4>${esc(tr('jira.attachments', { n: list.length, count: list.length }))}</h4>
      ${images ? `<div class="jira-img-grid">${images}</div>` : ''}
      ${files ? `<div class="jira-attachments">${files}</div>` : ''}</div>`;
}

/* Le détail d'un ticket s'affiche dans DEUX endroits — « Mes tickets » et « Surveillés » —
   avec exactement les mêmes actions (transitions, commentaires, pièces jointes, « faire coder
   l'IA »). D'où un conteneur en paramètre plutôt qu'un second rendu : deux copies finiraient
   par diverger, et c'est le genre d'écart qu'on ne voit qu'en production. */
function renderJiraDetail(it, box = $('#jiraDetail')) {
  if (!box) return;
  JIRA.current = it || null; // gardé pour ajouter un commentaire sans tout recharger
  JIRA.currentBox = box;     // …et pour le réafficher au bon endroit
  if (!it) { box.innerHTML = ''; return; }
  const person = (p) => (p ? esc(p.name) : '—');
  const chips = [
    it.type ? `<span class="jira-chip">${esc(it.type)}</span>` : '',
    it.priority ? `<span class="jira-chip">${esc(tr('jira.meta.priority'))} : ${esc(it.priority)}</span>` : '',
    it.assignee ? `<span class="jira-chip">${esc(tr('jira.meta.assignee'))} : ${esc(it.assignee.name)}</span>` : '',
  ].join('');
  const meta = [
    jiraMetaRow(tr('jira.meta.reporter'), person(it.reporter)),
    jiraMetaRow(tr('jira.meta.project'), esc(it.project)),
    it.epic ? jiraMetaRow(tr('jira.meta.epic'), it.epic.url
      ? `<a href="${esc(safeUrl(it.epic.url))}" target="_blank" rel="noopener noreferrer" class="jira-epic-link" title="${esc(tr('jira.epic-open', { key: it.epic.key, summary: it.epic.summary }))}"><code>${esc(it.epic.key)}</code> ${esc(it.epic.summary)} ↗</a>`
      : `<code>${esc(it.epic.key)}</code> ${esc(it.epic.summary)}`) : '',
    jiraMetaRow(tr('jira.meta.created'), esc(fmtDate(it.created))),
    jiraMetaRow(tr('jira.meta.updated'), esc(fmtDate(it.updated))),
    it.duedate ? jiraMetaRow(tr('jira.meta.due'), esc(fmtDate(it.duedate))) : '',
    (it.labels && it.labels.length) ? jiraMetaRow(tr('jira.meta.labels'), it.labels.map((l) => `<span class="jira-label">${esc(l)}</span>`).join(' ')) : '',
    (it.components && it.components.length) ? jiraMetaRow(tr('jira.meta.components'), esc(it.components.join(', '))) : '',
    (it.fixVersions && it.fixVersions.length) ? jiraMetaRow(tr('jira.meta.fixversions'), esc(it.fixVersions.join(', '))) : '',
  ].join('');
  const cList = (it.comments || []).length
    ? (it.comments || []).map((c) => `<div class="jira-comment">
          <div class="jira-avatar" aria-hidden="true">${esc(jiraInitials(c.author))}</div>
          <div class="jira-comment-main">
            <div class="jira-comment-head"><strong>${esc(c.author)}</strong> <span class="muted">${esc(fmtDate(c.created))}</span></div>
            <div class="jira-comment-body md-body">${mdToHtml(c.bodyMd || '')}</div>
          </div></div>`).join('')
    : `<p class="muted">${esc(tr('jira.no-comment'))}</p>`;
  // Composer : poster un commentaire (texte simple → converti en ADF côté serveur).
  /* A/Jira 3 — LE LIEN DE LA MR, D'UN CLIC. « J'ai poussé, voici la MR » est le commentaire
     Jira le plus fréquent, et il obligeait à retourner dans Reviews chercher l'adresse pour
     la recoller ici. L'outil connaît déjà les merge requests qui portent cette clé (section
     « Dans Mergerie ») : le bouton insère la ligne au curseur, et on écrit autour. */
  const mrsDuTicket = (it.mergerie && it.mergerie.mrs) || [];
  const boutonsLien = mrsDuTicket.filter((m) => m.url).slice(0, 4).map((m) => `<button type="button" class="btn btn-sm"
      data-jira-insert="${esc(`!${m.iid} ${m.url}`)}" title="${esc(tr('jira.insert-mr.title', { iid: m.iid }))}">!${esc(String(m.iid))}</button>`).join('');
  const composer = `<form class="jira-comment-form" data-key="${esc(it.key)}" autocomplete="off">
      <textarea class="jira-comment-input" rows="3" placeholder="${esc(tr('jira.comment-ph'))}"></textarea>
      ${boutonsLien ? `<div class="jira-insert-row"><span class="muted">${esc(tr('jira.insert-mr'))}</span> ${boutonsLien}</div>` : ''}
      <div class="jira-comment-actions"><button class="btn btn-primary btn-sm" type="submit"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('jira.add-comment'))}</button></div>
    </form>`;
  const comments = `<div class="jira-section"><h4>${esc(tr('jira.comments', { n: (it.comments || []).length, count: (it.comments || []).length }))}</h4>${cList}${composer}</div>`;
  box.innerHTML = `<article class="jira-detail-inner jira-cat-${JIRA_CAT[it.statusCategory] || 'todo'}">
      <header class="jira-dhead">
        <div class="jira-dhead-top">
          ${/* C7 — la clé se colle partout : Slack, un commit, une recherche. Elle était
                à resélectionner à la souris. */''}
          <button type="button" class="jira-key jira-key-copy" data-copy-txt="${esc(it.key)}" title="${esc(tr('jira.copy-key'))}">${esc(it.key)}</button>
          ${jiraStatusChip(it)}
          ${(it.transitions && it.transitions.length) ? `<select class="jira-transition" data-key="${esc(it.key)}" aria-label="${esc(tr('jira.change-status'))}">
            <option value="">${esc(tr('jira.change-status'))}</option>
            ${it.transitions.map((tt) => `<option value="${esc(tt.id)}">→ ${esc(tt.to ? tt.to.name : tt.name)}</option>`).join('')}
          </select>` : ''}
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm${jiraIsWatched(it.key) ? ' active' : ''}" data-jirawatch="${esc(it.key)}" title="${esc(tr(jiraIsWatched(it.key) ? 'jira.watch.stop-title' : 'jira.watch.start-title'))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${esc(tr(jiraIsWatched(it.key) ? 'jira.watch.stop' : 'jira.watch.start'))}</button>
          ${/* L'ÉCHÉANCE ET LA PRIORITÉ DU TICKET VIENNENT AVEC : le rappel bureau tombe le bon
                jour sans ressaisie, et une todo « haute » née d'un ticket bloquant se range
                d'elle-même là où on la cherchera. */''}
          ${addTodoBtn('ticket', it.key, tr('notes.add-todo.ticket', { key: it.key, title: String(it.summary || '').slice(0, 60) }), {
    due: echeanceDepuisJira(it.duedate), priority: prioriteDepuisJira(it.priority),
  })}
          ${/* UNE TRACE DANS LE TICKET : « quel dépôt ? quel fichier ? » se répondait au grep
                dans douze clones. Le bouton n'apparaît QUE si le texte porte une trace —
                sinon c'est un bouton qui ne sert à rien sur les neuf tickets sur dix. */''}
          ${detecterTrace(`${it.summary || ''}\n${it.descriptionMd || ''}`) ? `<button type="button" class="btn btn-sm btn-jira-investigate" data-jirakey="${esc(it.key)}" title="${esc(tr('jira.investigate-title'))}"><svg class="ico ico-sm"><use href="#i-search"/></svg>${esc(tr('jira.investigate'))}</button>` : ''}
          <button type="button" class="btn btn-sm btn-primary" data-jiracode="${esc(it.key)}" title="${esc(tr('jira.code-title'))}"><svg class="ico ico-sm"><use href="#i-bot"/></svg>${esc(tr('jira.code'))}</button>
          <a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" class="jira-open">${esc(tr('jira.open'))} ↗</a>
        </div>
        <h2 class="jira-title">${esc(it.summary)}</h2>
        <div class="jira-chips">${chips}</div>
      </header>
      ${/* CE QUI EST DÉJÀ ENGAGÉ. Le ticket ne disait rien du code : on allait le chercher dans
             Reviews à la main. La section arrive vide et se remplit — l'appel est court, et un
             ticket sans engagement n'affiche rien plutôt qu'une section vide. */''}
      <div class="jira-section jira-mergerie" id="jiraMergerie" hidden></div>
      ${/* Le ticket a un dépôt PROBABLE — celui de la merge request ou de la session qui porte
            sa clé : les mêmes boutons y mènent aux mêmes environnements. */''}
      <div class="jira-section jira-liens" data-liens-ticket="${esc(it.key)}"></div>
      <div class="jira-section"><h4>${esc(tr('jira.description'))}</h4>
        <div class="jira-card md-body">${it.descriptionMd ? mdToHtml(it.descriptionMd) : `<p class="muted">${esc(tr('jira.no-description'))}</p>`}</div>
      </div>
      ${jiraAttachmentsBlock(it)}
      ${jiraRelatedBlock(it)}
      <div class="jira-section"><h4>${esc(tr('jira.details'))}</h4><div class="jira-meta">${meta}</div></div>
      ${comments}
    </article>`;
  chargerEngagements(it.key);
  remplirLiensDifferes(box);     // les boutons contextuels du ticket
  /* C8 — le champ de commentaire se souvient et part à Ctrl+Entrée, comme celui de la
     surveillance. Armé APRÈS le rendu : le textarea vient d'être recréé. */
  const taJ = $('.jira-comment-input', box);
  if (taJ) champAvecBrouillon(taJ, `jira:${it.key}`, () => { const f = taJ.closest('form'); if (f) f.requestSubmit(); });
}

/* Ce que Mergerie porte déjà sur ce ticket : les merge requests qui en viennent (par la clé
   relevée, la branche ou le titre) et les sessions de codage lancées dessus. Chargé APRÈS le
   rendu du ticket : la fiche ne doit pas attendre cette réponse pour s'afficher. */
let jiraMergerieSeq = 0;
async function chargerEngagements(cle) {
  const box = $('#jiraMergerie');
  if (!box) return;
  const seq = ++jiraMergerieSeq;
  let d;
  try { d = await api(`/jira/issues/${encodeURIComponent(cle)}/mergerie`); } catch { return; }
  if (seq !== jiraMergerieSeq) return;          // un autre ticket a été ouvert entre-temps
  const rien = !(d.mrs || []).length && !(d.tasks || []).length && !(d.citations || []).length;
  box.hidden = rien;
  if (rien) { box.innerHTML = ''; return; }
  const ligneMr = (m) => {
    const bouts = [esc(m.project)];
    if (m.note != null) bouts.push(esc(fmtNote10(m.note * 10)));
    if (m.verdict) bouts.push(esc(tr(`mr.ref.verdict.${m.verdict}`)));
    bouts.push(esc(tr(m.closed ? 'notes.todo.mr.closed' : `mr.status.${String(m.status).replace('_', '-')}`)));
    return `<li><button type="button" class="lien-reglage" data-jira-mr="${m.id}">!${m.iid} — ${esc(m.title || '')}</button> <span class="muted">${bouts.join(' · ')}</span></li>`;
  };
  const ligneTache = (x) => `<li><button type="button" class="lien-reglage" data-jira-task="${x.id}">${esc(x.label || String(x.prompt || '').slice(0, 70))}</button> <span class="muted">${esc(tr(`task.status.${x.status}`, {}) || x.status)}</span></li>`;
  /* B1 — VÉRIFIER ENSEMBLE, DEPUIS LE TICKET. Cinq merge requests dans cinq dépôts pour un
     seul ticket : la fiche les liste déjà. Pour les vérifier ensemble il fallait pourtant
     retourner dans Reviews, cocher les cinq à la main, taper un nom de lot, puis retrouver ce
     lot dans Dev IA. Le bouton fait les trois d'un coup, avec la clé du ticket comme nom.

     Il n'apparaît qu'à partir de DEUX merge requests OUVERTES de dépôts DIFFÉRENTS : deux du
     même dépôt rendraient le verdict ininterprétable — c'est déjà la règle de la sélection
     multiple, et elle ne change pas parce qu'on part du ticket. */
  const ouvertes = (d.mrs || []).filter((m) => !m.closed);
  const depots = new Set(ouvertes.map((m) => m.project));
  const groupables = ouvertes.length >= 2 && depots.size === ouvertes.length;
  box.innerHTML = `<h4>${esc(tr('jira.mergerie.title'))}</h4>
    <div class="jira-card">
      ${(d.mrs || []).length ? `<ul class="jira-eng">${d.mrs.map(ligneMr).join('')}</ul>` : ''}
      ${(d.tasks || []).length ? `<ul class="jira-eng">${d.tasks.map(ligneTache).join('')}</ul>` : ''}
      ${/* B4 — les notes qui citent ce ticket. Le ticket est l'endroit où l'on se demande « on
            en avait parlé, où ? » : la réponse était une recherche plein texte à refaire. */''}
      ${(d.citations || []).length ? `<ul class="jira-eng">${d.citations.map((c) => `<li><button type="button" class="lien-reglage" data-cite-page="${c.id}">${esc(c.title)}</button> <span class="muted">${esc(String(c.excerpt || '').slice(0, 120))}</span></li>`).join('')}</ul>` : ''}
      ${groupables ? `<button type="button" class="btn btn-primary" data-jira-lot="${esc(cle)}"
          data-mrs="${esc(ouvertes.map((m) => m.id).join(','))}"
          title="${esc(tr('jira.verify-together.title', { n: ouvertes.length, key: cle }))}">${svgIco('check')}${esc(tr('jira.verify-together', { n: ouvertes.length, count: ouvertes.length }))}</button>` : ''}
    </div>`;
}
/* B1 — le lot, puis la vérification, en un geste. Le lot est nommé par la clé : c'est ce
   qu'on aurait tapé, et c'est ce qui le rendra reconnaissable dans Dev IA trois jours plus
   tard. Si le lot existe déjà (on a cliqué deux fois), l'erreur du serveur est dite telle
   quelle et la vérification ne part pas : mieux vaut ça qu'un second lot homonyme. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-jira-lot]');
  if (!b) return;
  const ids = String(b.dataset.mrs || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  try {
    const lot = await busy(b, () => api('/lots', { method: 'POST', body: { name: b.dataset.jiraLot, members: ids } }));
    toast(tr('verify.toast.lot-created', { name: b.dataset.jiraLot }));
    const repoIds = toReviewRows.concat(reportRows).filter((m) => ids.includes(m.id)).map((m) => m.repo_id).filter(Boolean);
    lancerVerification(ids, { lotId: lot && lot.id, repoIds });
  } catch (err) { toast(explainError(err.message), true); }
});

document.addEventListener('click', (e) => {
  const m = e.target.closest && e.target.closest('[data-jira-mr]');
  if (m) { navMrReport(Number(m.dataset.jiraMr)); return; }
  /* Un ticket lié s'ouvre DANS la colonne où on l'a cliqué : la fiche surveillée reste dans
     « Surveillés », celle de « Mes tickets » dans la sienne. */
  const rel = e.target.closest && e.target.closest('[data-jira-open]');
  if (rel) {
    const box = rel.closest('#jiraWatchDetail') ? 'watch' : 'mine';
    selectJiraIssue(rel.dataset.jiraOpen, box);
    return;
  }
  const t2 = e.target.closest && e.target.closest('[data-jira-task]');
  if (t2) { navTab('task'); loadTasks(); }
});

/* `ou` : 'mine' (Mes tickets) ou 'watch' (Surveillés). Les deux sous-onglets ont leur propre
   liste et leur propre sélection — passer de l'un à l'autre ne doit pas déplacer le curseur
   de celui qu'on vient de quitter. */
/* OUVRIR UN TICKET DEPUIS AILLEURS (note, todo, palette). Le ticket DEMANDÉ l'emporte sur « le
   premier de ma liste » : ouvrir l'onglet charge mes tickets, et cette réponse, arrivée après,
   remplaçait le ticket demandé par un autre. */
function ouvrirTicketJira(key) {
  JIRA.cible = key;
  navTab('jira'); showJiraSub('mine'); selectJiraIssue(key, 'mine');
}
async function selectJiraIssue(key, ou = 'mine') {
  const surveille = ou === 'watch';
  const box = $(surveille ? '#jiraWatchDetail' : '#jiraDetail');
  if (!box) return;
  if (surveille) { JIRA_WATCH.selectedKey = key; renderJiraWatch(); }
  else { JIRA.selectedKey = key; renderJiraList(); }
  box.innerHTML = skeleton(2);
  try {
    const d = await api(`/jira/issue/${encodeURIComponent(key)}`);
    /* Synchronise l'entrée de la liste (statut/priorité/date) avec le détail à jour — utile
       notamment après un changement d'état. Côté surveillés, l'état affiché vient de la
       dernière vérification : le détail est plus frais, on en profite. */
    const li = JIRA.issues.find((x) => x.key === key);
    if (li && d.issue) { li.status = d.issue.status; li.statusCategory = d.issue.statusCategory; li.priority = d.issue.priority; li.updated = d.issue.updated; renderJiraList(); }
    const w = JIRA_WATCH.rows.find((x) => x.key === key);
    if (w && d.issue) { w.status = d.issue.status; w.status_category = d.issue.statusCategory; if (surveille) renderJiraWatch(); }
    renderJiraDetail(d.issue, box);
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
}

// Filtre par ASSIGNÉ (persisté) : on mémorise les accountIds COCHÉS. Non défini → [moi].
function jiraCheckedAssignees() { try { const v = JSON.parse(localStorage.getItem('aidevtools_jira_assignees') || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } }
function setJiraCheckedAssignees(arr) { try { localStorage.setItem('aidevtools_jira_assignees', JSON.stringify(arr)); } catch { /* ignore */ } }
function jiraCheckedSet() {
  const persisted = jiraCheckedAssignees();
  if (persisted) return new Set(persisted);
  return new Set(JIRA.me && JIRA.me.accountId ? [JIRA.me.accountId] : []); // défaut : moi seul
}
function jiraUpdateAssigneeCount() {
  const el = $('#jiraAssigneeFilterCount'); if (!el) return;
  el.textContent = tr('jira.status-filter-count', { shown: jiraCheckedSet().size, total: JIRA.people.length });
}
// Filtre la LISTE des personnes (pas les tickets) selon la recherche de personne.
function jiraFilterAssigneeSearch() {
  const q = (($('#jiraAssigneeSearch') && $('#jiraAssigneeSearch').value) || '').toLowerCase().trim();
  $$('#jiraAssigneeFilterBody .jira-sf-item').forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
}
function renderJiraAssigneeFilter() {
  const det = $('#jiraAssigneeFilter'); const body = $('#jiraAssigneeFilterBody'); if (!det || !body) return;
  if (!JIRA.people.length) { det.hidden = true; return; }
  det.hidden = false;
  const checked = jiraCheckedSet();
  body.innerHTML = JIRA.people.map((p) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(p.accountId)}"${checked.has(p.accountId) ? ' checked' : ''} />
      <span class="jira-avatar jira-avatar-sm" aria-hidden="true">${esc(jiraInitials(p.name))}</span>
      <span>${esc(p.name)}${JIRA.me && p.accountId === JIRA.me.accountId ? ` <span class="muted">(${esc(tr('jira.me'))})</span>` : ''}</span></label>`).join('');
  jiraUpdateAssigneeCount();
  jiraFilterAssigneeSearch(); // conserve la recherche courante après reconstruction
}

// 1) charge « moi » + les personnes candidates ; 2) charge les tickets des personnes cochées.
async function loadJira() {
  const errBox = $('#jiraError'); errBox.innerHTML = '';
  $('#jiraList').innerHTML = skeleton(3); $('#jiraDetail').innerHTML = ''; $('#jiraInfo').textContent = '';
  try { $('#jiraIncludeDone').checked = localStorage.getItem('aidevtools_jira_done') === '1'; } catch { /* ignore */ }
  let a;
  try { a = await api('/jira/assignees'); }
  catch (e) { $('#jiraList').innerHTML = ''; errBox.innerHTML = errorBox(explainError(e.message)); return; }
  if (!a.configured) {
    errBox.innerHTML = '';
    // État « non configuré » actionnable (comme l'onboarding Reviews) plutôt qu'un simple message.
    $('#jiraList').innerHTML = emptyState({ icon: 'tag',
      title: tr('jira.not-configured.title'),
      text: tr('jira.not-configured'),
      actions: [{ act: 'go-jira-config', label: tr('jira.not-configured.cta'), primary: true }] });
    $('#jiraAssigneeFilter').hidden = true; $('#jiraStatusFilter').hidden = true;
    return;
  }
  JIRA.me = a.me; JIRA.people = a.people || [];
  renderJiraAssigneeFilter();
  // La liste surveillée est chargée AVEC l'onglet : le bouton « Surveiller » du détail doit
  // connaître l'état réel dès le premier rendu, sinon il propose d'ajouter un ticket déjà suivi.
  await loadJiraWatch();
  await loadJiraTickets();
  refreshJiraBadge();
}

async function loadJiraTickets() {
  $('#jiraList').innerHTML = skeleton(3);
  const done = $('#jiraIncludeDone').checked ? 1 : 0;
  const assignees = [...jiraCheckedSet()].join(',');
  // Les projets cochés sont appliqués PAR Jira : filtrer après coup ne verrait qu'un extrait.
  const projects = (jiraFiltres().project || []).join(',');
  const sprints = jiraSprintsChoisis().join(',');
  /* Séparateur « unité » (U+001F) : un nom de statut peut contenir une virgule
     (« En attente, client »), la virgule ne peut donc pas servir de séparateur. */
  const masques = [...jiraHiddenStatuses()].join('\u001f');
  let d;
  try { d = await api(`/jira/tickets?assignees=${encodeURIComponent(assignees)}&includeDone=${done}&projects=${encodeURIComponent(projects)}&sprints=${encodeURIComponent(sprints)}&hideStatuses=${encodeURIComponent(masques)}`); }
  catch (e) { $('#jiraList').innerHTML = ''; $('#jiraError').innerHTML = errorBox(explainError(e.message)); return; }
  JIRA.issues = d.issues || [];
  JIRA.total = d.total != null ? d.total : null;
  /* On ne mémorise que ce qu'on a vu SANS la contrainte correspondante : sinon on figerait
     une liste déjà réduite par le filtre lui-même. */
  if (!sprints) jiraMemoriseValeurs('sprint', JIRA.issues.flatMap((i) => i.sprints || []));
  if (!masques) {
    jiraMemoriseValeurs('status', JIRA.issues.filter((i) => i.status)
      .map((i) => ({ v: i.status, l: i.status, cat: i.statusCategory })));
  }
  if (!projects) {
    jiraMemoriseValeurs('project', JIRA.issues
      .filter((i) => i.projectKey).map((i) => ({ v: i.projectKey, l: i.project || i.projectKey })));
  }
  JIRA.selectedKey = null;
  $('#jiraInfo').textContent = tr('jira.count', { n: JIRA.issues.length, count: JIRA.issues.length });
  renderJiraStatusFilter();
  renderJiraSprintFilter();
  renderJiraFieldFilter();
  renderJiraList();
  const vis = jiraVisibleIssues();
  chargerStatutsDuWorkflow();   // complète la liste des statuts, sans bloquer l'affichage
  const cible = JIRA.cible; JIRA.cible = null;
  if (cible) selectJiraIssue(cible, 'mine');
  else if (vis.length) selectJiraIssue(vis[0].key);
  else $('#jiraDetail').innerHTML = `<div class="jira-empty muted">${esc(tr(JIRA.issues.length ? 'jira.no-match' : 'jira.empty'))}</div>`;
}

