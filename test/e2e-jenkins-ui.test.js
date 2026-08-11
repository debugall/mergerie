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
    const build = (t, causes, ref) => ({
      timestamp: t, number: 10 + (t % 10),
      actions: [{ causes }, ref ? { lastBuiltRevision: { branch: [{ name: `refs/remotes/origin/${ref}` }] } } : {}],
    });
    mock.state.jobs = [
      { name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'api-build', color: 'blue', buildable: true, lastBuild: build(2000, [{ userName: 'Alice' }], 'main') },
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
        { name: 'front-build', color: 'red', buildable: true, lastBuild: build(9000, [{ _class: 'hudson.triggers.SCMTrigger$SCMTriggerCause' }], 'feature/x') },
      ] },
      { name: 'batch', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'nuit', color: 'blue', buildable: true, lastBuild: build(5000, [{ _class: 'hudson.triggers.TimerTrigger$TimerTriggerCause' }], 'main') },
      ] },
      { name: 'archive', color: 'disabled', buildable: false },
    ];
    mock.state.details['/job/boutique/job/api-build'] = {
      name: 'api-build', color: 'blue', buildable: true, property: [], builds: [
        { number: 8, result: 'SUCCESS', building: false, timestamp: Date.now(), duration: 4000, url: '' },
      ],
    };
    mock.state.details['/job/boutique/job/deploy-prod'] = {
      name: 'deploy-prod', color: 'blue', buildable: true, builds: [],
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
    assert.equal(await page.locator('#jenkinsBox .jk-row').count(), 5,
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
      ['boutique/front-build', 'batch/nuit', 'boutique/api-build', 'boutique/deploy-prod', 'archive'],
      'du plus récent au plus ancien, et le jamais lancé à la fin');

    const meta = await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'api-build' }).first().locator('.jk-meta').textContent();
    assert.match(meta, /par Alice/, 'qui a lancé');
    assert.match(meta, /main/, 'sur quelle branche');
    assert.doesNotMatch(meta, /refs\/remotes/, '« refs/remotes/origin/main » est un détail d’implémentation');

    /* AVEC QUELS PARAMÈTRES le dernier lancement est parti — ils arrivent dans la même
       requête que la liste, donc les afficher ne coûte rien. */
    const dep = await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'deploy-prod' }).first().locator('.jk-meta');
    const texte = await dep.textContent();
    assert.match(texte, /ENV=prod/, 'les valeurs du dernier build sont là');
    assert.doesNotMatch(texte, /MDP=/, 'un paramètre de type mot de passe est écarté');
    assert.doesNotMatch(texte, /VIDE=/, 'une valeur vide n’apprend rien');
    assert.match(texte, /\+1/, 'au-delà de trois, le reste est compté et détaillé en infobulle');
    assert.match(await dep.getAttribute('title'), /DEBUG=/, 'l’infobulle porte la liste entière');

    // Un déclenchement automatique n'a pas d'auteur : on dit sa NATURE plutôt que rien.
    const auto = await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'nuit' }).first().locator('.jk-meta').textContent();
    assert.match(auto, /planificateur/);
  });

  test('la recherche et « ce qui ne va pas » filtrent la liste', async () => {
    await allerJenkins();
    await page.locator('#jenkinsSearch').fill('front');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    await page.locator('#jenkinsSearch').fill('');

    await page.locator('#jenkinsFailOnly').check();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 1);
    assert.match(await page.locator('#jenkinsBox .jk-row').first().textContent(), /front-build/,
      '« ce qui ne va pas » retient l’échec et l’instable, pas le vert');
    await page.locator('#jenkinsFailOnly').uncheck();
  });

  /* LE FILTRE PAR DOSSIERS. Il est mémorisé — sinon il faudrait le refaire à chaque
     ouverture, ce qui revient à ne pas l'avoir. Et il mémorise ce qu'on a DÉCOCHÉ : un
     dossier créé demain doit apparaître de lui-même, pas rester invisible pour toujours. */
  test('décocher un dossier masque ses jobs, et ça survit au rechargement', async () => {
    await allerJenkins();
    /* On attend le compte ATTENDU, pas un compte capturé : entre deux rendus la liste passe
       par un squelette à zéro ligne, et une valeur lue là est un piège silencieux. */
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(5);
    await page.waitForSelector('#jenkinsFolders:not([hidden])');

    await page.locator('[data-jkfolder="boutique"]').uncheck();
    await lignes(2);   // 5 jobs, dont 3 dans « boutique »
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
    await lignes(5);
  });

  /* MASQUER N'EST PAS DÉCOCHER. Décocher, c'est « pas maintenant » — la case reste sous la
     main. Masquer, c'est « ce dossier ne me concerne pas » : il sort de la liste des cases,
     qui redevient lisible. Ses jobs partent avec lui — le masquer en les laissant donnerait
     des jobs qu'on ne peut plus filtrer. Et on doit pouvoir le remettre, un par un. */
  test('un dossier se masque de la liste des filtres, et se remet', async () => {
    await allerJenkins();
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(5);
    // Trois entrées : « batch », « boutique », et la racine — un job hors dossier en est un aussi.
    assert.equal(await page.locator('#jenkinsFolderList [data-jkfolder]').count(), 3);

    await page.locator('[data-jkhide="batch"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsFolderList [data-jkfolder]').length === 2);
    await lignes(4);
    assert.equal(await page.locator('[data-jkfolder="batch"]').count(), 0, 'sa case quitte la liste');
    assert.equal(await page.locator('#jenkinsBox .jk-row').filter({ hasText: 'batch/' }).count(), 0,
      'ses jobs partent avec elle : sinon on aurait des jobs qu’on ne peut plus filtrer');

    // Ce qui est masqué reste VISIBLE en petit : un filtre invisible devient un mystère.
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');
    assert.match(await page.locator('#jenkinsFolderHidden').textContent(), /1 dossier masqué/);

    await page.reload();
    await allerJenkins();
    await lignes(4);
    assert.equal(await page.locator('[data-jkfolder="batch"]').count(), 0, 'le masquage est mémorisé');

    await page.locator('[data-jkshow="batch"]').click();
    await lignes(5);
    assert.equal(await page.locator('[data-jkfolder="batch"]').isChecked(), true, 'remis, et coché comme avant');
    assert.equal(await page.locator('#jenkinsFolderHidden').isHidden(), true, 'plus rien de masqué, plus de pied');
  });

  /* Un dossier DÉCOCHÉ puis masqué doit revenir DÉCOCHÉ : masquer range, ça ne décide pas à
     notre place de ce qu'on avait choisi de voir. */
  test('masquer ne perd pas l’état coché du dossier', async () => {
    await allerJenkins();
    const lignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#jenkinsBox .jk-row').length === k, n);
    await lignes(5);
    await page.locator('[data-jkfolder="batch"]').uncheck();
    await lignes(4);
    await page.locator('[data-jkhide="batch"]').click();
    await page.waitForSelector('#jenkinsFolderHidden:not([hidden])');
    await page.locator('[data-jkshow="batch"]').click();
    await page.waitForSelector('[data-jkfolder="batch"]');
    assert.equal(await page.locator('[data-jkfolder="batch"]').isChecked(), false,
      'masquer range la case, ça ne recoche pas à notre place');
    await page.locator('[data-jkfolder="batch"]').check();
    await lignes(5);
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
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 5);
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
