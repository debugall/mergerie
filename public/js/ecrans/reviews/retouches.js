'use strict';
/* Les retouches après merge : « retouchée par !230 · 3 j · 23 lignes » sur la carte d'une merge
   request MERGÉE dont une autre a réécrit le code dans la fenêtre, « annulée par !230 · 1 j » pour un
   revert, « retouchée par a1b2c3d · hotfix sans MR » pour un commit direct, « évolution par !230 »
   (gris) quand un humain a requalifié — et le miroir « retouche !214 (8,4/10) » sur la carte de la
   retouche. Un fait de git, jamais un verdict : rien ici ne dit « défaut » ni « erreur du rapport ».
   Le panneau ancré donne de quoi vérifier à la main (les plages de lignes par fichier, le SHA), les
   signaux, ce qui qualifie la retouche, et les deux gestes « Pas un correctif » / « Marquer comme
   correctif » — requalifier est un fait enregistré avec son auteur, qui voyage avec la MR. */

const fixParMr = new Map();

function sigRetouches(m) {
  const f = m && m.fix;
  if (!f) return '';
  const p = (l) => (l || []).map((x) => `${x.fix.id || x.fix.sha}:${x.kind}:${x.status}:${x.lines}:${x.large ? 1 : 0}`).join(',');
  return `${p(f.touched_by)}|${p(f.touches)}`;
}

const fixRefDe = (fix) => (fix && fix.id ? `!${fix.iid}` : String((fix && fix.sha) || '').slice(0, 7));
const fixJoursDe = (d) => tr('mr.fix.days', { n: d == null ? '?' : Math.round(Number(d)), count: Math.round(Number(d) || 0) });
/* Sur la carte : les paires qui disent quelque chose — jamais une référence seule, jamais une
   réécriture large (le panneau les montre). */
const fixVisibles = (l) => (l || []).filter((p) => !p.reference_only && !p.large);

function texteRetouches(f) {
  const vus = fixVisibles(f.touched_by);
  if (!vus.length) return null;
  const actives = vus.filter((p) => p.status !== 'dismissed');
  if (!actives.length) return { texte: tr('mr.fix.evolution', { ref: fixRefDe(vus[0].fix) }), gris: true };
  if (actives.length > 1) return { texte: tr('mr.fix.touched-many', { n: actives.length, count: actives.length }) };
  const p = actives[0];
  if (!p.fix.id) return { texte: tr('mr.fix.hotfix', { sha: fixRefDe(p.fix), days: fixJoursDe(p.days) }) };
  if (p.kind === 'revert') return { texte: tr('mr.fix.reverted', { ref: fixRefDe(p.fix), days: fixJoursDe(p.days) }) };
  if (p.lines) return { texte: tr('mr.fix.touched-lines', { ref: fixRefDe(p.fix), days: fixJoursDe(p.days), n: p.lines }) };
  return { texte: tr('mr.fix.touched', { ref: fixRefDe(p.fix), days: fixJoursDe(p.days) }) };
}

function badgeRetouches(m) {
  const f = m && m.fix;
  if (!f) return '';
  const direct = texteRetouches(f);
  const miroirs = fixVisibles(f.touches).filter((p) => p.status !== 'dismissed');
  if (!direct && !miroirs.length) return '';
  fixParMr.set(Number(m.id), f);
  let texte; let titre;
  if (direct) { texte = direct.texte; titre = tr('mr.fix.title'); } else {
    const p = miroirs[0];
    texte = p.origin.note != null ? tr('mr.fix.mirror-note', { ref: `!${p.origin.iid}`, note: fmtNote10(p.origin.note * 10) }) : tr('mr.fix.mirror', { ref: `!${p.origin.iid}` });
    titre = tr('mr.fix.title-mirror');
  }
  return `<button type="button" class="tag fix${direct && direct.gris ? ' fix-evolution' : ''}${direct && !direct.gris ? ' fix-touched' : ''}" data-fix="${m.id}" aria-haspopup="dialog" aria-expanded="false" title="${esc(titre)}">${svgIco('repeat')} ${esc(texte)}</button>`;
}

/* ---------- le panneau ---------- */

const fixOuQuoi = (where) => ({ title: tr('mr.fix.where.title'), description: tr('mr.fix.where.description'), branch: tr('mr.fix.where.branch') }[where] || where);
function fixSignalHtml(s, p) {
  if (s.kind === 'revert') return tr('mr.fix.signal.revert');
  if (s.kind === 'reference' && s.where === 'ticket') return tr('mr.fix.signal.reference-ticket', { ticket: s.ticket || '' });
  if (s.kind === 'reference') return tr('mr.fix.signal.reference', { ref: `!${p.origin.iid}`, where: fixOuQuoi(s.where) });
  return s.kind;
}
function fixQualifHtml(p) {
  if (p.status === 'dismissed') return `<span class="muted">${esc(tr('mr.fix.dismissed'))}</span>`;
  const pourquoi = [];
  if (p.status === 'confirmed') pourquoi.push(tr('mr.fix.bug.confirmed'));
  for (const b of p.bug || []) {
    if (b.kind === 'revert') pourquoi.push(tr('mr.fix.bug.revert'));
    else if (b.kind === 'ticket-bug') pourquoi.push(tr('mr.fix.bug.ticket-bug', { ref: b.ref || '', type: b.type || 'Bug' }));
    else if (b.kind === 'commit-fix') pourquoi.push(tr('mr.fix.bug.commit-fix'));
  }
  if (!pourquoi.length) return `<span class="fix-undecided">${esc(tr('mr.fix.bug.none'))}</span>`;
  return `<span class="fix-bug">${esc(tr('mr.fix.bug.label', { why: [...new Set(pourquoi)].join(' · ') }))}</span>`;
}
const fixPlageTexte = (r) => r.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');

function fixLigneMr(o, { note = null, mergedAt = null } = {}) {
  return `<button type="button" class="croise-go" data-croise-go="${o.id}" data-croise-status="done" title="${esc(tr('mr.croise.go'))}">!${esc(o.iid)} — ${esc(o.title || '')}${note != null ? ` · ${esc(fmtNote10(note * 10))}` : ''}${mergedAt ? ` · ${esc(depuis(mergedAt))}` : ''}</button>`;
}

function fixPaireHtml(id, p, { cote }) {
  const kinds = (p.kinds || []).filter((k) => k !== 'reference');
  const signaux = [
    ...kinds.filter((k) => k === 'rewrites').map(() => tr('mr.fix.signal.rewrites')),
    ...kinds.filter((k) => k === 'manual').map(() => tr('mr.fix.signal.manual')),
    ...(p.signals || []).map((s) => fixSignalHtml(s, p)),
  ];
  const fichiers = Object.entries(p.ranges || {}).map(([chemin, plages]) => `<li><code>${esc(chemin)}</code> : ${esc(fixPlageTexte(plages))}</li>`);
  const cle = `data-fix-origin="${p.origin.id}" data-fix-mr="${p.fix.id || 0}" data-fix-sha="${esc(p.fix.sha || '')}"`;
  const gestes = p.status === 'auto'
    ? `<button type="button" class="btn btn-sm btn-ghost" data-fix-status="dismissed" ${cle}>${esc(tr('mr.fix.btn.dismiss'))}</button>
       <button type="button" class="btn btn-sm btn-ghost" data-fix-status="confirmed" ${cle}>${esc(tr('mr.fix.btn.confirm'))}</button>`
    : `<span class="muted">${esc(tr('mr.fix.requalified', { by: p.status_by || '—', when: depuis(p.status_at) }))}</span>
       <button type="button" class="btn btn-sm btn-ghost" data-fix-status="auto" ${cle}>${esc(tr('mr.fix.btn.undo'))}</button>`;
  const tete = cote === 'origin'
    ? (p.fix.id ? fixLigneMr(p.fix, { mergedAt: p.fix.merged_at }) : `<code>${esc(String(p.fix.sha || '').slice(0, 10))}</code> · ${esc(tr('mr.fix.panel.hotfix'))}${p.fix.title ? ` — ${esc(p.fix.title)}` : ''}`)
    : fixLigneMr(p.origin, { note: p.origin.note, mergedAt: p.origin.merged_at });
  return `<div class="fix-pair${p.status === 'dismissed' ? ' fix-pair-dismissed' : ''}">
    <div>${tete}</div>
    <div class="muted fix-counts">${esc(fixJoursDe(p.days))}${p.lines ? ` · ${esc(tr('mr.fix.panel.lines', { n: p.lines, files: p.files, count: p.lines }))}` : ''}${p.large ? ` · ${esc(tr('mr.fix.large'))}` : ''}</div>
    ${fichiers.length ? `<ul class="croise-paths fix-files">${fichiers.join('')}</ul>` : ''}
    ${signaux.length ? `<div class="fix-signals"><strong>${esc(tr('mr.fix.panel.signals'))}</strong> ${signaux.map((s) => `<span class="tag">${esc(s)}</span>`).join(' ')}</div>` : ''}
    <div class="fix-qualif">${fixQualifHtml(p)}</div>
    <div class="fix-actions">${gestes}</div>
  </div>`;
}

function panneauRetouches(id, f) {
  const par = (f.touched_by || []).map((p) => fixPaireHtml(id, p, { cote: 'origin' }));
  const vers = (f.touches || []).map((p) => fixPaireHtml(id, p, { cote: 'fix' }));
  const sha = [...(f.touched_by || []), ...(f.touches || [])].map((p) => p.head_sha).find(Boolean);
  const sec = (titre, lignes) => (lignes.length ? `<div class="stack-sec"><strong>${esc(titre)}</strong>${lignes.join('')}</div>` : '');
  return `<div class="croise-panel fix-panel" role="dialog" data-fix-panel="${id}" aria-label="${esc(tr('mr.fix.panel.title'))}">
    <div class="croise-head"><strong>${esc(tr('mr.fix.panel.title'))}</strong>
      <button type="button" class="btn btn-icon btn-sm" data-croise-close title="${esc(tr('mr.croise.close'))}" aria-label="${esc(tr('mr.croise.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>
    ${sec(tr('mr.fix.panel.by'), par)}
    ${sec(tr('mr.fix.panel.touches'), vers)}
    <div class="croise-foot muted">${esc(sha ? tr('mr.fix.foot', { days: f.window, sha: String(sha).slice(0, 8) }) : tr('mr.fix.foot-manual', { days: f.window }))}</div>
  </div>`;
}

/* ---------- les gestes ---------- */

async function rafraichirApresRetouche(id) {
  fermerPanneauAncre();
  try { if (typeof loadSegment === 'function' && typeof currentSeg !== 'undefined') await loadSegment(currentSeg); } catch { /* la liste se rechargera au prochain geste */ }
  try { if (typeof selectedMr !== 'undefined' && selectedMr === id && typeof openReport === 'function') openReport(id, { force: true }); } catch { /* idem */ }
}

async function requalifierRetouche(b) {
  const originId = Number(b.dataset.fixOrigin);
  const status = b.dataset.fixStatus;
  try {
    await busy(b, () => api(`/retouches/${originId}/statut`, { method: 'POST', body: { fix_mr_id: Number(b.dataset.fixMr) || 0, fix_commit_sha: b.dataset.fixSha || '', status } }));
    toast(tr(status === 'dismissed' ? 'mr.fix.toast.dismissed' : status === 'confirmed' ? 'mr.fix.toast.confirmed' : 'mr.fix.toast.undone'));
    await rafraichirApresRetouche(originId);
  } catch (e) { toast(explainError(e.message), true); }
}

/* « Marquer comme correctif d'une MR… » depuis le menu ⋯ d'une merge request mergée B : la liste
   des MR mergées avant elle sur la même cible, le choix, le lien posé en `confirmed`. */
async function marquerCorrectif(b) {
  const fixId = Number(b.dataset.fixMark);
  const zone = $('#reportDetail') || b.closest('.detail') || b.parentElement;
  let origines;
  try { origines = await api(`/retouches/${fixId}/origines`); } catch (e) { toast(explainError(e.message), true); return; }
  $$('.fix-mark').forEach((x) => x.remove());
  if (!origines.length) { toast(tr('mr.fix.mark.none'), true); return; }
  const html = `<div class="fix-mark">
    <label>${esc(tr('mr.fix.mark.pick'))}
      <select class="fix-mark-select">${origines.map((o) => `<option value="${o.id}">!${esc(o.iid)} — ${esc(o.title)}${o.note != null ? ` · ${esc(fmtNote10(o.note * 10))}` : ''} · ${esc(depuis(o.merged_at))}</option>`).join('')}</select>
    </label>
    <button type="button" class="btn btn-sm" data-fix-mark-ok="${fixId}">${esc(tr('mr.fix.btn.confirm'))}</button>
    <button type="button" class="btn btn-sm btn-ghost" data-fix-mark-cancel>${esc(tr('mr.croise.close'))}</button>
  </div>`;
  const actions = zone.querySelector('.detail-actions') || zone;
  actions.insertAdjacentHTML('afterend', html);
  const sel = zone.querySelector('.fix-mark-select');
  if (sel) sel.focus();
}

document.addEventListener('click', async (e) => {
  const badge = e.target.closest && e.target.closest('[data-fix]');
  if (badge) {
    e.stopPropagation();
    if (badge.getAttribute('aria-expanded') === 'true') { fermerPanneauAncre(); return; }
    const id = Number(badge.dataset.fix);
    const f = fixParMr.get(id);
    if (f) ouvrirPanneauAncre(badge, panneauRetouches(id, f));
    return;
  }
  const geste = e.target.closest && e.target.closest('[data-fix-status]');
  if (geste) { e.stopPropagation(); await requalifierRetouche(geste); return; }
  const marque = e.target.closest && e.target.closest('[data-fix-mark]');
  if (marque) { e.stopPropagation(); if (typeof closeSplitMenus === 'function') closeSplitMenus(); await marquerCorrectif(marque); return; }
  const ok = e.target.closest && e.target.closest('[data-fix-mark-ok]');
  if (ok) {
    e.stopPropagation();
    const fixId = Number(ok.dataset.fixMarkOk);
    const sel = ok.parentElement.querySelector('.fix-mark-select');
    const originId = Number(sel && sel.value);
    if (!originId) return;
    try {
      await busy(ok, () => api(`/retouches/${originId}/statut`, { method: 'POST', body: { fix_mr_id: fixId, status: 'confirmed' } }));
      toast(tr('mr.fix.mark.done', { ref: `!${(sel.selectedOptions[0] || {}).textContent.split(' ')[0].replace('!', '')}` }));
      ok.closest('.fix-mark').remove();
      await rafraichirApresRetouche(fixId);
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (e.target.closest && e.target.closest('[data-fix-mark-cancel]')) { e.stopPropagation(); $$('.fix-mark').forEach((x) => x.remove()); }
});
