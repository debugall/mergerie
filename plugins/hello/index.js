'use strict';
/* Hello — activate(ctx) reçoit le ctx (docs/plugins/API.md) ; deactivate() rend ce qui a été pris.
   Tout ce que ce plugin fait passe par le ctx : rien n'importe src/ de Mergerie. */

const MIGRATIONS = [
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_hello_event (id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload TEXT, at TEXT NOT NULL)' },
];

async function activate(ctx) {
  ctx.i18n.register('fr', require('./ui/i18n').fr);
  ctx.i18n.register('en', require('./ui/i18n').en);
  ctx.db.migrate(MIGRATIONS);
  ctx.db.classify('plugin_hello_event', 'L');

  // Un onglet, replié d'office (comme Git, Docker et Liens) : on le déplie dans Réglages → Général → Menus.
  ctx.ui.registerTab({ id: 'hello', label: 'Hello', icon: 'i-plug', i18n: { label: 'hello.nav', title: 'hello.tab.title' } });

  // Chaque événement écouté est journalisé et noté en base : l'onglet les affiche.
  const noter = (nom) => (payload) => {
    ctx.log(`événement ${nom} (v${payload.version})`);
    ctx.db.prepare('INSERT INTO plugin_hello_event (name, payload, at) VALUES (?, ?, ?)').run(nom, JSON.stringify(payload), new Date().toISOString());
  };
  for (const nom of ['app.ready', 'session.finished', 'review.completed', 'verify.finished', 'mr.created', 'converge.finished', 'repo.deleted', 'app.shutdown']) ctx.events.on(nom, noter(nom));

  // /api/plugins/hello/ping et /events : ce que l'onglet lit.
  ctx.http.router.get('/ping', () => ({ ok: true, greeting: ctx.settings.get('greeting') }));
  ctx.http.router.get('/events', () => ({ events: ctx.db.prepare('SELECT name, payload, at FROM plugin_hello_event ORDER BY id DESC LIMIT 50').all().map((e) => ({ ...e, payload: JSON.parse(e.payload) })) }));
  ctx.log('activé');
}

async function deactivate() {
  // Le chargeur retire lui-même abonnements, routes, tâches et déclarations d'écran ; les tables restent.
}

module.exports = { activate, deactivate, MIGRATIONS };
