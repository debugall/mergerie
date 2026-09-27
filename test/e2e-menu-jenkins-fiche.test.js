'use strict';
/* MENU « JENKINS » — LA FICHE D'UN JOB ET SA CONSOLE, CE QUE `e2e-jenkins-ui` NE PILOTAIT PAS.
 *
 * La fiche (`#jenkinsModal`) : sa description, le pré-remplissage « comme le dernier build
 * VERT » et son explication, ma dernière saisie qui l'emporte à la réouverture, le paramètre
 * booléen (case à cocher, envoyé `true`/`false`), un job sans paramètre qui se lance depuis sa
 * fiche après confirmation, un job désactivé sans bouton « Lancer », un job introuvable qui
 * affiche l'erreur, un filtre d'historique qui ne retient rien, la fin de console d'un build
 * rouge (copiée d'un clic), sa console vide, « Ajouter aux todos » sur une exécution, et la
 * fermeture par un clic au fond.
 *
 * La console (`#jenkinsLogModal`) : le journal tronqué qui le dit, « Enquêter » proposé sur
 * une trace — et seulement là — qui ouvre la session de l'enquêteur avec la fin du journal,
 * une console introuvable qui affiche l'erreur, et Échap qui la ferme.
 *
 * Déjà prouvés dans un navigateur (`e2e-jenkins-ui`) : ouvrir la fiche par le nom, le rendu
 * des listes à choix (et multiples), les valeurs calculées par Jenkins, le filtre d'historique
 * qui va chercher plus loin, reprendre / relancer une exécution, la valeur disparue des choix,
 * un paramètre dynamique en échec, lancer avec paramètres sans seconde confirmation, les deux
 * colonnes, les trois zones, la console qui replie ses lignes.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// L'enquêteur est un agent livré : son répertoire d'accueil ne doit pas être celui de la machine.
process.env.MERGERIE_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jenkins-fiche-home-'));

// eslint-disable-next-line import/order
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const mock = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

const valeurs = (liste) => liste.map(([name, value, cls = 'StringParameterValue']) => ({ name, value, _class: `hudson.model.${cls}` }));
const execution = (number, result, params, qui = 'Bruno') => ({
  number, result, building: false, timestamp: 1000 + number, duration: 7000,
  url: `http://jenkins.test/job/app/job/deploy/${number}/`,
  actions: [{ causes: [{ userName: qui }] }, { parameters: valeurs(params) }],
});

const TRACE = [
  '[INFO] Compilation…',
  'Exception in thread "main" java.lang.IllegalStateException: pool épuisé',
  '    at com.boutique.Pool.prendre(Pool.java:42)',
  'Finished: FAILURE',
].join('\n');

describe('Menu Jenkins — la fiche d’un job et sa console', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let srv; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    srv = await mock.start();
    mock.reset();
    const job = (name, color, extra = {}) => ({ name, color, buildable: color !== 'disabled', ...extra });
    mock.state.jobs = [{ name: 'app', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
      job('deploy', 'red', {
        property: [{ parameterDefinitions: [{ name: 'VERSION' }, { name: 'DRY' }, { name: 'ENV' }] }],
        lastBuild: { timestamp: 1005, number: 5, actions: [{ causes: [{ userName: 'Bruno' }] }] },
      }),
      job('simple', 'blue', { lastBuild: { timestamp: 900, number: 2, actions: [] } }),
      job('gele', 'disabled'),
      job('fantome', 'blue'),
    ] }];
    mock.state.details['/job/app/job/deploy'] = {
      name: 'deploy', color: 'red', buildable: true, description: 'Déploie la boutique sur un environnement.',
      property: [{ parameterDefinitions: [
        { name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '1.0' } },
        { name: 'DRY', type: 'BooleanParameterDefinition', defaultParameterValue: { value: true } },
        { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['recette', 'prod'], defaultParameterValue: { value: 'recette' } },
      ] }],
      // Le plus récent a ÉCHOUÉ ; le précédent, vert, porte d'autres valeurs.
      builds: [
        execution(5, 'FAILURE', [['VERSION', '2.0'], ['DRY', 'false', 'BooleanParameterValue'], ['ENV', 'prod']]),
        execution(4, 'SUCCESS', [['VERSION', '1.9'], ['DRY', 'true', 'BooleanParameterValue'], ['ENV', 'recette']]),
      ],
    };
    mock.state.details['/job/app/job/simple'] = {
      name: 'simple', color: 'blue', buildable: true, property: [],
      builds: [{ number: 2, result: 'SUCCESS', building: false, timestamp: 900, duration: 1000, url: '', actions: [] }],
    };
    mock.state.details['/job/app/job/gele'] = {
      name: 'gele', color: 'disabled', buildable: false, property: [],
      builds: [{ number: 1, result: 'ABORTED', building: false, timestamp: 800, duration: 1000, url: '', actions: [] }],
    };
    // « fantome » est dans la liste mais sa fiche répond 404 : un job supprimé entre-temps.
    mock.state.console['/job/app/job/deploy/5'] = TRACE;
    mock.state.console['/job/app/job/deploy/4'] = 'BUILD SUCCESS\nFinished: SUCCESS';
    mock.state.console['/job/app/job/gele/1'] = '';

    await app.configure({
      jenkins_url: srv.url, jenkins_user: mock.state.user, jenkins_token: mock.state.token,
      jenkins_refresh_minutes: '0',
    });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    // Presse-papiers en mémoire : aucune permission de navigateur à accorder.
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(String(t)); }, readText: async () => window.__copies.at(-1) || '' },
      });
    });
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (srv) await srv.close();
    if (app) await app.stop();
  });

  async function allerJenkins() {
    await page.locator('nav button[data-tab="jenkins"]').click();
    await page.waitForSelector('#tab-jenkins.active');
    await page.waitForFunction(() => document.querySelectorAll('#jenkinsBox .jk-row').length === 4);
  }
  /* Ouvre la fiche et attend qu'elle soit RENDUE (le squelette de l'appel la précède) : `pret`
     est un sélecteur que seule la fiche arrivée satisfait. */
  async function ouvrirFiche(chemin, pret = '#jenkinsFiche') {
    await page.locator(`#jenkinsBox [data-jkopen="${chemin}"]`).click();
    await page.waitForSelector('#jenkinsModal:not([hidden])');
    await page.waitForSelector(pret, { state: 'attached' });
  }
  async function deplier() {
    const repli = page.locator('#jenkinsModalBody details.jk-fiche-repli');
    if (await repli.count() && !await repli.evaluate((e) => e.open)) await repli.locator('> summary').click();
    await page.waitForSelector('#jenkinsFiche [data-jkbuild], #jenkinsFiche .jk-vide');
  }
  async function fermerFiche() {
    await page.locator('#jenkinsClose').click();
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
  }
  const posts = (depuis) => mock.state.calls.slice(depuis).filter((c) => c.method === 'POST');

  /* A34 — « COMME LE DERNIER RUN VERT ». Le dernier lancement a échoué : reproposer ses
     valeurs referait l'erreur. La fiche reprend donc celles du dernier build RÉUSSI, et le dit. */
  test('la fiche se pré-remplit avec le dernier build vert, et explique pourquoi', async () => {
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    assert.equal(await page.locator('#jenkinsModalTitle').textContent(), 'Lancer app/deploy', 'le titre porte le verbe');
    assert.equal(await page.locator('#jenkinsModalDesc').textContent(), 'Déploie la boutique sur un environnement.');
    assert.equal(await page.locator('#jenkinsRun').textContent(), 'Lancer avec ces paramètres');
    assert.equal(await page.locator('[data-jkparam="VERSION"]').inputValue(), '1.9', 'la VERSION du build #4, le vert');
    assert.equal(await page.locator('[data-jkparam="ENV"]').inputValue(), 'recette');
    assert.equal(await page.locator('[data-jkparam="DRY"]').isChecked(), true, 'un booléen se coche, il ne se tape pas');
    assert.match(await page.locator('.jk-param-intro').textContent(), /dernier build RÉUSSI \(#4\)/);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.jkparam), 'VERSION',
      'le focus est sur le premier paramètre, dans la fenêtre qui vient de s’ouvrir');
    await fermerFiche();
  });

  /* CE QU'ON VIENT DE LANCER SERA PROPOSÉ LA PROCHAINE FOIS : ma saisie passe avant l'historique.
     Et le booléen décoché part bien en `false` — pas absent, ce qui laisserait Jenkins prendre
     son défaut (`true`) et lancer « à blanc » ce qu'on voulait vraiment déployer. */
  test('lancer depuis la fiche envoie ce qui est saisi (booléen compris), et le repropose ensuite', async () => {
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await page.locator('[data-jkparam="VERSION"]').fill('3.0');
    await page.locator('[data-jkparam="DRY"]').click();
    await page.locator('[data-jkparam="ENV"]').selectOption('prod');
    const avant = mock.state.calls.length;
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
    await attendreServeur(() => posts(avant).some((c) => c.path.endsWith('/buildWithParameters')), 'Jenkins a reçu le lancement');
    assert.equal(posts(avant).find((c) => c.path.endsWith('/buildWithParameters')).body, 'VERSION=3.0&DRY=false&ENV=prod');

    const memo = await page.evaluate(() => JSON.parse(localStorage.getItem('aidevtools_jenkins_saisie') || '{}'));
    assert.deepEqual(memo['app/deploy'], [
      { name: 'VERSION', value: '3.0' }, { name: 'DRY', value: 'false' }, { name: 'ENV', value: 'prod' }]);

    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    assert.equal(await page.locator('[data-jkparam="VERSION"]').inputValue(), '3.0', 'ma dernière saisie l’emporte');
    assert.equal(await page.locator('[data-jkparam="DRY"]').isChecked(), false);
    assert.equal(await page.locator('[data-jkparam="ENV"]').inputValue(), 'prod');
    assert.doesNotMatch(await page.locator('.jk-param-intro').textContent(), /RÉUSSI/,
      'ce n’est plus le build vert qui est repris : l’explication n’a plus lieu d’être');

    // Et on recoche : `true` part aussi, explicitement.
    await page.locator('[data-jkparam="DRY"]').click();
    const avant2 = mock.state.calls.length;
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
    await attendreServeur(() => posts(avant2).some((c) => c.path.endsWith('/buildWithParameters')), 'second lancement reçu');
    assert.match(posts(avant2).find((c) => c.path.endsWith('/buildWithParameters')).body, /DRY=true/);
  });

  /* UN JOB SANS PARAMÈTRE : sa fiche EST l'historique (déplié), et « Lancer » depuis la fiche
     redemande confirmation — on n'y a rempli aucune valeur qui vaudrait décision. */
  test('un job sans paramètre se lance depuis sa fiche, après confirmation', async () => {
    await allerJenkins();
    await ouvrirFiche('app/simple', '#jenkinsFiche [data-jkbuild="2"]');
    assert.equal(await page.locator('#jenkinsModalBody details.jk-fiche-repli').count(), 0, 'rien à remplir : l’historique n’est pas replié');
    assert.equal(await page.locator('#jenkinsModalTitle').textContent(), 'app/simple');
    assert.equal(await page.locator('#jenkinsRun').textContent(), 'Lancer');

    const avant = mock.state.calls.length;
    await page.locator('#jenkinsRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /app\/simple/);
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
    await attendreServeur(() => posts(avant).some((c) => c.path === '/job/app/job/simple/build'), 'Jenkins a reçu /build');
    await page.locator('.toast', { hasText: '« app/simple » mis en file' }).first().waitFor();
  });

  test('un job désactivé n’offre pas « Lancer » dans sa fiche ; un job disparu affiche l’erreur', async () => {
    await allerJenkins();
    await ouvrirFiche('app/gele', '#jenkinsFiche [data-jkbuild="1"]');
    assert.equal(await page.locator('#jenkinsRun').isHidden(), true, 'Jenkins refuserait : le bouton n’est pas proposé');
    await fermerFiche();

    await page.locator('#jenkinsBox [data-jkjob="app/fantome"]').click();
    await page.waitForSelector('#jenkinsModal:not([hidden]) #jenkinsModalBody .errbox');
    assert.equal(await page.locator('#jenkinsRun').isHidden(), true, 'pas de lancement sur une fiche qu’on n’a pas pu lire');
    // Un clic au fond ferme la fiche (rien n'y est saisi).
    await page.mouse.click(5, 5);
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
  });

  /* LA FIN DE LA CONSOLE D'UN BUILD ROUGE, dans la fiche : l'erreur se lit sans ouvrir Jenkins,
     et se copie d'un clic pour la coller à un collègue. */
  test('un build rouge montre la fin de sa console, qui se copie d’un clic', async () => {
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();
    assert.equal(await page.locator('#jenkinsFiche .jk-build.selected [data-jkbuild]').getAttribute('data-jkbuild'), '5');
    await page.waitForFunction(() => /Pool\.java:42/.test((document.querySelector('[data-jk-tail="5"]') || {}).textContent || ''));
    const lien = page.locator('#jenkinsFiche .jk-col-detail h4 a[href="http://jenkins.test/job/app/job/deploy/5/"]');
    assert.ok(await lien.count() >= 1, 'le build s’ouvre dans Jenkins');

    await page.locator('[data-jk-tail-copy="5"]').click();
    await page.locator('.toast', { hasText: 'Console copiée.' }).first().waitFor();
    const copie = await page.evaluate(() => window.__copies.at(-1));
    assert.match(copie, /IllegalStateException: pool épuisé/);
    assert.match(copie, /Finished: FAILURE/);

    // Un build vert n'a pas de fin de console à montrer : c'est un rouge qu'on vient lire.
    await page.locator('[data-jkbuild="4"]').click();
    await page.waitForFunction(() => document.querySelector('#jenkinsFiche .jk-build.selected [data-jkbuild="4"]'));
    assert.equal(await page.locator('[data-jk-tail]').count(), 0);
    await fermerFiche();
  });

  test('une console vide le dit, au lieu d’un cadre muet', async () => {
    await allerJenkins();
    await ouvrirFiche('app/gele', '#jenkinsFiche [data-jkbuild="1"]');
    await page.waitForFunction(() => (document.querySelector('[data-jk-tail="1"]') || {}).textContent === '(console vide ou illisible)');
    await fermerFiche();
  });

  test('un filtre d’historique qui ne retient rien le dit', async () => {
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();
    await page.locator('#jenkinsFiche [data-jkff="ENV"]').fill('inexistant');
    await page.waitForFunction(() => /Aucune de ces exécutions ne correspond au filtre/.test(document.querySelector('#jenkinsFiche').textContent));
    assert.equal(await page.locator('#jenkinsFiche [data-jkbuild]').count(), 0);
    assert.match(await page.locator('#jenkinsFiche .jk-col-detail').textContent(), /Choisis une exécution/,
      'le détail de droite ne montre plus une exécution qu’on ne voit plus à gauche');
    await page.locator('#jenkinsFiche [data-jkff="ENV"]').fill('');
    await page.waitForSelector('#jenkinsFiche [data-jkbuild="5"]');
    await fermerFiche();
  });

  /* B16 — « ce build casse une fois sur trois » : la note se prend là où on le constate. La
     todo est créée au CLAVIER (Entrée dans le titre) : c'est un geste réel de l'écran, et il ne
     dépend pas de l'empilement des fenêtres, éprouvé à part juste en dessous. */
  test('« Ajouter aux todos » sur une exécution crée une todo liée à ce build', async (t) => {
    t.after(() => page.evaluate(() => {
      if (!document.querySelector('#captureModal').hidden) document.querySelector('#captureCancel').click();
      if (!document.querySelector('#jenkinsModal').hidden) document.querySelector('#jenkinsClose').click();
    }));
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();
    const ligne = page.locator('#jenkinsFiche .jk-build').filter({ has: page.locator('[data-jkbuild="5"]') });
    await ligne.locator('[data-add-todo="build"]').click();
    await page.locator('#captureModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#captureTitle').inputValue(), 'Build app/deploy #5');
    await page.locator('#captureTitle').press('Enter');
    await page.locator('#captureModal').waitFor({ state: 'hidden' });

    let todo;
    await attendreServeur(async () => {
      todo = (await app.api('GET', '/api/todos')).body.todos.find((x) => x.link_kind === 'build' && x.link_ref === 'app/deploy#5');
      return !!todo;
    }, 'la todo liée au build existe');
    assert.equal(todo.title, 'Build app/deploy #5');
    // Le bouton bascule : un second clic créerait le doublon que l'anti-doublon existe pour éviter.
    await page.waitForSelector('#jenkinsFiche .jk-build [data-see-todo]');
  });

  /* Ce que le point du milieu d'un bouton TOUCHE vraiment : l'élément lui-même, ou une fenêtre
     posée par-dessus. Deux `.modal` au même `z-index` s'empilent dans l'ordre du DOM. */
  const atteignable = (sel) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const dessus = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!dessus && (dessus === el || el.contains(dessus)), dessus: dessus ? (dessus.closest('.modal') || {}).id || dessus.tagName : null };
  });

  test('la fenêtre de capture d’une todo s’ouvre AU-DESSUS de la fiche', async (t) => {
    t.after(() => page.evaluate(() => {
      if (!document.querySelector('#captureModal').hidden) document.querySelector('#captureCancel').click();
      if (!document.querySelector('#jenkinsModal').hidden) document.querySelector('#jenkinsClose').click();
    }));
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();
    await page.locator('#jenkinsFiche .jk-build').filter({ has: page.locator('[data-jkbuild="4"]') })
      .locator('[data-add-todo="build"]').click();
    await page.locator('#captureModal').waitFor({ state: 'visible' });
    const r = await atteignable('#captureOk');
    assert.ok(r.ok, `« Créer » est recouvert par ${r.dessus}`);
  });

  /* LA CONSOLE : « Enquêter » n'est proposé que s'il y a une trace, et il part avec elle. */
  test('la console propose « Enquêter » sur une trace, et ouvre l’enquêteur avec la fin du journal', async (t) => {
    t.after(() => page.evaluate(() => {
      if (!document.querySelector('#taskModal').hidden) document.querySelector('#taskCancel').click();
      if (!document.querySelector('#jenkinsModal').hidden) document.querySelector('#jenkinsClose').click();
    }));
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();

    await page.locator('#jenkinsFiche [data-jklog="4"]').click();
    await page.waitForFunction(() => /BUILD SUCCESS/.test(document.querySelector('#jenkinsLogBody').textContent));
    assert.equal(await page.locator('#jenkinsLogTitle').textContent(), 'app/deploy #4');
    assert.equal(await page.locator('#jenkinsLogInvestigate').isHidden(), true, 'rien à enquêter sur un build vert');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#jenkinsLogModal', { state: 'hidden' });
    assert.equal(await page.locator('#jenkinsModal').isVisible(), true, 'Échap ferme la console, pas la fiche dessous');

    await page.locator('#jenkinsFiche [data-jklog="5"]').click();
    await page.waitForFunction(() => /Pool\.java/.test(document.querySelector('#jenkinsLogBody').textContent));
    await page.waitForSelector('#jenkinsLogInvestigate:not([hidden])');
    await page.locator('#jenkinsLogInvestigate').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => /app\/deploy/.test(document.querySelector('#taskPrompt').value));
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.match(prompt, /build #5/);
    assert.match(prompt, /Pool\.prendre\(Pool\.java:42\)/, 'la trace part avec la demande');
    assert.match(await page.locator('#taskAgentBox [data-combo="taskAgentVal"]').inputValue(), /Enquêteur/);
    assert.equal(await page.locator('#jenkinsLogModal').isHidden(), true, 'la console s’est effacée devant la session');
  });

  test('la session de l’enquêteur s’ouvre AU-DESSUS de la fiche restée ouverte', async (t) => {
    t.after(() => page.evaluate(() => {
      if (!document.querySelector('#taskModal').hidden) document.querySelector('#taskCancel').click();
      if (!document.querySelector('#jenkinsModal').hidden) document.querySelector('#jenkinsClose').click();
    }));
    await allerJenkins();
    await ouvrirFiche('app/deploy', '#jenkinsModal [data-jkparam="VERSION"]');
    await deplier();
    await page.locator('#jenkinsFiche [data-jklog="5"]').click();
    await page.waitForSelector('#jenkinsLogInvestigate:not([hidden])');
    await page.locator('#jenkinsLogInvestigate').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => /app\/deploy/.test(document.querySelector('#taskPrompt').value));
    const r = await atteignable('#taskCancel');
    assert.ok(r.ok, `« Annuler » de la session est recouvert par ${r.dessus}`);
  });

  test('une console tronquée le dit ; une console introuvable affiche l’erreur', async () => {
    mock.state.console['/job/app/job/simple/2'] = `${'bruit de compilation\n'.repeat(11000)}Finished: SUCCESS`;
    await allerJenkins();
    await ouvrirFiche('app/simple', '#jenkinsFiche [data-jklog="2"]');
    await page.locator('#jenkinsFiche [data-jklog="2"]').click();
    await page.waitForFunction(() => /Finished: SUCCESS/.test(document.querySelector('#jenkinsLogBody').textContent));
    assert.match(await page.locator('#jenkinsLogBody').textContent(), /^\(début du journal coupé — seule la fin est affichée\)/);
    await page.locator('#jenkinsLogClose').click();
    await page.waitForSelector('#jenkinsLogModal', { state: 'hidden' });

    delete mock.state.console['/job/app/job/simple/2'];
    await page.locator('#jenkinsFiche [data-jklog="2"]').click();
    await page.waitForSelector('#jenkinsLogModal:not([hidden])');
    await page.waitForFunction(() => {
      const t = document.querySelector('#jenkinsLogBody').textContent;
      return t && t !== '…' && !/Finished/.test(t);
    });
    assert.equal(await page.locator('#jenkinsLogInvestigate').isHidden(), true);
    await page.mouse.click(5, 5);
    await page.waitForSelector('#jenkinsLogModal', { state: 'hidden' });
    await fermerFiche();
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
