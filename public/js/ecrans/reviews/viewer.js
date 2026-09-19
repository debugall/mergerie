'use strict';
/* Vue plein écran : explorateur de code (rapport | arbre | fichier), `renderFile`, commentaires en attente, échanges. */
// @expose chargerEchangesRevue, openDiffPreview, openSplit, parseDiffByFile, renderDiffLines, renderTree, selectFile, split
/* ---------- Vue plein écran : explorateur de code (rapport | arbre | fichier) ---------- */
let split = { mrId: null, md: null, explanation: null, diffByFile: {}, files: [], target: '', view: 'diff', path: null, fullCache: {} };


// Rendu du diff en lignes structurées : numéros old/new + bouton « commenter ».
// Renvoie { html, oldPath, newPath }.
function renderDiffLines(diff) {
  if (!diff) return { html: '<div class="muted" style="padding:12px">(aucun diff)</div>', oldPath: '', newPath: '' };
  let oldPath = ''; let newPath = ''; let oldNo = 0; let newNo = 0;
  const strip = (p) => p.replace(/^[ab]\//, '');
  const rows = [];
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) { const p = l.slice(4); oldPath = p === '/dev/null' ? '' : strip(p); continue; }
    if (l.startsWith('+++ ')) { const p = l.slice(4); newPath = p === '/dev/null' ? '' : strip(p); continue; }
    if (l.startsWith('diff ') || l.startsWith('index ')) continue;
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hm) {
      oldNo = +hm[1]; newNo = +hm[2];
      rows.push(`<div class="dl-row hunk"><span class="ln"></span><span class="ln"></span><span class="cbtn"></span><span class="dl hunk">${esc(l)}</span></div>`);
      continue;
    }
    let type = ''; let o = ''; let n = ''; let code;
    if (l.startsWith('+')) { type = 'add'; n = newNo++; code = l.slice(1); }
    else if (l.startsWith('-')) { type = 'del'; o = oldNo++; code = l.slice(1); }
    else { o = oldNo++; n = newNo++; code = l.startsWith(' ') ? l.slice(1) : l; }
    const pfx = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
    rows.push(`<div class="dl-row ${type}" data-old="${o}" data-new="${n}">`
      + `<span class="ln ln-old">${o}</span><span class="ln ln-new">${n}</span>`
      + `<button class="cbtn ln-comment" title="${tr('cmt.inline.line-title')}"><svg class="ico"><use href="#i-plus"/></svg></button>`
      + `<span class="dl ${type}">${esc(pfx)}${highlightCode(code)}</span></div>`);
  }
  return { html: `<div class="difflines">${rows.join('')}</div>`, oldPath, newPath };
}

// Découpe un diff unifié en { chemin -> diff de ce fichier }.
function parseDiffByFile(diff) {
  const map = {};
  if (!diff) return map;
  for (const part of diff.split(/(?=^diff --git )/m)) {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(part);
    if (m) map[m[1]] = part.replace(/\s+$/, '');
  }
  return map;
}

// bascule des onglets rapport / explication
function setSplitPane(which) {
  $$('#splitView .split-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.split === which));
  $('#splitMd').innerHTML = mdToHtml(which === 'review' ? split.md : split.explanation, IA);
  $('#splitMd').scrollTop = 0;
}

// ---- arbre de fichiers ----
function buildTree(files) {
  const root = { children: {} };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      node.children = node.children || {};
      if (i === parts.length - 1) node.children[p] = { file: f };
      else { if (!node.children[p]) node.children[p] = { children: {} }; node = node.children[p]; }
    });
  }
  return root;
}
/* A8 — L'ARBRE DIT CE QUE CHAQUE FICHIER PORTE. Il ne posait qu'un point « modifié » : sur
   une merge request à quarante fichiers, savoir lesquels portent un constat, un fil de
   discussion ou un brouillon demandait de les ouvrir un par un. Tout est déjà chargé —
   `split.findings`, `split.discussions`, `split.drafts`, `split.diffByFile`. Le poids du
   changement (nombre de lignes) situe l'effort avant d'ouvrir : trois fichiers à deux lignes
   ne se lisent pas comme un fichier à trois cents.

   Les pastilles restent MUETTES quand il n'y a rien : un arbre constellé de zéros serait plus
   difficile à lire que l'arbre nu qu'on remplace. */
function lignesChangees(path) {
  const d = split.diffByFile[path];
  if (!d) return 0;
  return String(d).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
}
function treeFileRow(f, label) {
  const constats = (split.findings || []).filter((x) => x.file === f.path && x.status !== 'resolved').length;
  const bloquants = (split.findings || []).filter((x) => x.file === f.path && x.status !== 'resolved' && x.severity === 'blocker').length;
  const fils = (split.discussions || []).filter((d) => d.notes && d.notes[0] && d.notes[0].position
    && (d.notes[0].position.new_path === f.path || d.notes[0].position.old_path === f.path)).length;
  const brouillons = (split.drafts || []).filter((d) => d.new_path === f.path || d.old_path === f.path).length;
  const n = f.changed ? lignesChangees(f.path) : 0;
  const puce = (cls, valeur, titre) => (valeur
    ? `<span class="tf-badge tf-${cls}" title="${esc(titre)}">${esc(String(valeur))}</span>` : '');
  return `<div class="tree-file${f.changed ? ' changed' : ''}${split.path === f.path ? ' active' : ''}" data-path="${esc(f.path)}">`
    + `${f.changed ? '<span class="dot">●</span>' : ''}<span class="tf-name">${esc(label)}</span>`
    + `<span class="tf-badges">`
    + puce(bloquants ? 'blocker' : 'finding', constats, tr('viewer.tree.findings', { n: constats, count: constats }))
    + puce('thread', fils, tr('viewer.tree.threads', { n: fils, count: fils }))
    + puce('draft', brouillons, tr('viewer.tree.drafts', { n: brouillons, count: brouillons }))
    + puce('lines', n, tr('viewer.tree.lines', { n, count: n }))
    + `</span></div>`;
}
// Un sous-arbre contient-il au moins un fichier modifié ? Sert à ne déplier par défaut
// que les dossiers qui portent un changement (les autres restent repliés).
function nodeHasChange(node) {
  if (node.file) return !!node.file.changed;
  return Object.values(node.children || {}).some(nodeHasChange);
}
/* Ce que l'utilisateur a ouvert ou fermé À LA MAIN, retenu par chemin de dossier. L'arbre est
   reconstruit à chaque clic sur un fichier : sans cette mémoire, l'état repart de la règle par
   défaut et un dossier ouvert se referme sous le curseur — au moment précis où on ouvre l'un de
   ses fichiers. Rangé dans `split`, il repart donc à zéro quand on ouvre un autre diff. */
function memoDossiers() { split.dirs = split.dirs || {}; return split.dirs; }
function renderTreeNode(node, name, parent = '') {
  if (node.file) return treeFileRow(node.file, name);
  const keys = Object.keys(node.children || {}).sort((a, b) => {
    const af = !!node.children[a].file, bf = !!node.children[b].file;
    if (af !== bf) return af ? 1 : -1;
    return a.localeCompare(b);
  });
  const chemin = name === null ? '' : (parent ? `${parent}/${name}` : name);
  const inner = keys.map((k) => renderTreeNode(node.children[k], k, chemin)).join('');
  if (name === null) return inner;
  // Ce que l'utilisateur a décidé prime ; sinon, déplié seulement si le dossier porte un changement.
  const memo = memoDossiers();
  const open = (chemin in memo ? memo[chemin] : nodeHasChange(node)) ? ' open' : '';
  return `<details${open} class="tree-folder" data-dir="${esc(chemin)}"><summary>${esc(name)}</summary><div class="tree-children">${inner}</div></details>`;
}
function renderTree() {
  const q = ($('#treeSearch').value || '').toLowerCase().trim();
  const el = $('#treeList');
  if (q) {
    const matches = split.files.filter((f) => f.path.toLowerCase().includes(q));
    el.innerHTML = matches.length ? matches.map((f) => treeFileRow(f, f.path)).join('') : '<p class="muted">aucun fichier</p>';
  } else {
    el.innerHTML = renderTreeNode(buildTree(split.files), null) || '<p class="muted">(vide)</p>';
  }
}

/* Base d'URL des routes du viewer. Le composant est le même pour une MR et pour un
   projet de session : seule la racine change (`split.base`), les chemins `/file` et
   `/filediff` sont identiques des deux côtés. */
function splitBase() { return split.base || `/mrs/${split.mrId}`; }

async function selectFile(path) {
  split.path = path;
  renderTree();
  await renderFile();
}

// Coloration syntaxique générique (commentaires, chaînes, nombres, mots-clés).
// Tokenise le code BRUT puis échappe chaque token (pas de casse d'entités HTML).
const CODE_TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d[\w.]*)\b|\b(function|fn|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|const|let|var|class|extends|implements|interface|trait|enum|new|public|private|protected|static|readonly|abstract|final|void|null|true|false|undefined|this|self|parent|echo|print|require|require_once|include|include_once|use|namespace|async|await|try|catch|finally|throw|throws|import|from|export|default|typeof|instanceof|yield|global|as|match)\b/g;
function highlightCode(code) {
  if (!code) return '';
  let out = ''; let last = 0; let m;
  CODE_TOKEN.lastIndex = 0;
  while ((m = CODE_TOKEN.exec(code))) {
    out += esc(code.slice(last, m.index));
    const cls = m[1] ? 'c-com' : m[2] ? 'c-str' : m[3] ? 'c-num' : 'c-kw';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

/* UNE RÉPONSE EN RETARD NE DOIT PAS ÉCRASER L'ÉCRAN. `renderFile` vide le panneau, ATTEND le
   diff du fichier, puis réécrit. Deux rendus peuvent donc se chevaucher — l'ouverture de la
   visionneuse en lance un, et un clic sur un constat en lance aussitôt un autre sur un autre
   fichier. Le plus LENT gagnait : il réécrivait `#fileContent` avec son contenu, effaçant le
   fichier qu'on venait d'ouvrir ET tout éditeur de commentaire ouvert dessus — c'est-à-dire ce
   qu'on était en train d'écrire. Silencieux, et intermittent par nature. Un numéro d'ordre
   suffit : un rendu qui n'est plus le dernier s'abstient. */
let renderFileSeq = 0;
async function renderFile() {
  const seq = ++renderFileSeq;
  const perime = () => seq !== renderFileSeq;
  const path = split.path;
  $('#fileName').textContent = path || '';
  const el = $('#fileContent');
  if (!path) { el.innerHTML = ''; return; }
  const changed = !!split.diffByFile[path];
  el.innerHTML = skeleton(4);
  if (changed) {
    // fichier entier AVEC les changements surlignés (diff à contexte complet, façon GitLab)
    if (split.diffFullCache[path] == null) {
      try { const r = await api(`${splitBase()}/filediff?path=${encodeURIComponent(path)}`); split.diffFullCache[path] = r.diff || split.diffByFile[path] || ''; }
      catch { split.diffFullCache[path] = split.diffByFile[path] || ''; }
    }
    if (perime()) return;
    const rd = renderDiffLines(split.diffFullCache[path]);
    split.fileOldPath = rd.oldPath || path;
    split.fileNewPath = rd.newPath || path;
    el.innerHTML = rd.html;
    renderInlineThreads();     // commentaires existants sous leur ligne
    renderInlineDrafts();      // …et ceux qui attendent encore d'être envoyés
    el.scrollTop = 0;
    setupChangeNav();          // repère les changements + saute au premier
    return;
  }
  // fichier non modifié : contenu complet coloré, pas de navigation de changements
  $('#changeNav').hidden = true;
  $('#minimap').hidden = true;
  if (split.fullCache[path] == null) {
    try { const r = await api(`${splitBase()}/file?path=${encodeURIComponent(path)}`); split.fullCache[path] = r.content || ''; }
    catch (e) { if (!perime()) el.innerHTML = errorBox(e.message); return; }
  }
  if (perime()) return;
  el.innerHTML = `<pre class="code">${highlightCode(split.fullCache[path])}</pre>`;
  el.scrollTop = 0;
}

// Repère les blocs de changement (runs contigus d'ajouts/suppressions), affiche
// la navigation et saute automatiquement au premier.
function setupChangeNav() {
  const lines = [...$('#fileContent').querySelectorAll('.dl-row')];
  const blocks = [];
  let inBlock = false;
  for (const l of lines) {
    const isChange = l.classList.contains('add') || l.classList.contains('del');
    if (isChange && !inBlock) { blocks.push(l); inBlock = true; }
    else if (!isChange) inBlock = false;
  }
  split.changeBlocks = blocks;
  split.changeIdx = -1;
  $('#changeNav').hidden = blocks.length === 0;
  renderMinimap();
  if (blocks.length) goToChange(0);
}

// Affiche les commentaires existants (discussions inline) sous leur ligne.
function renderInlineThreads() {
  const discs = (split.discussions || []).filter((d) => d.notes[0] && d.notes[0].position);
  for (const d of discs) {
    const pos = d.notes[0].position;
    if (pos.new_path !== split.fileNewPath && pos.old_path !== split.fileOldPath) continue;
    let row = null;
    if (pos.new_line != null) row = $(`#fileContent .dl-row[data-new="${pos.new_line}"]`);
    else if (pos.old_line != null) row = $(`#fileContent .dl-row[data-old="${pos.old_line}"]`);
    if (!row) continue;
    row.classList.add('has-comment');
    const el = document.createElement('div');
    el.className = 'cmt-thread';
    el.dataset.disc = d.id;
    el.innerHTML = d.notes.map((n) => noteHtml(n, split.mrId)).join('') + replyBtnHtml(d.id, split.mrId);
    row.after(el);
  }
}

/* LES COMMENTAIRES EN ATTENTE, sous leur ligne, comme les vrais — mais reconnaissables au
   premier regard : ils ne sont PAS partis. Les afficher comme les autres ferait croire le
   travail fait, et on refermerait la MR en laissant ses remarques en local. */
function renderInlineDrafts() {
  for (const d of split.drafts || []) {
    if (d.new_path !== split.fileNewPath && d.old_path !== split.fileOldPath) continue;
    let row = null;
    if (d.new_line != null) row = $(`#fileContent .dl-row[data-new="${d.new_line}"]`);
    else if (d.old_line != null) row = $(`#fileContent .dl-row[data-old="${d.old_line}"]`);
    if (!row) continue;
    row.classList.add('has-comment');
    const el = document.createElement('div');
    el.className = 'cmt-thread cmt-draft';
    el.dataset.draft = d.id;
    el.innerHTML = `<div class="cmt-draft-head">${svgIco('edit')}<span>${esc(tr('cmt.draft.badge'))}</span></div>`
      + `<div class="cmt-draft-body">${esc(d.body)}</div>`
      + `<div class="cmt-actions"><button type="button" class="btn btn-sm" data-draftedit="${d.id}">${esc(tr('ui.edit'))}</button>`
      + `<button type="button" class="btn btn-sm btn-danger" data-draftdel="${d.id}">${esc(tr('ui.delete'))}</button></div>`;
    // Après le fil existant de la même ligne s'il y en a un : les vrais d'abord, l'à-venir après.
    const apres = row.nextElementSibling && row.nextElementSibling.classList.contains('cmt-thread')
      ? row.nextElementSibling : row;
    apres.after(el);
  }
}

/* Le compteur, dans l'en-tête de la vue plein écran. C'est LUI qui rappelle qu'un travail
   attend : sans compteur visible, on referme la MR en laissant ses remarques en local. */
function majBoutonBrouillons() {
  const b = $('#draftsSend');
  if (!b) return;
  const n = (split.drafts || []).length;
  b.hidden = !n;
  $('#draftsCount').textContent = n;
  // La sortie de secours n'apparaît qu'avec quelque chose à vider.
  const w = $('#draftsWipe');
  if (w) w.hidden = !n;
  // Tout ce qui touche aux remarques passe ici : la carte suit le compteur, quoi qu'il arrive.
  majCartesBrouillons(split.mrId, split.drafts);
}

async function chargerBrouillons() {
  if (!split.mrId) { split.drafts = []; majBoutonBrouillons(); return; }
  try {
    const d = await api(`/mrs/${split.mrId}/comment-drafts`);
    split.drafts = d.drafts || [];
  } catch { split.drafts = []; }
  majBoutonBrouillons();
}

// Mini-carte : marqueurs cliquables aux emplacements des changements.
function renderMinimap() {
  const mm = $('#minimap');
  const content = $('#fileContent');
  const blocks = split.changeBlocks || [];
  if (!blocks.length) { mm.hidden = true; mm.innerHTML = ''; return; }
  const total = content.scrollHeight || 1;
  const cTop = content.getBoundingClientRect().top;
  mm.innerHTML = blocks.map((b, i) => {
    const top = ((b.getBoundingClientRect().top - cTop + content.scrollTop) / total) * 100;
    const type = b.classList.contains('del') ? 'del' : 'add';
    return `<div class="minimap-mark ${type}" data-ci="${i}" title="changement ${i + 1}" style="top:${top}%"></div>`;
  }).join('');
  mm.hidden = false;
}
function goToChange(i) {
  const blocks = split.changeBlocks || [];
  if (!blocks.length) return;
  split.changeIdx = (i + blocks.length) % blocks.length;
  const el = blocks[split.changeIdx];
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
  $('#changeCounter').textContent = `${split.changeIdx + 1}/${blocks.length}`;
}

async function openSplit(id) {
  try {
    /* A8 — LES CONSTATS ARRIVENT AVEC LE RESTE. L'arbre en a besoin pour dire quels fichiers
       en portent ; les demander APRÈS ferait un arbre qui se complète sous les yeux. Sans
       rapport (aperçu avant review), la liste est vide et les pastilles se taisent. */
    const [d, diffResp, tree, disc, fnd] = await Promise.all([
      api(`/mrs/${id}`), api(`/mrs/${id}/diff`), api(`/mrs/${id}/tree`).catch(() => ({ files: [] })),
      api(`/mrs/${id}/discussions`).catch(() => ({ discussions: [] })),
      api(`/mrs/${id}/findings`).catch(() => ({ findings: [] })),
    ]);
    split = {
      mrId: id,
      forge: d.mr && d.mr.forge,        // libellés « GitLab »/« GitHub » des commentaires
      md: d.review && d.review.md,
      explanation: d.review && d.review.explanation,
      diffByFile: parseDiffByFile(diffResp.diff),
      files: tree.files || [],
      target: tree.target || '',
      discussions: disc.discussions || [],
      findings: fnd.findings || [],
      path: null, fullCache: {}, diffFullCache: {},
    };
    $('#splitTitle').textContent = `!${d.mr.iid} — ${d.mr.title || ''}`;
    setSplitPane('review');
    chargerBrouillons();
    renderTree();
    $('#splitView').hidden = false;
    const first = split.files.find((f) => f.changed) || split.files[0];
    if (first) selectFile(first.path);
    else { $('#fileName').textContent = 'Aucun fichier'; $('#fileContent').innerHTML = '<p class="muted">Arborescence indisponible — relance une review de cette MR.</p>'; }
  } catch (e) { toast(e.message, true); }
}

/* Aperçu du diff AVANT review : réutilise le viewer plein écran (arbre + diff
   inline + navigation), mais le panneau de gauche devient un panneau de DÉCISION —
   on juge la MR et on tranche (Reviewer / Classer sans review) sans dépenser un
   appel IA si elle est triviale. Le clone est chauffé côté serveur par /diffview,
   donc les endpoints /file et /filediff du viewer fonctionnent ensuite. */
async function openDiffPreview(m) {
  let dv;
  try { dv = await api(`/mrs/${m.id}/diffview`); }
  catch (e) { toast(explainError(e.message), true); return; }
  split = {
    mrId: m.id, mr: m, preview: true, forge: m.forge,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('preview-mode');
  $('#splitTitle').textContent = `!${m.iid} — ${m.title || ''}`;
  renderDecisionPanel(m, dv.stats);
  renderTree();
  $('#splitView').hidden = false;
  const first = split.files.find((f) => f.changed) || split.files[0];
  if (first) selectFile(first.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}

// Panneau de décision (remplace le rapport en mode aperçu) : résumé du diff + les
// deux actions, câblées comme sur les cartes.
function renderDecisionPanel(m, stats) {
  $('#splitMd').innerHTML = `<div class="diff-decision">
      <h3>${tr('preview.decision.title')}</h3>
      <p class="diff-decision-stats">${tr('preview.decision.stats', { files: stats.files, added: stats.added, removed: stats.removed })}</p>
      <p class="muted">${tr('preview.decision.help')}</p>
      <div class="diff-decision-actions">
        <button id="pvReview" class="btn btn-primary"><svg class="ico"><use href="#i-play"/></svg>${tr('mr.btn.review')}</button>
        <button id="pvDismiss" class="btn"><svg class="ico"><use href="#i-archive"/></svg>${tr('mr.btn.dismiss')}</button>
        ${m.closed_seen ? '' : `<button id="pvMerge" class="btn btn-danger"><svg class="ico"><use href="#i-merge"/></svg>${tr('task.btn.merge')}</button>`}
      </div>
    </div>`;
  $('#pvReview').addEventListener('click', (e) => {
    const b = e.currentTarget;
    busy(b, () => api(`/mrs/${m.id}/review`, { method: 'POST' }))
      .then(() => { toast(tr('toast.review-de-lancee', { iid: m.iid })); closeSplit(); refreshStatus(); })
      .catch((err) => toast(explainError(err.message), true));
  });
  $('#pvDismiss').addEventListener('click', (e) => {
    const b = e.currentTarget;
    busy(b, () => api(`/mrs/${m.id}/done`, { method: 'POST' }))
      .then(() => {
        closeSplit();
        toastUndo(tr('toast.classee-sans-review', { iid: m.iid }), async () => {
          try { await api(`/mrs/${m.id}/reopen`, { method: 'POST' }); loadSegment(currentSeg); refreshCounts(); } catch (err) { toast(err.message, true); }
        });
        loadToReview(); refreshCounts();
      })
      .catch((err) => toast(explainError(err.message), true));
  });
  const pvMerge = $('#pvMerge');
  if (pvMerge) pvMerge.addEventListener('click', (e) => {
    mergeMrFromQueue(m, () => { closeSplit(); loadToReview(); refreshCounts(); });
  });
}

/* Historique des demandes de modification : chaque régénération a été déclenchée par une
   demande précise, et a produit SA version de rapport. Les afficher côte à côte évite de
   rejouer de tête « qu'est-ce que j'avais demandé pour arriver à ce rapport ? ». */
/* LES ÉCHANGES D'UNE REVUE : chaque question posée et la réponse obtenue, la plus récente en
   tête — c'est celle qu'on vient de poser qu'on attend. La réponse est rendue en Markdown, comme
   le rapport : l'IA y cite des chemins et des extraits de code.
   Aucune version n'apparaît ici, et c'est le point : une question ne fabrique pas de rapport. */
async function chargerEchangesRevue(id) {
  const box = $('#askHistory');
  if (!box) return;
  let d;
  try { d = await api(`/mrs/${id}/passes`); } catch { box.innerHTML = ''; return; }
  const echanges = (d.passes || []).filter((p) => p.id);
  if (!echanges.length) { box.innerHTML = `<p class="muted">${esc(tr('report.ask.none'))}</p>`; return; }
  /* Le contenu de CHAQUE échange est déjà sur le serveur, mais `passes` ne rend que le courant :
     on relit donc chacun. Une revue en compte quelques-uns, pas des milliers. */
  const complets = await Promise.all(echanges.map((p) => api(`/mrs/${id}/passes?n=${p.n}`)
    .then((r) => ({ ...p, output: (r.current || {}).output || '' })).catch(() => p)));
  box.innerHTML = `<p class="muted">${esc(tr('report.ask.history'))}</p>`
    + complets.slice().reverse().map((p) => `<div class="ask-entry">
        <div class="ask-entry-head"><span class="muted">${esc(fmtDateTime(p.created_at))}</span></div>
        <div class="ask-q">${esc(p.prompt || '')}</div>
        <div class="ask-a md">${p.output ? mdToHtml(p.output, IA) : `<span class="muted">${esc(tr('report.ask.running'))}</span>`}</div>
      </div>`).join('')
    + `<button type="button" class="btn btn-sm btn-ghost" id="askSeeAll">${svgIco('doc')}<span>${esc(tr('report.ask.see-all'))}</span></button>`;
  const tout = $('#askSeeAll');
  // La même vue à itérations que les sessions : colonne, recherche, épingles et noms.
  if (tout) tout.addEventListener('click', () => openPasses(`/mrs/${id}`));
}

function renderModifyHistory(versions) {
  const box = $('#modifyHistory');
  if (!box) return;
  const asked = (versions || []).filter((v) => v.kind === 'modify' && v.instruction);
  box.hidden = !asked.length;
  if (!asked.length) return;
  box.innerHTML = `<p class="muted">${esc(tr('report.modify.history'))}</p>`
    + asked.map((v) => `<div class="modify-entry">
        <div class="modify-entry-head">
          <span class="muted">${esc(fmtDateTime(v.created_at))}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-modifyv="${v.version}"
            title="${esc(tr('report.modify.see-report-title', { v: v.version }))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('report.modify.see-report', { v: v.version }))}</button>
        </div>
        <div class="modify-entry-text">${esc(v.instruction)}</div>
      </div>`).join('');
  // Ouvrir le rapport correspondant = piloter le sélecteur de versions existant.
  $$('#modifyHistory [data-modifyv]').forEach((b) => b.addEventListener('click', () => {
    const sel = $('#mdVersion');
    if (!sel || sel.hidden) return;
    sel.value = b.dataset.modifyv;
    sel.dispatchEvent(new Event('change'));
    sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

function closeSplit() {
  $('#splitView').hidden = true;
  $('#splitView').classList.remove('preview-mode', 'session-mode'); // sinon un openSplit suivant hériterait du mode
}

$$('#splitView .split-tabs button').forEach((b) => b.addEventListener('click', () => setSplitPane(b.dataset.split)));
$('#prevChange').addEventListener('click', () => goToChange(split.changeIdx - 1));
$('#nextChange').addEventListener('click', () => goToChange(split.changeIdx + 1));
$('#minimap').addEventListener('click', (e) => { const m = e.target.closest('.minimap-mark'); if (m) goToChange(Number(m.dataset.ci)); });

