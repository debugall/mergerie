'use strict';
/* DE LA SESSION À SA MERGE REQUEST DANS REVIEWS. La ligne de projet disait « MR !5 · 6,0/10 »
   sans mener nulle part : pour lire le rapport il fallait aller dans Reviews et retrouver !5
   dans la file. Dès que la merge request est connue de la base (`mr_row_id`), la puce est un
   bouton vers sa carte (à traiter) ou son rapport (reviewée, traitée) — `allerALaMr`, le même
   geste que les croisements et le brief. La forge garde son lien ↗ à côté. */

/* CE QUE LA MERGE REQUEST EST DEVENUE, SUR LA LIGNE DU PROJET. « MR !216 ↗ » ne disait rien
   de ce qu'elle vaut : il fallait retourner dans Reviews pour lire la note et le verdict de ce
   que la session venait de produire. Trois faits, aucun calcul — ils viennent avec la ligne. */
function etatMrDeLaLigne(tg) {
  const bouts = [];
  // `note_value` est une FRACTION [0,1] en base : la note sur 10 vaut dix fois.
  if (tg.mr_note != null) bouts.push(`<span class="tmr-note">${esc(fmtNote10(tg.mr_note * 10))}</span>`);
  if (tg.mr_verdict) bouts.push(`<span class="tmr-verdict v-${esc(tg.mr_verdict)}">${esc(tr(`mr.ref.verdict.${tg.mr_verdict}`))}</span>`);
  if (tg.mr_drafts) bouts.push(esc(tr('task.mr.drafts', { n: tg.mr_drafts, count: tg.mr_drafts })));
  if (!bouts.length) return '';
  return ` <span class="tmr-etat muted">${bouts.join(' · ')}</span>`;
}

function puceMr(tg, mrIid, mrUrl) {
  if (!mrIid) return etatMrDeLaLigne(tg);
  const forge = mrUrl ? `<a class="muted" href="${esc(safeUrl(mrUrl))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('task.mr.forge', { iid: mrIid }))}">↗</a>` : '';
  if (!tg.mr_row_id) {
    // Avant la découverte : l'étiquette d'avant, rien à ouvrir côté Reviews.
    return `${mrUrl ? ` <a href="${esc(safeUrl(mrUrl))}" target="_blank" rel="noopener noreferrer">MR !${mrIid} ↗</a>` : ` <span class="muted">MR !${mrIid}</span>`}${etatMrDeLaLigne(tg)}`;
  }
  return ` <button type="button" class="tag tmr-go" data-go-mr="${tg.mr_row_id}" data-go-mr-status="${esc(tg.mr_status || '')}" title="${esc(tr('task.mr.go', { iid: mrIid }))}">${svgIco('eye')} MR !${mrIid}${etatMrDeLaLigne(tg)}</button>${forge ? ` ${forge}` : ''}`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-go-mr]');
  if (b) { e.stopPropagation(); allerALaMr(Number(b.dataset.goMr), b.dataset.goMrStatus); }
});
