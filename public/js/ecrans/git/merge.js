'use strict';
/* Git · Merge de branche à branche (onglet Git → Merge). */
// @expose mergeMemoriser
/* ============ Git · Merge de branche à branche (onglet Git → Merge) ============
 *
 * L'écran de conflits est le cœur : il doit se comprendre sans mode d'emploi. Le parti pris est
 * de ne JAMAIS montrer un fichier entier avec des marqueurs `<<<<<<<` à déchiffrer. On montre,
 * conflit par conflit, les deux versions face à face, chacune avec son bouton « Garder ». Trois
 * lignes de contexte de part et d'autre situent le passage sans noyer l'écran.
 *
 * Qui assemble quoi : les boutons envoient des CHOIX au serveur, qui recolle (`gitmerge.recoller`).
 * L'écran calcule bien un aperçu, mais pour l'AFFICHER seulement — la version qui part sur le
 * disque est toujours celle du serveur. L'édition à la main, elle, envoie le texte.
 */
let mergeEtat = null;              // état du merge ouvert
let mergeFichier = null;           // { path, morceaux, choix: [], edite: bool, texte }

const mergeRefsCache = new Map();  // repoId -> [{ value, label }]
/* …ET SON OUBLI. Le cache n'était jamais vidé : après un merge poussé ou une branche créée
   depuis l'onglet Git, les listes de Merge proposaient encore l'état d'avant — une branche
   qu'on venait de supprimer restait choisissable, une branche neuve n'apparaissait pas. Les
   refs de l'onglet Git, elles, étaient déjà oubliées après `gitExecute` ; on suit la même
   règle : ce qui fait bouger les refs vide les deux. */
function oublierRefs() { gitRefsCache = {}; mergeRefsCache.clear(); }
async function mergeRefs(repoId) {
  if (!repoId) return [];
  if (mergeRefsCache.has(repoId)) return mergeRefsCache.get(repoId);
  const d = await api(`/git/refs?repo_id=${repoId}&kind=branch`);
  const opts = (d.refs || []).map((r) => ({ value: r.name, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' }));
  mergeRefsCache.set(repoId, opts);
  return opts;
}
const mergeRepoId = () => Number(($('#mergeRepoBox .rc-id') || {}).value || 0);

/* Les trois choix passent par des combos AVEC RECHERCHE : un dépôt actif compte des centaines
   de branches, et `npm run check` refuse une liste de refs sans champ de recherche. */
/* A/Git 1 — MERGE SE SOUVIENT, comme *Comparer* le fait déjà. Trois sous-onglets voisins et
   deux politiques de mémoire, c'était la seule raison de retaper `develop → main` sur le même
   dépôt tous les matins. Mémoire de navigateur : la perdre ne perd qu'une proposition. */
const MERGE_FORM_MEMO = 'aidevtools_merge_form_memo';   // ≠ MERGE_MEMO, qui retient squash/suppression PAR DÉPÔT
const mergeMemo = () => { try { return JSON.parse(localStorage.getItem(MERGE_FORM_MEMO) || '{}'); } catch { return {}; } };
const mergeMemoriser = (etat) => {
  try { localStorage.setItem(MERGE_FORM_MEMO, JSON.stringify(etat)); } catch { /* stockage indisponible */ }
};

function mergeRenderPickers() {
  const rb = $('#mergeRepoBox'); if (!rb) return;
  const memo = mergeMemo();
  const repo = mergeRepoId() || Number(memo.repo_id) || null;
  rb.innerHTML = repoComboHtml(repo, { idClass: 'merge-repo' });
  /* Les branches ne sont reproposées QUE pour le dépôt qui les a vues : une branche d'un autre
     dépôt donnerait un formulaire qui a l'air valide et une erreur au lancement. */
  const meme = repo && Number(memo.repo_id) === Number(repo);
  $('#mergeSourceBox').innerHTML = comboHtml('merge-source', {
    ph: tr('git.merge.ph-branch'), value: meme ? (memo.source || '') : '', label: meme ? (memo.source || '') : '' });
  $('#mergeTargetBox').innerHTML = comboHtml('merge-target', {
    ph: tr('git.merge.ph-branch'), value: meme ? (memo.target || '') : '', label: meme ? (memo.target || '') : '' });
  wireRepoCombos($('#gsub-merge'));
  wireCombo($('#gsub-merge'), 'merge-source', () => mergeRefs(mergeRepoId()));
  wireCombo($('#gsub-merge'), 'merge-target', () => mergeRefs(mergeRepoId()));
}

/* Changer de dépôt vide les deux branches : garder « main » d'un autre dépôt donnerait un
   formulaire qui a l'air valide et une erreur au lancement. */
document.addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('merge-repo')) return;
  for (const cls of ['merge-source', 'merge-target']) {
    const h = $(`.${cls}`, $('#gsub-merge')); const vis = $(`[data-combo="${cls}"]`, $('#gsub-merge'));
    if (h) { h.value = ''; h.dataset.label = ''; }
    if (vis) vis.value = '';
  }
});

async function mergeLoad() {
  mergeRenderPickers();
  await mergeRenderRunning();
}

/** Les merges non soldés : on peut en reprendre un, ou l'abandonner. */
async function mergeRenderRunning() {
  const box = $('#mergeRunning'); if (!box) return;
  let liste = [];
  try { liste = await api('/git/merges'); } catch { liste = []; }
  if (!liste.length) { box.innerHTML = ''; if (!mergeEtat) $('#mergeWork').hidden = true; return; }
  box.innerHTML = `<div class="box merge-running"><h4>${esc(tr('git.merge.running'))}</h4>${liste.map((m) => `
    <div class="merge-run-row">
      <span><strong>${esc(m.project)}</strong> <code>${esc(m.source_branch)}</code> → <code>${esc(m.target_branch)}</code>
      <span class="tag ${m.status === 'conflict' ? 'stale' : 'reviewed'}">${esc(tr(`git.merge.status.${m.status}`))}</span>
      ${/* A31 — CE QU'ON RATTRAPE. On arrive ici depuis le badge « en conflit » d'une merge
            request : sans son numéro, sa note et son ticket, on résout trente conflits sans
            plus savoir pour quoi. La puce ouvre le rapport. */''}
      ${m.mr ? `<button type="button" class="lien-reglage" data-merge-mr="${m.mr.id}" title="${esc(m.mr.title)}">!${esc(String(m.mr.iid))}</button>
        ${m.mr.note != null ? noteBadge(m.mr.note) : ''}
        ${m.mr.ticket ? `<span class="tag">${esc(m.mr.ticket)}</span>` : ''}` : ''}
      ${/* …et le diff de ce qui a été commité : `commit_sha` était stocké et relu par personne,
            alors que c'est la seule façon de vérifier ce qu'on vient d'assembler. */''}
      ${m.commit_sha ? `<button type="button" class="lien-reglage" data-merge-diff="${m.id}" title="${esc(tr('git.merge.diff-title'))}">${esc(tr('git.merge.diff', { sha: String(m.commit_sha).slice(0, 8) }))}</button>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-mopen="${m.id}">${esc(tr('git.merge.resume'))}</button>
      <button class="btn btn-sm btn-danger" data-mdrop="${m.id}">${esc(tr('git.merge.abandon'))}</button>
    </div>`).join('')}</div>`;
  $$('#mergeRunning [data-merge-mr]').forEach((b) => b.addEventListener('click', () => navMrReport(Number(b.dataset.mergeMr))));
  $$('#mergeRunning [data-merge-diff]').forEach((b) => b.addEventListener('click', () => ouvrirDiffMerge(Number(b.dataset.mergeDiff))));
}

async function mergeOuvrir(id) {
  mergeEtat = await api(`/git/merges/${id}`);
  mergeFichier = null;
  const premier = mergeEtat.conflits[0];
  if (premier) await mergeOuvrirFichier(premier); else mergeRenderWork();
}

/* Le fichier ouvert : ses morceaux, et un choix par conflit. « ours » d'office — la destination
   est ce qui existe déjà, c'est le repli le moins surprenant, et chaque conflit reste à
   confirmer avant que le fichier ne soit marqué résolu. */
async function mergeOuvrirFichier(chemin) {
  const d = await api(`/git/merges/${mergeEtat.id}/file?path=${encodeURIComponent(chemin)}`);
  const nb = d.morceaux.filter((m) => m.type === 'conflit').length;
  mergeFichier = { path: chemin, morceaux: d.morceaux, texte: d.texte, choix: Array(nb).fill('ours'), edite: false };
  mergeRenderWork();
}

const mergeApercu = () => {
  /* AFFICHAGE SEULEMENT. Ce que le serveur écrira vient de `gitmerge.recoller`, à qui l'on
     envoie les choix : deux assembleurs finiraient par ne plus dire la même chose. */
  let n = 0;
  return mergeFichier.morceaux.map((m) => {
    if (m.type === 'stable') return m.lignes.join('\n');
    const c = mergeFichier.choix[n]; n += 1;
    return (c === 'theirs' ? m.theirs : c === 'deux' ? [...m.ours, ...m.theirs] : m.ours).join('\n');
  }).join('\n');
};

function mergeRenderWork() {
  const box = $('#mergeWork'); if (!box) return;
  if (!mergeEtat) { box.hidden = true; return; }
  box.hidden = false;
  const e = mergeEtat;
  const reste = e.conflits.length;
  const fini = e.status === 'committed' || e.status === 'pushed';
  box.innerHTML = `
    <div class="box merge-head">
      <div>
        <strong>${esc(e.project)}</strong> — <code>${esc(e.source_branch)}</code> → <code>${esc(e.target_branch)}</code>
        ${/* A31 — CE QU'ON RATTRAPE. On arrive ici depuis un badge « en conflit » : sans ce
              rappel, on résout des conflits sans plus savoir sur quelle merge request. */''}
        ${e.mr ? `${e.mr.url ? `<a href="${esc(safeUrl(e.mr.url))}" target="_blank" rel="noopener noreferrer" class="tag">!${e.mr.iid} ↗</a>` : `<span class="tag">!${e.mr.iid}</span>`}
          ${e.mr.note != null ? noteBadge(Math.round(e.mr.note * 1000) / 100) : ''}
          ${e.mr.ticket ? `<span class="tag">${esc(e.mr.ticket)}</span>` : ''}
          <span class="muted">${esc(String(e.mr.title || '').slice(0, 60))}</span>` : ''}
        <span class="tag ${reste ? 'stale' : 'done'}">${esc(reste
    ? tr('git.merge.left', { n: reste, count: reste })
    : tr(`git.merge.status.${e.status}`))}</span>
        ${/* LE COMMIT DE FUSION, une fois qu'il existe. Il était écrit en base et jamais montré :
             après un merge résolu à la main, rien à l'écran ne permettait de retrouver l'objet
             qu'on venait de fabriquer — ni pour un `git show`, ni pour un message d'incident. */''}
        ${e.commit_sha ? `<button type="button" class="muted git-sha git-sha-copy" data-copy-txt="${esc(e.commit_sha)}" title="${esc(tr('git.copy-sha'))}">${esc(String(e.commit_sha).slice(0, 8))}</button>` : ''}
      </div>
      <div class="spacer"></div>
      ${fini ? '' : `<button class="btn btn-danger" id="mergeAbandon">${esc(tr('git.merge.abandon'))}</button>`}
      ${e.status === 'ready' ? `<button class="btn btn-primary" id="mergeCommit"><svg class="ico"><use href="#i-save"/></svg>${esc(tr('git.merge.commit.go'))}</button>` : ''}
      ${e.status === 'committed' ? `<button class="btn btn-primary" id="mergePush"><svg class="ico"><use href="#i-upload"/></svg>${esc(tr('git.merge.push'))}</button>` : ''}
    </div>
    ${e.status === 'pushed' ? `<p class="converge-note">${svgIco('check')} <span>${esc(tr('git.merge.pushed', { target: e.target_branch }))}</span></p>` : ''}
    ${reste || mergeFichier ? `<div class="merge-body">
      <div class="merge-files">${(e.conflits.length ? e.conflits : [mergeFichier && mergeFichier.path].filter(Boolean)).map((f) => `
        <button class="mf-item${mergeFichier && mergeFichier.path === f ? ' active' : ''}" data-mfile="${esc(f)}">
          ${svgIco('alert')} <span>${esc(f)}</span></button>`).join('')}
        ${e.prets.length ? `<div class="mf-done">${esc(tr('git.merge.done-files', { n: e.prets.length, count: e.prets.length }))}</div>` : ''}
      </div>
      <div class="merge-pane" id="mergePane">${mergeFichier ? mergePaneHtml() : `<p class="muted">${esc(tr('git.merge.pick-file'))}</p>`}</div>
    </div>` : ''}`;
}

function mergePaneHtml() {
  const f = mergeFichier;
  const e = mergeEtat;
  if (f.edite) {
    return `<div class="mp-head"><code>${esc(f.path)}</code>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-medit="0">${esc(tr('git.merge.back-to-choices'))}</button>
        <button class="btn btn-sm btn-primary" id="mergeResolveText">${esc(tr('git.merge.resolve'))}</button></div>
      <p class="muted">${esc(tr('git.merge.edit-hint'))}</p>
      <textarea id="mergeEditor" class="merge-editor" spellcheck="false">${esc(mergeApercu())}</textarea>`;
  }
  let n = -1;
  const corps = f.morceaux.map((m, i) => {
    if (m.type === 'stable') {
      /* Trois lignes de contexte de chaque côté : de quoi se situer, pas de quoi relire le
         fichier. Un conflit se juge sur ses bords, pas sur les deux cents lignes d'avant. */
      const avant = i === 0 ? [] : m.lignes.slice(0, 3);
      const apres = m.lignes.slice(-3);
      const bouts = m.lignes.length <= 6 ? [m.lignes] : [avant, apres];
      return `<pre class="cf-ctx">${bouts.map((b) => esc(b.join('\n'))).join('\n<span class="cf-gap">⋯</span>\n')}</pre>`;
    }
    n += 1;
    const c = f.choix[n];
    const bloc = (cote, lignes, libelle) => `<div class="cf-side cf-${cote}${c === cote || (c === 'deux') ? ' cf-keep' : ''}">
        <div class="cf-lab"><span>${esc(libelle)}</span>
          <button class="btn btn-sm${c === cote ? ' btn-primary' : ''}" data-keep="${cote}" data-h="${n}">${esc(tr('git.merge.keep'))}</button></div>
        <pre>${esc(lignes.join('\n')) || `<span class="muted">${esc(tr('git.merge.empty-side'))}</span>`}</pre></div>`;
    return `<div class="cf-hunk" data-hunk="${n}">
      <div class="cf-num">${esc(tr('git.merge.hunk', { n: n + 1, total: f.choix.length }))}</div>
      ${bloc('ours', m.ours, tr('git.merge.side-ours', { branch: e.target_branch }))}
      ${bloc('theirs', m.theirs, tr('git.merge.side-theirs', { branch: e.source_branch }))}
      <div class="cf-both"><button class="btn btn-sm${c === 'deux' ? ' btn-primary' : ''}" data-keep="deux" data-h="${n}">${esc(tr('git.merge.keep-both'))}</button></div>
    </div>`;
  }).join('');
  return `<div class="mp-head"><code>${esc(f.path)}</code>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-medit="1">${esc(tr('git.merge.edit'))}</button>
      <button class="btn btn-sm btn-primary" id="mergeResolveChoices">${esc(tr('git.merge.resolve'))}</button></div>
    ${corps}`;
}

/* Toute l'interaction de l'écran passe par ici : le contenu est réécrit à chaque clic, des
   écouteurs posés sur les boutons seraient perdus au rendu suivant. */
document.addEventListener('click', async (e) => {
  const dans = (sel) => e.target.closest && e.target.closest(sel);
  const open = dans('[data-mopen]');
  if (open) { try { await mergeOuvrir(Number(open.dataset.mopen)); } catch (err) { toast(explainError(err.message), true); } return; }
  const drop = dans('[data-mdrop]');
  if (drop) {
    if (!await confirmDialog({ text: tr('git.merge.abandon-confirm'), confirmLabel: tr('git.merge.abandon') })) return;
    try {
      await api(`/git/merges/${drop.dataset.mdrop}`, { method: 'DELETE' });
      mergeEtat = null; mergeFichier = null; $('#mergeWork').hidden = true;
      await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (!mergeEtat) return;
  const fich = dans('[data-mfile]');
  if (fich) { try { await mergeOuvrirFichier(fich.dataset.mfile); } catch (err) { toast(explainError(err.message), true); } return; }
  const keep = dans('[data-keep]');
  if (keep && mergeFichier) {
    mergeFichier.choix[Number(keep.dataset.h)] = keep.dataset.keep;
    $('#mergePane').innerHTML = mergePaneHtml();
    return;
  }
  const edit = dans('[data-medit]');
  if (edit && mergeFichier) { mergeFichier.edite = edit.dataset.medit === '1'; $('#mergePane').innerHTML = mergePaneHtml(); return; }
  if (dans('#mergeResolveChoices')) { await mergeResoudre({ choices: mergeFichier.choix }); return; }
  if (dans('#mergeResolveText')) { await mergeResoudre({ content: $('#mergeEditor').value }); return; }
  if (dans('#mergeAbandon')) {
    if (!await confirmDialog({ text: tr('git.merge.abandon-confirm'), confirmLabel: tr('git.merge.abandon') })) return;
    try {
      await api(`/git/merges/${mergeEtat.id}`, { method: 'DELETE' });
      mergeEtat = null; mergeFichier = null; $('#mergeWork').hidden = true;
      await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (dans('#mergeCommit')) { mergeOuvrirCommit(); return; }
  if (dans('#mergePush')) {
    const ok = await confirmDialog({
      title: tr('git.merge.push.confirm.title', { target: mergeEtat.target_branch }),
      text: tr('git.merge.push.confirm.text', { target: mergeEtat.target_branch, project: mergeEtat.project }),
      confirmLabel: tr('git.merge.push'), danger: false,
    });
    if (!ok) return;
    try {
      mergeEtat = await busy($('#mergePush'), () => api(`/git/merges/${mergeEtat.id}/push`, { method: 'POST' }));
      oublierRefs();                        // la cible vient d'avancer
      toast(tr('git.merge.pushed', { target: mergeEtat.target_branch }));
      mergeRenderWork(); await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
  }
});

async function mergeResoudre(body) {
  try {
    mergeEtat = await api(`/git/merges/${mergeEtat.id}/resolve`, {
      method: 'POST', body: { path: mergeFichier.path, ...body },
    });
    const suivant = mergeEtat.conflits[0];
    mergeFichier = null;
    if (suivant) await mergeOuvrirFichier(suivant); else mergeRenderWork();
    await mergeRenderRunning();
    if (!mergeEtat.conflits.length) toast(tr('git.merge.all-resolved'));
  } catch (err) { toast(explainError(err.message), true); }
}

function mergeOuvrirCommit() {
  $('#mergeCommitIntro').textContent = tr('git.merge.commit.intro', {
    source: mergeEtat.source_branch, target: mergeEtat.target_branch, project: mergeEtat.project,
  });
  $('#mergeCommitMsg').value = mergeEtat.message || '';
  $('#mergeCommitModal').hidden = false;
  setTimeout(() => $('#mergeCommitMsg').focus(), 0);
}
$('#mergeCommitCancel') && $('#mergeCommitCancel').addEventListener('click', () => { $('#mergeCommitModal').hidden = true; });
fermerAuFond('#mergeCommitModal', () => { $('#mergeCommitModal').hidden = true; });
$('#mergeCommitGo') && $('#mergeCommitGo').addEventListener('click', async () => {
  try {
    mergeEtat = await busy($('#mergeCommitGo'), () => api(`/git/merges/${mergeEtat.id}/commit`, {
      method: 'POST', body: { message: $('#mergeCommitMsg').value },
    }));
    $('#mergeCommitModal').hidden = true;
    toast(tr('git.merge.committed'));
    mergeRenderWork(); await mergeRenderRunning();
  } catch (err) { toast(explainError(err.message), true); }
});

async function mergeDemarrer({ sansAncetre = false } = {}) {
  const repoId = mergeRepoId();
  const source = ($('.merge-source', $('#gsub-merge')) || {}).value || '';
  const target = ($('.merge-target', $('#gsub-merge')) || {}).value || '';
  mergeMemoriser({ repo_id: repoId, source, target });   // retenu au LANCEMENT, pas à la saisie
  $('#mergeStartInfo').textContent = tr('git.merge.preparing');
  try {
    mergeEtat = await busy($('#mergeStart'), () => api('/git/merges', {
      method: 'POST', body: { repo_id: repoId, source, target, allow_unrelated: sansAncetre },
    }));
    $('#mergeUnrelated').hidden = true;
    mergeFichier = null;
    const premier = mergeEtat.conflits[0];
    if (premier) await mergeOuvrirFichier(premier); else mergeRenderWork();
    await mergeRenderRunning();
  } catch (err) {
    /* DEUX BRANCHES SANS ANCÊTRE COMMUN : ce n'est pas une panne, c'est une question. Git
       refuse par défaut, à juste titre — fusionner deux histoires étrangères juxtapose deux
       projets. On explique, et on propose de le demander explicitement, plutôt que de laisser
       un toast rouge sans suite. */
    if (err.code === 'UNRELATED') {
      const bloc = $('#mergeUnrelated');
      bloc.querySelector('.mu-text').textContent = err.message;
      bloc.hidden = false;
      return;
    }
    toast(explainError(err.message), true);
  } finally { $('#mergeStartInfo').textContent = ''; }
}
$('#mergeStart') && $('#mergeStart').addEventListener('click', () => mergeDemarrer());
$('#mergeUnrelatedGo') && $('#mergeUnrelatedGo').addEventListener('click', () => mergeDemarrer({ sansAncetre: true }));

