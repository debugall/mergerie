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
          { name: 'api-build', color: 'blue', buildable: true, url: 'http://j/job/boutique/job/api-build/', lastBuild: { timestamp: 1000, number: 3 } },
          { name: 'front build', color: 'red_anime', buildable: true, url: 'http://j/job/boutique/job/front%20build/', lastBuild: { timestamp: 5000, number: 9 } },
        ],
      },
      { name: 'vide', _class: 'com.cloudbees.hudson.plugins.folder.Folder', color: null, jobs: [] },
      { name: 'release', color: 'yellow', buildable: true, url: 'http://j/job/release/', lastBuild: { timestamp: 3000, number: 1 } },
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
    assert.deepEqual([...jobs.map((j) => j.path)].sort(),
      ['archive', 'boutique/api-build', 'boutique/front build', 'release'],
      'un dossier n’est pas un job : on descend dedans, on ne le liste pas — et un dossier VIDE ne laisse rien');
    assert.equal(jobs.find((j) => j.path === 'boutique/api-build').folder, 'boutique',
      'le dossier est calculé côté serveur : l’écran ne redécoupe pas les chemins de son côté');
    assert.equal(jobs.find((j) => j.path === 'archive').folder, '', 'un job à la racine n’a pas de dossier');
  });

  /* L'ORDRE DE LECTURE. Dans une liste de trois cents jobs, ce qui vient de tourner est ce
     qu'on vient chercher — pas ce qui commence par « a ». */
  test('la liste arrive triée par date de dernier lancement', async () => {
    poser();
    const jobs = await jenkins.lister(cfg);
    assert.deepEqual(jobs.map((j) => j.path),
      ['boutique/front build', 'release', 'boutique/api-build', 'archive'],
      'du plus récent au plus ancien, et les jamais lancés à la fin');
    assert.equal(jobs[0].last, 5000);
    assert.equal(jobs[3].last, null, 'jamais lancé = null, pas 0 : 0 trierait comme une date de 1970');
  });

  /* LES PARAMÈTRES DU DERNIER LANCEMENT arrivent avec la liste — même requête, aucun appel de
     plus. Deux choses n'ont pourtant rien à y faire : un mot de passe (Jenkins en rend une
     forme chiffrée) et une valeur vide. */
  test('les paramètres du dernier build sont rendus, sans les secrets', async () => {
    poser();
    mock.state.jobs[2].lastBuild.actions = [{ parameters: [
      { name: 'VERSION', value: '2.1', _class: 'hudson.model.StringParameterValue' },
      { name: 'MDP', value: '{AQAAABAAAAAQabc}', _class: 'hudson.model.PasswordParameterValue' },
      { name: 'API_TOKEN', value: 'zzz', _class: 'hudson.model.StringParameterValue' },
      { name: 'VIDE', value: '', _class: 'hudson.model.StringParameterValue' },
      { name: 'MIGRE', value: true, _class: 'hudson.model.BooleanParameterValue' },
    ] }];
    const job = (await jenkins.lister(cfg)).find((j) => j.path === 'release');
    assert.deepEqual(job.lastParams, [{ name: 'VERSION', value: '2.1' }, { name: 'MIGRE', value: 'true' }],
      'un secret n’a rien à faire dans une liste, et une valeur vide n’apprend rien');
  });

  /* AUCUN PLAFOND sur le NOMBRE : une liste qui prétend montrer avec quoi le job est parti en
     cachant la moitié ment. Seule chaque VALEUR est bornée — trois mille caractères dans une
     ligne de liste ne sont pas une information, c'est un mur. */
  test('tous les paramètres sont rendus, chaque valeur étant bornée', async () => {
    poser();
    mock.state.jobs[2].lastBuild.actions = [{ parameters: [
      ...Array.from({ length: 14 }, (_, i) => ({ name: `P${i}`, value: `v${i}`, _class: 'hudson.model.StringParameterValue' })),
      { name: 'LONG', value: 'x'.repeat(200), _class: 'hudson.model.StringParameterValue' },
    ] }];
    const job = (await jenkins.lister(cfg)).find((j) => j.path === 'release');
    assert.equal(job.lastParams.length, 15, 'quatorze paramètres et un long : aucun n’est écarté');
    assert.equal(job.lastParams[14].value.length, 60);
  });

  /* LES VALEURS QUI N'EXISTENT QUE DANS LA PAGE. Git Parameter et les listes dynamiques ne
     déclarent pas leurs options : Jenkins les calcule en rendant sa page « Build with
     Parameters ». On va donc les y lire — et seulement pour les paramètres dont l'API n'a
     rien dit. */
  test('les listes calculées sont reprises du formulaire de lancement', async () => {
    poser();
    mock.state.details['/job/release'].property = [{ parameterDefinitions: [
      { name: 'Branche', _class: 'net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition', type: 'PT_BRANCH' },
      { name: 'ENV', _class: 'com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition',
        value: 'Could not get Environment from ENV Param' },
      { name: 'LIBRE', type: 'StringParameterDefinition', defaultParameterValue: { value: 'x' } },
      { name: 'DEJA', type: 'ChoiceParameterDefinition', choices: ['a', 'b'], defaultParameterValue: { value: 'b' } },
    ] }];
    mock.state.forms['/job/release'] = `
      <div name="parameter"><input type="hidden" name="name" value="Branche">
        <select name="value" size="10" multiple>
          <option value="refs/heads/develop">refs/heads/develop</option>
          <option value="refs/heads/master" selected>refs/heads/master</option>
        </select></div>
      <div name="parameter"><input type="hidden" name="name" value="ENV">
        <select name="value"><option>dev</option><option selected>prod</option></select></div>
      <div name="parameter"><input type="hidden" name="name" value="LIBRE">
        <input name="value" value="x"></div>
      <div name="parameter"><input type="hidden" name="name" value="DEJA">
        <select name="value"><option>z</option></select></div>`;

    const par = Object.fromEntries((await jenkins.detail(cfg, 'release')).parameters.map((p) => [p.name, p]));
    assert.deepEqual(par.Branche.choices, ['refs/heads/develop', 'refs/heads/master'],
      'les branches ne sont NULLE PART dans l’API : elles ne peuvent venir que de la page');
    assert.equal(par.Branche.multiple, true, 'le job en accepte plusieurs : la liste aussi');
    assert.equal(par.Branche.value, 'refs/heads/master', 'la sélection de la page est reprise');
    assert.deepEqual(par.ENV.choices, ['dev', 'prod']);
    assert.equal(par.ENV.value, 'prod');
    assert.equal(par.ENV.unresolved, undefined, 'la page a répondu : plus rien à signaler');
    assert.equal(par.LIBRE.choices, null, 'un champ libre reste libre');
    assert.deepEqual(par.DEJA.choices, ['a', 'b'],
      'l’API est la source la plus sûre : ce qu’elle a déjà dit n’est pas écrasé par le HTML');
  });

  // La page ne répond pas / est illisible : on retombe exactement sur le comportement d'avant.
  test('sans page de lancement, rien n’est perdu', async () => {
    poser();
    mock.state.details['/job/release'].property = [{ parameterDefinitions: [
      { name: 'ENV', _class: 'ExtendedChoiceParameterDefinition', value: 'Could not get Environment from ENV Param' },
    ] }];
    const par = (await jenkins.detail(cfg, 'release')).parameters[0];
    assert.equal(par.choices, null);
    assert.equal(par.value, '', 'la phrase d’erreur n’est toujours pas une valeur');
    assert.equal(par.unresolved, true, 'et on le dit encore : jamais pire qu’avant');
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

  /* LA PROFONDEUR DE L'HISTORIQUE. Dix builds répondent à « qu'est-ce qui vient de se passer »
     et rien ne sert d'en demander plus à chaque ouverture. Mais « quand est-ce parti en prod la
     dernière fois » peut remonter à cinquante lancements : la fiche doit pouvoir redemander
     plus loin, une fois, sans que ce chiffre soit à la main de qui appelle sans limite. */
  test('l’historique se demande à la profondeur voulue, bornée des deux côtés', async () => {
    poser();
    const demande = () => mock.state.calls.map((c) => /\{0,(\d+)\}/.exec(decodeURIComponent(c.path)))
      .filter(Boolean).map((m) => Number(m[1]));

    const d = await jenkins.detail(cfg, 'boutique/api-build');
    assert.deepEqual(demande(), [10], 'par défaut, dix — l’ouverture doit être rapide');
    assert.equal(d.depth, 10, 'la fiche dit sur combien de lancements elle a cherché, sinon « aucun résultat » ment');

    mock.state.calls.length = 0;
    assert.equal((await jenkins.detail(cfg, 'boutique/api-build', 200)).depth, 200);
    assert.deepEqual(demande(), [200]);

    /* Ni un chiffre absurde, ni un texte, ni zéro : le nombre vient d'une URL, donc de
       l'extérieur, et un `{0,0}` rendrait un historique vide sans rien signaler. */
    mock.state.calls.length = 0;
    for (const entree of [5000, 0, -3, 'beaucoup', null]) await jenkins.detail(cfg, 'boutique/api-build', entree);
    assert.deepEqual(demande(), [200, 10, 10, 10, 10],
      'trop grand est ramené au plafond, tout le reste au défaut');
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
