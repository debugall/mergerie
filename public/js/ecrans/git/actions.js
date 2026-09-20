'use strict';
/* Onglet Git : opérations multi-dépôts (créer, supprimer, aperçu), B7 supprimer les branches de MR mergées. */
// @expose brMergees, gitDoPreview, gitDropPreview, gitFillRow, gitLoadRefs, gitRenderTargets, gitSameName, gitTargets
/* ---------- Onglet Git : opérations multi-dépôts + explorateur ----------
   Deux principes structurent cet écran :
   - on ne SAISIT un nom que s'il n'existe pas encore ; dès qu'il existe, on le
     CHOISIT dans une liste. Supprimer par saisie libre, répliqué sur N dépôts,
     c'est la faute de frappe qui touche juste sans qu'on s'en aperçoive ;
   - rien ne s'exécute sans aperçu. L'aperçu EST la confirmation. */

/* A/Git 1 — les dépôts de la dernière fois, s'ils existent encore. Un dépôt retiré depuis
   est écarté en silence : proposer une ligne qu'on ne peut pas choisir vaut moins que rien. */
let gitTargets = (() => {
  try {
    const ids = (JSON.parse(localStorage.getItem('aidevtools_git_actions') || '{}').repos) || [];
    return ids.length ? ids.map((id) => ({ repo_id: Number(id) })) : [{}];
  } catch { return [{}]; }
})();          // [{ repo_id, ref, refs: [], name }]
let gitRefsCache = {};          // "repoId|kind" -> { refs, default }
let gitPreviewData = null;

/* A/Git 1 — ACTIONS SE SOUVIENT, comme Navigation et Commandes. Trois sous-onglets voisins,
   deux politiques de mémoire : on rouvrait « Actions » sur « Créer une branche » et une ligne
   vide, alors qu'on y vient presque toujours pour la même opération sur les mêmes dépôts.
   L'action et les DÉPÔTS sont retenus ; ni les noms de branche (ils changent à chaque fois)
   ni les refs cochées pour une suppression — recocher est justement le geste qui fait relire
   ce qu'on s'apprête à supprimer. */
const GIT_ACT_MEMO = 'aidevtools_git_actions';
const gitActMemo = () => { try { return JSON.parse(localStorage.getItem(GIT_ACT_MEMO) || '{}'); } catch { return {}; } };
function gitActMemoriser() {
  try {
    localStorage.setItem(GIT_ACT_MEMO, JSON.stringify({
      action: ($('#gitAction') || {}).value || 'new_branch',
      repos: $$('#gitTargetRows .git-repo').map((el) => Number(el.value)).filter(Boolean),
    }));
  } catch { /* stockage indisponible */ }
}

const gitAction = () => ($('#gitAction') || {}).value || 'new_branch';
const gitIsDelete = () => /^delete_/.test(gitAction());
const gitIsTag = () => /_tag$/.test(gitAction());
// Le nom de la ref à créer est saisi soit UNE fois pour tout le lot (le cas
// courant), soit dans chaque ligne quand les conventions diffèrent d'un dépôt à
// l'autre. C'est la même opération, pas deux écrans : seule la saisie se déplace.
const gitSameName = () => { const c = $('#gitSameName'); return !c || c.checked; };
const gitPerProjectName = () => !gitIsDelete() && !gitSameName();

/* Quelles refs proposer pour l'action courante : on ne supprime des tags que dans
   « supprimer un tag » ; partout ailleurs on part d'une branche. */
function gitRefKind() {
  return gitIsTag() && gitIsDelete() ? 'tags' : 'branches';
}
// « Rechercher un tag » quand c'est un tag qu'on choisit : le libellé doit dire le vrai.
const gitRefSearchPh = () => tr(gitRefKind() === 'tags' ? 'git.refs.search-ph-tag' : 'git.refs.search-ph');

async function gitLoadRefs(repoId, kind) {
  const key = repoId + '|' + kind;
  if (gitRefsCache[key]) return gitRefsCache[key];
  const d = await api('/git/refs?repo_id=' + repoId + '&kind=' + kind);
  gitRefsCache[key] = d;
  return d;
}

function gitTargetRow(idx, sel) {
  // Dépôt : combo avec recherche (la liste peut compter des dizaines de projets).
  // L'input caché porte la classe `git-repo`, lu par la délégation 'change'.
  const repo = repoComboHtml(sel.repo_id, { idClass: 'git-repo' });
  /* À la suppression, la sélection est MULTIPLE : on coche ce qu'on supprime, avec un
     filtre au-dessus de la liste. Sinon c'est un choix unique — combo avec recherche,
     comme pour les dépôts : un dépôt actif compte souvent des centaines de branches,
     qu'aucune liste déroulante native ne rend parcourable. */
  const picker = gitIsDelete()
    ? '<div class="git-refs" data-row="' + idx + '"><span class="muted">' + esc(tr('git.refs.loading')) + '</span></div>'
    : comboHtml('git-ref', { ph: tr('git.refs.loading'), wrapClass: 'git-ref-combo' });
  // Nom par projet : le champ n'apparaît que si l'utilisateur a décoché « le même
  // pour tous ». Il porte son propre libellé accessible, la ligne n'en ayant pas.
  const nameLbl = gitIsTag() ? tr('git.lbl.tag-name') : tr('git.lbl.branch-name');
  const nameInput = gitPerProjectName()
    ? '<input class="git-name" data-row="' + idx + '" value="' + esc(sel.name || '') + '"' +
      ' placeholder="' + esc(gitIsTag() ? tr('git.ph.tag-name') : tr('git.ph.name')) + '"' +
      ' aria-label="' + esc(nameLbl) + '" title="' + esc(nameLbl) + '" />'
    : '';
  return '<div class="target-row git-row" data-row="' + idx + '">' +
    repo +
    picker +
    nameInput +
    '<button type="button" class="btn btn-icon btn-sm btn-danger" data-gitrm="' + idx + '" title="' + esc(tr('git.title.remove-row')) + '"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>' +
    '</div>';
}

async function gitFillRow(idx) {
  const row = $('#gitTargetRows .git-row[data-row="' + idx + '"]');
  if (!row) return;
  const repoId = Number(row.querySelector('.git-repo').value);
  if (!repoId) return;
  const kind = gitRefKind();
  let d;
  try { d = await gitLoadRefs(repoId, kind); }
  catch (e) {
    const box = row.querySelector('.git-refs, .git-ref');
    if (box) box.innerHTML = '<span class="t-err">' + esc(explainError(e.message)) + '</span>';
    return;
  }
  if (gitIsDelete()) {
    const box = row.querySelector('.git-refs');
    if (!box) return;
    // La branche par défaut et les refs protégées ne sont PAS proposées :
    // on ne peut pas cocher par erreur ce que le serveur refuserait ensuite.
    const sel = (gitTargets[idx] && gitTargets[idx].refs) || [];
    const list = d.refs.filter((r) => !r.default && !r.protected);
    const hidden = d.refs.length - list.length;
    /* Filtre au-dessus de la liste : un dépôt actif compte souvent des centaines de
       branches, et la liste défile dans 190 px de haut. Il MASQUE au lieu de reconstruire,
       pour que les cases déjà cochées survivent à la frappe — et qu'on puisse cocher,
       filtrer autre chose, cocher encore, puis tout supprimer d'un coup. */
    box.innerHTML = (list.length
      ? '<input type="search" class="search git-ref-filter" data-row="' + idx + '" placeholder="' + esc(gitRefSearchPh()) + '" aria-label="' + esc(gitRefSearchPh()) + '" />'
        + '<div class="git-ref-list">'
        + list.map((r) => '<label class="git-ref-item" data-name="' + esc(r.name.toLowerCase()) + '"><input type="checkbox" data-row="' + idx + '" value="' + esc(r.name) + '"' + (sel.includes(r.name) ? ' checked' : '') + ' />' +
          '<code>' + esc(r.name) + '</code>' + (r.merged ? '<span class="tag done">' + esc(tr('git.tag.merged')) + '</span>' : '') +
          '<span class="muted git-ref-date">' + (r.date ? fmtDate(r.date) : '') + '</span></label>').join('')
        + '<div class="muted git-ref-nomatch" hidden>' + esc(tr('git.refs.no-match')) + '</div></div>'
      : '<span class="muted">' + esc(tr('git.refs.none')) + '</span>')
      + (hidden ? '<div class="muted git-ref-hidden">' + esc(tr('git.refs.hidden', { n: hidden, count: hidden })) + '</div>' : '');
  } else {
    // Combo : la valeur retenue vit dans l'input CACHÉ (classe `git-ref`), le champ
    // visible n'en est que l'affichage — c'est lui qui accueille la recherche.
    const hidden2 = row.querySelector('.git-ref');
    const search = row.querySelector('[data-combo="git-ref"]');
    if (!hidden2 || !search) return;
    const cur = (gitTargets[idx] && gitTargets[idx].ref) || d.default || (d.refs[0] && d.refs[0].name) || '';
    hidden2.value = cur;
    hidden2.dataset.label = cur;
    search.value = cur;
    search.title = cur;
    search.placeholder = gitRefSearchPh();
    gitTargets[idx] = { ...gitTargets[idx], repo_id: repoId, ref: cur };
  }
}

/* Rend les lignes ET ATTEND qu'elles soient remplies. Le remplissage d'une ligne va chercher
   les refs de son dépôt : deux appelants pariaient là-dessus avec un `setTimeout` de 400 et
   600 ms — la règle du projet sur les délais fixes vaut aussi pour l'app, et un dépôt lent (ou
   une machine chargée) faisait alors un aperçu sur des lignes encore vides. On rend donc une
   promesse : l'aperçu attend l'effet, pas l'horloge. */
async function gitRenderTargets() {
  const el = $('#gitTargetRows');
  if (!el) return;
  el.innerHTML = gitTargets.map((t, i) => gitTargetRow(i, t)).join('');
  wireRepoCombos(el);
  /* Les refs sont chargées à l'OUVERTURE de la liste, pas au rendu de la ligne : rien ne
     dit que l'utilisateur va la dérouler, et `gitLoadRefs` met déjà en cache par dépôt. */
  wireCombo(el, 'git-ref', async (row) => {
    const repoId = Number(row.querySelector('.git-repo').value);
    if (!repoId) return [];
    const kind = gitRefKind();
    const d = await gitLoadRefs(repoId, kind);
    return d.refs.map((r) => ({ value: r.name, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' }));
  });
  await Promise.all(gitTargets.map((_, i) => gitFillRow(i)));
}

function gitReadTargets() {
  return $$('#gitTargetRows .git-row').map((row) => {
    const idx = Number(row.dataset.row);
    const repo_id = Number(row.querySelector('.git-repo').value);
    if (!repo_id) return null;
    if (gitIsDelete()) {
      const refs = [...row.querySelectorAll('.git-refs input:checked')].map((i) => i.value);
      return refs.length ? { repo_id, refs } : null;
    }
    const s = row.querySelector('.git-ref');
    const out = { repo_id, ref: s ? s.value : '' };
    const nm = row.querySelector('.git-name');
    if (nm) out.name = nm.value.trim();   // absent = le nom global s'applique
    return out;
  }).filter(Boolean);
}

// Le nom global et les noms par projet ne coexistent jamais : l'un est saisi, les
// autres sont vides. On lit donc celui qui est effectivement à l'écran.
function gitNameBody(targets) {
  const body = { message: $('#gitTagMsg').value.trim() };
  if (gitPerProjectName()) {
    if (targets.some((t) => !t.name)) return null;   // une ligne sans nom = rien n'est prévisualisé
    return body;
  }
  body.name = $('#gitRefName').value.trim();
  return body;
}

/* Jette l'aperçu affiché. À appeler dès qu'une saisie ne correspond plus à ce que
   le tableau montre : l'exécution relit les CHAMPS, pas le tableau, donc laisser
   un aperçu périmé à l'écran reviendrait à faire confirmer autre chose que ce qui
   part réellement. */
function gitDropPreview() {
  const box = $('#gitPreviewBox');
  if (box) box.hidden = true;
  gitPreviewData = null;
}

// Le formulaire change de forme selon l'action : c'est le même écran, pas quatre.
/* A/Git 2 — LE NOM SUIVANT. `release/1.4` puis `release/1.5` : le dernier nom créé porte
   presque toujours la réponse, à un chiffre près. On retient donc le dernier nom validé et on
   propose son incrément — bouton, pas remplissage automatique : deviner un nom de branche à
   la place de quelqu'un est le genre de service qu'on regrette. */
const GIT_DERNIER_NOM = 'aidevtools_git_dernier_nom';
function nomSuivant(nom) {
  const m = String(nom || '').match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return '';
  return `${m[1]}${String(Number(m[2]) + 1)}${m[3]}`;
}
function majPropositionNom() {
  const b = $('#gitNameSuivant');
  if (!b) return;
  let dernier = '';
  try { dernier = localStorage.getItem(GIT_DERNIER_NOM) || ''; } catch { dernier = ''; }
  const suivant = nomSuivant(dernier);
  b.hidden = !suivant || gitIsDelete();
  if (suivant) { b.textContent = suivant; b.title = tr('git.name.next-title', { nom: suivant }); }
}
$('#gitNameSuivant') && $('#gitNameSuivant').addEventListener('click', () => {
  const champ = $('#gitRefName');
  if (champ) { champ.value = $('#gitNameSuivant').textContent; champ.focus(); }
});
/* Le presse-papiers est lu AU CLIC et nulle part ailleurs : c'est une lecture de ce que
   l'utilisateur a copié, elle ne se fait pas en fond. Un contenu sans clé de ticket ne
   remplit rien — on le dit plutôt que de coller n'importe quoi. */
$('#gitNameColler') && $('#gitNameColler').addEventListener('click', async () => {
  let texte = '';
  try { texte = await navigator.clipboard.readText(); } catch { toast(tr('git.name.clipboard-denied'), true); return; }
  const m = String(texte || '').match(/[A-Z][A-Z0-9]+-\d+/);
  if (!m) { toast(tr('git.name.clipboard-no-key'), true); return; }
  const champ = $('#gitRefName');
  if (champ) { champ.value = `feature/${m[0]}`; champ.focus(); }
});

function gitApplyAction() {
  const del = gitIsDelete();
  const tag = gitIsTag();
  $('#gitNameField').hidden = del;                  // on ne saisit rien pour supprimer
  majPropositionNom();
  $('#gitSameNameField').hidden = del;
  $('#gitNameRow').hidden = del || !gitSameName();  // saisi par projet → plus de champ global
  $('#gitMsgField').hidden = !(tag && !del);
  $('#gitTargetsLabel').textContent = del
    ? (tag ? tr('git.targets.tags-to-delete') : tr('git.targets.branches-to-delete'))
    : (tag ? tr('git.targets.tag-source') : tr('git.targets.source'));
  $('#gitNameLabel').textContent = tag ? tr('git.lbl.tag-name') : tr('git.lbl.branch-name');
  $('#gitSameNameLabel').textContent = tag ? tr('git.lbl.same-tag-all') : tr('git.lbl.same-name-all');
  $('#gitRefName').placeholder = tag ? tr('git.ph.tag-name') : tr('git.ph.name');
  gitDropPreview();
  // Les refs ne sont plus valides ; les noms saisis par projet, si.
  gitTargets = gitTargets.map((t) => ({ repo_id: t.repo_id, name: t.name }));
  gitRenderTargets();
}

/* Les clés sont écrites EN TOUTES LETTRES et non construites par concaténation :
   `tr('git.state.' + state)` fonctionnerait, mais rendrait la clé introuvable par
   recherche textuelle — et c'est précisément ce que vérifie npm run i18n:check. */
const GIT_STATE = {
  ok: { cls: 'ok', icon: svgIco('check'), key: 'git.state.ok' },
  exists: { cls: 'skip', icon: svgIco('right'), key: 'git.state.exists' },
  missing: { cls: 'warn', icon: svgIco('alert'), key: 'git.state.missing' },
  missing_source: { cls: 'warn', icon: svgIco('alert'), key: 'git.state.missing-source' },
  protected: { cls: 'warn', icon: svgIco('lock'), key: 'git.state.protected' },
  is_default: { cls: 'warn', icon: svgIco('lock'), key: 'git.state.is-default' },
  nothing_selected: { cls: 'warn', icon: '—', key: 'git.state.nothing-selected' },
  duplicate: { cls: 'warn', icon: svgIco('repeat'), key: 'git.state.duplicate' },
  error: { cls: 'err', icon: svgIco('close'), key: 'git.state.error' },
  done: { cls: 'ok', icon: svgIco('check'), key: 'git.state.done' },
};

function gitRenderPreview(pv) {
  gitPreviewData = pv;
  const box = $('#gitPreviewBox');
  const rows = pv.rows.map((r) => {
    const st = GIT_STATE[r.state] || { cls: '', icon: '', key: null };
    const label = st.key ? tr(st.key) : r.state;
    // À la création, la ref affichée est la SOURCE : le nom fabriqué est montré
    // à côté, ligne par ligne — c'est le seul endroit où l'on voit qu'un tag
    // diffère d'un projet à l'autre avant de l'écrire.
    const ref = (r.ref ? '<code>' + esc(r.ref) + '</code>' : '<span class="muted">—</span>')
      + (r.target ? ' <span class="muted git-pv-arrow">→</span> <code class="git-pv-target">' + esc(r.target) + '</code>' : '');
    /* C7 — le SHA s'affiche court (huit caractères se lisent) mais se COPIE entier : un
       `git show` ou un message d'incident veut le complet, et il n'existait nulle part. */
    const sha = r.sha ? '<button type="button" class="muted git-sha git-sha-copy" data-copy-txt="' + esc(r.sha)
      + '" title="' + esc(tr('git.copy-sha')) + '">' + esc(String(r.sha).slice(0, 8)) + '</button>' : '';
    const when = r.committed_date ? '<span class="muted">' + fmtDate(r.committed_date) + '</span>' : '';
    /* CE QUI DIT SI C'EST SÛR. Trois cas, trois couleurs : mergée (vert, on peut y aller),
       merge request encore ouverte (ambre, on va casser quelque chose), ni l'un ni l'autre
       (ambre aussi — « non mergée » est une information, pas un blocage). */
    const surete = r.state !== 'ok' || !gitIsDelete() ? ''
      : (r.open_mr
        ? '<span class="git-sur git-sur-mr" title="' + esc(r.open_mr.title || '') + '">'
          + (r.open_mr.url ? '<a href="' + esc(safeUrl(r.open_mr.url)) + '" target="_blank" rel="noopener noreferrer">' : '')
          + esc(tr('git.safe.open-mr', { iid: r.open_mr.iid })) + (r.open_mr.url ? ' ↗</a>' : '')
          + (r.open_mr.title ? ' <span class="muted">' + esc(String(r.open_mr.title).slice(0, 50)) + '</span>' : '')
          + (r.open_mr.note != null ? ' ' + noteBadge(Math.round(r.open_mr.note * 1000) / 100) : '')
          + (r.open_mr.ticket ? ' <span class="tag" title="' + esc(r.open_mr.ticket_status || '') + '">' + esc(r.open_mr.ticket) + '</span>' : '')
          + '</span>'
        : (r.merged
          ? '<span class="git-sur git-sur-ok">' + esc(tr('git.safe.merged', { branch: r.merged_into || '' })) + '</span>'
          : '<span class="git-sur git-sur-non">' + esc(tr('git.safe.not-merged')) + '</span>'));
    // La commande n'est affichée que sur les lignes qui vont s'exécuter : la
    // montrer sur une ligne bloquée laisserait croire qu'elle passe.
    /* CES COMMANDES SE COLLENT DANS UN TERMINAL — c'est même toute leur raison d'être : voir ce
       que l'outil va faire, et pouvoir le refaire soi-même. Elles n'étaient pas copiables : on
       les resélectionnait à la souris, en attrapant l'étiquette avec. */
    const cmdLigne = (cls, cle, txt) => '<div class="git-cmd ' + cls + '"><span class="git-cmd-tag">' + esc(tr(cle))
      + '</span><button type="button" class="git-cmd-copy" data-copy-txt="' + esc(txt) + '" title="'
      + esc(tr('ui.copy')) + '"><code>' + esc(txt) + '</code></button></div>';
    const cmd = r.cmd ? '<tr class="git-cmd-row"><td></td><td colspan="2">' +
      (r.cmd.real || []).map((x) => cmdLigne('git-cmd-real', 'git.cmd.real', x)).join('') +
      cmdLigne('', 'git.cmd.equiv', r.cmd.equiv) +
      cmdLigne('git-cmd-api', 'git.cmd.api', r.cmd.api) +
      '</td></tr>' : '';
    return '<tr class="git-pv-' + st.cls + '"><td>' + esc(r.project) + '</td><td>' + ref + ' ' + sha + ' ' + when + ' ' + surete + '</td>' +
      '<td>' + st.icon + ' ' + esc(label) + (r.error ? ' <span class="muted">' + esc(r.error) + '</span>' : '') + '</td></tr>' + cmd;
  }).join('');
  const c2 = pv.counts;
  box.hidden = false;
  box.innerHTML = '<div class="box git-preview">' +
    '<h4>' + esc(tr('git.preview.title')) + '</h4>' +
    '<div class="md-tablewrap"><table class="md-table"><thead><tr>' +
      '<th>' + esc(tr('git.col.project')) + '</th><th>' + esc(tr('git.col.ref')) + '</th><th>' + esc(tr('git.col.result')) + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<p class="muted git-pv-counts">' + esc(tr('git.preview.counts', { ok: c2.ok, skipped: c2.skipped, blocked: c2.blocked })) + '</p>' +
    (c2.ok ? '<p class="muted git-pv-legend">' + esc(tr('git.cmd.legend')) + '</p>' : '') +
    (gitIsDelete() && c2.ok ? '<p class="muted git-pv-safe">' + esc(tr('git.preview.safety')) + '</p>' : '') +
    '<div class="form-actions">' +
      '<button id="gitCancel" class="btn">' + esc(tr('ui.cancel')) + '</button>' +
      '<button id="gitRun" class="btn ' + (gitIsDelete() ? 'btn-danger' : 'btn-primary') + '"' + (c2.ok ? '' : ' disabled') + '>' +
        '<svg class="ico"><use href="#i-play"/></svg>' + esc(tr('git.btn.execute', { n: c2.ok, count: c2.ok })) + '</button>' +
    '</div></div>';
  $('#gitCancel').addEventListener('click', () => { box.hidden = true; });
  $('#gitRun').addEventListener('click', gitExecute);
}

async function gitDoPreview() {
  const btn = $('#gitPreview');
  const targets = gitReadTargets();
  if (!targets.length) { toast(tr('err.git.no-target'), true); return; }
  const body = { action: gitAction(), targets };
  if (!gitIsDelete()) {
    const names = gitNameBody(targets);
    if (!names) { toast(tr('err.git.name-per-project'), true); return; }
    Object.assign(body, names);
  }
  gitActMemoriser();   // retenu à l'APERÇU : c'est le moment où l'intention est formée
  if (!gitIsDelete()) {
    const n = ($('#gitRefName') || {}).value || '';
    if (n.trim()) { try { localStorage.setItem(GIT_DERNIER_NOM, n.trim()); } catch { /* ignore */ } }
  }
  try { gitRenderPreview(await busy(btn, () => api('/git/preview', { method: 'POST', body }))); }
  catch (e) { toast(explainError(e.message), true); }
}

async function gitExecute() {
  if (!gitPreviewData) return;
  const n = gitPreviewData.counts.ok;
  if (gitIsDelete() && !await confirmDialog({ text: tr('confirm.git-delete', { n, count: n }), confirmLabel: tr('ui.delete') })) return;
  const targets = gitReadTargets();
  const body = { action: gitAction(), targets };
  if (!gitIsDelete()) {
    const names = gitNameBody(targets);
    if (!names) { toast(tr('err.git.name-per-project'), true); return; }
    Object.assign(body, names);
  }
  try {
    await api('/git/execute', { method: 'POST', body });
    toast(tr('toast.git-started'));
    $('#gitPreviewBox').hidden = true;
    oublierRefs();                        // les refs ont changé
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
}

/* ---------- B7 : « Supprimer les N branches de MR mergées » ----------
   Le bouton n'apparaît QUE s'il y a quelque chose à nettoyer, et il ne supprime rien : il
   REMPLIT le lot, puis lance l'aperçu habituel — qui dit branche par branche si elle existe
   encore, si elle est protégée, et si c'est sûr (« mergée dans main » / « MR ouverte »). */
let brMergees = { total: 0, repos: [] };
async function majBranchesMergees() {
  const bar = $('#gitMergedBar');
  const btn = $('#gitMergedFill');
  if (!bar || !btn) return;
  try { brMergees = await api('/git/merged-branches'); } catch { brMergees = { total: 0, repos: [] }; }
  bar.hidden = !brMergees.total;
  btn.textContent = tr('git.merged.fill', { n: brMergees.total, count: brMergees.total });
}
$('#gitMergedFill') && $('#gitMergedFill').addEventListener('click', () => {
  if (!brMergees.total) return;
  $('#gitAction').value = 'delete_branch';
  gitApplyAction();
  gitTargets = brMergees.repos.map((r) => ({ repo_id: r.repo_id, refs: r.refs.map((x) => x.name) }));
  // Les refs de chaque ligne se chargent après le rendu : l'aperçu attend qu'elles soient là.
  gitRenderTargets().then(gitDoPreview);
});

function gitMajVide() {
  const vide = $('#gitNoRepo');
  if (!vide) return;
  const sans = !repoOptions.length;
  vide.hidden = !sans;
  if (sans) {
    vide.innerHTML = emptyState({ icon: 'branch', title: tr('git.norepo.title'),
      text: tr('git.norepo.text'),
      actions: [{ act: 'go-repos', label: tr('git.norepo.action') }] });
  }
  /* Le formulaire disparaît AVEC ses impasses : le laisser grisé sous le vide guidé donnerait
     deux réponses à la même question. */
  const form = $('#gsub-actions .form');
  if (form) form.hidden = sans;
  const intro = $('#gsub-actions > p.muted');
  if (intro) intro.hidden = sans;
}

$$('#tab-git .subnav [data-gsub]').forEach((b) => b.addEventListener('click', () => showGitSub(b.dataset.gsub)));
$('#gitAction').addEventListener('change', () => { gitActMemoriser(); gitApplyAction(); });

