'use strict';
/* Les portes d'entrée de la modale : faire coder à partir de cette réponse (B9), d'une question (B18), d'un ticket, d'une page de notes ; dupliquer. */
// @expose openTaskForJira, openTaskForNote
/* ---------- B9 : « Faire coder à partir de cette réponse » ----------
   L'exploration a lu trois dépôts et répondu. Le codage qui suit part des MÊMES dépôts, avec
   la question et la réponse en contexte, et surtout DANS LA SESSION D'AGENT de l'exploration :
   l'agent garde ce qu'il a lu au lieu de tout relire. Le mécanisme de reprise fournie à la
   création existe déjà — on ne fait que le pré-remplir. */
async function coderDepuisExploration(id) {
  const f = $('#taskForm');
  let d;
  try { d = await api(`/tasks/${id}`); } catch (e) { toast(explainError(e.message), true); return; }
  const t = d.task || {};
  let reponse = '';
  // `current` est la passe la plus récente : c'est son `output` qui est la réponse.
  try { reponse = ((await api(`/tasks/${id}/passes`)).current || {}).output || ''; } catch { reponse = ''; }

  f.reset(); resetTaskFiles();
  editingTaskId = null; cleJiraDeLaSession = null; taskKind = 'code';
  await loadRepoOptions();
  applyKindToModal('code');
  /* Mêmes dépôts, branche de travail à nommer : une exploration lit une branche existante,
     un codage en crée une — proposer celle qu'on vient de LIRE ferait écrire dessus. */
  renderTargetRows((t.targets || []).map((tg) => ({ repo_id: tg.repo_id, base_branch: tg.branch || '' })));
  proposerBranche();
  f.prompt.value = `${tr('task.explore-to-code.header')}\n\n> ${String(t.prompt || '').trim().replace(/\n/g, '\n> ')}\n\n${String(reponse).trim()}\n\n---\n\n`;
  /* La session d'agent de l'exploration : c'est TOUTE la valeur du geste. Les cibles d'une
     exploration partagent le même handle — on prend le premier qui en a un. */
  const handle = (t.targets || []).map((tg) => tg.session_key).filter(Boolean)[0] || '';
  if (f.session_id) f.session_id.value = handle;
  const hint = $('#taskSessionHint');
  if (hint && handle) { hint.textContent = tr('task.explore-to-code.session'); hint.hidden = false; hint.dataset.keep = '1'; }
  if (handle) { const av = $('#taskAdvanced'); if (av) av.open = true; }   // on doit VOIR la reprise
  $('#taskModalTitle').textContent = tr('task.explore-to-code.title');
  $('#taskExistingImgs').textContent = '';
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
  const fin = f.prompt.value.length;
  try { f.prompt.setSelectionRange(fin, fin); } catch { /* champ non focusable */ }
}

/* B18 — UNE QUESTION LIBRE DEVIENT UN CODAGE (ou une exploration). Même patron que
   `coderDepuisExploration`, à une différence près : une question n'a pas de dépôt, donc rien à
   reprendre comme cible — on laisse la ligne à remplir plutôt que d'en inventer une. La
   SESSION D'AGENT, elle, est reprise : c'est tout l'intérêt du geste, l'IA a déjà le contexte
   de sa propre réponse. */
async function coderDepuisQuestion(id, kind = 'code') {
  let q; let reponse = '';
  // La route enveloppe la question sous `task` : la lire à plat donnerait une demande vide.
  try { q = (await api(`/questions/${id}`)).task; }
  catch (e) { toast(explainError(e.message), true); return; }
  if (!q) return;
  try { reponse = ((await api(`/questions/${id}/passes`)).current || {}).output || ''; } catch { reponse = ''; }

  await openTaskModal(kind);
  const f = $('#taskForm');
  f.prompt.value = `${tr('task.explore-to-code.header')}\n\n> ${String(q.prompt || '').trim().replace(/\n/g, '\n> ')}\n\n${String(reponse).trim()}\n\n---\n\n`;
  if (f.label && q.label) f.label.value = String(q.label).slice(0, 120);
  if (f.session_id && q.session_key) {
    f.session_id.value = q.session_key;
    const hint = $('#taskSessionHint');
    if (hint) { hint.textContent = tr('task.explore-to-code.session'); hint.hidden = false; hint.dataset.keep = '1'; }
    const av = $('#taskAdvanced'); if (av) av.open = true;
  }
  $('#taskModalTitle').textContent = tr('task.explore-to-code.title');
  f.prompt.focus();
  const fin = f.prompt.value.length;
  try { f.prompt.setSelectionRange(fin, fin); } catch { /* champ non focusable */ }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-qcode]');
  if (b) coderDepuisQuestion(Number(b.dataset.qcode));
});

/* Les images d'un ticket Jira, proposées à joindre à la session. Elles ne sont TÉLÉCHARGÉES
   qu'au moment de la création (quand la case est cochée) : ouvrir la modale ne doit pas tirer
   cinq pièces jointes qu'on ne joindra peut-être pas. */
let piecesJiraProposees = [];
async function proposerPiecesJira(issue) {
  const box = $('#taskJiraPieces');
  piecesJiraProposees = [];
  if (!box) return;
  const images = ((issue && issue.attachments) || [])
    .filter((a) => /^image\//i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename || ''));
  box.hidden = !images.length;
  if (!images.length) { box.innerHTML = ''; return; }
  piecesJiraProposees = images;
  const defaut = images.length <= 3;
  box.innerHTML = `<p class="field-note">${esc(tr('task.jira.pieces.intro'))}</p>`
    + images.map((a, i) => `<label class="jira-piece"><input type="checkbox" data-jira-piece="${i}"${defaut ? ' checked' : ''} />
        <img src="/api/jira/attachment/${encodeURIComponent(a.id)}" alt="${esc(a.filename)}" loading="lazy" />
        <span class="muted">${esc(a.filename)}</span></label>`).join('');
}

/* Au moment de créer : on télécharge CE QUI EST COCHÉ et on le joint comme une capture collée.
   Un téléchargement qui échoue ne fait pas échouer la session — on le dit, et on continue. */
async function piecesJiraCochees() {
  const choisies = $$('#taskJiraPieces [data-jira-piece]:checked').map((c) => piecesJiraProposees[Number(c.dataset.jiraPiece)]).filter(Boolean);
  const out = [];
  for (const a of choisies) {
    try {
      const rep = await fetch(`/api/jira/attachment/${encodeURIComponent(a.id)}`);
      if (!rep.ok) continue;
      const blob = await rep.blob();
      const data = await new Promise((res2, rej) => {
        const r = new FileReader(); r.onload = () => res2(r.result); r.onerror = rej; r.readAsDataURL(blob);
      });
      out.push({ name: a.filename || 'capture.png', data });
    } catch { /* pièce injoignable : la session part sans elle */ }
  }
  return out;
}

/* B6 — DEPUIS UNE PAGE DE NOTES. Le prompt est le contenu de la page, titre compris : c'est
   ce qui a été écrit en réunion, et le réécrire dans la modale est exactement la corvée qu'on
   supprime. Les captures collées dans la page sont proposées en pièces jointes, comme celles
   d'un ticket Jira — cochées d'office jusqu'à trois, au-delà choisir est le geste utile. */
async function openTaskForNote(page) {
  if (!page) return;
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  editingTaskId = null; taskKind = 'code';
  launchAfterCreate = false;          // on prépare, l'utilisateur lance
  cleJiraDeLaSession = null;
  await loadRepoOptions();
  applyKindToModal('code');
  renderTargetRows(lignesProposees('code'));
  setupTaskJira('');
  f.prompt.value = `${tr('task.note.context-header', { title: page.title || '' })}\n\n${(page.content || '').trim()}\n\n---\n\n`;
  await proposerPiecesNote(page.id);
  await majVerificateursSession('');
  await appliquerDefautsSession(f);
  $('#taskModalTitle').textContent = tr('task.note.modal-title', { title: page.title || '' });
  $('#taskExistingImgs').textContent = tr('task.note.from', { title: page.title || '' });
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
  f.prompt.setSelectionRange(f.prompt.value.length, f.prompt.value.length);
}

/* Les captures de la page, en cases à cocher. On réutilise le bloc des pièces Jira : c'est le
   même geste et le même endroit à l'écran — en avoir deux ferait deux vies à maintenir. */
async function proposerPiecesNote(pageId) {
  const box = $('#taskJiraPieces');
  piecesNoteProposees = [];
  if (!box) return;
  let images = [];
  try { images = await api(`/notes/${pageId}/images`); } catch { images = []; }
  box.hidden = !images.length;
  if (!images.length) { box.innerHTML = ''; return; }
  piecesNoteProposees = images.map((im) => ({ ...im, url: `/api/notes/${pageId}/images/${im.id}` }));
  const defaut = images.length <= 3;
  box.innerHTML = `<p class="field-note">${esc(tr('task.note.pieces.intro'))}</p>`
    + piecesNoteProposees.map((a, i) => `<label class="jira-piece"><input type="checkbox" data-note-piece="${i}"${defaut ? ' checked' : ''} />
        <img src="${esc(safeImg(a.url))}" alt="${esc(a.name)}" loading="lazy" />
        <span class="muted">${esc(a.name)}</span></label>`).join('');
}

/* Même mécanique que pour Jira : on télécharge CE QUI EST COCHÉ au moment de créer. */
async function piecesNoteCochees() {
  const choisies = $$('#taskJiraPieces [data-note-piece]:checked')
    .map((c) => piecesNoteProposees[Number(c.dataset.notePiece)]).filter(Boolean);
  const out = [];
  for (const a of choisies) {
    try {
      const rep = await fetch(a.url);
      if (!rep.ok) continue;
      const blob = await rep.blob();
      const data = await new Promise((res2, rej) => {
        const r = new FileReader(); r.onload = () => res2(r.result); r.onerror = rej; r.readAsDataURL(blob);
      });
      out.push({ name: a.name || 'capture.png', data });
    } catch { /* pièce injoignable : la session part sans elle */ }
  }
  return out;
}

async function openTaskForJira(key) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  editingTaskId = null; taskKind = 'code';
  launchAfterCreate = false;   // on prépare, l'utilisateur lance
  await loadRepoOptions();
  applyKindToModal('code');

  let issue = null;
  try { issue = await api('/jira/fetch', { method: 'POST', body: { key } }); }
  catch (e) { toast(explainError(e.message), true); }      // le ticket reste ouvrable sans contexte

  const slug = slugBranche((issue && issue.summary) || '');
  const branch = `feature/${key}${slug ? `-${slug}` : ''}`;
  /* LE DÉPÔT EST LE SEUL CHAMP QU'ON REMPLISSAIT ENCORE À LA MAIN. On ne peut pas le deviner —
     mais on peut se souvenir : le dernier dépôt choisi pour le MÊME projet Jira (le préfixe de
     la clé, `PROJ-1408` → `PROJ`) est proposé, et reste modifiable comme n'importe quelle
     ligne. Sans souvenir, on retombe sur le comportement d'avant : à choisir. */
  const projetJira = String(key).split('-')[0].toUpperCase();
  const memo = memoDepotJira()[projetJira];
  const connu = memo && repoOptions.some((r) => r.id === Number(memo));
  renderTargetRows([connu ? { branch, repo_id: Number(memo) } : { branch }]);
  setupTaskJira(branch);

  if (issue) {
    f.prompt.value = `${tr('task.jira.context-header', { key: issue.key })}\n\n${(issue.context || '').trim()}\n\n---\n\n`;
    if (f.commit_message) f.commit_message.value = `${key} ${issue.summary || ''}`.trim();
  }
  cleJiraDeLaSession = key;
  /* B10 — LES CAPTURES DU TICKET, SANS PASSER PAR LE DOSSIER TÉLÉCHARGEMENTS. Un bug
     d'affichage vient avec sa capture : on la téléchargeait depuis Jira, on la retrouvait dans
     Téléchargements, on la collait dans la modale — pour chaque ticket. Elles sont proposées
     en cases à cocher, cochées d'office s'il y en a trois ou moins (au-delà, choisir est le
     geste utile). Le téléchargement passe par le proxy existant. */
  await proposerPiecesJira(issue);
  await majVerificateursSession('');   // §0 — idem depuis un ticket
  await appliquerDefautsSession(f);    // A20 — et les cases par défaut, comme partout ailleurs
  $('#taskModalTitle').textContent = tr('jira.code-modal-title', { key });
  $('#taskExistingImgs').textContent = issue ? tr('jira.code-from', { key: issue.key, summary: issue.summary || '' }) : '';
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
  // Curseur après le bloc de contexte : on écrit SA demande, pas au milieu du ticket.
  const end = f.prompt.value.length;
  try { f.prompt.setSelectionRange(end, end); } catch { /* champ non focusable */ }
}

async function openTaskEdit(id) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  try {
    const d = await api(`/tasks/${id}`);
    const t = d.task;
    editingTaskId = id; launchAfterCreate = false;
    taskKind = t.kind || 'code';
    await loadRepoOptions();
    applyKindToModal(taskKind);
    renderTargetRows((t.targets || []).map((x) => ({ repo_id: x.repo_id, branch: x.branch, base_branch: x.base_branch })));
    setupTaskJira((t.targets && t.targets[0] && t.targets[0].branch) || '');
    f.prompt.value = t.prompt || '';
    if (f.label) f.label.value = t.label || '';
    if (f.commit_message) f.commit_message.value = t.commit_message || '';
    if (f.auto_push) f.auto_push.checked = !!t.auto_push;
    if (f.ask_questions) f.ask_questions.checked = !!t.ask_questions;
  if (f.notify_jira) f.notify_jira.checked = !!t.notify_jira;
  if (f.review_after) f.review_after.checked = !!t.review_after;
    poserDateProgrammee(f, t.scheduled_at);
    await majVerificateursSession(t.verifier_id || '', { autoPick: false });
    if (f.session_id) f.session_id.value = sharedSessionKey(t.targets);
    deplierAvanceSiRempli(f);
    $('#taskModalTitle').textContent = tr(taskKind === 'code' ? 'task.edit.code-title' : 'task.edit.explore-title');
    setTaskPieces('task', d.images);      // les pièces, pas leur compte : on veut les VOIR
    $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
    $('#taskSubmitOnly').hidden = true;
    showTaskModal();
    /* L'agent qui a porté la session, replacé dans le combo. Supprimé depuis, il garde son
       NOM sur la session : on l'affiche quand même, et le combo reste inerte — sinon la
       relecture d'une session ancienne perdrait l'information sans rien dire. */
    poserAgentRelu(t);
  } catch (e) { toast(explainError(e.message), true); }
}

/* Une session dupliquée ne doit pas repartir sur la MÊME branche : l'IA y commiterait par-dessus
   le travail de l'originale, et deux sessions se disputeraient une seule branche. On propose donc
   « -2 », « -3 »… en évitant celles que d'autres sessions du même dépôt occupent déjà. C'est une
   PROPOSITION : le champ reste libre, et c'est le premier endroit où l'on met la main. */
function brancheLibreSession(repoId, branche) {
  if (!branche) return '';
  const prises = new Set();
  for (const t of allTasks) {
    for (const tg of t.targets || []) {
      if (!repoId || Number(tg.repo_id) === Number(repoId)) prises.add(tg.branch);
    }
  }
  const base = String(branche).replace(/-\d+$/, '');
  let n = 2;
  while (prises.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/* DUPLIQUER une session de codage. Le formulaire s'ouvre rempli comme pour une modification,
   mais SANS identifiant : enregistrer crée une NOUVELLE session au lieu d'écraser l'originale.
   C'est le geste de qui relance la même consigne sur un autre dépôt, ou repart d'une session
   passée en changeant deux mots — sinon il faut tout retaper, ou pire, modifier l'existante en
   croyant en créer une autre.
   Deux choses ne se copient PAS, et l'écran le dit :
     - la SESSION D'AGENT (« reprendre une session existante ») : la reprendre continuerait la
       conversation de l'originale, alors qu'on en démarre une neuve ;
     - les IMAGES attachées, qui vivent sur disque et appartiennent à la session d'origine. */
async function dupliquerTask(id) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  const d = await api(`/tasks/${id}`);
  const t = d.task;
  editingTaskId = null; launchAfterCreate = false;
  taskKind = t.kind || 'code';
  await loadRepoOptions();
  applyKindToModal(taskKind);
  /* La branche ne se décale QU'EN CODAGE. En exploration, c'est la branche qu'on LIT : la
     décaler pointerait vers une branche qui n'existe pas, et l'exploration échouerait. */
  const decale = taskKind === 'code';
  renderTargetRows((t.targets || []).map((x) => ({
    repo_id: x.repo_id,
    branch: decale ? brancheLibreSession(x.repo_id, x.branch) : x.branch,
    base_branch: x.base_branch,
  })));
  setupTaskJira((t.targets && t.targets[0] && t.targets[0].branch) || '');
  f.prompt.value = t.prompt || '';
  if (f.label) f.label.value = t.label || '';
  if (f.commit_message) f.commit_message.value = t.commit_message || '';
  if (f.auto_push) f.auto_push.checked = !!t.auto_push;
  if (f.ask_questions) f.ask_questions.checked = !!t.ask_questions;
  if (f.notify_jira) f.notify_jira.checked = !!t.notify_jira;
  if (f.review_after) f.review_after.checked = !!t.review_after;
  /* « AUCUN » SE COPIE AUSSI. La duplication reprend le vérificateur de l'original — son
     commentaire le dit — donc un « aucun » délibéré ne doit pas se faire remplacer par le
     vérificateur unique qui couvre les dépôts : même raison qu'à l'édition. */
  await majVerificateursSession(t.verifier_id || '', { autoPick: false });
  /* L'AGENT FAIT PARTIE DE CE QU'ON COPIE. La duplication reprenait tout — prompt, dépôts,
     cases, vérificateur — sauf le profil d'agent : la copie d'un run de l'enquêteur repartait
     en session ordinaire, sans son rôle, ses outils ni ses skills, et rien ne le disait. */
  poserAgentRelu(t);
  if (f.session_id) f.session_id.value = '';
  $('#taskModalTitle').textContent = tr(decale ? 'task.duplicate.title' : 'task.duplicate.title-explore');
  infoDuplication(decale, (d.images && d.images.length) || 0);
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
}

/* Ce que la copie NE reprend pas, dit sous le prompt. Le silence ici se paierait cher : on
   croirait avoir un décalque, et on découvrirait la branche décalée après le lancement. */
function infoDuplication(brancheDecalee, nImages) {
  const bouts = [tr('task.duplicate.info')];
  if (brancheDecalee) bouts.push(tr('task.duplicate.info-branch'));
  if (nImages) bouts.push(tr('task.duplicate.no-images', { n: nImages, count: nImages }));
  $('#taskExistingImgs').textContent = bouts.join(' ');
}

/* Les boutons d'une CRÉATION, quelle que soit la saveur et quel que soit le point d'entrée
   (session neuve, duplication) : un bouton qui changerait de sens selon qu'on crée ou qu'on
   copie serait un piège.

   UN VERBE PAR EFFET, ET LE PARCOURS PRINCIPAL EN UN GESTE. La modale disait « Lancer le
   codage », « Poser la question » et « Créer et lancer » pour un seul et même effet, selon la
   saveur ; et deux saveurs sur quatre n'offraient PAS de lancement du tout — on créait, on
   fermait, on retrouvait la carte dans Dev IA, on cliquait « Lancer ». Deux boutons suffisent,
   les mêmes partout, et ils se lisent l'un contre l'autre :

     — « Créer et lancer »  (primaire)   crée PUIS lance : c'est ce qu'on vient faire ;
     — « Créer sans lancer » (secondaire) crée et s'arrête : préparer maintenant, déclencher
       plus tard reste un besoin légitime, et c'est le seul endroit qui le permet.

   L'ÉDITION n'a ni l'un ni l'autre : elle enregistre (voir les appelants qui posent
   `launchAfterCreate = false` et masquent le secondaire). */
/* L'ACCORDÉON « AVANCÉ » DÉMARRE REPLIÉ. À l'édition, une valeur qu'on ne verrait pas serait
   une surprise : s'il porte un message de commit ou une session d'agent, on le déplie. */
function deplierAvanceSiRempli(f) {
  const av = $('#taskAdvanced');
  if (!av) return;
  const rempli = (f.commit_message && f.commit_message.value) || (f.session_id && f.session_id.value);
  if (rempli) av.open = true;
}
function boutonsCreation() {
  launchAfterCreate = true;
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-play"/></svg>${tr('task.btn.create-run')}`;
  $('#taskSubmitOnly').hidden = false;
}
