'use strict';
/* Le client Jenkins, contre un FAUX SERVEUR Jenkins.
 *
 * Trois choses de Jenkins ne se devinent pas, et sont ici la matière du test :
 *   — l'arbre des jobs (dossiers imbriqués, jobs à plat) ;
 *   — la couleur, qui porte à la fois le verdict et le fait de tourner (`_anime`) ;
 *   — le crumb anti-CSRF, sans lequel tout lancement échoue en 403 sur un Jenkins normal.
 *
 * On teste contre un serveur et non un module bouchonné : c'est l'encodage réel des chemins,
 * le vrai corps de formulaire et les vrais en-têtes qui doivent être justes.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./helpers/mock-jenkins');
const jenkins = require('../src/jenkins');

describe('Client Jenkins', () => {
  let srv;
  let cfg;

  before(async () => {
    srv = await mock.start();
    cfg = { jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token };
  });
  after(async () => { if (srv) await srv.close(); });

  const poser = () => {
    mock.reset();
    mock.state.jobs = [
      {
        name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', color: null,
        jobs: [
          { name: 'api-build', color: 'blue', buildable: true, url: 'http://j/job/boutique/job/api-build/' },
          { name: 'front build', color: 'red_anime', buildable: true, url: 'http://j/job/boutique/job/front%20build/' },
        ],
      },
      { name: 'vide', _class: 'com.cloudbees.hudson.plugins.folder.Folder', color: null, jobs: [] },
      { name: 'release', color: 'yellow', buildable: true, url: 'http://j/job/release/' },
      { name: 'archive', color: 'disabled', buildable: false, url: 'http://j/job/archive/' },
    ];
    mock.state.details['/job/boutique/job/api-build'] = {
      name: 'api-build', color: 'blue', buildable: true, description: 'Construit l’API',
      property: [{ parameterDefinitions: [
        { name: 'VERSION', type: 'StringParameterDefinition', description: 'tag', defaultParameterValue: { value: '1.0' } },
        { name: 'ENV', _class: 'hudson.model.ChoiceParameterDefinition', choices: ['recette', 'prod'], defaultParameterValue: { value: 'recette' } },
      ] }],
      builds: [
        { number: 12, result: null, building: true, timestamp: 1, duration: 0, url: 'http://j/12/' },
        { number: 11, result: 'FAILURE', building: false, timestamp: 2, duration: 9000, url: 'http://j/11/' },
      ],
    };
    mock.state.details['/job/release'] = { name: 'release', color: 'yellow', buildable: true, property: [], builds: [] };
    mock.state.console['/job/boutique/job/api-build/11'] = 'ligne 1\nERREUR\nFinished: FAILURE';
  };

  test('l’arbre des jobs est aplati en chemins, dossiers exclus', async () => {
    poser();
    const jobs = await jenkins.lister(cfg);
    assert.deepEqual(jobs.map((j) => j.path),
      ['archive', 'boutique/api-build', 'boutique/front build', 'release'],
      'un dossier n’est pas un job : on descend dedans, on ne le liste pas — et un dossier VIDE ne laisse rien');
  });

  test('la couleur dit le verdict ET le fait de tourner', async () => {
    poser();
    const jobs = await jenkins.lister(cfg);
    const par = Object.fromEntries(jobs.map((j) => [j.path, j]));
    assert.deepEqual({ s: par['boutique/api-build'].statut, e: par['boutique/api-build'].enCours }, { s: 'succes', e: false },
      'bleu = succès chez Jenkins : la convention se traduit ici, pas dans une feuille de style');
    assert.deepEqual({ s: par['boutique/front build'].statut, e: par['boutique/front build'].enCours }, { s: 'echec', e: true },
      '`_anime` signifie « en cours », et le verdict affiché reste celui de la fois d’avant');
    assert.equal(par.release.statut, 'instable');
    assert.equal(par.archive.statut, 'desactive');
    assert.equal(par.archive.buildable, false, 'un job désactivé ne se lance pas : le bouton doit disparaître');
  });

  test('un nom avec espace est encodé dans l’URL, pas dans le chemin affiché', async () => {
    poser();
    mock.state.details['/job/boutique/job/front%20build'] = { name: 'front build', color: 'red', buildable: true, property: [], builds: [] };
    const d = await jenkins.detail(cfg, 'boutique/front build');
    assert.equal(d.name, 'front build');
    assert.ok(mock.state.calls.some((c) => c.path.startsWith('/job/boutique/job/front%20build/api/json')),
      'le chemin part encodé segment par segment — sinon Jenkins répond 404 sur la moitié des jobs');
  });

  test('les paramètres sont rendus avec leur type et leur défaut', async () => {
    poser();
    const d = await jenkins.detail(cfg, 'boutique/api-build');
    assert.deepEqual(d.parameters.map((p) => [p.name, p.type, p.value]),
      [['VERSION', 'StringParameterDefinition', '1.0'], ['ENV', 'ChoiceParameterDefinition', 'recette']],
      'le type vient de `type` ou, à défaut, de `_class` — Jenkins renseigne l’un ou l’autre selon les versions');
    assert.deepEqual(d.parameters[1].choices, ['recette', 'prod'],
      'sans les choix, une liste déroulante deviendrait un champ libre où l’on tape « prod » à la main');
    assert.equal(d.builds[0].result, null, 'un build en cours n’a pas de verdict : Jenkins ne tranche qu’à la fin');
    assert.equal(d.builds[0].building, true);
  });

  /* LE PIÈGE. Sans crumb, un Jenkins protégé (le défaut) répond 403 avec une page HTML que
     personne ne relie au CSRF. Et le crumb SEUL ne suffit pas : il est lié à la session qui
     l'a demandé, donc le cookie doit repartir avec lui. */
  test('lancer envoie le crumb ET son cookie', async () => {
    poser();
    const r = await jenkins.lancer(cfg, 'boutique/api-build', { VERSION: '2.0', ENV: 'prod' });
    assert.equal(r.queued, true);
    assert.equal(r.location, 'http://jenkins.test/queue/item/77/', 'l’URL de file est rendue : le build n’a pas encore de numéro');

    const post = mock.state.calls.find((c) => c.method === 'POST');
    assert.ok(post.path.endsWith('/buildWithParameters'),
      '`build` ignorerait les paramètres en silence et le job repartirait sur ses défauts');
    assert.equal(post.crumb, 'abc123');
    assert.match(post.cookie || '', /JSESSIONID=zz1/, 'le crumb sans son cookie vaut pas de crumb du tout');
    assert.equal(post.body, 'VERSION=2.0&ENV=prod');
  });

  test('un job sans paramètre part sur /build', async () => {
    poser();
    await jenkins.lancer(cfg, 'release', {});
    const post = mock.state.calls.find((c) => c.method === 'POST');
    assert.ok(post.path.endsWith('/build') && !post.path.includes('WithParameters'));
    assert.equal(post.body, '');
  });

  // Une installation sans protection CSRF n'a pas d'émetteur de crumb : on lance quand même.
  test('sans émetteur de crumb, le lancement passe tout de même', async () => {
    poser();
    mock.state.crumbActif = false;
    const r = await jenkins.lancer(cfg, 'release', {});
    assert.equal(r.queued, true);
    assert.equal(mock.state.calls.find((c) => c.method === 'POST').crumb, null);
  });

  test('la console est rendue telle quelle, la fin d’abord', async () => {
    poser();
    const d = await jenkins.console(cfg, 'boutique/api-build', 11);
    assert.match(d.text, /Finished: FAILURE/);
    assert.equal(d.truncated, false);
  });

  /* Les erreurs de Jenkins sont des PAGES HTML entières. Les recopier dans un message noierait
     la seule information utile ; on nomme le cas et on cite le code. */
  test('un refus d’authentification devient une phrase, pas une page HTML', async () => {
    poser();
    const mauvais = { ...cfg, jenkins_token: 'faux' };
    await assert.rejects(() => jenkins.lister(mauvais), (e) => {
      assert.match(e.message, /refusé l'accès \(401\)/);
      assert.ok(!/html/i.test(e.message), 'la page d’erreur de Jenkins n’a rien à faire dans un toast');
      return true;
    });
  });

  test('un job inconnu se dit introuvable', async () => {
    poser();
    await assert.rejects(() => jenkins.detail(cfg, 'nexistepas'), /introuvable \(404\)/);
  });

  test('non configuré, rien n’est tenté', async () => {
    assert.equal(jenkins.isConfigured({ jenkins_url: 'http://x', jenkins_user: 'a' }), false,
      'le jeton seul ou l’utilisateur seul ne suffit pas : Jenkins authentifie le COUPLE');
    await assert.rejects(() => jenkins.lister({ jenkins_url: 'http://x' }), /non configuré/);
  });
});
