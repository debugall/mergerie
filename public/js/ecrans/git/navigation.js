'use strict';
/* Navigation : positionner des projets locaux sur une branche distante. */
/* ---- Navigation : positionner des projets LOCAUX sur une branche distante ----
   Un répertoire local en haut, N lignes (projet, branche) en dessous. La branche
   COURANTE de chaque projet est affichée à côté du sélecteur : sans elle, on choisit
   à l'aveugle et on ne sait pas si l'opération a changé quoi que ce soit.
   Rien n'est jeté : le bilan dit projet par projet ce qui est passé, ce qui a échoué,
   et quels fichiers modifiés ont été emportés d'une branche à l'autre. */
let navRootId = '';                 // répertoire local courant
let navTargets = [{}];              // [{ name, branch, current }]
const navBranchCache = new Map();   // "rootId|projet" -> { branches, current }

async function navBranchesOf(rootId, name) {
  const key = `${rootId}|${name}`;
  if (!navBranchCache.has(key)) {
    // La promesse est mémoïsée : focus puis frappe ouvrent la liste deux fois de
    // suite, et chaque ouverture déclencherait sinon un `git fetch` complet.
    navBranchCache.set(key, api(`/local-projects/branches?root_id=${encodeURIComponent(rootId)}&name=${encodeURIComponent(name)}`));
  }
  try { return await navBranchCache.get(key); }
  catch (e) { navBranchCache.delete(key); throw e; }
}

function navDropResult() {
  const box = $('#navResultBox');
  if (box) box.hidden = true;
}

function navRenderRoot() {
  const box = $('#navRootBox');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('git.navigate.no-root'))}</span>`; return; }
  const cur = localRoots.find((r) => String(r.id) === String(navRootId)) || localRoots[0];
  navRootId = String(cur.id);
  box.innerHTML = comboHtml('nav-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'nav-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.nav-root', box).addEventListener('change', (e) => {
    navRootId = e.target.value;
    navTargets = [{}];        // les projets choisis appartenaient à l'autre répertoire
    navMemoriser();
    navDropResult();
    navRenderTargets();
  });
}

function navCurrentLabel(t) {
  return t.current ? tr('git.navigate.current', { branch: t.current }) : '';
}

function navTargetRow(idx, sel) {
  const cur = navCurrentLabel(sel);
  return `<div class="target-row nav-row" data-row="${idx}">
    ${comboHtml('nav-project', { value: sel.name || '', label: sel.name || '', ph: tr('git.navigate.ph.project') })}
    <span class="nav-current muted" title="${esc(cur)}">${esc(cur)}</span>
    ${comboHtml('nav-branch', { value: sel.branch || '', label: sel.branch || '', ph: tr('git.navigate.ph.branch') })}
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-navrm="${idx}" title="${esc(tr('git.navigate.remove-row'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}

/* Les projets de la Navigation se retiennent AUSSI, par répertoire : « checkout develop sur
   ces trois-là » est le geste du lundi matin, et on re-choisissait les trois. On ne retient
   que les NOMS de projet, pas la branche : elle, on la choisit à chaque fois — c'est même tout
   le propos de l'écran. */
const NAV_MEMO = 'aidevtools_git_nav_memo';
const navMemo = () => { try { return JSON.parse(localStorage.getItem(NAV_MEMO) || '{}'); } catch { return {}; } };
function navMemoriser() {
  if (!navRootId) return;
  try {
    const m = navMemo();
    m[navRootId] = navTargets.map((x) => x.name).filter(Boolean);
    localStorage.setItem(NAV_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}
async function navRestaurer() {
  if (!navRootId || navTargets.some((x) => x.name)) return;
  const noms = navMemo()[navRootId] || [];
  if (!noms.length) return;
  let dispo = [];
  try { dispo = (await localProjectsOf(navRootId)).filter((p) => p.git).map((p) => p.name); } catch { return; }
  const gardes = noms.filter((n) => dispo.includes(n));   // un projet disparu ne revient pas
  if (!gardes.length) return;
  navTargets = gardes.map((name) => ({ name }));
  navRenderTargets();
}

function navRenderTargets() {
  const el = $('#navTargetRows');
  if (!el) return;
  if (!localRoots.length) { el.innerHTML = `<p class="muted">${esc(tr('git.navigate.no-root'))}</p>`; return; }
  el.innerHTML = navTargets.map((t, i) => navTargetRow(i, t)).join('');
  // Seuls les dossiers qui SONT des dépôts git sont proposés : proposer les autres
  // reviendrait à laisser choisir une ligne qui échouera forcément au checkout.
  wireCombo(el, 'nav-project', async () => (await localProjectsOf(navRootId))
    .filter((p) => p.git)
    .map((p) => ({ value: p.name, label: p.name, hint: p.branch ? `· ${p.branch}` : '' })));
  wireCombo(el, 'nav-branch', async (row) => {
    const name = row.querySelector('.nav-project').value;
    if (!name) throw new Error(tr('git.navigate.pick-project-first'));
    const d = await navBranchesOf(navRootId, name);
    return d.branches.map((b) => ({ value: b.name, label: b.name, hint: b.date ? fmtDate(b.date) : '' }));
  });
}

function navReadTargets() {
  return $$('#navTargetRows .nav-row').map((row) => ({
    root_id: Number(navRootId),
    name: row.querySelector('.nav-project').value,
    branch: row.querySelector('.nav-branch').value,
  })).filter((t) => t.name);
}

/* Le choix d'un projet met à jour l'état ET la mémoire : sans lire l'écran ici, `navTargets`
   ne connaîtrait que les lignes ajoutées, pas les projets qu'on y a mis. */
$('#navTargetRows') && $('#navTargetRows').addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('nav-project')) return;
  navTargets = navReadTargets().map((x) => ({ name: x.name, branch: x.branch }));
  navMemoriser();
});

const NAV_STATE = {
  done: { cls: 'ok', icon: svgIco('check'), key: 'git.navigate.state.done' },
  done_dirty: { cls: 'warn', icon: svgIco('alert'), key: 'git.navigate.state.done-dirty' },
  already: { cls: 'ok', icon: svgIco('check'), key: 'git.navigate.state.already' },
  already_dirty: { cls: 'warn', icon: svgIco('alert'), key: 'git.navigate.state.already-dirty' },
  error: { cls: 'err', icon: svgIco('close'), key: 'git.navigate.state.error' },
};

function navRenderResult(d) {
  const box = $('#navResultBox');
  const rows = d.results.map((r) => {
    const st = NAV_STATE[r.state] || { cls: '', icon: '', key: null };
    const notes = [
      r.error ? `<div class="t-err">${esc(r.error)}</div>` : '',
      (r.from && r.from !== r.branch && r.state !== 'error') ? `<div class="muted">${esc(tr('git.navigate.from', { branch: r.from }))}</div>` : '',
      r.fetch_error ? `<div class="muted">${esc(tr('git.navigate.fetch-failed', { error: r.fetch_error }))}</div>` : '',
      r.ff_error ? `<div class="muted">${esc(tr('git.navigate.ff-failed', { error: r.ff_error }))}</div>` : '',
      r.local_only ? `<div class="muted">${esc(tr('git.navigate.local-only'))}</div>` : '',
      /* La LISTE des fichiers, pas seulement leur nombre : c'est elle qui dit ce qu'on
         emporte d'une branche à l'autre — un compte ne permet pas de le vérifier. */
      (r.files && r.files.length) ? `<details class="nav-files"><summary>${esc(tr('git.navigate.files', { n: r.files.length, count: r.files.length }))}</summary>`
        + `<ul>${r.files.map((f) => `<li><code>${esc(f.code)}</code> ${esc(f.file)}</li>`).join('')}</ul></details>` : '',
    ].join('');
    return `<tr class="git-pv-${st.cls}"><td>${esc(r.project)}</td><td><code>${esc(r.branch || '—')}</code></td>`
      + `<td>${st.icon} ${esc(st.key ? tr(st.key) : r.state)}${notes}</td></tr>`;
  }).join('');
  box.hidden = false;
  box.innerHTML = `<div class="box git-preview">
    <h4>${esc(tr('git.navigate.result'))}</h4>
    <div class="md-tablewrap"><table class="md-table"><thead><tr>
      <th>${esc(tr('git.col.project'))}</th><th>${esc(tr('git.col.branch'))}</th><th>${esc(tr('git.navigate.col.state'))}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted git-pv-counts">${esc(tr('git.navigate.counts', d.counts))}</p>
  </div>`;
}

async function navCheckout() {
  const btn = $('#navGo');
  const targets = navReadTargets();
  if (!targets.length) { toast(tr('err.navigate.no-target'), true); return; }
  // On refuse AVANT l'appel : une ligne sans branche ne produirait qu'une erreur de
  // plus dans le bilan, alors que c'est une saisie incomplète, pas un échec git.
  if (targets.some((t) => !t.branch)) { toast(tr('git.navigate.select-branch'), true); return; }
  $('#navInfo').textContent = tr('git.navigate.running');
  try {
    const d = await busy(btn, () => api('/navigate/checkout', { method: 'POST', body: { targets } }));
    navRenderResult(d);
    toast(tr('toast.navigate-done', { done: d.counts.done, failed: d.counts.failed }), d.counts.failed > 0);
    // Les branches courantes viennent de changer : le cache les décrirait à tort.
    localProjectsCache.delete(String(navRootId));
    navBranchCache.clear();
    for (const r of d.results) {
      const i = navTargets.findIndex((t) => t.name === r.project);
      if (i >= 0 && r.state !== 'error') navTargets[i] = { ...navTargets[i], current: r.branch };
    }
    navRenderTargets();
  } catch (e) { toast(explainError(e.message), true); }
  finally { $('#navInfo').textContent = ''; }
}

$('#navAddTarget') && $('#navAddTarget').addEventListener('click', () => { navTargets.push({}); navDropResult(); navRenderTargets(); navMemoriser(); });
$('#navGo') && $('#navGo').addEventListener('click', navCheckout);
document.addEventListener('change', (e) => {
  const row = e.target.closest && e.target.closest('.nav-row');
  if (!row) return;
  const i = Number(row.dataset.row);
  if (e.target.classList.contains('nav-project')) {
    const name = e.target.value;
    navTargets[i] = { name, current: localProjectBranch(navRootId, name) };
    // Changer de projet invalide la branche choisie : elle appartenait à l'autre dépôt.
    const hidden = row.querySelector('.nav-branch');
    if (hidden) { hidden.value = ''; hidden.dataset.label = ''; }
    const search = row.querySelector('[data-combo="nav-branch"]');
    if (search) { search.value = ''; search.title = ''; }
    const cell = row.querySelector('.nav-current');
    if (cell) { cell.textContent = navCurrentLabel(navTargets[i]); cell.title = cell.textContent; }
  }
  if (e.target.classList.contains('nav-branch')) navTargets[i] = { ...navTargets[i], branch: e.target.value };
  navDropResult();
});
document.addEventListener('click', (e) => {
  const rm = e.target.closest && e.target.closest('[data-navrm]');
  if (!rm) return;
  const i = Number(rm.dataset.navrm);
  if (navTargets.length > 1) { navTargets.splice(i, 1); navDropResult(); navRenderTargets(); navMemoriser(); }
});

