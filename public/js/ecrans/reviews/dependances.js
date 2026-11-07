'use strict';
/* Les dépendances ajoutées : « +2 dépendances » (accentué dès qu'une entre) ou « 3 dépendances
   changées » (discret), « · 1 majeur » quand un passage de majeur se lit, dans la rangée des
   pastilles après les tests touchés — et son panneau ancré : une ligne par dépendance, groupées
   par manifeste quand il y en a plusieurs. Zéro réseau : tout vient de la liste (`deps`), lu en
   base sur le diff des manifestes gardé au relevé. Le badge compte, le panneau nomme, l'humain
   décide si ce paquet méritait d'entrer. Aucun lien vers un registre : le nom se copie. */

function sigDeps(m) {
  const c = m && m.deps;
  return c ? `${c.added}:${c.changed}:${c.removed}:${c.major}:${c.unparsed}:${c.refused || ''}:${(c.fetch || {}).sha || ''}` : '';
}

const depsParMr = new Map();

/* Rien sans manifeste touché ni diff gardé ; rien quand les manifestes touchés ne se lisent pas. */
function badgeDeps(m) {
  const c = m && m.deps;
  if (!c || c.added + c.changed + c.removed === 0) return '';
  depsParMr.set(Number(m.id), c);
  const majeur = c.major ? ` · ${tr('mr.deps.major', { n: c.major, count: c.major })}` : '';
  const texte = c.added
    ? `${tr('mr.deps.added', { n: c.added, count: c.added })}${majeur}`
    : `${tr('mr.deps.changed', { n: c.changed + c.removed, count: c.changed + c.removed })}${majeur}`;
  return `<button type="button" class="tag deps${c.added ? ' alert' : ''}" data-deps="${m.id}" aria-haspopup="dialog" aria-expanded="false"`
    + ` title="${esc(tr('mr.deps.title'))}">${esc(texte)}</button>`;
}

function lienMotifsDeps(src) {
  if (!src) return '';
  if (src.kind === 'repo') return `<button type="button" class="croise-go" data-deps-motifs="repo:${src.repo_id}">${esc(tr('mr.tests.patterns.repo'))}</button>`;
  if (src.kind === 'group') {
    return (src.groups || []).map((g) => `<button type="button" class="croise-go" data-deps-motifs="group:${g.id}">${esc(tr('mr.tests.patterns.group', { name: g.name }))}</button>`).join(' + ');
  }
  return `<button type="button" class="croise-go" data-deps-motifs="config">${esc(tr(src.kind === 'config' ? 'mr.tests.patterns.config' : 'mr.tests.patterns.default'))}</button>`;
}

const sectionDeps = (s) => (s === 'dev' ? tr('mr.deps.section.dev') : (s === 'prod' ? tr('mr.deps.section.prod') : tr('mr.deps.section.unknown')));

/* Les lignes d'un manifeste : ajoutées, puis changées, puis retirées, dans l'ordre du fichier. */
function lignesManifeste(a) {
  if (!a.parser) return `<li class="deps-unparsed muted">${esc(tr('mr.deps.unparsed'))}</li>`;
  const l = [];
  for (const e of a.added) l.push(`<li><code>${esc(e.name)}</code> <span class="deps-ver">${esc(e.version || '')}</span> <span class="deps-kind add">${esc(tr('mr.deps.row.added'))}</span> · ${esc(sectionDeps(e.section))}</li>`);
  for (const e of a.changed) {
    const maj = e.major === true ? ` <span class="deps-kind major">${esc(tr('mr.deps.row.major'))}</span>` : (e.major === null ? ` <span class="muted">${esc(tr('mr.deps.row.major-unknown'))}</span>` : '');
    l.push(`<li><code>${esc(e.name)}</code> <span class="deps-ver">${esc(e.from || '')} → ${esc(e.to || '')}</span>${maj} · ${esc(sectionDeps(e.section))}</li>`);
  }
  for (const e of a.removed) l.push(`<li><code>${esc(e.name)}</code> <span class="deps-kind del">${esc(tr('mr.deps.row.removed'))}</span> · ${esc(sectionDeps(e.section))}</li>`);
  return l.join('');
}

function panneauDeps(id, c) {
  const f = c.fetch || {};
  const plusieurs = (c.manifests || []).length > 1;
  return `<div class="croise-panel deps-panel" role="dialog" data-deps-panel="${id}" aria-label="${esc(tr('mr.deps.panel.title'))}">
    <div class="croise-head"><strong>${esc(tr('mr.deps.panel.title'))}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    <div class="muted">${esc(tr('mr.deps.panel.sub', { added: c.added, changed: c.changed, removed: c.removed }))}</div>
    ${(c.manifests || []).map((a) => `${plusieurs ? `<div class="deps-manifest"><code>${esc(a.path)}</code></div>` : ''}<ul class="croise-paths deps-rows">${lignesManifeste(a)}</ul>`).join('')}
    ${c.refused ? `<p class="croise-mr muted">${esc(tr('mr.deps.refused'))}</p>` : ''}
    <div class="croise-foot muted">${esc(tr('mr.deps.panel.patterns'))} ${lienMotifsDeps(c.patterns)}</div>
    ${f.sha ? `<div class="croise-foot muted">${esc(tr('mr.croise.fetched', { sha: String(f.sha).slice(0, 8) }))} · <span data-when="${esc(f.at || '')}">${esc(depuis(f.at))}</span></div>` : ''}
  </div>`;
}

document.addEventListener('click', (e) => {
  const badge = e.target.closest && e.target.closest('[data-deps]');
  if (badge) {
    e.stopPropagation();
    if (badge.getAttribute('aria-expanded') === 'true') { fermerPanneauAncre(); return; }
    const c = depsParMr.get(Number(badge.dataset.deps));
    if (c) ouvrirPanneauAncre(badge, panneauDeps(Number(badge.dataset.deps), c));
    return;
  }
  const lien = e.target.closest && e.target.closest('[data-deps-motifs]');
  if (lien) { e.stopPropagation(); ouvrirMotifs(lien.dataset.depsMotifs, 'manifest_patterns'); }
});
