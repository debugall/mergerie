'use strict';
/* Delta depuis la dernière visite. */
/* ---------- Delta depuis la dernière visite ----------
   Le panneau de droite ouvre la journée. Son axe est STRICTEMENT « ce qui a changé depuis
   ma dernière session » — le bandeau du pied de page, lui, raconte le présent qui bouge ;
   deux endroits qui diraient la même chose s'annuleraient. D'où les trois règles dures :
   plafond à trois lignes, uniquement ce qui a changé (jamais de « 0 nouvelle MR »), et
   un instantané par stade pour qu'un simple changement de segment ne fasse pas tout
   passer pour nouveau. */
const VISITE_GAP_MS = 4 * 3600 * 1000; // en deçà, on est encore dans la même session de travail
const visiteKey = (seg) => `aidevtools_visite_${seg}`;
// Lu UNE fois par chargement de page : le delta doit rester stable pendant qu'on
// travaille, pas fondre au premier re-rendu de la liste.
const visitesPrec = {};
function visitePrecedente(seg) {
  if (!(seg in visitesPrec)) {
    let v = null;
    try {
      const raw = JSON.parse(localStorage.getItem(visiteKey(seg)) || 'null');
      if (raw && Array.isArray(raw.ids) && raw.ts) v = raw;
    } catch { /* instantané illisible : on repart de zéro */ }
    visitesPrec[seg] = v;
  }
  return visitesPrec[seg];
}
function memoriserVisite(seg, rows) {
  const prec = visitePrecedente(seg);
  // Tant qu'on est dans la même session, on garde la base de comparaison d'origine :
  // sinon le delta s'effacerait à mesure qu'on lit la liste.
  if (prec && Date.now() - prec.ts < VISITE_GAP_MS) return;
  try { localStorage.setItem(visiteKey(seg), JSON.stringify({ ts: Date.now(), ids: rows.map((m) => m.id) })); }
  catch { /* stockage indisponible */ }
}
// Renvoie au plus trois lignes de faits, ou [] s'il ne s'est rien passé.
function lignesDelta(seg, rows, maintenant = Date.now()) {
  const prec = visitePrecedente(seg);
  if (!prec) return []; // première visite : aucun passé à comparer
  const avant = new Set(prec.ids);
  const ids = new Set(rows.map((m) => m.id));
  const arrivees = rows.filter((m) => !avant.has(m.id)).length;
  const parties = prec.ids.filter((id) => !ids.has(id)).length;
  const jours = Math.max(0, Math.round((maintenant - prec.ts) / 86400000));
  const depuis = jours <= 0 ? tr('report.delta.since.today') : (jours === 1 ? tr('report.delta.since.yesterday') : tr('report.delta.since.days', { n: jours }));
  const lignes = [];
  if (arrivees) lignes.push(tr('report.delta.new', { n: arrivees }));
  if (parties) lignes.push(tr('report.delta.gone', { n: parties }));
  /* L'attente la plus longue n'est pas un delta : c'est un état permanent. Elle n'apparaît
     donc qu'en APPUI d'un vrai changement — seule, elle deviendrait la ligne immuable
     affichée tous les matins, et c'est ainsi qu'un panneau cesse d'être lu. */
  const vieilles = lignes.length ? rows.filter((m) => m.stale && m.gitlab_created_at) : [];
  if (vieilles.length) {
    const plusVieille = vieilles.reduce((a, b) => (new Date(a.gitlab_created_at) < new Date(b.gitlab_created_at) ? a : b));
    const j = Math.floor((maintenant - new Date(plusVieille.gitlab_created_at).getTime()) / 86400000);
    if (j > 0) lignes.push(tr('report.delta.wait', { n: j }));
  }
  return lignes.length ? [depuis, ...lignes.slice(0, 3)] : [];
}

// La colonne de droite était occupée par « Sélectionne une MR ». On y met plutôt
// un résumé actionnable : ce qu'il y a, et par quoi commencer.
function renderReportPlaceholder() {
  const el = $('#reportDetail');
  if (!el) return;
  const toutes = reportRows || [];
  if (!toutes.length) { el.innerHTML = `<p class="muted">${tr('report.ph.pick')}</p>`; return; }
  /* Le résumé décrit ce qui est À L'ÉCRAN : sinon « 6 rapports » et trois raccourcis vers des
     merge requests masquées s'affichent à côté d'une liste qui n'en montre qu'une.
     Le suivi des nouveautés, lui, reste sur le stade ENTIER : mémoriser une visite partielle
     ferait resignaler comme neuves des lignes que le filtre avait simplement cachées. */
  const rows = toutes.filter(passeFiltreNote);
  const noted = rows.filter((m) => m.note && m.note.value != null);
  const avg = noted.length ? Math.round((noted.reduce((s, m) => s + m.note.value, 0) / noted.length) * 100) / 10 : null;
  const stale = rows.filter((m) => m.stale).length;
  const worst = [...noted].sort((a, b) => a.note.value - b.note.value).slice(0, 3);
  const delta = lignesDelta(currentSeg, toutes);
  memoriserVisite(currentSeg, toutes);
  if (!rows.length) { el.innerHTML = `<p class="muted">${tr('report.ph.pick')}</p>`; return; }
  el.innerHTML = `
    <div class="ph-summary">
      ${delta.length ? `<div class="ph-delta">
        <div class="step-s">${esc(delta[0])}</div>
        <ul>${delta.slice(1).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>` : ''}
      <div class="empty-t">${tr('report.ph.count', { n: rows.length, total: rows.length })}</div>
      <p class="empty-s">${avg != null ? tr('report.ph.avg', { avg: fmtNote10(avg).replace('/10', '') }) : tr('report.ph.no-note')}${stale ? tr('report.ph.stale', { stale }) : ''}</p>
      ${worst.length ? `<div class="ph-worst">
        <div class="step-s">${tr('report.ph.priority')}</div>
        ${worst.map((m) => `<button class="ph-item" data-open-mr="${m.id}">
            <span class="note ${noteClass(m.note)}">${esc(fmtNote(m.note))}</span>
            <span class="ph-item-t">!${m.iid} — ${esc((m.title || '').slice(0, 48))}</span>
          </button>`).join('')}
      </div>` : ''}
      <p class="step-s" style="margin-top:12px">${tr('report.ph.pick-long')}</p>
    </div>`;
  $$('#reportDetail [data-open-mr]').forEach((b) => b.addEventListener('click', () => openReport(Number(b.dataset.openMr))));
}

