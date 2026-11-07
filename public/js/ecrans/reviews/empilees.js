'use strict';
/* Les merge requests empilées : « contient !214 » / « contenue dans !219 » / « basée sur !214 » /
   « jumelle de !220 », discret, dans la rangée des pastilles juste avant « croise » (une MR contenue
   croise forcément la contenante ; l'empilement est plus précis et passe devant) — et son panneau
   ancré : la merge request liée (la ligne mène à elle dans Reviews), les commits communs et propres,
   le DIFF PROPRE (ce que le reviewer doit lire ici et pas là-bas, calculé à l'ouverture), l'historique
   « contenait !214 · mergée il y a 2 h » pendant sept jours, le relevé en pied. Zéro réseau de forge :
   tout vient de la liste (`stack`) et d'une lecture de la base pour le diff propre. Un fait de git,
   pas un jugement : rien n'est bloqué, aucune note ne bouge. */

function sigStack(m) {
  const s = m && m.stack;
  if (!s) return '';
  const ids = (l) => (l || []).map((x) => `${x.id}:${x.shared || ''}`).join(',');
  return `${ids(s.contains)}|${ids(s.containedIn)}|${s.basedOn ? s.basedOn.id : ''}|${ids(s.twins)}|${(s.history || []).map((h) => h.id).join(',')}|${(s.fetch || {}).sha || ''}`;
}

const stackParMr = new Map();

/* Le badge dit la relation la plus parlante : contient, puis contenue dans, puis basée sur, puis
   jumelle ; le panneau dit tout. Aucun badge sans relation — jamais « indépendante ». */
function texteStack(s) {
  if ((s.contains || []).length === 1) return tr('mr.stack.contains', { iid: s.contains[0].iid });
  if ((s.contains || []).length > 1) return tr('mr.stack.contains-many', { n: s.contains.length, count: s.contains.length });
  if ((s.containedIn || []).length) return tr('mr.stack.contained-in', { iid: s.containedIn[0].iid });
  if (s.basedOn) return tr('mr.stack.based-on', { iid: s.basedOn.iid });
  if ((s.twins || []).length) return tr('mr.stack.twin', { iid: s.twins[0].iid });
  return '';
}
function badgeStack(m) {
  const s = m && m.stack;
  if (!s) return '';
  const texte = texteStack(s);
  if (!texte) return '';
  stackParMr.set(Number(m.id), s);
  return `<button type="button" class="tag stack" data-stack="${m.id}" aria-haspopup="dialog" aria-expanded="false"`
    + ` title="${esc(tr('mr.stack.title'))}">${svgIco('branch')} ${esc(texte)}</button>`;
}

function ligneStackMr(o) {
  return `<button type="button" class="croise-go" data-croise-go="${o.id}" data-croise-status="${esc(o.status || '')}" title="${esc(tr('mr.croise.go'))}">!${esc(o.iid)} — ${esc(o.title || '')}${o.author ? ` · ${esc(o.author)}` : ''}${o.created_at ? ` · ${esc(tr('mr.croise.opened', { age: depuis(o.created_at) }))}` : ''}${o.note != null ? ` · ${esc(fmtNote10(o.note * 10))}` : ''}</button>`;
}
const sectionStack = (titre, lignes) => (lignes.length ? `<div class="stack-sec"><strong>${esc(titre)}</strong>${lignes.join('')}</div>` : '');

function panneauStack(id, s) {
  const f = s.fetch || {};
  const contient = (s.contains || []).map((o) => `<div class="croise-mr">${ligneStackMr(o)}<div class="stack-counts muted">${esc(tr('mr.stack.counts', { shared: o.shared, extra: o.extra }))}</div></div>`);
  const dans = (s.containedIn || []).map((o) => `<div class="croise-mr">${ligneStackMr(o)}<div class="stack-counts muted">${esc(tr('mr.stack.counts-in', { shared: o.shared, iid: o.iid, extra: o.extra }))}</div></div>`);
  const base = s.basedOn ? [`<div class="croise-mr">${ligneStackMr(s.basedOn)}</div>`] : [];
  const jumelles = (s.twins || []).map((o) => `<div class="croise-mr">${ligneStackMr(o)}<div class="stack-counts muted">${esc(tr('mr.stack.counts-twin', { shared: o.shared }))}</div></div>`);
  const histo = (s.history || []).map((o) => `<div class="croise-mr stack-history">${ligneStackMr(o)} · ${esc(tr('mr.stack.history', { age: depuis(o.merged_at) }))}</div>`);
  const titre = (s.contains || []).length ? tr('mr.stack.panel.contains', { n: s.contains.length, count: s.contains.length })
    : (s.containedIn || []).length ? tr('mr.stack.panel.contained-in', { iid: s.containedIn[0].iid })
      : s.basedOn ? tr('mr.stack.panel.based-on', { iid: s.basedOn.iid })
        : (s.twins || []).length ? tr('mr.stack.panel.twin', { iid: s.twins[0].iid }) : tr('mr.stack.title-short');
  return `<div class="croise-panel stack-panel" role="dialog" data-stack-panel="${id}" aria-label="${esc(titre)}">
    <div class="croise-head"><strong>${esc(titre)}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    ${sectionStack(tr('mr.stack.sec.contains'), contient)}
    ${contient.length ? `<div class="stack-propre" data-stack-propre="${id}"><span class="muted">${esc(tr('mr.stack.propre.loading'))}</span></div>` : ''}
    ${sectionStack(tr('mr.stack.sec.contained-in'), dans)}
    ${sectionStack(tr('mr.stack.sec.based-on'), base)}
    ${sectionStack(tr('mr.stack.sec.twins'), jumelles)}
    ${sectionStack(tr('mr.stack.sec.history'), histo)}
    ${f.sha ? `<div class="croise-foot muted">${esc(tr('mr.croise.fetched', { sha: String(f.sha).slice(0, 8) }))} · <span data-when="${esc(f.at || '')}">${esc(depuis(f.at))}</span></div>` : ''}
  </div>`;
}

/* Le diff propre se lit à l'ouverture (une requête sur la base, aucune forge) : le panneau est déjà
   là, la ligne se remplit. Si le panneau a été refermé entre-temps, rien à remplir. */
async function remplirDiffPropre(id) {
  let d;
  try { d = await api(`/empilees/${id}/propre`); } catch { d = null; }
  const zone = document.querySelector(`[data-stack-propre="${id}"]`);
  if (!zone) return;
  if (!d || !d.computed) { zone.innerHTML = `<span class="muted">${esc(tr('mr.stack.propre.none'))}</span>`; return; }
  const plus = d.count > d.paths.length ? `<li class="muted">${esc(tr('mr.croise.more', { n: d.count - d.paths.length, count: d.count - d.paths.length }))}</li>` : '';
  zone.innerHTML = `<div><strong>${esc(tr('mr.stack.propre', { n: d.count, count: d.count }))}</strong></div>
    <ul class="croise-paths">${d.paths.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}${plus}</ul>`;
}

document.addEventListener('click', (e) => {
  const badge = e.target.closest && e.target.closest('[data-stack]');
  if (!badge) return;
  e.stopPropagation();
  if (badge.getAttribute('aria-expanded') === 'true') { fermerPanneauAncre(); return; }
  const id = Number(badge.dataset.stack);
  const s = stackParMr.get(id);
  if (!s) return;
  ouvrirPanneauAncre(badge, panneauStack(id, s));
  if ((s.contains || []).length) remplirDiffPropre(id);
});
