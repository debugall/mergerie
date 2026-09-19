'use strict';
/* Règles de review spécifiques. */
/* ---------- Règles de review spécifiques ---------- */
/* Le filtre des règles : il MASQUE, comme partout ailleurs — une règle écartée revient à un
   caractère effacé près, et le rendu ne se rejoue pas à chaque frappe (les champs de la liste
   sont ÉDITABLES : les reconstruire emporterait une saisie en cours). */
function filtrerRegles() {
  const q = (($('#ruleSearch') || {}).value || '').trim().toLowerCase();
  let vus = 0;
  $$('#ruleList .repo-row').forEach((c) => {
    const ok = !q || (c.dataset.cherche || '').includes(q);
    c.hidden = !ok;
    if (ok) vus += 1;
  });
  const vide = $('#ruleNoMatch');
  if (vide) vide.hidden = vus > 0 || !$$('#ruleList .repo-row').length;
}
onEl($('#ruleSearch'), 'input', debounce(filtrerRegles, 120));

async function loadRules() {
  /* A/Réglages 2 — le dépôt se CHOISIT, avec recherche : `npm run check` refuse une liste de
     dépôts sans champ de recherche, et pour cause — un parc en compte quarante. Vide = tous. */
  const boxRegle = $('#ruleRepoBox');
  if (boxRegle) {
    await loadRepoOptions();
    /* `defaultFirst: false` : vide, la règle vaut pour TOUS les dépôts — c'est ce que dit l'aide.
       Pré-choisir le premier la bornait en silence à lui. */
    boxRegle.innerHTML = repoComboHtml(null, { idClass: 'rule-repo', defaultFirst: false });
    wireRepoCombos(boxRegle);
  }
  const rows = await api('/rules');
  const el = $('#ruleList');
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="card repo-row" data-rule="${r.id}" data-cherche="${esc([r.branch_match, r.path_match, r.label, r.content].filter(Boolean).join(' ').toLowerCase())}">
      <div class="rule-head">
        <input data-f="branch_match" value="${esc(r.branch_match || '')}" class="rule-match" placeholder="${tr('settings.rule.ph.ex-proj-12344')}" title="${tr('settings.rule.match-title')}" />
        <input data-f="path_match" value="${esc(r.path_match || '')}" class="rule-match" placeholder="${tr('settings.rule.ph.path-match')}" title="${esc(tr('settings.rule.tip.path-match'))}" />
        <input data-f="label" value="${esc(r.label || '')}" class="rule-label" placeholder="${tr('settings.rule.ph.label')}" title="${esc(tr('settings.rule.tip.label'))}" />
        <div class="spacer"></div>
        <label class="muted"><input type="checkbox" data-rtoggle="${r.id}" ${r.enabled ? 'checked' : ''}/> ${tr('settings.rule.enabled')}</label>
        <button class="btn btn-primary" data-rsave="${r.id}" title="${tr('settings.rule.save-title')}">${tr('ui.save')}</button>
        ${/* A39 — DUPLIQUER : une règle proche d'une autre s'écrivait en recopiant quatre
              champs à la main. Les vérificateurs le proposent déjà, à deux écrans d'ici. */''}
        <button class="btn btn-icon btn-sm" data-rcopy="${r.id}" title="${esc(tr('settings.rule.duplicate-title'))}">${svgIco('copy')}</button>
        <button class="btn btn-icon btn-sm btn-danger" data-rdel="${r.id}" title="${tr('settings.rule.del-title')}"><svg class=\"ico\"><use href=\"#i-close\"/></svg></button>
      </div>
      <textarea data-f="content" rows="3" class="rule-content">${esc(r.content)}</textarea>
      ${/* COMBIEN DE MERGE REQUESTS OUVERTES CETTE RÈGLE TOUCHE-T-ELLE ? Une règle qui ne
            matche plus rien reste dans la liste sans qu'on le sache. Calculé localement,
            sans IA : les chemins modifiés et le nom de branche sont en base. */''}
      ${r.repo_id ? `<p class="field-note">${esc(tr('settings.rule.scoped', { project: (repoOptions.find((x) => x.id === r.repo_id) || {}).project || `#${r.repo_id}` }))}</p>` : ''}
      ${r.author ? `<p class="field-note">${esc(tr('settings.rule.author', { who: r.author }))}</p>` : ''}
      <p class="field-note${r.open_mrs ? '' : ' rule-vide'}">${esc(r.open_mrs
    ? tr('settings.rule.reach', { n: r.open_mrs, count: r.open_mrs })
    : tr('settings.rule.reach-none'))}</p>
    </div>`).join('') : emptyState({ icon: 'sliders', title: tr('settings.rule.empty.title'), text: tr('settings.rule.empty.text') });

  filtrerRegles();
  $$('#ruleList [data-rcopy]').forEach((b) => b.addEventListener('click', async () => {
    const r = rows.find((x) => x.id === Number(b.dataset.rcopy));
    if (!r) return;
    try {
      await api('/rules', { method: 'POST', body: {
        branch_match: r.branch_match || '', path_match: r.path_match || '',
        label: r.label ? tr('settings.rule.copy-of', { label: r.label }) : '',
        content: r.content, repo_id: r.repo_id || null,
      } });
      toast(tr('settings.rule.duplicated'));
      loadRules();
    } catch (e) { toast(explainError(e.message), true); }
  }));

  const ruleEl = (id) => $(`#ruleList .repo-row[data-rule="${id}"]`);
  const gather = (id) => {
    const row = ruleEl(id); const body = {};
    row.querySelectorAll('[data-f]').forEach((i) => { body[i.dataset.f] = i.value; });
    return body;
  };
  $$('#ruleList [data-rsave]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/rules/${b.dataset.rsave}`, { method: 'PUT', body: gather(b.dataset.rsave) }); toast(tr('toast.regle-enregistree')); loadRules(); }
    catch (e) { b.disabled = false; toast(e.message, true); }
  }));
  $$('#ruleList [data-rtoggle]').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/rules/${cb.dataset.rtoggle}`, { method: 'PUT', body: { enabled: cb.checked } }); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#ruleList [data-rdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-rule'), confirmLabel: tr('ui.delete') })) return;
    supprimerAvecAnnulation({
      element: b.closest('.card'),
      message: tr('settings.rule.deleted'),
      supprimer: () => api(`/rules/${b.dataset.rdel}`, { method: 'DELETE' }),
      apres: loadRules,
    });
  }));
}
$('#ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/rules', { method: 'POST', body: {
      branch_match: f.branch_match.value, path_match: f.path_match.value, label: f.label.value, content: f.content.value,
      repo_id: Number(($('#ruleRepoBox .rule-repo') || {}).value || 0) || null,
    } });
    f.branch_match.value = ''; f.path_match.value = ''; f.label.value = ''; f.content.value = ''; loadRules(); toast(tr('toast.regle-ajoutee'));
  } catch (err) { toast(err.message, true); }
});

