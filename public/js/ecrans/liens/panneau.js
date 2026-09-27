'use strict';
/* Le panneau d'une case. */
/* ---------- Le panneau d'une case ---------- */

/* OÙ SE POSE LE PANNEAU.
 *
 * Une case de grille fait 190 px de large à six environnements, et l'on y lit ou saisit des
 * URLs : encastré, le champ mesurait 90 px et la liste débordait sur les colonnes voisines.
 * Le panneau reste attaché à la case — même clic, mêmes touches — mais quitte le flux : posé
 * en `position: fixed` sous elle, à sa vraie largeur. C'est ce que font déjà les menus des
 * combos, et pour la même raison : un conteneur qui défile rogne tout ce qui est en absolu.
 * Il bascule au-dessus quand le bas de l'écran manque, et se recale tant qu'il est ouvert. */
function placerPanneauCase(td, box) {
  const r = td.getBoundingClientRect();
  const marge = 8;
  const l = box.getBoundingClientRect();
  box.style.left = `${Math.max(marge, Math.min(r.left, window.innerWidth - l.width - marge))}px`;
  const dessous = window.innerHeight - r.bottom - marge;
  if (dessous < l.height && r.top - marge > dessous) {
    box.style.top = 'auto';
    box.style.bottom = `${window.innerHeight - r.top + 2}px`;
  } else {
    box.style.bottom = 'auto';
    box.style.top = `${r.bottom + 2}px`;
  }
}

/* FERMER SANS REDESSINER. Un `renderLinkGrid()` ici détacherait, au `mousedown`, le bouton
   qu'on est en train de cliquer : le `mouseup` tomberait sur un autre nœud et le clic ne serait
   jamais délivré — ouvrir le panneau d'une case voisine demanderait deux clics. On retire donc
   le panneau et rien d'autre ; la grille sous lui n'a pas changé. */
function fermerPanneauCase() {
  const box = $('.link-cell-panel');
  if (!box) return;
  const td = box.closest('.link-cell');
  box.remove();
  if (td) td.classList.remove('en-edition');
}

/* Une ligne du panneau EN LECTURE : le nom, l'URL abrégée, la dernière ouverture, copier,
   ouvrir. Le point marque les trois plus ouvertes — celles que la case montre. */
function lignePanneau(s, e, u, marquee) {
  return `<div class="lcp-row" data-url="${esc(u.url)}" data-open="${s.id}:${e.id}:${u.id}">
    <span class="lcp-dot${marquee ? ' on' : ''}" aria-hidden="true"></span>
    <span class="lcp-name">${esc(nomAdresse(u))}</span>
    <span class="lcp-url muted" title="${esc(u.url)}">${esc(urlCourte(u.url))}</span>
    <span class="lcp-when muted">${u.last_used_at ? esc(depuis(u.last_used_at)) : ''}</span>
    <button type="button" class="link-icon lcp-copy" data-copy-txt="${esc(u.url)}"
      title="${esc(tr('links.copy-url', { url: u.url }))}" aria-label="${esc(tr('links.copy-url', { url: u.url }))}">${svgIco('copy')}</button>
    <a class="link-icon lcp-open" href="${esc(safeUrl(u.url))}" target="_blank" rel="noopener noreferrer"
      data-usekind="service_url" data-useref="${s.id}:${e.id}:${u.id}"
      title="${esc(tr('links.url.open'))}" aria-label="${esc(tr('links.url.open'))}">${svgIco('external')}</a>
  </div>`;
}

/* Une ligne du panneau EN ÉDITION : un nom (facultatif — le serveur sait quoi afficher sans
   lui), l'URL, les flèches d'ordre et la corbeille. Vider une URL retire sa ligne à
   l'enregistrement ; tout vider efface la case. */
function ligneEdition(u = { label: '', url: '' }) {
  return `<div class="lce-row">
    <span class="lce-ord">
      <button type="button" class="link-icon lce-up" title="${esc(tr('links.url.up'))}" aria-label="${esc(tr('links.url.up'))}">${svgIco('up')}</button>
      <button type="button" class="link-icon lce-down" title="${esc(tr('links.url.down'))}" aria-label="${esc(tr('links.url.down'))}">${svgIco('down')}</button>
    </span>
    <input type="text" class="lce-label" maxlength="100" placeholder="${esc(tr('links.url.label-ph'))}" value="${esc(u.label || '')}" />
    <input type="url" class="lce-url" placeholder="https://…" value="${esc(u.url || '')}" />
    <button type="button" class="link-icon lce-del" title="${esc(tr('ui.delete'))}" aria-label="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>
  </div>`;
}

function ouvrirPanneauCase(td, sid, eid, { edition = false } = {}) {
  /* UN SEUL PANNEAU À LA FOIS. Deux panneaux flottants de cases voisines se recouvriraient, et
     on ne saurait plus lequel enregistre quoi. On referme donc l'autre en redessinant la
     grille — ce qui déplace la case visée : on la retrouve par ses attributs. */
  if ($('.link-cell-panel')) {
    renderLinkGrid();
    const ancre = $(`#linkGrid [data-cell="${sid}:${eid}"]`);
    if (ancre) td = ancre;
  }
  if (!td) return;
  const svc = ((LINKS.grid && LINKS.grid.services) || []).find((x) => String(x.id) === String(sid));
  const env = ((LINKS.grid && LINKS.grid.environments) || []).find((x) => String(x.id) === String(eid));
  const liste = (svc && (svc.urls || {})[eid]) || [];
  /* LE PANNEAU DIT SUR QUELLE CASE IL PORTE. Tant qu'il était encastré dans la colonne, la
     colonne le disait ; flottant, il ne le dirait plus — et on corrigerait « preprod » en
     croyant corriger « dev ». */
  const tete = `<div class="lcp-head">${esc((svc || {}).name || '')}
    <span class="lce-env"><span class="link-env-dot" style="background:${esc((env || {}).color || '')}"></span>${esc((env || {}).name || '')}</span>
    <span class="spacer"></span><span class="muted">${esc(tr('links.url.count', { n: liste.length, count: liste.length }))}</span></div>`;
  const marquees = new Set(troisPlusOuvertes(liste));
  const corps = edition
    ? `<div class="lce-rows">${(liste.length ? liste : [{ label: '', url: '' }]).map(ligneEdition).join('')}</div>
       <div class="lcp-multi" hidden><textarea class="lcp-paste" rows="3" placeholder="${esc(tr('links.paste.ph'))}"></textarea>
         <button type="button" class="btn btn-sm lcp-paste-add">${esc(tr('links.paste.add-lines'))}</button></div>
       <div class="lce-actions">
         <button type="button" class="btn btn-sm btn-ghost lce-add">${svgIco('plus')}<span>${esc(tr('links.url.add'))}</span></button>
         <button type="button" class="btn btn-sm btn-ghost lcp-multi-on">${svgIco('clip')}<span>${esc(tr('links.paste.several'))}</span></button>
         <span class="spacer"></span>
         <button type="button" class="btn btn-sm lce-cancel">${esc(tr('ui.cancel'))}</button>
         <button type="button" class="btn btn-sm btn-primary lce-save">${esc(tr('ui.save'))}</button>
       </div>
       <p class="muted lce-hint">${esc(tr('links.url.edit-hint'))}</p>`
    : `<div class="lcp-bar">
         <input type="search" class="lcp-search" placeholder="${esc(tr('links.url.filter-ph'))}" aria-label="${esc(tr('links.url.filter-ph'))}" />
         <button type="button" class="btn btn-sm lcp-edit">${svgIco('edit')}<span>${esc(tr('ui.edit'))}</span></button>
       </div>
       <div class="lcp-list">${liste.map((u) => lignePanneau(svc, env, u, marquees.has(u))).join('')}</div>
       <p class="muted lce-hint">${esc(tr('links.url.read-hint'))}</p>`;
  td.classList.add('en-edition');
  td.insertAdjacentHTML('beforeend', `<div class="link-cell-panel${edition ? ' en-edition' : ''}" data-cellfor="${sid}" data-env="${eid}">${tete}${corps}</div>`);
  const box = $('.link-cell-panel', td);
  placerPanneauCase(td, box);
  /* Le panneau ne fait plus partie du flux : il faut le suivre à la main. En capture, pour
     attraper AUSSI le défilement de la grille, qui ne remonte pas jusqu'à `window`. Le
     suiveur se retire tout seul quand la grille est redessinée. */
  const suivre = () => {
    if (!document.body.contains(box)) {
      window.removeEventListener('scroll', suivre, true);
      window.removeEventListener('resize', suivre);
      return;
    }
    placerPanneauCase(td, box);
  };
  window.addEventListener('scroll', suivre, true);
  window.addEventListener('resize', suivre);
  if (edition) {
    /* LE FOCUS NE SE POSE JAMAIS SUR UNE ADRESSE EXISTANTE SÉLECTIONNÉE. `focus()` puis
       `select()` sur la première URL d'une case déjà remplie : on venait AJOUTER une adresse,
       on tapait, et on écrasait la première sans l'avoir vue partir. On ouvre donc sur une
       ligne vide ajoutée à la fin — ou sur la seule ligne, quand la case est vide. */
    const vides = $$('.lce-url', box).filter((i) => !i.value.trim());
    if (vides.length) { vides[0].focus(); return; }
    $('.lce-rows', box).insertAdjacentHTML('beforeend', ligneEdition());
    $$('.lce-url', box).pop().focus();
    placerPanneauCase(td, box);
    return;
  }
  const s = $('.lcp-search', box);
  if (s) s.focus();
  marquerLignePanneau(box, $('.lcp-row', box));
}

const marquerLignePanneau = (box, row) => {
  $$('.lcp-row', box).forEach((r) => r.classList.toggle('cur', r === row));
  if (row) row.scrollIntoView({ block: 'nearest' });
};

// Ce que l'éditeur d'une case contient à l'instant t.
const lireCase = (box) => $$('.lce-row', box).map((r) => ({
  label: $('.lce-label', r).value.trim(),
  url: $('.lce-url', r).value.trim(),
})).filter((u) => u.url);

async function enregistrerCase(box) {
  try {
    await api(`/services/${box.dataset.cellfor}/urls`, {
      method: 'PUT',
      body: { environment_id: Number(box.dataset.env), urls: lireCase(box) },
    });
    await loadLinks();
  } catch (err) { toast(explainError(err.message), true); }
}

