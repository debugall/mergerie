'use strict';
/* Les tests touchés : « 14 fichiers · 3 tests » (discret) ou « 14 fichiers · 0 test » (accentué, à
   partir de N fichiers de code) dans la rangée des pastilles, et son panneau ancré sur la carte —
   la même mécanique que les croisements. Zéro réseau : tout vient de la liste (`tests`), classé
   en base par des motifs de chemin. Des fichiers, pas une couverture : le badge compte, l'humain
   lit. */

function sigTests(m) {
  const c = m && m.tests;
  return c ? `${c.code}:${c.tests}:${c.neutral}:${c.alert ? 1 : 0}:${(c.fetch || {}).sha || ''}` : '';
}

const testsParMr = new Map();

/* Rien sans liste fraîche (jamais un faux « 0 test »), rien quand tout est neutre, rien sous le
   seuil quand il n'y a pas de test. */
function badgeTests(m) {
  const c = m && m.tests;
  if (!c || (c.code === 0 && c.tests === 0) || (c.tests === 0 && !c.alert)) return '';
  testsParMr.set(Number(m.id), c);
  const texte = `${tr('mr.size.files', { n: c.code, count: c.code })} · ${c.tests ? tr('mr.tests.count', { n: c.tests, count: c.tests }) : tr('mr.tests.none')}`;
  return `<button type="button" class="tag tests${c.alert ? ' alert' : ''}" data-tests="${m.id}" aria-haspopup="dialog" aria-expanded="false"`
    + ` title="${esc(tr('mr.tests.title'))}">${esc(texte)}</button>`;
}

/* D'où viennent les motifs : « dépôt », « groupe Paiement », « défaut » — et le lien mène au
   réglage, pour corriger un faux « 0 test » sur un dépôt d'un autre écosystème en deux clics. */
function lienMotifs(src) {
  if (!src) return '';
  if (src.kind === 'repo') return `<button type="button" class="croise-go" data-tests-motifs="repo:${src.repo_id}">${esc(tr('mr.tests.patterns.repo'))}</button>`;
  if (src.kind === 'group') {
    return (src.groups || []).map((g) => `<button type="button" class="croise-go" data-tests-motifs="group:${g.id}">${esc(tr('mr.tests.patterns.group', { name: g.name }))}</button>`).join(' + ');
  }
  return `<button type="button" class="croise-go" data-tests-motifs="config">${esc(tr(src.kind === 'config' ? 'mr.tests.patterns.config' : 'mr.tests.patterns.default'))}</button>`;
}

function panneauTests(id, c) {
  const f = c.fetch || {};
  const sources = c.patterns || {};
  const memes = JSON.stringify(sources.tests) === JSON.stringify(sources.neutres);
  return `<div class="croise-panel" role="dialog" data-tests-panel="${id}" aria-label="${esc(tr('mr.tests.panel.title'))}">
    <div class="croise-head"><strong>${esc(tr('mr.tests.panel.title'))}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    <div class="muted">${esc(tr('mr.tests.panel.sub', { code: c.code, tests: c.tests, neutral: c.neutral }))}</div>
    ${c.tests
    ? `<ul class="croise-paths">${(c.test_paths || []).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}${c.tests > (c.test_paths || []).length ? `<li class="muted">${esc(tr('mr.croise.more', { n: c.tests - c.test_paths.length, count: c.tests - c.test_paths.length }))}</li>` : ''}</ul>`
    : `<p class="croise-mr">${esc(tr('mr.tests.panel.none'))}</p>`}
    <div class="croise-foot muted">${esc(tr('mr.tests.panel.patterns'))} ${memes ? lienMotifs(sources.tests) : `${lienMotifs(sources.tests)} · ${lienMotifs(sources.neutres)}`}</div>
    ${f.sha ? `<div class="croise-foot muted">${esc(tr('mr.croise.fetched', { sha: String(f.sha).slice(0, 8) }))} · <span data-when="${esc(f.at || '')}">${esc(depuis(f.at))}</span></div>` : ''}
  </div>`;
}

/* Le réglage correspondant : la ligne du dépôt dépliée, le formulaire du groupe, ou le champ des
   réglages globaux. Les listes se chargent en asynchrone : on attend que le bouton existe. */
async function ouvrirMotifs(cible) {
  const [kind, id] = String(cible || '').split(':');
  fermerPanneauAncre();
  navTab('admin');
  const attendre = async (sel) => {
    for (let i = 0; i < 50; i += 1) {
      const el = $(sel);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  if (kind === 'repo') {
    showAdminSub('repos');
    const b = await attendre(`#repoList [data-edit="${Number(id)}"]`);
    if (b) { b.click(); const z = $(`#repoList .repo-row[data-repo="${Number(id)}"] [data-f="test_patterns"]`); if (z) { z.scrollIntoView({ block: 'center' }); z.focus(); } }
  } else if (kind === 'group') {
    showAdminSub('repos');
    const b = await attendre(`#groupList [data-gedit="${Number(id)}"]`);
    if (b) { b.click(); const det = $('#groupForm .group-overrides'); if (det) det.open = true; const z = $('#groupForm [name="test_patterns"]'); if (z) z.focus(); }
  } else {
    showAdminSub('mr');
    const z = await attendre('#sub-mr [name="test_patterns"]');
    if (z) { z.scrollIntoView({ block: 'center' }); z.focus(); }
  }
}

document.addEventListener('click', (e) => {
  const badge = e.target.closest && e.target.closest('[data-tests]');
  if (badge) {
    e.stopPropagation();
    if (badge.getAttribute('aria-expanded') === 'true') { fermerPanneauAncre(); return; }
    const c = testsParMr.get(Number(badge.dataset.tests));
    if (c) ouvrirPanneauAncre(badge, panneauTests(Number(badge.dataset.tests), c));
    return;
  }
  const lien = e.target.closest && e.target.closest('[data-tests-motifs]');
  if (lien) { e.stopPropagation(); ouvrirMotifs(lien.dataset.testsMotifs); }
});
