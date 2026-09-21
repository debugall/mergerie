'use strict';
/* Captures d'un suivi, le suivi en attente, relancer n'est pas continuer. */
// @expose loadTasks, taskMatches
/* ---- Captures collées dans une demande de suivi ----
   Une remarque de suivi montre souvent quelque chose : une capture de l'écran cassé vaut dix
   lignes de description. Les images vivent ICI, hors du DOM, parce qu'une carte de session en
   cours se re-rend toutes les secondes et demie — dans le DOM, la capture disparaîtrait sous
   les doigts. Elles ne partent qu'avec l'envoi du suivi : un brouillon n'emporte que du texte
   (c'est ce que sait stocker le serveur), et on le DIT plutôt que de les perdre en silence. */
const suiviImages = new Map();
const cleFormSuivi = (form) => {
  const k = CLES_FORM.find((x) => form.dataset[x]);
  return k ? `${k}:${form.dataset[k]}` : '';
};
const PJ_ACCEPT = 'image/*,.pdf,.txt,.md,.csv,.tsv,.json,.yml,.yaml,.xml,.html,.log,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf';
const suiviCapturesHtml = () => `<div class="followup-imgs">
    <button type="button" class="btn btn-sm" data-followpick>${svgIco('clip')}${tr('task.lbl.add-piece')}</button>
    <span class="muted">${esc(tr('task.followup.paste-hint'))}</span>
    <input type="file" class="followup-file" accept="${PJ_ACCEPT}" multiple hidden />
    <span class="followup-prev"></span>
  </div>`;

function renderSuiviPreviews(form) {
  const box = form.querySelector('.followup-prev');
  if (!box) return;
  const imgs = suiviImages.get(cleFormSuivi(form)) || [];
  box.innerHTML = imgs.map((p, i) => (estImage(p)
    ? `<span class="task-prev"><img src="${esc(safeImg(p.data))}" title="${esc(p.name)}" />`
      + `<button type="button" data-rmfollowimg="${i}" title="${esc(tr('task.piece.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button></span>`
    : `<span class="task-prev task-prev-doc" title="${esc(p.name)}">${svgIco('doc')}<span class="task-prev-nom">${esc(p.name)}</span>`
      + `<button type="button" data-rmfollowimg="${i}" title="${esc(tr('task.piece.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button></span>`)).join('');
  $$('[data-rmfollowimg]', box).forEach((b) => b.addEventListener('click', () => {
    const liste = suiviImages.get(cleFormSuivi(form)) || [];
    liste.splice(Number(b.dataset.rmfollowimg), 1);
    if (liste.length) suiviImages.set(cleFormSuivi(form), liste); else suiviImages.delete(cleFormSuivi(form));
    renderSuiviPreviews(form);
  }));
}

async function ajouterSuiviImages(form, files) {
  const cle = cleFormSuivi(form);
  if (!cle) return;
  const liste = suiviImages.get(cle) || [];
  for (const f of files) {
    if (!f) continue;
    liste.push({ name: nomDeCapture(f, liste.length + 1), data: await readFileDataURL(f) });
  }
  if (liste.length) suiviImages.set(cle, liste);
  renderSuiviPreviews(form);
}

/* Coller marche partout où l'on écrit un suivi. La modale de session a son propre collage :
   elle passe devant, sinon un Ctrl+V sur une carte visible en arrière-plan attacherait la
   capture à la mauvaise chose. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-followpick]');
  if (!b) return;
  const f = b.closest('.followup').querySelector('.followup-file');
  if (f) f.click();
});
document.addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('followup-file')) return;
  ajouterSuiviImages(e.target.closest('.followup'), [...e.target.files]);
  e.target.value = '';       // re-choisir le même fichier doit redéclencher l'événement
});
document.addEventListener('paste', (e) => {
  if (!$('#taskModal').hidden) return;
  const form = document.activeElement && document.activeElement.closest && document.activeElement.closest('.followup');
  if (!form) return;
  const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (imgs.length) { e.preventDefault(); ajouterSuiviImages(form, imgs); }
});

/* LE SUIVI EN ATTENTE. Écrit pendant que la session travaille, il reste affiché sur la carte
   tant qu'on ne l'a pas envoyé — sinon on oublie qu'on en a un. Le bouton d'envoi est là dès
   le premier instant, désactivé, pour qu'on sache où il sera. */
/* La case qui arme le suivi. Décochée par défaut, et sur la MÊME ligne que le texte : c'est au
   moment où on écrit la remarque qu'on sait si elle mérite de partir toute seule. */
/* …ou une DATE. Une session de dépôt ou hors dépôt peut faire partir son suivi à une heure
   fixée (`sansDate` pour la question libre, qui ne se programme pas). Une date remplace la case :
   un suivi n'a qu'un armement, et le serveur y veille aussi. */
const autoSuiviCase = (t, sansDate = false) => `<label class="inline-check followup-auto-line"><input type="checkbox" class="followup-auto"${t.followup_auto ? ' checked' : ''} />
    <span>${tr('task.followup.auto')}</span></label>${sansDate ? '' : `
  <label class="inline-check followup-at-line"><span>${tr('task.followup.at')}</span> <input type="datetime-local" class="followup-at" step="60" value="${versDatetimeLocal(t.followup_at)}" /></label>`}`;

function suiviBlock(t, pre) {
  if (!t.followup_draft) return '';
  const enCours = t.status === 'running';
  const arme = t.followup_at ? 'scheduled' : (t.followup_auto ? 'auto' : '');
  const titre = { scheduled: 'task.followup.draft-scheduled', auto: 'task.followup.draft-auto' }[arme] || 'task.followup.draft';
  const indice = arme === 'scheduled' ? tr('task.followup.draft-hint-scheduled', { when: esc(fmtDateTime(t.followup_at)) })
    : tr(arme === 'auto' ? 'task.followup.draft-hint-auto' : 'task.followup.draft-hint');
  return `<div class="followup-draft${arme ? ' is-auto' : ''}">
    <div class="followup-draft-head">${svgIco(arme === 'scheduled' ? 'clock' : 'repeat')}<span>${tr(titre)}</span>
      <span class="muted">${indice}</span></div>
    <div class="followup-draft-text">${esc(t.followup_draft)}</div>
    <div class="followup-draft-actions">
      <button class="btn btn-sm" data-${pre}followedit="${t.id}">${tr('ui.edit')}</button>
      <button class="btn btn-sm btn-danger" data-${pre}followdrop="${t.id}">${tr('ui.delete')}</button>
      <button class="btn btn-sm btn-primary" data-${pre}followsend="${t.id}"${enCours ? ' disabled' : ''} title="${esc(tr(enCours ? 'task.title.send-followup-wait' : 'task.title.send-followup'))}">${tr('task.btn.send-followup')}</button>
    </div>
  </div>`;
}

/* Enregistrer, corriger, supprimer, envoyer : les quatre gestes du suivi, identiques pour une
   session de dépôt et pour une session hors dépôt — seule la route change. */
async function enregistrerSuivi(b, route) {
  const form = b.closest('.followup');
  const field = form.querySelector('.followup-text');
  const instruction = field.value.trim();
  if (!instruction) { supprimerSuivi(b, route); return; }   // effacer le texte, c'est supprimer
  /* Un brouillon ne garde QUE du texte — c'est ce que le serveur sait stocker. Les captures
     restent attachées au formulaire ouvert et partiront avec l'envoi ; on le dit, parce qu'une
     image qu'on croit enregistrée et qui disparaît au rechargement est une perte silencieuse. */
  if ((suiviImages.get(cleFormSuivi(form)) || []).length) toast(tr('task.followup.draft-no-image'));
  const caseAuto = form.querySelector('.followup-auto');
  const champAt = form.querySelector('.followup-at');
  let at = null;
  if (champAt && champAt.value) {
    const d = new Date(champAt.value);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) { toast(tr('err.programmation.date-passee'), true); return; }
    at = d.toISOString();
  }
  try {
    await busy(b, () => api(route, { method: 'PUT', body: { instruction, auto: !!(caseAuto && caseAuto.checked) && !at, ...(champAt ? { at } : {}) } }));
    /* On referme AVANT de recharger : ouvert, `captureTaskForms` le rouvrirait au rendu
       suivant et on croirait que l'enregistrement n'a rien fait. */
    form.hidden = true;
    toast(tr('toast.suivi-enregistre'));
    loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}
async function supprimerSuivi(b, route) {
  try {
    await busy(b, () => api(route, { method: 'PUT', body: { instruction: '' } }));
    const form = b.closest('.followup');
    if (form) form.hidden = true;
    toast(tr('toast.suivi-supprime'));
    loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}
// Corps vide EXPRÈS : c'est le serveur qui reprend le suivi enregistré et l'efface, en un geste.
async function envoyerSuivi(b, route) {
  try {
    await busy(b, () => api(route, { method: 'POST', body: {} }));
    toast(tr('toast.lance'));
    refreshStatus(); loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}

/* RELANCER N'EST PAS CONTINUER. Une relance renvoie le PROMPT INITIAL : tout ce qu'on a demandé
   depuis — les suivis, les réponses aux questions — n'est pas rejoué, et l'agent repart du début
   sur du travail déjà fait. Le bouton voisine avec ceux qu'on utilise vraiment souvent, et le clic
   de trop coûte une session d'IA entière. On ne demande donc rien tant que rien n'a tourné : la
   toute première mise en route reste un seul clic. */
async function confirmerRelance(dejaLance, cle = 'confirm.rerun') {
  if (!dejaLance) return true;
  return confirmDialog({ title: tr('confirm.rerun.title'), text: tr(cle), confirmLabel: tr('task.btn.rerun') });
}

// Le bouton qui ouvre le formulaire de suivi : « préparer » tant que ça tourne, « corriger » après.
/* LE NOMBRE D'ITÉRATIONS DÉJÀ FAITES, dans le libellé même du bouton (« Envoyer un suivi (2) »).
   Il ne se lisait qu'en ouvrant « Retour de l'IA » — avant de demander un énième suivi, savoir
   qu'on en est à la sixième passe se lit désormais sans un clic de plus. Absent (jamais
   lancée) : rien ne s'ajoute, un « (0) » se lirait comme une mesure plutôt que comme une absence. */
const followBtn = (t, attr, titreFini, libelleFini = 'task.btn.request-fix') => {
  const enCours = t.status === 'running';
  const n = t.passes_count || 0;
  const libelle = tr(enCours ? 'task.btn.draft-followup' : libelleFini);
  return `<button class="btn" data-${attr}="${t.id}" title="${esc(tr(enCours ? 'task.title.draft-followup' : titreFini))}"><svg class="ico"><use href="#i-repeat"/></svg>${libelle}${n ? ` (${n})` : ''}</button>`;
};

/* Le rang du dernier chargement lancé. Deux appels peuvent être en vol — un clic et un
   rafraîchissement de fin de job, par exemple — et rien ne garantit qu'ils reviennent dans
   l'ordre. Sans ce garde, la réponse la plus ANCIENNE écrasait la plus récente : on répondait
   à l'IA, la session repartait, et la boîte de questions se réaffichait intacte quelques
   dizaines de millisecondes plus tard. Même parade que pour la palette. */
let tasksSeq = 0;
async function loadTasks() {
  const seq = ++tasksSeq;
  /* Y a-t-il une équipe, et qui suis-je ? Lu UNE fois (mémorisé), et avant le rendu : les cartes
     décident sans attendre s'il faut proposer « partager » et « supprimer » ou « ranger ». */
  await partageActif();
  try {
    const [tasks, locals, asks] = await Promise.all([
      api('/tasks'), api('/local-tasks').catch(() => []), api('/questions').catch(() => []),
    ]);
    if (seq !== tasksSeq) return;          // un chargement plus récent a déjà répondu
    allTasks = tasks; localTasks = locals; questions = asks;
  } catch (e) { if (seq === tasksSeq) $('#taskList').innerHTML = errorBox(e.message); return; }
  listeChargee = true;
  renderTasks();
  loadLots();
}

// Texte de recherche courant (sessions de codage, hors dépôt et exploration partagent
// le même champ : une seule liste est visible à la fois).
function taskQuery() {
  const el = $('#taskSearch');
  return (el && el.value ? el.value : '').toLowerCase().trim();
}
// Une session correspond si le texte apparaît dans son prompt, son message de commit,
// ou dans l'un de ses projets/branches (ou dossiers, hors dépôt).
function taskMatches(t, q, units) {
  if (!q) return true;
  /* `answer_head` : le chapeau de la réponse, servi avec chaque session et affiché sur la
     carte. Il n'entrait pas dans la recherche — on cherchait « mutex » en se souvenant de la
     RÉPONSE, et la session ne sortait pas alors que le mot était sous les yeux. */
  const hay = [t.label, t.prompt, t.commit_message, t.answer_head, ...(units || [])].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

