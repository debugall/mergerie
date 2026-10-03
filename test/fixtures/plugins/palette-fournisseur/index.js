'use strict';
async function activate(ctx) {
  ctx.ui.registerPaletteProvider((q) => (/zorglub/i.test(String(q || ''))
    ? [
      { label: 'Zorglub sans groupe', ref: 'a', text: 'zorglub' },
      { label: 'Zorglub nommé', ref: 'b', text: 'zorglub', group: 'links', nav: { url: 'https://zorglub.test/' } },
    ] : []));
}
async function deactivate() { /* rien */ }
module.exports = { activate, deactivate };
