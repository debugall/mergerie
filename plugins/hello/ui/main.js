'use strict';
/* Le front du plugin : évalué dans une portée privée avec le kit `window.mergerie` (docs/plugins/UI.md).
   Les noms du kit ($, api, tr, esc, ui…) sont en portée ; rien d'autre du cœur. */
ui.onTabOpen('hello', async () => {
  const box = $('#helloBox');
  if (!box) return;
  box.innerHTML = skeleton(2);
  try {
    const [ping, d] = await Promise.all([api('/plugins/hello/ping'), api('/plugins/hello/events')]);
    box.innerHTML = `<p class="muted">${esc(tr('hello.greeting', { greeting: ping.greeting }))}</p>`
      + ((d.events || []).length
        ? d.events.map((e) => `<div class="card"><strong>${esc(e.name)}</strong> <span class="muted">v${esc(String(e.payload.version))} · ${esc(fmtDateTime(e.at))}</span><pre>${esc(JSON.stringify(e.payload, null, 1))}</pre></div>`).join('')
        : `<p class="muted">${esc(tr('hello.empty'))}</p>`);
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
});
