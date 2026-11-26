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
function cockpitLigne(l, { quoi = null } = {}) {
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
    </div>
    <div class="meta">${projets}</div>
    ${pourquoi ? `<div class="cockpit-pourquoi">${esc(pourquoi)}</div>` : ''}
    ${chaineHtml({ id: l.task_id, chaine: l.chaine })}
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
$('#cockpitBox') && $('#cockpitBox').addEventListener('click', (e) => {
  const o = e.target.closest && e.target.closest('[data-cockpit-open]');
  if (o) ouvrirSession(Number(o.dataset.cockpitOpen), 'code');
});
// « Relancer » d'une chaîne (le geste de la carte de session) : le cockpit se relit aussitôt.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#taskCockpit [data-chaine-relancer]')) setTimeout(() => { if ($('#tab-task.active.vue-cockpit')) loadCockpit(); }, 0);
});
