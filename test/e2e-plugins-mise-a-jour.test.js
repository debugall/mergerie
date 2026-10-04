'use strict';
/* METTRE À JOUR UN PLUGIN INSTALLÉ : l'adresse d'installation est gardée, et « Mettre à jour » la rejoue — clone, désactive, remplace le dossier, réactive —
 * sans toucher aux données ni aux réglages. Un dépôt git LOCAL tient lieu de forge : on y publie une version 1.0.1 après l'installation de la 1.0.0.
 * Un plugin dont l'adresse est inconnue (déposé à la main, ou installé avant que l'adresse soit gardée) ne peut pas être mis à jour : le bouton le dit. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'hello-fixture');
const GIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...GIT, ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

function copier(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copier(s, d); else fs.copyFileSync(s, d);
  }
}
/** Pose la version `v` du plugin dans le dépôt (manifeste + une migration de plus à la 1.0.1). */
function publier(depot, v) {
  const m = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'plugin.json'), 'utf8'));
  m.version = v;
  fs.writeFileSync(path.join(depot, 'plugin.json'), JSON.stringify(m, null, 2));
  git(depot, 'add', '-A'); git(depot, 'commit', '-q', '-m', `v${v}`);
}

describe('Plugins — mettre à jour depuis la source d’installation', () => {
  let app; let depot;
  const de = async (nom) => (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === nom);

  before(async () => {
    app = await startApp(); await app.configure();
    depot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-source-'));
    copier(FIXTURE, depot);
    git(depot, 'init', '-q', '-b', 'main');
    publier(depot, '1.0.0');
  });
  after(async () => { if (app) await app.stop(); fs.rmSync(depot, { recursive: true, force: true }); });

  test('installer depuis git garde l’adresse ; le plugin peut être mis à jour', async () => {
    const r = await app.api('POST', '/api/plugins/install', { url: depot });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await de('hello-fixture');
    assert.deepEqual([p.version, p.canUpdate, p.source.url], ['1.0.0', true, depot]);
    assert.equal((await app.api('POST', '/api/plugins/hello-fixture/enable')).body.ok, true);
    await app.api('PUT', '/api/plugins/hello-fixture/settings', { greeting: 'salut', url: 'http://p.test', token: 'jeton-secret' });
  });

  test('« Mettre à jour » : la 1.0.1 remplace la 1.0.0, le plugin reste actif, réglages et jeton intacts', async () => {
    publier(depot, '1.0.1');
    const r = await app.api('POST', '/api/plugins/hello-fixture/update');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.from, r.body.to, r.body.wasActive, r.body.active], ['1.0.0', '1.0.1', true, true]);
    const p = await de('hello-fixture');
    assert.deepEqual([p.version, p.state], ['1.0.1', 'active']);
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/ping')).body.greeting, 'salut', 'ses réglages sont gardés');
    assert.equal((await app.api('POST', '/api/plugins/hello-fixture/secret', { key: 'token' })).body.value, 'jeton-secret', 'son jeton aussi');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, 'plugins', 'hello-fixture', 'plugin.json'), 'utf8')).version, '1.0.1', 'le dossier installé est la nouvelle version');
  });

  test('un plugin désactivé le reste après la mise à jour', async () => {
    await app.api('POST', '/api/plugins/hello-fixture/disable');
    publier(depot, '1.0.2');
    const r = await app.api('POST', '/api/plugins/hello-fixture/update');
    assert.deepEqual([r.status, r.body.to, r.body.wasActive, r.body.active], [200, '1.0.2', false, false]);
    assert.equal((await de('hello-fixture')).state, 'inactive');
  });

  test('source injoignable : la mise à jour échoue proprement et le plugin reste tel quel', async () => {
    await app.api('POST', '/api/plugins/hello-fixture/enable');
    fs.renameSync(depot, `${depot}-parti`);
    const r = await app.api('POST', '/api/plugins/hello-fixture/update');
    fs.renameSync(`${depot}-parti`, depot);
    assert.notEqual(r.status, 200, 'refusée');
    const p = await de('hello-fixture');
    assert.deepEqual([p.version, p.state], ['1.0.2', 'active'], 'le clone échoue AVANT de toucher au plugin : il reste actif, en 1.0.2');
  });

  test('un plugin sans adresse gardée, ou embarqué, ne se met pas à jour (409)', async () => {
    copier(path.join(__dirname, 'fixtures', 'plugins', 'ui-cibles'), path.join(app.dataDir, 'plugins', 'ui-cibles'));
    await app.api('POST', '/api/plugins/rescan');
    const p = await de('ui-cibles');
    assert.deepEqual([p.canUpdate, p.source], [false, null]);
    assert.equal((await app.api('POST', '/api/plugins/ui-cibles/update')).status, 409);
    assert.equal((await app.api('POST', '/api/plugins/hello/update')).status, 409, 'un embarqué se met à jour avec Mergerie');
    assert.equal((await app.api('POST', '/api/plugins/inconnu/update')).status, 404);
  });

  describe('dans le navigateur', { skip: navigateurDispo().dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      await page.goto(app.base);
      await page.waitForSelector('nav button[data-tab="admin"]');
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('le bouton « Mettre à jour » : actif avec une source, grisé et expliqué sans ; un clic met à jour', async () => {
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('#tab-admin .subnav [data-sub="plugins"]').click();
      await page.waitForSelector('#pluginList [data-plugin="hello-fixture"]');
      assert.equal(await page.locator('#pluginList [data-plugin="hello"] [data-plugin-update]').count(), 0, 'pas de bouton sur un embarqué');
      const sans = page.locator('#pluginList [data-plugin="ui-cibles"] button[disabled]', { hasText: /mettre à jour/i });
      assert.equal(await sans.count(), 1, 'grisé sans source');
      assert.match(await sans.getAttribute('title'), /Adresse d.installation inconnue/);
      publier(depot, '1.0.3');
      await Promise.all([page.waitForEvent('load'), page.locator('#pluginList [data-plugin="hello-fixture"] [data-plugin-update]').click()]);
      assert.equal((await de('hello-fixture')).version, '1.0.3');
    });
  });
});
