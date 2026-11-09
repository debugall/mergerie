'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » — qui attend quoi, depuis quand. Trois listes de faits — décisions,
   questions, vérifications en échec —, chacune masquée si vide, plafonnée à douze lignes, calculées par le
   serveur sur ce que l'équipe partage déjà. Rien n'est stocké ici au-delà des deux filtres en mémoire ;
   aucune action : chaque ligne mène à la carte (Reviews, Dev IA) où les gestes existent déjà. La liste des
   postes et leur dernière synchro vit dans Réglages → Données partagées : ici, un nombre de postes
   silencieux qui y mène. */
// @expose loadEquipe
let equipeFiltres = { group_id: '', person: '' };
let equipeChargement = 0;

/* Une attente en clair : « 5 j », « 3 h », « 40 min ». */
function attenteCourte(jours) {
  if (jours == null) return tr('team.unknown');
  if (jours >= 1) { const n = Math.floor(jours); return tr('team.wait.days', { n, count: n }); }
  const h = Math.floor(jours * 24);
  if (h >= 1) return tr('team.wait.hours', { n: h, count: h });
  const m = Math.max(1, Math.round(jours * 24 * 60));
  return tr('team.wait.minutes', { n: m, count: m });
}
const depuisOuInconnu = (iso) => (iso ? depuis(iso) : tr('team.unknown'));

function equipeSection(cle, s, lignes, { icon = 'inbox', hint = '', plusDestination = null } = {}) {
  if (!s || !s.items.length) return '';
  return `<section class="equipe-sec" data-equipe-sec="${cle}">
    <h3><svg class="ico"><use href="#i-${icon}"/></svg>${esc(tr(`team.sec.${cle}`))}</h3>
    ${hint ? `<p class="muted equipe-hint">${esc(hint)}</p>` : ''}
    ${lignes}
    ${s.more ? `<div class="equipe-plus"><button type="button" class="croise-go" data-equipe-plus="${esc(plusDestination || cle)}">${esc(tr('team.more', { n: s.more, count: s.more }))}</button></div>` : ''}
  </section>`;
}
/* Une ligne mène quelque part (Reviews, Dev IA, un rapport) : elle le dit à droite, en gris, pour que le
   clic ne soit pas une surprise. */
const equipeLigne = (attrs, titre, meta, { vers = null } = {}) => `<div class="equipe-item" ${attrs}${vers ? ` title="${esc(tr('team.go.title', { where: tr(`team.go.${vers}`) }))}"` : ''}>
    <div class="equipe-item-main"><div class="equipe-item-title">${titre}</div><div class="meta">${meta}</div></div>
    ${vers ? `<span class="equipe-go muted">${esc(tr(`team.go.${vers}`))} ›</span>` : ''}
  </div>`;

function renderEquipe(d) {
  const box = $('#equipeBox');
  if (!d.attached) {
    box.innerHTML = `<p class="equipe-absente">${esc(tr('team.not-attached'))} <button type="button" class="btn btn-sm" data-equipe-reglages>${esc(tr('team.not-attached.go'))}</button></p>`;
    return;
  }
  const c = d.counts || {};
  // Un compteur à zéro n'est pas une nouvelle : il reste, en retrait, pour que la ligne garde sa forme.
  const chiffre = (cle, n) => `<span class="equipe-chiffre${n ? '' : ' zero'}"><b>${n}</b> ${esc(tr(cle, { n, count: n }).replace(/^\d+\s*/, ''))}</span>`;
  /* Les postes silencieux : un nombre, et le chemin vers la liste (Réglages → Données partagées) — pas
     de nom ici, la page parle du travail. */
  const silencieux = c.quiet ? ` · <button type="button" class="croise-go equipe-silencieux" data-equipe-reglages>${esc(tr('team.quiet', { n: c.quiet, count: c.quiet }))}</button>` : '';
  const tete = `<div class="equipe-tete">
      ${chiffre('team.count.decisions', c.decisions || 0)}
      ${chiffre('team.count.questions', c.questions || 0)}
    </div>
    <div class="equipe-sync">${esc(d.sync && d.sync.last
    ? (d.sync.next && Date.parse(d.sync.next) > Date.now()
      ? tr('team.sync.line', { age: depuis(d.sync.last), next: attenteCourte((Date.parse(d.sync.next) - Date.now()) / 86400000) })
      : tr('team.sync.line-nonext', { age: depuis(d.sync.last) }))
    : tr('team.sync.never'))}${d.single_person ? ` · ${esc(tr('team.single'))}` : ''}${silencieux}</div>`;

  const decisions = equipeSection('decisions', d.decisions, (d.decisions.items || []).map((x) => equipeLigne(
    `data-equipe-mr="${x.mr_id}" data-status="${esc(x.status || '')}"`,
    `!${esc(x.iid)} · ${esc(x.project)}${x.title ? ` — ${esc(x.title)}` : ''}`,
    esc(tr(x.reviewer ? 'team.decision.line' : 'team.decision.line-noreviewer', { score: String(x.score).replace('.', ','), author: x.author || tr('team.unknown'), reviewer: x.reviewer || '', wait: attenteCourte(x.waiting_days) })),
    { vers: 'reviews' },
  )).join(''), { icon: 'check', hint: tr('team.sec.decisions.hint', { threshold: d.threshold }) });

  const questions = equipeSection('questions', d.questions, (d.questions.items || []).map((x) => equipeLigne(
    `data-equipe-session="${x.task_id}"`,
    esc(tr('team.question.line', { id: x.task_id, author: x.author || tr('team.unknown'), project: x.project, age: depuisOuInconnu(x.since) })),
    x.question ? `<span class="equipe-question">« ${esc(x.question)} »</span>` : '',
    { vers: 'sessions' },
  )).join(''), { icon: 'alert' });

  const failing = equipeSection('failing', d.failing, (d.failing.items || []).map((x) => equipeLigne(
    `data-equipe-verif="${x.verification_id}"`,
    `!${esc(x.iid)} · ${esc(x.project)}`,
    esc(tr('team.failing.line', { failed_label: tr('team.failing.tests', { n: x.failed, count: x.failed }), author: x.author || tr('team.unknown'), age: depuisOuInconnu(x.at) })),
    { vers: 'report' },
  )).join(''), { icon: 'alert' });

  const corps = decisions + questions + failing;
  box.innerHTML = tete + (corps || `<p class="equipe-vide">${esc(tr('team.empty'))}</p>`);
}

function remplirFiltresEquipe(d) {
  const g = $('#equipeGroupe'); const p = $('#equipePersonne');
  if (g) {
    g.innerHTML = `<option value="">${esc(tr('team.filter.group.all'))}</option>${(d.groups || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
    g.value = equipeFiltres.group_id || '';
    g.hidden = !(d.groups || []).length;
  }
  if (p) {
    p.innerHTML = `<option value="">${esc(tr('team.filter.person.all'))}</option>${(d.people || []).map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}`;
    p.value = equipeFiltres.person || '';
    p.hidden = !d.attached || !(d.people || []).length;
  }
  const s = $('#equipeSync'); if (s) s.hidden = !d.attached;
}

async function loadEquipe() {
  const box = $('#equipeBox');
  if (!box) return;
  const mon = ++equipeChargement;
  box.innerHTML = skeleton(3);
  let d;
  try {
    const q = new URLSearchParams();
    if (equipeFiltres.group_id) q.set('group_id', equipeFiltres.group_id);
    if (equipeFiltres.person) q.set('person', equipeFiltres.person);
    d = await api(`/equipe${q.toString() ? `?${q}` : ''}`);
  } catch (err) { if (mon === equipeChargement) box.innerHTML = `<p class="err">${esc(explainError(err.message))}</p>`; return; }
  if (mon !== equipeChargement) return;
  remplirFiltresEquipe(d);
  renderEquipe(d);
}

$('#equipeGroupe') && $('#equipeGroupe').addEventListener('change', (e) => { equipeFiltres.group_id = e.target.value; loadEquipe(); });
$('#equipePersonne') && $('#equipePersonne').addEventListener('change', (e) => { equipeFiltres.person = e.target.value; loadEquipe(); });
$('#equipeSync') && $('#equipeSync').addEventListener('click', async () => {
  try { await busy($('#equipeSync'), () => api('/data-sync/now', { method: 'POST' })); } catch (err) { toast(explainError(err.message), true); }
  loadEquipe();
});

document.addEventListener('click', (e) => {
  const dans = e.target.closest && e.target.closest('#tab-team');
  if (!dans) return;
  const r = e.target.closest('[data-equipe-reglages]');
  if (r) { navTab('admin'); showAdminSub('datasync'); return; }
  const m = e.target.closest('[data-equipe-mr]');
  if (m) { allerALaMr(Number(m.dataset.equipeMr), m.dataset.status || 'reviewed'); return; }
  const s = e.target.closest('[data-equipe-session]');
  if (s) { ouvrirSession(s.dataset.equipeSession, 'code'); return; }
  const v = e.target.closest('[data-equipe-verif]');
  if (v) { openVerifyReport(Number(v.dataset.equipeVerif)); return; }
  const plus = e.target.closest('[data-equipe-plus]');
  if (plus) {
    const sec = plus.dataset.equipePlus;
    if (sec === 'questions') navTab('task'); else navReviews(sec === 'decisions' ? 'reviewed' : 'to_review');
  }
});
