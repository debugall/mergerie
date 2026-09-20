'use strict';
/* Programmer une session : une date change le bouton, les deux champs (date + heure) en ISO. */
/* UNE DATE CHANGE LE BOUTON. « Créer et lancer » avec une date remplie lancerait… plus tard :
   le bouton le dit (« Créer et programmer ») et « Créer sans lancer » disparaît — avec une date,
   la question ne se pose plus. Effacer la date rend les boutons d'avant. À l'édition, rien ne
   bouge : « Enregistrer » couvre la date comme le reste. */
function majBoutonProgrammation() {
  const jour = $('#taskScheduleDate');
  const heure = $('#taskScheduleTime');
  const btn = $('#taskSubmit');
  const seul = $('#taskSubmitOnly');
  if (!jour || !heure || !btn || editingTaskId) return;
  if (jour.value || heure.value) {
    if (!btn.dataset.avant) { btn.dataset.avant = btn.innerHTML; btn.dataset.seulAvant = seul.hidden ? '1' : '0'; }
    btn.innerHTML = `${svgIco('clock')}${tr('task.btn.create-schedule')}`;
    seul.hidden = true;
  } else if (btn.dataset.avant) {
    btn.innerHTML = btn.dataset.avant;
    seul.hidden = btn.dataset.seulAvant === '1';
    delete btn.dataset.avant; delete btn.dataset.seulAvant;
  }
}
/* La date des deux champs, en ISO — `null` sans rien dans les deux, ou `false` si l'un des deux
   manque ou si la date est déjà passée (signalé sous le champ fautif : c'est presque toujours
   une faute de frappe, et la session partirait pendant qu'on relit). Les champs sont en heure
   locale, comme l'horloge du poste qui lancera. */
function lireDateProgrammee(f) {
  const jour = f && f.scheduled_at_date;
  const heure = f && f.scheduled_at_time;
  if (!jour || !heure || taskKind === 'ask') return null;
  const enveloppe = jour.closest('.schedule-inputs') || jour.parentElement;
  if (!jour.value && !heure.value) { viderErreursChamps(enveloppe); return null; }
  viderErreursChamps(enveloppe);
  if (!jour.value) return signalerChamp(jour, tr('err.programmation.date-manquante'));
  if (!heure.value) return signalerChamp(heure, tr('err.programmation.heure-manquante'));
  const d = new Date(`${jour.value}T${heure.value}`);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return signalerChamp(heure, tr('err.programmation.date-passee'));
  return d.toISOString();
}
// À l'édition : la date en place, et ce qu'elle était — pour ne l'envoyer que si elle change.
function poserDateProgrammee(f, iso) {
  const jour = f && f.scheduled_at_date;
  const heure = f && f.scheduled_at_time;
  if (!jour || !heure) return;
  const [dv, hv] = (versDatetimeLocal(iso) || '').split('T');
  jour.value = dv || ''; heure.value = hv || '';
  jour.dataset.initial = jour.value; heure.dataset.initial = heure.value;
}
async function majProgrammationEdition(f, route, iso) {
  const jour = f && f.scheduled_at_date;
  const heure = f && f.scheduled_at_time;
  if (!jour || !heure) return;
  const inchange = (jour.dataset.initial || '') === (jour.value || '') && (heure.dataset.initial || '') === (heure.value || '');
  if (inchange) return;
  await api(route, { method: 'PUT', body: { at: iso } });
}
$('#taskScheduleDate') && $('#taskScheduleDate').addEventListener('input', majBoutonProgrammation);
$('#taskScheduleTime') && $('#taskScheduleTime').addEventListener('input', majBoutonProgrammation);

