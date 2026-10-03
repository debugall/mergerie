'use strict';
/* LA DOCUMENTATION NE PEUT PAS MENTIR : chaque exemple de docs/plugins/examples/ est chargé sur un
 * ctx de test, activé, puis exercé. Un exemple qui ne tourne plus fait rougir la CI — avant qu'un
 * lecteur ne le découvre en le recopiant. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('../sdk');

const DIR = path.join(__dirname, '..', 'docs', 'plugins', 'examples');

describe('Documentation des plugins — les exemples s’exécutent', () => {
  test('chaque exemple a un manifeste valide et s’active sur createTestContext', async () => {
    const exemples = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
    assert.ok(exemples.length >= 4, 'au moins les quatre exemples cités par API.md');
    for (const f of exemples) {
      const ex = require(path.join(DIR, f)); // eslint-disable-line global-require
      assert.deepEqual(sdk.validateManifest(ex.manifest), [], `${f} : manifeste valide`);
      const t = sdk.createTestContext({ manifest: ex.manifest });
      await ex.activate(t.ctx);
      t.close();
    }
  });

  test('activate-minimal : un réglage et une route', async () => {
    const ex = require(path.join(DIR, 'activate-minimal.js')); // eslint-disable-line global-require
    const t = sdk.createTestContext({ manifest: ex.manifest });
    await ex.activate(t.ctx);
    assert.deepEqual((await t.http.call('GET', '/ping')).body, { ok: true, greeting: 'bonjour' });
    await t.http.call('PUT', '/greeting', { body: { value: 'salut' } });
    assert.equal((await t.http.call('GET', '/ping')).body.greeting, 'salut');
    assert.match(t.log.join('\n'), /activé/);
    t.close();
  });

  test('db-migrations : en avant seulement, sous le préfixe', async () => {
    const ex = require(path.join(DIR, 'db-migrations.js')); // eslint-disable-line global-require
    const t = sdk.createTestContext({ manifest: ex.manifest });
    await ex.activate(t.ctx);
    assert.match(t.log.join('\n'), /migrations jouées : 2/);
    assert.equal(t.ctx.db.migrate(ex.MIGRATIONS), 0, 'rejouer ne fait rien');
    assert.equal((await t.http.call('POST', '/notes', { body: { texte: 'a' } })).body.id, 1);
    assert.deepEqual((await t.http.call('GET', '/notes')).body.notes, [{ id: 1, texte: 'a' }]);
    assert.throws(() => t.ctx.db.prepare('SELECT * FROM repo').all(), /n'appartient pas au plugin/);
    t.close();
  });

  test('events-and-schedule : le bus, l’horloge, la notification', async () => {
    const ex = require(path.join(DIR, 'events-and-schedule.js')); // eslint-disable-line global-require
    const t = sdk.createTestContext({ manifest: ex.manifest });
    await ex.activate(t.ctx);
    let compte = null;
    t.bus.on('exemple-events.compte', (p) => { compte = p.sessions; });
    for (let i = 1; i <= 10; i += 1) await t.emit('session.finished', { kind: 'task', id: i, action: 'run', status: 'done' });
    assert.equal(compte, 10);
    assert.deepEqual(t.notifications.map((n) => [n.type, n.data.n]), [['exemple_compte', 10]]);
    assert.equal(await t.tick(), 1, 'la tâche périodique tourne à la main');
    assert.equal((await t.http.call('GET', '/compte')).body.sessions, 10);
    await ex.deactivate();
    t.close();
  });

  test('ui-registrations : ce que le serveur enregistre', async () => {
    const ex = require(path.join(DIR, 'ui-registrations.js')); // eslint-disable-line global-require
    const t = sdk.createTestContext({ manifest: ex.manifest });
    await ex.activate(t.ctx);
    const ui = t.ui();
    assert.deepEqual(ui.tabs.map((x) => [x.id, x.foldedByDefault, x.searchField]), [['exemple-ui', true, '#exempleSearch']]);
    assert.deepEqual(ui.settingsTabs.map((x) => x.followsTab), ['exemple-ui']);
    assert.deepEqual(ui.actions.map((x) => `${x.target}:${x.id}`), ['mr:dire-bonjour']);
    assert.deepEqual(ui.decorators.map((x) => x.target), ['mr-badge']);
    assert.equal((await t.registre.palette('exemple')).length, 1);
    t.close();
  });
});
