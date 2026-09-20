'use strict';
/* Converger : panneau de run et modale de lancement. */
// @expose convergeBoxHtml
/* ---------- Converger : panneau de run + modale de lancement ---------- */
// Bandeau d'état de la dernière boucle de convergence d'une MR.
function convergeBoxHtml(run) {
  if (!run) return '';
  const n = (v) => fmtNote10(v);
  /* `needs_input` : la boucle s'arrête parce que l'IA a posé des questions. Il manquait des
     trois tables — couleur, icône et libellé —, donc le bandeau affichait la clé brute
     `converge.status.needs_input` à l'endroit exact où l'on attend une consigne. */
  const cls = { converged: 'ok', capped: 'warn', regressed: 'warn', no_change: 'warn', needs_input: 'warn', stopped: 'muted', error: 'danger', running: 'run' }[run.status] || 'muted';
  const icon = { converged: 'i-check', capped: 'i-clock', regressed: 'i-reset', no_change: 'i-info', needs_input: 'i-inbox', stopped: 'i-stop', error: 'i-close', running: 'i-zap' }[run.status] || 'i-info';
  const label = tr(`converge.status.${run.status}`, { note: n(run.best_note), passes: run.passes_done, threshold: run.threshold });
  const delta = (run.start_note != null && run.best_note != null && run.best_note !== run.start_note)
    ? `<span class="converge-delta">${n(run.start_note)} → ${n(run.best_note)}</span>` : '';
  /* A15 — QUELLE VERSION EST LA MEILLEURE, et ce que la boucle attend. `best_version` était
     écrit à chaque passe et lu par personne : le bandeau annonçait « 8,1/10 » sans dire de
     QUELLE version — or après trois passes, le rapport affiché n'est pas forcément celui qui
     porte la meilleure note, et c'est justement celui qu'on veut relire. Le bouton y va.
     `needs_input` dit en plus ce qui bloque : la boucle ne repartira pas toute seule. */
  const meilleure = run.best_version != null
    ? `<button type="button" class="lien-reglage converge-best" data-converge-version="${run.best_version}" title="${esc(tr('converge.best.title'))}">${esc(tr('converge.best', { v: run.best_version }))}</button>` : '';
  const attente = run.status === 'needs_input'
    ? `<div class="converge-wait muted">${esc(tr('converge.waiting'))}</div>` : '';
  return `<div class="converge-box converge-${cls}">
      <svg class="ico"><use href="#${icon}"/></svg>
      <div><strong>${tr('converge.title')}</strong> — ${esc(label)} ${delta} ${meilleure}${attente}</div>
    </div>`;
}

