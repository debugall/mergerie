'use strict';
/* Les gestes : de la barre, de la grille, réordonner au glisser, le clavier, des liens libres. */
// @expose naviguerGrilleLiens
/* ---------- Les gestes de la barre ---------- */

$('#linkCols') && $('#linkCols').addEventListener('click', (e) => {
  const b = e.target.closest('[data-linkenv]');
  if (!b) return;
  const id = Number(b.dataset.linkenv);
  if (LINKS.envsCaches.has(id)) LINKS.envsCaches.delete(id); else LINKS.envsCaches.add(id);
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkCols') && $('#linkCols').addEventListener('change', (e) => {
  if (!e.target.closest('#linkHideEmpty')) return;
  LINKS.masquerVides = e.target.checked;
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkTagMenu') && $('#linkTagMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-linktag]');
  if (!b) return;
  closeSplitMenus();
  LINKS.tag = LINKS.tag === b.dataset.linktag ? '' : b.dataset.linktag;
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkFilterChips') && $('#linkFilterChips').addEventListener('click', (e) => {
  if (!e.target.closest('[data-untag]')) return;
  LINKS.tag = '';
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkClearFilters') && $('#linkClearFilters').addEventListener('click', () => {
  LINKS.envsCaches.clear(); LINKS.tag = ''; LINKS.masquerVides = false; LINKS.q = '';
  if ($('#linkSearch')) $('#linkSearch').value = '';
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkSearch') && $('#linkSearch').addEventListener('input', () => {
  LINKS.q = $('#linkSearch').value.trim().toLowerCase();
  renderLinkBarre();
  renderLinkGrid();
  renderFreeLinks();
});
/* TAPER PUIS ENTRÉE OUVRE. On cherchait « latence », on lisait la réponse, et il fallait
   reprendre la souris pour cliquer dessus. `↓` entre dans la grille au clavier. */
$('#linkSearch') && $('#linkSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    const c = $('#linkGrid .link-cell:not(.vide)');
    if (c) { e.preventDefault(); c.focus(); }
    return;
  }
  if (e.key !== 'Enter') return;
  const a = $('#linkGrid .link-open, #linkFreeList .link-free-label');
  if (a) { e.preventDefault(); a.click(); }
});

const menuLiens = (bouton, menu) => {
  const b = $(bouton);
  if (!b) return;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const ouvrir = $(menu).hidden;
    closeSplitMenus();
    $(menu).hidden = !ouvrir;
    b.setAttribute('aria-expanded', String(ouvrir));
  });
};
menuLiens('#linkTagBtn', '#linkTagMenu');
menuLiens('#linkMore', '#linkMoreMenu');

$('#linkMoreMenu') && $('#linkMoreMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-more]');
  if (!b) return;
  closeSplitMenus();
  const quoi = b.dataset.more;
  if (quoi === 'import') { ouvrirImport(); return; }
  if (quoi === 'newenv') { openEnvModal(null); return; }
  if (quoi === 'newservice') { openServiceModal(null); return; }
  if (quoi === 'select') {
    LINKS.selectMode = !LINKS.selectMode;
    if (!LINKS.selectMode) LINKS.selection.clear();
    renderFreeLinks();
    return;
  }
  if (quoi === 'wipe') viderLiensLibres();
});
$('#linkPaste') && $('#linkPaste').addEventListener('click', () => ouvrirCollage(''));

/* COLLER SUR L'ONGLET. `Ctrl+V` hors d'un champ ouvre le dialogue pré-rempli — comme coller
   une capture ouvre le contexte d'une merge request. C'est le geste qu'on a déjà fait cent
   fois ailleurs, et il n'y a rien à apprendre. */
document.addEventListener('paste', (e) => {
  const t = $('#tab-links');
  if (!t || !t.classList.contains('active')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if ($$('.modal').some((m) => !m.hidden)) return;
  const texte = (e.clipboardData && e.clipboardData.getData('text')) || '';
  if (!/https?:\/\//i.test(texte)) return;
  e.preventDefault();
  ouvrirCollage(texte);
});

/* ---------- Les gestes de la grille ---------- */

/* Ouvrir TOUTES les adresses d'un environnement, dans l'ordre de la grille. Le navigateur
   bloque les fenêtres non demandées : on ouvre depuis le CLIC, sans await entre deux, et on
   prévient quand il y en a beaucoup — c'est le seul moment où l'on peut encore reculer. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-envopen]');
  if (!b) return;
  const envId = Number(b.dataset.envopen);
  const services = ((LINKS.grid && LINKS.grid.services) || []);
  const adresses = [];
  for (const s of services) for (const u of (((s.urls || {})[envId]) || [])) adresses.push({ s, u });
  if (!adresses.length) { toast(tr('links.env.open-none'), true); return; }
  if (adresses.length > 3 && !await confirmDialog({
    title: tr('links.env.open-all'),
    text: tr('links.env.open-confirm', { n: adresses.length, count: adresses.length }),
    confirmLabel: tr('links.env.open-go'),
  })) return;
  for (const { s, u } of adresses) {
    api('/launcher/used', { method: 'POST', body: { kind: 'service_url', ref: `${s.id}:${envId}:${u.id}` } }).catch(() => {});
    window.open(safeUrl(u.url), '_blank', 'noopener,noreferrer');
  }
});

$('#linkGrid') && $('#linkGrid').addEventListener('click', async (e) => {
  const vide = e.target.closest('[data-empty-act]');
  if (vide) {
    if (vide.dataset.emptyAct === 'import') { ouvrirImport(); return; }
    ouvrirCollage(($('#linkEmptyUrl') || {}).value || '');
    return;
  }
  const mv = e.target.closest('[data-envmove]');
  if (mv) {
    /* LA FLÈCHE DÉPLACE VERS LA COLONNE VOISINE VISIBLE. Elle était calculée sur TOUTES les
       colonnes mais rendue sur les visibles : sous filtre, on cliquait et rien ne semblait se
       passer — l'échange avait lieu avec une colonne masquée. Les masquées gardent leur place
       dans l'ordre global (voir `ordreCompletEnvs`), elles ne partent pas à la fin. */
    busy(mv, async () => {
      const vus = envsVisibles().map((x) => x.id);
      const i = vus.indexOf(Number(mv.dataset.envmove));
      const j = i + Number(mv.dataset.dir);
      if (i < 0 || j < 0 || j >= vus.length) return;
      [vus[i], vus[j]] = [vus[j], vus[i]];
      try {
        await api('/environments/reorder', { method: 'POST', body: { ids: ordreCompletEnvs(vus) } });
        await loadLinks();
      } catch (err) { toast(explainError(err.message), true); }
    });
    return;
  }
  const ee = e.target.closest('[data-envedit]');
  if (ee) {
    const env = ((LINKS.grid && LINKS.grid.environments) || []).find((x) => x.id === Number(ee.dataset.envedit));
    if (env) openEnvModal(env);
    return;
  }
  /* L'ÉPINGLE EST DANS LA LIGNE, et c'est une épingle. Elle se réglait dans la fiche du
     service et s'affichait avec une icône ÉTIQUETTE — deux raisons de ne pas la trouver. */
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const s = ((LINKS.grid && LINKS.grid.services) || []).find((x) => x.id === Number(pin.dataset.pin));
    if (!s) return;
    try {
      await api(`/services/${s.id}`, { method: 'PUT', body: { pinned: s.pinned ? 0 : 1 } });
      await loadLinks();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const ctx = e.target.closest('[data-ctxopen]');
  if (ctx) { openServiceModal(Number(ctx.dataset.ctxopen), { section: 'ctx' }); return; }
  const panneau = e.target.closest('[data-cellpanel]');
  if (panneau) {
    const [sid, eid] = panneau.dataset.cellpanel.split(':');
    ouvrirPanneauCase(panneau.closest('.link-cell'), sid, eid);
    return;
  }
  const add = e.target.closest('[data-addurl]');
  if (add) { ouvrirPanneauCase(add.closest('.link-cell'), add.dataset.addurl, add.dataset.env, { edition: true }); return; }
  const maj = e.target.closest('[data-editurl]');
  if (maj) { ouvrirPanneauCase(maj.closest('.link-cell'), maj.dataset.editurl, maj.dataset.env, { edition: true }); return; }
  const box = e.target.closest('.link-cell-panel');
  if (box) { gestesPanneau(e, box); return; }
  const ed = e.target.closest('[data-editservice]');
  if (ed) { openServiceModal(Number(ed.dataset.editservice)); return; }
  /* UNE CASE À UNE ADRESSE EST CLIQUABLE EN ENTIER : le clic sur le blanc de la case ouvre
     l'adresse, exactement comme le clic sur son nom. */
  const cell = e.target.closest('.link-cell.une');
  if (cell && !e.target.closest('a, button')) {
    const a = $('.link-open', cell);
    if (a) a.click();
  }
});

function gestesPanneau(e, box) {
  const td = box.closest('.link-cell');
  if (e.target.closest('.lcp-edit')) {
    ouvrirPanneauCase(td, box.dataset.cellfor, box.dataset.env, { edition: true });
    return;
  }
  if (e.target.closest('.lce-add')) {
    $('.lce-rows', box).insertAdjacentHTML('beforeend', ligneEdition());
    $$('.lce-url', box).pop().focus();
    placerPanneauCase(td, box);
    return;
  }
  if (e.target.closest('.lcp-multi-on')) {
    const m = $('.lcp-multi', box);
    m.hidden = !m.hidden;
    if (!m.hidden) $('.lcp-paste', m).focus();
    placerPanneauCase(td, box);
    return;
  }
  /* COLLER PLUSIEURS ADRESSES D'UN COUP. Une par ligne : ajouter trois adresses à la même case
     demandait sept clics et deux écrans. Le libellé se propose depuis le chemin — c'est ce qui
     distingue une adresse d'une autre au même endroit. */
  if (e.target.closest('.lcp-paste-add')) {
    const ta = $('.lcp-paste', box);
    const urls = String(ta.value || '').split(/\r?\n/).map((l) => (l.match(/https?:\/\/\S+/i) || [''])[0]).filter(Boolean);
    if (!urls.length) { toast(tr('links.paste.none'), true); return; }
    const rows = $('.lce-rows', box);
    // Une ligne vide déjà ouverte accueille la première adresse : sinon on la laisserait derrière.
    for (const u of urls) {
      const libre = $$('.lce-row', rows).find((r) => !$('.lce-url', r).value.trim());
      const cible = libre || (rows.insertAdjacentHTML('beforeend', ligneEdition()), $$('.lce-row', rows).pop());
      $('.lce-url', cible).value = u;
      if (!$('.lce-label', cible).value.trim()) $('.lce-label', cible).value = nomProposeAdresse(u);
    }
    ta.value = '';
    $('.lcp-multi', box).hidden = true;
    placerPanneauCase(td, box);
    return;
  }
  const ord = e.target.closest('.lce-up, .lce-down');
  if (ord) {
    const row = ord.closest('.lce-row');
    const voisin = ord.classList.contains('lce-up') ? row.previousElementSibling : row.nextElementSibling;
    if (voisin && voisin.classList.contains('lce-row')) {
      row.parentNode.insertBefore(ord.classList.contains('lce-up') ? row : voisin, ord.classList.contains('lce-up') ? voisin : row);
    }
    return;
  }
  // Retirer la dernière ligne la vide au lieu de la supprimer : sinon la case n'aurait plus
  // de champ où écrire, et il faudrait ressortir puis rentrer pour repartir.
  const del = e.target.closest('.lce-del');
  if (del) {
    const rows = $$('.lce-row', box);
    if (rows.length > 1) del.closest('.lce-row').remove();
    else { $('.lce-label', rows[0]).value = ''; $('.lce-url', rows[0]).value = ''; }
    placerPanneauCase(td, box);
    return;
  }
  if (e.target.closest('.lce-cancel')) { renderLinkGrid(); return; }
  if (e.target.closest('.lce-save')) { enregistrerCase(box); return; }
  const row = e.target.closest('.lcp-row');
  if (row && !e.target.closest('a, button')) { marquerLignePanneau(box, row); $('.lcp-open', row).click(); }
}

/* LE TAMIS DU PANNEAU masque des lignes sans rien décocher, comme partout ailleurs ici. */
$('#linkGrid') && $('#linkGrid').addEventListener('input', (e) => {
  const s = e.target.closest('.lcp-search');
  if (!s) return;
  const box = s.closest('.link-cell-panel');
  const q = s.value.trim().toLowerCase();
  const vues = $$('.lcp-row', box).filter((r) => {
    const ok = !q || `${$('.lcp-name', r).textContent} ${r.dataset.url}`.toLowerCase().includes(q);
    r.hidden = !ok;
    return ok;
  });
  marquerLignePanneau(box, vues[0]);
});

$('#linkGrid') && $('#linkGrid').addEventListener('keydown', (e) => {
  const box = e.target.closest('.link-cell-panel');
  if (!box) return;
  if (e.key === 'Escape') { e.preventDefault(); renderLinkGrid(); return; }
  if (box.classList.contains('en-edition')) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    enregistrerCase(box);
    return;
  }
  const vues = $$('.lcp-row', box).filter((r) => !r.hidden);
  const i = vues.findIndex((r) => r.classList.contains('cur'));
  if (e.key === 'ArrowDown') { e.preventDefault(); marquerLignePanneau(box, vues[Math.min(i + 1, vues.length - 1)]); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); marquerLignePanneau(box, vues[Math.max(i - 1, 0)]); return; }
  if (e.key === 'Enter' && vues[i]) { e.preventDefault(); $('.lcp-open', vues[i]).click(); }
});

/* …ET ÉCHAP LE FERME D'OÙ QU'ON SOIT. Le gestionnaire ci-dessus exige que la touche soit
   frappée DANS le panneau : dès qu'une action y renvoie le focus ailleurs — coller plusieurs
   adresses redessine son corps, et le focus retombe sur le document —, Échap ne l'atteignait
   plus et le panneau ne se fermait qu'à la souris. On le ferme donc ici aussi, en dernier
   recours, et par `fermerPanneauCase()` : re-rendre la grille détacherait l'élément sous le
   curseur, ce qui est précisément le défaut corrigé plus haut. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const box = $('.link-cell-panel');
  if (!box || (e.target && e.target.closest && e.target.closest('.link-cell-panel'))) return;
  e.preventDefault();
  fermerPanneauCase();
}, true);

/* Le panneau se ferme AU CLIC EXTÉRIEUR. Il ne se fermait qu'en cliquant « Annuler » ou en
   appuyant sur Échap : on cliquait ailleurs, il restait, et deux cases semblaient ouvertes. */
document.addEventListener('mousedown', (e) => {
  const box = $('.link-cell-panel');
  if (!box || box.contains(e.target) || e.target.closest('.modal, .toast')) return;
  fermerPanneauCase();
});

/* ---------- Réordonner au glisser ---------- */

/* UN SEUL ENREGISTREMENT À LA DÉPOSE. Déplacer une colonne de la sixième à la première coûtait
   cinq clics, cinq appels et cinq rechargements de la grille — et cinq visées, la colonne
   bougeant sous le curseur. On déplace dans le DOM pendant le geste (sans quoi on lâche à
   l'aveugle) et on n'écrit qu'une fois. */
/* LES COLONNES MASQUÉES GARDENT LEUR PLACE. On n'envoie que ce qu'on voit — c'est tout ce que
   l'écran connaît —, et les masquées reprennent les créneaux qu'elles occupaient : sans ça,
   déplacer une colonne alors qu'une autre est masquée renverrait la masquée à la fin, et son
   ordre changerait sans que rien ne l'ait montré. */
function ordreCompletEnvs(visibles) {
  const tous = ((LINKS.grid || {}).environments || []).map((e) => e.id);
  const suite = [...visibles];
  return tous.map((id) => (visibles.includes(id) ? suite.shift() : id));
}

let tireCol = null;
let tireLigne = null;
$('#linkGrid') && $('#linkGrid').addEventListener('dragstart', (e) => {
  const th = e.target.closest('th.link-col');
  if (th) { tireCol = th; th.classList.add('dragging'); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; return; }
  const poignee = e.target.closest('.link-move');
  if (!poignee) return;
  tireLigne = poignee.closest('tr.link-grid-row');
  tireLigne.classList.add('dragging');
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
});
$('#linkGrid') && $('#linkGrid').addEventListener('dragover', (e) => {
  if (tireCol) {
    const cible = e.target.closest('th.link-col');
    if (!cible || cible === tireCol) return;
    e.preventDefault();
    const r = cible.getBoundingClientRect();
    cible.parentNode.insertBefore(tireCol, e.clientX < r.left + r.width / 2 ? cible : cible.nextSibling);
    return;
  }
  if (!tireLigne) return;
  const cible = e.target.closest('tr.link-grid-row');
  // On ne traverse pas la frontière des épinglés : « épinglé » veut dire « en tête ».
  if (!cible || cible === tireLigne || cible.dataset.pinned !== tireLigne.dataset.pinned) return;
  e.preventDefault();
  const r = cible.getBoundingClientRect();
  cible.parentNode.insertBefore(tireLigne, e.clientY < r.top + r.height / 2 ? cible : cible.nextSibling);
});
$('#linkGrid') && $('#linkGrid').addEventListener('drop', (e) => { if (tireCol || tireLigne) e.preventDefault(); });
$('#linkGrid') && $('#linkGrid').addEventListener('dragend', async () => {
  const col = tireCol; const ligne = tireLigne;
  tireCol = null; tireLigne = null;
  if (col) {
    col.classList.remove('dragging');
    const ids = ordreCompletEnvs($$('#linkGrid th.link-col').map((x) => Number(x.dataset.envcol)));
    try { await api('/environments/reorder', { method: 'POST', body: { ids } }); await loadLinks(); }
    catch (err) { toast(explainError(err.message), true); await loadLinks(); }
    return;
  }
  if (!ligne) return;
  ligne.classList.remove('dragging');
  const ids = $$('#linkGrid tr.link-grid-row').map((x) => Number(x.dataset.service));
  try { await api('/services/reorder', { method: 'POST', body: { ids } }); await loadLinks(); }
  catch (err) { toast(explainError(err.message), true); await loadLinks(); }
});

/* ---------- Le clavier dans la grille ---------- */

/* `j`/`k` LES LIGNES, `←`/`→` LES CASES, `Entrée` OUVRE, `e` MODIFIE, `c` COPIE. La palette
   faisait déjà mieux que la souris, mais seulement si l'on savait qu'elle existait ; l'onglet
   lui-même n'avait aucune touche. */
function naviguerGrilleLiens(e) {
  const cur = $('#linkGrid .link-cell:focus');
  if (!cur) return false;
  const tr2 = cur.closest('tr');
  const cases = $$('.link-cell', tr2);
  const col = cases.indexOf(cur);
  const lignes = $$('#linkGrid tr.link-grid-row');
  const rang = lignes.indexOf(tr2);
  const aller = (l, c) => {
    const cible = l && $$('.link-cell', l)[Math.min(c, $$('.link-cell', l).length - 1)];
    if (cible) { e.preventDefault(); cible.focus(); }
  };
  switch (e.key) {
    case 'j': case 'ArrowDown': aller(lignes[rang + 1], col); return true;
    case 'k': case 'ArrowUp': aller(lignes[rang - 1], col); return true;
    case 'ArrowLeft': aller(tr2, Math.max(0, col - 1)); return true;
    case 'ArrowRight': aller(tr2, Math.min(cases.length - 1, col + 1)); return true;
    case 'Enter': {
      e.preventDefault();
      const plus = $('[data-cellpanel]', cur);
      if (plus) { plus.click(); return true; }
      const a = $('.link-open', cur);
      if (a) a.click(); else { const p = $('.link-add', cur); if (p) p.click(); }
      return true;
    }
    case 'e': {
      e.preventDefault();
      const [sid, eid] = cur.dataset.cell.split(':');
      ouvrirPanneauCase(cur, sid, eid, { edition: true });
      return true;
    }
    case 'c': {
      const a = $('.link-copy', cur);
      if (a) { e.preventDefault(); a.click(); }
      return true;
    }
    case 'Escape': cur.blur(); return true;
    default: return false;
  }
}

/* ---------- Les gestes des liens libres ---------- */

$('#linkFreeExpand') && $('#linkFreeExpand').addEventListener('click', () => plierLiens(true));
$('#linkFreeFold') && $('#linkFreeFold').addEventListener('click', () => plierLiens(false));
/* Recliquer sur le bouton actif REVIENT AU DÉFAUT — le premier niveau. Sans ça, on ne pourrait
   plus y retourner qu'en vidant son stockage. */
const plierLiens = (valeur) => {
  LINKS.freeDeplie = LINKS.freeDeplie === valeur ? null : valeur;
  retenirFiltresLiens();
  renderFreeLinks();
};
$('#linkFreeAll') && $('#linkFreeAll').addEventListener('click', (e) => {
  const visibles = ((LINKS.grid && LINKS.grid.free_links) || []).filter(freeVisible);
  if (e.currentTarget.dataset.complet) visibles.forEach((l) => LINKS.selection.delete(l.id));
  else visibles.forEach((l) => LINKS.selection.add(l.id));
  renderFreeLinks();
});
$('#linkToService') && $('#linkToService').addEventListener('click', () => ouvrirRangement([...LINKS.selection]));

$('#linkFreeList') && $('#linkFreeList').addEventListener('click', async (e) => {
  /* Plier ou déplier UN dossier et tout ce qu'il contient. Le geste est local et ne se retient
     pas : c'est un coup d'œil, pas une préférence. */
  const fold = e.target.closest('[data-foldsub]');
  if (fold) {
    e.preventDefault();
    e.stopPropagation();
    const sous = $$('details', fold.closest('details'));
    const tousOuverts = sous.length > 0 && sous.every((d) => d.open);
    sous.forEach((d) => { d.open = !tousOuverts; });
    $('use', fold).setAttribute('href', tousOuverts ? '#i-unfold' : '#i-fold');
    return;
  }
  const ra = e.target.closest('[data-filefree]');
  if (ra) { ouvrirRangement([Number(ra.dataset.filefree)]); return; }
  const ed = e.target.closest('[data-editfree]');
  if (ed) { openFreeModal(Number(ed.dataset.editfree)); return; }
  /* SUPPRIMER SANS MODALE, AVEC ANNULATION. Il fallait le crayon, puis « Supprimer », puis
     confirmer — trois écrans pour retirer un favori importé par erreur. Le toast d'annulation
     existe déjà ailleurs, et il répond mieux à la question : on voit ce qui est parti. */
  const del = e.target.closest('[data-delfree]');
  if (del) {
    const l = ((LINKS.grid && LINKS.grid.free_links) || []).find((x) => x.id === Number(del.dataset.delfree));
    if (!l) return;
    try {
      await api(`/free-links/${l.id}`, { method: 'DELETE' });
      await loadLinks();
      toastUndo(tr('links.free.deleted', { label: l.label }), async () => {
        try {
          await api('/free-links', { method: 'POST', body: { label: l.label, url: l.url, tags: (l.tags || []).join(','), folder: l.folder || '' } });
          await loadLinks();
        } catch (err) { toast(explainError(err.message), true); }
      });
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const pick = e.target.closest('[data-freepick]');
  if (pick) {
    const id = Number(pick.dataset.freepick);
    if (pick.checked) LINKS.selection.add(id); else LINKS.selection.delete(id);
    // Le compte du bouton SUIT LA COCHE : il ne se recalculait qu'au rendu suivant.
    renderFreeLinks();
  }
});

