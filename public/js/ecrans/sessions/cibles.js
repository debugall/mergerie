'use strict';
/* Éditeur « projets et branches » de la modale, la branche proposée, A19, le sélecteur de branche existante. */
// @expose branchesFor, hint, proposerBranche, readTargetRows, renderTargetRows
/* ---- Éditeur « projets et branches » de la modale ---- */
// Icône « i » + explication du champ. Même markup que les champs statiques
// d'index.html ; l'affichage est géré par la délégation en bas de fichier.
/* `tabindex="-1"` : une ligne de projet porte trois ⓘ pour trois champs, soit six arrêts de
   tabulation sur seize dans la modale, tous pour la même icône. L'explication vient désormais
   au FOCUS DU CHAMP (voir la délégation `focusin` en bas de fichier) — elle arrive là où on
   en a besoin, et le clavier va de champ en champ. */
function hint(text) {
  const t = esc(text);
  return `<button type="button" class="hint" tabindex="-1" aria-label="${t}" data-tip="${t}"><svg class="ico"><use href="#i-info"/></svg></button>`;
}

function targetRowHtml(idx, sel = {}) {
  // Le <select> natif devenait inutilisable au-delà de quelques dizaines de dépôts :
  // même composant combo que les branches, avec filtre à la frappe.
  // Comme avant, une nouvelle ligne présélectionne le 1er dépôt (sinon elle serait
  // silencieusement ignorée par readTargetRows, qui écarte les lignes sans repo_id).
  const cur = repoOptions.find((r) => r.id === Number(sel.repo_id)) || depotParDefaut() || null;
  // Le champ qui désigne une branche EXISTANTE est un sélecteur avec recherche :
  // en codage la branche de départ, en exploration la branche à regarder.
  // La branche de travail (codage) reste libre : elle est souvent à créer.
  const workHint = taskKind === 'code'
    ? hint(tr('task.tip.work-branch-code'))
    : hint(tr('task.tip.work-branch-explore'));
  const workField = taskKind === 'code'
    ? `<input class="t-branch" value="${esc(sel.branch || '')}" placeholder="${tr('task.ph.work-branch')}" />`
    : `<div class="combo"><input class="t-branch" data-pick="1" autocomplete="off" value="${esc(sel.branch || '')}" placeholder="${tr('task.ph.read-branch')}" /><div class="combo-options" hidden></div></div>`;
  /* LA BRANCHE DE DÉPART N'EST PAS `main` PARTOUT. Un dépôt part de `develop`, un autre de
     `master` ; on la retapait à chaque session. On propose donc la dernière retenue POUR CE
     DÉPÔT — modifiable, comme le fait déjà « Vérifier une branche ». */
  const baseMemo = sel.base_branch || (cur ? (memoBaseSession()[cur.id] || '') : '');
  const baseField = taskKind === 'code'
    ? `<div class="combo"><input class="t-base" data-pick="1" autocomplete="off" value="${esc(baseMemo)}" placeholder="${tr('task.ph.base-branch')}" /><div class="combo-options" hidden></div></div>`
    : '';
  return `<div class="target-row" data-row="${idx}">
    <div class="combo repo-combo">
      <input class="t-repo-search" data-pick-repo="1" autocomplete="off" value="${esc(cur ? cur.project : '')}" title="${esc(cur ? cur.project : '')}" placeholder="${repoOptions.length ? tr('task.ph.search-repo') : tr('task.ph.no-repo')}" ${repoOptions.length ? '' : 'disabled'} />
      <input type="hidden" class="t-repo" value="${cur ? cur.id : ''}" />
      <div class="combo-options" hidden></div>
    </div>${hint(tr('task.tip.repo'))}
    ${workField}${workHint}
    ${baseField}${taskKind === 'code' ? hint(tr('task.tip.base-branch')) : ''}
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-rmrow="${idx}" title="${tr('task.title.remove-project')}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}
function readTargetRows() {
  return $$('#targetRows .target-row').map((row) => {
    const base = row.querySelector('.t-base');
    return {
      repo_id: Number(row.querySelector('.t-repo').value),
      branch: row.querySelector('.t-branch').value.trim(),
      base_branch: base ? base.value.trim() : '',
    };
  }).filter((t) => t.repo_id);
}
/* UNE LIGNE D'EN-TÊTES, une seule fois, au-dessus des champs. Trois champs par projet, tous
   identifiés par leur seul texte d'invite : dès qu'on tape, plus rien ne dit ce qu'on remplit,
   et « branche à créer » ressemble à « branche de départ » quand les deux sont pleines.
   Elle réutilise le gabarit flex de la ligne (mêmes classes) pour tomber sur les mêmes
   colonnes, avec un espaceur là où la ligne porte un « ? » ou la croix de suppression. */
/* Un morceau de texte → un fragment de nom de branche : sans accent, sans majuscule, sans
   ponctuation, borné. Sert au pré-remplissage depuis le libellé ou le prompt, et à la reprise
   d'un ticket Jira — une seule règle, pour que deux chemins ne produisent pas deux formes. */
function slugBranche(texte, mots = 6) {
  return String(texte || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter(Boolean).slice(0, mots)
    .join('-').slice(0, 40);
}

/* LA BRANCHE DE TRAVAIL SE PROPOSE. C'est le seul champ obligatoire de la modale que rien ne
   remplit, et la source est sous la main : le libellé de la session, sinon les premiers mots
   du prompt. Proposée seulement — on n'écrase JAMAIS ce qui a été tapé, et un champ vidé
   volontairement le reste (`data-touche`). */
function proposerBranche() {
  if (taskKind !== 'code') return;
  const f = $('#taskForm');
  if (!f) return;
  const source = (f.label && f.label.value.trim()) || (f.prompt && f.prompt.value.trim()) || '';
  const slug = slugBranche(source);
  if (!slug) return;
  /* `.target-row` : la ligne d'EN-TÊTE porte la même classe pour s'aligner sur la colonne,
     et n'est pas un champ. */
  for (const champ of $$('#targetRows .target-row .t-branch')) {
    /* Une valeur DÉJÀ PROPOSÉE se remplace — le libellé arrive souvent après le prompt, et la
       proposition doit suivre. Une valeur TAPÉE, jamais : `data-touche` la protège, y compris
       quand on l'a volontairement vidée. */
    if (champ.dataset.touche === '1') continue;
    if (champ.value.trim() && champ.dataset.propose !== '1') continue;
    champ.value = `ai/${slug}`;
    champ.dataset.propose = '1';
  }
}

/* A19 — CETTE BRANCHE EST DÉJÀ CELLE D'UNE AUTRE SESSION. La duplication décale le nom
   (`ai/x` → `ai/x-2`) précisément pour éviter que deux sessions écrivent sur la même branche ;
   à la CRÉATION, rien ne le disait : on lançait une session sur `feature/x` que la #12 avait
   déjà commitée, et le second agent repartait de son travail sans savoir d'où il venait.
   On ne bloque pas — travailler à deux sur une branche est parfois voulu : on prévient, en
   nommant la session, et on propose le nom libre à un clic. */
function avertirBrancheDejaPrise() {
  if (taskKind !== 'code' || editingTaskId) return;
  for (const champ of $$('#targetRows .target-row input.t-branch')) {
    const row = champ.closest('.target-row');
    const repoId = Number((row.querySelector('.t-repo') || {}).value || 0);
    const nom = champ.value.trim();
    let note = row.querySelector('.t-branch-note');
    const autre = nom && allTasks.find((t) => (t.targets || []).some((tg) => tg.branch === nom
      && (!repoId || Number(tg.repo_id) === repoId)));
    if (!autre) { if (note) note.remove(); continue; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'field-note t-branch-note';
      champ.closest('.combo, td, div').appendChild(note);
    }
    note.innerHTML = `${esc(tr('task.branch.taken', { id: autre.id, label: autre.label || String(autre.prompt || '').slice(0, 40) }))} `
      + `<button type="button" class="lien-reglage" data-branch-libre="${esc(brancheLibreSession(repoId, nom))}">${esc(tr('task.branch.free'))}</button>`;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-branch-libre]');
  if (!b) return;
  const champ = b.closest('.target-row').querySelector('input.t-branch');
  if (!champ) return;
  champ.value = b.dataset.branchLibre;
  champ.dataset.touche = '1';
  avertirBrancheDejaPrise();
});
// La saisie d'une branche relance l'avertissement : il suit ce qu'on écrit, sans attendre.
document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('#targetRows input.t-branch')) avertirBrancheDejaPrise();
});

function targetHeadHtml() {
  const col = (k) => `<span class="combo t-lab">${esc(tr(k))}</span>`;
  /* La colonne « branche de travail » n'a pas la même largeur selon la saveur : en codage
     c'est un champ libre (`.t-branch`), en exploration un sélecteur (`.combo`). L'en-tête
     porte donc la classe du champ qu'il coiffe, sinon il tombe 120 px à côté. */
  /* L'ÉTOILE DIT L'OBLIGATION. En codage, la branche de travail est refusée vide par le
     serveur ; rien à l'écran ne l'annonçait, et on ne l'apprenait qu'au moment du refus. */
  const colTravail = taskKind === 'code'
    ? `<span class="t-branch t-lab req">${esc(tr('task.col.work-branch'))}</span>`
    : col('task.col.read-branch');
  return `<div class="target-head-row" aria-hidden="true">
    <span class="combo repo-combo t-lab">${esc(tr('task.col.repo'))}</span><span class="t-lab-hint"></span>
    ${colTravail}<span class="t-lab-hint"></span>
    ${taskKind === 'code' ? `${col('task.col.base-branch')}<span class="t-lab-hint"></span>` : ''}
    <span class="t-lab-rm"></span>
  </div>`;
}

function renderTargetRows(list) {
  const el = $('#targetRows');
  el.innerHTML = targetHeadHtml() + (list.length ? list : [{}]).map((t, i) => targetRowHtml(i, t)).join('');
  $$('#targetRows [data-rmrow]').forEach((b) => b.addEventListener('click', () => {
    const cur = readTargetRows();
    if (cur.length <= 1) { toast(tr('toast.au-moins-un-projet-est'), true); return; }
    cur.splice(Number(b.dataset.rmrow), 1);
    renderTargetRows(cur);
    /* Retirer un dépôt change ce que les vérificateurs couvrent : sans ce rappel, la liste
       disait encore « aucun ne couvre » après qu'on avait ôté le seul dépôt qui manquait. */
    majVerificateursSession(); majSkillsSession();
  }));
  /* Une saisie manuelle gèle le champ : la proposition ne doit jamais écraser ce que
     l'utilisateur a écrit, ni revenir après qu'il l'a effacé. */
  $$('#targetRows .target-row .t-branch').forEach((c) => c.addEventListener('input', () => { c.dataset.touche = '1'; delete c.dataset.propose; }));
  wireRepoPickers();
  wireBranchPickers();
  proposerBranche();
  avertirBrancheDejaPrise();
  $('#targetsHint').textContent = taskKind === 'code'
    ? tr('task.hint.code')
    : tr('task.hint.explore');
}
$('#addTarget').addEventListener('click', () => {
  renderTargetRows([...readTargetRows(), {}]);
  majVerificateursSession(); majSkillsSession();
});


/* ---- Sélecteur de branche existante (liste déroulante avec recherche) ----
   Les branches sont récupérées sur GitLab à la demande, puis mises en cache par
   dépôt : ouvrir plusieurs lignes du même projet ne relance pas d'appel. */
const branchCache = new Map();
async function branchesFor(repoId) {
  if (branchCache.has(repoId)) return branchCache.get(repoId);
  const r = await api(`/gitlab/branches?repo_id=${repoId}`);
  const v = { branches: r.branches || [], def: r.default || '' };
  branchCache.set(repoId, v);
  return v;
}
function wireRepoPickers() {
  $$('#targetRows .target-row').forEach((row) => {
    const input = row.querySelector('[data-pick-repo]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    const hidden = row.querySelector('.t-repo');
    const box = row.querySelector('.repo-combo .combo-options');
    const labelOf = (id) => { const r = repoOptions.find((x) => x.id === Number(id)); return r ? r.project : ''; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      const list = repoOptions.filter((r) => r.project.toLowerCase().includes(q)).slice(0, 200);
      box.innerHTML = list.map((r) => `<div class="combo-opt" data-r="${r.id}">${esc(r.project)}${marqueDemo(r)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-repo')}</div>`;
      box.hidden = false;
    };
    // Au focus on vide l'affichage : sinon le nom du dépôt courant servirait
    // lui-même de filtre et la liste se réduirait à ce seul dépôt. Le blur le
    // rétablit depuis `hidden`, donc rien n'est perdu si l'on ne choisit rien.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => {
      box.hidden = true;
      // Le texte libre ne vaut pas sélection : on réaffiche le dépôt réellement
      // retenu, sinon l'écran montrerait autre chose que ce qui sera enregistré.
      input.value = labelOf(hidden.value);
      input.title = input.value; input.scrollLeft = input.scrollWidth;
    }, 150));
    const choisir = (o) => {
      if (!o) return;
      const changed = hidden.value !== o.dataset.r;
      hidden.value = o.dataset.r;
      input.value = labelOf(o.dataset.r);
      input.title = input.value; input.scrollLeft = input.scrollWidth;
      box.hidden = true;
      // Un input caché n'émet pas 'change' tout seul : on le déclenche pour que
      // le sélecteur de branche remette son champ à zéro (branche d'un autre dépôt).
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    box.addEventListener('mousedown', (e) => choisir(e.target.closest('.combo-opt[data-r]')));
    clavierCombo(input, box, {
      ouvrir: open,
      options: () => $$('.combo-opt[data-r]', box),
      choisir,
      renoncer: () => { box.hidden = true; input.value = labelOf(hidden.value); input.blur(); },
    });
  });
}

function wireBranchPickers() {
  $$('#targetRows .target-row').forEach((row) => {
    const input = row.querySelector('[data-pick]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    // Le conteneur d'options DOIT être celui du .combo de CE champ (branche), sinon
    // row.querySelector renvoie le premier de la ligne — celui du combo projet — et la
    // liste s'affiche au mauvais endroit (sous le projet, à gauche).
    const box = input.closest('.combo').querySelector('.combo-options');
    const repoSel = row.querySelector('.t-repo');
    const open = async () => {
      const repoId = Number(repoSel.value);
      if (!repoId) return;
      box.innerHTML = '<div class="combo-opt muted">chargement des branches…</div>';
      box.hidden = false;
      let data;
      try { data = await branchesFor(repoId); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(errorHint(e.message) || e.message)}</div>`; return; }
      const q = input.value.toLowerCase();
      const list = data.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
      const defOpt = data.def ? `<div class="combo-opt" data-b="">${tr('task.combo.default', { branch: esc(data.def) })}</div>` : '';
      box.innerHTML = defOpt + (list.map((b) => `<div class="combo-opt" data-b="${esc(b)}">${esc(b)}</div>`).join('')
        || '<div class="combo-opt muted">aucune branche ne correspond</div>');
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    const choisir = (o) => {
      if (!o) return;
      input.value = o.dataset.b;
      /* Une branche CHOISIE est une saisie manuelle comme une autre : sans cette marque, la
         proposition automatique la réécrirait au prochain rendu de la ligne. */
      input.dataset.touche = '1'; delete input.dataset.propose;
      box.hidden = true;
    };
    box.addEventListener('mousedown', (e) => choisir(e.target.closest('.combo-opt[data-b]')));
    clavierCombo(input, box, {
      ouvrir: open,
      options: () => $$('.combo-opt[data-b]', box),
      choisir,
      renoncer: () => { box.hidden = true; input.blur(); },
    });
    // changer de projet invalide la branche saisie (elle appartenait à l'autre dépôt)
    repoSel.addEventListener('change', () => { input.value = ''; box.hidden = true; });
  });
}

