'use strict';
/* Git · Commandes multi-projets, ce qu'on refait tous les matins se retient. */
/* ============ Git · Commandes multi-projets (onglet « Commandes Git ») ============
 * Choisir un répertoire local → cocher des projets → une commande git (palette ou libre) →
 * prévisualiser → exécuter à la racine de chacun → sortie par projet. Réutilise localRoots /
 * localProjectsOf de la Navigation. Palette alimentée par Réglages → Git (/git-commands). */
const CMD = { rootId: null, selected: new Set(), palette: [], projects: [] };

/* ---------- Ce qu'on refait tous les matins se retient ----------
   `git fetch --all --prune` sur les mêmes cinq projets, tous les jours : on re-cochait les
   cinq, on re-choisissait la commande. Les deux se mémorisent PAR RÉPERTOIRE LOCAL — deux
   racines n'ont ni les mêmes projets ni les mêmes habitudes. Confort pur : perdre ce stockage
   ne fait perdre que la pré-sélection. */
const CMD_MEMO = 'aidevtools_git_cmd_memo';
const cmdMemo = () => { try { return JSON.parse(localStorage.getItem(CMD_MEMO) || '{}'); } catch { return {}; } };
function cmdMemoriser(patch) {
  if (!CMD.rootId) return;
  try {
    const m = cmdMemo();
    m[CMD.rootId] = { ...(m[CMD.rootId] || {}), ...patch };
    localStorage.setItem(CMD_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}

function cmdRenderRoot() {
  const box = $('#cmdRootBox'); if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('git.navigate.no-root'))}</span>`; $('#cmdProjectBox').innerHTML = ''; return; }
  const cur = localRoots.find((r) => String(r.id) === String(CMD.rootId)) || localRoots[0];
  CMD.rootId = String(cur.id);
  box.innerHTML = comboHtml('cmd-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'cmd-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.cmd-root', box).addEventListener('change', (e) => { CMD.rootId = e.target.value; CMD.selected.clear(); cmdRenderProjects(); });
  cmdRenderProjects();
}

async function cmdRenderProjects() {
  const box = $('#cmdProjectBox'); if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<p class="muted">${esc(tr('git.navigate.no-root'))}</p>`; return; }
  box.innerHTML = skeleton(1);
  let projects = [];
  try { projects = (await localProjectsOf(CMD.rootId)).filter((p) => p.git); }
  catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  CMD.projects = projects;
  /* La sélection retenue pour CETTE racine, filtrée sur ce qui existe encore : un projet
     supprimé depuis ne doit pas revenir coché — ni compter dans « 5 projets choisis ». */
  if (!CMD.selected.size) {
    const gardes = (cmdMemo()[CMD.rootId] || {}).projects || [];
    for (const nom of gardes) if (projects.some((p) => p.name === nom)) CMD.selected.add(nom);
  }
  if (!projects.length) { box.innerHTML = `<p class="muted">${esc(tr('git.commands.no-project'))}</p>`; cmdUpdateCount(); return; }
  box.innerHTML = `<div class="cmd-picker-top">
      <input class="cmd-search" type="search" placeholder="${esc(tr('git.commands.search-ph'))}" />
      <label class="cmd-selall"><input type="checkbox" id="cmdSelAll" /> <span>${esc(tr('git.commands.select-all'))}</span></label>
    </div>
    <div class="cmd-plist">${projects.map((p) => `<label class="cmd-pitem"><input type="checkbox" value="${esc(p.name)}"${CMD.selected.has(p.name) ? ' checked' : ''}/>
      <span class="cmd-pname">${esc(p.name)}</span>${p.branch ? `<span class="cmd-pbranch muted">${esc(p.branch)}</span>` : ''}</label>`).join('')}</div>`;
  cmdUpdateCount();
  /* La dernière commande de CE répertoire est reproposée dans le champ — vide seulement, pour
     ne jamais écraser ce qu'on est en train d'écrire. */
  const champ = $('#cmdInput');
  const derniere = (cmdMemo()[CMD.rootId] || {}).command;
  if (champ && !champ.value && derniere) champ.value = derniere;
}

function cmdUpdateCount() {
  const el = $('#cmdPickCount');
  if (el) el.textContent = CMD.selected.size ? tr('git.commands.picked', { n: CMD.selected.size, count: CMD.selected.size }) : '';
  const boxes = $$('#cmdProjectBox .cmd-plist input[type="checkbox"]');
  const all = $('#cmdSelAll'); const checked = boxes.filter((b) => b.checked).length;
  if (all) { all.checked = boxes.length > 0 && checked === boxes.length; all.indeterminate = checked > 0 && checked < boxes.length; }
}

async function loadGitCommands() {
  try { CMD.palette = await api('/git-commands'); } catch { CMD.palette = []; }
  const sel = $('#cmdPalette');
  if (sel) sel.innerHTML = `<option value="">${esc(tr('git.commands.palette-ph'))}</option>`
    + CMD.palette.map((c) => `<option value="${esc(c.command)}">${esc(c.label)} — git ${esc(c.command)}</option>`).join('');
  cmdRenderRoot();
}

function cmdReadTargets() { return [...CMD.selected].map((name) => ({ root_id: Number(CMD.rootId), name })); }

/* Commandes git qui peuvent détruire du travail non poussé. La prévisualisation liste bien
   les projets ciblés, mais elle n'alerte pas : `git reset --hard` sur trente dépôts ne se
   rattrape pas. On ne demande confirmation que pour ces verbes-là — confirmer un `git fetch`
   n'apprendrait qu'à cliquer sans lire. */
const GIT_DESTRUCTIVE = [
  /(^|\s)reset\s+.*(--hard|--merge|--keep)/, /(^|\s)clean\s+.*-[a-zA-Z]*[fdx]/,
  /(^|\s)checkout\s+.*(-f|--force)/, /(^|\s)switch\s+.*(-f|--force|--discard-changes)/,
  /(^|\s)push\s+.*(--force|--delete|\s-f(\s|$)|\s-d(\s|$))/,
  /(^|\s)branch\s+.*-D/, /(^|\s)tag\s+.*(-d|--delete)/,
  /(^|\s)(rm|restore|rebase|filter-branch)(\s|$)/,
  /(^|\s)stash\s+(drop|clear)/, /(^|\s)update-ref\s+.*-d/, /(^|\s)gc\s+.*--prune/,
];
function gitCmdIsDestructive(cmd) { return GIT_DESTRUCTIVE.some((re) => re.test(cmd)); }

function cmdPreview() {
  const targets = cmdReadTargets();
  const command = ($('#cmdInput').value || '').trim();
  if (!targets.length) { toast(tr('err.gitcmd.no-target'), true); return; }
  if (!command) { toast(tr('err.gitcmd.empty'), true); return; }
  // La commande qu'on vient d'aller jusqu'à prévisualiser est celle qu'on refera demain.
  cmdMemoriser({ command });
  const box = $('#cmdPreviewBox'); box.hidden = false; $('#cmdResultBox').hidden = true;
  box.innerHTML = `<div class="box cmd-preview">
    <h4>${esc(tr('git.commands.preview-h'))}</h4>
    <p><code class="cmd-full">git ${esc(command)}</code></p>
    <p class="muted">${esc(tr('git.commands.on-projects', { n: targets.length, count: targets.length }))}</p>
    <ul class="cmd-preview-list">${targets.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>
    <div class="form-actions">
      <button id="cmdCancel" class="btn">${esc(tr('git.commands.cancel'))}</button>
      <button id="cmdRun" class="btn btn-primary"><svg class="ico"><use href="#i-play"/></svg>${esc(tr('git.commands.execute'))}</button>
    </div>
  </div>`;
  $('#cmdRun').addEventListener('click', async () => {
    if (gitCmdIsDestructive(command) && !await confirmDialog({
      title: tr('git.commands.confirm-title'),
      text: tr('git.commands.confirm-text', { n: targets.length, count: targets.length }),
      detail: `git ${command}`,
      confirmLabel: tr('git.commands.execute'),
    })) return;
    cmdExecute(targets, command);
  });
  $('#cmdCancel').addEventListener('click', () => { box.hidden = true; });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function cmdExecute(targets, command) {
  const btn = $('#cmdRun');
  try {
    const d = await busy(btn, () => api('/git-run', { method: 'POST', body: { targets, command } }));
    $('#cmdPreviewBox').hidden = true;
    cmdRenderResult(d);
    toast(tr('git.commands.done', { ok: d.counts.ok, failed: d.counts.failed }), d.counts.failed > 0);
  } catch (e) { toast(explainError(e.message), true); }
}

function cmdRenderResult(d) {
  const box = $('#cmdResultBox'); box.hidden = false;
  const rows = d.results.map((r) => `<div class="cmd-res ${r.ok ? 'ok' : 'err'}">
    <div class="cmd-res-head"><span class="dlog-dot ${r.ok ? 'run' : 'stop'}"></span><strong>${esc(r.project)}</strong>
      <span class="muted">${r.ok ? esc(tr('git.commands.exit-ok')) : esc(tr('git.commands.exit-code', { code: r.code }))}</span></div>
    <pre class="cmd-res-out">${esc(r.output || '')}${r.truncated ? '\n…' : ''}</pre>
  </div>`).join('');
  box.innerHTML = `<div class="box"><h4>${esc(tr('git.commands.result'))} — <code>${esc(d.command)}</code></h4>
    <p class="muted">${esc(tr('git.commands.counts', d.counts))}</p>${rows}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#cmdPalette') && $('#cmdPalette').addEventListener('change', (e) => { if (e.target.value) $('#cmdInput').value = e.target.value; });
$('#cmdPreview') && $('#cmdPreview').addEventListener('click', cmdPreview);
$('#cmdProjectBox') && $('#cmdProjectBox').addEventListener('change', (e) => {
  if (e.target.id === 'cmdSelAll') {
    for (const cb of $$('#cmdProjectBox .cmd-plist input[type="checkbox"]')) { cb.checked = e.target.checked; if (e.target.checked) CMD.selected.add(cb.value); else CMD.selected.delete(cb.value); }
    cmdUpdateCount(); cmdMemoriser({ projects: [...CMD.selected] }); return;
  }
  const cb = e.target.closest('.cmd-plist input[type="checkbox"]'); if (!cb) return;
  if (cb.checked) CMD.selected.add(cb.value); else CMD.selected.delete(cb.value);
  cmdUpdateCount();
  cmdMemoriser({ projects: [...CMD.selected] });   // demain, les mêmes cinq seront déjà cochés
});
$('#cmdProjectBox') && $('#cmdProjectBox').addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('cmd-search')) return;
  const q = e.target.value.toLowerCase().trim();
  $$('#cmdProjectBox .cmd-pitem').forEach((it) => { it.hidden = !!q && !$('.cmd-pname', it).textContent.toLowerCase().includes(q); });
});

