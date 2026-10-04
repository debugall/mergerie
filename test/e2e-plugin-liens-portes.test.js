'use strict';
/* LES PORTES QUE LE CŒUR TIENT POUR LE PLUGIN LIENS — sans le plugin lui-même (une doublure, test/fixtures/plugins/links-stub, tient sa place) :
 *
 *   - le contexte écrit à un agent (`recent.md`) nomme les services d'un dépôt et leurs adresses… quand le plugin est là, et s'en passe sinon ;
 *   - `/api/links/local-suggestion` relie un dossier à son dépôt (le remote de son `.git/config`) puis demande au plugin le service et la case « local » ;
 *   - le porteur d'un ticket (`/api/jira/issues/:key/carrier`) est testé dans `e2e-couverture-mr-jira`.
 *
 * `src/` NE SE CHARGE QU'APRÈS `startApp()` : un require en tête de fichier viserait la base de production. Un seul `startApp()` pour tout le fichier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/app');

describe('Les portes du cœur pour le plugin Liens', () => {
  let app; let repoId; let dossier;

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/api-core.git', project: 'groupe/api-core' })).body.id;
    // Un dossier de travail dont le remote est ce dépôt : ce que `origineDuDossier` lit dans `.git/config`.
    dossier = fs.mkdtempSync(path.join(app.dataDir, 'compose-'));
    fs.mkdirSync(path.join(dossier, '.git'));
    fs.writeFileSync(path.join(dossier, '.git', 'config'), '[remote "origin"]\n\turl = https://gitlab.test/groupe/api-core.git\n');
  });
  after(async () => { if (app) await app.stop(); });

  const suggestion = async (dir) => (await app.api('GET', `/api/links/local-suggestion?dir=${encodeURIComponent(dir)}`)).body;
  const ecrireRecent = async () => {
    // eslint-disable-next-line global-require
    const input = require('../src/agent/input');
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'clones-'));
    const rel = await input.ecrireRecent(racine, [{ repo_id: repoId, project: 'groupe/api-core' }]);
    return fs.readFileSync(path.join(racine, rel), 'utf8');
  };

  test('sans le plugin : rien à proposer au compose, et le contexte de l’agent se passe des services', async () => {
    assert.deepEqual(await suggestion(dossier), { service: null, ports: [] });
    assert.doesNotMatch(await ecrireRecent(), /Services et adresses/);
  });

  test('avec le plugin : le dossier est relié à son dépôt, le plugin répond pour son service', async () => {
    const inst = await app.api('POST', '/api/plugins/install', { path: path.join(__dirname, 'fixtures', 'plugins', 'links-stub') });
    assert.equal(inst.status, 200, JSON.stringify(inst.body));
    assert.equal((await app.api('POST', '/api/plugins/links/enable')).body.ok, true);

    const s = await suggestion(dossier);
    assert.deepEqual(s.service, { id: 5, name: 'api', project: 'groupe/api-core' });
    assert.deepEqual(s.environment, { id: 1, name: 'local' });
    const vus = (await app.api('GET', '/api/plugins/links/vus')).body.vus;
    assert.deepEqual(vus.filter((v) => v[0] === 'localSuggestion'), [['localSuggestion', repoId, 'groupe/api-core']], 'le cœur donne le dépôt et son nom — le plugin ne lit jamais le disque');

    // Un dossier sans remote, ou dont le remote n'est pas un dépôt suivi : rien, sans même déranger le plugin.
    const nu = fs.mkdtempSync(path.join(app.dataDir, 'nu-'));
    assert.deepEqual(await suggestion(nu), { service: null, ports: [] });
    assert.deepEqual(await suggestion(''), { service: null, ports: [] });
    assert.equal((await app.api('GET', '/api/plugins/links/vus')).body.vus.filter((v) => v[0] === 'localSuggestion').length, 1);
  });

  test('le contexte de l’agent nomme les services du dépôt et leurs adresses par environnement', async () => {
    await app.api('POST', '/api/plugins/links/set', { repo_id: repoId, envs: [{ env: 'recette' }] });
    const texte = await ecrireRecent();
    assert.match(texte, /### Services et adresses/);
    assert.match(texte, /- \*\*api\*\* : recette → https:\/\/api\.recette\.test\//);
  });

  test('un plugin qui ne répond pas ne casse pas la préparation d’une session', async () => {
    assert.equal((await app.api('POST', '/api/plugins/links/disable')).body.ok, true);
    assert.doesNotMatch(await ecrireRecent(), /Services et adresses/, 'plugin désactivé : la section disparaît, le fichier s’écrit');
  });
});
