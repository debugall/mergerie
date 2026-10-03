'use strict';
/* LE TEST D'EXTÉRIORITÉ : le dossier `plugins/jenkins/` est copié dans `<dataDir>/plugins/`, le
 * dépôt n'a plus de plugin embarqué (un dossier vide tient lieu de `plugins/`), et Mergerie
 * démarre. Le plugin se charge alors comme un TIERS — dans un worker, désactivé d'office, à
 * activer depuis Réglages → Plugins — et répond exactement comme quand il est embarqué. C'est
 * la preuve que l'API publique suffit : rien dans le plugin ne dépend d'être dans le dépôt.
 *
 * Le dossier de plugins embarqués est substitué par `MERGERIE_BUILTIN_PLUGINS_DIR`, posé AVANT
 * le premier require du serveur — le chargeur le lit au chargement. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-sans-embarques-'));
process.env.MERGERIE_BUILTIN_PLUGINS_DIR = VIDE;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

function copier(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copier(s, d); else fs.copyFileSync(s, d);
  }
}

describe('Plugin Jenkins installé comme un tiers — même comportement, dans un worker', () => {
  let app; let srv;
  before(async () => {
    app = await startApp();
    await app.configure();
    copier(path.join(__dirname, '..', 'plugins', 'jenkins'), path.join(app.dataDir, 'plugins', 'jenkins'));
    copier(path.join(__dirname, '..', 'plugins', 'hello'), path.join(app.dataDir, 'plugins', 'hello'));
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [{ name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [{ name: 'api-build', color: 'blue', buildable: true }, { name: 'front-build', color: 'red', buildable: true }] }, { name: 'release', color: 'notbuilt', buildable: true }];
    mock.state.details['/job/boutique/job/api-build'] = { name: 'api-build', color: 'blue', buildable: true, property: [], builds: [{ number: 3, result: 'SUCCESS', building: false, timestamp: 1, duration: 1000, url: '' }] };
    mock.state.console['/job/boutique/job/api-build/3'] = 'tout va bien\nFinished: SUCCESS';
  });
  after(async () => {
    if (srv) await srv.close();
    if (app) await app.stop();
    fs.rmSync(VIDE, { recursive: true, force: true });
    delete process.env.MERGERIE_BUILTIN_PLUGINS_DIR;
  });

  test('sans dossier embarqué, Jenkins n’existe pas ; déposé chez l’utilisateur, il apparaît désactivé', async () => {
    assert.equal((await app.api('GET', '/api/plugins')).body.plugins.length, 0, 'aucun plugin embarqué');
    const r = await app.api('POST', '/api/plugins/rescan');
    const jk = r.body.plugins.find((p) => p.name === 'jenkins');
    assert.ok(jk, 'découvert');
    assert.deepEqual([jk.builtin, jk.origin, jk.enabled, jk.state], [false, 'user', false, 'inactive']);
    assert.ok(!(await app.api('GET', '/')).text.includes('data-tab="jenkins"'));
  });

  test('activé comme un tiers, la suite Jenkins passe : routes, jeton, liens, page, bundle', async () => {
    const on = await app.api('POST', '/api/plugins/jenkins/enable');
    assert.equal(on.body.ok, true, on.body.error || '');
    await app.configureJenkins({ jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token });

    const r = await app.api('GET', '/api/plugins/jenkins/jobs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.jobs.map((j) => [j.path, j.statut]), [['boutique/api-build', 'succes'], ['boutique/front-build', 'echec'], ['release', 'jamais']]);
    const d = await app.api('GET', '/api/plugins/jenkins/job?path=boutique%2Fapi-build');
    assert.equal(d.body.builds[0].number, 3);
    const c = await app.api('GET', '/api/plugins/jenkins/console?path=boutique%2Fapi-build&build=3');
    assert.match(c.body.text, /Finished: SUCCESS/);
    const avant = mock.state.calls.length;
    const b = await app.api('POST', '/api/plugins/jenkins/build', { path: 'boutique/api-build', parameters: { A: '1' } });
    assert.equal(b.body.queued, true);
    assert.equal(mock.state.calls.slice(avant).find((x) => x.method === 'POST' && /build/.test(x.path)).body, 'A=1', 'la requête part vraiment, depuis le worker');
    assert.equal((await app.api('GET', '/api/plugins/jenkins/job?path=')).status, 400);
    const lu = await app.api('GET', '/api/plugins/jenkins/settings');
    assert.equal(lu.body.jenkins_token, '***');
    assert.equal(lu.body.jenkins_user, mock.state.user);
    const t = await app.api('POST', '/api/plugins/jenkins/test', { jenkins_token: '***' });
    assert.equal(t.body.user, 'Moi Même');
    const repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    assert.equal((await app.api('POST', '/api/plugins/jenkins/links', { repo_id: repoId, job_path: 'boutique/api-build', param: 'BRANCH' })).status, 200);
    assert.deepEqual((await app.api('GET', '/api/plugins/jenkins/links')).body.links.map((l) => [l.project, l.job_path]), [['grp/app', 'boutique/api-build']]);
    const html = (await app.api('GET', '/')).text;
    assert.ok(html.includes('data-tab="jenkins"') && html.includes('id="tab-jenkins"') && html.includes('data-sub="jenkinscfg"'));
    assert.equal((await app.api('GET', '/plugins/jenkins/bundle.js')).status, 200);
    assert.equal((await app.api('GET', '/plugins/jenkins/ui/jenkins.css')).status, 200);
    const palette = (await app.api('POST', '/api/launcher', { q: 'api-build' })).body.results.find((x) => x.kind === 'plugin:jenkins');
    assert.equal(palette && palette.nav.jenkins_path, 'boutique/api-build', 'le fournisseur de palette répond depuis le worker');
    assert.equal((await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === 'jenkins').state, 'active');
  });

  test('hello, le plugin minimal, se charge aussi comme un tiers', async () => {
    const on = await app.api('POST', '/api/plugins/hello/enable');
    assert.equal(on.body.ok, true, on.body.error || '');
    const s = await app.api('GET', '/api/plugins/hello/settings');
    assert.equal(s.status, 200);
    assert.ok('greeting' in s.body);
    assert.equal((await app.api('GET', '/api/plugins/hello/ping')).body.ok, true);
  });
});
