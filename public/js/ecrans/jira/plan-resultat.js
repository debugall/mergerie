'use strict';
/* JIRA → PLANS : le RÉSULTAT d'un plan — l'état de l'analyse et ses questions, l'ordre de réalisation
 * (numéro, libellé et état VENUS DE JIRA, la raison venue de l'IA), la spécification fonctionnelle, les compléments par ticket avec
 * leur publication en commentaire, les tickets à créer (à copier), la synthèse, les versions, le
 * suivi, la relecture de Jira et Confluence (les sources à jour, sans tout recommencer) et l'export (md, Word, PDF).
 *
 * PUBLIER, C'EST VOIR AVANT. Le bouton ouvre le texte EXACT qui partira — ligne repère comprise — et
 * la validation le publie tel quel ; republier met à jour le même commentaire. Une version passée se
 * relit, elle ne se publie pas : ce qui part est toujours la version courante. */

let planVersionVue = null;   // { version, result, markdown } quand on relit une version passée
let planPostEnCours = null;  // { id, key, version } : l'aperçu ouvert dans la modale

const etatJira = (x) => (x && x.status
  ? `<span class="jira-plan-state is-${esc(x.statusCategory || 'new')}">${esc(x.status)}</span>` : '');

function ordreHtml(r, tickets) {
  const parCle = new Map((tickets || []).map((x) => [x.key, x]));
  const nouveau = (ref) => (r.nouveaux || []).find((n) => n.ref === ref);
  const lignes = (r.ordre || []).map((o, i) => {
    const tk = parCle.get(o.key);
    const nv = o.nouveau ? nouveau(o.key) : null;
    const cle = o.nouveau
      ? `<span class="jira-chip jira-plan-new">${esc(tr('jira.plan.new-badge'))}</span> ${esc(o.key)}`
      : `<button type="button" class="lien-reglage" data-spec-open="${esc(o.key)}">${esc(o.key)}</button>${tk && tk.url ? ` <a href="${esc(safeUrl(tk.url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jira.plan.open-jira'))}">↗</a>` : ''}`;
    return `<tr data-plan-order="${esc(o.key)}">
        <td class="jira-plan-rank">${i + 1}</td>
        <td class="jira-plan-key">${cle}</td>
        <td>${esc(tk ? tk.summary : (nv ? nv.titre : ''))}</td>
        <td>${o.nouveau ? `<span class="jira-plan-state is-new">${esc(tr('jira.plan.new-status'))}</span>` : etatJira(tk)}</td>
        <td class="jira-plan-why">${esc(o.raison)}</td>
      </tr>`;
  }).join('');
  const places = new Set((r.ordre || []).map((o) => o.key));
  const oublies = (tickets || []).filter((x) => !places.has(x.key) && x.statusCategory !== 'done');
  const finis = (tickets || []).filter((x) => !places.has(x.key) && x.statusCategory === 'done');
  return `<h5>${esc(tr('jira.plan.doc.order'))}</h5>
    <div class="md-tablewrap"><table class="md-table jira-plan-order"><thead><tr>
      <th>#</th><th>${esc(tr('jira.plan.col.ticket'))}</th><th>${esc(tr('jira.plan.col.summary'))}</th><th>${esc(tr('jira.plan.col.status'))}</th><th>${esc(tr('jira.plan.col.why'))}</th>
    </tr></thead><tbody>${lignes}</tbody></table></div>
    ${finis.length ? `<p class="jira-spec-hint jira-plan-done">${esc(tr('jira.plan.doc.done', { keys: finis.map((x) => `${x.key} (${x.status})`).join(', ') }))}</p>` : ''}
    ${oublies.length ? `<p class="jira-spec-hint is-warn">${esc(tr('jira.plan.doc.unplaced', { keys: oublies.map((x) => x.key).join(', ') }))}</p>` : ''}`;
}

/* RELIRE LES SOURCES : Jira toujours, Confluence quand le plan a des pages — le libellé et le budget le disent. */
function boutonRelireHtml(v, enCours) {
  const b = v.budget || {};
  const n = b.jira || 1;
  const titre = b.confluence ? tr('jira.plan.refresh-title-pages', { n, p: b.confluence }) : tr('jira.plan.refresh-title', { n, count: n });
  return `<button type="button" class="btn btn-sm" data-plan-refresh title="${esc(titre)}"${enCours ? ' disabled' : ''}><svg class="ico ico-sm"><use href="#i-refresh"/></svg>${esc(tr(b.confluence ? 'jira.plan.btn.refresh-both' : 'jira.plan.btn.refresh'))}</button>`;
}

/* Une version née d'une relecture de Jira dit ce qui y a changé : c'est sa « demande ». */
function changementsHtml(v, n) {
  const info = (v.versions || []).find((x) => x.version === n);
  if (!info || info.origin !== 'jira' || !info.instruction) return '';
  return `<div class="jira-spec-hint jira-plan-changes"><strong>${esc(tr('jira.plan.changes-title'))}</strong>
      <ul>${info.instruction.split('\n').map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
}

function complementsHtml(v, r, ancienne) {
  const cles = Object.keys(r.complements || {});
  if (!cles.length) return `<h5>${esc(tr('jira.plan.doc.complements'))}</h5><p class="muted">${esc(tr('jira.plan.no-complements'))}</p>`;
  const parCle = new Map((v.tickets || []).map((x) => [x.key, x]));
  const ordre = (r.ordre || []).map((o) => o.key).filter((k) => cles.includes(k));
  const reste = cles.filter((k) => !ordre.includes(k));
  return `<h5>${esc(tr('jira.plan.doc.complements'))}</h5>` + [...ordre, ...reste].map((k) => {
    const post = (v.posts || {})[k];
    let badge = `<span class="jira-chip">${esc(tr('jira.plan.post.none'))}</span>`;
    if (post && post.changed) badge = `<span class="jira-chip jira-spec-unposted">${esc(tr('jira.plan.post.changed', { n: post.posted_version }))}</span>`;
    else if (post) badge = `<span class="jira-chip jira-plan-posted">${esc(tr('jira.plan.post.done', { n: post.posted_version }))}</span>`;
    const tk = parCle.get(k);
    return `<div class="jira-card jira-plan-compl" data-plan-compl="${esc(k)}">
        <div class="jira-plan-compl-head">
          <strong>${esc(k)}</strong> <span>${esc(tk ? tk.summary : '')}</span>
          <span class="spacer"></span>
          ${ancienne ? '' : `${badge}
          <button type="button" class="btn btn-sm${post ? '' : ' btn-primary'}" data-plan-post="${esc(k)}"><svg class="ico ico-sm"><use href="#i-upload"/></svg>${esc(tr(post ? 'jira.plan.btn.post-update' : 'jira.plan.btn.post'))}</button>`}
        </div>
        <div class="md-body">${mdToHtml(r.complements[k])}</div>
      </div>`;
  }).join('');
}

function nouveauxHtml(r) {
  if (!(r.nouveaux || []).length) return '';
  return `<h5>${esc(tr('jira.plan.doc.new'))}</h5>` + r.nouveaux.map((n) => `<div class="jira-card jira-plan-nouveau" data-plan-new="${esc(n.ref)}">
      <div class="jira-plan-compl-head">
        <span class="jira-chip jira-plan-new">${esc(n.ref)}</span> <strong>${esc(n.titre)}</strong>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-plan-copy="${esc(n.ref)}"><svg class="ico ico-sm"><use href="#i-copy"/></svg>${esc(tr('jira.plan.btn.copy'))}</button>
      </div>
      <div class="md-body">${mdToHtml(n.markdown || '')}</div>
    </div>`).join('');
}

function etatAnalyseHtml(v) {
  if (v.status === 'running') {
    return `<p class="muted jira-spec-hint"><span class="spin"></span> ${esc(tr('jira.plan.running'))}
      ${v.task_id ? `<button type="button" class="btn btn-sm" data-spec-task="${v.task_id}">${esc(tr('jira.spec.btn.open-session'))}</button>` : ''}</p>`;
  }
  if (v.status === 'needs_input') {
    const q = v.questions;
    return `<p class="jira-spec-hint is-warn">${esc(tr('jira.plan.needs-input'))}</p>`
      + (q ? questionsForm({ id: q.task_id }, { id: q.target_id, questions: q.questions }, `/tasks/${q.task_id}/targets/${q.target_id}/answer`) : '');
  }
  if (v.status === 'error') return `<p class="jira-spec-hint is-err">${esc(tr('jira.plan.error'))} ${esc(v.last_error || '')}</p>`;
  return '';
}

function rendreResultatPlan() {
  const box = $('#jiraPlanResult');
  if (!box) return;
  const v = PLAN.courant;
  if (!v) { box.innerHTML = ''; return; }
  const etat = etatAnalyseHtml(v);
  if (!v.version) {
    box.innerHTML = etat ? `<section class="jira-plan-section">${etat}</section>` : '';
    return;
  }
  const vue = planVersionVue && planVersionVue.version !== v.version ? planVersionVue : { version: v.version, result: v.result, markdown: v.markdown };
  const ancienne = vue.version !== v.version;
  const r = vue.result || { ordre: [], complements: {}, nouveaux: [], synthese: '' };
  const enCours = v.status === 'running' || v.status === 'needs_input';
  const choix = (v.versions || []).slice().reverse().map((x) => `<option value="${x.version}"${x.version === vue.version ? ' selected' : ''}>${esc(tr('jira.plan.version-opt', { n: x.version, origin: tr(`jira.plan.origin.${x.origin}`), when: fmtDateTime(x.created_at) }))}</option>`).join('');
  box.innerHTML = `<section class="jira-plan-section jira-plan-resultat">
      <div class="jira-plan-result-head">
        ${(v.versions || []).length > 1 ? `<select id="jiraPlanVersion" aria-label="${esc(tr('jira.plan.versions'))}">${choix}</select>` : `<span class="jira-chip">${esc(tr('jira.spec.version', { n: vue.version }))}</span>`}
        ${ancienne ? '' : boutonRelireHtml(v, enCours)}
        <span class="spacer"></span>
        <span class="muted">${esc(tr('jira.plan.export'))}</span>
        <button type="button" class="btn btn-sm" data-plan-export="md">Markdown</button>
        <button type="button" class="btn btn-sm" data-plan-export="docx">Word</button>
        <button type="button" class="btn btn-sm" data-plan-export="pdf">PDF</button>
      </div>
      ${etat}
      ${changementsHtml(v, vue.version)}
      ${ancienne ? `<p class="jira-spec-hint is-warn">${esc(tr('jira.plan.old-version', { n: vue.version }))}</p>` : ''}
      ${ordreHtml(r, v.tickets)}
      ${r.fonctionnel ? `<h5>${esc(tr('jira.plan.doc.functional'))}</h5><div class="jira-card md-body jira-plan-fonctionnel">${mdToHtml(r.fonctionnel)}</div>` : ''}
      ${complementsHtml(v, r, ancienne)}
      ${nouveauxHtml(r)}
      ${r.synthese ? `<h5>${esc(tr('jira.plan.doc.summary'))}</h5><div class="jira-card md-body">${mdToHtml(r.synthese)}</div>` : ''}
      ${ancienne ? '' : `<div class="jira-spec-suivi">
        <textarea id="jiraPlanFollowup" rows="2" placeholder="${esc(tr('jira.plan.followup-ph'))}"${enCours ? ' disabled' : ''}></textarea>
        <button type="button" class="btn btn-sm" data-plan-followup${enCours ? ' disabled' : ''}><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('jira.spec.btn.followup'))}</button>
      </div>`}
    </section>`;
}

/* ---------- Publier un complément ---------- */
function fermerPublication() { $('#jiraPlanPostModal').hidden = true; planPostEnCours = null; }
async function ouvrirPublication(key) {
  const v = PLAN.courant;
  const d = await api(`/jira/plans/${v.id}/post/${encodeURIComponent(key)}`);
  planPostEnCours = { id: v.id, key, version: d.version };
  $('#jiraPlanPostTitle').textContent = tr('jira.plan.post.title', { key });
  $('#jiraPlanPostNote').textContent = tr(d.update ? 'jira.plan.post.note-update' : 'jira.plan.post.note-new', { n: d.posted_version || 0 });
  $('#jiraPlanPostText').textContent = d.text;
  $('#jiraPlanPostOkLbl').textContent = tr(d.update ? 'jira.plan.btn.post-update' : 'jira.plan.btn.post');
  $('#jiraPlanPostModal').hidden = false;
  $('#jiraPlanPostOk').focus();
}
$('#jiraPlanPostCancel') && $('#jiraPlanPostCancel').addEventListener('click', fermerPublication);
$('#jiraPlanPostOk') && $('#jiraPlanPostOk').addEventListener('click', async () => {
  const p = planPostEnCours;
  if (!p) return;
  try {
    const d = await busy($('#jiraPlanPostOk'), () => api(`/jira/plans/${p.id}/post/${encodeURIComponent(p.key)}`, { method: 'POST', body: { version: p.version } }));
    fermerPublication();
    PLAN.courant = d;
    toast(tr(d.updated ? 'jira.plan.post.updated' : 'jira.plan.post.published', { key: p.key }));
    rendreResultatPlan();
  } catch (e) { toast(explainError(e.message), true); }
});
fermerAuFond('#jiraPlanPostModal', fermerPublication, { salissable: false });

/* ---------- Exporter ---------- */
async function exporterPlan(format) {
  const v = PLAN.courant;
  const d = await api(`/jira/plans/${v.id}/export.md`);
  await exporterMarkdown(format, d.title, format === 'md' ? `# ${d.title}\n\n${d.markdown}` : d.markdown, mdToHtml(d.markdown));
}

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'jiraPlanVersion') return;
  const n = Number(e.target.value);
  try {
    planVersionVue = n === PLAN.courant.version ? null : await api(`/jira/plans/${PLAN.courant.id}/versions/${n}`);
    rendreResultatPlan();
  } catch (err) { toast(explainError(err.message), true); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('#jiraPlanResult button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.planPost) { await busy(b, () => ouvrirPublication(d.planPost)); return; }
    if (d.planCopy) {
      const n = ((planVersionVue || PLAN.courant).result.nouveaux || []).find((x) => x.ref === d.planCopy);
      if (n) await copyText(`${n.titre}\n\n${n.markdown || ''}`.trim(), b);
      return;
    }
    if (d.planExport) { await busy(b, () => exporterPlan(d.planExport)); return; }
    if (d.planRefresh !== undefined) {
      const avant = PLAN.courant.prompt;
      const r = await busy(b, () => api(`/jira/plans/${PLAN.courant.id}/refresh`, { method: 'POST' }));
      PLAN.courant = r; planVersionVue = null;
      if (r.job) refreshStatus();
      toast(r.changes.length ? tr('jira.plan.refresh-started', { n: r.changes.length, count: r.changes.length }) : tr('jira.plan.refresh-none'));
      // Le prompt devient périmé ; on ne le redessine que s'il n'a pas de retouche en cours de frappe.
      const champ = $('#jiraPlanPrompt');
      if (!champ || champ.value === avant) rendrePrompt();
      rendreResultatPlan(); sonderPlan(); chargerPlans();
      return;
    }
    if (d.planFollowup !== undefined) {
      const instruction = ($('#jiraPlanFollowup').value || '').trim();
      if (!instruction) { toast(tr('err.spec.instruction-required'), true); return; }
      const r = await busy(b, () => api(`/jira/plans/${PLAN.courant.id}/followup`, { method: 'POST', body: { instruction } }));
      PLAN.courant = r; planVersionVue = null;
      if (r.job) refreshStatus();
      toast(tr('jira.plan.followup-sent'));
      rendreResultatPlan(); sonderPlan(); chargerPlans();
    }
  } catch (err) { toast(explainError(err.message), true); }
});
