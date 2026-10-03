'use strict';
/* Le front de la fixture : l'onglet charge /ping, l'action « mr » rend un bouton. */
ui.onTabOpen('hello', async () => {
  const d = await api('/plugins/hello-fixture/ping');
  const el = $('#helloBox');
  if (el) el.textContent = `pong ${d.greeting}`;
});
ui.onAction('hello-say', { render: (m) => `<button role="menuitem" data-hello-say="${esc(m.id)}">Hello !${esc(m.iid)}</button>` });
ui.onBriefSection('hello-brief', () => '<div class="brief-item">hello</div>');
ui.onLinkKind('hello', (ref) => toast(`hello ${ref}`));
ui.onNotif('hello_rang', () => ({ title: tr('hello-fixture.notif'), body: '' }));
ui.onPaletteResult('hello-fixture', () => navTab('hello'));
window.HELLO_FIXTURE_CHARGE = true;
