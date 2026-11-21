'use strict';
/* UN RÉGLAGE DE PLUGIN AU NOM DE SECRET, SANS `x-secret` : le coffre (Réglages → Sécurité) ne le chiffre pas, il reste
 * en clair dans les réglages du plugin. Le chargeur le repère et la carte du plugin le dit — pour `api_key`, pas pour
 * `token` (marqué), ni `password_hint` (`x-secret: false` assumé), ni `user` (un identifiant). Un plugin sans tel
 * réglage n'a pas l'avertissement. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startApp, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;
const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');

describe('Plugins — réglage au nom de secret hors du coffre', () => {
  let app; let navigateur; let page;
  const de = async (nom) => (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === nom);

  before(async () => {
    app = await startApp({ plugins: [] });
    await app.configure();
    for (const nom of ['clear-secret', 'hidden-state']) {
      const r = await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, nom) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  test('l’API liste le seul réglage concerné', async () => {
    assert.deepEqual((await de('clear-secret')).clearSecrets, ['api_key']);
    assert.deepEqual((await de('hidden-state')).clearSecrets, []);
  });

  test('il reste bien en clair, le vrai secret est masqué', async () => {
    assert.equal((await app.api('POST', '/api/plugins/clear-secret/enable')).body.ok, true);
    await app.api('PUT', '/api/plugins/clear-secret/settings', { api_key: 'cle-en-clair', token: 'jeton' });
    const s = (await app.api('GET', '/api/plugins/clear-secret/settings')).body;
    assert.deepEqual([s.api_key, s.token], ['cle-en-clair', '***']);
  });

  test('la carte du plugin l’annonce, pas celle d’un plugin sans tel réglage', { skip: dispo ? false : MSG_NAVIGATEUR }, async () => {
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1300, height: 950 } });
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.click('nav button[data-tab="admin"]');
    await page.click('#tab-admin .subnav [data-sub="plugins"]');
    const avert = page.locator('#pluginList [data-plugin="clear-secret"] .plugin-clear-secrets');
    await avert.waitFor({ timeout: ATTENTE });
    const texte = await avert.textContent();
    assert.match(texte, /api_key/);
    assert.doesNotMatch(texte, /token|password_hint|user/);
    assert.equal(await page.locator('#pluginList [data-plugin="hidden-state"] .plugin-clear-secrets').count(), 0);
  });
});
