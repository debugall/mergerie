'use strict';
/* LE BINAIRE D'UNE SESSION : le sélecteur de la modale, rempli à chaque ouverture depuis
   `/api/agent-clis`. Sans autre binaire que le défaut, la ligne reste cachée — l'écran est
   celui d'avant. Le défaut est la première option (valeur vide) ; une session éditée ou
   dupliquée réaffiche son choix (`cliPreselection`, posé avant `showTaskModal`). */
let cliPreselection = '';
async function majChoixCli(valeur) {
  const row = $('#taskCliRow'); const sel = $('#taskCli');
  if (!row || !sel) return;
  let d = { defaut: null, items: [] };
  try { d = await api('/agent-clis'); } catch { /* la ligne reste cachée */ }
  const items = d.items || [];
  const voulu = valeur == null ? '' : String(valeur);
  sel.innerHTML = [`<option value="">${esc(tr('task.cli.default', { name: d.defaut ? d.defaut.name : '' }))}</option>`]
    .concat(items.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)).join('');
  /* Un choix qui n'existe plus (profil supprimé) retombe sur le défaut, et se voit. */
  sel.value = items.some((c) => String(c.id) === voulu) ? voulu : '';
  row.hidden = taskKind === 'ask' || (!items.length && !voulu);
}
