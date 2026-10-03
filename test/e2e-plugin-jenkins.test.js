'use strict';
/* LE PLUGIN JENKINS, EMBARQUÉ : actif au démarrage, désactivable À CHAUD sans rien perdre, et
 * — c'est la non-régression explicite — un build lancé puis terminé produit EXACTEMENT la
 * notification et les événements d'avant l'extraction. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

describe('Plugin Jenkins — embarqué, à chaud, sans régression', () => {
  let app; let srv; let events; let notify; let jkVeille;

  before(async () => {
    app = await startApp();
    await app.configure();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [{ name: 'dossier', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [{ name: 'deploy', color: 'blue', buildable: true }] }];
    mock.state.details['/job/dossier/job/deploy'] = { name: 'deploy', color: 'blue', buildable: true, property: [], builds: [{ number: 41, result: 'SUCCESS', building: false, timestamp: 1, duration: 10, url: '' }] };
    await app.configureJenkins({ jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token });
    /* eslint-disable global-require */
    events = require('../src/core/events');
    notify = require('../src/core/notify');
    jkVeille = require('../plugins/jenkins/src/veille');
    /* eslint-enable global-require */
  });
  after(async () => { if (srv) await srv.close(); if (app) await app.stop(); });

  const fiche = async () => (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === 'jenkins');

  test('au démarrage : actif, embarqué, dans la page avec son onglet, son sous-onglet et sa pastille', async () => {
    const f = await fiche();
    assert.deepEqual([f.builtin, f.active, f.state, f.origin], [true, true, 'active', 'builtin']);
    assert.ok(f.permissions.includes('net') && f.permissions.includes('db'));
    assert.deepEqual(f.events.emits, ['jenkins.job.started', 'jenkins.job.finished']);
    assert.ok(f.events.listens.includes('repo.deleted'));
    const html = (await app.api('GET', '/')).text;
    assert.ok(html.includes('data-tab="jenkins"') && html.includes('id="tab-jenkins"') && html.includes('id="jenkinsModal"'), 'onglet et modales');
    assert.ok(html.includes('data-sub="jenkinscfg"') && html.includes('id="sub-jenkinscfg"'), 'le sous-onglet de réglages');
    assert.ok(html.includes('<symbol id="i-pipeline"'), 'le symbole du sprite');
    assert.ok(html.includes('/plugins/jenkins/bundle.js') && html.includes('/plugins/jenkins/ui/i18n.js'), 'bundle et dictionnaire');
    const ordre = [...html.matchAll(/<button data-tab="([a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ordre, ['review', 'task', 'agents', 'notes', 'jira', 'git', 'docker', 'jenkins', 'links', 'dashboard', 'admin'], 'à sa place d’avant, avant Liens');
  });

  test('non-régression : lancer puis finir un build produit la même notification et les événements documentés', async () => {
    const vus = [];
    const off1 = events.on('jenkins.job.started', (p) => vus.push(p));
    const off2 = events.on('jenkins.job.finished', (p) => vus.push(p));
    const curseur = notify.latestId();
    const r = await app.api('POST', '/api/plugins/jenkins/build', { path: 'dossier/deploy', parameters: { BRANCH: 'feat/x' }, since: 41 });
    assert.equal(r.status, 200);
    assert.equal(r.body.queued, true);
    assert.deepEqual(jkVeille.attendus(), ['dossier/deploy'], 'le serveur attend la fin du build');
    assert.deepEqual(vus[0], { version: 1, path: 'dossier/deploy', since: 41, parameters: { BRANCH: 'feat/x' } });

    // Le build suivant finit en échec : le tour de veille le voit.
    mock.state.details['/job/dossier/job/deploy'].builds.unshift({ number: 42, result: 'FAILURE', building: false, timestamp: 2, duration: 10, url: '' });
    const cfg = { jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token };
    assert.equal(await jkVeille.tourJenkins(cfg), 1);
    const notifs = notify.since(curseur).filter((e) => e.type === 'jenkins_done');
    assert.equal(notifs.length, 1);
    const { id, at, ...fait } = notifs[0];
    assert.deepEqual(fait, { type: 'jenkins_done', path: 'dossier/deploy', number: 42, result: 'FAILURE', ok: false }, 'la notification d’avant, champ pour champ');
    assert.deepEqual(vus[1], { version: 1, path: 'dossier/deploy', number: 42, result: 'FAILURE', ok: false });
    assert.deepEqual(jkVeille.attendus(), []);
    off1(); off2();
  });

  test('désactiver à chaud : plus de route, plus d’onglet, plus de tâche — et les tables restent ; réactiver retrouve l’historique', async () => {
    await app.api('POST', '/api/plugins/jenkins/links', { repo_id: (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id, job_path: 'dossier/deploy', param: 'BRANCH' });
    assert.equal((await app.api('GET', '/api/plugins/jenkins/links')).body.links.length, 1);
    const horloge = require('../src/plugins/horloge'); // eslint-disable-line global-require
    assert.equal(horloge.tachesDe('jenkins').length, 1, 'la veille tourne');

    const off = await app.api('POST', '/api/plugins/jenkins/disable');
    assert.equal(off.status, 200);
    for (const p of ['/jobs', '/links', '/status', '/build-links?path=x']) {
      assert.equal((await app.api('GET', `/api/plugins/jenkins${p}`)).status, 404, `${p} ne répond plus`);
    }
    assert.equal((await app.api('POST', '/api/plugins/jenkins/build', { path: 'dossier/deploy' })).status, 404);
    assert.equal(horloge.tachesDe('jenkins').length, 0, 'aucune tâche planifiée Jenkins ne tourne');
    assert.equal(events.ecoutesPar('jenkins').length, 0, 'plus aucun abonnement');
    const html = (await app.api('GET', '/')).text;
    assert.ok(!html.includes('data-tab="jenkins"') && !html.includes('data-sub="jenkinscfg"') && !html.includes('/plugins/jenkins/bundle.js'), 'onglet, sous-onglet et bundle retirés');
    assert.equal((await app.api('GET', '/plugins/jenkins/bundle.js')).status, 404);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM plugin_jenkins_link').get().c, 1, 'la table plugin_jenkins_* est intacte');
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM plugin_secret WHERE plugin = 'jenkins'").get().c, 1, 'le jeton aussi');
    assert.equal((await app.api('GET', '/api/status')).status, 200, 'Mergerie répond');
    assert.equal((await fiche()).state, 'inactive');
    assert.equal(app.db.prepare("SELECT enabled FROM plugin_state WHERE name = 'jenkins'").get().enabled, 0, 'l’état est persisté : un redémarrage le trouverait désactivé');

    const on = await app.api('POST', '/api/plugins/jenkins/enable');
    assert.equal(on.body.ok, true, on.body.error || '');
    assert.equal((await app.api('GET', '/api/plugins/jenkins/links')).body.links[0].job_path, 'dossier/deploy', 'l’historique est là');
    assert.equal((await app.api('GET', '/api/plugins/jenkins/jobs')).body.configured, true, 'et la connexion aussi');
    assert.equal(horloge.tachesDe('jenkins').length, 1);
    assert.ok((await app.api('GET', '/')).text.includes('data-tab="jenkins"'));
  });

  test('un genre de lien de todo vient du plugin ACTIF : « build » passe, un genre inconnu non, et plus de « build » une fois le plugin éteint', async () => {
    const creer = (kind) => app.api('POST', '/api/todos', { title: 'Relancer', link_kind: kind, link_ref: 'equipe/deploy#42' });
    const ok = await creer('build');
    assert.equal(ok.status, 200, 'le genre déclaré par registerLinkKind est accepté sans que la table le connaisse');
    assert.equal(ok.body.link_kind, 'build');
    assert.notEqual((await creer('inconnu')).status, 200, 'un genre que personne ne déclare reste refusé');
    await app.api('POST', '/api/plugins/jenkins/disable');
    assert.notEqual((await creer('build')).status, 200, 'plugin éteint : son genre n’est plus accepté en écriture');
    assert.equal((await app.api('GET', '/api/todos')).body.todos.find((x) => x.id === ok.body.id).link_kind, 'build', 'mais la todo déjà liée garde son lien');
    assert.equal((await app.api('POST', '/api/plugins/jenkins/enable')).body.ok, true);
    assert.equal((await creer('build')).status, 200, 'réactivé : accepté de nouveau');
  });

  test('un dépôt retiré emporte ses jobs liés — l’événement remplace la clé étrangère', async () => {
    const repo = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/autre', project: 'grp/autre' })).body;
    await app.api('POST', '/api/plugins/jenkins/links', { repo_id: repo.id, job_path: 'autre/job' });
    assert.ok((await app.api('GET', '/api/plugins/jenkins/links')).body.links.some((l) => l.job_path === 'autre/job'));
    await app.api('DELETE', `/api/repos/${repo.id}`);
    assert.ok(!(await app.api('GET', '/api/plugins/jenkins/links')).body.links.some((l) => l.job_path === 'autre/job'));
  });

  test('la palette propose un job rattaché, par le fournisseur du plugin', async () => {
    const res = (await app.api('POST', '/api/launcher', { q: 'deploy' })).body.results;
    const j = res.find((r) => r.kind === 'plugin:jenkins');
    assert.ok(j, `une entrée du plugin : ${res.map((r) => r.kind).join(', ')}`);
    assert.deepEqual(j.nav, { plugin: 'jenkins', jenkins_path: 'dossier/deploy' });
    assert.equal(j.label, 'Ouvrir le job dossier/deploy');
  });
});
