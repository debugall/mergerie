'use strict';
/* Vues plein écran : diff d'un projet, réponse d'une exploration, nommer une itération. */
// @expose openPasses
/* ---- Vues plein écran : diff d'un projet, réponse d'une exploration ---- */
/* « Voir le diff » d'un projet de session : on RÉUTILISE le viewer des MR (arbre +
   fichier entier avec les changements en place + navigation), comme le fait déjà
   l'aperçu avant review. Seuls changent la base d'URL et le panneau de gauche, qui
   affiche ici le RETOUR DE L'IA au lieu du rapport de revue. */
async function openTargetDiff(taskId, targetId) {
  const base = `/tasks/${taskId}/targets/${targetId}`;
  let dv;
  try { dv = await api(`${base}/diffview`); }
  catch (e) { toast(explainError(e.message), true); return; }
  let output = '';
  try { output = (await api(`${base}/output`)).output || ''; } catch { /* pas de retour : panneau vide */ }

  split = {
    mrId: null, base, session: true,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],                       // pas de MR → aucun fil à afficher
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('session-mode');
  $('#splitTitle').textContent = `${dv.project} — ${dv.branch}`;
  $('#splitMd').innerHTML = output
    ? mdToHtml(output, IA)
    : `<p class="muted">${esc(tr('task.no-output'))}</p>`;
  renderTree();
  $('#splitView').hidden = false;
  const first = split.files.find((f) => f.changed) || split.files[0];
  if (first) selectFile(first.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}

let currentMd = '';
// Réponse d'une exploration : même vue à itérations que les sessions — chaque question
// de suivi a sa propre entrée, avec la question posée et la réponse obtenue.
const openTaskMd = async (id) => { await openPasses(`/tasks/${id}`); await majBoutonCorriger(id); };

/* « Corriger sur <dépôt> ». L'enquêteur termine son rapport par un bloc qui NOMME le dépôt
   trouvé ; le serveur le résout contre les dépôts connus — un dépôt inventé n'ouvre aucun
   bouton. Le rapport devient alors la demande de la session de codage : c'est lui qui porte
   le chemin, la ligne et l'hypothèse. */
let indiceDepotCourant = null;
async function majBoutonCorriger(taskId) {
  const b = $('#taskMdFix');
  if (!b) return;
  b.hidden = true;
  indiceDepotCourant = null;
  try {
    const hint = await api(`/tasks/${taskId}/repo-hint`);
    if (!hint || !hint.repo_id) return;
    indiceDepotCourant = { ...hint, task_id: taskId };
    $('#taskMdFixLabel').textContent = tr('agents.fix-on', { project: hint.project });
    b.hidden = false;
  } catch { /* pas d'indice : pas de bouton */ }
}

onEl($('#taskMdFix'), 'click', async () => {
  const h = indiceDepotCourant;
  if (!h) return;
  const d = await api(`/tasks/${h.task_id}/md`).catch(() => ({}));
  $('#taskMdView').hidden = true;
  await openTaskModal('code');
  renderTargetRows([{ repo_id: h.repo_id, branch: '' }]);
  $('#taskPrompt').value = `${tr('agents.fix-prompt', { path: h.path || '', line: h.line || '' })}\n\n${d.md || ''}`;
  await majVerificateursSession('');
  $('#taskPrompt').focus();
});
/* Retour de l'agent — même vue plein écran que la réponse d'une exploration, avec un
   sélecteur d'ITÉRATION quand la session en compte plusieurs (comme le sélecteur de
   versions d'un rapport de review). Chaque itération montre le prompt envoyé ET le
   retour obtenu : relire une réponse sans savoir à quelle demande elle répondait
   n'apprend rien. `base` est la racine d'URL (session sur dépôt ou hors dépôt), le
   reste du rendu est commun. */
let passCtx = { base: null };
let passFiltre = '';
async function openPasses(base, n, dossiers = null) {
  try {
    const d = await api(`${base}/passes${n ? `?n=${n}` : ''}`);
    /* La recherche ne survit qu'à l'intérieur d'une même unité : changer d'itération garde le
       filtre (on cherchait quelque chose), ouvrir une autre session repart de zéro. */
    if (passCtx.base !== base) passFiltre = '';
    passCtx = { base, dossiers };
    $('#taskMdTitle').textContent = d.title || '';
    /* Sélecteur de DOSSIER : propre au codage hors dépôt, où une session en couvre plusieurs.
       Comme la liste d'itérations, il disparaît quand il n'y a rien à choisir. */
    const selDir = $('#taskPassDir');
    selDir.hidden = !dossiers || dossiers.length < 2;
    if (!selDir.hidden) {
      selDir.innerHTML = dossiers.map((x) => `<option value="${x.id}" ${base.endsWith(`/${x.id}`) ? 'selected' : ''}>${esc(x.path)}</option>`).join('');
    }
    renderPassList(d.passes || [], d.current ? d.current.n : 0);
    $('#taskMdBody').innerHTML = passBodyHtml(d.current);
    const bouton = $('#taskMdBody [data-passdiff]');
    if (bouton) bouton.addEventListener('click', () => openPassDiff(base, d.current));
    currentMd = d.current ? passMarkdown(d.current) : '';
    $('#taskMdView').hidden = false;
  } catch (e) { toast(explainError(e.message), true); }
}

/* La liste des itérations, à GAUCHE. Chaque entrée porte la demande qui l'a produite : une
   réponse relue sans savoir à quoi elle répondait n'apprend rien, et c'est par la demande
   qu'on retrouve l'itération qu'on cherche — pas par son numéro. */
function renderPassList(passes, courante) {
  const aside = $('#taskPassAside');
  const corps = $('#taskPassAside').closest('.split-body');
  // Une seule itération : rien à choisir, la réponse prend toute la largeur.
  const montrer = passes.length > 1;
  aside.hidden = !montrer;
  corps.classList.toggle('no-list', !montrer);
  if (!montrer) return;

  $('#taskPassTitle').textContent = tr('task.pass.list-title', { n: passes.length });
  /* LES ÉPINGLÉES EN TÊTE. Au-delà de quelques itérations, celle qu'on cherche est presque
     toujours l'une des deux ou trois qui ont compté : les remonter évite de faire défiler.
     Le NUMÉRO reste affiché, donc la chronologie se lit encore — c'est le même choix que les
     pages de notes épinglées. */
  const ordonnees = [...passes].sort((a, b2) => (b2.favori ? 1 : 0) - (a.favori ? 1 : 0) || a.n - b2.n);
  $('#taskPassList').innerHTML = ordonnees.map((p) => {
    const prompt = (p.prompt || '').trim();
    const titre = (p.titre || '').trim();
    /* Une passe ANTÉRIEURE à l'historique n'a pas de ligne en base, donc pas d'identifiant :
       on ne propose ni l'épingle ni le nom plutôt que d'offrir un geste sans effet. */
    const actions = p.id ? `<span class="pass-item-actions">
        <button type="button" class="pass-star${p.favori ? ' on' : ''}" data-passfav="${p.id}"
          title="${esc(tr(p.favori ? 'task.pass.unfav' : 'task.pass.fav'))}">${svgIco('tag')}</button>
        <button type="button" data-passname="${p.id}" title="${esc(tr('task.pass.rename'))}">${svgIco('edit')}</button>
      </span>` : `<span class="pass-item-actions muted" title="${esc(tr('task.pass.legacy-no-name'))}">${svgIco('info')}</span>`;
    return `<div class="pass-item${p.n === courante ? ' active' : ''}${p.favori ? ' fav' : ''}" data-pass="${p.n}">
      <button type="button" class="pass-open" title="${esc(prompt || tr('task.pass.no-prompt'))}">
        <span class="pass-item-head">${esc(tr('task.pass.option', {
    n: p.n, kind: tr(`task.pass.kind.${p.kind}`), date: fmtDateTime(p.created_at),
  }))}${p.cost_usd != null ? ` <span class="muted">· ${esc(fmtCout(p.cost_usd))}</span>` : ''}</span>
        ${titre ? `<span class="pass-item-name">${esc(titre)}</span>` : ''}
        <span class="pass-item-prompt${prompt ? '' : ' muted'}">${esc(prompt || tr('task.pass.no-prompt'))}</span>
      </button>
      ${actions}
    </div>`;
  }).join('');
  $$('#taskPassList .pass-open').forEach((b) => b.addEventListener('click', () => {
    const item = b.closest('.pass-item');
    if (passCtx.base) openPasses(passCtx.base, item.dataset.pass, passCtx.dossiers);
  }));
  $$('#taskPassList [data-passfav]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = b.closest('.pass-item');
    try {
      await api(`/agent-passes/${b.dataset.passfav}`, { method: 'PUT', body: { favori: !item.classList.contains('fav') } });
      if (passCtx.base) openPasses(passCtx.base, courante || undefined, passCtx.dossiers);
    } catch (err) { toast(explainError(err.message), true); }
  }));
  $$('#taskPassList [data-passname]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    nommerPasse(b.closest('.pass-item'), b.dataset.passname, courante);
  }));
  // Le filtre survit au re-rendu : sans cela, choisir une itération rouvrirait la liste entière.
  $('#taskPassSearch').value = passFiltre;
  filtrerPasses();
}

/* NOMMER UNE ITÉRATION, sur place. Le nom remplace le champ le temps de l'écrire : ouvrir une
   modale pour trois mots ferait perdre des yeux la liste dans laquelle on cherchait justement
   à s'y retrouver. Entrée valide, Échap annule — et le nom ne part JAMAIS à l'agent : c'est un
   titre de rangement, écrit pour l'humain qui parcourt la colonne. */
function nommerPasse(item, id, courante) {
  if (item.querySelector('.pass-rename')) return;
  const actuel = (item.querySelector('.pass-item-name') || {}).textContent || '';
  const champ = document.createElement('input');
  champ.className = 'pass-rename';
  champ.value = actuel;
  champ.placeholder = tr('task.pass.title-ph');
  champ.maxLength = 120;
  item.querySelector('.pass-open').after(champ);
  champ.focus(); champ.select();

  let fini = false;
  const finir = async (garder) => {
    if (fini) return;
    fini = true;
    const valeur = champ.value.trim();
    champ.remove();
    if (!garder || valeur === actuel.trim()) return;
    try {
      await api(`/agent-passes/${id}`, { method: 'PUT', body: { titre: valeur } });
      if (passCtx.base) openPasses(passCtx.base, courante || undefined, passCtx.dossiers);
    } catch (e) { toast(explainError(e.message), true); }
  };
  champ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finir(true); }
    if (e.key === 'Escape') { e.preventDefault(); finir(false); }
  });
  champ.addEventListener('blur', () => finir(true));
}

/* Filtrer MASQUE, ne retire pas : l'itération écartée reste à un caractère effacé près. La
   recherche porte sur la demande, sur le NOM qu'on lui a donné et sur l'en-tête (numéro,
   genre, date) — on cherche ce qu'on voit. */
function filtrerPasses() {
  const q = passFiltre.toLowerCase();
  let vus = 0;
  $$('#taskPassList .pass-item').forEach((b) => {
    const ok = !q || b.textContent.toLowerCase().includes(q);
    b.hidden = !ok;
    if (ok) vus += 1;
  });
  $('#taskPassNoMatch').hidden = vus > 0;
}

$('#taskPassSearch') && $('#taskPassSearch').addEventListener('input', debounce((e) => {
  passFiltre = e.target.value.trim();
  filtrerPasses();
}, 120));
// Corps d'une itération : la demande, puis la réponse.
function passBodyHtml(p) {
  if (!p) return `<p class="muted">${esc(tr('task.no-output'))}</p>`;
  const prompt = (p.prompt || '').trim();
  /* CE QUE CETTE ITÉRATION-LÀ A CHANGÉ, juste sous la demande qui l'a produite. Le diff de la
     branche, lui, ne distingue rien : au troisième suivi, les trois lignes qu'on vient de
     demander se cherchent au milieu de deux cents. Une itération qui n'a rien changé le dit
     plutôt que d'offrir un bouton qui ouvrirait une vue vide ; une itération sans mesure (le
     hors-dépôt, une session d'avant) ne montre rien du tout — promettre un diff qu'on n'a pas
     est pire que se taire. */
  const diff = p.has_diff
    ? `<p class="pass-diff-line"><button type="button" class="btn btn-sm" data-passdiff="${p.n}">${svgIco('eye')}<span>${esc(tr('task.pass.diff'))}</span></button></p>`
    : (p.no_change ? `<p class="muted pass-diff-line">${esc(tr('task.pass.no-change'))}</p>` : '');
  return (prompt ? `<h3>${esc(tr('task.pass.prompt'))}</h3><pre class="pass-prompt">${esc(prompt)}</pre>` : '')
    + diff
    + `<h3>${esc(tr('task.pass.answer'))}</h3>`
    + (p.output ? mdToHtml(p.output, IA) : `<p class="muted">${esc(tr('task.no-output'))}</p>`);
}

/* LE DIFF D'UNE SEULE ITÉRATION, dans le viewer de tout le reste : même arbre, même fichier
   entier avec les changements en place. Seule la base d'URL change — les routes de la passe
   ont la même forme que celles d'un projet ou d'une merge request. Le panneau de gauche garde
   la demande et le retour de CETTE itération : un diff relu sans savoir ce qu'on avait demandé
   n'apprend rien de plus que le diff de la branche. */
async function openPassDiff(base, passe) {
  const url = `${base}/passes/${passe.n}`;
  let dv;
  try { dv = await api(`${url}/diffview`); }
  catch (e) { toast(explainError(e.message), true); return; }
  split = {
    mrId: null, base: url, session: true,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('session-mode');
  const quoi = tr('task.pass.diff-title', { n: passe.n, kind: tr(`task.pass.kind.${passe.kind}`) });
  // Hors dépôt, il n'y a pas de branche : le tiret qui l'annonce n'aurait rien à annoncer.
  const ou = dv.branch ? `${dv.project} — ${dv.branch}` : dv.project;
  $('#splitTitle').textContent = `${ou} · ${quoi}`;
  $('#splitMd').innerHTML = passBodyHtml({ ...passe, has_diff: 0, no_change: 0 });
  renderTree();
  $('#splitView').hidden = false;
  const premier = split.files.find((f) => f.changed) || split.files[0];
  if (premier) selectFile(premier.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}
// Version copiable (le bouton Copier donne du Markdown, pas du HTML).
function passMarkdown(p) {
  const prompt = (p.prompt || '').trim();
  return `${prompt ? `## ${tr('task.pass.prompt')}\n\n${prompt}\n\n` : ''}## ${tr('task.pass.answer')}\n\n${p.output || ''}`;
}
const openTargetOutput = (taskId, targetId) => openPasses(`/tasks/${taskId}/targets/${targetId}`);
/* Retour de l'agent d'un codage hors dépôt. On passe la liste des dossiers QUI ONT un retour :
   la vue peut alors basculer de l'un à l'autre sans refermer — utile depuis le bouton de la
   session, qui ne désigne aucun dossier en particulier. */
function openLocalDirOutput(taskId, dirId) {
  const t = localTasks.find((x) => String(x.id) === String(taskId));
  const dossiers = ((t && t.dirs) || []).filter((d) => d.output_path).map((d) => ({ id: d.id, path: d.path }));
  return openPasses(`/local-tasks/${taskId}/dirs/${dirId}`, null, dossiers);
}
$('#taskPassDir') && $('#taskPassDir').addEventListener('change', (e) => {
  const base = String(passCtx.base || '');
  openPasses(base.replace(/\/dirs\/\d+$/, `/dirs/${e.target.value}`), null, passCtx.dossiers);
});
$('#taskMdClose').addEventListener('click', () => { $('#taskMdView').hidden = true; });
$('#taskMdCopy').addEventListener('click', () => copyText(currentMd, $('#taskMdCopy')));

