'use strict';
/* Git → Vérificateur : des PRÉPARATIONS de vérification. Une préparation = des dépôts, chacun sur
   une branche ou un tag, et des vérificateurs dans un ordre. « Lancer » les fait tourner l'un après
   l'autre, en arrière-plan, chacun dans son job (le journal les montre) ; un rouge arrête la suite
   et les étapes restantes, « non lancées », se lancent une à une. La séquence vit côté serveur
   (`jobs/plan-verif.js`) : l'écran ne fait que lire et rafraîchir tant que quelque chose tourne. */
let planVerifPlans = [];
let planVerifVerifiers = [];
let planVerifEdite = null;     // id de la préparation en modification, null à la création
let planVerifOrdre = [];       // les vérificateurs cochés, dans l'ordre où ils tourneront
let planVerifMinuteur = null;

async function planVerifCharger() {
  const box = $('#planVerifList');
  if (!box) return;
  if (!planVerifPlans.length && !box.innerHTML) box.innerHTML = skeleton(2);
  try { planVerifPlans = await api('/verif-plans'); }
  catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  planVerifRendre();
  planVerifSuivre();
}

/* Tant qu'une préparation tourne ET que le sous-onglet est sous les yeux, on relit : les verdicts
   tombent les uns après les autres, et c'est ce qu'on est venu voir. Ailleurs, rien ne tourne pour
   rien — la prochaine visite relira. */
function planVerifSuivre() {
  clearTimeout(planVerifMinuteur);
  const visible = () => { const s = $('#gsub-verif'); return !!(s && s.classList.contains('active') && s.offsetParent); };
  if (!planVerifPlans.some((p) => p.running)) return;
  planVerifMinuteur = setTimeout(() => { if (visible()) planVerifCharger(); }, 2000);
}

const planVerifRefHtml = (c) => `<span class="pv-ref">${esc(c.project)} <code>${c.tag ? `${svgIco('tag')} ` : ''}${esc(c.tag || c.branch || '')}</code></span>`;

/* Une étape : son rang, son vérificateur, et ce qu'on en sait — le badge du verdict (qui ouvre le
   rapport), l'attente, ou le bouton qui la lance seule quand la séquence s'est arrêtée avant elle. */
function planVerifEtapeHtml(run, s, i) {
  let etat = '';
  if (s.etat === 'done' && s.verification) etat = verifyBadge(s.verification);
  else if (s.etat === 'error') etat = `<span class="tag pv-etat pv-error">${esc(tr('git.verif.state.error'))}</span> <span class="pv-err">${esc(s.erreur || '')}</span>`;
  else etat = `<span class="tag pv-etat pv-${esc(s.etat)}">${esc(tr(`git.verif.state.${s.etat}`))}</span>`;
  if ((s.etat === 'queued' || s.etat === 'running') && s.verification) {
    etat += ` <button type="button" class="btn btn-sm" data-vreport="${s.verification.id}">${esc(tr('git.verif.see-report'))}</button>`;
  }
  // Non lancée, refusée, ou échouée : elle se (re)lance seule. Une étape verte, non.
  const echouee = s.etat === 'done' && (!s.verification || s.verification.verdict !== 'verified_pass');
  const lancer = s.etat === 'not_run' || s.etat === 'error' || echouee
    ? ` <button type="button" class="btn btn-sm" data-pvstep="${run.id}:${i}">${svgIco(echouee ? 'refresh' : 'play')} ${esc(tr(echouee ? 'git.verif.rerun-step' : 'git.verif.run-step'))}</button>` : '';
  return `<li class="pv-step" data-etat="${esc(s.etat)}"><span class="pv-vname">${esc(s.verifier_name || '?')}</span> ${etat}${lancer}</li>`;
}

const planVerifRunHtml = (run, titre) => `<div class="pv-run"><div class="pv-run-head muted">${esc(titre)}</div>
  <ol class="pv-steps">${run.steps.map((s, i) => planVerifEtapeHtml(run, s, i)).join('')}</ol></div>`;

function planVerifCarteHtml(p, ouverts) {
  const [dernier, ...hist] = p.runs;
  // Chaque vérificateur se lance aussi seul, hors séquence : un nouveau lancement où lui seul part.
  const verifs = p.verifiers.map((v, i) => `<li class="pv-verifier"><span>${esc(v.name || tr('git.verif.verifier-gone'))}</span>
    <button type="button" class="btn btn-sm" data-pvone="${p.id}:${i}" title="${esc(tr('git.verif.run-one-title'))}"${p.running || !v.name ? ' disabled' : ''}>${svgIco('play')} ${esc(tr('git.verif.run-step'))}</button></li>`).join('');
  return `<div class="card pv-card" data-plan="${p.id}">
    <div class="pv-head">
      <div class="pv-titre"><h4 class="pv-name">${esc(p.name || tr('git.verif.unnamed'))}</h4>
        <div class="pv-refs">${p.targets.map(planVerifRefHtml).join('')}</div></div>
      <div class="pv-actions">
        <button type="button" class="btn btn-primary btn-sm" data-pvrun="${p.id}"${p.running ? ' disabled' : ''}>${svgIco('play')} ${esc(tr(p.running ? 'git.verif.running' : 'git.verif.run'))}</button>
        <button type="button" class="btn btn-icon btn-sm" data-pvedit="${p.id}" title="${esc(tr('git.verif.edit'))}" aria-label="${esc(tr('git.verif.edit'))}">${svgIco('edit')}</button>
        <button type="button" class="btn btn-icon btn-sm btn-danger" data-pvdel="${p.id}" title="${esc(tr('git.verif.delete'))}" aria-label="${esc(tr('git.verif.delete'))}">${svgIco('trash')}</button>
      </div>
    </div>
    <ol class="pv-verifiers">${verifs}</ol>
    ${dernier ? planVerifRunHtml(dernier, tr('git.verif.last-run', { date: fmtDateHour(dernier.created_at) })) : `<p class="muted pv-never">${esc(tr('git.verif.never-run'))}</p>`}
    ${hist.length ? `<details class="pv-hist"${ouverts.has(p.id) ? ' open' : ''}><summary>${esc(tr('git.verif.history', { n: hist.length, count: hist.length }))}</summary>
      ${hist.map((r) => planVerifRunHtml(r, fmtDateHour(r.created_at))).join('')}</details>` : ''}
  </div>`;
}

function planVerifRendre() {
  const box = $('#planVerifList');
  if (!planVerifPlans.length) {
    box.innerHTML = emptyState({ icon: 'check', title: esc(tr('git.verif.empty')), text: esc(tr('git.verif.empty-text')) });
    return;
  }
  // L'historique déplié le reste : la relecture toutes les deux secondes ne doit pas le refermer.
  const ouverts = new Set($$('.pv-card', box).filter((c) => { const d = $('.pv-hist', c); return d && d.open; }).map((c) => Number(c.dataset.plan)));
  box.innerHTML = planVerifPlans.map((p) => planVerifCarteHtml(p, ouverts)).join('');
}

/* ---------- La modale : dépôts et refs, puis vérificateurs ---------- */

const planVerifGenre = (row) => (row.dataset.genre === 'tag' ? 'tag' : 'branch');
const planVerifCoches = () => $$('#planVerifRepos .pv-repo-row').filter((r) => $('.pv-pick', r).checked).map((r) => Number(r.dataset.repo));

async function planVerifOuvrir(plan = null) {
  planVerifEdite = plan ? plan.id : null;
  planVerifOrdre = plan ? plan.verifiers.map((v) => v.id) : [];
  $('#planVerifTitle').textContent = tr(plan ? 'git.verif.modal.edit-title' : 'git.verif.modal.title');
  $('#planVerifName').value = plan ? plan.name || '' : '';
  $('#planVerifSave span').textContent = tr(plan ? 'git.verif.modal.save' : 'git.verif.modal.create');
  $('#planVerifRepos').innerHTML = skeleton(3);
  $('#planVerifVerifiers').innerHTML = '';
  $('#planVerifModal').hidden = false;
  try {
    if (!repoOptions.length) await loadRepoOptions();
    const d = await api('/verifiers');
    planVerifVerifiers = Array.isArray(d) ? d : (d.verifiers || []);
  } catch (e) {
    $('#planVerifModal').hidden = true;
    setTimeout(() => toast(explainError(e.message), true), 0);
    return;
  }
  const choisis = new Map(((plan && plan.targets) || []).map((c) => [c.repo_id, c]));
  const lignes = repoOptions.map((r) => {
    const c = choisis.get(r.id);
    const genre = c && c.tag ? 'tag' : 'branch';
    const ref = c ? (c.tag || c.branch || '') : '';
    /* `data-row` : l'ancêtre que `wireCombo` passe au chargeur. La case est dans SON label, pas
       la ligne entière : cliquer dans le champ de branche ne doit pas la basculer. */
    return `<div class="pv-repo-row${c ? '' : ' is-off'}" data-row="${r.id}" data-repo="${r.id}" data-genre="${genre}">
      <label class="repo-multi-item"><input type="checkbox" class="pv-pick"${c ? ' checked' : ''} /> <span>${esc(r.project)}</span></label>
      <div class="pv-ref-pick"><select class="pv-genre" aria-label="${esc(tr('verify.branch.kind-title'))}"${c ? '' : ' disabled'}>
        <option value="branch"${genre === 'branch' ? ' selected' : ''}>${esc(tr('verify.branch.kind-branch'))}</option>
        <option value="tag"${genre === 'tag' ? ' selected' : ''}>${esc(tr('verify.branch.kind-tag'))}</option></select>
      ${comboHtml('pv-branch', { value: ref, label: ref, ph: tr(genre === 'tag' ? 'verify.branch.ph-tag' : 'verify.branch.ph'), disabled: !c })}</div></div>`;
  }).join('');
  const el = $('#planVerifRepos');
  // Recherche obligatoire là où l'on choisit des dépôts : elle MASQUE, elle ne décoche rien.
  el.innerHTML = `<input class="repo-multi-search pv-search" type="search" placeholder="${esc(tr('git.verif.modal.search'))}" />
    <div class="repo-multi-list pv-repo-list">${lignes}</div>`;
  wireCombo(el, 'pv-branch', async (row) => {
    const repoId = Number(row && row.dataset.repo);
    if (!repoId) return [];
    if (planVerifGenre(row) === 'tag') {
      const d = await gitLoadRefs(repoId, 'tags');
      return d.refs.map((x) => ({ value: x.name, label: x.name, hint: x.date ? fmtDate(x.date) : '' }));
    }
    const d = await gitLoadRefs(repoId, 'branches');
    return d.refs.map((x) => ({ value: x.name, label: x.name, hint: x.default ? tr('git.refs.default-suffix') : '' }));
  });
  planVerifRendreVerifs();
}

/* Une ligne cochée sans ref reçoit la branche par défaut du dépôt — celle sur laquelle tout a été
   mergé, presque toujours. Un tag ne se devine pas. */
async function planVerifBrancheDefaut(row) {
  const cache = $('.pv-branch', row);
  if (cache.value || planVerifGenre(row) === 'tag') return;
  const champ = $('.cb-search', row);
  try {
    const d = await gitLoadRefs(Number(row.dataset.repo), 'branches');
    const def = (d.refs || []).find((x) => x.default);
    if (def && !cache.value && planVerifGenre(row) === 'branch') {
      cache.value = def.name; cache.dataset.label = def.name; champ.value = def.name;
    }
  } catch { /* dépôt injoignable : la ref se tape à la main */ }
}

/* Les vérificateurs, selon les dépôts cochés : grisé s'il n'en couvre aucun (il n'aurait rien à
   vérifier), et la part qu'il couvre sinon — les autres dépôts seront mis sur leur ref dans le clone
   local pendant son run. Le rang affiché est l'ordre de passage. */
function planVerifRendreVerifs() {
  const el = $('#planVerifVerifiers');
  if (!planVerifVerifiers.length) { el.innerHTML = `<p class="muted">${esc(tr('git.verif.modal.no-verifier'))}</p>`; return; }
  const coches = planVerifCoches();
  const couvre = (v) => coches.filter((id) => (v.covered || []).some((c) => c.repo_id === id)).length;
  planVerifOrdre = planVerifOrdre.filter((id) => { const v = planVerifVerifiers.find((x) => x.id === id); return v && couvre(v) > 0; });
  el.innerHTML = planVerifVerifiers.map((v) => {
    const n = couvre(v);
    const rang = planVerifOrdre.indexOf(v.id);
    let note = '';
    if (coches.length) {
      if (!n) note = tr('git.verif.modal.covers-none');
      else if (n < coches.length) note = tr('git.verif.modal.covers-some', { n, total: coches.length });
      else note = tr('git.verif.modal.covers-all');
    }
    return `<label class="pv-verif-row${n ? '' : ' is-off'}"><input type="checkbox" class="pv-vpick" value="${v.id}"${rang >= 0 ? ' checked' : ''}${n ? '' : ' disabled'} />
      <span class="pv-rang">${rang >= 0 ? `${rang + 1}.` : ''}</span> <span class="pv-vname">${esc(v.name)}</span> <span class="muted pv-couv">${esc(note)}</span></label>`;
  }).join('');
}

$('#planVerifRepos') && $('#planVerifRepos').addEventListener('input', (e) => {
  if (!e.target.classList.contains('pv-search')) return;
  const q = e.target.value.toLowerCase().trim();
  $$('#planVerifRepos .pv-repo-row').forEach((row) => {
    row.hidden = !!q && !$('.repo-multi-item span', row).textContent.toLowerCase().includes(q);
  });
});
$('#planVerifRepos') && $('#planVerifRepos').addEventListener('change', async (e) => {
  const g = e.target.closest && e.target.closest('.pv-genre');
  if (g) {
    const row = g.closest('.pv-repo-row');
    row.dataset.genre = g.value;
    const cache = $('.pv-branch', row); const champ = $('.cb-search', row);
    cache.value = ''; cache.dataset.label = ''; champ.value = '';
    champ.placeholder = tr(g.value === 'tag' ? 'verify.branch.ph-tag' : 'verify.branch.ph');
    await planVerifBrancheDefaut(row);
    return;
  }
  const c = e.target.closest && e.target.closest('.pv-pick');
  if (!c) return;
  const row = c.closest('.pv-repo-row');
  row.classList.toggle('is-off', !c.checked);
  $('.cb-search', row).disabled = !c.checked;
  $('.pv-genre', row).disabled = !c.checked;
  planVerifRendreVerifs();
  if (c.checked) await planVerifBrancheDefaut(row);
});
$('#planVerifVerifiers') && $('#planVerifVerifiers').addEventListener('change', (e) => {
  const c = e.target.closest && e.target.closest('.pv-vpick');
  if (!c) return;
  const id = Number(c.value);
  planVerifOrdre = planVerifOrdre.filter((x) => x !== id);
  if (c.checked) planVerifOrdre.push(id);
  planVerifRendreVerifs();
});

$('#planVerifCancel') && $('#planVerifCancel').addEventListener('click', () => { $('#planVerifModal').hidden = true; });
$('#planVerifSave') && $('#planVerifSave').addEventListener('click', async (e) => {
  const name = $('#planVerifName').value.trim();
  if (!name) { toast(tr('err.plan.name-required'), true); $('#planVerifName').focus(); return; }
  const targets = [];
  for (const row of $$('#planVerifRepos .pv-repo-row').filter((r) => $('.pv-pick', r).checked)) {
    // Une ref tapée sans passer par la liste compte aussi : le champ visible fait foi s'il est seul.
    const ref = ($('.pv-branch', row).value || $('.cb-search', row).value || '').trim();
    if (!ref) { toast(tr('git.verif.modal.ref-missing', { project: $('.repo-multi-item span', row).textContent }), true); return; }
    targets.push(planVerifGenre(row) === 'tag' ? { repo_id: Number(row.dataset.repo), tag: ref } : { repo_id: Number(row.dataset.repo), branch: ref });
  }
  const body = { name, targets, verifier_ids: planVerifOrdre };
  try {
    await busy(e.currentTarget, () => api(planVerifEdite ? `/verif-plans/${planVerifEdite}` : '/verif-plans', { method: planVerifEdite ? 'PUT' : 'POST', body }));
  } catch (err) { toast(explainError(err.message), true); return; }
  $('#planVerifModal').hidden = true;
  toast(tr(planVerifEdite ? 'git.verif.saved' : 'git.verif.created'));
  planVerifCharger();
});

/* ---------- La liste ---------- */

$('#planVerifNew') && $('#planVerifNew').addEventListener('click', () => planVerifOuvrir());
$('#planVerifList') && $('#planVerifList').addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-pvrun],[data-pvone],[data-pvstep],[data-pvedit],[data-pvdel]');
  if (!b) return;
  try {
    if (b.dataset.pvedit) { planVerifOuvrir(planVerifPlans.find((p) => p.id === Number(b.dataset.pvedit))); return; }
    if (b.dataset.pvdel) {
      if (!await confirmDialog({ text: tr('git.verif.delete-confirm'), confirmLabel: tr('ui.delete') })) return;
      await api(`/verif-plans/${b.dataset.pvdel}`, { method: 'DELETE' });
    } else if (b.dataset.pvrun) {
      await busy(b, () => api(`/verif-plans/${b.dataset.pvrun}/run`, { method: 'POST' }));
      toast(tr('git.verif.started'));
    } else if (b.dataset.pvone) {
      const [plan, i] = b.dataset.pvone.split(':');
      await busy(b, () => api(`/verif-plans/${plan}/run`, { method: 'POST', body: { index: Number(i) } }));
      toast(tr('git.verif.started'));
    } else {
      const [run, i] = b.dataset.pvstep.split(':');
      await busy(b, () => api(`/verif-plan-runs/${run}/steps/${i}/run`, { method: 'POST' }));
      toast(tr('git.verif.started'));
    }
  } catch (err) { toast(explainError(err.message), true); }
  planVerifCharger();
});
