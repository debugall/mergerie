'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » — où en est-on, qui attend quoi, depuis quand. Sept listes de faits,
   chacune masquée si vide, plafonnée à douze lignes, calculées par le serveur sur ce que l'équipe partage
   déjà. Rien n'est stocké ici au-delà des deux filtres en mémoire ; aucune action : chaque ligne mène à la
   carte (Reviews, Dev IA) où les gestes existent déjà. Une personne n'est jamais un lien. */
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
const qui = (nom) => esc(nom || tr('team.unknown'));
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
const equipeLigne = (attrs, titre, meta, { inerte = false } = {}) => `<div class="equipe-item${inerte ? ' inerte' : ''}" ${attrs}>
    <div class="equipe-item-main"><div class="equipe-item-title">${titre}</div><div class="meta">${meta}</div></div>
  </div>`;

function renderEquipe(d) {
  const box = $('#equipeBox');
  if (!d.attached) {
    box.innerHTML = `<p class="equipe-absente">${esc(tr('team.not-attached'))} <button type="button" class="btn btn-sm" data-equipe-reglages>${esc(tr('team.not-attached.go'))}</button></p>`;
    return;
  }
  const c = d.counts || {};
  const chiffre = (cle, n) => `<span class="equipe-chiffre"><b>${n}</b> ${esc(tr(cle, { n, count: n }).replace(/^\d+\s*/, ''))}</span>`;
  const tete = `<div class="equipe-tete">
      ${chiffre('team.count.decisions', c.decisions || 0)}
      ${chiffre('team.count.questions', c.questions || 0)}
      ${chiffre('team.count.running', c.running || 0)}
    </div>
    <div class="equipe-sync">${esc(d.sync && d.sync.last
    ? (d.sync.next && Date.parse(d.sync.next) > Date.now()
      ? tr('team.sync.line', { age: depuis(d.sync.last), next: attenteCourte((Date.parse(d.sync.next) - Date.now()) / 86400000) })
      : tr('team.sync.line-nonext', { age: depuis(d.sync.last) }))
    : tr('team.sync.never'))}${d.single_person ? ` · ${esc(tr('team.single'))}` : ''}</div>`;

  const decisions = equipeSection('decisions', d.decisions, (d.decisions.items || []).map((x) => equipeLigne(
    `data-equipe-mr="${x.mr_id}" data-status="${esc(x.status || '')}"`,
    `!${esc(x.iid)} · ${esc(x.project)}${x.title ? ` — ${esc(x.title)}` : ''}`,
    esc(tr(x.reviewer ? 'team.decision.line' : 'team.decision.line-noreviewer', { score: String(x.score).replace('.', ','), author: x.author || tr('team.unknown'), reviewer: x.reviewer || '', wait: attenteCourte(x.waiting_days) })),
  )).join(''), { icon: 'check', hint: tr('team.sec.decisions.hint', { threshold: d.threshold }) });

  const questions = equipeSection('questions', d.questions, (d.questions.items || []).map((x) => equipeLigne(
    `data-equipe-session="${x.task_id}"`,
    esc(tr('team.question.line', { id: x.task_id, author: x.author || tr('team.unknown'), project: x.project, age: depuisOuInconnu(x.since) })),
    `${x.question ? `<span class="equipe-question">« ${esc(x.question)} »</span>` : ''}${x.answered_in ? ` · <span>${esc(tr('team.question.answered', { id: x.answered_in }))}</span>` : ''}`,
  )).join(''), { icon: 'alert' });

  const running = equipeSection('running', d.running, (d.running.items || []).map((x) => equipeLigne(
    `data-equipe-session="${x.task_id}"`,
    esc(tr(x.synced_at ? 'team.running.line' : 'team.running.line-nosync', { author: x.author || tr('team.unknown'), project: x.project, since: attenteCourte(x.running_minutes != null ? x.running_minutes / 1440 : null), synced: x.synced_at ? depuis(x.synced_at) : '' })),
    x.label ? esc(x.label) : '',
  )).join(''), { icon: 'bot' });

  const takeovers = equipeSection('takeovers', d.takeovers, (d.takeovers.items || []).map((x) => equipeLigne(
    `data-equipe-session="${x.task_id}"`,
    esc(tr('team.takeover.line', { from: x.from_task_id, from_author: x.from_author || tr('team.unknown'), to: x.task_id, author: x.author || tr('team.unknown'), when: depuisOuInconnu(x.at) })),
    esc(x.project),
  )).join(''), { icon: 'play' });

  const failing = equipeSection('failing', d.failing, (d.failing.items || []).map((x) => equipeLigne(
    `data-equipe-verif="${x.verification_id}"`,
    `!${esc(x.iid)} · ${esc(x.project)}`,
    esc(tr('team.failing.line', { failed_label: tr('team.failing.tests', { n: x.failed, count: x.failed }), author: x.author || tr('team.unknown'), age: depuisOuInconnu(x.at) })),
  )).join(''), { icon: 'alert' });

  const pairs = equipeSection('pairs', d.pairs, (d.pairs.items || []).map((x) => equipeLigne(
    `data-equipe-paire="${x.a_id},${x.b_id}" data-project="${esc(x.project || '')}"`,
    esc(x.kind === 'stack'
      ? tr('team.pair.stack', { a: x.a_iid, a_author: x.a_author || tr('team.unknown'), b: x.b_iid, b_author: x.b_author || tr('team.unknown') })
      : tr('team.pair.overlap', { a: x.a_iid, a_author: x.a_author || tr('team.unknown'), b: x.b_iid, b_author: x.b_author || tr('team.unknown'), files: tr('team.pair.files', { n: x.shared, count: x.shared }) })),
    esc(x.project || ''),
  )).join(''), { icon: 'branch' });

  const workstations = equipeSection('workstations', d.workstations, (d.workstations.items || []).map((x) => equipeLigne(
    'data-equipe-poste',
    qui(x.name),
    `${esc(x.synced_at ? tr('team.ws.line', { age: depuis(x.synced_at) }) : tr('team.ws.never'))}${x.decisions_awaited ? ` · ${esc(tr('team.ws.awaited', { n: x.decisions_awaited, count: x.decisions_awaited }))}` : ''}${x.quiet ? ` · <span class="quiet">${esc(tr('team.ws.quiet'))}</span>` : ''}`,
    { inerte: true },
  )).join(''), { icon: 'users' });

  const corps = decisions + questions + running + takeovers + failing + pairs;
  box.innerHTML = tete + (corps || `<p class="equipe-vide">${esc(tr('team.empty'))}</p>`) + workstations;
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
  const p = e.target.closest('[data-equipe-paire]');
  if (p) { epinglerMrs(p.dataset.equipePaire.split(',').map(Number)); $('#searchReview').value = p.dataset.project || ''; navReviews('to_review'); return; }
  const plus = e.target.closest('[data-equipe-plus]');
  if (plus) {
    const sec = plus.dataset.equipePlus;
    if (['questions', 'running', 'takeovers'].includes(sec)) navTab('task'); else navReviews(sec === 'decisions' ? 'reviewed' : 'to_review');
  }
});
