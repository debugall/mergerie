'use strict';
/* Les routes Jenkins, par de vraies requêtes HTTP, contre un faux serveur Jenkins.
 *
 * Ce que l'unitaire ne prouve pas : que les routes existent, qu'elles refusent proprement, et
 * surtout que le jeton VIT et se protège comme les autres secrets — masqué en lecture,
 * conservé quand l'écran renvoie le masque. Un jeton effacé par un enregistrement de réglages
 * ne se voit qu'au prochain besoin, c'est-à-dire trop tard.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

describe('Jenkins — routes', () => {
  let app;
  let srv;

  before(async () => {
    app = await startApp();
    await app.configure();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = [
      { name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'api-build', color: 'blue', buildable: true },
        { name: 'front-build', color: 'red', buildable: true },
      ] },
      { name: 'release', color: 'notbuilt', buildable: true },
    ];
    mock.state.details['/job/boutique/job/api-build'] = {
      name: 'api-build', color: 'blue', buildable: true, property: [], builds: [
        { number: 3, result: 'SUCCESS', building: false, timestamp: 1, duration: 1000, url: '' },
      ],
    };
    mock.state.console['/job/boutique/job/api-build/3'] = 'tout va bien\nFinished: SUCCESS';
    await app.api('PUT', '/api/config', {
      jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token,
    });
  });
  after(async () => {
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  test('la liste des jobs arrive aplatie et traduite', async () => {
    const r = await app.api('GET', '/api/jenkins/jobs');
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, true);
    assert.deepEqual(r.body.jobs.map((j) => [j.path, j.statut]),
      [['boutique/api-build', 'succes'], ['boutique/front-build', 'echec'], ['release', 'jamais']]);
  });

  test('le détail et la console d’un build', async () => {
    const d = await app.api('GET', '/api/jenkins/job?path=boutique%2Fapi-build');
    assert.equal(d.status, 200);
    assert.equal(d.body.builds[0].number, 3);
    const c = await app.api('GET', '/api/jenkins/console?path=boutique%2Fapi-build&build=3');
    assert.match(c.body.text, /Finished: SUCCESS/);
  });

  test('lancer est un POST, et il arrive vraiment chez Jenkins', async () => {
    const avant = mock.state.calls.length;
    const r = await app.api('POST', '/api/jenkins/build', { path: 'boutique/api-build', parameters: { A: '1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.queued, true);
    const post = mock.state.calls.slice(avant).find((c) => c.method === 'POST' && /build/.test(c.path));
    assert.ok(post, 'sans requête sortante, on aurait juste un message de succès menteur');
    assert.equal(post.body, 'A=1');
  });

  test('un chemin vide est refusé plutôt qu’interprété', async () => {
    assert.equal((await app.api('GET', '/api/jenkins/job?path=')).status, 400);
    assert.equal((await app.api('POST', '/api/jenkins/build', {})).status, 400);
  });

  /* LE JETON. Trois règles, chacune apprise à ses dépens ailleurs dans l'application :
     il ne ressort jamais en clair, le masque signifie « garde-le », et une chaîne vide
     signifie « efface-le » — sinon on ne pourrait jamais retirer un accès. */
  test('le jeton se masque en lecture et survit à un enregistrement', async () => {
    const lu = await app.api('GET', '/api/config');
    assert.equal(lu.body.jenkins_token, '***', 'un secret ne repart pas en clair vers l’écran');
    assert.equal(lu.body.jenkins_user, mock.state.user, 'l’utilisateur, lui, n’est pas un secret');

    // L'écran renvoie le masque quand on n'a pas touché au champ : le jeton doit rester.
    await app.api('PUT', '/api/config', { jenkins_token: '***', jenkins_url: srv.url });
    assert.equal((await app.api('GET', '/api/jenkins/jobs')).body.configured, true,
      'enregistrer les réglages sans retoucher le jeton ne doit pas déconnecter Jenkins');

    const t = await app.api('POST', '/api/jenkins/test', { jenkins_token: '***' });
    assert.equal(t.body.ok, true);
    assert.equal(t.body.user, 'Moi Même', 'le test nomme le compte : l’URL qui répond ne prouve pas le jeton');
  });

  test('sans configuration, l’onglet dit qu’il n’est pas connecté au lieu d’échouer', async () => {
    await app.api('PUT', '/api/config', { jenkins_url: '', jenkins_user: '', jenkins_token: '' });
    const r = await app.api('GET', '/api/jenkins/jobs');
    assert.equal(r.status, 200, 'un onglet non configuré doit expliquer, pas afficher une erreur rouge');
    assert.deepEqual({ c: r.body.configured, n: r.body.jobs.length }, { c: false, n: 0 });
    assert.equal((await app.api('POST', '/api/jenkins/test', {})).status, 400, 'tester sans rien, en revanche, est une erreur');
  });

  /* LA CADENCE EST UN RÉGLAGE DE L'OUTIL, comme celle des MR et celle de Jira : en base, pas
     dans le navigateur, et bornée — une liste de trois cents jobs redemandée toutes les dix
     secondes pèse sur une installation partagée, pas seulement sur celui qui l'a réglée. */
  test('la cadence de rafraîchissement se règle, et reste bornée', async () => {
    const lire = () => app.api('GET', '/api/status').then((r) => r.body.jenkinsRefreshMinutes);
    assert.equal(await lire(), 1, 'une minute par défaut');

    await app.api('PUT', '/api/config', { jenkins_refresh_minutes: '5' });
    assert.equal(await lire(), 5, 'l’écran la lit dans /status : changer le réglage s’applique sans recharger');

    await app.api('PUT', '/api/config', { jenkins_refresh_minutes: '0' });
    assert.equal(await lire(), 0, '0 = jamais : seul le bouton Rafraîchir demande alors l’état');

    await app.api('PUT', '/api/config', { jenkins_refresh_minutes: '999' });
    assert.equal(await lire(), 60, 'plafonnée à l’heure');
    await app.api('PUT', '/api/config', { jenkins_refresh_minutes: 'x' });
    assert.equal(await lire(), 0, 'une saisie illisible coupe le sondage plutôt que d’inventer une cadence');
    await app.api('PUT', '/api/config', { jenkins_refresh_minutes: '1' });
  });
});
