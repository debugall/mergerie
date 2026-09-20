'use strict';
/* Environnements. */
/* ---------- Environnements ---------- */

let envEnCours = null;
function openEnvModal(env) {
  envEnCours = env || null;
  $('#envModalTitle').textContent = tr(env ? 'links.env.edit' : 'links.env.new');
  $('#envName').value = env ? env.name : '';
  $('#envColor').value = (env && env.color) || '#2f6fe0';
  $('#envDelete').hidden = !env;
  $('#envModal').hidden = false;
  setTimeout(() => $('#envName').focus(), 0);
}
$('#envCancel') && $('#envCancel').addEventListener('click', () => { $('#envModal').hidden = true; });
fermerAuFond('#envModal', () => { $('#envModal').hidden = true; }, { salissable: true });
$('#envSave') && $('#envSave').addEventListener('click', async () => {
  const body = { name: $('#envName').value, color: $('#envColor').value };
  try {
    if (envEnCours) await api(`/environments/${envEnCours.id}`, { method: 'PUT', body });
    else await api('/environments', { method: 'POST', body });
    $('#envModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});
$('#envDelete') && $('#envDelete').addEventListener('click', async () => {
  if (!envEnCours) return;
  /* COMBIEN D'ADRESSES PARTENT AVEC LA COLONNE. « Les URLs sont supprimées avec lui » ne dit
     pas s'il y en a une ou quarante, et c'est ce qu'on a besoin de savoir pour répondre. */
  const n = ((LINKS.grid && LINKS.grid.services) || [])
    .reduce((t, s2) => t + (((s2.urls || {})[envEnCours.id] || []).length), 0);
  if (!await confirmDialog({
    title: tr('links.env.delete'),
    text: n
      ? tr('links.env.delete-text-n', { name: envEnCours.name, n, count: n })
      : tr('links.env.delete-text-empty', { name: envEnCours.name }),
    confirmLabel: tr('ui.delete'), danger: true,
  })) return;
  try {
    await api(`/environments/${envEnCours.id}`, { method: 'DELETE' });
    $('#envModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});
/* L'en-tête entier N'EST PLUS cliquable : il l'était sans que rien ne le dise, et le clic
   partait aussi quand on visait les flèches de déplacement. Un bouton nommé, c'est plus long
   à écrire et plus court à comprendre. */

