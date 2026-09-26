'use strict';
/* Réglages → Dépôts → Groupes de dépôts : la liste, le formulaire (membres, gabarits), et les
   pastilles sur chaque ligne de dépôt (ameliorations_proposal.md, §4.5). */
let groupesConnus = [];

/* Les pastilles d'un dépôt, sur sa ligne : d'un coup d'œil, « backend · paiement ». */
function groupeTagsHtml(groups) {
  return (groups || []).map((g) => `<span class="groupe-tag" data-groupe-tag="${g.id}">${esc(g.name)}</span>`).join(' ');
}

async function loadGroupes() {
  groupesConnus = await loadGroupeOptions();
  const el = $('#groupList');
  if (!el) return;
  el.innerHTML = groupesConnus.length ? groupesConnus.map((g) => `
    <div class="card repo-row groupe-row" data-groupe="${g.id}">
      <div class="repo-view">
        <div style="min-width:0">
          <div class="title">${esc(g.name)} <span class="muted">· ${esc(tr('settings.groups.n-repos', { n: g.repos.length, count: g.repos.length }))}</span></div>
          ${g.description ? `<div class="meta">${esc(g.description)}</div>` : ''}
          <div class="meta muted">${g.repos.map((r) => esc(r.project)).join(' · ') || esc(tr('settings.groups.no-repo'))}</div>
          <div class="meta muted">${[
    g.rules ? tr('settings.groups.n-rules', { n: g.rules, count: g.rules }) : '',
    g.verifiers ? tr('settings.groups.n-verifiers', { n: g.verifiers, count: g.verifiers }) : '',
    [g.prompt_review && tr('settings.groups.has-review'), g.prompt_fix && tr('settings.groups.has-fix'), g.prompt_modify && tr('settings.groups.has-modify'), g.ai_extra_instructions && tr('settings.groups.has-extra')].filter(Boolean).join(', '),
  ].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-gedit="${g.id}"><svg class="ico"><use href="#i-edit"/></svg>${esc(tr('settings.repo.edit'))}</button>
        <button class="btn btn-icon btn-sm btn-danger" data-gdel="${g.id}" title="${esc(tr('settings.groups.del-title'))}"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
    </div>`).join('') : `<p class="muted">${esc(tr('settings.groups.empty'))}</p>`;
  $$('#groupList [data-gedit]').forEach((b) => b.addEventListener('click', () => ouvrirFormGroupe(groupesConnus.find((g) => g.id === Number(b.dataset.gedit)))));
  $$('#groupList [data-gdel]').forEach((b) => b.addEventListener('click', async () => {
    const g = groupesConnus.find((x) => x.id === Number(b.dataset.gdel));
    if (!g) return;
    const ok = await confirmDialog({ title: tr('settings.groups.del.confirm.title', { name: g.name }), text: tr('settings.groups.del.confirm.text'), confirmLabel: tr('ui.delete') });
    if (!ok) return;
    try { await api(`/repo-groups/${g.id}`, { method: 'DELETE' }); toast(tr('settings.groups.deleted')); await loadGroupes(); loadRepos(); } catch (e) { toast(explainError(e.message), true); }
  }));
}

function renderGroupRepoList(cochees = []) {
  const box = $('#groupRepoList');
  if (!box) return;
  const set = new Set((cochees || []).map(Number));
  box.innerHTML = repoOptions.map((r) => `<label class="repo-multi-item" data-repo="${r.id}" data-cherche="${esc(String(r.project).toLowerCase())}"><input type="checkbox" class="gr-pick" value="${r.id}" ${set.has(r.id) ? 'checked' : ''} /> <span>${esc(r.project)}</span></label>`).join('')
    || `<span class="muted">${esc(tr('settings.repo.empty.title'))}</span>`;
  /* Le filtre MASQUE sans décocher (`filtrerLignes`) : on coche, on filtre autre chose, on coche encore. */
  const filtre = $('#groupRepoFilter');
  if (filtre && !filtre.dataset.wired) {
    filtre.dataset.wired = '1';
    filtre.addEventListener('input', () => filtrerLignes(filtre, $('#groupRepoList')));
  }
}

function ouvrirFormGroupe(g) {
  const f = $('#groupForm');
  if (!f) return;
  f.hidden = false;
  f.id.value = g ? g.id : '';
  f.name.value = g ? g.name : '';
  f.description.value = g ? (g.description || '') : '';
  f.ai_extra_instructions.value = g ? (g.ai_extra_instructions || '') : '';
  f.prompt_review.value = g ? (g.prompt_review || '') : '';
  f.prompt_fix.value = g ? (g.prompt_fix || '') : '';
  f.prompt_modify.value = g ? (g.prompt_modify || '') : '';
  renderGroupRepoList(g ? g.repos.map((r) => r.repo_id) : []);
  const det = f.querySelector('.group-overrides');
  if (det) det.open = !!(g && (g.prompt_review || g.prompt_fix || g.prompt_modify || g.ai_extra_instructions));
  $('#groupInfo').textContent = g ? tr('settings.groups.editing', { name: g.name }) : '';
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.name.focus();
}
onEl($('#btnNewGroup'), 'click', async () => { await loadRepoOptions(); ouvrirFormGroupe(null); });
onEl($('#btnCancelGroup'), 'click', () => { $('#groupForm').hidden = true; });
onEl($('#groupForm'), 'submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  viderErreursChamps(f);
  const body = {
    name: f.name.value.trim(), description: f.description.value.trim(),
    ai_extra_instructions: f.ai_extra_instructions.value, prompt_review: f.prompt_review.value,
    prompt_fix: f.prompt_fix.value, prompt_modify: f.prompt_modify.value,
    repos: $$('#groupRepoList .gr-pick').filter((c) => c.checked).map((c) => Number(c.value)),
  };
  if (!body.name) { erreurChamp(f.name, tr('err.group.name-required')); return; }
  const id = f.id.value;
  try {
    await api(id ? `/repo-groups/${id}` : '/repo-groups', { method: id ? 'PUT' : 'POST', body });
    toast(tr('settings.groups.saved'));
    f.hidden = true;
    await loadGroupes();
    loadRepos();
  } catch (err) { toast(explainError(err.message), true); }
});
