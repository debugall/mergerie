'use strict';
/* Projets liés en LECTURE SEULE à une session de codage : l'IA a parfois besoin du contexte
   d'un autre projet (son API, son schéma) pour coder correctement dans les projets ci-dessus,
   sans avoir le droit d'y toucher. Même dispositif d'écran que les « projets liés » d'une
   review (public/js/ecrans/reviews/contexte.js) : un dépôt (combo générique avec recherche)
   + une branche (existante, facultative — vide = branche par défaut du dépôt). */

function ctxRepoRowHtml(idx, sel = {}) {
  return `<div class="target-row" data-row="${idx}">
    ${repoComboHtml(sel.repo_id, { idClass: 'ctx-repo', defaultFirst: false })}
    <div class="combo ctx-branch-combo">
      <input class="ctx-branch" data-pick-ctx="1" autocomplete="off" value="${esc(sel.branch || '')}" placeholder="${tr('task.ctx.branch-ph')}" />
      <div class="combo-options" hidden></div>
    </div>
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-rmctx="${idx}" title="${tr('task.ctx.remove')}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}
function renderCtxRepoRows(list) {
  const el = $('#taskContextRepoRows');
  if (!el) return;
  el.innerHTML = (list || []).map((c, i) => ctxRepoRowHtml(i, c)).join('');
  wireRepoCombos(el);
  wireCtxBranchPickers();
  $$('#taskContextRepoRows [data-rmctx]').forEach((b) => b.addEventListener('click', () => {
    renderCtxRepoRows(readCtxRepoRows().filter((_, i) => i !== Number(b.dataset.rmctx)));
  }));
}
// Sélecteur de branche des projets liés (liste déroulante avec recherche), calqué sur
// wireLinkBranchPickers (reviews/contexte.js) mais lisant le dépôt de la MÊME ligne.
function wireCtxBranchPickers() {
  $$('#taskContextRepoRows .target-row').forEach((row) => {
    const input = row.querySelector('[data-pick-ctx]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    const box = row.querySelector('.ctx-branch-combo .combo-options');
    const repoHidden = row.querySelector('.ctx-repo');
    const open = async () => {
      const repoId = Number(repoHidden.value);
      if (!repoId) { box.innerHTML = `<div class="combo-opt muted">${tr('context.links.pick-repo-first')}</div>`; box.hidden = false; return; }
      box.innerHTML = `<div class="combo-opt muted">${tr('task.combo.loading')}</div>`; box.hidden = false;
      let data;
      try { data = await branchesFor(repoId); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(errorHint(e.message) || e.message)}</div>`; return; }
      const q = input.value.toLowerCase();
      const list = data.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
      const defOpt = data.def ? `<div class="combo-opt" data-b="">${tr('task.combo.default', { branch: esc(data.def) })}</div>` : '';
      box.innerHTML = defOpt + (list.map((b) => `<div class="combo-opt" data-b="${esc(b)}">${esc(b)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-branch')}</div>`);
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-b]');
      if (!o) return;
      input.value = o.dataset.b;
      box.hidden = true;
    });
    // changer de projet invalide la branche saisie (elle appartenait à l'autre dépôt)
    repoHidden.addEventListener('change', () => { input.value = ''; box.hidden = true; });
  });
}
function readCtxRepoRows() {
  return $$('#taskContextRepoRows .target-row').map((row) => ({
    repo_id: Number(row.querySelector('.ctx-repo').value),
    branch: (row.querySelector('.ctx-branch').value || '').trim(),
  })).filter((c) => c.repo_id);
}
const taskContextRepoAdd = $('#taskContextRepoAdd');
if (taskContextRepoAdd) taskContextRepoAdd.addEventListener('click', () => {
  renderCtxRepoRows([...readCtxRepoRows(), {}]);
});
