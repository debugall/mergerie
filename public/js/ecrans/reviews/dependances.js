'use strict';
/* Les dépendances ajoutées : « +2 dépendances » (accentué dès qu'une entre) ou « 3 dépendances
   changées » (discret), « · 1 majeur » quand un passage de majeur se lit, dans la rangée des
   pastilles après les tests touchés — et son panneau ancré : une ligne par dépendance, groupées
   par manifeste quand il y en a plusieurs. Zéro réseau ici : tout vient de la liste (`deps`), lu en
   base sur le diff des manifestes gardé au relevé. Le badge compte, le panneau nomme, l'humain
   décide si ce paquet méritait d'entrer. Aucun lien vers un registre : le nom se copie.

   LE CONTRÔLE AU REGISTRE (réglage décoché d'office) complète le badge — « · 1 inconnue »,
   « · 1 récente », l'inconnue d'abord — et chaque ligne d'ajoutée : ce que le registre public a
   répondu, en clair, jamais une icône seule ; « injoignable » et « non contrôlé » ne sont jamais
   « inconnu ». Le pied du panneau nomme les registres contactés, ou dit que le contrôle est désactivé. */

function sigDeps(m) {
  const c = m && m.deps;
  return c ? `${c.added}:${c.changed}:${c.removed}:${c.major}:${c.unparsed}:${c.unknown || 0}:${c.recent || 0}:${c.refused || ''}:${(c.fetch || {}).sha || ''}` : '';
}

const depsParMr = new Map();

/* Le complément du registre sur le badge : « · 1 inconnue · 1 récente », l'inconnue devant. */
function complementRegistre(c) {
  let s = '';
  if (c.unknown) s += ` · ${tr('mr.deps.unknown', { n: c.unknown, count: c.unknown })}`;
  if (c.recent) s += ` · ${tr('mr.deps.recent', { n: c.recent, count: c.recent })}`;
  return s;
}

/* Rien sans manifeste touché ni diff gardé ; rien quand les manifestes touchés ne se lisent pas. */
function badgeDeps(m) {
  const c = m && m.deps;
  if (!c || c.added + c.changed + c.removed === 0) return '';
  depsParMr.set(Number(m.id), c);
  const majeur = c.major ? ` · ${tr('mr.deps.major', { n: c.major, count: c.major })}` : '';
  const texte = c.added
    ? `${tr('mr.deps.added', { n: c.added, count: c.added })}${complementRegistre(c)}${majeur}`
    : `${tr('mr.deps.changed', { n: c.changed + c.removed, count: c.changed + c.removed })}${majeur}`;
  return `<button type="button" class="tag deps${c.added ? ' alert' : ''}" data-deps="${m.id}" aria-haspopup="dialog" aria-expanded="false"`
    + ` title="${esc(tr('mr.deps.title'))}">${esc(texte)}</button>`;
}

function lienMotifsDeps(src, champ = 'manifest_patterns') {
  if (!src) return '';
  if (src.kind === 'repo') return `<button type="button" class="croise-go" data-deps-motifs="repo:${src.repo_id}" data-deps-champ="${champ}">${esc(tr('mr.tests.patterns.repo'))}</button>`;
  if (src.kind === 'group') {
    return (src.groups || []).map((g) => `<button type="button" class="croise-go" data-deps-motifs="group:${g.id}" data-deps-champ="${champ}">${esc(tr('mr.tests.patterns.group', { name: g.name }))}</button>`).join(' + ');
  }
  return `<button type="button" class="croise-go" data-deps-motifs="config" data-deps-champ="${champ}">${esc(tr(src.kind === 'config' ? 'mr.tests.patterns.config' : 'mr.tests.patterns.default'))}</button>`;
}

const sectionDeps = (s) => (s === 'dev' ? tr('mr.deps.section.dev') : (s === 'prod' ? tr('mr.deps.section.prod') : tr('mr.deps.section.unknown')));

/* Ce que le registre a dit d'une ajoutée, en clair. `unknown` est la seule réponse accentuée : c'est
   la seule qui dit « ce nom n'existe pas » — et c'est le registre qui le dit, pas l'outil. */
function texteRegistre(r) {
  if (!r) return '';
  if (r.status === 'unknown') return `<span class="deps-reg unknown">${esc(tr('mr.deps.reg.unknown', { registry: r.label }))}</span>`;
  if (r.status === 'recent') return `<span class="deps-reg recent">${esc(tr('mr.deps.reg.recent', { age: depuis(r.first_published), registry: r.label }))}</span>`;
  if (r.status === 'known') return `<span class="deps-reg muted">${esc(tr('mr.deps.reg.known', { year: r.first_published ? String(r.first_published).slice(0, 4) : '?', registry: r.label }))}</span>`;
  if (r.status === 'unreachable') {
    const raison = r.reason === 'timeout' ? tr('mr.deps.reg.reason.timeout')
      : /^http-\d+$/.test(r.reason || '') ? tr('mr.deps.reg.reason.http', { code: r.reason.slice(5) })
        : r.reason === 'redirect' ? tr('mr.deps.reg.reason.redirect') : tr('mr.deps.reg.reason.other');
    return `<span class="deps-reg muted">${esc(tr('mr.deps.reg.unreachable', { host: r.host, reason: raison }))}</span>`;
  }
  const cle = `mr.deps.reg.skipped.${r.reason || 'pending'}`;
  return `<span class="deps-reg muted">${esc(tr(cle, { file: typeof r.source === 'string' ? r.source : '' }))}</span>`;
}

/* Les lignes d'un manifeste : ajoutées, puis changées, puis retirées, dans l'ordre du fichier. */
function lignesManifeste(a) {
  if (!a.parser) return `<li class="deps-unparsed muted">${esc(tr('mr.deps.unparsed'))}</li>`;
  const l = [];
  for (const e of a.added) l.push(`<li><code>${esc(e.name)}</code> <span class="deps-ver">${esc(e.version || '')}</span> <span class="deps-kind add">${esc(tr('mr.deps.row.added'))}</span> · ${esc(sectionDeps(e.section))}${e.registry ? ` · ${texteRegistre(e.registry)}` : ''}</li>`);
  for (const e of a.changed) {
    const maj = e.major === true ? ` <span class="deps-kind major">${esc(tr('mr.deps.row.major'))}</span>` : (e.major === null ? ` <span class="muted">${esc(tr('mr.deps.row.major-unknown'))}</span>` : '');
    l.push(`<li><code>${esc(e.name)}</code> <span class="deps-ver">${esc(e.from || '')} → ${esc(e.to || '')}</span>${maj} · ${esc(sectionDeps(e.section))}</li>`);
  }
  for (const e of a.removed) l.push(`<li><code>${esc(e.name)}</code> <span class="deps-kind del">${esc(tr('mr.deps.row.removed'))}</span> · ${esc(sectionDeps(e.section))}</li>`);
  return l.join('');
}

/* Le pied « registre » : les registres contactés et quand, ou « désactivé » — avec, dans les deux
   cas, le lien vers le réglage, et celui des motifs de paquets privés (un faux « inconnu » se corrige là). */
function piedRegistre(c) {
  const r = c.registry;
  if (!r || !c.added) return '';
  if (!r.enabled) return `<div class="croise-foot muted" data-deps-registre="off">${esc(tr('mr.deps.reg.off'))} · <button type="button" class="croise-go" data-deps-motifs="config" data-deps-champ="registry_enabled">${esc(tr('mr.deps.reg.setting'))}</button></div>`;
  const contacts = Object.entries(r.contacted || {}).map(([eco, at]) => `${esc(eco)} · <span data-when="${esc(at)}">${esc(depuis(at))}</span>`);
  return `<div class="croise-foot muted" data-deps-registre="on">${contacts.length ? `${esc(tr('mr.deps.reg.foot'))} ${contacts.join(', ')}` : esc(tr('mr.deps.reg.foot.none'))}
    · ${esc(tr('mr.deps.reg.private'))} ${lienMotifsDeps(r.private || { kind: 'config' }, 'private_patterns')}</div>`;
}

function panneauDeps(id, c) {
  const f = c.fetch || {};
  const plusieurs = (c.manifests || []).length > 1;
  return `<div class="croise-panel deps-panel" role="dialog" data-deps-panel="${id}" aria-label="${esc(tr('mr.deps.panel.title'))}">
    <div class="croise-head"><strong>${esc(tr('mr.deps.panel.title'))}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    <div class="muted">${esc(tr('mr.deps.panel.sub', { added: c.added, changed: c.changed, removed: c.removed }))}${esc(complementRegistre(c))}</div>
    ${(c.manifests || []).map((a) => `${plusieurs ? `<div class="deps-manifest"><code>${esc(a.path)}</code></div>` : ''}<ul class="croise-paths deps-rows">${lignesManifeste(a)}</ul>`).join('')}
    ${c.refused ? `<p class="croise-mr muted">${esc(tr('mr.deps.refused'))}</p>` : ''}
    <div class="croise-foot muted">${esc(tr('mr.deps.panel.patterns'))} ${lienMotifsDeps(c.patterns)}</div>
    ${piedRegistre(c)}
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
  if (lien) { e.stopPropagation(); ouvrirMotifs(lien.dataset.depsMotifs, lien.dataset.depsChamp || 'manifest_patterns'); }
});
