'use strict';
/* LA VEILLE DE FOND (B14/B15) — ce que le serveur remarque pendant qu'on regarde ailleurs.
 *
 * La fin d'un build Jenkins lancé d'ici n'était guettée que par le NAVIGATEUR, donc seulement l'onglet Jenkins
 * ouvert. (La chute d'un conteneur a sa veille dans le plugin Docker, testée chez lui.) Ce fichier tient les règles
 * qui rendent cette veille supportable, parce que ce sont elles qu'on casse sans s'en apercevoir :
 *
 *   1. une TRANSITION, jamais un état — sinon le même build redonne l'alerte à chaque tour, et on coupe tout au bout de deux jours ;
 *   2. on ne sonde QUE ce qu'on attend — sans lancement en cours, Jenkins n'est pas appelé ;
 *   3. ce qui n'aboutit pas s'oublie — un build qui ne revient jamais ne se sonde pas sans fin.
 *
 * Jenkins est remplacé par une doublure : ces tests doivent tourner sur une machine sans CI, ce qui est le cas du runner.
 *
 * Un seul `startApp()` pour tout le fichier — il sert la partie brief.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

/* LES MODULES DE `src/` SE CHARGENT APRÈS `startApp()`, JAMAIS EN TÊTE DE FICHIER.
 *
 * `paths.js` lit `MERGERIE_DATA_DIR` AU CHARGEMENT, et c'est `startApp()` qui le pose. Un
 * `require('../src/…')` en tête de fichier charge donc toute la chaîne — jusqu'à `db.js` —
 * sur le dossier `data/` du projet, c'est-à-dire sur la base de PRODUCTION : le serveur de test
 * s'y connecte ensuite, la configuration du faux GitLab y est écrite, et les lignes fabriquées
 * par les tests s'y accumulent. Ce fichier l'a fait, et il a fallu réparer la base à la main.
 *
 * D'où ces trois variables remplies dans le `before`, après le démarrage. */
let jenkins; let notify; let jkVeille;

// Les événements poussés depuis le dernier appel — `notify` est un buffer global.
let curseur = 0;
function nouveaux(type) {
  const evts = notify.since(curseur).filter((e) => !type || e.type === type);
  curseur = notify.latestId();
  return evts;
}

describe('Veille de fond', () => {
  let app;
  // Les vraies implémentations, remises en place à la fin (les doublures sont posées par test).
  let vraiDetail; let vraiConfigure;

  before(async () => {
    app = await startApp();
    await app.configure();
    /* eslint-disable global-require */
    /* La veille des builds vit dans le plugin Jenkins (embarqué, en processus) : même instance que celle
       qu'il a configurée à l'activation, et son client se remplace comme avant. */
    jkVeille = require('../plugins/jenkins/src/veille');
    jenkins = jkVeille.client;
    notify = require('../src/core/notify');
    /* eslint-enable global-require */
    vraiDetail = jenkins.detail; vraiConfigure = jenkins.isConfigured;
  });
  after(async () => {
    jenkins.detail = vraiDetail; jenkins.isConfigured = vraiConfigure;
    if (app) await app.stop();
  });

  describe('Jenkins', () => {
    before(() => { jenkins.isConfigured = () => true; });

    test('rien n’est demandé à Jenkins tant qu’aucun build n’est attendu', async () => {
      jkVeille.oublierTout();
      let appels = 0;
      jenkins.detail = async () => { appels += 1; return { builds: [] }; };
      await jkVeille.tourJenkins({});
      assert.equal(appels, 0, 'un outil local ne martèle pas le CI de l’équipe');
    });

    test('le build ATTENDU, terminé, fait l’événement — et l’attente s’efface', async () => {
      jkVeille.oublierTout();
      nouveaux();
      jkVeille.attendreJenkins('dossier/deploy', 41);
      // Encore en cours, et le numéro d'avant : deux raisons de se taire.
      jenkins.detail = async () => ({ builds: [{ number: 41, result: 'SUCCESS', building: false }] });
      assert.equal(await jkVeille.tourJenkins({}), 0);
      jenkins.detail = async () => ({ builds: [{ number: 42, result: null, building: true }] });
      assert.equal(await jkVeille.tourJenkins({}), 0);
      assert.deepEqual(nouveaux('jenkins_done'), []);

      jenkins.detail = async () => ({ builds: [{ number: 42, result: 'FAILURE', building: false }] });
      assert.equal(await jkVeille.tourJenkins({}), 1);
      const [e] = nouveaux('jenkins_done');
      assert.equal(e.path, 'dossier/deploy');
      assert.equal(e.number, 42);
      assert.equal(e.ok, false, 'un rouge est justement ce qu’on veut apprendre sans regarder');
      assert.deepEqual(jkVeille.attendus(), [], 'l’attente est close');
    });

    test('un Jenkins injoignable ne perd pas l’attente', async () => {
      jkVeille.oublierTout();
      jkVeille.attendreJenkins('dossier/deploy', 1);
      jenkins.detail = async () => { throw new Error('ECONNREFUSED'); };
      await jkVeille.tourJenkins({});
      assert.deepEqual(jkVeille.attendus(), ['dossier/deploy'], 'on retentera au tour suivant');
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
  });
});
