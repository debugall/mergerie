'use strict';
/* LA VEILLE DE FOND (B14/B15) — ce que le serveur remarque pendant qu'on regarde ailleurs.
 *
 * Deux événements ne se produisaient pour personne : la fin d'un build Jenkins lancé d'ici
 * (guettée par le NAVIGATEUR, donc seulement l'onglet Jenkins ouvert) et la chute d'un
 * conteneur (rien du tout). Ce fichier tient les trois règles qui rendent cette veille
 * supportable, parce que ce sont elles qu'on casse sans s'en apercevoir :
 *
 *   1. une TRANSITION, jamais un état — sinon le conteneur arrêté la semaine dernière
 *      redonne l'alerte à chaque tour, et on coupe tout au bout de deux jours ;
 *   2. on ne sonde QUE ce qu'on attend — sans lancement en cours, Jenkins n'est pas appelé ;
 *   3. ce qui n'aboutit pas s'oublie — un build qui ne revient jamais ne se sonde pas sans fin.
 *
 * Docker et Jenkins sont remplacés par des doublures : ces tests doivent tourner sur une
 * machine sans démon et sans CI, ce qui est le cas du runner.
 *
 * Un seul `startApp()` pour tout le fichier — il sert la partie brief.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

/* LES MODULES DE `src/` SE CHARGENT APRÈS `startApp()`, JAMAIS EN TÊTE DE FICHIER.
 *
 * `paths.js` lit `MERGERIE_DATA_DIR` AU CHARGEMENT, et c'est `startApp()` qui le pose. Un
 * `require('../src/veille')` en tête de fichier charge donc toute la chaîne — jusqu'à `db.js` —
 * sur le dossier `data/` du projet, c'est-à-dire sur la base de PRODUCTION : le serveur de test
 * s'y connecte ensuite, la configuration du faux GitLab y est écrite, et les lignes fabriquées
 * par les tests s'y accumulent. Ce fichier l'a fait, et il a fallu réparer la base à la main.
 *
 * D'où ces trois variables remplies dans le `before`, après le démarrage. */
let veille; let docker; let jenkins; let notify;

// Les événements poussés depuis le dernier appel — `notify` est un buffer global.
let curseur = 0;
function nouveaux(type) {
  const evts = notify.since(curseur).filter((e) => !type || e.type === type);
  curseur = notify.latestId();
  return evts;
}

const conteneur = (name, state, status) => ({
  id: name, name, state, status, image: 'x', project: null, service: null, running: state === 'running',
});

describe('Veille de fond', () => {
  let app;
  // Les vraies implémentations, remises en place à la fin (les doublures sont posées par test).
  let vraiStatus; let vraiListe; let vraiDetail; let vraiConfigure;

  before(async () => {
    app = await startApp();
    await app.configure();
    /* eslint-disable global-require */
    veille = require('../src/veille');
    docker = require('../src/docker');
    jenkins = require('../src/jenkins');
    notify = require('../src/notify');
    /* eslint-enable global-require */
    vraiStatus = docker.status; vraiListe = docker.listContainers;
    vraiDetail = jenkins.detail; vraiConfigure = jenkins.isConfigured;
  });
  after(async () => {
    docker.status = vraiStatus; docker.listContainers = vraiListe;
    jenkins.detail = vraiDetail; jenkins.isConfigured = vraiConfigure;
    veille.arreter();
    if (app) await app.stop();
  });

  describe('Docker', () => {
    before(() => { docker.status = async () => ({ ok: true }); });

    test('le premier relevé cale l’état sans rien annoncer', async () => {
      veille.oublierTout();
      nouveaux();
      docker.listContainers = async () => [conteneur('api', 'exited', 'Exited (1) 2 minutes ago')];
      assert.equal(await veille.tourDocker(), 0);
      assert.deepEqual(nouveaux('docker_down'), [], 'un conteneur déjà tombé au démarrage n’est pas un événement');
    });

    test('un conteneur qui TOMBE entre deux tours annonce, une seule fois', async () => {
      veille.oublierTout();
      docker.listContainers = async () => [conteneur('api', 'running', 'Up 3 hours')];
      await veille.tourDocker();
      nouveaux();

      docker.listContainers = async () => [conteneur('api', 'exited', 'Exited (1) 3 seconds ago')];
      assert.equal(await veille.tourDocker(), 1);
      const [e] = nouveaux('docker_down');
      assert.ok(e && e.names.includes('api'), 'le nom est dans l’événement');

      // Toujours tombé au tour suivant : ce n'est plus une nouvelle.
      assert.equal(await veille.tourDocker(), 0);
      assert.deepEqual(nouveaux('docker_down'), []);
    });

    test('un arrêt DEMANDÉ ne réveille personne', async () => {
      veille.oublierTout();
      docker.listContainers = async () => [conteneur('api', 'running', 'Up 3 hours')];
      await veille.tourDocker();
      nouveaux();
      // 143 = SIGTERM non piégé, la signature d'un `docker stop` — pas une chute.
      docker.listContainers = async () => [conteneur('api', 'exited', 'Exited (143) 1 second ago')];
      assert.equal(await veille.tourDocker(), 0);
      assert.deepEqual(nouveaux('docker_down'), []);
    });

    test('sans démon, la veille ne dit rien et ne casse rien', async () => {
      veille.oublierTout();
      docker.status = async () => ({ ok: false, error: 'démon absent' });
      assert.equal(await veille.tourDocker(), 0);
      assert.deepEqual(nouveaux('docker_down'), []);
      docker.status = async () => ({ ok: true });
    });
  });

  describe('Jenkins', () => {
    before(() => { jenkins.isConfigured = () => true; });

    test('rien n’est demandé à Jenkins tant qu’aucun build n’est attendu', async () => {
      veille.oublierTout();
      let appels = 0;
      jenkins.detail = async () => { appels += 1; return { builds: [] }; };
      await veille.tourJenkins({});
      assert.equal(appels, 0, 'un outil local ne martèle pas le CI de l’équipe');
    });

    test('le build ATTENDU, terminé, fait l’événement — et l’attente s’efface', async () => {
      veille.oublierTout();
      nouveaux();
      veille.attendreJenkins('dossier/deploy', 41);
      // Encore en cours, et le numéro d'avant : deux raisons de se taire.
      jenkins.detail = async () => ({ builds: [{ number: 41, result: 'SUCCESS', building: false }] });
      assert.equal(await veille.tourJenkins({}), 0);
      jenkins.detail = async () => ({ builds: [{ number: 42, result: null, building: true }] });
      assert.equal(await veille.tourJenkins({}), 0);
      assert.deepEqual(nouveaux('jenkins_done'), []);

      jenkins.detail = async () => ({ builds: [{ number: 42, result: 'FAILURE', building: false }] });
      assert.equal(await veille.tourJenkins({}), 1);
      const [e] = nouveaux('jenkins_done');
      assert.equal(e.path, 'dossier/deploy');
      assert.equal(e.number, 42);
      assert.equal(e.ok, false, 'un rouge est justement ce qu’on veut apprendre sans regarder');
      assert.deepEqual(veille.attendus(), [], 'l’attente est close');
    });

    test('un Jenkins injoignable ne perd pas l’attente', async () => {
      veille.oublierTout();
      veille.attendreJenkins('dossier/deploy', 1);
      jenkins.detail = async () => { throw new Error('ECONNREFUSED'); };
      await veille.tourJenkins({});
      assert.deepEqual(veille.attendus(), ['dossier/deploy'], 'on retentera au tour suivant');
    });
  });

  describe('Le brief', () => {
    test('un merge laissé à moitié et une opération en échec entrent dans le brief', async () => {
      const d = app.db;
      const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/veille','http://v',datetime('now'))").run().lastInsertRowid;
      d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
        VALUES (?, 'main', 'feature/x', '/tmp/w', 'conflict', datetime('now'), datetime('now'))`).run(repoId);
      d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
        VALUES (?, 'main', 'feature/fini', '/tmp/w2', 'pushed', datetime('now'), datetime('now'))`).run(repoId);
      d.prepare(`INSERT INTO git_op (batch_id, created_at, action, repo_id, project, ref_name, status, error)
        VALUES ('lot-1', datetime('now'), 'delete_branch', ?, 'grp/veille', 'old/1', 'error', 'protected branch')`).run(repoId);

      const b = (await app.api('GET', '/api/brief')).body;
      const merges = (b.git || []).filter((g) => g.kind === 'merge');
      assert.equal(merges.length, 1, 'un merge poussé est fini : il n’attend plus rien');
      assert.equal(merges[0].status, 'conflict');
      const ops = (b.git || []).filter((g) => g.kind === 'op');
      assert.equal(ops.length, 1);
      assert.equal(ops[0].batch_id, 'lot-1', 'les échecs sont groupés par lot, comme dans l’historique');
    });

    /* B14 — et la dernière table de trace que Statistiques ignorait. Ce qui sert n'est pas le
       volume mais le RAPPORT : dix suppressions dont quatre refusées ne racontent pas la même
       chose que trente sans un échec. */
    test('les opérations git entrent dans les statistiques', async () => {
      const d = app.db;
      d.prepare(`INSERT INTO git_op (batch_id, created_at, action, project, ref_name, status)
        VALUES ('lot-2', datetime('now'), 'create_tag', 'grp/veille', 'v1.0', 'done')`).run();
      const g = (await app.api('GET', '/api/stats')).body.gitOps;
      assert.ok(g.total >= 2, `total : ${g.total}`);
      assert.ok(g.errors >= 1, 'l’échec du lot précédent est compté');
      const supp = g.byAction.find((a) => a.action === 'delete_branch');
      assert.ok(supp && supp.errors === supp.n, 'la suppression a échoué autant de fois qu’elle a été tentée');
    });

    test('sans relevé Docker, le brief n’affirme rien', async () => {
      const brief = require('../src/brief');
      assert.equal(brief.construire({}).docker, null, 'pas de section plutôt qu’un « 0 conteneur tombé » qui n’a rien regardé');
      const avec = brief.construire({ dockerDown: { at: '2026-09-12T08:00:00Z', containers: [{ name: 'api', state: 'exited' }] } });
      assert.equal(avec.docker.containers.length, 1);
      assert.equal(avec.docker.at, '2026-09-12T08:00:00Z', 'le relevé est DATÉ : ce n’est pas un direct');
    });
  });
});
