'use strict';
/* LE FRONT DÉCOUPÉ SE CHARGE ENTIER, ET CHAQUE ÉCRAN S'OUVRE SANS ERREUR.
 *
 * `public/` est rangé par écran et par couche : des scripts courts, chargés dans l'ordre du
 * MANIFESTE (la liste des `<script src>` d'`index.html`), une portée globale partagée. Deux
 * pannes deviennent alors possibles, et toutes deux silencieuses pour les tests fonctionnels
 * — qui échouent loin de la cause, sur un bouton qui ne répond plus :
 *   — un fichier oublié dans le manifeste (ajouté sans sa ligne, ou une ligne perdue dans une
 *     résolution de conflit) : son écran est muet, sans la moindre erreur ;
 *   — un `const` déclaré dans deux fichiers, ou appelé avant le fichier qui le déclare : une
 *     SyntaxError ou « Cannot access X before initialization » PENDANT l'évaluation, et tout ce
 *     qui suit dans le manifeste n'existe pas.
 *
 * Ce fichier les attrape en NOMMANT le fichier : il charge la page et vérifie que chaque
 * script et chaque feuille du manifeste a bien été chargé (une entrée de `performance` par
 * fichier, en 200), puis ouvre chaque onglet et chaque sous-onglet des réglages et des agents,
 * sans aucun `pageerror` ni erreur de console. Un `pageerror` de Playwright nomme
 * `ecrans/sessions/modale.js:120`, pas `app.js:8412`.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { manifeste } = require('./helpers/front');

const { dispo } = navigateurDispo();

describe('Front découpé — manifeste chargé entier, chaque écran s’ouvre sans erreur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let contexte; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    contexte = await navigateur.newContext({ viewport: { width: 1500, height: 1000 } });
    page = await contexte.newPage();
    // Tous les menus, y compris ceux repliés d'office : un écran caché ne s'exercerait pas.
    await afficherMenusOptionnels(page);
    page.on('pageerror', (e) => erreurs.push(`pageerror : ${e.message}`));
    /* Une ressource qui répond 404 ou 500 (un service absent sur ce poste) est une erreur de
       console aussi — mais du réseau, pas du script : ce n'est pas ce qu'on cherche ici. */
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erreurs.push(`console : ${m.text()}`);
    });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('chaque script et chaque feuille du manifeste est chargé, en 200', async () => {
    const { scripts, styles } = manifeste();
    assert.ok(scripts.length >= 1 && styles.length >= 1, 'le manifeste cite au moins un script et une feuille');
    /* Les entrées de `performance` pour les ressources de la page : le nom est l'URL entière,
       `responseStatus` le code HTTP (Chromium 109+ ; absent, on ne juge que la présence). */
    const charges = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((e) => ({ url: e.name, status: e.responseStatus })));
    const parChemin = new Map(charges.map((e) => [new URL(e.url).pathname, e]));
    const manquants = [];
    for (const f of [...scripts, ...styles]) {
      const e = parChemin.get(`/${f}`);
      if (!e) manquants.push(`/${f} : jamais demandé au serveur`);
      else if (e.status != null && e.status !== 200 && e.status !== 304) manquants.push(`/${f} : statut ${e.status}`);
    }
    assert.deepEqual(manquants, [], 'chaque fichier du manifeste est chargé');
    assert.deepEqual(erreurs, [], 'aucune erreur au chargement de la page');
  });

  test('chaque onglet, et chaque sous-onglet des réglages et des agents, s’ouvre sans erreur', async () => {
    const onglets = await page.$$eval('nav button[data-tab]', (bs) => bs.map((b) => b.dataset.tab));
    assert.ok(onglets.length >= 11, `onze onglets attendus, ${onglets.length} trouvés`);
    for (const tab of onglets) {
      await page.locator(`nav button[data-tab="${tab}"]`).click();
      await page.waitForSelector(`#tab-${tab}.active`);
      const sous = await page.$$eval(`#tab-${tab} .subnav [data-sub]`, (bs) => bs.map((b) => b.dataset.sub));
      for (const sub of sous) {
        await page.locator(`#tab-${tab} .subnav [data-sub="${sub}"]`).click();
        // Le sous-onglet s'active ; ce qu'il charge derrière part en promesse.
        await page.waitForSelector(`#tab-${tab} .subnav [data-sub="${sub}"].active`);
      }
    }
    // Laisser atterrir ce que les onglets ont lancé : une erreur asynchrone compte aussi.
    await page.waitForLoadState('networkidle');
    assert.deepEqual(erreurs, [], 'aucune erreur de script en ouvrant chaque écran');
  });
});
