'use strict';
/* Le plugin de test : chaque primitive du ctx, une fois. */
let vus = [];
let compteur = 0;
module.exports = {
  async activate(ctx) {
    ctx.i18n.register('fr', { 'hello-fixture.tab': 'Hello', 'hello-fixture.notif': 'Hello a sonné' });
    ctx.i18n.register('en', { 'hello-fixture.tab': 'Hello', 'hello-fixture.notif': 'Hello rang' });
    ctx.db.migrate([
      { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_hello_fixture_note (id INTEGER PRIMARY KEY, texte TEXT NOT NULL, at TEXT)' },
      { version: 2, up: (db) => db.exec('CREATE INDEX IF NOT EXISTS plugin_hello_fixture_note_at ON plugin_hello_fixture_note (at)') },
    ]);
    ctx.db.classify('plugin_hello_fixture_note', 'L');
    ctx.ui.registerTab({ id: 'hello', label: 'Hello', icon: 'i-plug', i18n: { label: 'hello-fixture.tab' }, searchField: '#helloSearch', foldedByDefault: false });
    ctx.ui.registerSettingsTab({ id: 'hellocfg', label: 'Hello', followsTab: 'hello' });
    ctx.ui.registerAction({ id: 'hello-say', target: 'mr', label: 'Dire bonjour' });
    ctx.ui.registerBriefSection({ id: 'hello-brief', label: 'Hello' });
    ctx.ui.registerLinkKind({ kind: 'hello', label: 'Hello' });
    ctx.ui.registerPaletteProvider((q) => (q.includes('hello') ? [{ label: 'Hello : ouvrir', ref: 'x', nav: { open: 1 } }] : []));
    ctx.notify.registerKind({ type: 'hello_rang', label: 'Hello a sonné', default: true });
    ctx.events.on('session.finished', (p) => { vus.push(p); });
    ctx.repos.onRemoved((r) => { vus.push({ removed: r.id }); });
    ctx.schedule(1000, () => { compteur += 1; }, { inDemo: true });
    ctx.services.register('echo', (p) => ({ echo: p, greeting: ctx.settings.get('greeting') }));
    ctx.http.router.get('/ping', (req) => ({ pong: true, greeting: ctx.settings.get('greeting'), q: req.query.q || null, lang: req.lang }));
    ctx.http.router.post('/notes', (req) => {
      const r = ctx.db.prepare('INSERT INTO plugin_hello_fixture_note (texte, at) VALUES (?, ?)').run(String(req.body.texte || ''), new Date().toISOString());
      return { id: Number(r.lastInsertRowid) };
    });
    ctx.http.router.get('/notes', () => ({ notes: ctx.db.prepare('SELECT id, texte FROM plugin_hello_fixture_note ORDER BY id').all() }));
    ctx.http.router.get('/seen', () => ({ seen: vus, ticks: compteur, token: ctx.secrets.has('token'), env: ctx.env.get('HELLO_FIXTURE_X') || null }));
    ctx.http.router.post('/ring', async () => { ctx.notify.push('hello_rang', { n: 1 }); await ctx.events.emit('hello-fixture.pinged', { n: 1 }); return { rang: true }; });
    ctx.http.router.get('/boom', () => { const e = new Error('boom demandé'); e.status = 418; throw e; });
    ctx.http.router.get('/repos', () => ({ repos: ctx.repos.list().length }));
    ctx.http.router.get('/service', async () => ctx.services.call('hello-fixture.echo', { a: 1 }));
    ctx.demo.seed((c) => { c.db.prepare("INSERT INTO plugin_hello_fixture_note (texte, at) VALUES ('démo', '2026-01-01')").run(); });
    ctx.log('activé');
  },
  async deactivate() { vus = []; compteur = 0; },
};
