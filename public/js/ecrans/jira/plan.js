'use strict';
/* JIRA → PLANS : la liste des plans, leurs ENTRÉES et leur PROMPT.
 *
 * Un plan prend un lot de tickets (une epic, une liste), des pages Confluence, des dépôts lus chacun
 * sur sa branche, un complément et des pièces jointes. « Préparer le prompt » enregistre les entrées,
 * fait lire Jira et Confluence au serveur et montre le texte composé : on le relit, on le retouche, et
 * c'est ce texte-là qui part avec « Lancer l'analyse ». Le résultat (ordre, compléments, tickets à
 * créer) vit dans `plan-resultat.js`.
 *
 * Le formulaire n'est JAMAIS redessiné par le sondage d'une analyse en cours : seule la zone du
 * résultat l'est. Sans ça, ce qu'on tape dans le complément ou le prompt disparaîtrait toutes les
 * trois secondes. */

const PLAN = {
  liste: [],
  courant: null,      // vue complète du plan ouvert (serveur) ; null = un plan pas encore enregistré
  brouillon: null,    // l'état du formulaire, lu du DOM avant chaque geste
  timer: null,
  ouvert: false,      // le panneau principal montre-t-il un plan (neuf ou existant) ?
};

const brouillonVide = () => ({
  label: '', epic: '', tickets: [], pages: [], repos: [], branches: {}, complement: '',
  comments: false, ask: true, filtreTickets: '', filtreRepos: '', fichiers: [],
});
function brouillonDe(v) {
  const photo = new Map((v.tickets || []).map((x) => [x.key, x]));
  return {
    ...brouillonVide(),
    label: v.label, epic: v.epic_key || '',
    tickets: (v.ticket_keys || []).map((k) => ({ key: k, summary: (photo.get(k) || {}).summary || '', status: (photo.get(k) || {}).status || '', statusCategory: (photo.get(k) || {}).statusCategory || '', coche: true })),
    pages: (v.confluence_urls || []).slice(), repos: (v.repo_ids || []).slice(), branches: { ...(v.repo_branches || {}) },
    complement: v.complement || '', comments: !!v.include_comments, ask: !!v.ask_questions,
  };
}

/* ---------- La liste ---------- */
const statutPlan = (s) => `<span class="jira-plan-status is-${esc(s)}">${esc(tr(`jira.plan.status.${s}`))}</span>`;
function rendreListePlans() {
  const box = $('#jiraPlanList');
  if (!box) return;
  const q = ($('#jiraPlanSearch').value || '').trim().toLowerCase();
  const compte = $('#jiraPlanCount');
  if (compte) { compte.textContent = String(PLAN.liste.length); compte.hidden = !PLAN.liste.length; }
  if (!PLAN.liste.length) { box.innerHTML = `<p class="muted">${esc(tr('jira.plan.none'))}</p>`; return; }
  box.innerHTML = PLAN.liste.map((p) => `<button type="button" class="jira-plan-item${PLAN.courant && PLAN.courant.id === p.id ? ' active' : ''}" data-plan-open="${p.id}"
      ${q && !`${p.label} ${(p.ticket_keys || []).join(' ')}`.toLowerCase().includes(q) ? 'hidden' : ''}>
      <span class="jira-plan-item-label">${esc(p.label)}</span>
      <span class="jira-plan-item-meta">${statutPlan(p.status)} <span class="muted">${esc(tr('jira.plan.n-tickets', { n: (p.ticket_keys || []).length, count: (p.ticket_keys || []).length }))} · ${esc(fmtDateTime(p.updated_at))}</span></span>
    </button>`).join('');
}
async function chargerPlans() {
  try { PLAN.liste = (await api('/jira/plans')).items || []; } catch (e) { PLAN.liste = []; toast(explainError(e.message), true); }
  rendreListePlans();
  if (!PLAN.ouvert) rendrePlanVide();
}
function rendrePlanVide() {
  $('#jiraPlanMain').innerHTML = emptyState({ icon: 'grid', title: tr('jira.plan.empty.title'), text: tr('jira.plan.empty.text') });
}

/* ---------- Le formulaire des entrées ---------- */
function ticketsHtml(b) {
  const q = b.filtreTickets.trim().toLowerCase();
  if (!b.tickets.length) return `<p class="muted">${esc(tr('jira.plan.tickets-none'))}</p>`;
  return b.tickets.map((x) => `<label class="inline-check jira-plan-ticket" data-row${q && !`${x.key} ${x.summary}`.toLowerCase().includes(q) ? ' hidden' : ''}>
      <input type="checkbox" data-plan-ticket="${esc(x.key)}"${x.coche ? ' checked' : ''} />
      <strong>${esc(x.key)}</strong> <span>${esc(x.summary || '')}</span> ${x.status ? `<span class="jira-plan-state is-${esc(x.statusCategory || 'new')}">${esc(x.status)}</span>` : ''}</label>`).join('');
}
function reposHtml(b) {
  const q = b.filtreRepos.trim().toLowerCase();
  const repos = SPEC.repos || [];
  if (!repos.length) return `<span class="muted">${esc(tr('jira.spec.repos-none'))}</span>`;
  return repos.map((r) => `<div class="jira-spec-repo" data-row data-spec-row="${r.id}"${q && !r.project.toLowerCase().includes(q) ? ' hidden' : ''}>
      <label class="inline-check"><input type="checkbox" data-plan-repo="${r.id}"${b.repos.includes(r.id) ? ' checked' : ''} /> <span>${esc(r.project)}</span></label>
      ${b.repos.includes(r.id) ? brancheComboHtml(b.branches[r.id] || '') : ''}</div>`).join('');
}
function piecesHtml(b, v) {
  const enregistrees = (v && v.pieces) || [];
  const lignes = [
    ...enregistrees.map((p) => `<li><a href="/api/pieces/plan/${p.id}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a> <button type="button" class="btn btn-sm" data-plan-piece-del="${p.id}" title="${esc(tr('ui.delete'))}">×</button></li>`),
    ...b.fichiers.map((f, i) => `<li>${esc(f.name)} <span class="muted">${esc(tr('jira.plan.piece-pending'))}</span> <button type="button" class="btn btn-sm" data-plan-file-del="${i}" title="${esc(tr('ui.delete'))}">×</button></li>`),
  ];
  return `<ul class="jira-spec-pages">${lignes.join('')}</ul>
    <label class="btn btn-sm jira-plan-file"><svg class="ico ico-sm"><use href="#i-clip"/></svg>${esc(tr('jira.plan.btn.attach'))}<input type="file" multiple hidden data-plan-files accept="${esc(PJ_ACCEPT_PLAN)}" /></label>`;
}
const PJ_ACCEPT_PLAN = 'image/*,.pdf,.txt,.md,.csv,.tsv,.json,.yml,.yaml,.xml,.html,.log,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf';

function entreesHtml(b, v) {
  return `<form class="jira-plan-section jira-plan-form" id="jiraPlanForm" autocomplete="off">
      <h4>${esc(tr('jira.plan.step.inputs'))}</h4>
      <label class="jira-spec-field"><span class="jira-spec-lbl">${esc(tr('jira.plan.lbl.label'))}</span>
        <input type="text" id="jiraPlanLabel" maxlength="120" value="${esc(b.label)}" placeholder="${esc(tr('jira.plan.label-ph'))}" /></label>
      <div class="jira-spec-field">
        <span class="jira-spec-lbl">${esc(tr('jira.plan.lbl.tickets'))}</span>
        <div class="jira-spec-add">
          <input type="text" id="jiraPlanEpic" value="${esc(b.epic)}" placeholder="${esc(tr('jira.plan.epic-ph'))}" />
          <button type="button" class="btn btn-sm" data-plan-epic-load>${esc(tr('jira.plan.btn.epic'))}</button>
          <input type="text" id="jiraPlanKeys" placeholder="${esc(tr('jira.plan.keys-ph'))}" />
          <button type="button" class="btn btn-sm" data-plan-keys-add>${esc(tr('jira.plan.btn.keys'))}</button>
        </div>
        <input type="search" class="jira-spec-filtre" data-plan-filtre-tickets placeholder="${esc(tr('jira.plan.tickets-filter-ph'))}" value="${esc(b.filtreTickets)}" />
        <div class="jira-plan-tickets" id="jiraPlanTickets">${ticketsHtml(b)}</div>
      </div>
      <div class="jira-spec-field">
        <span class="jira-spec-lbl">${esc(tr('jira.spec.lbl.confluence'))}</span>
        <ul class="jira-spec-pages">${b.pages.map((u, i) => `<li><span class="jira-spec-url" title="${esc(u)}">${esc(u)}</span> <button type="button" class="btn btn-sm" data-plan-page-del="${i}" title="${esc(tr('ui.delete'))}">×</button></li>`).join('')}</ul>
        <div class="jira-spec-add">
          <input type="url" id="jiraPlanPageUrl" placeholder="${esc(tr('jira.spec.add-page-ph'))}" />
          <button type="button" class="btn btn-sm" data-plan-page-add>${esc(tr('jira.spec.btn.add-page'))}</button>
        </div>
      </div>
      <div class="jira-spec-field">
        <span class="jira-spec-lbl">${esc(tr('jira.plan.lbl.repos'))}</span>
        <input type="search" class="jira-spec-filtre" data-plan-filtre-repos placeholder="${esc(tr('jira.spec.repos-ph'))}" value="${esc(b.filtreRepos)}" />
        <div class="jira-spec-repos" id="jiraPlanRepos">${reposHtml(b)}</div>
      </div>
      <label class="jira-spec-field"><span class="jira-spec-lbl">${esc(tr('jira.plan.lbl.complement'))}</span>
        <textarea id="jiraPlanComplement" rows="3" placeholder="${esc(tr('jira.plan.complement-ph'))}">${esc(b.complement)}</textarea></label>
      <div class="jira-spec-field"><span class="jira-spec-lbl">${esc(tr('jira.plan.lbl.pieces'))}</span>${piecesHtml(b, v)}</div>
      <div class="jira-spec-row">
        <label class="inline-check"><input type="checkbox" id="jiraPlanComments"${b.comments ? ' checked' : ''} /> <span>${esc(tr('jira.plan.lbl.comments'))}</span></label>
        <label class="inline-check"><input type="checkbox" id="jiraPlanAsk"${b.ask ? ' checked' : ''} /> <span>${esc(tr('jira.spec.lbl.ask'))}</span></label>
      </div>
      <div class="jira-spec-actions">
        <button type="submit" class="btn btn-primary btn-sm" id="jiraPlanPrepare"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('jira.plan.btn.prepare'))}</button>
        <button type="button" class="btn btn-sm" data-plan-save>${esc(tr('jira.plan.btn.save'))}</button>
        <span class="muted" id="jiraPlanBudget">${esc(budgetTexte(b))}</span>
        <span class="spacer"></span>
        ${v ? `<button type="button" class="btn btn-sm btn-danger" data-plan-delete="${v.id}">${esc(tr('jira.plan.btn.delete'))}</button>` : ''}
      </div>
    </form>`;
}
/* Le coût de la préparation, dit AVANT de la lancer : une recherche par tranche de cent tickets,
   un appel par ticket si l'on veut ses commentaires, un par page Confluence. */
function budgetTexte(b) {
  const n = b.tickets.filter((x) => x.coche).length;
  const jira = Math.ceil(n / 100) + (b.comments ? n : 0);
  return tr('jira.plan.budget', { jira, pages: b.pages.length });
}

/* ---------- Le prompt ---------- */
function promptHtml(v) {
  if (!v || !v.prompt) return '';
  const enCours = v.status === 'running' || v.status === 'needs_input';
  const lues = (v.pages || []).filter((p) => p.title || p.error);
  return `<section class="jira-plan-section" id="jiraPlanPromptBox">
      <h4>${esc(tr('jira.plan.step.prompt'))} ${v.prompt_edited ? `<span class="jira-chip">${esc(tr('jira.plan.prompt-edited'))}</span>` : ''}</h4>
      ${v.prompt_stale ? `<p class="jira-spec-hint is-warn">${esc(tr('jira.plan.prompt-stale'))}</p>` : ''}
      ${(v.missing || []).length ? `<p class="jira-spec-hint is-warn">${esc(tr('jira.plan.missing', { keys: v.missing.join(', ') }))}</p>` : ''}
      ${lues.length ? `<ul class="jira-spec-lues muted">${lues.map((p) => `<li>${esc(p.title || p.url)}${p.truncated ? ` (${esc(tr('jira.spec.page-truncated-ui'))})` : ''}${p.error ? ` — ${esc(p.error)}` : ''}</li>`).join('')}</ul>` : ''}
      <textarea id="jiraPlanPrompt" class="jira-plan-prompt" rows="18" spellcheck="false">${esc(v.prompt)}</textarea>
      <p class="field-note">${esc(tr('jira.plan.prompt-note'))}</p>
      <div class="jira-spec-actions">
        <button type="button" class="btn btn-primary btn-sm" data-plan-run${enCours ? ' disabled' : ''}><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr(v.version ? 'jira.plan.btn.rerun' : 'jira.plan.btn.run'))}</button>
        <button type="button" class="btn btn-sm" data-plan-prompt-save>${esc(tr('jira.plan.btn.prompt-save'))}</button>
        <span class="muted">${esc(tr('jira.plan.run-note'))}</span>
      </div>
    </section>`;
}

/* ---------- Le panneau ---------- */
function rendrePlan() {
  const v = PLAN.courant;
  const b = PLAN.brouillon;
  $('#jiraPlanMain').innerHTML = `${entreesHtml(b, v)}<div id="jiraPlanPromptZone">${promptHtml(v)}</div><div id="jiraPlanResult"></div>`;
  brancherCombosBranche($('#jiraPlanRepos'));
  rendreResultatPlan();
  sonderPlan();
}
function rendrePrompt() {
  const zone = $('#jiraPlanPromptZone');
  if (zone) zone.innerHTML = promptHtml(PLAN.courant);
}

/* TANT QU'UNE ANALYSE TOURNE : on relit le plan, et on ne redessine que le résultat et la liste. */
function sonderPlan() {
  clearTimeout(PLAN.timer);
  const v = PLAN.courant;
  if (!v || !(v.status === 'running' || v.status === 'needs_input')) return;
  PLAN.timer = setTimeout(async () => {
    if (!PLAN.courant || PLAN.courant.id !== v.id || $('#jiraSubPlan').hidden) return;
    try {
      const d = await api(`/jira/plans/${v.id}`);
      const etait = PLAN.courant.status;
      PLAN.courant = d;
      /* EN ATTENTE DE RÉPONSES, ON NE REDESSINE PAS : le formulaire des questions perdrait ce qu'on
         est en train d'y taper. Il sera redessiné quand l'état changera. */
      if (!(etait === 'needs_input' && d.status === 'needs_input')) rendreResultatPlan();
      if (etait !== d.status) {
        // Le bouton « Lancer » se réactive quand l'analyse s'arrête ; le texte du prompt, lui, n'est pas touché.
        const run = $('[data-plan-run]'); if (run) run.disabled = d.status === 'running' || d.status === 'needs_input';
        chargerPlans();
      }
    } catch { /* on réessaie au prochain tour */ }
    sonderPlan();
  }, 3000);
}

async function ouvrirPlan(id) {
  await reposOptions();
  try {
    const v = await api(`/jira/plans/${id}`);
    PLAN.courant = v; PLAN.brouillon = brouillonDe(v); PLAN.ouvert = true;
    rendreListePlans(); rendrePlan();
  } catch (e) { toast(explainError(e.message), true); }
}
async function nouveauPlan() {
  await reposOptions();
  PLAN.courant = null; PLAN.brouillon = brouillonVide(); PLAN.ouvert = true;
  rendreListePlans(); rendrePlan();
  const champ = $('#jiraPlanLabel'); if (champ) champ.focus();
}

/* Le DOM → le brouillon : ce qu'on a tapé fait foi avant chaque geste. */
function lireFormPlan() {
  const b = PLAN.brouillon;
  if (!b || !$('#jiraPlanForm')) return b;
  b.label = $('#jiraPlanLabel').value;
  b.epic = $('#jiraPlanEpic').value.trim().toUpperCase();
  for (const c of $$('[data-plan-ticket]')) { const x = b.tickets.find((y) => y.key === c.dataset.planTicket); if (x) x.coche = c.checked; }
  b.repos = $$('[data-plan-repo]:checked').map((c) => Number(c.dataset.planRepo));
  b.branches = {};
  for (const id of b.repos) {
    const champ = document.querySelector(`#jiraPlanRepos [data-spec-row="${id}"] .spec-branch`);
    if (champ && champ.value.trim()) b.branches[id] = champ.value.trim();
  }
  b.complement = $('#jiraPlanComplement').value;
  b.comments = $('#jiraPlanComments').checked;
  b.ask = $('#jiraPlanAsk').checked;
  return b;
}
const corpsPlan = (b) => ({
  label: b.label, epic_key: b.epic, ticket_keys: b.tickets.filter((x) => x.coche).map((x) => x.key),
  confluence_urls: b.pages, repo_ids: b.repos, repo_branches: b.branches, complement: b.complement,
  include_comments: b.comments, ask_questions: b.ask, files: b.fichiers,
});

async function enregistrerPlan() {
  const b = lireFormPlan();
  const v = PLAN.courant;
  const d = v
    ? await api(`/jira/plans/${v.id}`, { method: 'PUT', body: corpsPlan(b) })
    : await api('/jira/plans', { method: 'POST', body: corpsPlan(b) });
  b.fichiers = [];
  PLAN.courant = d;
  return d;
}

/* PRÉPARER : enregistrer, puis faire composer le prompt. Une retouche à la main n'est remplacée
   qu'après l'avoir confirmé. */
async function preparerPlan(btn) {
  const b = lireFormPlan();
  if (!b.tickets.some((x) => x.coche)) { toast(tr('err.plan.no-ticket'), true); return; }
  if (!b.repos.length) { toast(tr('err.plan.no-repo'), true); return; }
  try {
    await busy(btn, async () => {
      const v = await enregistrerPlan();
      let d;
      try { d = await api(`/jira/plans/${v.id}/prepare`, { method: 'POST', body: {} }); }
      catch (e) {
        if (e.code !== 'PLAN_PROMPT_EDITED') throw e;
        if (!await confirmDialog({ text: tr('jira.plan.confirm-reprepare'), confirmLabel: tr('jira.plan.btn.reprepare') })) { rendrePlan(); return; }
        d = await api(`/jira/plans/${v.id}/prepare`, { method: 'POST', body: { force: true } });
      }
      PLAN.courant = d; PLAN.brouillon = { ...brouillonDe(d), filtreTickets: b.filtreTickets, filtreRepos: b.filtreRepos };
      toast(tr('jira.plan.prepared'));
      rendrePlan(); chargerPlans();
      const zone = $('#jiraPlanPromptBox'); if (zone) zone.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (e) { toast(explainError(e.message), true); }
}

/* LANCER : le prompt tel qu'il est à l'écran — enregistré d'abord s'il a été retouché. */
async function lancerPlan(btn) {
  const v = PLAN.courant;
  const champ = $('#jiraPlanPrompt');
  try {
    await busy(btn, async () => {
      if (champ && champ.value.trim() !== String(v.prompt || '').trim()) {
        PLAN.courant = await api(`/jira/plans/${v.id}/prompt`, { method: 'PUT', body: { prompt: champ.value } });
      }
      const d = await api(`/jira/plans/${v.id}/run`, { method: 'POST', body: {} });
      PLAN.courant = d;
      if (d.job) refreshStatus();
      toast(tr(d.job ? 'jira.plan.launched' : 'jira.plan.done-demo'));
      rendrePrompt(); rendreResultatPlan(); sonderPlan(); chargerPlans();
    });
  } catch (e) { toast(explainError(e.message), true); }
}

/* ---------- Les gestes ---------- */
const dansPlan = (el) => el.closest && el.closest('#jiraSubPlan');
document.addEventListener('input', (e) => {
  if (!dansPlan(e.target) || !PLAN.brouillon) return;
  if (e.target.matches('[data-plan-filtre-tickets]')) {
    PLAN.brouillon.filtreTickets = e.target.value;
    const q = e.target.value.trim().toLowerCase();
    // Le filtre MASQUE sans rien décocher : ce qui est coché reste coché.
    for (const l of $$('#jiraPlanTickets .jira-plan-ticket')) l.hidden = !!q && !l.textContent.toLowerCase().includes(q);
  } else if (e.target.matches('[data-plan-filtre-repos]')) {
    PLAN.brouillon.filtreRepos = e.target.value;
    const q = e.target.value.trim().toLowerCase();
    for (const l of $$('#jiraPlanRepos .jira-spec-repo')) l.hidden = !!q && !l.textContent.toLowerCase().includes(q);
  }
});
document.addEventListener('change', async (e) => {
  if (!dansPlan(e.target) || !PLAN.brouillon) return;
  const repo = e.target.closest('[data-plan-repo]');
  if (repo) {
    // Cocher un dépôt fait apparaître son sélecteur de branche, sur place.
    const ligne = repo.closest('[data-spec-row]');
    const existant = $('.combo', ligne);
    if (repo.checked && !existant) { ligne.insertAdjacentHTML('beforeend', brancheComboHtml('')); brancherCombosBranche(ligne); }
    else if (!repo.checked && existant) { existant.remove(); const i = $('.hint', ligne); if (i) i.remove(); }
    return;
  }
  if (e.target.matches('[data-plan-ticket], #jiraPlanComments')) { lireFormPlan(); $('#jiraPlanBudget').textContent = budgetTexte(PLAN.brouillon); return; }
  if (e.target.matches('[data-plan-files]')) {
    const fichiers = [...e.target.files];
    for (const f of fichiers) {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      PLAN.brouillon.fichiers.push({ name: f.name, data });
    }
    lireFormPlan(); rendrePlan();
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'jiraPlanForm') return;
  e.preventDefault();
  preparerPlan($('#jiraPlanPrepare'));
});
document.addEventListener('click', async (e) => {
  if (!dansPlan(e.target)) return;
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (b.id === 'jiraPlanNew') { await nouveauPlan(); return; }
    if (d.planOpen) { await ouvrirPlan(Number(d.planOpen)); return; }
    if (d.planEpicLoad !== undefined) {
      lireFormPlan();
      const cle = PLAN.brouillon.epic;
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(cle)) { toast(tr('err.jira.invalid-key'), true); return; }
      const r = await busy(b, () => api(`/jira/spec/epic/${encodeURIComponent(cle)}/children`));
      for (const c of r.children || []) {
        if (!PLAN.brouillon.tickets.some((x) => x.key === c.key)) PLAN.brouillon.tickets.push({ key: c.key, summary: c.summary, status: c.status, statusCategory: c.statusCategory || '', coche: !c.isSubtask });
      }
      if (!PLAN.brouillon.label.trim()) PLAN.brouillon.label = cle;
      toast(tr('jira.plan.epic-loaded', { n: (r.children || []).length, count: (r.children || []).length, key: cle }));
      rendrePlan();
      return;
    }
    if (d.planKeysAdd !== undefined) {
      lireFormPlan();
      const cles = String($('#jiraPlanKeys').value || '').split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k));
      if (!cles.length) { toast(tr('err.jira.invalid-key'), true); return; }
      for (const k of cles) {
        const x = PLAN.brouillon.tickets.find((y) => y.key === k);
        if (x) x.coche = true; else PLAN.brouillon.tickets.push({ key: k, summary: '', status: '', coche: true });
      }
      rendrePlan();
      return;
    }
    if (d.planPageAdd !== undefined) {
      lireFormPlan();
      const url = ($('#jiraPlanPageUrl').value || '').trim();
      if (!/^https?:\/\//i.test(url)) return;
      if (!PLAN.brouillon.pages.includes(url)) PLAN.brouillon.pages.push(url);
      rendrePlan();
      return;
    }
    if (d.planPageDel !== undefined) { lireFormPlan(); PLAN.brouillon.pages.splice(Number(d.planPageDel), 1); rendrePlan(); return; }
    if (d.planFileDel !== undefined) { lireFormPlan(); PLAN.brouillon.fichiers.splice(Number(d.planFileDel), 1); rendrePlan(); return; }
    if (d.planPieceDel) {
      lireFormPlan();
      await busy(b, () => api(`/pieces/plan/${d.planPieceDel}`, { method: 'DELETE' }));
      PLAN.courant = await api(`/jira/plans/${PLAN.courant.id}`);
      rendrePlan();
      return;
    }
    if (d.planSave !== undefined) {
      await busy(b, () => enregistrerPlan());
      PLAN.brouillon = { ...brouillonDe(PLAN.courant), filtreTickets: PLAN.brouillon.filtreTickets, filtreRepos: PLAN.brouillon.filtreRepos };
      toast(tr('jira.plan.saved'));
      rendrePlan(); chargerPlans();
      return;
    }
    if (d.planDelete) {
      if (!await confirmDialog({ text: tr('jira.plan.confirm-delete', { label: PLAN.courant.label }), confirmLabel: tr('ui.delete') })) return;
      await api(`/jira/plans/${d.planDelete}`, { method: 'DELETE' });
      PLAN.courant = null; PLAN.ouvert = false;
      toast(tr('jira.plan.deleted'));
      chargerPlans();
      return;
    }
    if (d.planRun !== undefined) { await lancerPlan(b); return; }
    if (d.planPromptSave !== undefined) {
      const v = await busy(b, () => api(`/jira/plans/${PLAN.courant.id}/prompt`, { method: 'PUT', body: { prompt: $('#jiraPlanPrompt').value } }));
      PLAN.courant = v;
      toast(tr('jira.plan.prompt-saved'));
      rendrePrompt();
    }
  } catch (err) { toast(explainError(err.message), true); }
});
$('#jiraPlanSearch') && $('#jiraPlanSearch').addEventListener('input', rendreListePlans);
