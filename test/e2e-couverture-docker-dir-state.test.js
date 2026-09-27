'use strict';
/* L'ÉTAT DES SERVICES D'UN RÉPERTOIRE (`/api/docker/dir-state`), demandé par la fenêtre de
   vérification « in place » avant de lancer : si le compose du répertoire de travail a sa base
   arrêtée, le run mourra en trois secondes sur un ECONNREFUSED — la fenêtre le dit AVANT.

   La route ne renvoie que ce qu'un `docker ps` et le scan des racines déclarées savent : un
   répertoire hors racine, ou sans compose, n'est pas « trouvé », et ce n'est pas une erreur.
   Docker est simulé (helpers/fake-docker.js) : l'état de chaque service vient de lui. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('./helpers/app');
const { installerFauxDocker, scenarioDocker, ecrireProjetsCompose } = require('./helpers/fake-docker');

describe('Couverture — état docker d’un répertoire', () => {
  let app; let faux; let racine; let dirs;

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());   // AVANT startApp : le binaire est mémorisé au premier appel
    app = await startApp();
    await app.configure();
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'racine-compose-'));
    dirs = ecrireProjetsCompose(racine, { makefile: false });
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);
  });

  after(async () => {
    if (app) await app.stop();
    if (faux) faux.nettoyer();
    try { fs.rmSync(racine, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const etat = (dir) => app.api('GET', `/api/docker/dir-state?dir=${encodeURIComponent(dir)}`);

  test('un répertoire compose sous une racine rend ses services avec l’état de chaque conteneur', async () => {
    const r = await etat(dirs.boutique);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.found, true);
    assert.equal(r.body.dir, dirs.boutique);
    assert.equal(r.body.project, 'boutique');
    const parNom = Object.fromEntries(r.body.services.map((s) => [s.name, s.state]));
    assert.equal(parNom.web, 'running');
    assert.equal(parNom.api, 'running');
    assert.equal(parNom.db, 'exited', 'la base arrêtée : c’est ce que la fenêtre doit signaler');
    assert.equal(parNom.cache, 'none', 'déclaré dans le compose mais jamais démarré : aucun conteneur');
  });

  test('l’état suit le démon : un service arrêté entre deux appels change d’état', async () => {
    faux.modifier((e) => { e.containers.find((c) => c.name === 'boutique-web-1').state = 'exited'; });
    const r = await etat(dirs.boutique);
    assert.equal(r.body.services.find((s) => s.name === 'web').state, 'exited');
    faux.modifier((e) => { e.containers.find((c) => c.name === 'boutique-web-1').state = 'running'; });
  });

  test('un répertoire inconnu, hors racine ou sans compose n’est pas trouvé — sans erreur', async () => {
    const horsRacine = fs.mkdtempSync(path.join(os.tmpdir(), 'hors-racine-'));
    fs.writeFileSync(path.join(horsRacine, 'compose.yaml'), 'name: ailleurs\nservices: {}\n');
    for (const dir of [path.join(racine, 'nexiste-pas'), horsRacine, racine]) {
      const r = await etat(dir);
      assert.equal(r.status, 200, `${dir} : ${r.text}`);
      assert.deepEqual(r.body, { found: false, services: [] }, dir);
    }
    const vide = await app.api('GET', '/api/docker/dir-state');
    assert.equal(vide.status, 200);
    assert.deepEqual(vide.body, { found: false, services: [] }, 'sans répertoire : rien à dire, pas un 400');
    fs.rmSync(horsRacine, { recursive: true, force: true });
  });
});
