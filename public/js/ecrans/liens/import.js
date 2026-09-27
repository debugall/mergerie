'use strict';
/* Import Chrome. */
// @expose pris
/* ---------- Import Chrome ---------- */

/* Tout effacer, derrière une confirmation qui ANNONCE LE NOMBRE. « Supprimer tous les liens ? »
   ne dit pas s'il y en a trois ou deux cents, et c'est exactement ce qu'on a besoin de savoir
   avant de répondre. Le message précise aussi ce qui n'est PAS touché : de là où on clique, la
   grille est juste au-dessus, et rien ne dit que « les liens » ne la désigne pas. */
async function viderLiensLibres() {
  const n = (((LINKS.grid || {}).free_links) || []).length;
  if (!n) return;
  if (!await confirmDialog({
    title: tr('links.free.delete-all'), text: tr('links.free.delete-all-text', { n, count: n }),
    confirmLabel: tr('ui.delete'), danger: true,
  })) return;
  try {
    const r = await api('/free-links', { method: 'DELETE' });
    toast(tr('links.free.deleted-all', { n: r.deleted, count: r.deleted }));
    LINKS.selection.clear();
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
}

/* Nommée, parce qu'on y entre maintenant par trois portes : le menu « Autres actions »,
   l'état vide, et rien d'autre — le bouton de barre a disparu avec la barre de configuration. */
function ouvrirImport() {
  LINKS.importLinks = [];
  $('#importPreview').hidden = true;
  $('#importApply').disabled = true;
  $('#importFile').value = '';
  $('#importModal').hidden = false;
}
$('#importCancel') && $('#importCancel').addEventListener('click', () => { $('#importModal').hidden = true; });
fermerAuFond('#importModal', () => { $('#importModal').hidden = true; }, { salissable: true });
$('#importFile') && $('#importFile').addEventListener('change', async () => {
  const f = $('#importFile').files[0];
  if (!f) return;
  try {
    const html = await f.text();
    const d = await api('/links/import', { method: 'POST', body: { html } });
    LINKS.importLinks = d.links || [];
    LINKS.importGrid = d.proposal && (d.proposal.services || []).length ? d.proposal : null;
    renderImport();
  } catch (e) { toast(explainError(e.message), true); }
});
/* L'arbre des dossiers, tel qu'il était dans le navigateur : on reconnaît son propre
   rangement, ce qui rend le choix évident. Les tags proposés viennent de ce chemin. */
function renderImport() {
  const box = $('#importTree');
  if (!LINKS.importLinks.length) {
    box.innerHTML = `<p class="muted">${esc(tr('links.import.empty'))}</p>`;
    $('#importPreview').hidden = false;
    $('#importApply').disabled = true;
    return;
  }
  renderImportProposal();
  /* Les dossiers absorbés par la grille ne sont plus proposés en liens libres : les laisser
     ferait importer deux fois la même adresse, une fois dans une case et une fois à plat. */
  const absorbes = new Set(pris());
  const parDossier = new Map();
  LINKS.importLinks.forEach((l, i) => {
    if (absorbes.has(dossierCourt(l.folder))) return;
    const d = l.folder || tr('links.import.root');
    if (!parDossier.has(d)) parDossier.set(d, []);
    parDossier.get(d).push({ ...l, i });
  });
  /* REPLIÉ, ET RIEN DE COCHÉ. Deux cents favoris cochés d'office entrent d'un clic, et on
     passe le reste de la journée à faire le tri dans une liste plate. Un dossier par ligne,
     avec son compte et sa case : on déplie celui qu'on veut, on coche, on importe douze liens.
     Choisir ce qui entre coûte dix secondes ; trier ce qui est entré coûte une demi-heure. */
  box.innerHTML = [...parDossier.entries()].map(([dossier, liens], k) => `
    <details class="import-folder-box"${k === 0 && parDossier.size === 1 ? ' open' : ''}>
      <summary>
        <input type="checkbox" class="imp-folder" data-folder="${k}" aria-label="${esc(tr('links.import.pick-folder'))}" />
        <span class="import-folder">${esc(dossier)}</span>
        <span class="muted">${esc(tr('links.import.count-folder', { n: liens.length, count: liens.length }))}</span>
      </summary>
      ${liens.map((l) => `<label class="import-item" data-in="${k}">
        <input type="checkbox" data-imp="${l.i}" />
        <span>${esc(l.label)}</span>
        <span class="import-url">${esc(l.url)}</span>
      </label>`).join('')}
    </details>`).join('');
  $('#importPreview').hidden = false;
  majImportCount();
}
/* Le chemin tel que le serveur le compte : sans la racine du navigateur, qui ne dit rien. */
const RACINES_VUES = /^(barre de favoris|autres favoris|favoris mobiles|barre personnelle|menu des marque-pages|marque-pages mobiles|autres marque-pages|bookmarks bar|bookmarks toolbar|other bookmarks|mobile bookmarks|bookmarks menu|favorites bar)\//i;
const dossierCourt = (f) => String(f || '').replace(RACINES_VUES, '');
const pris = () => (LINKS.importGrid && $('#importGrid') && $('#importGrid').checked ? LINKS.importGrid.folders : []);

function renderImportProposal() {
  const box = $('#importProposal');
  if (!box) return;
  box.hidden = !LINKS.importGrid;
  if (!LINKS.importGrid) return;
  const { environments: envs, services } = LINKS.importGrid;
  $('#importProposalTitle').textContent = tr('links.import.grid', {
    envs: tr('links.import.grid-envs', { n: envs.length, count: envs.length }),
    svcs: tr('links.import.grid-svcs', { n: services.length, count: services.length }),
  });
  /* La grille TELLE QU'ELLE SERA, pas une phrase qui la décrit : c'est en la voyant qu'on sait
     si elle a du sens, et un compte par case suffit à s'en rendre compte.
     Chaque ligne est COCHABLE parce que la détection ne peut pas tout savoir : elle ne sait pas
     que « logs · keycloak » et « logs · purge » sont, pour toi, le même service. Deux lignes
     cochées, un nom, et elles n'en font plus qu'une. */
  const entete = envs.map((e) => `<th>${esc(e)}</th>`).join('');
  /* Le nom de chaque ligne est MODIFIABLE ici : la détection le tire d'un nom de dossier, qui
     n'est pas toujours celui qu'on donnerait au service. Le corriger avant la création coûte
     une frappe ; le corriger après demande d'ouvrir la fiche du service. */
  const lignes = services.map((svc, i) => {
    const n = (env) => ((svc.cells.find((c) => c.env === env) || {}).links || []).length;
    return `<tr><td class="ig-first"><input type="checkbox" data-igrow="${i}" aria-label="${esc(tr('links.import.merge'))}" />
        <input type="text" class="ig-name" data-igname="${i}" maxlength="100" value="${esc(svc.name)}" /></td>${envs.map((e) => `<td>${n(e) || '·'}</td>`).join('')}</tr>`;
  }).join('');
  $('#importProposalTable').innerHTML = `<table class="import-grid"><thead><tr><th></th>${entete}</tr></thead><tbody>${lignes}</tbody></table>`
    + `<div class="toolbar toolbar-tight"><button type="button" id="importMerge" class="btn btn-sm" hidden>`
    + `${svgIco('merge')}<span>${esc(tr('links.import.merge'))}</span></button>`
    + `<span class="muted">${esc(tr('links.import.grid-help'))}</span></div>`;
}
$('#importGrid') && $('#importGrid').addEventListener('change', renderImport);

/* FUSIONNER DES LIGNES. La détection lit des noms de dossiers ; elle ne sait pas que deux
   d'entre eux désignent le même service chez toi. On coche, on nomme, et les cases se
   rejoignent — environnement par environnement, sans rien perdre. */
$('#importProposalTable') && $('#importProposalTable').addEventListener('change', () => {
  const n = $$('#importProposalTable [data-igrow]:checked').length;
  const b = $('#importMerge');
  if (b) b.hidden = n < 2;
});
/* On note le nom SANS re-rendre : re-rendre à chaque frappe reprendrait le focus au champ, et
   l'on ne pourrait pas écrire trois lettres d'affilée. */
$('#importProposalTable') && $('#importProposalTable').addEventListener('input', (e) => {
  const i = e.target.closest('[data-igname]');
  if (!i || !LINKS.importGrid) return;
  const svc = LINKS.importGrid.services[Number(i.dataset.igname)];
  if (svc) svc.name = i.value;
});
$('#importProposalTable') && $('#importProposalTable').addEventListener('click', (e) => {
  if (!e.target.closest('#importMerge')) return;
  const idx = $$('#importProposalTable [data-igrow]:checked').map((c) => Number(c.dataset.igrow));
  if (idx.length < 2) return;
  const choisis = idx.map((i) => LINKS.importGrid.services[i]);
  // Le nom part du préfixe commun — celui qu'on allait taper — et reste modifiable dans le tableau.
  const fusion = { name: prefixeCommun(choisis.map((s2) => s2.name)), source: choisis[0].source, cells: [] };
  for (const svc of choisis) {
    for (const cell of svc.cells) {
      let c = fusion.cells.find((x) => x.env === cell.env);
      if (!c) { c = { env: cell.env, links: [] }; fusion.cells.push(c); }
      c.links.push(...cell.links);
    }
  }
  LINKS.importGrid.services = [fusion, ...LINKS.importGrid.services.filter((s2) => !choisis.includes(s2))]
    .sort((a, b2) => a.name.localeCompare(b2.name));
  renderImport();
});

// « logs · keycloak » + « logs · purge » → « logs ». Le préfixe commun est le nom qu'on allait taper.
function prefixeCommun(noms) {
  if (!noms.length) return '';
  let p = noms[0];
  for (const n of noms.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i += 1;
    p = p.slice(0, i);
  }
  return p.replace(/[\s·\-—|]+$/, '').trim() || noms[0];
}

function majImportCount() {
  const n = $$('#importTree [data-imp]:checked').length;
  $('#importCount').textContent = tr('links.import.count', { n, count: n });
  $('#importApply').disabled = !n;
}
$('#importTree') && $('#importTree').addEventListener('change', (e) => {
  // La case d'un dossier coche ses liens ; cocher les liens à la main met la sienne d'accord.
  const f = e.target.closest('.imp-folder');
  if (f) {
    $$(`#importTree .import-item[data-in="${f.dataset.folder}"] [data-imp]`).forEach((c) => { c.checked = f.checked; });
  } else {
    $$('#importTree .import-folder-box').forEach((d) => {
      const cases = $$('[data-imp]', d);
      const chef = $('.imp-folder', d);
      if (!chef) return;
      chef.checked = cases.length > 0 && cases.every((c) => c.checked);
      chef.indeterminate = !chef.checked && cases.some((c) => c.checked);
    });
  }
  majImportCount();
});
$('#importAll') && $('#importAll').addEventListener('click', () => { $$('#importTree input[type=checkbox]').forEach((c) => { c.checked = true; c.indeterminate = false; }); majImportCount(); });
$('#importNone') && $('#importNone').addEventListener('click', () => { $$('#importTree input[type=checkbox]').forEach((c) => { c.checked = false; c.indeterminate = false; }); majImportCount(); });
$('#importApply') && $('#importApply').addEventListener('click', async (e) => {
  const choisis = $$('#importTree [data-imp]:checked').map((c) => LINKS.importLinks[Number(c.dataset.imp)]).filter(Boolean);
  const grid = LINKS.importGrid && $('#importGrid').checked ? LINKS.importGrid : null;
  try {
    const r = await busy(e.currentTarget, () => api('/links/import/apply', { method: 'POST', body: { links: choisis, grid } }));
    $('#importModal').hidden = true;
    /* Le compte des IGNORÉS est dit : un import rejoué qui ne crée rien doit s'expliquer,
       sinon il passe pour un échec silencieux. */
    /* Ce que la grille a produit est DIT : sans ça, on voit soixante-neuf liens importés et on
       cherche où sont passés les soixante-treize autres. */
    if (r.services_created || r.urls_created) {
      toast(tr('links.import.done-grid', {
        n: r.created,
        svcs: tr('links.import.grid-svcs', { n: r.services_created, count: r.services_created }),
        urls: tr('links.import.urls-n', { n: r.urls_created, count: r.urls_created }),
      }));
    } else {
      toast(r.skipped
        ? tr('links.import.done-skipped', { n: r.created, count: r.created, skipped: r.skipped })
        : tr('links.import.done', { n: r.created, count: r.created }));
    }
    await loadLinks();
  } catch (err) { toast(explainError(err.message), true); }
});

