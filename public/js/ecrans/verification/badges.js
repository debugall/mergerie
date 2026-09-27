'use strict';
/* Badges de verdict. */
// @expose verifyBadge
/* ---------- Badges de verdict ---------- */

/* Un badge dit trois choses en un coup d'œil : le verdict, s'il porte encore sur le code
   actuel (⟳ périmé), et s'il a été rendu dans un répertoire de travail (in place). */
const raccourci = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

function verifyBadge(v) {
  if (!v) return `<span class="tag verify none" title="${esc(tr('verify.badge.none.title'))}">${esc(tr('verify.badge.none'))}</span>`;
  const suffixe = v.in_place ? ` ${tr('verify.badge.in-place')}` : '';
  if (v.stale) {
    return `<button type="button" class="tag verify stale" data-vreport="${v.id}" title="${esc(tr('verify.badge.stale.title'))}">${svgIco('refresh')}${esc(tr('verify.badge.stale') + suffixe)} <span class="tag-cta">${esc(tr('verify.badge.see-report'))}</span></button>`;
  }
  /* Sans nom de test, on ne prétend pas en compter : le badge nomme la COMMANDE qui a
     échoué. Annoncer « 1 test cassé » là où on ne sait rien des tests serait une invention. */
  const par = {
    verified_pass: ['ok', tr('verify.badge.pass'), tr('verify.badge.pass.title')],
    verified_fail: ['ko',
      v.detail_source === 'command'
        ? tr('verify.badge.fail-command', { command: raccourci(v.failed_label || '', 28) })
        : tr('verify.badge.fail', { n: v.failed_count }),
      tr('verify.badge.fail.title')],
    broken_base: ['warn', tr('verify.badge.broken-base'), tr('verify.badge.broken-base.title')],
    verify_error: ['warn', tr('verify.badge.error'), tr('verify.badge.error.title')],
  }[v.verdict];
  if (!par) return '';
  /* Le badge OUVRE le rapport : c'était un <span> cliquable, invisible au clavier et muet sur
     ce qu'il fait. Un <button> le rend atteignable par Tab, et « · voir le rapport » dit la
     porte au lieu de la laisser deviner au survol. */
  return `<button type="button" class="tag verify ${par[0]}" data-vreport="${v.id}" title="${esc(par[2])}">${esc(par[1] + suffixe)} <span class="tag-cta">${esc(tr('verify.badge.see-report'))}</span></button>`;
}

