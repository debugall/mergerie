'use strict';
/* MENU « JENKINS » — LA LISTE DES JOBS, CE QUE `e2e-jenkins-ui` NE PILOTAIT PAS ENCORE.
 *
 * Le compteur « n jobs sur N », la recherche et « seulement ce qui ne va pas » qui SURVIVENT à
 * un rechargement (et se voient restaurés), « Aucun job ne correspond », l'épingle qui remonte
 * un job en tête et s'en souvient, « Mes lancements » (ce que J'AI lancé d'ici), « Rafraîchir »
 * qui redemande vraiment à Jenkins, un Jenkins en panne puis revenu, un Jenkins sans aucun job,
 * la recherche du filtre de dossiers qui ne trouve rien, et la modale des dossiers masqués qui
 * se ferme par son bouton, par Échap et par un clic au fond.
 *
 * Déjà prouvés dans un navigateur, et donc pas rejoués ici (`e2e-jenkins-ui`) : l'état non
 * configuré, les identifiants saisis dans les réglages, l'ordre et le contenu des lignes, la
 * recherche par paramètre/auteur/branche, les teintes, les filtres par paramètre, décocher /
 * masquer / remettre un dossier, « tout cocher / décocher », les boutons inertes, lancer avec
 * confirmation, relancer, la fiche, les badges du menu, le lien externe, la case « ne pas
 * rafraîchir tout seul », la console.
 *
 * L'effet de chaque geste est relu là où il atterrit : les requêtes reçues par le faux Jenkins
 * pour ce qui part chez lui, le stockage du navigateur pour ce qui est un arrangement d'écran.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

const DOSSIER = 'com.cloudbees.hudson.plugins.folder.Folder';
const build = (ts, numero, params = [], qui = 'Alice') => ({
  timestamp: ts, number: numero,
  actions: [
    { causes: [{ userName: qui }] },
    { parameters: params.map(([name, value]) => ({ name, value, _class: 'hudson.model.StringParameterValue' })) },
  ],
});

/* Cinq jobs, trois « dossiers » (dont la racine). Les dates sont fixes et anciennes : le badge
   du jour n'est pas le sujet ici, et la liste doit garder le même ordre d'un test à l'autre. */
function decor() {
  return [
    { name: 'equipe', _class: DOSSIER, jobs: [
      { name: 'api-build', color: 'blue', buildable: true, lastBuild: build(5000, 12, [['ENV', 'recette']]) },
      { name: 'deploy', color: 'red', buildable: true,
        property: [{ parameterDefinitions: [{ name: 'ENV' }] }],
        lastBuild: build(4000, 7, [['ENV', 'prod']], 'Bruno') },
    ] },
    { name: 'outils', _class: DOSSIER, jobs: [
      { name: 'lint', color: 'blue', buildable: true, lastBuild: build(3000, 3) },
      { name: 'vieux', color: 'blue', buildable: true, lastBuild: build(2000, 1) },
    ] },
    { name: 'solo', color: 'notbuilt', buildable: true },
  ];
}

describe('Menu Jenkins — la liste des jobs', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let srv; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    srv = await mock.start();
    mock.reset();
    mock.state.jobs = decor();
    /* La fiche de chaque job : « Lancer » la consulte d'abord pour savoir s'il y a des
       paramètres à lire — sans elle, le clic ouvrirait une erreur au lieu de la confirmation. */
    for (const [chemin, nom] of [['/job/outils/job/lint', 'lint'], ['/job/outils/job/vieux', 'vieux']]) {
      mock.state.details[chemin] = { name: nom, color: 'blue', buildable: true, property: [], builds: [] };
    }
    await app.configure({ jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
  const noms = () => page.evaluate(() => [...document.querySelectorAll('#jenkinsBox .jk-row [data-jkjob]')]
    .map((b) => b.dataset.jkjob));
  async function allerJenkins(n = 5) {
    await page.locator('nav button[data-tab="jenkins"]').click();
    await page.waitForSelector('#tab-jenkins.active');
    if (n != null) await lignes(n);
  }
  const memo = (cle) => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, cle);

  test('le compteur dit combien de jobs restent, et une recherche vaine le dit en clair', async () => {
    await allerJenkins();
    await page.waitForFunction(() => document.querySelector('#jenkinsCount').textContent === '5 jobs sur 5');

    await page.locator('#jenkinsSearch').fill('lint');
    await lignes(1);
    await page.waitForFunction(() => document.querySelector('#jenkinsCount').textContent === '1 job sur 5');

    await page.locator('#jenkinsSearch').fill('introuvable-xyz');
    await page.waitForFunction(() => /Aucun job ne correspond/.test(document.querySelector('#jenkinsBox').textContent));
    assert.equal(await page.locator('#jenkinsBox .jk-row').count(), 0);
    assert.equal(await page.locator('#jenkinsCount').textContent(), '0 jobs sur 5',
      'le total reste affiché : c’est lui qui dit que la liste n’est pas vide, seulement filtrée');

    await page.locator('#jenkinsSearch').fill('');
    await lignes(5);
  });

  /* LES FILTRES VOLATILS SONT MÉMORISÉS — ET SE VOIENT. Une liste réduite par une recherche
     qu'on ne lit nulle part passe pour une liste vide : le champ doit reparaître rempli. */
  test('la recherche et « ce qui ne va pas » survivent au rechargement, et se voient', async () => {
    await allerJenkins();
    await page.locator('#jenkinsSearch').fill('equipe');
    await lignes(2);
    await page.locator('#jenkinsFailOnly').click();
    await lignes(1);
    assert.deepEqual(await noms(), ['equipe/deploy'], 'seul le rouge du dossier « equipe » reste');
    const m = await memo('mergerie_jenkins_filtres');
    assert.equal(m.q, 'equipe');
    assert.equal(m.echecsSeuls, true);

    await page.reload();
    await allerJenkins(1);
    assert.equal(await page.locator('#jenkinsSearch').inputValue(), 'equipe', 'la recherche est restaurée DANS le champ');
    assert.equal(await page.locator('#jenkinsFailOnly').isChecked(), true, 'et la case est cochée à l’écran');
    assert.deepEqual(await noms(), ['equipe/deploy']);

    await page.locator('#jenkinsFailOnly').click();
    await lignes(2);
    await page.locator('#jenkinsSearch').fill('');
    await lignes(5);
    const apres = await memo('mergerie_jenkins_filtres');
    assert.equal(apres.q, '');
    assert.equal(apres.echecsSeuls, false);
  });

  /* L'ÉPINGLE : trois jobs du quotidien ne se cherchent plus dans deux cents. */
  test('épingler remonte un job en tête, s’en souvient, et se détache', async () => {
    await allerJenkins();
    assert.equal((await noms())[0], 'equipe/api-build', 'ordre du serveur : le plus récent d’abord');

    await page.locator('#jenkinsBox [data-jkpin="outils/vieux"]').click();
    await page.waitForFunction(() => {
      const r = document.querySelector('#jenkinsBox .jk-row');
      return r && r.classList.contains('jk-pinned') && r.querySelector('[data-jkjob="outils/vieux"]');
    });
    assert.deepEqual(await memo('mergerie_jenkins_epingles'), ['outils/vieux']);
    const pin = page.locator('#jenkinsBox [data-jkpin="outils/vieux"]');
    assert.equal(await pin.getAttribute('title'), 'Détacher ce job', 'l’infobulle dit le geste inverse');
    assert.match(await pin.getAttribute('class'), /\bactive\b/);
    assert.deepEqual((await noms()).slice(1), ['equipe/api-build', 'equipe/deploy', 'outils/lint', 'solo'],
      'le reste garde l’ordre du serveur');

    await page.reload();
    await allerJenkins();
    assert.equal((await noms())[0], 'outils/vieux', 'l’épingle survit au rechargement');

    await page.locator('#jenkinsBox [data-jkpin="outils/vieux"]').click();
    await page.waitForFunction(() => !document.querySelector('#jenkinsBox .jk-pinned'));
    assert.deepEqual(await noms(), ['equipe/api-build', 'equipe/deploy', 'outils/lint', 'outils/vieux', 'solo']);
    assert.deepEqual(await memo('mergerie_jenkins_epingles'), []);
    assert.equal(await page.locator('#jenkinsBox [data-jkpin="outils/vieux"]').getAttribute('title'), 'Épingler ce job');
  });

  /* « MES LANCEMENTS » : Jenkins connaît l'auteur d'un build, pas l'outil d'où le clic est
     parti. C'est donc ce que J'AI lancé d'ici, et rien d'autre. */
  test('« Mes lancements » ne retient que ce que j’ai lancé d’ici', async () => {
    await allerJenkins();
    await page.locator('#jenkinsMineOnly').click();
    await page.waitForFunction(() => /Aucun job ne correspond/.test(document.querySelector('#jenkinsBox').textContent));
    await page.locator('#jenkinsMineOnly').click();
    await lignes(5);

    const avant = mock.state.calls.length;
    await page.locator('#jenkinsBox [data-jkrun="outils/lint"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(() => mock.state.calls.slice(avant)
      .some((c) => c.method === 'POST' && c.path === '/job/outils/job/lint/build'), 'Jenkins a reçu le lancement de « lint »');
    await page.waitForFunction(() => /outils\/lint/.test(localStorage.getItem('mergerie_jenkins_lances') || ''));

    await page.locator('#jenkinsMineOnly').click();
    await lignes(1);
    assert.deepEqual(await noms(), ['outils/lint']);

    await page.reload();
    await allerJenkins(1);
    assert.equal(await page.locator('#jenkinsMineOnly').isChecked(), true, 'le filtre est restauré, et se voit');
    assert.deepEqual(await noms(), ['outils/lint']);

    await page.locator('#jenkinsMineOnly').click();
    await lignes(5);
  });

  /* RAFRAÎCHIR REDEMANDE À JENKINS — ce n'est pas un nouveau rendu de la liste en mémoire. */
  test('« Rafraîchir » redemande la liste à Jenkins', async () => {
    await allerJenkins();
    mock.state.jobs[1].jobs.push({ name: 'neuf', color: 'blue', buildable: true, lastBuild: build(9000, 1) });
    try {
      const avant = mock.state.calls.filter((c) => c.path.startsWith('/api/json')).length;
      await page.locator('#jenkinsReload').click();
      await lignes(6);
      assert.equal((await noms())[0], 'outils/neuf', 'le job apparu chez Jenkins arrive en tête (le plus récent)');
      assert.ok(mock.state.calls.filter((c) => c.path.startsWith('/api/json')).length > avant,
        'la liste a bien été redemandée à Jenkins');
      await page.waitForFunction(() => document.querySelector('#jenkinsCount').textContent === '6 jobs sur 6');
    } finally {
      mock.state.jobs = decor();
    }
    await page.locator('#jenkinsReload').click();
    await lignes(5);
  });

  /* UN JENKINS EN PANNE s'annonce dans la liste, et un rafraîchissement suffit quand il revient. */
  test('Jenkins en panne : l’erreur s’affiche, et « Rafraîchir » la dissipe au retour', async () => {
    await allerJenkins();
    mock.state.fail['/api/json'] = { status: 500, body: '<html>boom</html>' };
    try {
      await page.locator('#jenkinsReload').click();
      await page.waitForSelector('#jenkinsBox .errbox');
      assert.equal(await page.locator('#jenkinsBox .jk-row').count(), 0);
    } finally {
      delete mock.state.fail['/api/json'];
    }
    await page.locator('#jenkinsReload').click();
    await lignes(5);
    assert.equal(await page.locator('#jenkinsBox .errbox').count(), 0);
  });

  test('un Jenkins sans aucun job le dit, sans filtre ni compteur trompeur', async () => {
    await allerJenkins();
    mock.state.jobs = [];
    try {
      await page.locator('#jenkinsReload').click();
      await page.waitForFunction(() => /Aucun job/.test((document.querySelector('#jenkinsBox .empty-t') || {}).textContent || ''));
      assert.equal(await page.locator('#jenkinsFolders').isHidden(), true, 'aucun dossier à filtrer');
      assert.equal(await page.locator('#jenkinsCount').textContent(), '0 jobs sur 0');
    } finally {
      mock.state.jobs = decor();
    }
    await page.locator('#jenkinsReload').click();
    await lignes(5);
  });

  /* La recherche du filtre de dossiers MASQUE des cases, elle n'en décoche aucune — et quand
     elle ne trouve rien, elle le dit au lieu de laisser un cadre vide. */
  test('chercher un dossier inconnu le dit, et n’a rien décoché', async () => {
    await allerJenkins();
    await page.locator('#jenkinsFolderSearch').fill('zzz');
    await page.waitForFunction(() => /Aucun dossier ne correspond/.test(document.querySelector('#jenkinsFolderList').textContent));
    await lignes(5);
    await page.locator('#jenkinsFolderSearch').fill('out');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsFolderList [data-jkfolder]').length === 1);
    assert.equal(await page.locator('#jenkinsFolderList [data-jkfolder="outils"]').count(), 1);
    await page.locator('#jenkinsFolderSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsFolderList [data-jkfolder]').length === 3);
    assert.equal(await page.locator('#jenkinsFolderList [data-jkfolder]:checked').count(), 3,
      'filtrer la liste des dossiers ne change pas ce qu’on a choisi de voir');
    await lignes(5);
  });

  test('la modale des dossiers masqués se ferme par son bouton, par Échap et par un clic au fond', async () => {
    await allerJenkins();
    await page.locator('#jenkinsFolderList [data-jkhide="outils"]').click();
    await lignes(3);
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');

    const ouvrir = async () => {
      await page.locator('#jenkinsFolderHidden').click();
      await page.waitForSelector('#jenkinsHiddenModal:not([hidden])');
      assert.equal(await page.locator('#jenkinsHiddenList [data-jkshow="outils"]').count(), 1);
    };
    const fermee = () => page.waitForSelector('#jenkinsHiddenModal', { state: 'hidden' });

    await ouvrir();
    await page.locator('#jenkinsHiddenClose').click();
    await fermee();
    await ouvrir();
    await page.keyboard.press('Escape');
    await fermee();
    await ouvrir();
    await page.mouse.click(5, 5);
    await fermee();

    assert.deepEqual((await memo('mergerie_jenkins_dossiers')).masques, ['outils'],
      'fermer la modale ne remet rien : le dossier reste masqué');
    await lignes(3);

    await ouvrir();
    await page.locator('#jenkinsHiddenAll').click();
    await fermee();
    await lignes(5);
    assert.deepEqual((await memo('mergerie_jenkins_dossiers')).masques, []);
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
