'use strict';
/* Le front de Jenkins Teams Notify : évalué dans une portée privée avec le kit `window.mergerie` (docs/plugins/UI.md).
   Trois choses : l'état de la session (pastille de l'onglet + section du brief), le journal des envois,
   et le formulaire de Réglages avec ses trois gestes (test, connexion, oublier la session). */
const TN_API = '/plugins/jenkins-teams-notify';
const TN = { etat: null, minuteur: null };
const TN_CHAMPS = ['team_link', 'channel_name', 'session_mode', 'cdp_url', 'headless', 'job_filter',
  'template_started', 'template_success', 'template_failure', 'template_aborted', 'retention_days'];

/* ---------- L'état : relu au chargement, toutes les minutes, et à chaque geste ---------- */
async function tnCharger() {
  try { TN.etat = await api(`${TN_API}/status`); } catch { TN.etat = null; }
  const requise = !!TN.etat && TN.etat.state === 'connexion-requise';
  ui.setBadge('jenkins-teams-notify', requise ? { warn: 1, warnTip: tr('jenkins-teams-notify.badge.login') } : { warn: 0 });
  notes.refreshBrief();
  return TN.etat;
}

/* ---------- Le brief : une section, seulement quand la connexion est requise ---------- */
ui.onBriefSection('connexion', () => {
  if (!TN.etat || TN.etat.state !== 'connexion-requise') return '';
  return `<div class="brief-item">
      <div class="brief-item-main"><div class="brief-item-title">${esc(tr('jenkins-teams-notify.brief.body'))}</div></div>
      <button type="button" class="btn btn-primary" data-tn-open>${esc(tr('jenkins-teams-notify.brief.open'))}</button>
    </div>`;
});
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-tn-open]')) { navTab('admin'); settings.showTab('jenkins-teams-notifycfg'); }
});

/* ---------- Ce que l'écran dit de l'état ---------- */
function tnLignesEtat(s) {
  if (!s) return [];
  const lignes = [];
  const ligne = (texte, classe = '') => lignes.push(`<div class="tn-line ${classe}">${esc(texte)}</div>`);
  if (s.demo) ligne(tr('jenkins-teams-notify.state.demo'));
  if (s.busy) ligne(tr(`jenkins-teams-notify.state.busy.${s.busy}`), 'tn-warn');
  else ligne(tr(`jenkins-teams-notify.state.${s.state}`), s.state === 'connexion-requise' ? 'tn-bad' : '');
  if (!s.jenkins.present) ligne(tr('jenkins-teams-notify.jenkins.absent'), 'tn-warn');
  else if (!s.jenkins.configured) ligne(tr('jenkins-teams-notify.jenkins.unconfigured'), 'tn-warn');
  for (const p of s.problems || []) ligne(tr(`jenkins-teams-notify.problems.${p.champ}`, { erreur: p.erreur }), 'tn-bad');
  if (!s.scriptPresent) ligne(tr('jenkins-teams-notify.script.missing'), 'tn-bad');
  return lignes;
}

/* ---------- Le journal ---------- */
function tnJournalHtml(rows) {
  if (!rows.length) return `<p class="muted">${esc(tr('jenkins-teams-notify.log.empty'))}</p>`;
  const cle = (famille, v) => { const k = `jenkins-teams-notify.${famille}.${v}`; const t = tr(k); return t === k ? v : t; };
  return `<table class="tn-log"><thead><tr>${['at', 'job', 'event', 'status', 'error'].map((c) => `<th>${esc(tr(`jenkins-teams-notify.log.col.${c}`))}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(fmtDateTime(r.at))}</td><td>${esc(r.job || '')}</td><td>${esc(cle('event', r.event))}</td>
      <td class="tn-st-${esc(r.status)}">${esc(cle('status', r.status))}</td><td class="tn-err">${esc(r.error || '')}</td></tr>`).join('')}
    </tbody></table>`;
}
async function tnAfficherJournal(boite) {
  if (!boite) return;
  try { boite.innerHTML = tnJournalHtml((await api(`${TN_API}/log?limit=100`)).rows || []); }
  catch (e) { boite.innerHTML = errorBox(explainError(e.message)); }
}

/* ---------- L'onglet ---------- */
async function tnRendreOnglet() {
  const s = await tnCharger();
  const etat = $('#tnTabStatus');
  if (etat) etat.innerHTML = tnLignesEtat(s).join('');
  tnAfficherJournal($('#tnTabLog'));
}
ui.onTabOpen('jenkins-teams-notify', tnRendreOnglet);

/* ---------- Réglages : formulaire, gestes, journal ---------- */
function tnMajMode() {
  const f = $('#tnForm');
  if (!f) return;
  const ligneCdp = $('#tnCdpRow');
  if (ligneCdp) ligneCdp.hidden = f.session_mode.value !== 'cdp';
  f.headless.disabled = f.session_mode.value === 'cdp';
}
async function tnRendreReglages() {
  const f = $('#tnForm');
  if (!f) return;
  try {
    const v = await ui.settings.get('jenkins-teams-notify');
    for (const k of TN_CHAMPS) {
      if (!f.elements[k]) continue;
      if (f.elements[k].type === 'checkbox') f.elements[k].checked = !!v[k]; else f.elements[k].value = v[k] == null ? '' : v[k];
    }
    // Les modèles vides montrent le modèle par défaut de la langue, en grisé.
    for (const t of ['started', 'success', 'failure', 'aborted']) f.elements[`template_${t}`].placeholder = tr(`jenkins-teams-notify.template.${t}`);
  } catch (e) { toast(explainError(e.message), true); }
  tnMajMode();
  await tnRafraichirReglages();
}
/* L'état de l'écran de Réglages. Pendant qu'un geste long tourne (un test, une connexion), on le suit de près. */
async function tnRafraichirReglages() {
  clearTimeout(TN.minuteur);
  const s = await tnCharger();
  const boite = $('#tnStatus');
  if (boite) boite.innerHTML = tnLignesEtat(s).join('');
  for (const id of ['tnTest', 'tnSaveTest', 'tnLogin', 'tnReset']) { const b = $(`#${id}`); if (b) b.disabled = !!(s && s.busy); }
  await tnAfficherJournal($('#tnLog'));
  if (s && s.busy && $('#tnForm') && $('#sub-jenkins-teams-notifycfg').classList.contains('active')) TN.minuteur = setTimeout(tnRafraichirReglages, 1500);
}
ui.onSettingsTab('jenkins-teams-notifycfg', tnRendreReglages);

/* Enregistrer le formulaire. Rend vrai si c'est fait : un test ou une connexion n'ont de sens que sur CE qu'on voit à l'écran. */
async function tnEnregistrer() {
  const f = $('#tnForm');
  if (!f) return false;
  const patch = {};
  for (const k of TN_CHAMPS) if (f.elements[k]) patch[k] = f.elements[k].type === 'checkbox' ? f.elements[k].checked : f.elements[k].value;
  const info = $('#tnInfo');
  try {
    await busy(f.querySelector('button[type=submit]'), () => ui.settings.save('jenkins-teams-notify', patch));
    if (info) info.textContent = tr('jenkins-teams-notify.saved');
    return true;
  } catch (err) { if (info) info.textContent = ''; toast(explainError(err.message), true); return false; }
}
document.addEventListener('submit', async (e) => {
  if (!e.target || e.target.id !== 'tnForm') return;
  e.preventDefault();
  if (await tnEnregistrer()) await tnRafraichirReglages();
});
document.addEventListener('change', (e) => { if (e.target && e.target.form && e.target.form.id === 'tnForm' && e.target.name === 'session_mode') tnMajMode(); });

/* Un geste : on l'envoie, la route rend la main aussitôt, et l'écran suit l'état jusqu'à la fin. */
async function tnGeste(chemin) {
  if (!(await tnEnregistrer())) return;   // on teste ce qui est à l'écran, pas la version d'hier
  try {
    await api(`${TN_API}${chemin}`, { method: 'POST' });
    toast(tr('jenkins-teams-notify.toast.started'));
  } catch (err) { toast(explainError(err.message), true); }
  await tnRafraichirReglages();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('#tnTest, #tnSaveTest, #tnLogin, #tnReset');
  if (!b) return;
  if (b.id === 'tnTest' || b.id === 'tnSaveTest') await tnGeste('/test');
  else if (b.id === 'tnLogin') await tnGeste('/login');
  else if (await confirmDialog({ title: tr('jenkins-teams-notify.reset.title'), text: tr('jenkins-teams-notify.reset.text'), confirmLabel: tr('jenkins-teams-notify.btn.reset') })) {
    try { await api(`${TN_API}/session/reset`, { method: 'POST' }); toast(tr('jenkins-teams-notify.toast.reset')); } catch (err) { toast(explainError(err.message), true); }
    await tnRafraichirReglages();
  }
});

/* ---------- La pastille et le brief restent justes sans ouvrir l'écran ---------- */
tnCharger();
setInterval(tnCharger, 60_000);
