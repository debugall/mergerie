'use strict';
/* Services et liens contextuels. */
/* ---------- Services et liens contextuels ---------- */

let serviceEnCours = null;
/* Les gabarits saisis AVANT que le service existe. Ils vivent ici le temps de la création,
   puis sont posés juste après — sinon la section resterait masquée à la création, et il
   faudrait rouvrir la fiche pour ajouter le lien contextuel qu'on avait déjà en tête. */
let ctxEnAttente = [];
async function openServiceModal(id, { section = '' } = {}) {
  serviceEnCours = id ? ((LINKS.grid.services || []).find((s) => s.id === id) || null) : null;
  ctxEnAttente = [];
  $('#serviceModalTitle').textContent = tr(serviceEnCours ? 'links.service.edit' : 'links.service.new');
  $('#serviceName').value = serviceEnCours ? serviceEnCours.name : '';
  $('#serviceTags').value = serviceEnCours ? (serviceEnCours.tags || []).join(', ') : '';
  // Le choix du dépôt passe par le sélecteur À RECHERCHE, comme partout ailleurs.
  /* Le dépôt se choisit dans le sélecteur À RECHERCHE, comme partout : la liste peut
     compter des dizaines d'entrées. `defaultFirst: false` — un service sans dépôt est le
     cas courant, en pré-sélectionner un au hasard poserait des boutons sur ses MR. */
  await loadRepoOptions();
  $('#serviceRepoBox').innerHTML = repoComboHtml(serviceEnCours ? serviceEnCours.repo_id : null, { idClass: 'js-service-repo', defaultFirst: false });
  wireRepoCombos($('#serviceRepoBox'));
  $('#servicePinned').checked = !!(serviceEnCours && serviceEnCours.pinned);
  renderServiceUrls();
  $('#serviceDelete').hidden = !serviceEnCours;
  if (serviceEnCours) await renderCtxLinks(serviceEnCours.id); else renderCtxLinks(null);
  $('#serviceModal').hidden = false;
  /* L'icône ⚡ de la grille ouvre la fiche À LA BONNE SECTION : le chip « 1 lien contextuel »
     ne menait nulle part, et retrouver les gabarits demandait de faire défiler la fiche. */
  if (section === 'ctx') {
    const b = $('#serviceCtxBox');
    if (b) b.scrollIntoView({ block: 'center' });
    setTimeout(() => $('#ctxLabel').focus(), 0);
    return;
  }
  setTimeout(() => $('#serviceName').focus(), 0);
}

/* LE DÉPÔT SE PROPOSE DEPUIS LE NOM TAPÉ. On appelle son service comme son dépôt neuf fois
   sur dix ; le sélecteur restait vide et il fallait retrouver « groupe/api-core » dans une
   liste de deux cents. La proposition n'est QUE cela : elle ne se pose que sur un champ
   encore vide, et un seul dépôt doit correspondre — deux candidats, et on ne devine pas. */
$('#serviceName') && $('#serviceName').addEventListener('input', () => {
  if (serviceEnCours) return;
  const combo = $('#serviceRepoBox .js-service-repo');
  if (!combo || combo.value) return;
  const n = $('#serviceName').value.trim().toLowerCase();
  if (n.length < 3) return;
  const cands = (repoOptions || []).filter((r) => String(r.project || '').toLowerCase().includes(n));
  if (cands.length !== 1) return;
  combo.value = String(cands[0].id);
  combo.dataset.label = cands[0].project;
  const champ = $('#serviceRepoBox .rc-search');
  if (champ) { champ.value = cands[0].project; champ.title = cands[0].project; }
});

/* Une ligne par environnement, pré-remplie à l'édition. C'est le second chemin vers une URL,
   et il vaut la peine d'exister : la grille sert quand on corrige une case, la modale quand on
   pose tout un service d'un coup. */
/* TOUTES LES ADRESSES DE LA CASE, et non la première suivie d'un « 2 adresses ». Ce compte
   désignait le RESTE, invisible et non modifiable ici : on croyait la case à une adresse, et
   l'enregistrement — qui remplace la case entière — semblait avoir mangé les autres.
   Une ligne par adresse, plus une vide pour en ajouter une : la fiche pose un service
   utilisable en une passe, la grille sert à corriger une case au milieu du travail. */
function renderServiceUrls() {
  const envs = ((LINKS.grid && LINKS.grid.environments) || []);
  const box = $('#serviceUrlsList');
  if (!envs.length) { box.innerHTML = `<p class="muted">${esc(tr('links.service.no-env'))}</p>`; return; }
  box.innerHTML = envs.map((e) => {
    const liste = (serviceEnCours && (serviceEnCours.urls || {})[e.id]) || [];
    const rangees = [...liste, { label: '', url: '' }];
    return `<div class="link-url-env" data-svcenv="${e.id}">
      <span class="link-env"><span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.name)}</span>
      <div class="link-url-rows">${rangees.map((u) => ligneUrlService(u)).join('')}</div>
    </div>`;
  }).join('');
}
const ligneUrlService = (u) => `<div class="link-url-row">
    <input type="text" class="svc-url-label" maxlength="100" placeholder="${esc(tr('links.url.label-ph'))}" value="${esc(u.label || '')}" />
    <input type="url" class="svc-url" placeholder="https://…" value="${esc(u.url || '')}" />
    <button type="button" class="link-icon svc-url-del" title="${esc(tr('ui.delete'))}" aria-label="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>
  </div>`;
/* Une ligne vide reste TOUJOURS disponible au bas de chaque environnement : sans elle, ajouter
   une seconde adresse demanderait un bouton de plus à trouver. */
$('#serviceUrlsList') && $('#serviceUrlsList').addEventListener('input', (e) => {
  const champ = e.target.closest('.svc-url');
  if (!champ || !champ.value.trim()) return;
  const rows = champ.closest('.link-url-rows');
  if ($$('.svc-url', rows).some((i) => !i.value.trim())) return;
  rows.insertAdjacentHTML('beforeend', ligneUrlService({ label: '', url: '' }));
});
$('#serviceUrlsList') && $('#serviceUrlsList').addEventListener('click', (e) => {
  const del = e.target.closest('.svc-url-del');
  if (!del) return;
  const rows = del.closest('.link-url-rows');
  const row = del.closest('.link-url-row');
  if ($$('.link-url-row', rows).length > 1) row.remove();
  else { $('.svc-url-label', row).value = ''; $('.svc-url', row).value = ''; }
});
const ligneCtx = (l, i) => `<div class="link-ctx-row"><strong>${esc(l.label)}</strong>`
  + `<code>${esc(l.url_template)}</code>`
  + `<button type="button" class="btn btn-sm btn-ghost btn-danger" ${l.id ? `data-delctx="${l.id}"` : `data-delctxnew="${i}"`}>${svgIco('trash')}</button></div>`;
async function renderCtxLinks(serviceId) {
  const box = $('#serviceCtxList');
  // À la CRÉATION, il n'y a rien à lire côté serveur : on rend ce qui attend en mémoire.
  if (!serviceId) {
    box.innerHTML = ctxEnAttente.length
      ? ctxEnAttente.map(ligneCtx).join('')
      : `<p class="muted">${esc(tr('links.ctx.empty'))}</p>`;
    return;
  }
  try {
    const d = await api(`/services/${serviceId}/context-links`);
    box.innerHTML = (d.links || []).length
      ? d.links.map(ligneCtx).join('')
      : `<p class="muted">${esc(tr('links.ctx.empty'))}</p>`;
  } catch (e) { box.innerHTML = errorBox(e.message); }
}
$('#serviceCtxList') && $('#serviceCtxList').addEventListener('click', async (e) => {
  const neuf = e.target.closest('[data-delctxnew]');
  if (neuf) { ctxEnAttente.splice(Number(neuf.dataset.delctxnew), 1); renderCtxLinks(null); return; }
  const b = e.target.closest('[data-delctx]');
  if (!b || !serviceEnCours) return;
  try { await api(`/context-links/${b.dataset.delctx}`, { method: 'DELETE' }); await renderCtxLinks(serviceEnCours.id); }
  catch (err) { toast(explainError(err.message), true); }
});
$('#ctxAdd') && $('#ctxAdd').addEventListener('click', async () => {
  const label = $('#ctxLabel').value.trim();
  const gabarit = $('#ctxTemplate').value.trim();
  if (!label || !gabarit) { toast(tr('links.ctx.incomplete'), true); return; }
  if (!serviceEnCours) {
    /* Le gabarit ATTEND la création. On ne le valide pas ici : le serveur le fera au moment
       de le poser, et refuser une variable inconnue deux fois serait deux messages pour une
       même faute. */
    ctxEnAttente.push({ label, url_template: gabarit });
    $('#ctxLabel').value = ''; $('#ctxTemplate').value = '';
    renderCtxLinks(null);
    return;
  }
  try {
    await api(`/services/${serviceEnCours.id}/context-links`, { method: 'POST', body: { label, url_template: gabarit } });
    $('#ctxLabel').value = ''; $('#ctxTemplate').value = '';
    await renderCtxLinks(serviceEnCours.id);
  } catch (e) { toast(explainError(e.message), true); }
});
$('#serviceCancel') && $('#serviceCancel').addEventListener('click', () => { $('#serviceModal').hidden = true; });
fermerAuFond('#serviceModal', () => { $('#serviceModal').hidden = true; }, { salissable: true });
$('#serviceSave') && $('#serviceSave').addEventListener('click', async () => {
  const repo = $('#serviceRepoBox .js-service-repo');
  const body = {
    name: $('#serviceName').value,
    tags: $('#serviceTags').value,
    repo_id: repo ? Number(repo.value) || null : null,
    pinned: $('#servicePinned').checked ? 1 : 0,
  };
  // Une case entière par environnement : c'est ce que l'écran montre, et ce que l'API attend.
  const cases = $$('#serviceUrlsList [data-svcenv]').map((bloc) => ({
    environment_id: Number(bloc.dataset.svcenv),
    urls: $$('.link-url-row', bloc)
      .map((r) => ({ label: $('.svc-url-label', r).value.trim(), url: $('.svc-url', r).value.trim() }))
      .filter((u) => u.url),
  }));
  /* DEUX SERVICES SUR LE MÊME DÉPÔT étaient acceptés en silence, et seul le premier alimentait
     les boutons des merge requests : le second existait sans jamais rien produire. On accepte
     toujours — c'est parfois voulu —, mais on le DIT avant. */
  if (body.repo_id) {
    const autre = ((LINKS.grid && LINKS.grid.services) || [])
      .find((x) => x.repo_id === body.repo_id && (!serviceEnCours || x.id !== serviceEnCours.id));
    if (autre && !await confirmDialog({
      title: tr('links.service.repo-taken'),
      text: tr('links.service.repo-taken-text', { name: autre.name, repo: autre.project || '' }),
      confirmLabel: tr('ui.save'),
    })) return;
  }
  try {
    let id;
    if (serviceEnCours) {
      await api(`/services/${serviceEnCours.id}`, { method: 'PUT', body });
      id = serviceEnCours.id;
      /* On n'envoie QUE les cases qui ont bougé : rejouer les autres ferait autant d'écritures
         inutiles, et réécrirait des adresses qu'on n'a pas touchées. */
      const avant = serviceEnCours.urls || {};
      const memeCase = (a, b) => a.length === b.length
        && a.every((u, i) => u.url === b[i].url && (u.label || '') === (b[i].label || ''));
      for (const c of cases) {
        if (memeCase(avant[c.environment_id] || [], c.urls)) continue;
        await api(`/services/${id}/urls`, { method: 'PUT', body: c });
      }
    } else {
      const plates = cases.flatMap((c) => c.urls.map((u) => ({ environment_id: c.environment_id, label: u.label, url: u.url })));
      id = (await api('/services', { method: 'POST', body: { ...body, urls: plates } })).id;
      // Les gabarits saisis avant la création sont posés maintenant, dans l'ordre où ils l'ont été.
      for (const c of ctxEnAttente) {
        await api(`/services/${id}/context-links`, { method: 'POST', body: c });
      }
      ctxEnAttente = [];
    }
    $('#serviceModal').hidden = true;
    await loadLinks();
    montrerLigneService(id);
  } catch (e) { toast(explainError(e.message), true); }
});

/* Après enregistrement, on AMÈNE À la ligne au lieu de laisser chercher : un service
   nouvellement créé atterrit n'importe où dans l'ordre. Le surlignage s'efface
   tout seul — il dit « c'est ici », il n'a pas à rester. */
function montrerLigneService(id) {
  if (!id) return;
  /* SOUS UN FILTRE, LA LIGNE N'EXISTE PAS À L'ÉCRAN. On enregistrait, l'écran ne bougeait pas,
     et rien ne disait pourquoi : le service venait d'être créé hors du tag ou de la recherche
     en cours. On relâche donc ce qui le cache — l'avoir sous les yeux vaut mieux qu'un filtre
     qu'on a posé il y a dix minutes. */
  if (!$(`#linkGrid [data-editservice="${id}"]`)) {
    LINKS.tag = ''; LINKS.q = ''; LINKS.masquerVides = false;
    if ($('#linkSearch')) $('#linkSearch').value = '';
    retenirFiltresLiens();
    rafraichirLiens();
  }
  const b = $(`#linkGrid [data-editservice="${id}"]`);
  if (!b) return;
  const tr2 = b.closest('tr');
  tr2.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr2.classList.add('link-flash');
  setTimeout(() => tr2.classList.remove('link-flash'), 1600);
}
$('#serviceDelete') && $('#serviceDelete').addEventListener('click', async () => {
  if (!serviceEnCours) return;
  if (!await confirmDialog({
    title: tr('links.service.delete'), text: tr('links.service.delete-text', { name: serviceEnCours.name }),
    confirmLabel: tr('ui.delete'),
  })) return;
  try {
    await api(`/services/${serviceEnCours.id}`, { method: 'DELETE' });
    $('#serviceModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});

