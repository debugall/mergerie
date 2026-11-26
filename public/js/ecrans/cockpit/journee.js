'use strict';
/* « LANCER MA JOURNÉE » : des tickets (tapés, ou cochés dans « mes tickets »), une session de codage chacun,
   lancée tout de suite, la chaîne de validation reprise d'une session modèle. Le coût Jira est dit avant
   le clic : un appel par ticket. Un ticket qui ne nomme aucun dépôt revient avec sa raison et un bouton pour
   l'ouvrir dans la fenêtre de session. */
let journeeTickets = [];

const clesTapees = () => String(($('#cockpitKeys') || {}).value || '').toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/g) || [];
function clesJournee() {
  const cochees = $$('#cockpitTickets .cockpit-ticket-pick:checked').map((c) => c.value);
  return [...new Set([...clesTapees(), ...cochees])];
}
function majCoutJournee() {
  const n = clesJournee().length;
  $('#cockpitCout').textContent = tr('cockpit.journee.cost', { n, count: n });
  $('#cockpitLancer').disabled = !n;
}
function ouvrirJournee() {
  $('#cockpitKeys').value = '';
  $('#cockpitTickets').innerHTML = '';
  $('#cockpitTicketsFiltre').hidden = true;
  $('#cockpitResultat').hidden = true;
  const sel = $('#cockpitModele');
  const modeles = (cockpitDonnees && cockpitDonnees.modeles) || [];
  sel.innerHTML = `<option value="">${esc(tr('cockpit.journee.no-model'))}</option>`
    + modeles.map((m) => `<option value="${m.id}">#${m.id} ${esc(m.label)} — ${esc(tr('cockpit.journee.model-n', { n: m.n, count: m.n }))}</option>`).join('');
  if (modeles.length) sel.value = String(modeles[0].id);
  majCoutJournee();
  $('#cockpitJourneeModal').hidden = false;
  $('#cockpitKeys').focus();
}
$('#cockpitJournee') && $('#cockpitJournee').addEventListener('click', ouvrirJournee);
$('#cockpitAnnuler') && $('#cockpitAnnuler').addEventListener('click', () => { $('#cockpitJourneeModal').hidden = true; });
fermerAuFond('#cockpitJourneeModal', () => { $('#cockpitJourneeModal').hidden = true; });
$('#cockpitKeys') && $('#cockpitKeys').addEventListener('input', majCoutJournee);
$('#cockpitTickets') && $('#cockpitTickets').addEventListener('change', majCoutJournee);
$('#cockpitTicketsFiltre') && $('#cockpitTicketsFiltre').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  $$('#cockpitTickets .cockpit-ticket').forEach((r) => { r.hidden = !!q && !r.dataset.texte.includes(q); });
});
$('#cockpitMesTickets') && $('#cockpitMesTickets').addEventListener('click', async (e) => {
  try { journeeTickets = (await busy(e.currentTarget, () => api('/cockpit/mes-tickets'))).tickets || []; }
  catch (err) { toast(explainError(err.message), true); return; }
  $('#cockpitTicketsFiltre').hidden = !journeeTickets.length;
  $('#cockpitTickets').innerHTML = journeeTickets.length
    ? journeeTickets.map((x) => `<label class="cockpit-ticket" data-texte="${esc(`${x.key} ${x.summary || ''}`.toLowerCase())}"><input type="checkbox" class="cockpit-ticket-pick" value="${esc(x.key)}" /> <b>${esc(x.key)}</b> ${esc(x.summary || '')} <span class="muted">${esc(x.status || '')}</span></label>`).join('')
    : `<p class="muted">${esc(tr('cockpit.journee.mine-none'))}</p>`;
  majCoutJournee();
});
$('#cockpitLancer') && $('#cockpitLancer').addEventListener('click', async (e) => {
  const keys = clesJournee();
  if (!keys.length) return;
  let r;
  try { r = await busy(e.currentTarget, () => api('/cockpit/journee', { method: 'POST', body: { keys, modele_id: Number($('#cockpitModele').value) || null } })); }
  catch (err) { toast(explainError(err.message), true); return; }
  toast(tr('cockpit.journee.launched', { n: r.lancees.length, count: r.lancees.length }));
  const res = $('#cockpitResultat');
  res.hidden = !r.ignores.length;
  res.innerHTML = r.ignores.map((i) => `<div class="cockpit-ignore"><b>${esc(i.key)}</b> ${esc(i.raison)}
    <button type="button" class="btn btn-sm" data-cockpit-manuel="${esc(i.key)}">${esc(tr('cockpit.journee.open-manual'))}</button></div>`).join('');
  if (!r.ignores.length) $('#cockpitJourneeModal').hidden = true;
  loadCockpit();
});
// Un ticket sans dépôt nommé : la fenêtre de session, préparée depuis le ticket, pour choisir à la main.
$('#cockpitResultat') && $('#cockpitResultat').addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-cockpit-manuel]');
  if (!b) return;
  $('#cockpitJourneeModal').hidden = true;
  openTaskForJira(b.dataset.cockpitManuel);
});
