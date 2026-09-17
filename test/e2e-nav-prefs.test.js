'use strict';
/* RANGER LA BARRE DE MENUS : ordre et visibilité.
 *
 * Onze onglets, et chacun n'en utilise que quelques-uns. Le geste attendu tient en deux choses :
 * remonter ce qu'on ouvre dix fois par jour, et faire disparaître ce dont on ne se sert pas.
 *
 * Ce qui se joue ici :
 *
 *   0. la barre ne porte D'OFFICE que le travail de tous les jours : Git, Docker, Jenkins et
 *      Liens démarrent repliés, et une case des Réglages les rend — sans rien désactiver ;
 *
 *   1. l'ordre et le masquage s'appliquent À LA BARRE, tout de suite, et survivent au
 *      rechargement — une préférence qu'il faut reposer à chaque visite n'en est pas une ;
 *   2. « Réglages » ne se masque PAS : c'est le chemin du retour, et l'écran qui permettrait
 *      de revenir en arrière serait justement celui qu'on vient de faire disparaître ;
 *   3. un menu masqué quitte aussi la palette et les raccourcis chiffrés — sinon on ouvre un
 *      écran dont l'entrée de menu n'existe plus, sans moyen évident d'en sortir ;
 *   4. l'onglet courant qu'on masque ne laisse pas l'écran ouvert derrière lui.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

describe('Réglages · ordre et visibilité des menus', { skip: navigateurDispo().dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const barre = () => page.locator('nav button[data-tab]:not([hidden])')
    .evaluateAll((els) => els.map((e) => e.dataset.tab));
  // Tous les onglets du fichier, repliés compris : ce que les Réglages doivent lister.
  const tousLesOnglets = () => page.locator('nav button[data-tab]')
    .evaluateAll((els) => els.map((e) => e.dataset.tab));
  const REPLIES_DOFFICE = ['git', 'docker', 'jenkins', 'links'];
  const ouvrirReglages = async () => {
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="config"]').click();
    await page.waitForSelector('#navPrefs .nav-prefs-row');
  };
  const remettreAZero = async () => {
    await page.evaluate(() => localStorage.removeItem('mergerie_nav'));
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
  };

  test('la liste des Réglages reprend TOUS les menus, dans leur ordre', async () => {
    await remettreAZero();
    await ouvrirReglages();
    const lignes = await page.locator('#navPrefs .nav-prefs-row')
      .evaluateAll((els) => els.map((e) => e.dataset.navtab));
    /* La liste porte aussi les menus repliés — c'est par elle qu'on les rend. Comparer à la
       barre VISIBLE reviendrait à exiger qu'un menu replié disparaisse aussi des Réglages,
       c'est-à-dire qu'on ne puisse plus jamais le rappeler. */
    assert.deepEqual(lignes, await tousLesOnglets(), 'une ligne par menu, dans le même ordre');
  });

  /* LE DÉFAUT. Une barre de onze entrées se lit moins bien qu'une barre de sept : Git, Docker,
     Jenkins et Liens sont des commodités — on y va le jour où on en a besoin. Elles démarrent
     donc repliées. Rien n'est désactivé pour autant : la ligne est dans les Réglages, décochée,
     et une case suffit. */
  test('Git, Docker, Jenkins et Liens sont repliés d’office, et une case les rend', async () => {
    await remettreAZero();
    const visibles = await barre();
    for (const t of REPLIES_DOFFICE) {
      assert.ok(!visibles.includes(t), `« ${t} » n’est pas dans la barre au premier lancement`);
    }
    assert.ok(visibles.includes('review') && visibles.includes('task') && visibles.includes('notes')
      && visibles.includes('jira') && visibles.includes('agents') && visibles.includes('admin'),
    `le travail de tous les jours, lui, est là : ${visibles.join(', ')}`);

    await ouvrirReglages();
    for (const t of REPLIES_DOFFICE) {
      assert.equal(await page.locator(`.nav-prefs-row[data-navtab="${t}"] .nav-show`).isChecked(), false,
        `« ${t} » est listé, décoché : on peut le rappeler`);
    }
    await page.locator('.nav-prefs-row[data-navtab="docker"] .nav-show').check();
    await page.waitForFunction(() => !!document.querySelector('nav button[data-tab="docker"]:not([hidden])'));
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.ok((await barre()).includes('docker'), 'et ce choix-là tient au rechargement');
  });

  test('monter un menu le déplace dans la barre, et ça survit au rechargement', async () => {
    await remettreAZero();
    await ouvrirReglages();
    const avant = await barre();
    const cible = avant[avant.length - 3];           // un onglet du bas, à remonter
    const i = avant.indexOf(cible);

    await page.locator(`[data-navup="${cible}"]`).click();
    await page.waitForFunction(({ t, n }) => {
      const b = [...document.querySelectorAll('nav button[data-tab]:not([hidden])')].map((e) => e.dataset.tab);
      return b[n] === t;
    }, { t: cible, n: i - 1 });

    const apres = await barre();
    assert.equal(apres[i - 1], cible, 'il est monté d’un cran');
    assert.equal(apres.length, avant.length, 'et personne n’a disparu au passage');

    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.deepEqual(await barre(), apres, 'l’ordre choisi est retrouvé au rechargement');
  });

  test('masquer un menu le retire de la barre, et le rendre le ramène à sa place', async () => {
    await remettreAZero();
    await ouvrirReglages();
    const avant = await barre();

    await page.locator('.nav-prefs-row[data-navtab="jira"] .nav-show').uncheck();
    await page.waitForFunction(() => !document.querySelector('nav button[data-tab="jira"]:not([hidden])'));
    assert.ok(!(await barre()).includes('jira'));

    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.ok(!(await barre()).includes('jira'), 'le masquage tient au rechargement');

    await ouvrirReglages();
    assert.equal(await page.locator('.nav-prefs-row[data-navtab="jira"]').count(), 1,
      'il reste dans les Réglages — sinon on ne pourrait plus le rendre');
    await page.locator('.nav-prefs-row[data-navtab="jira"] .nav-show').check();
    await page.waitForFunction(() => !!document.querySelector('nav button[data-tab="jira"]:not([hidden])'));
    assert.deepEqual(await barre(), avant, 'il revient à sa place d’origine');
  });

  /* Masquer « Réglages » enfermerait dehors : l'écran qui permet de le rendre est justement
     celui qu'on aurait fait disparaître. */
  test('« Réglages » ne peut pas être masqué', async () => {
    await remettreAZero();
    await ouvrirReglages();
    const c = page.locator('.nav-prefs-row[data-navtab="admin"] .nav-show');
    assert.equal(await c.isDisabled(), true);
    assert.equal(await c.isChecked(), true);
    // …et même en forçant la préférence à la main, la barre le garde.
    await page.evaluate(() => localStorage.setItem('mergerie_nav', JSON.stringify({ ordre: [], masques: ['admin'] })));
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.ok((await barre()).includes('admin'), 'le chemin du retour ne se perd pas');
  });

  test('un menu masqué quitte la palette et les raccourcis chiffrés', async () => {
    await remettreAZero();
    await ouvrirReglages();
    await page.locator('.nav-prefs-row[data-navtab="jira"] .nav-show').uncheck();
    await page.waitForFunction(() => !document.querySelector('nav button[data-tab="jira"]:not([hidden])'));

    // La palette ne le propose plus.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#paletteModal:not([hidden])');
    await page.locator('#paletteModal input').fill('jira');
    await page.waitForFunction(() => !document.querySelector('#paletteModal .palette-item.loading'));
    const propositions = await page.locator('#paletteModal .palette-item').allTextContents();
    assert.ok(!propositions.some((x) => /jira/i.test(x)),
      `la palette n’offre plus l’onglet masqué : ${propositions.join(' | ')}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#paletteModal[hidden]', { state: 'attached' });
    /* Le curseur est resté dans le champ de la palette : les raccourcis globaux s'effacent
       devant une saisie (c'est voulu), donc on rend le focus à la page avant de taper. */
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    /* Les chiffres suivent la barre VISIBLE : « 6 » ouvre le sixième menu affiché, pas le
       sixième du fichier — sinon un menu masqué garderait un raccourci vers nulle part. */
    const visibles = await barre();
    await page.keyboard.press('6');
    await page.waitForFunction((t) => document.querySelector(`nav button[data-tab="${t}"]`).classList.contains('active'), visibles[5]);
    assert.equal(await page.locator('nav button[data-tab].active').getAttribute('data-tab'), visibles[5]);
  });

  test('masquer l’onglet ouvert bascule sur un autre', async () => {
    await remettreAZero();
    // Un menu AFFICHÉ d'office : c'est le fait de le masquer qui est éprouvé ici.
    await page.locator('nav button[data-tab="notes"]').click();
    await ouvrirReglages();                       // on quitte Notes pour aller dans Réglages…
    await page.evaluate(() => document.querySelector('nav button[data-tab="notes"]').click());
    await page.waitForFunction(() => document.querySelector('nav button[data-tab="notes"]').classList.contains('active'));

    // …puis on le masque depuis la palette de réglages restée en mémoire : la barre doit réagir.
    await page.evaluate(() => {
      localStorage.setItem('mergerie_nav', JSON.stringify({ ordre: [], masques: ['notes'] }));
    });
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.ok(!(await barre()).includes('notes'));
    const actif = await page.locator('nav button[data-tab].active').getAttribute('data-tab');
    assert.notEqual(actif, 'notes', 'on n’atterrit pas sur un onglet dont le menu a disparu');
    assert.deepEqual(erreurs, []);
  });

  /* « Rétablir » rend l'état DU DÉPART, repliés compris — et non « tout afficher ». Écrire une
     liste de masqués vide aurait déplié les quatre commodités à qui demandait seulement de
     défaire son rangement : ce n'est pas l'origine, c'est l'inverse. */
  test('« Rétablir les menus d’origine » rend la barre du départ, repliés compris', async () => {
    await remettreAZero();
    const origine = await barre();
    await ouvrirReglages();
    await page.locator('[data-navup="dashboard"]').click();
    // On dérange dans les deux sens : un menu qu'on rend, un menu qu'on replie.
    await page.locator('.nav-prefs-row[data-navtab="docker"] .nav-show').check();
    await page.locator('.nav-prefs-row[data-navtab="jira"] .nav-show').uncheck();
    await page.waitForFunction(() => {
      const v = [...document.querySelectorAll('nav button[data-tab]:not([hidden])')].map((e) => e.dataset.tab);
      return v.includes('docker') && !v.includes('jira');
    });

    await page.locator('#navPrefsReset').click();
    await page.waitForFunction((o) => {
      const v = [...document.querySelectorAll('nav button[data-tab]:not([hidden])')].map((e) => e.dataset.tab);
      return v.join(',') === o.join(',');
    }, origine);
    assert.deepEqual(await barre(), origine, 'Docker est reparti se replier, Jira est revenu, l’ordre aussi');
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    assert.deepEqual(await barre(), origine, 'et ça tient au rechargement');
  });
});
