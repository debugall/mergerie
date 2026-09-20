'use strict';
/* Programmer une session : une date change le bouton, la date du champ en ISO. */
/* UNE DATE CHANGE LE BOUTON. « Créer et lancer » avec une date remplie lancerait… plus tard :
   le bouton le dit (« Créer et programmer ») et « Créer sans lancer » disparaît — avec une date,
   la question ne se pose plus. Effacer la date rend les boutons d'avant. À l'édition, rien ne
   bouge : « Enregistrer » couvre la date comme le reste. */
function majBoutonProgrammation() {
  const champ = $('#taskScheduleAt');
  const btn = $('#taskSubmit');
  const seul = $('#taskSubmitOnly');
  if (!champ || !btn || editingTaskId) return;
  if (champ.value) {
    if (!btn.dataset.avant) { btn.dataset.avant = btn.innerHTML; btn.dataset.seulAvant = seul.hidden ? '1' : '0'; }
    btn.innerHTML = `${svgIco('clock')}${tr('task.btn.create-schedule')}`;
    seul.hidden = true;
  } else if (btn.dataset.avant) {
    btn.innerHTML = btn.dataset.avant;
    seul.hidden = btn.dataset.seulAvant === '1';
    delete btn.dataset.avant; delete btn.dataset.seulAvant;
  }
}
/* La date du champ, en ISO — ou `null` sans date, ou `false` si elle est déjà passée (signalée
   sous le champ : c'est presque toujours une faute de frappe, et la session partirait pendant
   qu'on relit). Le champ est en heure locale, comme l'horloge du poste qui lancera. */
function lireDateProgrammee(f) {
  const champ = f && f.scheduled_at;
  if (!champ || taskKind === 'ask' || !champ.value) return null;
  viderErreursChamps(champ.parentElement);
  const d = new Date(champ.value);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return signalerChamp(champ, tr('err.programmation.date-passee'));
  return d.toISOString();
}
// À l'édition : la date en place, et ce qu'elle était — pour ne l'envoyer que si elle change.
function poserDateProgrammee(f, iso) {
  const champ = f && f.scheduled_at;
  if (!champ) return;
  champ.value = versDatetimeLocal(iso);
  champ.dataset.initial = champ.value;
}
async function majProgrammationEdition(f, route, iso) {
  const champ = f && f.scheduled_at;
  if (!champ || (champ.dataset.initial || '') === (champ.value || '')) return;
  await api(route, { method: 'PUT', body: { at: iso } });
}

