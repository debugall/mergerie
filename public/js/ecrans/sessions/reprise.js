'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE SUR CE POSTE.
   Sur la ligne de projet d'une session de codage REÇUE du dépôt partagé : « Reprendre sur ce poste »
   (ou « Répondre et reprendre » quand la cible attend une réponse). La modale de session s'ouvre
   pré-remplie et verrouillée sur l'essentiel — dépôt et branche de départ fixés (celle du collègue, à
   sa tête sur la forge), nouvelle branche proposée, mes réglages —, un seul champ à remplir : ma
   consigne. Un encart repliable montre, en entier, le premier message que l'agent recevra : tout
   l'historique de la session d'origine, assemblé mécaniquement par le serveur, puis ma consigne.
   Zéro token avant « Lancer la reprise ». La session d'origine n'est jamais touchée. */

let repriseEnCours = null;   // { taskId, tgId, passes } pendant que la modale est ouverte en reprise

/* Le bouton d'une cible, ou la mention qui dit pourquoi il n'y est pas. */
function boutonReprise(t, tg) {
  const e = tg && tg.reprise;
  if (!e || (!e.ok && e.reason === 'mine')) return '';
  if (e.ok) {
    const cle = e.needs_input ? 'task.reprise.btn.answer' : 'task.reprise.btn';
    return `<button class="btn btn-sm" data-reprise="${tg.id}" data-task="${t.id}" title="${esc(tr('task.reprise.title', { de_who: I18Nrt.deNom(t.author || tr('task.reprise.someone')) }))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr(cle))}</button>`;
  }
  if (e.reason === 'unpushed') return `<span class="t-note reprise-note muted" title="${esc(tr('task.reprise.unpushed.title'))}">${esc(tr('task.reprise.unpushed', { who: t.author || '' }))}</span>`;
  if (e.reason === 'merged') return `<span class="t-note reprise-note muted">${esc(tr('task.reprise.merged', { iid: e.iid || '?' }))}</span>`;
  return '';
}

/* « reprise par Amady (#207) · il y a 10 min » sous le projet repris — plusieurs reprises, plusieurs
   lignes, les plus récentes d'abord ; aucune n'est « la » suite officielle. */
function lignesReprises(t, tg) {
  const liste = (tg && tg.resumed_by) || [];
  if (!liste.length) return '';
  const repondue = tg.status === 'needs_input';
  return `<div class="reprise-par">${liste.map((r) => `<button type="button" class="croise-go" data-reprise-go="${r.id}">${esc(tr('task.reprise.by', { who: r.author || tr('task.reprise.someone'), id: r.id }))}</button> · <span data-when="${esc(r.created_at || '')}">${esc(depuis(r.created_at))}</span>${repondue ? ` · ${esc(tr('task.reprise.answered-in', { id: r.id }))}` : ''}`).join('<br>')}</div>`;
}

/* Sur MA carte : « reprise de la session de Claire (#123) », lien vers sa carte. */
function ligneOrigine(t) {
  const o = t && t.resumed_from;
  if (!o) return '';
  const texte = tr('task.reprise.from', { de_who: I18Nrt.deNom(o.author || tr('task.reprise.someone')), id: o.id != null ? o.id : '?' });
  return `<div class="reprise-origine muted">${o.id != null ? `<button type="button" class="croise-go" data-reprise-go="${o.id}">${esc(texte)}</button>` : esc(texte)}</div>`;
}
const tagReprise = (t) => (t && t.resumed_from ? ` <span class="tag reprise" title="${esc(tr('task.reprise.tag-title'))}">${esc(tr('task.reprise.tag'))}</span>` : '');

/* ---------- La modale ---------- */

const repriseBloc = () => $('#taskReprise');
function fermerReprise() {
  repriseEnCours = null;
  const b = repriseBloc(); if (b) b.hidden = true;
  const f = $('#taskForm');
  if (f) f.querySelectorAll('#taskReposWrap input, #taskReposWrap button').forEach((el) => { el.disabled = false; });
  const only = $('#taskSubmitOnly'); if (only) only.hidden = false;
}

const seqApercuReprise = { n: 0 };
async function majApercuReprise() {
  const r = repriseEnCours;
  if (!r) return;
  const f = $('#taskForm');
  const mon = ++seqApercuReprise.n;
  const corps = {
    consigne: f.prompt.value, reponse: ($('#taskRepriseReponse') || {}).value || null,
    passes_incluses: Number(($('#taskReprisePasses') || {}).value ?? r.passes), diff: !!($('#taskRepriseDiff') && $('#taskRepriseDiff').checked),
  };
  try {
    const d = await api(`/tasks/${r.taskId}/reprise/${r.tgId}/apercu`, { method: 'POST', body: corps });
    if (mon !== seqApercuReprise.n) return;
    $('#taskRepriseApercu').textContent = d.texte;
    $('#taskRepriseTokens').textContent = texteTokensReprise(d, corps.passes_incluses) + (d.tokens > d.seuil ? ` · ${tr('task.reprise.tokens-high')}` : '');
    $('#taskRepriseTokens').classList.toggle('form-info-dirty', d.tokens > d.seuil);
  } catch (e) { if (mon === seqApercuReprise.n) $('#taskRepriseTokens').textContent = explainError(e.message); }
}
const majApercuRepriseBientot = debounce(majApercuReprise, 400);
/* « ~800 tokens · 2/2 passes incluses » : le serveur a déjà écrit le nombre en clair (`tokens_court`),
   jamais « 0 k » pour un historique court. */
const texteTokensReprise = (d, incluses) => tr('task.reprise.tokens', {
  tokens: d.tokens_court != null ? d.tokens_court : String(d.tokens || 0),
  passes: tr('task.reprise.passes-n', { n: incluses, total: d.passes, count: incluses }),
});

async function ouvrirReprise(taskId, tgId) {
  let d;
  try { d = await api(`/tasks/${taskId}/reprise/${tgId}/apercu`, { method: 'POST', body: {} }); }
  catch (e) { toast(explainError(e.message), true); return; }
  if (d.forge && d.forge.absent) { toast(tr('task.reprise.err.absent', { branch: d.target.branch }), true); return; }
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  editingTaskId = null; taskKind = 'code'; forcePushCreation = false;
  await loadRepoOptions();
  applyKindToModal('code');
  renderTargetRows([{ repo_id: d.target.repo_id, branch: d.branch_proposee, base_branch: d.target.branch }]);
  renderCtxRepoRows([]);
  setupTaskJira(d.target.branch);
  await majVerificateursSession('');
  await appliquerDefautsSession(f);
  /* Verrouillé sur l'essentiel : le dépôt et la branche de départ sont ceux de la session reprise ;
     seule la nouvelle branche se modifie. */
  f.querySelectorAll('#taskReposWrap input.t-repo-search, #taskReposWrap input.t-base, #taskReposWrap [data-rmrow], #addTarget').forEach((el) => { el.disabled = true; el.title = tr('task.reprise.locked'); });
  repriseEnCours = { taskId, tgId, passes: d.passes };
  const b = repriseBloc();
  const qs = (d.target.questions || []).filter((q) => q.answer == null || !String(q.answer).trim());
  const deWho = I18Nrt.deNom(d.task.author || tr('task.reprise.someone'));
  b.innerHTML = `<div class="reprise-bandeau">${svgIco('users')} ${esc(tr('task.reprise.banner', { de_who: deWho, id: d.task.id, project: d.target.project, branch: d.target.branch }))}${d.target.commit_sha ? ` · ${esc(tr('task.reprise.last-commit', { sha: String(d.target.commit_sha).slice(0, 7) }))}` : ''}${d.forge && d.forge.ecart ? ` · ${esc(tr('task.reprise.ahead', { n: d.forge.ecart, count: d.forge.ecart }))}` : ''}${d.task.status === 'running' ? ` · ${esc(tr('task.reprise.running', { who: d.task.author || '' }))}` : ''}</div>
    ${qs.length ? `<label><span>${esc(tr('task.reprise.answer-lbl'))}</span><div class="reprise-questions muted">${qs.map((q) => `<div>${esc(q.question || '')}</div>`).join('')}</div><textarea id="taskRepriseReponse" rows="3" placeholder="${esc(tr('task.reprise.answer-ph'))}"></textarea></label>` : ''}
    <details class="reprise-encart"><summary>${esc(tr('task.reprise.preview'))} <span id="taskRepriseTokens" class="muted"></span></summary>
      <div class="reprise-options">
        <label>${esc(tr('task.reprise.passes'))} <input type="range" id="taskReprisePasses" min="0" max="${d.passes}" value="${d.passes}" step="1" /> <output id="taskReprisePassesOut">${d.passes}</output>/${d.passes}</label>
        <label class="inline-check"><input type="checkbox" id="taskRepriseDiff" /> <span>${esc(tr('task.reprise.diff'))}</span></label>
      </div>
      <pre id="taskRepriseApercu" class="reprise-apercu"></pre>
    </details>`;
  b.hidden = false;
  $('#taskRepriseApercu').textContent = d.texte;
  $('#taskRepriseTokens').textContent = texteTokensReprise(d, d.passes);
  $('#taskReprisePasses').addEventListener('input', (e) => { $('#taskReprisePassesOut').textContent = e.target.value; majApercuRepriseBientot(); });
  $('#taskRepriseDiff').addEventListener('change', majApercuReprise);
  const rep = $('#taskRepriseReponse'); if (rep) rep.addEventListener('input', majApercuRepriseBientot);
  f.prompt.placeholder = tr('task.reprise.consigne-ph');
  if (f.label) f.label.value = tr('task.reprise.label', { de_who: deWho, id: d.task.id });
  $('#taskModalTitle').textContent = tr('task.reprise.modal-title');
  $('#taskExistingImgs').textContent = '';
  boutonsCreation();
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-play"/></svg>${esc(tr('task.reprise.launch'))}`;
  $('#taskSubmitOnly').hidden = true;
  showTaskModal();
  f.prompt.focus();
}

/* La soumission en reprise part vers sa propre route — AVANT le gestionnaire ordinaire du formulaire. */
document.addEventListener('submit', async (e) => {
  if (!repriseEnCours || !e.target || e.target.id !== 'taskForm') return;
  e.preventDefault(); e.stopImmediatePropagation();
  const f = e.target;
  const r = repriseEnCours;
  const ligne = readTargetRows()[0] || {};
  const corps = {
    consigne: f.prompt.value, reponse: ($('#taskRepriseReponse') || {}).value || null,
    passes_incluses: Number(($('#taskReprisePasses') || {}).value ?? r.passes), diff: !!($('#taskRepriseDiff') && $('#taskRepriseDiff').checked),
    branch: ligne.branch || '', label: f.label ? f.label.value : '', cli_id: f.cli_id ? f.cli_id.value : '',
  };
  if (!corps.consigne.trim()) { toast(tr('task.reprise.err.consigne'), true); f.prompt.focus(); return; }
  try {
    const d = await busy($('#taskSubmit'), () => api(`/tasks/${r.taskId}/reprise/${r.tgId}`, { method: 'POST', body: corps }));
    fermerReprise();
    closeTaskModal();
    toast(tr('task.reprise.launched', { id: d.id }));
    await loadTasks();
    revelerSession(d.id);
  } catch (err) { toast(explainError(err.message), true); }
}, true);

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-reprise]');
  if (b) { e.stopPropagation(); ouvrirReprise(Number(b.dataset.task), Number(b.dataset.reprise)); return; }
  const go = e.target.closest && e.target.closest('[data-reprise-go]');
  if (go) {
    e.stopPropagation();
    const id = Number(go.dataset.repriseGo);
    revelerSession(id); renderTasks();
    const carte = $(`#taskList [data-task="${id}"]`);
    if (carte) { carte.scrollIntoView({ block: 'center', behavior: 'smooth' }); poserAtterrissage(carte, { id }); }
  }
});
/* Le champ de consigne rafraîchit l'encart ; fermer la modale sort de la reprise. */
document.addEventListener('input', (e) => { if (repriseEnCours && e.target && e.target.id === 'taskPrompt') majApercuRepriseBientot(); });
document.addEventListener('click', (e) => { if (repriseEnCours && e.target.closest && (e.target.closest('#taskCancel') || e.target.closest('#btnNewTask'))) fermerReprise(); });
