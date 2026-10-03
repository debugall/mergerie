'use strict'; module.exports = { activate(ctx) { ctx.http.router.get('/ok', () => ({ ok: true })); } };
