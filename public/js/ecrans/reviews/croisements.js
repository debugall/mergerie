'use strict';
/* Les croisements : le badge « croise !214 · 3 fichiers · 2 j » et son panneau ancré sur la carte.
   Zéro réseau : tout vient de la liste (`overlaps`, `files_fetch`), calculé en base à la découverte.
   Un croisement est un FAIT — deux MR ouvertes du même dépôt qui touchent le même fichier — pas un
   jugement : le panneau montre, l'humain décide l'ordre des merges. */

/* L'âge court du badge : « 2 j », « 5 h », « 12 min » — pas la phrase du survol. */
function ageCourt(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 60) return tr('mr.croise.age.min', { n: m });
  if (m < 1440) return tr('mr.croise.age.hour', { n: Math.floor(m / 60) });
  return tr('mr.croise.age.day', { n: Math.floor(m / 1440) });
}

/* Ce que le badge et le panneau affichent, pour la signature de re-rendu des cartes. */
function sigCroise(m) {
  const liste = (m && m.overlaps) || [];
  const f = m && m.files_fetch;
  return `${liste.map((o) => `${o.id}:${o.shared}`).join(',')}|${f ? `${f.sha}:${f.refused || ''}` : ''}`;
}

/* Ce que chaque badge sait de sa merge request : relu à l'ouverture du panneau, sans refaire
   d'appel — la liste a déjà tout. */
const croiseParMr = new Map();

/* Le badge : une MR croisée → son numéro, les fichiers communs, son âge ; plusieurs → le compte,
   le détail est dans le panneau. Aucun badge sans croisement, et aucun tant que la liste n'est
   pas relevée : un badge qui dit « rien » mentirait. */
function badgeCroise(m) {
  const liste = (m && m.overlaps) || [];
  if (!liste.length) return '';
  croiseParMr.set(Number(m.id), { overlaps: liste, files_fetch: m.files_fetch || null });
  const texte = liste.length === 1
    ? tr('mr.croise.one', {
      iid: liste[0].iid,
      files: tr('mr.croise.files', { n: liste[0].shared, count: liste[0].shared }),
      age: ageCourt(liste[0].created_at),
    })
    : tr('mr.croise.many', { n: liste.length, count: liste.length });
  return `<button type="button" class="tag croise" data-croise="${m.id}" aria-haspopup="dialog" aria-expanded="false"`
    + ` title="${esc(tr('mr.croise.title'))}">${svgIco('branch')} ${esc(texte)}</button>`;
}

function panneauCroise(id, d) {
  const liste = d.overlaps || [];
  const f = d.files_fetch || {};
  return `<div class="croise-panel" role="dialog" data-croise-panel="${id}" aria-label="${esc(tr('mr.croise.panel.title', { n: liste.length, count: liste.length }))}">
    <div class="croise-head"><strong>${esc(tr('mr.croise.panel.title', { n: liste.length, count: liste.length }))}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    ${liste.map((o) => `<div class="croise-mr">
      <button type="button" class="croise-go" data-croise-go="${o.id}" data-croise-status="${esc(o.status || '')}" title="${esc(tr('mr.croise.go'))}">!${esc(o.iid)} — ${esc(o.title || '')}${o.author ? ` · ${esc(o.author)}` : ''}${o.created_at ? ` · ${esc(tr('mr.croise.opened', { age: depuis(o.created_at) }))}` : ''}${o.note != null ? ` · ${esc(fmtNote10(o.note * 10))}` : ''}</button>
      <ul class="croise-paths">${(o.paths || []).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}${o.shared > (o.paths || []).length ? `<li class="muted">${esc(tr('mr.croise.more', { n: o.shared - o.paths.length, count: o.shared - o.paths.length }))}</li>` : ''}</ul>
    </div>`).join('')}
    ${f.sha ? `<div class="croise-foot muted">${esc(tr('mr.croise.fetched', { sha: String(f.sha).slice(0, 8) }))} · <span data-when="${esc(f.at || '')}">${esc(depuis(f.at))}</span></div>` : ''}
  </div>`;
}

let panneauOuvert = null;
function fermerCroisements() {
  if (!panneauOuvert) return;
  panneauOuvert.remove();
  panneauOuvert = null;
  $$('[data-croise][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  $$('.croise-open').forEach((el) => el.classList.remove('croise-open'));
}
/* Ancré sur la carte : la carte passe en `position: relative` (et au-dessus des suivantes), la
   liste débloque son overflow — la même mécanique que le menu « ⋯ ». Le panneau part du badge
   et reste dans la largeur de la carte. */
function ouvrirCroisements(b) {
  const id = Number(b.dataset.croise);
  const d = croiseParMr.get(id);
  if (!d) return;
  fermerCroisements();
  if (typeof closeSplitMenus === 'function') closeSplitMenus();
  const carte = b.closest('.card') || b.parentElement;
  carte.classList.add('croise-open');
  const liste = carte.closest('.list'); if (liste) liste.classList.add('croise-open');
  carte.insertAdjacentHTML('beforeend', panneauCroise(id, d));
  panneauOuvert = carte.querySelector('.croise-panel');
  const gauche = Math.max(0, Math.min(b.offsetLeft, carte.clientWidth - panneauOuvert.offsetWidth - 8));
  panneauOuvert.style.top = `${b.offsetTop + b.offsetHeight + 4}px`;
  panneauOuvert.style.left = `${gauche}px`;
  b.setAttribute('aria-expanded', 'true');
  const premier = panneauOuvert.querySelector('.croise-go');
  if (premier) premier.focus();
}

/* Chaque ligne mène à l'autre merge request dans Reviews : sa carte si elle est à traiter, son
   rapport sinon. */
async function allerALaMr(id, status) {
  fermerCroisements();
  if (status !== 'to_review') { navMrReport(id); return; }
  navTab('review');
  await loadSegment('to_review');
  const carte = $(`#toReviewList .card[data-id="${id}"]`);
  if (!carte) return;
  carte.scrollIntoView({ block: 'center', behavior: 'smooth' });
  carte.classList.add('just-landed');
  carte.addEventListener('animationend', () => carte.classList.remove('just-landed'), { once: true });
}

document.addEventListener('click', (e) => {
  const badge = e.target.closest && e.target.closest('[data-croise]');
  if (badge) {
    e.stopPropagation();
    if (badge.getAttribute('aria-expanded') === 'true') fermerCroisements(); else ouvrirCroisements(badge);
    return;
  }
  const go = e.target.closest && e.target.closest('[data-croise-go]');
  if (go) { e.stopPropagation(); allerALaMr(Number(go.dataset.croiseGo), go.dataset.croiseStatus); return; }
  if (e.target.closest && e.target.closest('[data-croise-close]')) { e.stopPropagation(); fermerCroisements(); return; }
  // Un clic n'importe où ailleurs referme le panneau — sauf dedans (un chemin qu'on sélectionne).
  if (panneauOuvert && !(e.target.closest && e.target.closest('.croise-panel'))) fermerCroisements();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panneauOuvert) { fermerCroisements(); e.stopPropagation(); }
});
