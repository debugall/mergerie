'use strict';
/* PRÉCISION TECHNIQUE D'UN TICKET — la section « Précision technique » du détail Jira.
 *
 * Un ticket écrit par un PO dit le quoi, jamais le où ni le comment. Ici : on choisit des
 * dépôts, on joint l'epic, des pages Confluence, un complément ; l'IA explore et propose ; on
 * fait ajuster (suivi), on corrige à la main, on poste en commentaire — et on relance sans
 * jamais empiler un deuxième commentaire. Tout passe par `/api/jira/spec…` ; l'écran ne porte
 * que l'état du formulaire (par ticket) et le sondage tant qu'une analyse tourne. */

const SPEC = {
  parCle: {},        // KEY -> vue rendue par le serveur
  formulaire: {},    // KEY -> { ouvert, repos:[ids], pages:[url], complement, detail, epic, ask, edition }
  repos: null,       // options de dépôts, chargées une fois
  timers: {},        // KEY -> timer de sondage pendant une analyse
};

async function reposOptions() {
  if (SPEC.repos) return SPEC.repos;
  try { SPEC.repos = (await api('/repos')).map((r) => ({ id: r.id, project: r.project })).sort((a, b) => a.project.localeCompare(b.project)); }
  catch { SPEC.repos = []; }
  return SPEC.repos;
}

function formulaireDe(cle, vue) {
  if (!SPEC.formulaire[cle]) {
    SPEC.formulaire[cle] = {
      ouvert: !vue, repos: vue ? vue.repo_ids.slice() : [], pages: vue ? vue.confluence.map((p) => p.url) : [],
      complement: vue ? vue.complement : '', detail: vue ? vue.detail : 'synthese', epic: vue ? vue.include_epic : true,
      ask: vue ? vue.ask_questions : true, edition: false, filtre: '',
    };
  }
  return SPEC.formulaire[cle];
}

/* ---------- Rendu ---------- */
const statutChip = (vue) => `<span class="jira-spec-status is-${esc(vue.status)}">${esc(tr(`jira.spec.status.${vue.status}`))}</span>`;

function formulaireHtml(cle, it, vue) {
  const f = formulaireDe(cle, vue);
  const repos = SPEC.repos || [];
  const q = f.filtre.trim().toLowerCase();
  const lignes = repos.map((r) => `<label class="jira-spec-repo"${q && !r.project.toLowerCase().includes(q) ? ' hidden' : ''}>
      <input type="checkbox" data-spec-repo="${r.id}"${f.repos.includes(r.id) ? ' checked' : ''} /> <span>${esc(r.project)}</span></label>`).join('');
  const epic = it.epic || (it.type && /epic|epique|epopee/i.test(it.type) ? { key: it.key, summary: it.summary } : null);
  return `<form class="jira-spec-form" data-spec-form="${esc(cle)}" autocomplete="off">
      <div class="jira-spec-field">
        <span class="jira-spec-lbl">${esc(tr('jira.spec.lbl.repos'))}</span>
        <input type="search" class="jira-spec-filtre" data-spec-filtre placeholder="${esc(tr('jira.spec.repos-ph'))}" value="${esc(f.filtre)}" />
        <div class="jira-spec-repos">${lignes || `<span class="muted">${esc(tr('jira.spec.repos-none'))}</span>`}</div>
      </div>
      ${epic ? `<label class="inline-check"><input type="checkbox" data-spec-epic${f.epic ? ' checked' : ''} /> <span>${esc(tr('jira.spec.lbl.epic', { key: epic.key }))}</span></label>` : ''}
      <div class="jira-spec-field">
        <span class="jira-spec-lbl">${esc(tr('jira.spec.lbl.confluence'))}</span>
        <ul class="jira-spec-pages">${f.pages.map((u, i) => `<li><span class="jira-spec-url" title="${esc(u)}">${esc(u)}</span> <button type="button" class="btn btn-sm" data-spec-page-del="${i}" title="${esc(tr('jira.spec.btn.cancel'))}">×</button></li>`).join('')}</ul>
        <div class="jira-spec-add">
          <input type="url" data-spec-page-url placeholder="${esc(tr('jira.spec.add-page-ph'))}" />
          <button type="button" class="btn btn-sm" data-spec-page-add>${esc(tr('jira.spec.btn.add-page'))}</button>
        </div>
      </div>
      <label class="jira-spec-field"><span class="jira-spec-lbl">${esc(tr('jira.spec.lbl.complement'))}</span>
        <textarea data-spec-complement rows="2" placeholder="${esc(tr('jira.spec.complement-ph'))}">${esc(f.complement)}</textarea></label>
      <div class="jira-spec-row">
        <span class="jira-spec-lbl">${esc(tr('jira.spec.lbl.detail'))}</span>
        <label class="inline-check"><input type="radio" name="spec-detail-${esc(cle)}" value="synthese"${f.detail !== 'detaille' ? ' checked' : ''} /> <span>${esc(tr('jira.spec.detail-short'))}</span></label>
        <label class="inline-check"><input type="radio" name="spec-detail-${esc(cle)}" value="detaille"${f.detail === 'detaille' ? ' checked' : ''} /> <span>${esc(tr('jira.spec.detail-long'))}</span></label>
        <label class="inline-check"><input type="checkbox" data-spec-ask${f.ask ? ' checked' : ''} /> <span>${esc(tr('jira.spec.lbl.ask'))}</span></label>
      </div>
      <div class="jira-spec-actions">
        <button type="submit" class="btn btn-primary btn-sm"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr(vue ? 'jira.spec.btn.rerun' : 'jira.spec.btn.analyse'))}</button>
        <span class="muted">${esc(tr('jira.spec.cost'))}</span>
        ${epic ? `<button type="button" class="btn btn-sm" data-spec-epic-lot="${esc(epic.key)}"><svg class="ico ico-sm"><use href="#i-grid"/></svg>${esc(tr('jira.spec.btn.epic'))}</button>` : ''}
        ${vue ? `<button type="button" class="btn btn-sm" data-spec-form-close>${esc(tr('jira.spec.btn.cancel'))}</button>` : ''}
      </div>
    </form>`;
}

function propositionHtml(cle, vue) {
  const f = formulaireDe(cle, vue);
  const enCours = vue.status === 'running';
  const attend = vue.status === 'needs_input';
  const pages = (vue.confluence || []).filter((p) => p.title || p.error);
  const entete = `<div class="jira-spec-head">
      ${statutChip(vue)}
      ${vue.version ? `<span class="jira-chip">${esc(tr('jira.spec.version', { n: vue.version }))}</span>` : ''}
      ${vue.posted_version ? `<span class="jira-chip">${esc(tr('jira.spec.posted-v', { n: vue.posted_version }))}</span>` : ''}
      ${vue.unposted && vue.version ? `<span class="jira-chip jira-spec-unposted">${esc(tr('jira.spec.unposted'))}</span>` : ''}
      ${vue.versions.length > 1 ? `<span class="muted">${esc(tr('jira.spec.versions', { n: vue.versions.length }))}</span>` : ''}
      <span class="spacer"></span>
      ${vue.task_id ? `<button type="button" class="btn btn-sm" data-spec-task="${vue.task_id}">${esc(tr('jira.spec.btn.open-session'))}</button>` : ''}
      <button type="button" class="btn btn-sm" data-spec-form-open>${esc(tr('jira.spec.btn.options'))}</button>
      <button type="button" class="btn btn-sm btn-danger" data-spec-delete="${vue.id}" title="${esc(tr('jira.spec.btn.delete'))}">×</button>
    </div>`;
  let conseil = '';
  if (enCours) conseil = `<p class="muted jira-spec-hint"><span class="spin"></span> ${esc(tr('jira.spec.running-hint'))}</p>`;
  else if (attend) conseil = `<p class="jira-spec-hint is-warn">${esc(tr('jira.spec.needs-input-hint'))}</p>`;
  else if (vue.status === 'stale') conseil = `<p class="jira-spec-hint is-warn">${esc(tr('jira.spec.stale-hint'))}</p>`;
  else if (vue.status === 'error') conseil = `<p class="jira-spec-hint is-err">${esc(tr('jira.spec.error-hint'))} ${esc(vue.last_error || '')}</p>`;
  const pagesHtml = pages.length ? `<ul class="jira-spec-lues muted">${pages.map((p) => `<li>${esc(p.title || p.url)}${p.truncated ? ` (${esc(tr('jira.spec.page-truncated-ui'))})` : ''}${p.error ? ` — ${esc(p.error)}` : ''}</li>`).join('')}</ul>` : '';
  let corps = '';
  if (vue.version && f.edition) {
    corps = `<textarea class="jira-spec-editor" data-spec-editor rows="16">${esc(vue.markdown)}</textarea>
      <div class="jira-spec-actions">
        <button type="button" class="btn btn-primary btn-sm" data-spec-save="${vue.id}">${esc(tr('jira.spec.btn.save'))}</button>
        <button type="button" class="btn btn-sm" data-spec-edit-cancel>${esc(tr('jira.spec.btn.cancel'))}</button>
      </div>`;
  } else if (vue.version) {
    corps = `<div class="jira-card md-body jira-spec-md">${mdToHtml(vue.markdown)}</div>
      <div class="jira-spec-suivi">
        <textarea data-spec-followup rows="2" placeholder="${esc(tr('jira.spec.followup-ph'))}"${enCours || attend ? ' disabled' : ''}></textarea>
        <button type="button" class="btn btn-sm" data-spec-followup-send="${vue.id}"${enCours || attend ? ' disabled' : ''}><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('jira.spec.btn.followup'))}</button>
      </div>
      <div class="jira-spec-actions">
        <button type="button" class="btn btn-sm" data-spec-edit="${vue.id}"${enCours ? ' disabled' : ''}>${esc(tr('jira.spec.btn.edit'))}</button>
        <button type="button" class="btn btn-primary btn-sm" data-spec-post="${vue.id}"${enCours ? ' disabled' : ''}><svg class="ico ico-sm"><use href="#i-upload"/></svg>${esc(tr(vue.comment_id ? 'jira.spec.btn.post-update' : 'jira.spec.btn.post'))}</button>
        <button type="button" class="btn btn-sm" data-spec-session="${vue.id}" title="${esc(tr('jira.spec.btn.session-title'))}"><svg class="ico ico-sm"><use href="#i-bot"/></svg>${esc(tr('jira.spec.btn.session'))}</button>
      </div>`;
  }
  return `${entete}${conseil}${pagesHtml}${corps}`;
}

/** Le bloc inséré par le détail du ticket : vide tant que la spec n'est pas chargée. */
function sectionSpecHtml(it) {
  return `<div class="jira-section jira-spec" data-spec-box="${esc(it.key)}" hidden>
      <h4>${esc(tr('jira.spec.title'))}</h4>
      <div class="jira-spec-body"></div>
    </div>`;
}

function rendreSpec(cle, box) {
  const it = JIRA.current && JIRA.current.key === cle ? JIRA.current : { key: cle };
  const vue = SPEC.parCle[cle] || null;
  const f = formulaireDe(cle, vue);
  const corps = $('.jira-spec-body', box);
  if (!corps) return;
  corps.innerHTML = `${vue ? propositionHtml(cle, vue) : ''}${(!vue || f.ouvert) ? formulaireHtml(cle, it, vue) : ''}`;
  box.hidden = false;
  // Tant qu'une analyse tourne, on relit l'état : la proposition arrive sans recharger la page.
  clearTimeout(SPEC.timers[cle]);
  if (vue && (vue.status === 'running' || vue.status === 'needs_input')) {
    SPEC.timers[cle] = setTimeout(() => { if (document.contains(box)) chargerSpec(cle, box.closest('.js-jira-detail') || box.parentElement); }, 3000);
  }
}

/** Charge la spec d'un ticket et la rend dans sa section (le détail vient d'être affiché). */
async function chargerSpec(cle, conteneur) {
  const box = conteneur ? conteneur.querySelector(`[data-spec-box="${CSS.escape(cle)}"]`) : null;
  if (!box) return;
  await reposOptions();
  try {
    const d = await api(`/jira/spec/${encodeURIComponent(cle)}`);
    SPEC.parCle[cle] = d.spec || null;
    if (d.spec && SPEC.formulaire[cle] && !SPEC.formulaire[cle].ouvert) {
      // Les choix enregistrés font foi quand le formulaire est fermé.
      const f = SPEC.formulaire[cle];
      f.repos = d.spec.repo_ids.slice(); f.pages = d.spec.confluence.map((p) => p.url); f.complement = d.spec.complement;
      f.detail = d.spec.detail; f.epic = d.spec.include_epic; f.ask = d.spec.ask_questions;
    }
  } catch { SPEC.parCle[cle] = SPEC.parCle[cle] || null; }
  if (!document.contains(box)) return;
  rendreSpec(cle, box);
  majSpecsListe([cle]);   // la pastille de la carte suit l'état, y compris quand la proposition arrive
}

/* ---------- Les pastilles de la liste ---------- */
async function majSpecsListe(cles) {
  if (!cles || !cles.length) return;
  let d;
  try { d = await api(`/jira/specs?keys=${encodeURIComponent(cles.join(','))}`); } catch { return; }
  const demandees = new Set(cles);
  for (const el of $$('[data-spec-chip]')) {
    // Seules les cartes DEMANDÉES sont relues : un rafraîchissement d'un ticket ne doit pas éteindre les autres.
    if (!demandees.has(el.dataset.specChip)) continue;
    const s = d.specs[el.dataset.specChip];
    el.hidden = !s;
    if (!s) continue;
    el.className = `jira-spec-chip is-${s.status}`;
    el.textContent = tr('jira.spec.badge', { status: tr(`jira.spec.status.${s.status}`) });
  }
}

/* ---------- Gestes ---------- */
function lireFormulaire(form, cle) {
  const f = formulaireDe(cle, SPEC.parCle[cle]);
  f.repos = $$('[data-spec-repo]:checked', form).map((c) => Number(c.dataset.specRepo));
  f.complement = ($('[data-spec-complement]', form) || {}).value || '';
  const det = form.querySelector(`input[name="spec-detail-${CSS.escape(cle)}"]:checked`);
  f.detail = det ? det.value : 'synthese';
  const ep = $('[data-spec-epic]', form); f.epic = ep ? ep.checked : f.epic;
  const ask = $('[data-spec-ask]', form); f.ask = ask ? ask.checked : f.ask;
  return f;
}
const corpsDe = (cle, f, extra = {}) => ({
  key: cle, repo_ids: f.repos, complement: f.complement, confluence_urls: f.pages, detail: f.detail,
  include_epic: f.epic, ask_questions: f.ask, ...extra,
});
const boxDe = (el) => el.closest('[data-spec-box]');
const cleDe = (el) => (boxDe(el) || {}).dataset ? boxDe(el).dataset.specBox : null;
const conteneurDe = (el) => el.closest('.js-jira-detail') || boxDe(el).parentElement;

document.addEventListener('input', (e) => {
  const filtre = e.target.closest && e.target.closest('[data-spec-filtre]');
  if (!filtre) return;
  const form = filtre.closest('[data-spec-form]');
  const q = filtre.value.trim().toLowerCase();
  formulaireDe(form.dataset.specForm, SPEC.parCle[form.dataset.specForm]).filtre = filtre.value;
  // Le filtre MASQUE les lignes sans rien décocher : ce qui est coché reste coché.
  for (const l of $$('.jira-spec-repo', form)) l.hidden = !!q && !l.textContent.toLowerCase().includes(q);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest && e.target.closest('[data-spec-form]');
  if (!form) return;
  e.preventDefault();
  const cle = form.dataset.specForm;
  const f = lireFormulaire(form, cle);
  if (!f.repos.length) { toast(tr('err.spec.repo-required'), true); return; }
  const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
  try {
    const vue = SPEC.parCle[cle];
    const d = vue
      ? await api(`/jira/spec/${vue.id}/rerun`, { method: 'POST', body: corpsDe(cle, f) })
      : await api('/jira/spec', { method: 'POST', body: corpsDe(cle, f) });
    SPEC.parCle[cle] = d.spec; f.ouvert = false;
    toast(tr('jira.spec.launched'));
    rendreSpec(cle, boxDe(form));
    majSpecsListe([cle]);
  } catch (err) { toast(explainError(err.message), true); btn.disabled = false; }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  const closest = (sel) => t.closest && t.closest(sel);
  let b;
  if ((b = closest('[data-spec-page-add]'))) {
    const form = b.closest('[data-spec-form]'); const cle = form.dataset.specForm;
    const inp = $('[data-spec-page-url]', form); const url = (inp.value || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const f = lireFormulaire(form, cle);
    if (f.pages.length >= 5) { toast(tr('jira.spec.page-max'), true); return; }
    if (!f.pages.includes(url)) f.pages.push(url);
    rendreSpec(cle, boxDe(b)); return;
  }
  if ((b = closest('[data-spec-page-del]'))) {
    const form = b.closest('[data-spec-form]'); const cle = form.dataset.specForm;
    const f = lireFormulaire(form, cle); f.pages.splice(Number(b.dataset.specPageDel), 1);
    rendreSpec(cle, boxDe(b)); return;
  }
  if ((b = closest('[data-spec-form-open]'))) { const cle = cleDe(b); formulaireDe(cle, SPEC.parCle[cle]).ouvert = true; rendreSpec(cle, boxDe(b)); return; }
  if ((b = closest('[data-spec-form-close]'))) { const cle = cleDe(b); formulaireDe(cle, SPEC.parCle[cle]).ouvert = false; rendreSpec(cle, boxDe(b)); return; }
  if ((b = closest('[data-spec-edit]'))) { const cle = cleDe(b); formulaireDe(cle, SPEC.parCle[cle]).edition = true; rendreSpec(cle, boxDe(b)); return; }
  if ((b = closest('[data-spec-edit-cancel]'))) { const cle = cleDe(b); formulaireDe(cle, SPEC.parCle[cle]).edition = false; rendreSpec(cle, boxDe(b)); return; }
  if ((b = closest('[data-spec-goto]'))) {
    const cle = b.dataset.specGoto;
    const box = (b.closest('.js-jira-detail') || document).querySelector(`[data-spec-box="${CSS.escape(cle)}"]`);
    if (!box) return;
    formulaireDe(cle, SPEC.parCle[cle]).ouvert = true; rendreSpec(cle, box);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if ((b = closest('[data-spec-task]'))) { navTab('task'); loadTasks(); return; }
  if ((b = closest('[data-spec-open]'))) { ouvrirTicketJira(b.dataset.specOpen); return; }
  if ((b = closest('[data-spec-save]'))) {
    const cle = cleDe(b); const ta = $('[data-spec-editor]', boxDe(b));
    try {
      const d = await api(`/jira/spec/${b.dataset.specSave}`, { method: 'PUT', body: { markdown: ta.value } });
      SPEC.parCle[cle] = d.spec; formulaireDe(cle, d.spec).edition = false;
      toast(tr('jira.spec.saved')); rendreSpec(cle, boxDe(b)); majSpecsListe([cle]);
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if ((b = closest('[data-spec-followup-send]'))) {
    const cle = cleDe(b); const ta = $('[data-spec-followup]', boxDe(b));
    const instruction = (ta.value || '').trim();
    if (!instruction) { toast(tr('err.spec.instruction-required'), true); return; }
    b.disabled = true;
    try {
      const d = await api(`/jira/spec/${b.dataset.specFollowupSend}/followup`, { method: 'POST', body: { instruction } });
      SPEC.parCle[cle] = d.spec; toast(tr('jira.spec.followup-sent')); rendreSpec(cle, boxDe(b)); majSpecsListe([cle]);
    } catch (err) { toast(explainError(err.message), true); b.disabled = false; }
    return;
  }
  if ((b = closest('[data-spec-delete]'))) {
    const cle = cleDe(b);
    const ok = await confirmDialog({ title: tr('jira.spec.title'), text: tr('jira.spec.confirm.delete', { key: cle }), confirmLabel: tr('jira.spec.btn.delete') });
    if (!ok) return;
    try {
      await api(`/jira/spec/${b.dataset.specDelete}`, { method: 'DELETE' });
      SPEC.parCle[cle] = null; delete SPEC.formulaire[cle];
      rendreSpec(cle, boxDe(b)); majSpecsListe([cle]);
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if ((b = closest('[data-spec-post]'))) { await posterSpec(b); return; }
  if ((b = closest('[data-spec-session]'))) {
    try { const pre = await api(`/jira/spec/${b.dataset.specSession}/prefill`); await openTaskForSpec(pre); }
    catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if ((b = closest('[data-spec-epic-lot]'))) {
    const form = b.closest('[data-spec-form]'); const cle = form.dataset.specForm;
    const f = lireFormulaire(form, cle);
    await ouvrirLotEpic(b.dataset.specEpicLot, f, boxDe(b));
  }
});

/* POSTER : ce qui part est montré, et confirmé — c'est une écriture externe que le PO lira.
   Jira refuse la mise à jour (commentaire d'un collègue) : on le dit, et on propose une nouvelle
   version sous son nom ; jamais en silence. */
async function posterSpec(b, forceNew = false) {
  const cle = cleDe(b); const vue = SPEC.parCle[cle];
  if (!vue) return;
  if (!forceNew) {
    const ok = await confirmDialog({
      title: tr('jira.spec.confirm.post-title'),
      text: tr(vue.comment_id ? 'jira.spec.confirm.post-update' : 'jira.spec.confirm.post-new', { key: cle, n: vue.version }),
      html: `<div class="jira-card md-body jira-spec-md">${mdToHtml(vue.markdown)}</div>`, wide: true, danger: false,
      confirmLabel: tr(vue.comment_id ? 'jira.spec.btn.post-update' : 'jira.spec.btn.post'),
    });
    if (!ok) return;
  }
  try {
    const d = await api(`/jira/spec/${vue.id}/post`, { method: 'POST', body: { force_new: forceNew } });
    SPEC.parCle[cle] = d.spec;
    toast(d.recreated ? tr('jira.spec.posted-recreated') : (d.updated ? tr('jira.spec.posted-updated', { key: cle, n: d.spec.posted_version }) : tr('jira.spec.posted-ok', { key: cle })));
    /* LE FIL DU TICKET LE MONTRE TOUT DE SUITE : le commentaire posté (ou mis à jour) rejoint
       la liste, et le détail est redessiné — il recharge la section au passage. */
    if (JIRA.current && JIRA.current.key === cle && d.comment) {
      JIRA.current.comments = (JIRA.current.comments || []).filter((c) => !c.id || c.id !== d.comment.id).concat([d.comment]);
      renderJiraDetail(JIRA.current, JIRA.currentBox);
    } else { rendreSpec(cle, boxDe(b)); majSpecsListe([cle]); }
  } catch (err) {
    if (err.data && err.data.code === 'SPEC_COMMENT_DENIED') {
      const ok = await confirmDialog({ title: tr('jira.spec.denied-title'), text: tr('jira.spec.denied-text'), confirmLabel: tr('jira.spec.denied-new'), danger: false });
      if (ok) await posterSpec(b, true);
      return;
    }
    toast(explainError(err.message), true);
  }
}

/* LE LOT D'UNE EPIC : ses tickets, cochables, un filtre qui masque sans décocher, puis une
   analyse par ticket coché — avec les dépôts, pages et complément du formulaire courant. */
async function ouvrirLotEpic(epicKey, f, box) {
  let d;
  try { d = await api(`/jira/spec/epic/${encodeURIComponent(epicKey)}/children`); }
  catch (err) { toast(explainError(err.message), true); return; }
  const enfants = (d.children || []).filter((c) => !c.isSubtask);
  const html = enfants.length
    ? `<input type="search" class="jira-spec-filtre" data-lot-filtre placeholder="${esc(tr('jira.spec.epic-filter-ph'))}" />
       <div class="jira-spec-lot">${enfants.map((c) => {
    const deja = d.specs[c.key];
    const fini = c.statusCategory === 'done';
    return `<label class="jira-spec-repo"><input type="checkbox" data-lot-key="${esc(c.key)}"${deja || fini ? '' : ' checked'} />
          <code>${esc(c.key)}</code> <span>${esc(c.summary || '')}</span> <span class="muted">${esc(c.status || '')}${deja ? ` · ${esc(tr('jira.spec.epic-has-spec', { status: tr(`jira.spec.status.${deja.status}`) }))}` : ''}</span></label>`;
  }).join('')}</div>`
    : `<p class="muted">${esc(tr('jira.spec.epic-children-empty'))}</p>`;
  const ok = await confirmDialog({
    title: tr('jira.spec.epic-pick-title', { key: epicKey }), html, wide: true, danger: false,
    confirmLabel: tr('jira.spec.btn.launch-batch', { n: enfants.length }),
  });
  if (!ok) return;
  const cles = $$('#confirmBody [data-lot-key]:checked').map((c) => c.dataset.lotKey);
  if (!cles.length) { toast(tr('err.spec.no-ticket'), true); return; }
  if (!f.repos.length) { toast(tr('err.spec.repo-required'), true); return; }
  try {
    const r = await api('/jira/spec/epic', { method: 'POST', body: { ...corpsDe(null, f), epic_key: epicKey, keys: cles } });
    toast(tr('jira.spec.batch-launched', { n: r.specs.length }) + (r.errors.length ? ` ${tr('jira.spec.batch-errors', { n: r.errors.length })}` : ''), !!r.errors.length);
    for (const s of r.specs) SPEC.parCle[s.ticket_key] = s;
    majSpecsListe(cles);
    if (box) chargerSpec(box.dataset.specBox, conteneurDe(box));
  } catch (err) { toast(explainError(err.message), true); }
}
document.addEventListener('input', (e) => {
  const filtre = e.target.closest && e.target.closest('[data-lot-filtre]');
  if (!filtre) return;
  const q = filtre.value.trim().toLowerCase();
  for (const l of $$('#confirmBody .jira-spec-lot .jira-spec-repo')) l.hidden = !!q && !l.textContent.toLowerCase().includes(q);
});
