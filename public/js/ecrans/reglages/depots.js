'use strict';
/* La fiche d'un dépôt (B17), son URL, les répertoires locaux. */
/* B17 — LA FICHE D'UN DÉPÔT, dépliée sous sa ligne. Six listes, six portes : chaque entrée
   emmène là où l'objet se modifie, parce qu'une fiche qui énumère sans mener oblige à
   retrouver à la main ce qu'elle vient de nommer. Chargée au premier dépliage seulement — la
   liste des dépôts s'ouvre à chaque visite des réglages, et six requêtes par ligne pour un
   panneau fermé seraient six requêtes pour rien. */
async function ficheDepotHtml(d) {
  const section = (titre, lignes) => (lignes.length
    ? `<div class="repo-sheet-sec"><h5>${esc(titre)}</h5><ul>${lignes.join('')}</ul></div>` : '');
  const li = (contenu) => `<li>${contenu}</li>`;
  return [
    section(tr('settings.repo.sheet.verifiers'), (d.verifiers || []).map((v) => li(
      `<button type="button" class="lien-reglage" data-sheet-verifier="${v.id}">${esc(v.name)}</button>`
      + (v.mode === 'in_place' ? ` <span class="tag warn">${esc(tr('verify.mode.in-place-short'))}</span>` : ''),
    ))),
    section(tr('settings.repo.sheet.jenkins'), (d.jenkins || []).map((j) => li(
      `<button type="button" class="lien-reglage" data-sheet-jenkins="${esc(j.job_path)}">${esc(j.job_path)}</button>`
      + (j.param ? ` <span class="muted">${esc(j.param)}</span>` : ''),
    ))),
    section(tr('settings.repo.sheet.rules'), (d.rules || []).map((r) => li(
      `<button type="button" class="lien-reglage" data-sheet-rule="${r.id}">${esc(r.label || r.branch_match || r.path_match || `#${r.id}`)}</button>`
      + (r.enabled ? '' : ` <span class="muted">${esc(tr('rules.disabled'))}</span>`),
    ))),
    section(tr('settings.repo.sheet.services'), (d.services || []).map((sv) => li(
      `<button type="button" class="lien-reglage" data-sheet-service="${sv.id}">${esc(sv.name)}</button>`,
    ))),
    section(tr('settings.repo.sheet.links'), (d.links || []).map((l) => li(
      `${esc(l.project)}${l.branch ? ` <code>${esc(l.branch)}</code>` : ''}`,
    ))),
    section(tr('settings.repo.sheet.agents'), (d.agents || []).map((a) => li(
      `<button type="button" class="lien-reglage" data-sheet-agent="${a.id}">${esc(a.name)}</button>`
      + ` <span class="muted">${esc(tr(`agents.role.${a.role}`))}</span>`,
    ))),
  ].filter(Boolean).join('') || `<p class="muted">${esc(tr('settings.repo.sheet.empty'))}</p>`;
}

async function ouvrirFicheDepot(b) {
  const row = b.closest('.repo-row');
  const box = row && row.querySelector('.repo-sheet');
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }      // second clic : on replie
  box.hidden = false;
  box.innerHTML = skeleton(2);
  try {
    const d = await api(`/repos/${b.dataset.sheet}/sheet`);
    box.innerHTML = await ficheDepotHtml(d);
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
}

/* Les portes de la fiche. Chacune ouvre l'écran où l'objet VIT — on ne recopie pas ici un
   éditeur qui existe ailleurs. */
document.addEventListener('click', async (e) => {
  const v = e.target.closest && e.target.closest('[data-sheet-verifier]');
  if (v) { showAdminSub('verifiers'); return; }
  const j = e.target.closest && e.target.closest('[data-sheet-jenkins]');
  if (j) { navTab('jenkins'); await loadJenkins(); openJenkinsJob(j.dataset.sheetJenkins); return; }
  const r = e.target.closest && e.target.closest('[data-sheet-rule]');
  if (r) { showAdminSub('rules'); return; }
  const sv = e.target.closest && e.target.closest('[data-sheet-service]');
  if (sv) { navTab('links'); return; }
  const a = e.target.closest && e.target.closest('[data-sheet-agent]');
  if (a) { navTab('agents'); showAgentsSub('list'); return; }
});

async function loadRepos() {
  const rows = await api('/repos');
  /* Le seul endroit qui sait vraiment s'il y a des dépôts. On en profite pour tenir
     l'assistant de démarrage à jour, sans requête supplémentaire. */
  if (setupState.hasRepos !== (rows.length > 0)) rafraichirDemarrage();
  const el = $('#repoList');
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="card repo-row" data-repo="${r.id}">
      <div class="repo-view">
        <div style="min-width:0">
          <div class="title">${forgeBadge(r.forge)}${esc(r.project)}</div>
          <div class="meta">${esc(r.url)} · ${tr('settings.repo.pattern')} <code>${r.branch_pattern ? esc(r.branch_pattern) : tr('settings.repo.all-mrs')}</code></div>
          ${/* CE QU'IL EN EST DE CE DÉPÔT. « Pourquoi cette review échoue ? » commence presque
                toujours par « le clone est-il là ? » : on répond ici, et on propose le geste. */''}
          <div class="meta muted repo-etat">${[
    r.open_mrs ? esc(tr('settings.repo.open-mrs', { n: r.open_mrs, count: r.open_mrs })) : '',
    r.last_seen_at ? `<span data-when="${esc(r.last_seen_at)}">${esc(tr('settings.repo.last-fetch', { when: depuis(r.last_seen_at) }))}</span>` : '',
    `<span class="repo-clone repo-clone-${esc(r.clone_state)}" title="${esc(r.clone_dir || '')}">${esc(tr(`settings.repo.clone.${r.clone_state}`))}</span>`,
    `<button type="button" class="lien-reglage" data-reclone="${r.id}" data-project="${esc(r.project)}">${esc(tr('settings.repo.reclone'))}</button>`,
  ].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="spacer"></div>
        <label class="muted" title="${esc(tr('settings.repo.fetch-mrs-title'))}"><input type="checkbox" data-fetch="${r.id}" ${r.fetch_mrs == null || r.fetch_mrs ? 'checked' : ''}/> ${tr('settings.repo.fetch-mrs')}</label>
        <label class="muted" title="${esc(tr('settings.repo.enabled-title'))}"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''}/> ${tr('settings.repo.enabled')}</label>
        ${/* B17 — LA FICHE. La ligne dit ce qui concerne le dépôt ; la fiche dit ce qui est
              ACCROCHÉ à lui — vérificateurs, jobs Jenkins, règles limitées, services de la
              grille, projets liés par défaut, agents. Six portes, chargées à la demande. */''}
        <button class="btn btn-sm" data-sheet="${r.id}" title="${esc(tr('settings.repo.sheet-title'))}"><svg class="ico"><use href="#i-link"/></svg>${esc(tr('settings.repo.sheet'))}</button>
        <button class="btn btn-sm" data-edit="${r.id}" title="${tr('settings.repo.edit-title')}"><svg class="ico"><use href="#i-edit"/></svg>${tr('settings.repo.edit')}</button>
        <button class="btn btn-icon btn-sm btn-danger" data-del="${r.id}" title="${tr('settings.repo.del-title')}"><svg class=\"ico\"><use href=\"#i-close\"/></svg></button>
      </div>
      <div class="repo-sheet" hidden></div>
      <div class="repo-edit" hidden>
        <input data-f="url" value="${esc(r.url)}" placeholder="${tr('settings.repo.ph.url')}" />
        <input data-f="project" value="${esc(r.project)}" placeholder="${tr('settings.repo.ph.project')}" />
        <input data-f="branch_pattern" value="${esc(r.branch_pattern || '')}" placeholder="${tr('settings.repo.ph.pattern')}" />
        <div class="repo-edit-actions">
          <button class="btn" data-cancel="${r.id}" title="${tr('settings.repo.cancel-title')}">${tr('ui.cancel')}</button>
          <button class="btn btn-primary" data-save="${r.id}" title="${tr('settings.repo.save-title')}">${tr('ui.save')}</button>
        </div>
      </div>
    </div>`).join('') : emptyState({ icon: 'inbox', title: tr('settings.repo.empty.title'), text: tr('settings.repo.empty.text') });

  const rowEl = (id) => $(`#repoList .repo-row[data-repo="${id}"]`);
  const toggleEdit = (id, editing) => {
    const row = rowEl(id);
    row.querySelector('.repo-view').hidden = editing;
    row.querySelector('.repo-edit').hidden = !editing;
  };

  $$('#repoList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-repo'), confirmLabel: tr('ui.delete') })) return;
    await api(`/repos/${b.dataset.del}`, { method: 'DELETE' }); loadRepos();
  }));
  $$('#repoList [data-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
    await api(`/repos/${cb.dataset.toggle}`, { method: 'PUT', body: { enabled: cb.checked } });
  }));
  /* Décocher ne touche pas aux MR DÉJÀ récupérées : elles restent dans la file, on cesse
     seulement d'en ramener de nouvelles. Le message le dit, sinon on croit à une purge. */
  $$('#repoList [data-fetch]').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api(`/repos/${cb.dataset.fetch}`, { method: 'PUT', body: { fetch_mrs: cb.checked } });
      toast(tr(cb.checked ? 'toast.repo.fetch-on' : 'toast.repo.fetch-off'));
    } catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
  $$('#repoList [data-sheet]').forEach((b) => b.addEventListener('click', () => ouvrirFicheDepot(b)));
  $$('#repoList [data-edit]').forEach((b) => b.addEventListener('click', () => toggleEdit(b.dataset.edit, true)));
  $$('#repoList [data-cancel]').forEach((b) => b.addEventListener('click', () => toggleEdit(b.dataset.cancel, false)));
  $$('#repoList [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const row = rowEl(b.dataset.save);
    const body = {};
    row.querySelectorAll('.repo-edit [data-f]').forEach((i) => { body[i.dataset.f] = i.value; });
    b.disabled = true;
    try { await api(`/repos/${b.dataset.save}`, { method: 'PUT', body }); toast(tr('toast.depot-mis-a-jour')); loadRepos(); }
    catch (e) { b.disabled = false; toast(e.message, true); }
  }));
  // Les répertoires locaux vivent dans le même panneau : ils se chargent avec lui.
  loadLocalRootSettings();
}
/* CE QUI RESSEMBLE À UNE URL DE DÉPÔT. Ni le champ ni le serveur ne vérifiaient quoi que ce
   soit : « toto » devenait un dépôt suivi, et l'erreur ne se voyait qu'au premier clonage.
   Deux formes acceptées, celles que les forges donnent à copier — HTTP(S) et SSH. */
/* Un chemin ABSOLU est une source de clonage parfaitement valide — `git clone /srv/depots/x.git`
   marche, c'est ce que fait le décor de démo, et c'est ce que font les tests. La première
   version de cette garde ne connaissait que http(s) et ssh : elle refusait un dépôt local. */
const RE_URL_DEPOT = /^(https?:\/\/\S+|file:\/\/\S+|\/\S+|(ssh:\/\/)?[\w.-]+@[\w.-]+[:/]\S+)$/i;

$('#repoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  viderErreursChamps(f);
  const url = f.url.value.trim();
  if (!RE_URL_DEPOT.test(url)) { signalerChamp(f.url, tr('err.repo-url-invalide')); return; }
  try {
    await api('/repos', { method: 'POST', body: { project: f.project.value, url, branch_pattern: f.branch_pattern.value } });
    f.project.value = ''; f.url.value = ''; f.branch_pattern.value = ''; loadRepos();
  } catch (err) { signalerChamp(f.url, explainError(err.message)); }
});

/* La recherche filtre la liste des dépôts suivis, sans rien décocher — même règle que partout
   ailleurs dans l'application. */
$('#repoSearch') && $('#repoSearch').addEventListener('input', debounce(() => {
  const q = ($('#repoSearch').value || '').toLowerCase().trim();
  let vus = 0;
  $$('#repoList .repo-row').forEach((row) => {
    const ok = !q || row.textContent.toLowerCase().includes(q);
    row.hidden = !ok;
    if (ok) vus += 1;
  });
  const vide = $('#repoSearchNone');
  if (vide) vide.hidden = vus > 0 || !q;
}));

/* ---- Réglages → Dépôts : les répertoires LOCAUX ----
   Rien n'est cloné ici : on déclare un dossier déjà présent sur la machine. Le
   décompte affiché (« 12 projets git sur 14 dossiers ») est ce qui dit d'un coup
   d'œil qu'on a désigné le bon niveau d'arborescence, et non son parent. */
async function loadLocalRootSettings() {
  const el = $('#localRootList');
  if (!el) return;
  await loadLocalRoots();
  el.innerHTML = localRoots.length ? localRoots.map((r) => `
    <div class="card local-root-card">
      <div style="min-width:0;flex:1">
        <div class="title">${esc(r.label || r.path)}
          <button class="btn btn-icon btn-sm btn-danger" data-rootdel="${r.id}" title="${esc(tr('settings.localroot.del-title'))}" style="float:right"><svg class="ico"><use href="#i-close"/></svg></button>
        </div>
        <div class="meta">${r.label ? `${esc(r.path)} · ` : ''}${r.error
          ? `<span class="t-err">${esc(r.error)}</span>`
          : esc(tr('settings.localroot.count', { n: r.count, count: r.count, git: r.git_count }))}</div>
        ${!r.error && r.projects && r.projects.length ? `<div class="local-root-projects">${r.projects.map((p) => `
          <span class="local-proj${p.git ? '' : ' local-proj-nogit'}" title="${esc(p.git ? tr('settings.localroot.proj-git', { branch: p.branch || '?' }) : tr('settings.localroot.proj-nogit'))}">
            <svg class="ico ico-sm"><use href="#${p.git ? 'i-branch' : 'i-doc'}"/></svg>${esc(p.name)}${p.git && p.branch ? ` <code>${esc(p.branch)}</code>` : ''}
          </span>`).join('')}</div>` : ''}
      </div>
    </div>`).join('')
    : emptyState({ icon: 'inbox', title: tr('settings.localroot.empty.title'), text: tr('settings.localroot.empty.text') });
  $$('#localRootList [data-rootdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-local-root'), confirmLabel: tr('ui.delete') })) return;
    try {
      await api(`/local-roots/${b.dataset.rootdel}`, { method: 'DELETE' });
      localProjectsCache.clear();
      toast(tr('toast.local-root-deleted'));
      loadLocalRootSettings();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#localRootForm') && $('#localRootForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/local-roots', { method: 'POST', body: { path: f.path.value, label: f.label.value } });
    f.path.value = ''; f.label.value = '';
    localProjectsCache.clear();
    toast(tr('toast.local-root-added'));
    loadLocalRootSettings();
  } catch (err) { toast(explainError(err.message), true); }
});

