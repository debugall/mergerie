'use strict';
/* LE COCKPIT : ce qui attend l'utilisateur, ce qui tourne, ce qui a abouti — les sessions de codage du jour
   et leur chaîne de validation. Un sous-onglet de Dev IA, relu toutes les trois secondes tant qu'il est affiché : c'est
   l'écran qu'on laisse ouvert pendant que les agents travaillent. Chaque ligne ouvre sa session ; la
   chaîne se lit (et se relance) comme sur la carte de Dev IA. */
// @expose loadCockpit
let cockpitDonnees = null;
let cockpitTimer = null;

function cockpitRaison(r) {
  if (r.quoi === 'base') return tr('cockpit.reason.base', { name: r.nom });
  if (r.quoi === 'branche') return r.cause ? tr('cockpit.reason.branch-diag', { name: r.nom, cause: tr(`task.chaine.diag.cause.${r.cause}`) }) : tr('cockpit.reason.branch', { name: r.nom });
  if (r.quoi === 'scenario') return tr('cockpit.reason.scenario', { detail: r.detail || '' });
  return tr('cockpit.reason.error', { name: r.nom || '', detail: r.detail || '' });
}
function cockpitActions(l, { pret = false } = {}) {
  const enCours = !!l.job || l.status === 'running';
  return `<span class="cockpit-actions">
    ${pret ? `<button type="button" class="btn btn-sm btn-primary" data-cockpit-run="${l.task_id}"><svg class="ico"><use href="#i-play"/></svg>${esc(tr('cockpit.journee.go'))}</button>
    <button type="button" class="btn btn-sm" data-cockpit-edit="${l.task_id}"><svg class="ico"><use href="#i-edit"/></svg>${esc(tr('cockpit.journee.edit'))}</button>` : ''}
    ${enCours ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-cockpit-del="${l.task_id}" data-cockpit-n="${l.n_ticket || 1}" data-cockpit-key="${esc(l.jira_key || '')}" title="${esc(tr('cockpit.delete.title'))}" aria-label="${esc(tr('cockpit.delete.title'))}"><svg class="ico"><use href="#i-trash"/></svg></button>`}
  </span>`;
}
function cockpitLigne(l, { quoi = null, pret = false } = {}) {
  const projets = (l.projets || []).map((p) => `${esc(p.project)} · <code>${esc(p.branch || '')}</code>`).join(' — ');
  let pourquoi = '';
  if (quoi === 'question') pourquoi = tr('cockpit.why.question');
  else if (quoi === 'plan') pourquoi = tr('cockpit.why.plan');
  else if (quoi === 'erreur') pourquoi = tr('cockpit.why.error', { detail: l.detail || '' });
  else if (quoi === 'chaine') pourquoi = (l.raisons || []).map(cockpitRaison).join(' · ');
  const job = l.job ? `<span class="tag to_review">${esc(l.job.en_file ? tr('cockpit.job.queued') : tr('cockpit.job.running'))}</span> <span class="muted cockpit-job">${esc(l.job.message || '')}</span>` : '';
  return `<div class="cockpit-item${quoi ? ` is-${quoi}` : ''}" data-cockpit-task="${l.task_id}">
    <div class="cockpit-item-head">
      <button type="button" class="cockpit-titre" data-cockpit-open="${l.task_id}">#${l.task_id} ${esc(l.label || '')}</button>
      ${job}
      <span class="spacer"></span>
      ${cockpitActions(l, { pret })}
    </div>
    <div class="meta">${projets}</div>
    ${pourquoi ? `<div class="cockpit-pourquoi">${esc(pourquoi)}</div>` : ''}
    ${cockpitWorkflowHtml(l)}
  </div>`;
}
/* LA FRISE : toutes les étapes du déroulé, dans l'ordre — ce qui est fait, ce qui tourne (mise en avant), ce
   qui attend, ce qui viendra ; en pointillé, une passe qui n'aura lieu que si la note reste sous le seuil.
   Une étape de vérification ouvre son rapport. */
const WF_ICONE = { fait: 'check', en_cours: 'refresh', en_file: 'clock', a_toi: 'inbox', echec: 'close' };
function cockpitEtapeLibelle(e) {
  const v = { n: e.n || 0, nom: e.nom || '', projet: e.projet || '' };
  let libelle;
  if (e.cle === 'verif') libelle = tr(e.cote ? `cockpit.wf.verif-${e.cote}` : 'cockpit.wf.verif', v);
  else if (e.cle === 'review' && !e.n) libelle = tr('cockpit.wf.review-0', v);
  else libelle = tr(`cockpit.wf.${e.cle}`, v);
  // Plusieurs projets : chacun a sa boucle de convergence, la frise dit laquelle.
  return e.projet && !e.cle.startsWith('scen-') ? `${e.projet} · ${libelle}` : libelle;
}
function cockpitEtapeDetail(e) {
  const out = [];
  if (e.note != null) out.push(tr('cockpit.wf.note', { note: String(e.note).replace('.', ',') }));
  if (e.essai > 1) out.push(tr('task.chaine.attempt', { n: e.essai }));
  if (e.cle === 'converge-fin' && e.detail) out.push(tr(`cockpit.wf.fin.${e.detail}`));
  else if (e.cle === 'diag' && e.detail) out.push(tr(`task.chaine.diag.cause.${e.detail}`));
  else if ((e.cle === 'scen-ecrire' || e.cle === 'scen-pousser') && e.etat === 'fait' && e.detail) out.push(e.detail);   // les fichiers, le scénario qui couvre, la branche
  else if (e.detail && (e.etat === 'echec' || e.etat === 'a_toi')) out.push(e.detail);
  if (e.projet && e.cle.startsWith('scen-')) out.push(tr('cockpit.wf.in', { projet: e.projet }));
  return out.join(' · ');
}
function cockpitWorkflowHtml(l) {
  const wf = l.workflow;
  if (!wf || !wf.etapes || !wf.etapes.length) return '';
  const etapes = wf.etapes.map((e, i) => {
    const detail = cockpitEtapeDetail(e);
    const titre = `${tr(`cockpit.wf.etat.${e.etat}`)}${e.si ? ` — ${tr('cockpit.wf.si')}` : ''}${detail ? ` — ${detail}` : ''}`;
    const lien = e.verification_id ? ` data-chaine-verif="${e.verification_id}" role="button" tabindex="0"` : '';
    return `<li class="cockpit-wf-etape is-${esc(e.etat)}${e.si ? ' is-si' : ''}${i === wf.courante ? ' is-courante' : ''}" title="${esc(titre)}"${lien}>
      <span class="cockpit-wf-ico">${WF_ICONE[e.etat] ? svgIco(WF_ICONE[e.etat]) : '<span class="cockpit-wf-point"></span>'}</span>
      <span class="cockpit-wf-txt"><span class="cockpit-wf-nom">${esc(cockpitEtapeLibelle(e))}</span>${detail ? `<span class="cockpit-wf-detail">${esc(detail)}</span>` : ''}</span>
    </li>`;
  }).join('');
  const c = wf.courante == null ? null : wf.etapes[wf.courante];
  const ou = c ? tr('cockpit.wf.now', { etape: cockpitEtapeLibelle(c), etat: tr(`cockpit.wf.etat.${c.etat}`) }) : '';
  // Arrêtée sur une étape : « Continuer » fait repartir le déroulé (une question, elle, ouvre la session).
  const k = wf.continuer;
  const continuer = k ? `<button type="button" class="btn btn-sm btn-primary" data-cockpit-continuer="${l.task_id}" data-action="${esc(k.action)}"
      data-targets="${esc((k.targets || []).join(','))}" title="${esc(tr(`cockpit.wf.continue.${k.action}`))}">
      <svg class="ico"><use href="#i-${k.action === 'repondre' ? 'inbox' : 'play'}"/></svg>${esc(tr(k.action === 'repondre' ? 'cockpit.wf.answer' : 'cockpit.wf.continue'))}</button>` : '';
  return `<div class="cockpit-wf" data-cockpit-wf="${l.task_id}">
    ${ou || continuer ? `<div class="cockpit-wf-ou">${esc(ou)} ${continuer}</div>` : ''}
    <ol class="cockpit-wf-etapes">${etapes}</ol>
  </div>`;
}
function cockpitSection(cle, lignes, rendu) {
  return `<section class="cockpit-sec" data-cockpit-sec="${cle}">
    <h3>${esc(tr(`cockpit.sec.${cle}`))} <span class="seg-count">${lignes.length}</span></h3>
    ${lignes.length ? lignes.map(rendu).join('') : `<p class="muted cockpit-vide">${esc(tr(`cockpit.empty.${cle}`))}</p>`}
  </section>`;
}
function renderCockpit(d) {
  const box = $('#cockpitBox');
  if (!box) return;
  box.innerHTML = cockpitSection('a_toi', d.a_toi, (l) => cockpitLigne(l, { quoi: l.quoi }))
    + cockpitSection('pret', d.pret || [], (l) => cockpitLigne(l, { pret: true }))
    + cockpitSection('en_cours', d.en_cours, (l) => cockpitLigne(l))
    + cockpitSection('termine', d.termine, (l) => cockpitLigne(l));
}
async function loadCockpit() {
  try { cockpitDonnees = await api('/cockpit'); } catch (e) { const b = $('#cockpitBox'); if (b) b.innerHTML = errorBox(explainError(e.message)); return; }
  renderCockpit(cockpitDonnees);
  // Relu tant que le sous-onglet est à l'écran ; arrêté dès qu'on en sort.
  if (!cockpitTimer) {
    cockpitTimer = setInterval(() => {
      if (!$('#tab-task.active.vue-cockpit')) { clearInterval(cockpitTimer); cockpitTimer = null; return; }
      if (!document.hidden) api('/cockpit').then((d) => { cockpitDonnees = d; renderCockpit(d); }).catch(() => {});
    }, 3000);
  }
}
$('#cockpitBox') && $('#cockpitBox').addEventListener('click', async (e) => {
  if (!e.target.closest) return;
  const o = e.target.closest('[data-cockpit-open]');
  if (o) { ouvrirSession(Number(o.dataset.cockpitOpen), 'code'); return; }
  const run = e.target.closest('[data-cockpit-run]');
  if (run) {
    try { await busy(run, () => api(`/tasks/${run.dataset.cockpitRun}/run`, { method: 'POST', body: {} })); toast(tr('toast.session-lancee')); }
    catch (err) { toast(explainError(err.message), true); }
    loadCockpit(); refreshStatus();
    return;
  }
  const k = e.target.closest('[data-cockpit-continuer]');
  if (k) { await continuerCockpit(k); return; }
  const ed = e.target.closest('[data-cockpit-edit]');
  if (ed) { openTaskEdit(Number(ed.dataset.cockpitEdit)); return; }
  const del = e.target.closest('[data-cockpit-del]');
  if (del) await supprimerElementCockpit(del);
});
/* Supprimer un élément : la session — et, si elle vient d'un ticket, toutes celles du même ticket. Confirmé dans
   la fenêtre de l'application (jamais `confirm()`), qui dit combien partent. */
async function supprimerElementCockpit(b) {
  const n = Number(b.dataset.cockpitN) || 1;
  const key = b.dataset.cockpitKey;
  const ok = await confirmDialog({
    title: tr('cockpit.delete.title'),
    text: key ? tr('cockpit.delete.text-ticket', { key, n, count: n }) : tr('cockpit.delete.text'),
    confirmLabel: tr('cockpit.delete.ok'),
  });
  if (!ok) return;
  try {
    const r = await api('/cockpit/supprimer', { method: 'POST', body: { task_id: Number(b.dataset.cockpitDel) } });
    toast(tr('cockpit.delete.done', { n: r.supprimees.length, count: r.supprimees.length }));
  } catch (err) { toast(explainError(err.message), true); }
  loadCockpit();
}
/* « CONTINUER » : l'action que le serveur a choisie pour l'étape arrêtée, par la route qui la porte déjà —
   relancer le codage des projets sans commit, pousser, reprendre la convergence, relancer (ou démarrer) la
   chaîne. Une question n'a pas d'action : sa session s'ouvre pour y répondre. */
const ROUTES_CONTINUER = {
  code: (id, b) => [`/tasks/${id}/run`, { targets: (b.dataset.targets || '').split(',').filter(Boolean).map(Number) }],
  push: (id) => [`/tasks/${id}/push-all`, {}],
  converge: (id) => [`/tasks/${id}/converge`, {}],
  chaine: (id) => [`/tasks/${id}/chaine/relancer`, {}],
};
async function continuerCockpit(b) {
  const id = Number(b.dataset.cockpitContinuer);
  const action = b.dataset.action;
  if (action === 'repondre') { ouvrirSession(id, 'code'); return; }
  const route = ROUTES_CONTINUER[action];
  if (!route) return;
  const [url, body] = route(id, b);
  try { await busy(b, () => api(url, { method: 'POST', body })); toast(tr('cockpit.wf.continued')); }
  catch (err) { toast(explainError(err.message), true); }
  loadCockpit(); refreshStatus();
}
