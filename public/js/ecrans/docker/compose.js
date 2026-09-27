'use strict';
/* Docker · Compose en affichage progressif, ce qu'on peut encore refaire. */
/* ============ Docker · Compose en affichage PROGRESSIF ============
 * D'abord la liste légère des fichiers (rapide : un scan + un `docker ps -a`), rendue en
 * cartes « placeholder » déjà triées ; puis le détail de chaque projet est chargé au fil de
 * l'eau (concurrence bornée) et remplace SA carte — l'écran se remplit sans tout attendre. */
const COMPOSE = { files: [], details: new Map() };

async function pMapFront(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i; i += 1; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
}

function dockerPlaceholderCard(f) {
  return `<div class="card docker-project docker-ph">
      <div class="docker-project-head">
        <div class="title" style="flex:1;min-width:0"><code>${esc(f.name)}</code> <span class="muted">${esc(f.file)} · ${esc(f.rootLabel || f.dir)}</span></div>
        <span class="muted dlog-loading"><span class="spin"></span> ${esc(tr('docker.loading'))}${f.count ? ` · ${f.count}` : ''}</span>
      </div>
    </div>`;
}

function renderComposeTab() {
  const box = $('#dockerComposeBox');
  if (!box) return;
  if (!COMPOSE.files.length) { box.innerHTML = emptyState({ icon: 'inbox', title: tr('docker.compose.empty.title'), text: tr('docker.compose.empty.text') }); return; }
  const hidden = dockerHidden();
  const sf = composeSvcFilter();
  // Recherche + état : mêmes intitulés et mêmes valeurs que le sous-onglet Actions.
  // Recherche et état ont la MÊME structure (.dact-action : libellé au-dessus du contrôle),
  // sinon un champ nu se centrerait contre un bloc plus haut et les deux seraient décalés.
  const svcBar = `<div class="docker-svcbar">
      <label class="dact-action dact-action-grow"><span>${esc(tr('docker.compose.search-label'))}</span>
        <input id="dcSearch" class="dact-search" type="search" value="${esc(sf.q || '')}"
          placeholder="${esc(tr('docker.compose.search'))}" />
      </label>
      <div class="dact-action"><span>${esc(tr('docker.actions.filter'))}</span>
        <div id="dcState" class="chips" role="group" aria-label="${esc(tr('docker.actions.filter'))}" data-state="${esc(sf.state)}">${dockerStateChips(sf.state)}</div>
      </div>
    </div>`;
  // Filtre persistant : une case par fichier compose (cochée = affiché).
  const filter = `<div class="docker-filter"><span class="muted">${esc(tr('docker.filter.label'))}</span>${COMPOSE.files.map((f) => `
      <label class="inline-check inline-check-mid"><input type="checkbox" class="docker-filter-cb" value="${esc(f.path)}" ${hidden.has(f.path) ? '' : 'checked'} /> <span>${esc(f.name)}</span></label>`).join('')}</div>`;
  const visible = COMPOSE.files.filter((f) => !hidden.has(f.path));
  const slots = visible.map((f) => {
    const d = COMPOSE.details.get(f.path);
    // Détail pas encore chargé : on garde le squelette, sinon un filtre actif masquerait
    // des projets qu'on n'a simplement pas encore reçus.
    const inner = d ? (d.__error ? errorBox(d.__error) : dockerProjectCard(d)) : dockerPlaceholderCard(f);
    return inner ? `<div class="docker-slot" data-path="${esc(f.path)}">${inner}</div>` : '';
  }).join('');
  const empty = visible.length
    ? (composeFilterActive() ? `<p class="muted">${esc(tr('docker.filter.no-svc-match'))}</p>` : '')
    : `<p class="muted">${esc(tr('docker.filter.all-hidden'))}</p>`;
  box.innerHTML = svcBar + filter + (slots || empty);
  majDernieresCibles();          // « migrate · il y a 40 min · ✓ », posé après le rendu
  wireDockerActions(box);
  const search = $('#dcSearch', box);
  if (search) {
    // Debounce : chaque frappe reconstruit toutes les cartes de projet (et les recâble).
    const apply = debounce(() => {
      const pos = search.selectionStart;
      renderComposeTab();                                  // filtrage local : aucun appel Docker
      const again = $('#dcSearch');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* champ recréé */ } }
    });
    search.addEventListener('input', () => { setComposeSvcFilter({ q: search.value }); apply(); });
  }
  const stateSel = $('#dcState', box);
  if (stateSel) stateSel.addEventListener('click', (e) => {
    const c = e.target.closest('[data-dstate]'); if (!c) return;
    setComposeSvcFilter({ state: c.dataset.dstate }); renderComposeTab();
  });
  $$('.docker-filter-cb', box).forEach((cb) => cb.addEventListener('change', () => {
    const set = dockerHidden();
    if (cb.checked) set.delete(cb.value); else set.add(cb.value);
    setDockerHidden(set);
    renderComposeTab();               // ré-rendu instantané (les détails déjà chargés viennent du cache)
    fetchVisibleComposeDetails();     // charge ceux nouvellement affichés
  }));
}

function fillComposeSlot(path) {
  const box = $('#dockerComposeBox'); if (!box) return;
  const slot = $$('.docker-slot', box).find((s) => s.dataset.path === path);
  if (!slot) return;
  const d = COMPOSE.details.get(path);
  const html = d && d.__error ? errorBox(d.__error) : dockerProjectCard(d);
  // Le détail arrive après coup : s'il ne passe pas le filtre, le slot disparaît.
  if (!html) { slot.remove(); return; }
  slot.innerHTML = html;
  wireDockerActions(slot);
  majDernieresCibles();     // le détail arrive après coup : ses cibles aussi
  remplirGrilleLocale([d]); // B8 : idem — la case « local » de la grille, si elle est vide
}

async function fetchVisibleComposeDetails() {
  const hidden = dockerHidden();
  const todo = COMPOSE.files.filter((f) => !hidden.has(f.path) && !COMPOSE.details.has(f.path));
  await pMapFront(todo, 5, async (f) => {
    let detail;
    try {
      const d = await api(`/docker/compose/one?dir=${encodeURIComponent(f.dir)}&file=${encodeURIComponent(f.file)}`);
      detail = d.error ? { __error: d.error } : (d.project || { __error: tr('docker.compose.empty.title') });
    } catch (e) { detail = { __error: explainError(e.message) }; }
    COMPOSE.details.set(f.path, detail);
    fillComposeSlot(f.path);
  });
}

async function loadComposeProgressive() {
  const box = $('#dockerComposeBox');
  box.innerHTML = skeleton(2);
  let list;
  try { list = await api('/docker/compose/list'); }
  catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  if (list.error) { box.innerHTML = errorBox(list.error); return; }
  COMPOSE.files = list.files || [];
  COMPOSE.details = new Map();
  renderComposeTab();
  await fetchVisibleComposeDetails();
}

/* A/Docker 1 — CE QU'ON PEUT ENCORE REFAIRE. Avant chaque suppression d'un container
   hors-compose, l'outil sauvegarde son `inspect` complet ; personne ne le relisait. Le bloc
   n'apparaît que s'il y a quelque chose à restaurer — un cadre vide sur chaque visite
   ferait passer un filet pour une corvée. */
async function chargerSauvegardesDocker() {
  const box = $('#dockerBackupsBox');
  if (!box) return;
  let liste = [];
  try { liste = await api('/docker/backups'); } catch { liste = []; }
  if (!Array.isArray(liste) || !liste.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="bloc-t">${esc(tr('docker.backups.title'))}</h3>
    <p class="muted">${esc(tr('docker.backups.intro'))}</p>
    <div class="list">${liste.map((b) => `<div class="card dk-backup">
      <div class="dk-backup-main">
        <strong>${esc(b.name || b.container_id.slice(0, 12))}</strong>
        <span class="muted"> · ${esc(b.image || '')} · <span data-when="${esc(b.created_at)}">${esc(fmtDate(b.created_at))}</span></span>
        <pre class="dk-backup-cmd">${esc(b.run_command || '')}</pre>
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" data-copy-cmd="${esc(b.run_command || '')}" title="${esc(tr('docker.backups.copy'))}">${svgIco('copy')}</button>
      <button type="button" class="btn btn-sm btn-primary" data-dk-restore="${b.id}">${esc(tr('docker.backups.restore'))}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-dk-bk-del="${b.id}" title="${esc(tr('docker.backups.forget'))}">${svgIco('close')}</button>
    </div>`).join('')}</div>`;
}
document.addEventListener('click', async (e) => {
  const r = e.target.closest && e.target.closest('[data-dk-restore]');
  if (r) {
    /* Recréer un container est une écriture sur la machine : on nomme ce qui va être refait,
       comme toute action Docker de l'outil. */
    if (!await confirmDialog({
      title: tr('docker.backups.confirm.title'),
      text: tr('docker.backups.confirm.text'),
      confirmLabel: tr('docker.backups.restore'), danger: false,
    })) return;
    try { await busy(r, () => api(`/docker/backups/${r.dataset.dkRestore}/restore`, { method: 'POST' })); refreshStatus(); }
    catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const d = e.target.closest && e.target.closest('[data-dk-bk-del]');
  if (!d) return;
  if (!await confirmDialog({ text: tr('docker.backups.forget.confirm'), confirmLabel: tr('ui.delete') })) return;
  try { await api(`/docker/backups/${d.dataset.dkBkDel}`, { method: 'DELETE' }); await chargerSauvegardesDocker(); }
  catch (err) { toast(explainError(err.message), true); }
});

function renderDockerOrphans(d) {
  const box = $('#dockerOrphansBox');
  if (d.error) { box.innerHTML = errorBox(d.error); return; }
  const orphans = d.orphans || [];
  if (!orphans.length) { box.innerHTML = emptyState({ icon: 'inbox', title: tr('docker.orphans.empty.title'), text: tr('docker.orphans.empty.text') }); return; }
  box.innerHTML = `<p class="muted">${esc(tr('docker.orphans.intro'))}</p>` + orphans.map((c) => {
    const state = c.state || 'unknown';
    const label = dockerStateLabel(state);   // même libellé traduit que dans Compose
    return `
    <div class="card docker-orphan">
      <div style="flex:1;min-width:0">
        <div class="title"><span class="docker-state docker-state-${esc(state)}" title="${esc(label)}"><span class="docker-dot"></span>${esc(label)}</span> ${esc(c.name)} <code class="muted">${esc(c.image)}</code></div>
        <div class="meta muted">${esc(c.status || '')}${c.ports ? ` · ${esc(c.ports)}` : ''}</div>
        <pre class="docker-run" data-run="${esc(c.id)}" hidden></pre>
      </div>
      <div class="task-actions">
        <button class="btn btn-sm btn-danger" data-dockerstop="${esc(c.id)}"${state === 'running' ? ` title="${esc(tr('docker.orphan.stop-title'))}"` : ` disabled title="${esc(tr('docker.act.unavailable'))}"`}><svg class="ico ico-sm"><use href="#i-stop"/></svg>${esc(tr('docker.orphan.stop'))}</button>
        <button class="btn btn-sm" data-dockerrun="${esc(c.id)}" title="${esc(tr('docker.orphan.reconstitute-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('docker.orphan.reconstitute'))}</button>
        <button class="btn btn-sm btn-danger" data-dockerrm="${esc(c.id)}" data-name="${esc(c.name)}" title="${esc(tr('docker.orphan.remove-title'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg>${esc(tr('docker.orphan.remove'))}</button>
        ${/* B16 — « ce conteneur retombe toutes les nuits » : la note se prend devant le
              conteneur, pas dans une page de notes ouverte à côté. */''}
        ${addTodoBtn('container', c.name, tr('notes.add-todo.container', { name: c.name }))}
      </div>
    </div>`;
  }).join('');
  wireDockerActions(box);
}

function wireDockerActions(box) {
  $$('[data-dockeract]', box).forEach((b) => b.addEventListener('click', async () => {
    const services = b.dataset.svc ? [b.dataset.svc] : [];
    const { dir } = b.dataset;
    const action = b.dataset.dockeract;
    const run = (a) => api('/docker/compose/action', { method: 'POST', body: { dir, action: a, services } });
    try {
      await busy(b, () => run(action));
      // Un stop de service se rattrape par un up : on l'offre plutôt que de le faire confirmer.
      if (action === 'stop' && services.length) {
        toastUndo(tr('docker.act.started'), () => run('up')
          .then(() => { toast(tr('docker.act.started')); refreshStatus(); })
          .catch((e) => toast(explainError(e.message), true)));
      } else toast(tr('docker.act.started'));
      refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerdown]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      const pv = await api('/docker/compose/preview-down', { method: 'POST', body: { dir: b.dataset.dir, project: b.dataset.project } });
      const lines = (pv.containers || []).map((c) => `• ${c.name}${c.service ? ` (${c.service})` : ''}`).join('\n');
      const ok = await confirmDialog({
        text: `${tr('docker.down.confirm', { n: (pv.containers || []).length })}\n${tr('docker.down.volumes')}`,
        detail: lines, confirmLabel: tr('docker.act.down'),
      });
      if (!ok) return;
      await busy(b, () => api('/docker/compose/action', { method: 'POST', body: { dir: b.dataset.dir, action: 'down', services: [] } }));
      toast(tr('docker.act.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerrun]', box).forEach((b) => b.addEventListener('click', async () => {
    const pre = $(`.docker-run[data-run="${b.dataset.dockerrun}"]`, box);
    if (pre && !pre.hidden) { pre.hidden = true; return; }
    try { const d = await busy(b, () => api(`/docker/orphan/${b.dataset.dockerrun}/reconstitute`)); if (pre) { pre.textContent = d.command || ''; pre.hidden = false; } }
    catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerstop]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      await busy(b, () => api(`/docker/orphan/${b.dataset.dockerstop}/stop`, { method: 'POST' }));
      toast(tr('docker.act.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  // Recherche instantanée dans les commandes du Makefile.
  $$('.mk-search', box).forEach((inp) => inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    const wrap = inp.closest('.docker-make');
    let shown = 0;
    $$('.mk-item', wrap).forEach((it) => {
      const hit = !q || `${it.dataset.name} ${it.dataset.desc}`.toLowerCase().includes(q);
      it.hidden = !hit; if (hit) shown += 1;
    });
    $('.mk-none', wrap).hidden = shown > 0;
  }));
  // Exécution d'une commande make (log streamé, comme les actions compose).
  $$('.mk-run', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      await busy(b, () => api('/docker/make/run', { method: 'POST', body: { dir: b.dataset.dir, target: b.dataset.target } }));
      toast(tr('docker.make.started', { target: b.dataset.target })); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerrm]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('docker.orphan.remove-confirm', { name: b.dataset.name }), confirmLabel: tr('ui.delete') })) return;
    try {
      await busy(b, () => api(`/docker/orphan/${b.dataset.dockerrm}/remove`, { method: 'POST' }));
      toast(tr('docker.orphan.removed')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#gitSameName').addEventListener('change', () => {
  $('#gitNameRow').hidden = !gitSameName();
  gitDropPreview();                    // l'aperçu ne correspond plus à la saisie
  gitRenderTargets();
});
$('#gitAddTarget').addEventListener('click', () => { gitTargets.push({}); gitDropPreview(); gitRenderTargets(); });
$('#gitPreview').addEventListener('click', gitDoPreview);
$('#gitExploreGo').addEventListener('click', gitAnalyze);
document.addEventListener('change', (e) => {
  // L'index vient de la LIGNE, pas de l'élément : l'input caché du combo dépôt
  // ne porte pas data-row (il vit dans le combo, pas directement sur la ligne).
  const gitRow = e.target.closest && e.target.closest('.git-row');
  if (!gitRow) return;
  const i = Number(gitRow.dataset.row);
  if (e.target.classList.contains('git-repo')) {
    // Changer de dépôt invalide la ref choisie, pas le nom saisi pour la ligne.
    gitTargets[i] = { repo_id: Number(e.target.value), name: (gitTargets[i] || {}).name };
    gitFillRow(i);
  }
  if (e.target.classList.contains('git-ref')) {
    gitTargets[i] = { ...gitTargets[i], ref: e.target.value };
  }
  gitDropPreview();   // dépôt ou ref source changés : l'aperçu ne les décrit plus
});
// Les noms par projet sont mémorisés à la frappe : ajouter ou retirer une ligne
// redessine TOUTES les lignes, et une saisie restée dans le DOM serait perdue.
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-name')) return;
  const i = Number(e.target.dataset.row);
  gitTargets[i] = { ...gitTargets[i], name: e.target.value };
  gitDropPreview();
});
/* Filtre de la liste de refs à supprimer. Purement visuel : on masque des lignes, on n'en
   décoche aucune — la sélection appartient à l'utilisateur, pas au filtre. */
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-ref-filter')) return;
  const list = e.target.closest('.git-refs').querySelector('.git-ref-list');
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const it of list.querySelectorAll('.git-ref-item')) {
    const hit = !q || it.dataset.name.includes(q);
    it.hidden = !hit;
    if (hit) shown += 1;
  }
  list.querySelector('.git-ref-nomatch').hidden = shown > 0;
});
/* Retoucher un nom APRÈS l'aperçu périme celui-ci : l'exécution relit les champs,
   pas le tableau affiché. Sans ça on prévisualise v2.3.0, on corrige en v2.4.0, et
   c'est v2.4.0 qui part sous un tableau qui annonce toujours v2.3.0 — alors que
   l'aperçu est censé ÊTRE la confirmation. */
$('#gitRefName').addEventListener('input', gitDropPreview);
$('#gitTagMsg').addEventListener('input', gitDropPreview);
document.addEventListener('click', (e) => {
  const rm = e.target.closest && e.target.closest('[data-gitrm]');
  if (!rm) return;
  const i = Number(rm.dataset.gitrm);
  if (gitTargets.length > 1) { gitTargets.splice(i, 1); gitDropPreview(); gitRenderTargets(); }
});

