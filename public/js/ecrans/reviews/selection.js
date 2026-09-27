'use strict';
/* Sélection multiple dans la liste des MR, C4 : créer et vérifier. */
/* ---------- Sélection multiple dans la liste des MR ---------- */

const mrSelection = new Set();

function mrSelectionRepos() {
  const par = new Map();
  for (const id of mrSelection) {
    const r = mrRepoId(id);
    if (r) par.set(id, r);
  }
  return par;
}

/* Le nom qu'un lot devrait porter, déduit de ce qui est coché. Deux règles, dans cet ordre :
   la clé de ticket que TOUTES portent (c'est le cas d'usage : un ticket, cinq dépôts), sinon
   le plus long préfixe commun des noms de branche, coupé proprement à un séparateur — un
   préfixe tronqué au milieu d'un mot (`feat/PROJ-14`) est pire que pas de proposition. */
function nomDeLotPropose(ids) {
  const rows = toReviewRows.concat(reportRows).filter((m) => ids.includes(m.id));
  if (rows.length < 2) return '';
  const cles = rows.map((m) => (m.ticket_key || jiraCleDe(m) || '').toUpperCase());
  if (cles.every((k) => k && k === cles[0])) return cles[0];
  const branches = rows.map((m) => String(m.source_branch || ''));
  if (branches.some((b) => !b)) return '';
  let i = 0;
  while (i < branches[0].length && branches.every((b) => b[i] === branches[0][i])) i += 1;
  const commun = branches[0].slice(0, i).replace(/[^A-Za-z0-9]+$/, '');
  return commun.length >= 4 ? commun : '';
}

function renderMrBulkBar() {
  majBoutonReview();       // cocher une carte change ce que « Reviewer » va lancer
  const bar = $('#mrBulkBar');
  if (!bar) return;
  bar.hidden = mrSelection.size === 0;
  if (!mrSelection.size) return;
  $('#mrBulkCount').textContent = tr('verify.bulk.count', { n: mrSelection.size });
  /* Deux MR du même dépôt rendraient le verdict ininterprétable — on ne saurait pas quel code
     a été testé. On le dit ICI, avant le clic, plutôt que de renvoyer une erreur après. */
  const repos = [...mrSelectionRepos().values()];
  const double = repos.length !== new Set(repos).size;
  $('#mrBulkWarn').hidden = !double;
  $('#mrBulkWarn').textContent = double ? tr('err.verify.repo-twice') : '';
  $('#btnBulkVerify').disabled = double;
  /* C4 — LE NOM DU LOT SE DEVINE. On cochait cinq cartes puis on tapait « PROJ-1408 » à la
     main, alors que les cinq le portent déjà. La clé de ticket commune si elle existe, sinon
     le préfixe commun des branches. Proposé, jamais imposé : le champ reste modifiable, et
     ce qui a été tapé n'est pas écrasé. */
  const champLot = $('#mrBulkLotName');
  if (champLot && !champLot.value.trim() && !champLot.dataset.touche) {
    const propose = nomDeLotPropose([...mrSelection]);
    if (propose) champLot.value = propose;
  }
  $('#btnBulkLot').disabled = double;
}

$('#btnBulkClear') && $('#btnBulkClear').addEventListener('click', () => {
  mrSelection.clear();
  $$('#toReviewList .mr-pick').forEach((c) => { c.checked = false; });
  renderMrBulkBar();
});

$('#btnBulkVerify') && $('#btnBulkVerify').addEventListener('click', () => lancerVerification([...mrSelection]));

$('#mrBulkLotName') && $('#mrBulkLotName').addEventListener('input', (e) => { e.target.dataset.touche = '1'; });
/* C4 — CRÉER ET VÉRIFIER, en un geste. On ne crée pas un lot pour le contempler : on le crée
   pour lancer la vérification groupée, et il fallait ensuite aller le retrouver dans Dev IA.
   Le bouton « Créer un lot » reste, pour préparer maintenant et lancer plus tard. */
$('#btnBulkLotVerify') && $('#btnBulkLotVerify').addEventListener('click', async (e) => {
  const champ = $('#mrBulkLotName');
  const name = champ.value.trim();
  if (!name) { toast(tr('err.lot.name-required'), true); champ.focus(); return; }
  const ids = [...mrSelection];
  try {
    const lot = await busy(e.currentTarget, () => api('/lots', { method: 'POST', body: { name, members: ids } }));
    champ.value = '';
    delete champ.dataset.touche;
    toast(tr('verify.toast.lot-created', { name }));
    loadLots();
    lancerVerification(ids, { lotId: lot && lot.id, repoIds: [...mrSelectionRepos().values()] });
  } catch (err) { toast(explainError(err.message), true); }
});
$('#btnBulkLot') && $('#btnBulkLot').addEventListener('click', async (e) => {
  const name = $('#mrBulkLotName').value.trim();
  if (!name) { toast(tr('err.lot.name-required'), true); $('#mrBulkLotName').focus(); return; }
  try {
    await busy(e.currentTarget, () => api('/lots', { method: 'POST', body: { name, members: [...mrSelection] } }));
    $('#mrBulkLotName').value = '';
    delete $('#mrBulkLotName').dataset.touche;
    toast(tr('verify.toast.lot-created', { name }));
    loadLots();
  } catch (err) { toast(explainError(err.message), true); }
});

