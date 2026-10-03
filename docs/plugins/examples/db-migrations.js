'use strict';
/* Des tables préfixées `plugin_<nom>_` et des migrations rejouées EN AVANT seulement. */
const manifest = {
  name: 'exemple-db', version: '1.0.0', apiVersion: '1', displayName: 'Exemple DB', description: 'tables et migrations', main: 'index.js',
  permissions: ['db', 'http'],
};

const MIGRATIONS = [
  // Version 1 : la table. `IF NOT EXISTS` : la migration est notée dans plugin_migration, mais rester idempotent ne coûte rien.
  { version: 1, up: 'CREATE TABLE IF NOT EXISTS plugin_exemple_db_note (id INTEGER PRIMARY KEY, texte TEXT NOT NULL, at TEXT)' },
  // Version 2 : une fonction, quand du SQL ne suffit pas. Elle reçoit le même ctx.db.
  { version: 2, up: (db) => db.exec('CREATE INDEX IF NOT EXISTS plugin_exemple_db_note_at ON plugin_exemple_db_note (at)') },
];

async function activate(ctx) {
  const jouees = ctx.db.migrate(MIGRATIONS);   // 2 la première fois, 0 ensuite
  ctx.db.classify('plugin_exemple_db_note', 'L'); // de poste : jamais dans le dépôt d'équipe
  ctx.log(`migrations jouées : ${jouees}`);
  ctx.http.router.post('/notes', (req) => {
    const r = ctx.db.prepare('INSERT INTO plugin_exemple_db_note (texte, at) VALUES (?, ?)').run(String(req.body.texte || ''), new Date().toISOString());
    return { id: Number(r.lastInsertRowid) };
  });
  ctx.http.router.get('/notes', () => ({ notes: ctx.db.prepare('SELECT id, texte FROM plugin_exemple_db_note ORDER BY id').all() }));
  // Ceci serait REFUSÉ : `ctx.db.prepare('SELECT * FROM repo')` → « la table « repo » n'appartient pas au plugin ».
}

module.exports = { manifest, activate, MIGRATIONS };
