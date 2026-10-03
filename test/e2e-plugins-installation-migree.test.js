'use strict';
/* L'INSTALLATION D'UN PLUGIN QUE LA MONTÉE DE VERSION AVAIT DÉJÀ MARQUÉ « ACTIVÉ ». Docker, Jenkins et Liens ont quitté le cœur : sur un poste qui les avait, la
 * migration pose l'état « activé » de chacun (`db/schema/18-plugins.js`), et le plugin doit s'ACTIVER TOUT SEUL le jour où on l'installe — sans redémarrage, sans clic sur
 * « Activer » — pour que les données retrouvées soient aussitôt montrées par son écran. Un plugin sans état antérieur, lui, reste désactivé après l'installation. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startApp } = require('./helpers/app');

const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');

describe('Plugins — installer un plugin dont l’état persisté dit « activé »', () => {
  let app;
  const de = async (nom) => (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === nom);

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { if (app) await app.stop(); });

  test('un plugin neuf reste désactivé après l’installation (le choix est à la personne)', async () => {
    const r = await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'ui-cibles') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = await de('ui-cibles');
    assert.deepEqual([f.enabled, f.active, f.state], [false, false, 'inactive']);
  });

  test('un plugin marqué « activé » par la migration s’active à l’installation, et sa page le montre', async () => {
    app.db.prepare("INSERT OR REPLACE INTO plugin_state (name, enabled, version, origin, updated_at) VALUES ('onglet-replie', 1, '', 'user', ?)").run(new Date().toISOString());
    assert.ok(!(await app.api('GET', '/')).text.includes('data-tab="replie"'), 'avant : rien dans la page');
    const r = await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'onglet-replie') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = await de('onglet-replie');
    assert.deepEqual([f.enabled, f.active, f.state], [true, true, 'active'], 'activé sans « Activer » et sans redémarrage');
    assert.ok((await app.api('GET', '/')).text.includes('data-tab="replie"'), 'son onglet est dans la page');
  });
});
