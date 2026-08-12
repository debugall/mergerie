'use strict';
/* L'onglet Jenkins dans un VRAI navigateur, contre un faux serveur Jenkins.
 *
 * Deux choses ne se prouvent que là. La première : LANCER DEMANDE CONFIRMATION, et un job
 * PARAMÉTRÉ n'est jamais lancé depuis la liste — on ouvre sa fiche, où les paramètres se
 * lisent. Lancer avec des valeurs par défaut qu'on n'a pas vues, c'est déployer la mauvaise
 * version. La seconde : le jeton saisi dans les réglages arrive bien jusqu'à la requête —
 * un champ oublié dans une des deux listes blanches s'affiche, accepte la frappe, et n'est
 * jamais enregistré.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Onglet Jenkins', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let srv;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    srv = await mock.start();
    mock.reset();
    const build = (t, causes, ref, params) => ({
      timestamp: t, number: 10 + (t % 10),
      actions: [
        { causes },
        params ? { parameters: params.map(([name, value]) => ({ name, value, _class: 'hudson.model.StringParameterValue' })) } : {},
        ref ? { lastBuiltRevision: { branch: [{ name: `refs/remotes/origin/${ref}` }] } } : {},
      ],
    });
    mock.state.jobs = [
      { name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'api-build', color: 'blue', buildable: true, lastBuild: build(2000, [{ userName: 'Alice' }], 'main', [['ENV', 'recette'], ['VERSION', '9.9'], ['SEUL', 'x']]) },
        { name: 'deploy-prod',
          color: 'blue',
          buildable: true,
          property: [{ parameterDefinitions: [{ name: 'VERSION' }, { name: 'ENV' }] }],
          lastBuild: {
            ...build(1000, [{ userName: 'Bruno' }], 'v1.0'),
            actions: [
              { causes: [{ userName: 'Bruno' }] },
              { parameters: [
                { name: 'VERSION', value: '1.4', _class: 'hudson.model.StringParameterValue' },
                { name: 'ENV', value: 'prod', _class: 'hudson.model.StringParameterValue' },
                { name: 'MDP', value: '{AQAAABAA}', _class: 'hudson.model.PasswordParameterValue' },
                { name: 'VIDE', value: '', _class: 'hudson.model.StringParameterValue' },
                { name: 'MIGRE', value: true, _class: 'hudson.model.BooleanParameterValue' },
                { name: 'DEBUG', value: 'false', _class: 'hudson.model.BooleanParameterValue' },
              ] },
              { lastBuiltRevision: { branch: [{ name: 'refs/remotes/origin/v1.0' }] } },
            ],
          } },
        // Buildable et SANS paramètre : « Relancer » n'aurait rien à reprendre, ce serait « Lancer ».
        { name: 'simple', color: 'blue', buildable: true, lastBuild: build(500, [{ userName: 'Zoe' }], 'main') },
        { name: 'front-build', color: 'red', buildable: true, lastBuild: build(9000, [{ _class: 'hudson.triggers.SCMTrigger$SCMTriggerCause' }], 'feature/x', [['ENV', 'dev'], ['VERSION', '8.8'], ['LOT', '10']]) },
      ] },
      { name: 'batch', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'nuit', color: 'blue', buildable: true, lastBuild: build(5000, [{ _class: 'hudson.triggers.TimerTrigger$TimerTriggerCause' }], 'main', [['ENV', 'prod'], ['LOT', '20']]) },
      ] },
      { name: 'archive', color: 'disabled', buildable: false },
    ];
    mock.state.details['/job/boutique/job/api-build'] = {
      name: 'api-build', color: 'blue', buildable: true, property: [], builds: [
        { number: 8, result: 'SUCCESS', building: false, timestamp: Date.now(), duration: 4000, url: '' },
      ],
    };
    // Un historique AVEC ses paramètres : c'est ce que la fiche doit montrer à droite.
    const passe = (n, quand, env) => ({
      number: n, result: 'SUCCESS', building: false, timestamp: quand, duration: 5000, url: `http://jenkins.test/job/x/${n}/`,
      actions: [
        { causes: [{ userName: 'Bruno' }] },
        { parameters: [
          { name: 'VERSION', value: `1.${n}`, _class: 'hudson.model.StringParameterValue' },
          { name: 'ENV', value: env, _class: 'hudson.model.StringParameterValue' },
        ] },
      ],
    });
    mock.state.details['/job/boutique/job/deploy-prod'] = {
      name: 'deploy-prod', color: 'blue', buildable: true,
      builds: [passe(11, 3000, 'prod'), passe(10, 2000, 'recette')],
      property: [{ parameterDefinitions: [
        { name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '1.0' } },
        { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['recette', 'prod'], defaultParameterValue: { value: 'recette' } },
      ] }],
    };
    mock.state.console['/job/boutique/job/api-build/8'] = 'tout va bien\nFinished: SUCCESS';

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1300, height: 900 } });
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  const allerJenkins = async () => {
    await page.locator('nav button[data-tab="jenkins"]').click();
    await page.waitForSelector('#jenkinsBox');
  };

  /* On commence NON CONFIGURÉ, comme une installation neuve : l'onglet doit expliquer, pas
     afficher une erreur rouge — et son bouton doit mener au bon sous-onglet de réglages. */
  test('sans connexion, l’onglet explique et mène aux réglages', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .empty');
    await page.locator('#jenkinsBox [data-empty-act="jenkins-config"]').click();
    await page.waitForSelector('#sub-jenkinscfg.active');
    assert.equal(await page.locator('#configForm [name="jenkins_url"], [name="jenkins_url"]').first().isVisible(), true);
  });

  /* LE PIÈGE DES LISTES BLANCHES : un champ de config vit dans CONFIG_FIELDS (écran) et dans
     ALLOWED + l'UPDATE (serveur). En manquer une le laisse s'afficher, accepter la frappe, et
     n'être jamais enregistré. On le saisit donc à l'écran, et on le relit par son EFFET. */
  test('les identifiants saisis dans les réglages arrivent jusqu’à Jenkins', async () => {
    await page.locator('[name="jenkins_url"]').fill(srv.url);
    await page.locator('[name="jenkins_user"]').fill(mock.state.user);
    await page.locator('[name="jenkins_token"]').fill(mock.state.token);
    await page.locator('#btnTestJenkins').click();
    await page.waitForFunction(() => /Moi Même/.test(document.querySelector('#configInfoJenkins').textContent),
      null, { timeout: 5000 });

    await page.locator('#sub-jenkinscfg button[type="submit"]').first().click();
    await page.waitForTimeout(300);
    await page.reload();
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    assert.equal(await page.locator('#jenkinsBox .jk-row').count(), 6,
      'après enregistrement ET rechargement, la liste vient du serveur : le jeton a survécu');
  });

  /* L'ORDRE DE LECTURE, et ce que porte chaque ligne. Une liste de jobs se lit par la
     FRAÎCHEUR : ce qui vient de tourner d'abord. Et il faut trois choses pour savoir si ça
     nous concerne — quand, par qui, et sur quoi. */
  test('la liste est triée par date, avec l’auteur et la branche', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    const noms = await page.locator('#jenkinsBox .jk-name').allTextContents();
    assert.deepEqual(noms.map((n) => n.replace(/\s+#\d+$/, '')),
      ['boutique/front-build', 'batch/nuit', 'boutique/api-build', 'boutique/deploy-prod', 'boutique/simple', 'archive'],
      'du plus récent au plus ancien, et le jamais lancé à la fin');

    const meta = await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'api-build' }).first().locator('.jk-meta').textContent();
    assert.match(meta, /par Alice/, 'qui a lancé');
    assert.match(meta, /main/, 'sur quelle branche');
    assert.doesNotMatch(meta, /refs\/remotes/, '« refs/remotes/origin/main » est un détail d’implémentation');

    /* AVEC QUELS PARAMÈTRES le dernier lancement est parti — ils arrivent dans la même
       requête que la liste, donc les afficher ne coûte rien. Et ils vivent sur LEUR PROPRE LIGNE, en pastilles nom/valeur : mêlés au
       statut, à la date et à l'auteur — tous gris, tous séparés par des points médians — on
       lisait une phrase au lieu de couples. */
    const ligne = page.locator('#jenkinsBox .jk-row').filter({ hasText: 'deploy-prod' }).first();
    const chips = await ligne.locator('.jk-chip').allTextContents();
    const cles = await ligne.locator('.jk-chip-k').allTextContents();
    assert.deepEqual([...cles].sort(), ['DEBUG', 'ENV', 'MIGRE', 'VERSION'],
      'TOUS les paramètres, sans « +3 » : la question qu’on se pose en lisant la liste est justement « avec quoi ? »');
    assert.ok(chips.some((c) => /ENV\s*prod/.test(c)), 'nom et valeur ensemble dans la pastille');
    assert.ok(!cles.includes('MDP'), 'un paramètre de type mot de passe est écarté');
    assert.ok(!cles.includes('VIDE'), 'une valeur vide n’apprend rien');
    assert.equal(await ligne.locator('.jk-meta .jk-chip').count(), 0,
      'ils ne sont plus noyés dans la ligne de statut');

    // Un déclenchement automatique n'a pas d'auteur : on dit sa NATURE plutôt que rien.
    const auto = await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'nuit' }).first().locator('.jk-meta').textContent();
    assert.match(auto, /planificateur/);
  });

  test('la recherche et « ce qui ne va pas » filtrent la liste', async () => {
    await allerJenkins();
    await page.locator('#jenkinsSearch').fill('front');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);

    /* La recherche porte sur ce que la LIGNE MONTRE : chercher une valeur de paramètre qu'on a
       sous les yeux et ne rien trouver est la façon la plus sûre de ne plus s'en servir. */
    await page.locator('#jenkinsSearch').fill('MIGRE=true');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /deploy-prod/,
      'un paramètre du dernier lancement retrouve son job');

    // Une valeur portée par plusieurs jobs les retrouve tous — c'est bien le but.
    await page.locator('#jenkinsSearch').fill('ENV=prod');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 2);

    await page.locator('#jenkinsSearch').fill('Alice');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /api-build/,
      'l’auteur aussi : il est écrit sur la ligne');

    await page.locator('#jenkinsSearch').fill('feature/x');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /front-build/,
      'la branche aussi');

    await page.locator('#jenkinsSearch').fill('');

    await page.locator('#jenkinsFailOnly').check();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /front-build/,
      '« ce qui ne va pas » retient l’échec et l’instable, pas le vert');
    await page.locator('#jenkinsFailOnly').uncheck();
  });

  /* LES PARAMÈTRES QUI REVIENNENT PORTENT UNE COULEUR. Aligner en colonnes raidissait la liste
     et la remplissait de trous ; ce qu'on cherche, c'est retrouver `ENV` d'une ligne à l'autre
     du coin de l'œil. La teinte vient du NOM, donc elle ne bouge pas d'un job à l'autre — ni
     d'un rafraîchissement à l'autre. Un paramètre porté par un seul job reste neutre : une
     couleur qui ne se retrouve nulle part n'apprend rien. */
  test('un paramètre présent sur trois jobs porte la même couleur partout', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');

    const teintes = await page.evaluate(() => [...document.querySelectorAll('#jenkinsBox .jk-chip')]
      .map((c) => [c.querySelector('.jk-chip-k').textContent,
        [...c.classList].find((x) => /^jk-c\d+$/.test(x)) || null]));
    const de = (nom) => [...new Set(teintes.filter(([n]) => n === nom).map(([, t]) => t))];

    assert.equal(de('ENV').length, 1, 'la même teinte sur toutes les lignes');
    assert.ok(de('ENV')[0], 'ENV est sur quatre jobs : il en reçoit une');
    assert.ok(de('VERSION')[0], 'VERSION sur trois jobs aussi');
    assert.notEqual(de('ENV')[0], de('VERSION')[0], 'deux paramètres fréquents se distinguent');
    assert.equal(de('SEUL')[0], null, 'un paramètre d’un seul job reste neutre');
    assert.equal(de('LOT')[0], null, 'à deux jobs non plus : le seuil est à trois');
  });

  /* UN FILTRE QU'ON N'UTILISE JAMAIS EST DU BRUIT. Il se range, comme un dossier — et sa
     valeur est effacée en même temps : un filtre invisible qui continue de filtrer est le
     meilleur moyen de chercher dix minutes pourquoi la liste est vide. */
  test('un filtre non pertinent se masque, sa valeur avec, et se remet', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsParamFiltres [data-jkpf="VERSION"]');
    await page.locator('[data-jkpf="VERSION"]').selectOption('9.9');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);

    await page.locator('[data-jkpfhide="VERSION"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-jkpf="VERSION"]'));
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 6);
    assert.match(await page.locator('#jenkinsParamHidden').textContent(), /1 filtre masqué/);

    await page.reload();
    await allerJenkins();
    await page.waitForSelector('#jenkinsParamHidden');
    assert.equal(await page.locator('[data-jkpf="VERSION"]').count(), 0, 'le masquage est mémorisé');

    // On le retrouve dans la même modale que les dossiers rangés, et un clic le remet.
    await page.locator('#jenkinsParamHidden').click();
    await page.waitForSelector('#jenkinsHiddenModal:not([hidden])');
    await page.locator('[data-jkpfshow="VERSION"]').click();
    await page.waitForSelector('[data-jkpf="VERSION"]');
    assert.equal(await page.locator('[data-jkpf="VERSION"]').inputValue(), '',
      'il revient sans sa valeur d’avant : on ne remet pas en marche un filtre à son insu');
  });

  test('on filtre sur la valeur d’un paramètre fréquent', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsParamFiltres:not([hidden])');
    /* LE SEUIL EST À TROIS. À deux, une coïncidence entre deux jobs figerait une colonne pour
       tout le monde ; `LOT` est sur deux jobs et n'en obtient donc pas. */
    assert.deepEqual(await page.locator('#jenkinsParamFiltres .jk-pf-k').allTextContents(), ['ENV', 'VERSION'],
      'ENV sur quatre jobs et VERSION sur trois ; LOT sur deux et SEUL sur un n’en méritent pas');

    await page.locator('[data-jkpf="ENV"]').selectOption('dev');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /front-build/);

    /* Une valeur portée par deux jobs les garde tous les deux — et un job qui n'a PAS le
       paramètre est écarté : il ne répond pas à la question posée. */
    await page.locator('[data-jkpf="ENV"]').selectOption('prod');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 2);

    /* Les colonnes ne bougent PAS quand on filtre : elles sont calculées sur TOUS les jobs.
       Calculées sur ce qui reste, une liste réduite à un job ferait tomber tout le monde sous
       le seuil — les colonnes disparaîtraient sous les yeux à chaque frappe. */
    await page.locator('[data-jkpf="ENV"]').selectOption('dev');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.equal(await page.locator('#jenkinsParamFiltres [data-jkpf]').count(), 2,
      'un seul job affiché, et pourtant les deux colonnes tiennent');
    await page.locator('[data-jkpf="ENV"]').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 6);
  });

  /* LE FILTRE PAR DOSSIERS. Il est mémorisé — sinon il faudrait le refaire à chaque
     ouverture, ce qui revient à ne pas l'avoir. Et il mémorise ce qu'on a DÉCOCHÉ : un
     dossier créé demain doit apparaître de lui-même, pas rester invisible pour toujours. */
  test('décocher un dossier masque ses jobs, et ça survit au rechargement', async () => {
    await allerJenkins();
    /* On attend le compte ATTENDU, pas un compte capturé : entre deux rendus la liste passe
       par un squelette à zéro ligne, et une valeur lue là est un piège silencieux. */
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(6);
    await page.waitForSelector('#jenkinsFolders:not([hidden])');

    await page.locator('[data-jkfolder="boutique"]').uncheck();
    await lignes(2);   // 6 jobs, dont 4 dans « boutique »
    assert.equal(await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'boutique/' }).count(), 0);

    await page.reload();
    await allerJenkins();
    await lignes(2);
    assert.equal(await page.locator('[data-jkfolder="boutique"]').isChecked(), false,
      'un filtre qu’il faut refaire à chaque ouverture revient à ne pas l’avoir');

    // Un dossier NOUVEAU chez Jenkins apparaît coché : on mémorise les exclusions, pas les inclusions.
    mock.state.jobs.push({ name: 'nouveau', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [{ name: 'a', color: 'blue', buildable: true }] });
    await page.locator('#jenkinsReload').click();
    await page.waitForSelector('[data-jkfolder="nouveau"]');
    assert.equal(await page.locator('[data-jkfolder="nouveau"]').isChecked(), true,
      'mémoriser les cochés rendrait invisible tout dossier créé après coup');
    mock.state.jobs.pop();
    await page.locator('#jenkinsReload').click();
    await lignes(2);

    await page.locator('[data-jkfolder="boutique"]').check();
    await lignes(6);
  });

  /* MASQUER N'EST PAS DÉCOCHER. Décocher, c'est « pas maintenant » — la case reste sous la
     main. Masquer, c'est « ce dossier ne me concerne pas » : il sort de la liste des cases,
     qui redevient lisible. Ses jobs partent avec lui — le masquer en les laissant donnerait
     des jobs qu'on ne peut plus filtrer. Et on doit pouvoir le remettre, un par un. */
  test('un dossier se masque de la liste des filtres, et se remet', async () => {
    await allerJenkins();
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(6);
    // Trois entrées : « batch », « boutique », et la racine — un job hors dossier en est un aussi.
    assert.equal(await page.locator('#jenkinsFolderList [data-jkfolder]').count(), 3);

    await page.locator('[data-jkhide="batch"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsFolderList [data-jkfolder]').length === 2);
    await lignes(5);
    assert.equal(await page.locator('[data-jkfolder="batch"]').count(), 0, 'sa case quitte la liste');
    assert.equal(await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'batch/' }).count(), 0,
      'ses jobs partent avec elle : sinon on aurait des jobs qu’on ne peut plus filtrer');

    /* Ce qui est masqué se COMPTE — un filtre invisible devient un mystère — mais ne s'étale
       pas : le détail est derrière le clic, pas en travers de l'écran. */
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');
    assert.match(await page.locator('#jenkinsFolderHidden').textContent(), /1 dossier masqué/);
    assert.equal(await page.locator('#jenkinsFolderHidden [data-jkshow]').count(), 0,
      'le pied compte, il ne liste pas : une rangée de boutons rarement cliqués mange la place');

    await page.reload();
    await allerJenkins();
    await lignes(5);
    assert.equal(await page.locator('[data-jkfolder="batch"]').count(), 0, 'le masquage est mémorisé');

    // Le détail, et le retour, se font dans la modale.
    await page.locator('#jenkinsFolderHidden').click();
    await page.waitForSelector('#jenkinsHiddenModal:not([hidden])');
    assert.equal(await page.locator('#jenkinsHiddenList [data-jkshow]').count(), 1);
    await page.locator('[data-jkshow="batch"]').click();
    await lignes(6);
    assert.equal(await page.locator('[data-jkfolder="batch"]').isChecked(), true, 'remis, et coché comme avant');
    assert.equal(await page.locator('#jenkinsHiddenModal').isHidden(), true,
      'plus rien à remettre : la modale n’a plus de raison d’être ouverte');
    assert.equal(await page.locator('#jenkinsFolderHidden').isHidden(), true, 'plus rien de masqué, plus de compteur');
  });

  /* « Tout remettre » : le jour où l'on change d'avis en bloc, remettre huit dossiers un par
     un est une corvée que le bouton existe pour éviter. */
  test('« tout remettre » vide la liste des masqués d’un coup', async () => {
    await allerJenkins();
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(6);
    await page.locator('[data-jkhide="batch"]').click();
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');
    await page.locator('[data-jkhide="boutique"]').click();
    await page.waitForFunction(() => /2 dossiers masqués/.test(document.querySelector('#jenkinsFolderHidden').textContent));

    await page.locator('#jenkinsFolderHidden').click();
    await page.waitForSelector('#jenkinsHiddenModal:not([hidden])');
    await page.locator('#jenkinsHiddenAll').click();
    await lignes(6);
    assert.equal(await page.locator('#jenkinsHiddenModal').isHidden(), true);
    assert.equal(await page.locator('#jenkinsFolderHidden').isHidden(), true);
  });

  /* Un dossier DÉCOCHÉ puis masqué doit revenir DÉCOCHÉ : masquer range, ça ne décide pas à
     notre place de ce qu'on avait choisi de voir. */
  test('masquer ne perd pas l’état coché du dossier', async () => {
    await allerJenkins();
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(6);
    await page.locator('[data-jkfolder="batch"]').uncheck();
    await lignes(5);
    await page.locator('[data-jkhide="batch"]').click();
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');
    await page.locator('#jenkinsFolderHidden').click();
    await page.waitForSelector('#jenkinsHiddenModal:not([hidden])');
    await page.locator('[data-jkshow="batch"]').click();
    await page.waitForSelector('[data-jkfolder="batch"]');
    assert.equal(await page.locator('[data-jkfolder="batch"]').isChecked(), false,
      'masquer range la case, ça ne recoche pas à notre place');
    await page.locator('[data-jkfolder="batch"]').check();
    await lignes(6);
  });

  /* « Tout décocher » après une recherche ne doit toucher QUE ce qu'on voit : sinon le
     bouton agit sur des dossiers hors de l'écran, et personne ne comprend ce qui a disparu. */
  test('« tout décocher » ne porte que sur les dossiers visibles', async () => {
    await allerJenkins();
    await page.locator('#jenkinsFolderSearch').fill('bat');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsFolderList [data-jkfolder]').length === 1);
    await page.locator('#jenkinsFoldersNone').click();
    await page.waitForFunction(() => !!document.querySelector('#jenkinsBox .jk-row'));
    assert.equal(await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'batch/' }).count(), 0);
    assert.ok(await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'boutique/' }).count() > 0,
      'les dossiers masqués par la recherche du filtre n’ont pas été touchés');

    await page.locator('#jenkinsFolderSearch').fill('');
    await page.locator('#jenkinsFoldersAll').click();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 6);
  });

  test('un job désactivé n’a pas de bouton « Lancer »', async () => {
    await allerJenkins();
    const ligne = page.locator('#jenkinsBox .jk-row').filter({ hasText: 'archive' }).first();
    assert.equal(await ligne.locator('[data-jkrun]').count(), 0,
      'proposer de lancer ce que Jenkins refusera est une promesse qu’on ne tient pas');
  });

  /* Lancer un job sans paramètre : confirmation, puis la requête part vraiment. Le témoin est
     la requête reçue par Jenkins — un toast de succès ne prouve rien. */
  test('lancer demande confirmation, et annuler n’envoie rien', async () => {
    await allerJenkins();
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;
    await page.locator('[data-jkrun="boutique/api-build"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /api-build/,
      'la question nomme le job : c’est ce qui permet de s’apercevoir qu’on s’est trompé de ligne');

    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, avant,
      'annuler doit vraiment ne rien lancer');

    await page.locator('[data-jkrun="boutique/api-build"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => !!document.querySelector('#toasts .toast'));
    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant);
    assert.equal(post.length, 1);
    assert.ok(post[0].path.endsWith('/build'), 'un job sans paramètre part sur /build');
  });

  /* CE QUE LE BOUTON PROMET. « Lancer » sur un job qui part au clic et « Lancer » sur un job
     qui va d'abord demander une version ne sont pas le même geste : l'écran le sait avant le
     clic (les paramètres arrivent avec la liste), il doit donc le dire — points de suspension
     et infobulle, la convention de tout formulaire qui s'ouvre. */
  test('le bouton annonce qu’un job paramétré va demander des valeurs', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    const avecParams = page.locator('[data-jkrun="boutique/deploy-prod"]');
    assert.match(await avecParams.textContent(), /Lancer…/);
    assert.match(await avecParams.getAttribute('title'), /2 paramètres/);

    const sansParams = page.locator('[data-jkrun="boutique/api-build"]');
    assert.doesNotMatch(await sansParams.textContent(), /…/, 'sans paramètre, rien ne s’ouvre : le bouton lance');
  });

  /* UN JOB PARAMÉTRÉ NE SE LANCE PAS À L'AVEUGLE. Le bouton de la liste ouvre sa fiche : on
     voit ce qu'on va envoyer, et on peut le changer avant. */
  /* UNE LISTE DÉROULANTE DOIT ÊTRE UNE LISTE. Chaque plugin de paramètre expose ses valeurs à
     sa façon : le choix standard dans `choices`, Extended Choice dans une seule chaîne à
     virgules. Retomber en champ libre fait retaper à la main une valeur que Jenkins connaît —
     et une faute de frappe part alors en production. */
  test('les paramètres à choix sont rendus en liste déroulante, quel que soit le plugin', async () => {
    // On REND le décor : les tests partagent le faux serveur, et le suivant compte sur le sien.
    const decor = mock.state.details['/job/boutique/job/deploy-prod'].property;
    mock.state.details['/job/boutique/job/deploy-prod'].property = [{ parameterDefinitions: [
      { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['recette', 'prod'], defaultParameterValue: { value: 'recette' } },
      { name: 'CIBLE', _class: 'com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition', value: 'fr, be, ch', defaultValue: 'be' },
      { name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '1.0' } },
    ] }];
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jkparam="ENV"]');

    const balise = (n) => page.locator(`[data-jkparam="${n}"]`).evaluate((el) => el.tagName);
    assert.equal(await balise('ENV'), 'SELECT', 'le choix standard est une liste');
    assert.equal(await balise('CIBLE'), 'SELECT',
      'Extended Choice met ses options dans une chaîne à virgules : c’est une liste aussi');
    assert.deepEqual(await page.locator('[data-jkparam="CIBLE"] option').allTextContents(), ['fr', 'be', 'ch']);
    assert.equal(await page.locator('[data-jkparam="CIBLE"]').inputValue(), 'be', 'et sa valeur par défaut est retenue');
    assert.equal(await balise('VERSION'), 'INPUT', 'un texte libre reste un texte libre');
    await page.locator('#jenkinsClose').click();
    mock.state.details['/job/boutique/job/deploy-prod'].property = decor;
  });

  /* LE CAS RÉEL : un job dont les paramètres sont des LISTES CALCULÉES (branches du dépôt,
     environnements). L'API n'en dit rien ; la page de lancement, elle, les porte. À l'écran,
     ça doit donner de vraies listes — et le choix multiple doit rester multiple. */
  test('les listes calculées par Jenkins arrivent jusqu’au formulaire', async () => {
    const decor = mock.state.details['/job/boutique/job/deploy-prod'].property;
    mock.state.details['/job/boutique/job/deploy-prod'].property = [{ parameterDefinitions: [
      { name: 'Branche', _class: 'net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition' },
      { name: 'ENV', _class: 'ExtendedChoiceParameterDefinition', value: 'Could not get Environment from ENV Param' },
    ] }];
    mock.state.forms['/job/boutique/job/deploy-prod'] = `
      <div name="parameter"><input type="hidden" name="name" value="Branche">
        <select name="value" multiple>
          <option value="refs/heads/develop">refs/heads/develop</option>
          <option value="refs/heads/master" selected>refs/heads/master</option>
        </select></div>
      <div name="parameter"><input type="hidden" name="name" value="ENV">
        <select name="value"><option selected>dev</option><option>prod</option></select></div>`;

    await allerJenkins();
    await page.locator('[data-jkopen="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jkparam="Branche"]');
    assert.equal(await page.locator('[data-jkparam="ENV"]').evaluate((el) => el.tagName), 'SELECT',
      'plus de champ libre : la page de Jenkins portait la liste');
    assert.equal(await page.locator('[data-jkparam="Branche"]').evaluate((el) => el.multiple), true,
      '« une ou plusieurs machines » doit rester un choix multiple');
    assert.equal(await page.locator('.jk-param-warn').count(), 0, 'plus rien à signaler');

    // Ce qui part à Jenkins : les valeurs choisies, séparées par des virgules.
    await page.locator('[data-jkparam="Branche"]').selectOption(['refs/heads/develop', 'refs/heads/master']);
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction((n) => document.querySelectorAll('#toasts .toast').length >= n, 1);
    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant)[0];
    assert.match(decodeURIComponent(post.body), /Branche=refs\/heads\/develop,refs\/heads\/master/,
      'un choix multiple part en une valeur séparée par des virgules, la forme qu’attend le plugin');

    mock.state.details['/job/boutique/job/deploy-prod'].property = decor;
    delete mock.state.forms['/job/boutique/job/deploy-prod'];
  });

  /* QUAND LE PLUGIN RATE SON CALCUL, il rend sa phrase d'erreur À LA PLACE de la liste. La
     prendre pour une valeur pré-remplirait le champ d'une phrase qui a l'air d'une valeur —
     et un lancement l'enverrait telle quelle à Jenkins. */
  test('un paramètre dynamique en échec n’est pas pré-rempli avec le message d’erreur', async () => {
    const decor = mock.state.details['/job/boutique/job/deploy-prod'].property;
    mock.state.details['/job/boutique/job/deploy-prod'].property = [{ parameterDefinitions: [
      { name: 'HOST_IP',
        _class: 'com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition',
        description: 'OPTIONAL : Choose One or Multiple machine(s)',
        value: 'Could not get Environment from ENV Param' },
    ] }];
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jkparam="HOST_IP"]');

    assert.equal(await page.locator('[data-jkparam="HOST_IP"]').inputValue(), '',
      'la phrase d’erreur du plugin n’est pas une valeur : le champ part vide');
    assert.match(await page.locator('.jk-param-warn').textContent(), /paramètre dynamique/,
      'et on le DIT : un champ vide inexpliqué se remplit au jugé');
    assert.equal(await page.locator('.jk-param-warn .jk-open-ext').count(), 1,
      'avec le lien pour aller le lancer depuis Jenkins, qui sait calculer ces valeurs');

    await page.locator('#jenkinsClose').click();
    mock.state.details['/job/boutique/job/deploy-prod'].property = decor;
  });

  test('un job paramétré ouvre sa fiche au lieu de partir', async () => {
    await allerJenkins();
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;
    await page.locator('[data-jkrun="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jkparam="VERSION"]');
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, avant,
      'ouvrir la fiche ne lance rien');
    // …et la fiche explique ce qu'on attend de nous, sinon on la prend pour un panneau d'info.
    assert.match(await page.locator('.jk-param-intro').textContent(), /Lancer/);
    assert.equal(await page.locator('#confirmModal').isHidden(), true);

    await page.locator('[data-jkparam="VERSION"]').fill('2.4.1');
    await page.locator('[data-jkparam="ENV"]').selectOption('prod');
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction((n) => document.querySelectorAll('#toasts .toast').length >= n, 1);

    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant);
    assert.equal(post.length, 1);
    assert.ok(post[0].path.endsWith('/buildWithParameters'));
    assert.equal(post[0].body, 'VERSION=2.4.1&ENV=prod',
      'ce sont les valeurs SAISIES qui partent, pas les défauts du job');
  });

  /* La console s'ouvre — et se LIT. Une ligne de log fait volontiers trois cents caractères ;
     devoir défiler de côté pour lire l'erreur qu'on cherchait revient à ne pas l'afficher. Un
     `white-space` ne se relit pas, il se mesure : on demande au navigateur si le contenu
     déborde de son cadre. */
  /* LA FICHE EN DEUX COLONNES : l'historique à gauche, ce qu'on sélectionne à droite. Le
     bouton Console reste dans la liste — c'est le geste le plus fréquent, il ne doit pas
     coûter une sélection de plus. */
  test('la fiche montre l’historique à gauche et le détail de l’exécution choisie à droite', async () => {
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsFiche [data-jkbuild]');

    // Le plus récent est choisi d'office : c'est celui qu'on vient voir neuf fois sur dix.
    assert.equal(await page.locator('#jenkinsFiche .jk-build.selected [data-jkbuild]').getAttribute('data-jkbuild'), '11');
    const droite = page.locator('#jenkinsFiche .jk-fiche-col').nth(1);
    assert.match(await droite.textContent(), /ENV/, 'les paramètres de l’exécution sont à droite');
    assert.match(await droite.textContent(), /prod/);
    assert.match(await droite.textContent(), /Bruno/, 'et qui l’a lancée');
    assert.equal(await page.locator('#jenkinsFiche .jk-build [data-jklog]').count(),
      await page.locator('#jenkinsFiche [data-jkbuild]').count(),
      'chaque ligne d’historique garde son bouton Console');

    /* ET SURTOUT : choisir une AUTRE exécution change le détail. Sans ce clic, on ne prouve
       que l'affichage du premier build — la sélection pourrait ne rien faire du tout. */
    assert.match(await droite.textContent(), /1\.11/, 'les valeurs du build #11');
    await page.locator('[data-jkbuild="10"]').click();
    await page.waitForFunction(() => /1\.10/.test(document.querySelectorAll('#jenkinsFiche .jk-fiche-col')[1].textContent));
    assert.match(await droite.textContent(), /recette/, 'ce sont les paramètres du build choisi, pas ceux du dernier');
    assert.equal(await page.locator('#jenkinsFiche .jk-build.selected [data-jkbuild]').getAttribute('data-jkbuild'), '10',
      'la ligne choisie se voit dans la liste');
    await page.locator('#jenkinsClose').click();
  });

  /* RELANCER À L'IDENTIQUE, depuis la liste. La confirmation doit MONTRER les valeurs : sans
     elles, « relancer » ne dit pas avec quoi, et c'est justement la question. */
  test('relancer depuis la liste repart avec les paramètres du dernier lancement', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    const ligne = page.locator('#jenkinsBox .jk-row').filter({ hasText: 'deploy-prod' }).first();
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;

    /* ANNULER N'ENVOIE RIEN. Sans ce passage, la confirmation pourrait n'être qu'un décor :
       tous les autres tests cliquent « oui », et une garde qui ne garde rien passerait. */
    await ligne.locator('[data-jkrerun]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, avant,
      'annuler doit vraiment ne rien relancer');

    await ligne.locator('[data-jkrerun]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    const detail = await page.locator('#confirmDetail').textContent();
    assert.match(detail, /VERSION = 1\.4/, 'la confirmation montre les valeurs qui vont repartir');
    assert.match(detail, /ENV = prod/);
    assert.match(await page.locator('#confirmText').textContent(), /1 paramètre secret/,
      'un secret ne peut pas être renvoyé : le dire vaut mieux que relancer un job amputé');

    await page.locator('#confirmOk').click();
    await page.waitForFunction((n) => document.querySelectorAll('#toasts .toast').length >= n, 1);
    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant)[0];
    assert.ok(post.path.endsWith('/buildWithParameters'));
    assert.match(post.body, /VERSION=1\.4/);
    assert.match(post.body, /ENV=prod/);
    assert.ok(!/MDP/.test(post.body), 'le secret n’est pas inventé');
  });

  test('un job sans paramètre n’a pas de bouton « Relancer » (ce serait « Lancer »)', async () => {
    await allerJenkins();
    const ligne = page.locator('#jenkinsBox .jk-row').filter({ hasText: 'simple' }).first();
    assert.equal(await ligne.locator('.jk-chip').count(), 0, 'ce job est bien parti sans paramètre');
    assert.equal(await ligne.locator('[data-jkrerun]').count(), 0);
  });

  /* Et depuis l'historique : les valeurs de CETTE exécution, pas celles du dernier lancement —
     c'est ce qu'on veut après avoir lu la console d'un build raté. */
  test('relancer une exécution précise reprend SES valeurs', async () => {
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/deploy-prod"]').click();
    await page.waitForSelector('#jenkinsFiche [data-jkrerunbuild="10"]');
    const avant = mock.state.calls.filter((c) => c.method === 'POST').length;

    await page.locator('[data-jkrerunbuild="10"]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmDetail').textContent(), /ENV = recette/,
      'les valeurs du build CHOISI, pas celles du dernier');
    await page.locator('#confirmOk').click();
    await page.waitForFunction((n) => document.querySelectorAll('#toasts .toast').length >= n, 1);
    const post = mock.state.calls.filter((c) => c.method === 'POST').slice(avant)[0];
    assert.match(post.body, /ENV=recette/);
    // La fermeture suit l'envoi : on l'attend plutôt que de la lire dans la même milliseconde.
    await page.waitForSelector('#jenkinsModal[hidden]', { state: 'attached' });
  });

  /* LE LIEN VERS JENKINS. Il s'ouvre dans un nouvel onglet, et il ne relaie que du http(s) :
     l'URL vient de Jenkins, donc de l'extérieur. */
  test('chaque ligne porte un lien vers le job dans Jenkins', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    const lien = page.locator('#jenkinsBox .jk-open-ext').first();
    assert.equal(await lien.getAttribute('target'), '_blank');
    assert.match(await lien.getAttribute('rel'), /noopener/, 'la page ouverte ne doit pas reprendre la main');
    assert.match(await lien.getAttribute('href'), /^https?:\/\//);
  });

  /* LE RAFRAÎCHISSEMENT AUTOMATIQUE se débraye, et le choix est mémorisé. */
  test('la case coupe le rafraîchissement automatique, et s’en souvient', async () => {
    await allerJenkins();
    await page.waitForSelector('#jenkinsNoAuto');
    assert.equal(await page.locator('#jenkinsNoAuto').isChecked(), false, 'décoché par défaut : ça se rafraîchit tout seul');

    await page.locator('#jenkinsNoAuto').check();
    assert.equal(await page.evaluate(() => localStorage.getItem('mergerie_jenkins_auto')), '0');
    await page.reload();
    await allerJenkins();
    await page.waitForSelector('#jenkinsBox .jk-row');
    assert.equal(await page.locator('#jenkinsNoAuto').isChecked(), true,
      'un réglage qu’il faut refaire à chaque ouverture n’est pas un réglage');
    await page.locator('#jenkinsNoAuto').uncheck();
  });

  test('la console s’ouvre et se replie à la ligne, sans défilement horizontal', async () => {
    mock.state.console['/job/boutique/job/api-build/8'] = `commande : ${'x'.repeat(600)}\nFinished: SUCCESS`;
    await allerJenkins();
    await page.locator('[data-jkopen="boutique/api-build"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) [data-jklog]');
    await page.locator('[data-jklog]').first().click();
    await page.waitForFunction(() => /Finished: SUCCESS/.test(document.querySelector('#jenkinsLogBody').textContent));

    const deborde = await page.locator('#jenkinsLogBody').evaluate((el) => ({
      h: el.scrollWidth > el.clientWidth + 1,
      modale: el.closest('.modal-box').scrollWidth > el.closest('.modal-box').clientWidth + 1,
    }));
    assert.equal(deborde.h, false, 'la console doit replier à la ligne, pas défiler de côté');
    assert.equal(deborde.modale, false, 'et elle ne doit pas non plus élargir la modale qui la porte');

    await page.locator('#jenkinsLogClose').click();
    await page.locator('#jenkinsClose').click();
  });
});
