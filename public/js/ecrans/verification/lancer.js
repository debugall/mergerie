'use strict';
/* Vérifier une branche sans merge request, lancer une vérification, B6 l'état des services. */
// @expose lancerVerification, mrRepoId, ouvrirVerifBranche
/* ---------- Vérifier une BRANCHE, sans merge request ----------
   « Est-ce que develop est encore vert ? » — la question du retour de congés. Une ligne par
   dépôt COUVERT par le vérificateur choisi, chacune sur sa branche par défaut : un vérificateur
   multi-dépôts monte déjà un environnement complet, c'est la même vérification d'intégration
   avec des branches au lieu de merge requests.

   MAIS LA COUVERTURE N'EST PAS LA DEMANDE. Ces lignes étaient toutes obligatoires : un
   vérificateur qui couvre cinq dépôts imposait cinq branches, même à qui ne voulait vérifier
   que `develop` sur un seul — et une ligne dont la branche par défaut ne se lisait pas (dépôt
   injoignable) bloquait le lancement des autres. Chaque ligne se coche donc maintenant, toutes
   cochées d'entrée pour ne rien changer au cas multi-dépôts, et la sélection est mémorisée par
   vérificateur : c'est le même geste qu'on refait, semaine après semaine. Le serveur, lui,
   acceptait déjà un sous-ensemble — il exige des cibles COUVERTES par le vérificateur, pas la
   couverture entière. */
let branchVerifVerifiers = [];
const BRANCHE_MEMO = 'aidevtools_verif_branche';
const BRANCHE_MEMO_DEPOTS = 'aidevtools_verif_branche_depots';

const memoBranches = () => { try { return JSON.parse(localStorage.getItem(BRANCHE_MEMO) || '{}'); } catch { return {}; } };
const memoriserBranche = (repoId, branche) => {
  try {
    const m = memoBranches(); m[repoId] = branche;
    localStorage.setItem(BRANCHE_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
};
/* Les dépôts retenus, par vérificateur : « seulement api-core » n'est pas une envie du jour,
   c'est une habitude. Absente de la mémoire, la sélection vaut TOUT — et une mémoire devenue
   vide (les dépôts retenus ne sont plus couverts) revaut tout aussi : rouvrir la modale sur
   zéro dépôt coché ne dirait pas pourquoi le bouton refuse. */
const memoDepots = () => { try { return JSON.parse(localStorage.getItem(BRANCHE_MEMO_DEPOTS) || '{}'); } catch { return {}; } };
const memoriserDepots = (verifierId, repoIds) => {
  try {
    const m = memoDepots(); m[verifierId] = repoIds;
    localStorage.setItem(BRANCHE_MEMO_DEPOTS, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
};

async function ouvrirVerifBranche(verifierId = null) {
  try {
    const d = await api('/verifiers');
    branchVerifVerifiers = (Array.isArray(d) ? d : (d.verifiers || [])).filter((v) => (v.repos || []).length);
  } catch (e) { toast(explainError(e.message), true); return; }
  if (!branchVerifVerifiers.length) { toast(tr('verify.branch.none'), true); return; }
  const sel = $('#branchVerifySelect');
  sel.innerHTML = branchVerifVerifiers.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  if (verifierId && branchVerifVerifiers.some((v) => v.id === verifierId)) sel.value = String(verifierId);
  await renderVerifBrancheRows();
  $('#branchVerifyModal').hidden = false;
}

async function renderVerifBrancheRows() {
  const v = branchVerifVerifiers.find((x) => String(x.id) === $('#branchVerifySelect').value);
  const el = $('#branchVerifyRows');
  if (!v) { el.innerHTML = ''; return; }
  const memo = memoBranches();
  /* Sélection retenue pour CE vérificateur, réduite à ce qu'il couvre encore : un dépôt retiré
     de la couverture depuis la dernière fois ne doit pas rendre la mémoire inutilisable. */
  const couverts = (v.repos || []).map((r) => r.repo_id);
  const retenus = (memoDepots()[v.id] || []).filter((id) => couverts.includes(id));
  const coche = (id) => (retenus.length ? retenus.includes(id) : true);
  const lignes = (v.repos || []).map((r) => {
    const projet = (repoOptions.find((x) => x.id === r.repo_id) || {}).project || `#${r.repo_id}`;
    /* `data-row` est le contrat de `wireCombo` : c'est cet ancêtre-là qu'il passe au chargeur
       (`combo.closest('[data-row]')`). Sans lui, le chargeur reçoit `null`. LA LIGNE N'EST PLUS
       UN <label> : elle en contient un, celui de la case. Un `<label>` englobant la ligne
       entière ferait basculer la case à chaque clic dans le champ de branche. */
    return `<div class="verif-branche-row${coche(r.repo_id) ? '' : ' is-off'}" data-row="${r.repo_id}" data-repo="${r.repo_id}">
      <label class="repo-multi-item"><input type="checkbox" class="vb-pick"${coche(r.repo_id) ? ' checked' : ''} /> <span>${esc(projet)}</span></label>
      ${comboHtml('vb-branch', { value: memo[r.repo_id] || '', label: memo[r.repo_id] || '', ph: tr('verify.branch.ph'), disabled: !coche(r.repo_id) })}</div>`;
  }).join('');
  /* Recherche obligatoire dès qu'on choisit des dépôts (règle du projet) : elle MASQUE les
     lignes sans jamais décocher — filtrer ne doit pas changer ce qui va être lancé. */
  el.innerHTML = `<input class="repo-multi-search vb-search" type="search" placeholder="${esc(tr('verify.branch.search-ph'))}" />
    <div class="repo-multi-list vb-list">${lignes}</div>`;
  const rech = $('.vb-search', el);
  rech.addEventListener('input', () => {
    const q = rech.value.toLowerCase().trim();
    $$('.verif-branche-row', el).forEach((row) => {
      row.hidden = !!q && !$('.repo-multi-item span', row).textContent.toLowerCase().includes(q);
    });
  });
  /* Sélecteur À RECHERCHE, jamais une liste nue : un dépôt actif aligne des centaines de
     branches — et `npm run check` refuse une liste de branches sans champ de recherche. */
  wireCombo(el, 'vb-branch', async (row) => {
    const repoId = Number(row && row.dataset.repo);
    if (!repoId) return [];
    const d = await gitLoadRefs(repoId, 'branches');
    return d.refs.map((r) => ({ value: r.name, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' }));
  });
  /* La branche PAR DÉFAUT du dépôt est proposée d'emblée — c'est elle, « la branche sur
     laquelle tout a été mergé », dans la quasi-totalité des cas. La dernière vérifiée gagne.
     On ne va la chercher que pour les dépôts RETENUS : un dépôt décoché n'a pas à faire
     attendre l'ouverture de la modale pour une valeur qui ne partira pas. */
  for (const row of $$('#branchVerifyRows .verif-branche-row')) {
    const cache = row.querySelector('.vb-branch');
    if (cache.value || !row.querySelector('.vb-pick').checked) continue;
    try {
      const d = await gitLoadRefs(Number(row.dataset.repo), 'branches');
      const def = (d.refs || []).find((r) => r.default);
      if (def) {
        cache.value = def.name;
        row.querySelector('.cb-search').value = def.name;
      }
    } catch { /* dépôt injoignable : la ligne reste à remplir à la main */ }
  }
}

/* Cocher/décocher un dépôt : la ligne s'éteint, son champ de branche se désactive, et la
   branche par défaut est cherchée à la première coche — une ligne qu'on vient d'ajouter doit
   arriver remplie comme les autres, sans avoir à la remplir soi-même. */
$('#branchVerifyRows') && $('#branchVerifyRows').addEventListener('change', async (e) => {
  const c = e.target.closest && e.target.closest('.vb-pick');
  if (!c) return;
  const row = c.closest('.verif-branche-row');
  row.classList.toggle('is-off', !c.checked);
  const cache = row.querySelector('.vb-branch');
  const champ = row.querySelector('.cb-search');
  champ.disabled = !c.checked;
  if (!c.checked || cache.value) return;
  try {
    const d = await gitLoadRefs(Number(row.dataset.repo), 'branches');
    const def = (d.refs || []).find((r) => r.default);
    if (def) { cache.value = def.name; champ.value = def.name; }
  } catch { /* dépôt injoignable : la ligne reste à remplir à la main */ }
});

$('#btnVerifyBranch') && $('#btnVerifyBranch').addEventListener('click', () => ouvrirVerifBranche());
$('#branchVerifySelect') && $('#branchVerifySelect').addEventListener('change', () => renderVerifBrancheRows());
$('#branchVerifyCancel') && $('#branchVerifyCancel').addEventListener('click', () => { $('#branchVerifyModal').hidden = true; });
$('#branchVerifyGo') && $('#branchVerifyGo').addEventListener('click', async (e) => {
  /* SEULES LES LIGNES COCHÉES PARTENT — et une ligne masquée par la recherche compte comme les
     autres : le filtre cache, il ne désélectionne pas. Une branche manquante sur une ligne
     décochée ne bloque plus rien, c'était le défaut de départ. */
  const verifierId = Number($('#branchVerifySelect').value);
  const targets = $$('#branchVerifyRows .verif-branche-row')
    .filter((row) => row.querySelector('.vb-pick').checked)
    .map((row) => ({
      repo_id: Number(row.dataset.repo),
      branch: (row.querySelector('.vb-branch').value || '').trim(),
    }));
  if (!targets.length) { toast(tr('verify.branch.no-repo'), true); return; }
  if (targets.some((t) => !t.branch)) { toast(tr('verify.branch.missing'), true); return; }
  try {
    await busy(e.currentTarget, () => api('/verify/branches', {
      method: 'POST', body: { verifier_id: verifierId, targets },
    }));
    for (const t of targets) memoriserBranche(t.repo_id, t.branch);
    memoriserDepots(verifierId, targets.map((t) => t.repo_id));
    $('#branchVerifyModal').hidden = true;
    toast(tr('verify.toast.started'));
    refreshStatus();
  } catch (err) { toast(explainError(err.message), true); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-vbranch]');
  if (b) ouvrirVerifBranche(Number(b.dataset.vbranch));
});

/* A/Git 3 — LES DEUX GESTES DE L'EXPLORATEUR. Ils n'inventent rien : ils ouvrent les écrans
   qui existent, avec le dépôt et la branche déjà posés. La branche est écrite dans la MÊME
   mémoire que « Vérifier une branche » utilise déjà — deux endroits pour dire « la branche du
   dépôt X » se seraient contredits au premier changement. */
document.addEventListener('click', (e) => {
  const v = e.target.closest && e.target.closest('[data-gitverif]');
  if (v) {
    memoriserBranche(Number(v.dataset.repo), v.dataset.gitverif);
    ouvrirVerifBranche();
    return;
  }
  const c = e.target.closest && e.target.closest('[data-gitcode]');
  if (!c) return;
  /* Coder SUR une branche existante : la branche de travail est celle-là, et la branche de
     départ reste vide (c'est-à-dire « celle-ci ») — proposer un départ ferait croire qu'on
     va en créer une nouvelle. */
  navTab('task');
  openTaskModal('code').then(() => {
    renderTargetRows([{ repo_id: Number(c.dataset.repo), branch: c.dataset.gitcode }]);
    majVerificateursSession('');
  });
});

/* ---------- Lancer une vérification ---------- */

/* On CONFIRME toujours, même quand un seul vérificateur couvre le dépôt. La modale ne sert
   pas d'abord à choisir : lancer des commandes sur sa machine mérite un écran qui annonce
   lesquelles, dans quel dépôt et sur quels commits. */
async function lancerVerification(mrIds, { lotId = null, repoIds = null } = {}) {
  /* `repoIds` : les dépôts déjà connus de l'appelant (membres d'un lot). Sans eux, on retombe
     sur les listes Reviews — vides tant que l'onglet n'a pas été chargé, et un lot lancé
     depuis « Dev IA » échouerait à tort sur « aucun vérificateur ». */
  const repos = [...new Set(repoIds && repoIds.length ? repoIds : mrIds.map((id) => mrRepoId(id)).filter(Boolean))];
  let choix = null;
  try {
    const r = await api(`/verifiers/for?repos=${repos.join(',')}`);
    if (!r.verifiers.length) { toast(tr('err.verify.no-verifier'), true); return; }
    choix = await choisirVerifier(r.verifiers, mrIds, lotId);
    if (!choix) return;
  } catch (e) { toast(explainError(e.message), true); return; }
  memoriserVerifLot(lotId, choix);   // le même lot repartira sur le même vérificateur
  try {
    const body = { verifier_id: choix };
    if (lotId) await api(`/lots/${lotId}/verify`, { method: 'POST', body });
    else await api('/verify/mrs', { method: 'POST', body: { ...body, mr_ids: mrIds } });
    toast(tr('verify.toast.started'));
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
}

function mrRepoId(mrId) {
  const m = toReviewRows.find((x) => x.id === mrId) || reportRows.find((x) => x.id === mrId);
  return m ? m.repo_id : null;
}

let verifyPickResolve = null;
let verifyPickListe = [];

/* A/Réglages 3 — LE VÉRIFICATEUR D'UN LOT SE RETIENT. Un lot se revérifie plusieurs fois
   (après corrections, après rebase) et c'est chaque fois le même vérificateur : le proposer
   d'office évite de le rechoisir dans une liste où un mauvais clic lance autre chose.
   Mémoire de navigateur : la perdre ne perd qu'une présélection. */
const LOT_VERIF_MEMO = 'aidevtools_lot_verif';
const lotVerifMemo = () => { try { return JSON.parse(localStorage.getItem(LOT_VERIF_MEMO) || '{}'); } catch { return {}; } };
function memoriserVerifLot(lotId, verifierId) {
  if (!lotId || !verifierId) return;
  try {
    const m = lotVerifMemo(); m[lotId] = verifierId;
    localStorage.setItem(LOT_VERIF_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible */ }
}

function choisirVerifier(listeBrute, mrIds, lotId = null) {
  /* Les vérificateurs hérités de la famille « script » ne sont pas proposés : le serveur
     refuserait de les lancer, et offrir un choix qui échoue au clic suivant est pire que ne pas
     l'offrir. Ils restent visibles dans les Réglages, où l'on peut les réécrire. */
  const liste = (listeBrute || []).filter((v) => v.kind === 'commands');
  verifyPickListe = liste;
  const mrs = (mrIds || []).map((id) => toReviewRows.concat(reportRows).find((m) => m.id === id)).filter(Boolean);
  $('#verifyPickWhat').textContent = mrs.length
    ? tr('verify.pick.what', { n: mrs.length, list: mrs.map((m) => `${m.project} !${m.iid}`).join(', ') })
    : '';
  /* Radio et non bouton-qui-lance : on choisit d'abord, on voit ce que ça implique, puis on
     lance. Le détail change sous les yeux à chaque sélection. */
  const dejaChoisi = lotId ? Number(lotVerifMemo()[lotId]) : 0;
  const iDefaut = Math.max(0, liste.findIndex((v) => v.id === dejaChoisi));
  $('#verifyPickList').innerHTML = liste.map((v, i) => `<label class="inline-check verify-pick-opt">
    <input type="radio" name="verifyPick" value="${v.id}" ${i === iDefaut ? 'checked' : ''} />
    <span>${esc(v.name)}</span>
  </label>`).join('');
  majDetailChoix();
  $('#verifyPickModal').hidden = false;
  return new Promise((resolve) => { verifyPickResolve = resolve; });
}

/* ---------- B6 : l'état des services au moment du clic ----------
   La vérification « in place » tourne DANS un répertoire de travail. Si ce répertoire porte un
   projet compose et que sa base est arrêtée, elle mourra en trois secondes sur un
   `ECONNREFUSED` — et on l'apprendra après. La fenêtre le dit avant, avec le bouton qui
   répare. Demandé À L'OUVERTURE de la fenêtre, pas en boucle : c'est un `docker ps`. */
async function majEtatDockerDuChoix(v) {
  const box = $('#verifyDockerEtat');
  if (!box) return;
  const dirs = [...new Set((v.repos || []).filter((r) => r.mode === 'in_place' && r.workdir).map((r) => r.workdir))];
  box.innerHTML = '';
  for (const dir of dirs) {
    let d;
    try { d = await api(`/docker/dir-state?dir=${encodeURIComponent(dir)}`); } catch { d = null; }
    if (!d || !d.found || !d.services.length) continue;
    const arretes = d.services.filter((sv) => sv.state !== 'running');
    if (!arretes.length) continue;      // tout tourne : rien à dire, et le silence est la bonne réponse
    const el = document.createElement('p');
    el.className = 'converge-note';
    el.innerHTML = `${svgIco('alert')} <span>${esc(tr('verify.pick.docker-down', {
      project: d.project,
      list: arretes.map((sv) => `${sv.name} : ${dockerStateLabel(sv.state)}`).join(', '),
    }))}</span> <button type="button" class="btn btn-sm" data-verify-up="${esc(dir)}">${esc(tr('docker.act.up'))}</button>`;
    box.appendChild(el);
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-verify-up]');
  if (!b) return;
  try {
    await busy(b, () => api('/docker/compose/action', { method: 'POST', body: { action: 'up', dir: b.dataset.verifyUp, services: [] } }));
    toast(tr('docker.up.started'));
    b.disabled = true;
  } catch (err) { toast(explainError(err.message), true); }
});

// Ce qui va réellement tourner : les commandes, le mode, le délai.
function majDetailChoix() {
  const sel = $('#verifyPickList input:checked');
  const v = verifyPickListe.find((x) => String(x.id) === (sel && sel.value));
  const box = $('#verifyPickDetail');
  if (!box) return;
  if (!v) { box.innerHTML = ''; return; }
  const modes = (v.repos || []).map((r) => `${esc(r.project || `#${r.repo_id}`)} <span class="tag ${r.mode === 'in_place' ? 'warn' : ''}">${esc(r.mode === 'in_place' ? tr('verify.mode.in-place-short') : tr('verify.mode.worktree-short'))}</span>`).join(' · ');
  box.innerHTML = `
    <p class="muted">${esc(tr('verify.pick.commands'))}</p><pre class="verify-log">${(v.commands || []).map((c) => `$ ${esc(c)}`).join('\n')}</pre>
    <p class="muted">${modes}</p>
    <p class="muted">${esc(v.run_base ? tr('verify.pick.with-base') : tr('verify.pick.no-base'))} · ${esc(tr('verify.verifier.meta', { timeout: v.timeout_s }))}</p>
    ${(v.repos || []).some((r) => r.mode === 'in_place') ? `<div id="verifyDockerEtat"></div><p class="converge-note">${svgIco('alert')} <span>${esc(tr('verify.pick.in-place-warn'))}</span></p>` : ''}`;
  // L'état des services du répertoire « in place », demandé maintenant (cf. B6).
  majEtatDockerDuChoix(v);
}

function fermerChoixVerifier(v) {
  $('#verifyPickModal').hidden = true;
  const r = verifyPickResolve; verifyPickResolve = null;
  if (r) r(v);
}
$('#verifyPickCancel') && $('#verifyPickCancel').addEventListener('click', () => fermerChoixVerifier(null));
$('#verifyPickList') && $('#verifyPickList').addEventListener('change', majDetailChoix);
$('#verifyPickGo') && $('#verifyPickGo').addEventListener('click', () => {
  const sel = $('#verifyPickList input:checked');
  fermerChoixVerifier(sel ? Number(sel.value) : null);
});

