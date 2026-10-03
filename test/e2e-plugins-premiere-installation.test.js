'use strict';
/* UNE PREMIÈRE INSTALLATION DÉMARRE SANS AUCUN PLUGIN. Jenkins, hello : tous les plugins embarqués sont
 * désactivés sur une base neuve — rien dans la page, aucune route, aucune tâche — et s'activent à la demande, à chaud.
 * (Un poste qui MONTE DE VERSION, lui, garde Jenkins activé : c'est `unit-plugins-migration-jenkins.test.js`.)
 *
 * `startApp({ plugins: [] })` : le helper de la suite active Jenkins d'office, parce que presque tous les tests l'éprouvent ;
 * ici on lui demande de ne rien faire, et on voit ce que voit une personne qui installe Mergerie. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Première installation — tous les plugins embarqués désactivés', () => {
  let app;
  before(async () => { app = await startApp({ plugins: [] }); await app.configure(); });
  after(async () => { if (app) await app.stop(); });

  test('chaque plugin embarqué est présent, désactivé, inactif', async () => {
    const liste = (await app.api('GET', '/api/plugins')).body.plugins.filter((p) => p.builtin);
    for (const nom of ['hello', 'jenkins']) assert.ok(liste.some((p) => p.name === nom), `${nom} est livré`);
    for (const p of liste) assert.deepEqual([p.name, p.enabled, p.active, p.state], [p.name, false, false, 'inactive']);
  });

  test('la page ne montre ni onglet, ni sous-onglet, ni script de plugin ; leurs routes n’existent pas', async () => {
    const html = (await app.api('GET', '/')).text;
    for (const marque of ['data-tab="jenkins"', 'data-sub="jenkinscfg"', '/plugins/jenkins/bundle.js']) assert.ok(!html.includes(marque), marque);
    assert.equal((await app.api('GET', '/api/plugins/jenkins/jobs')).status, 404);
  });

  test('on l’active à la demande, à chaud ; l’état est gardé', async () => {
    assert.equal((await app.api('POST', '/api/plugins/jenkins/enable')).body.ok, true);
    assert.ok((await app.api('GET', '/')).text.includes('data-tab="jenkins"'));
    assert.equal(app.db.prepare("SELECT enabled FROM plugin_state WHERE name = 'jenkins'").get().enabled, 1, 'un redémarrage le retrouverait activé');
  });
});
