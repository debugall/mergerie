'use strict';
/* La ligne d'un dépôt reçoit le dépôt ; la fenêtre de lancement d'une vérification reçoit les dossiers « in place » ; le bus front dit la fin d'un job. */
ui.onDecorator('porte', (r) => `<button type="button" class="lien-reglage" data-fixture-porte="${esc(r.id)}">porte ${esc(r.project)}${r.has_compose ? ' (compose)' : ''}</button>`);
ui.onDecorator('lancement', (o) => `<div data-fixture-lancement="${esc(JSON.stringify(o.dirs))}"></div>`);
window.__jobsFinis = [];
events.on('job.finished', (j) => { window.__jobsFinis.push(j); });
