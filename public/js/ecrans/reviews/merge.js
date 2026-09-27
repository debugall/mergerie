'use strict';
/* Modales de merge et de création de MR, options, ce que la forge dit. */
// @expose openConvergeModal, openMergeModal, openMrModal
/* ---------- Modales de merge et de création de MR ----------
   Elles remplacent les `confirm()`/`prompt()` natifs : ceux-ci ne permettaient aucune
   option, et une décision irréversible (merge) mérite mieux qu'un « OK / Annuler ».
   Même gabarit que la modale de convergence : titre, intro contextuelle, champs,
   note, puis Annuler + action à droite. */
let mergeCtx = null;

/* LES OPTIONS DE MERGE SONT UNE HABITUDE DE DÉPÔT. « Squasher » et « supprimer la branche »
   se décident une fois par dépôt et ne changent plus : un projet squashe tout, un autre garde
   l'historique. Les merge requests NÉES D'UNE SESSION portent déjà le choix fait à leur
   création (mémorisé côté serveur, `ctx.squash`) ; les autres partaient de zéro à chaque fois.
   On retient donc le dernier choix PAR DÉPÔT, et il ne sert que de proposition — ce que le
   serveur sait de cette merge request-là garde toujours le dernier mot. */
const MERGE_MEMO = 'aidevtools_merge_opts';
const memoMerge = () => { try { return JSON.parse(localStorage.getItem(MERGE_MEMO) || '{}'); } catch { return {}; } };
function memoriserMerge(projet, opts) {
  if (!projet) return;
  try {
    const m = memoMerge(); m[projet] = opts;
    localStorage.setItem(MERGE_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}

/* `ctx` : { url, label, target, forge, project, squash, removeSourceBranch, onDone }.
   `squash`/`removeSourceBranch` pré-cochent d'après ce qui avait été choisi à la
   création de la MR (mémorisé côté serveur), sinon d'après le dernier merge de ce dépôt. */
function openMergeModal(ctx) {
  mergeCtx = ctx;
  $('#mergeModalIntro').textContent = tr('merge.modal.intro', {
    what: ctx.label, target: ctx.target || tr('report.merge.target-fallback'),
  });
  const habitude = (ctx.project && memoMerge()[ctx.project]) || null;
  const defaut = (champ) => (ctx[champ] != null ? !!ctx[champ] : !!(habitude && habitude[champ]));
  $('#mergeSquash').checked = defaut('squash');
  $('#mergeRemoveBranch').checked = defaut('removeSourceBranch');
  const note = $('#mergeModalNote');
  note.hidden = false;
  note.querySelector('span').textContent = tr('merge.modal.warn', { forge: forgeLabel(ctx.forge) });
  /* B2 — LA CASE JIRA. Elle n'existe que si Jira est connecté ET qu'une clé de ticket a été
     trouvée : proposer de « prévenir le ticket » sans ticket serait une case morte. Le
     souvenir est PAR PROJET JIRA (le préfixe de la clé) : une équipe qui veut la transition
     la veut sur tous ses tickets, une autre n'en veut sur aucun. */
  const cleJira = ctx.ticketKey || '';
  const ligneJira = $('#mergeJiraRow');
  if (ligneJira) {
    const visible = !!(cleJira && jiraConfigured);
    ligneJira.hidden = !visible;
    if (visible) {
      const projet = String(cleJira).split('-')[0].toUpperCase();
      $('#mergeJiraLbl').textContent = tr('merge.modal.jira.key', { key: cleJira });
      $('#mergeJira').checked = !!memoJiraMerge()[projet];
    }
  }
  rappelerCeQuOnSait(ctx);
  $('#mergeGo').disabled = false;
  $('#mergeModal').hidden = false;
  demanderEtatFusion(ctx);
}

/* TOP 16 — CE QU'ON SAIT, RAPPELÉ AVANT LE GESTE. Merger est irréversible depuis ici : la
   modale demandait « squash ? branche ? » sans rappeler la note, le verdict, les constats
   bloquants, le fait que le rapport soit périmé, ni les remarques rédigées et jamais envoyées —
   qui partiraient avec la merge request. Tout cela est déjà chargé pour la liste : aucun appel
   de plus, et les MÊMES badges qu'ailleurs (deux rendus d'un même fait finissent par se
   contredire). Rien de connu → rien d'affiché, plutôt qu'une ligne qui rassure à tort. */
function rappelerCeQuOnSait(ctx) {
  const el = $('#mergeModalSavoir');
  if (!el) return;
  el.hidden = true; el.innerHTML = '';
  const toutes = toReviewRows.concat(reportRows);
  const m = ctx.mrId ? toutes.find((x) => x.id === Number(ctx.mrId))
    : toutes.find((x) => `!${x.iid}` === ctx.label && (!ctx.project || x.project === ctx.project));
  if (!m) return;
  const bouts = [
    m.note ? noteBadge(m.note, m) : '',
    badgeSeverites(m),
    verifyBadge(m.verification),
    badgeBrouillons(m),
    m.stale ? `<span class="tag stale">${esc(tr('mr.tag.stale'))}</span>` : '',
  ].filter(Boolean);
  if (!bouts.length) return;
  el.innerHTML = bouts.join('');
  el.hidden = false;
}

/* CE QUE LA FORGE DIT DE CETTE MERGE REQUEST, demandé à l'ouverture.
 *
 * On est à un clic d'un merge : « elle est en conflit » se lit ICI, pas dans le refus qui
 * suivrait. Et quand la merge request vient d'une session de codage, la modale porte de quoi y
 * remédier — le même rattrapage que la ligne du projet.
 *
 * `ctx.check` absent (ou la forge muette) : on ne dit rien plutôt que de rassurer à tort. Une
 * absence de nouvelle n'est pas une bonne nouvelle, mais l'inventer serait pire. */
async function demanderEtatFusion(ctx) {
  const note = $('#mergeConflictNote');
  const bouton = $('#mergeRebase');
  note.hidden = true; bouton.hidden = true;
  if (!ctx.check) return;
  let d;
  try { d = await api(ctx.check); } catch { return; }
  if (mergeCtx !== ctx) return;            // la modale a été fermée entre-temps
  if (!d || d.has_conflicts !== true) return;
  note.querySelector('span').textContent = tr('merge.modal.conflicts', {
    target: d.target_branch || ctx.target || '',
  });
  note.hidden = false;
  if (!d.rebasable) return;
  const base = d.base_branch || d.target_branch;
  bouton.querySelector('span').textContent = tr('task.btn.update-base', { base });
  bouton.title = tr('task.title.update-base', { base });
  bouton.hidden = false;
  bouton.onclick = async () => {
    /* LA MÊME ACTION DEMANDE LA MÊME CHOSE. Depuis la ligne du projet, le rattrapage se
       confirme — il réécrit l'historique de la branche. Partir sans rien demander parce qu'on
       a cliqué depuis la modale serait la même opération avec deux poids : c'est l'endroit du
       clic qui changerait le niveau d'engagement, pas ce qui se passe ensuite. */
    const base = d.base_branch || d.target_branch;
    if (!await confirmDialog({
      title: tr('confirm.update-base.title', { branch: d.branch || '', base }),
      text: tr('confirm.update-base.text', { branch: d.branch || '', base }),
      confirmLabel: tr('task.btn.update-base', { base }),
      danger: false,
    })) return;
    try {
      await busy(bouton, () => api(ctx.rebase, { method: 'POST' }));
      closeMergeModal();
      toast(tr('toast.update-base.started', { branch: d.branch || '' }));
      refreshStatus(); loadTasks();
    } catch (e) { toast(e.message, true); }
  };
}
function closeMergeModal() {
  $('#mergeModal').hidden = true;
  mergeCtx = null;
  /* La remise à zéro de la note et du bouton se fait à l'OUVERTURE (`demanderEtatFusion`, dès
     sa première ligne), pas ici : un seul endroit, celui qui s'exécute forcément. La refaire à
     la fermeture était indétectable — deux mutations distinctes donnaient le même écran, ce qui
     est la définition d'un code mort. Reste ce que la fermeture est seule à pouvoir faire :
     lâcher le gestionnaire, qui retient sinon le contexte de la merge request précédente. */
  $('#mergeRebase').onclick = null;
}
$('#mergeCancel') && $('#mergeCancel').addEventListener('click', closeMergeModal);
fermerAuFond('#mergeModal', closeMergeModal);
$('#mergeGo') && $('#mergeGo').addEventListener('click', async () => {
  const ctx = mergeCtx; if (!ctx) return;
  const b = $('#mergeGo');
  const body = { squash: $('#mergeSquash').checked, removeSourceBranch: $('#mergeRemoveBranch').checked };
  memoriserMerge(ctx.project, body);   // la prochaine fois, ce dépôt repart de ce choix
  const prevenir = !!(ctx.ticketKey && $('#mergeJira') && !$('#mergeJiraRow').hidden && $('#mergeJira').checked);
  if (ctx.ticketKey) memoriserJiraMerge(ctx.ticketKey, prevenir);
  /* Un merge passe par la forge : ça prend une seconde ou deux, et la modale reste à l'écran
     pendant ce temps. Sans indicateur, le bouton paraît n'avoir rien fait — on reclique.
     `busy()` met le compte à rebours ET désactive, et rend la main dans tous les cas. */
  try {
    const r = await busy(b, () => api(ctx.url, { method: 'POST', body }));
    closeMergeModal();
    toast(r.merged ? tr('toast.mr-merged-ok') : tr('toast.merge-requested'));
    /* Le merge A EU LIEU : prévenir Jira est un APRÈS, best-effort. Un Jira injoignable ne
       doit pas faire croire que le merge a échoué — on le dit à part, en rouge, sans toucher
       au message qui précède. */
    if (prevenir && ctx.mrId) {
      try {
        const j = await api(`/mrs/${ctx.mrId}/notify-jira`, { method: 'POST' });
        toast(j.transitioned ? tr('toast.jira-notified-moved', { key: j.key }) : tr('toast.jira-notified', { key: j.key }));
      } catch (err) { toast(tr('toast.jira-notify-failed', { detail: explainError(err.message) }), true); }
    }
    if (ctx.onDone) await ctx.onDone(r);
  } catch (e) { toast(explainError(e.message), true); }
});

let mrCtx = null;
/* `ctx` : { url, body, title, source, target, forge, onDone }. Les deux options sont
   proposées ici aussi : GitLab les retient dès la création ; pour GitHub, dont l'API
   de création ne les accepte pas, elles sont mémorisées et appliquées au merge — la
   note de la modale le dit explicitement. */
function openMrModal(ctx) {
  mrCtx = ctx;
  /* Mode « lot » : mêmes options, mais pas de champ titre — chaque MR reprend le message de
     commit de la session. Demander dix titres à la suite serait la corvée qu'on veut supprimer. */
  const enLot = !!ctx.bulk;
  $('#mrModalIntro').textContent = enLot ? ctx.bulk : tr('mr.modal.intro', { source: ctx.source, target: ctx.target });
  const champ = $('#mrTitle').closest('label') || $('#mrTitle');
  champ.hidden = enLot;
  $('#mrTitle').value = ctx.title || ctx.source || '';
  /* C2 — LA MÊME HABITUDE DE DÉPÔT QUE LA MODALE DE MERGE. « Squasher » et « supprimer la
     branche » se décident une fois par projet et ne changent plus ; la modale de MERGE s'en
     souvenait, celle de CRÉATION forçait les deux à décoché. Deux fenêtres voisines, deux
     réponses différentes à la même question. Une valeur donnée par l'appelant reste
     prioritaire : elle vient d'un choix déjà fait ailleurs. */
  const habitudeMr = (ctx.project && memoMerge()[ctx.project]) || null;
  const dft = (champ) => (ctx[champ] != null ? !!ctx[champ] : !!(habitudeMr && habitudeMr[champ]));
  $('#mrSquash').checked = dft('squash');
  $('#mrRemoveBranch').checked = dft('removeSourceBranch');
  const note = $('#mrModalNote');
  const isGithub = forgeLabel(ctx.forge) === 'GitHub';
  note.hidden = !isGithub;
  if (isGithub) note.querySelector('span').textContent = tr('mr.modal.github-note');
  $('#mrGo').disabled = false;
  $('#mrModal').hidden = false;
  if (!enLot) setTimeout(() => { const f = $('#mrTitle'); if (f) { f.focus(); f.select(); } }, 0);
}
function closeMrModal() { $('#mrModal').hidden = true; mrCtx = null; }
$('#mrCancel') && $('#mrCancel').addEventListener('click', closeMrModal);
fermerAuFond('#mrModal', closeMrModal);
$('#mrGo') && $('#mrGo').addEventListener('click', async () => {
  const ctx = mrCtx; if (!ctx) return;
  const title = $('#mrTitle').value.trim();
  if (!ctx.bulk && !title) { $('#mrTitle').focus(); return; }
  const b = $('#mrGo');
  const body = { ...(ctx.body || {}), ...(ctx.bulk ? {} : { title }),
    squash: $('#mrSquash').checked, removeSourceBranch: $('#mrRemoveBranch').checked };
  // Même raison qu'au merge : l'appel part vers la forge et la modale reste affichée.
  try {
    const r = await busy(b, () => api(ctx.url, { method: 'POST', body }));
    /* Retenu APRÈS le succès, comme au merge : un choix qui n'a rien produit n'est pas une
       habitude. Même clé, même mémoire — les deux fenêtres parlent enfin de la même chose. */
    memoriserMerge(ctx.project, { squash: body.squash, removeSourceBranch: body.removeSourceBranch });
    closeMrModal();
    toast(tr('toast.mr-creee', { iid: r.iid }));
    if (ctx.onDone) await ctx.onDone(r);
  } catch (e) { toast(explainError(e.message), true); }
});

async function openConvergeModal(target) {
  convergeTarget = target;
  // Le bouton est grisé pendant le lancement et n'est réarmé que par le catch : sans
  // ce reset, la 2e convergence d'affilée trouverait un bouton inerte.
  const start = $('#convStart'); if (start) start.disabled = false;
  // Pré-remplit avec les réglages par défaut (surchargeables ici).
  try {
    const c = await api('/config');
    $('#convThreshold').value = c.converge_threshold || '8';
    $('#convPasses').value = c.converge_max_passes || '3';
  } catch { $('#convThreshold').value = '8'; $('#convPasses').value = '3'; }
  /* Titre et phrase d'accroche selon la CIBLE : depuis une session, l'IA va d'abord
     coder et ouvrir la MR — annoncer « Converger la MR » y serait faux. */
  const isTask = target.type === 'task';
  $('#convergeModalTitle').textContent = tr(isTask ? 'converge.modal.title-task' : 'converge.modal.title');
  const what = $('#convergeModalWhat');
  what.textContent = target.label ? tr(isTask ? 'converge.modal.what-task' : 'converge.modal.what', { what: target.label }) : '';
  what.hidden = !target.label;
  // Note spécifique session : l'IA va AUSSI coder et ouvrir la MR.
  const note = $('#convSessionNote'); if (note) note.hidden = !isTask;
  $('#convergeModal').hidden = false;
}
function closeConvergeModal() { $('#convergeModal').hidden = true; convergeTarget = null; }
$('#convCancel') && $('#convCancel').addEventListener('click', closeConvergeModal);
fermerAuFond('#convergeModal', closeConvergeModal);
$('#convStart') && $('#convStart').addEventListener('click', async () => {
  const tgt = convergeTarget; if (!tgt) return;
  const body = { threshold: $('#convThreshold').value, maxPasses: $('#convPasses').value };
  const b = $('#convStart'); b.disabled = true;
  try {
    const url = tgt.type === 'mr' ? `/mrs/${tgt.id}/converge` : `/tasks/${tgt.id}/converge`;
    await avecConfigAgent((accord) => api(url, { method: 'POST', body: { ...body, ...accord } }));
    closeConvergeModal();
    toast(tr('toast.converge-lancee'));
    refreshStatus();
    if (tgt.type === 'task') { navTab('task'); loadTasks(); }
  } catch (e) { b.disabled = false; if (!e.annule) toast(explainError(e.message), true); }
});

