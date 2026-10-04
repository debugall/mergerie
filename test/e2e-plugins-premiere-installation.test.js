'use strict';
/* UNE PREMIÈRE INSTALLATION DÉMARRE SANS AUCUN PLUGIN. Hello, le seul plugin embarqué, est
 * désactivé sur une base neuve — rien dans la page, aucune route, aucune tâche — et s'active à la demande, à chaud.
 * (Un poste qui MONTE DE VERSION, lui, garde activés Docker, Jenkins et Liens, ses plugins sortis du cœur : c'est `unit-plugins-migration-jenkins.test.js`.)
 *
 * `startApp({ plugins: [] })` : le helper de la suite n'active aucun plugin non plus ;
 * on le dit ici en toutes lettres, et on voit ce que voit une personne qui installe Mergerie. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Première installation — tous les plugins embarqués désactivés', () => {
  let app;
  before(async () => { app = await startApp({ plugins: [] }); await app.configure(); });
  after(async () => { if (app) await app.stop(); });

  test('chaque plugin embarqué est présent, désactivé, inactif', async () => {
    const liste = (await app.api('GET', '/api/plugins')).body.plugins.filter((p) => p.builtin);
    assert.ok(liste.some((p) => p.name === 'hello'), 'hello est livré');
    for (const p of liste) assert.deepEqual([p.name, p.enabled, p.active, p.state], [p.name, false, false, 'inactive']);
  });

  test('la page ne montre ni onglet, ni sous-onglet, ni script de plugin ; leurs routes n’existent pas', async () => {
    const html = (await app.api('GET', '/')).text;
    for (const marque of ['data-tab="hello"', '/plugins/hello/bundle.js']) assert.ok(!html.includes(marque), marque);
    assert.equal((await app.api('GET', '/api/plugins/hello/ping')).status, 404);
  });

  test('on l’active à la demande, à chaud ; l’état est gardé', async () => {
    assert.equal((await app.api('POST', '/api/plugins/hello/enable')).body.ok, true);
    assert.ok((await app.api('GET', '/')).text.includes('data-tab="hello"'));
    assert.equal(app.db.prepare("SELECT enabled FROM plugin_state WHERE name = 'hello'").get().enabled, 1, 'un redémarrage le retrouverait activé');
  });
});
