'use strict';
/* Le plugin, SANS Mergerie : un ctx en mémoire (createTestContext), activate(), puis ce qu'il fait.
   `node --test` suffit. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { activatePlugin } = require('../../../sdk');

describe('Hello', () => {
  test('activate() pose sa table, son onglet, ses routes, et note les événements reçus', async () => {
    const t = await activatePlugin(path.join(__dirname, '..'));
    assert.deepEqual(t.ctx.db.tables(), ['plugin_hello_event']);
    assert.deepEqual(t.ui().tabs.map((x) => x.id), ['hello']);
    assert.deepEqual((await t.http.call('GET', '/ping')).body, { ok: true, greeting: 'hello' });
    t.ctx.settings.set({ greeting: 'bonjour' });
    assert.equal((await t.http.call('GET', '/ping')).body.greeting, 'bonjour', 'un réglage se relit');
    await t.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
    const evts = (await t.http.call('GET', '/events')).body.events;
    assert.equal(evts.length, 1);
    assert.deepEqual([evts[0].name, evts[0].payload.id, evts[0].payload.version], ['session.finished', 1, 1]);
    assert.match(t.log.join('\n'), /événement session.finished/);
    await t.deactivate();
  });
});
