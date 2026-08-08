'use strict';
/* Liens et sidebar dans un VRAI navigateur.
 *
 * Trois choses ne se prouvent que là : la SIDEBAR (compaction, persistance, badges), la
 * PALETTE ancrée sous son champ et pilotée au clavier, et la GRILLE — dont l'ajout d'une
 * URL se fait DANS la case, ce qui est tout l'intérêt par rapport à une modale.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Liens · grille, palette et sidebar', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let env;
  /* Une erreur JavaScript ne fait PAS échouer un test : l'app la rattrape et l'affiche en
     toast, l'écran reste utilisable, et la suite passe au vert. C'est arrivé — un appel resté
     à une fonction supprimée. On collecte donc, et on exige le silence à la fin. */
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    env = (await app.api('POST', '/api/environments', { name: 'dev', color: '#2f6fe0' })).body;
    await app.api('POST', '/api/environments', { name: 'preprod', color: '#a16207' });
    const svc = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: env.id, url: 'https://api-dev.demo.invalid/health' });
    await app.api('POST', '/api/free-links', { label: 'Confluence — specs', url: 'https://confluence.demo.invalid/x', tags: 'confluence,doc' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirLiens = async () => {
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#linkGrid .link-grid');
  };

  test('la grille montre un service par ligne et un environnement par colonne', async () => {
    await ouvrirLiens();
    const colonnes = await page.locator('.link-grid thead th').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(colonnes.slice(1), ['dev', 'preprod'], 'les colonnes suivent l’ordre des environnements');
    assert.match(await page.locator('.link-grid tbody tr').first().innerText(), /api-core/);
    // Le lien s'ouvre AILLEURS, et sans donner la main sur la page qui l'ouvre.
    const a = page.locator('.link-open').first();
    assert.equal(await a.getAttribute('target'), '_blank');
    assert.match(await a.getAttribute('rel'), /noopener/);
    assert.equal(await page.locator('.link-add').count(), 1, 'la case vide propose un +');
  });

  /* Coller une URL doit coûter un clic : le champ remplace le `+` DANS la case. Une modale
     pour une adresse aurait coûté trois clics et un aller-retour du regard. */
  test('une URL s’ajoute dans la case, sans modale', async () => {
    await ouvrirLiens();
    await page.locator('.link-add').first().click();
    const champ = page.locator('.link-cell input[data-urlfor]');
    await champ.waitFor();
    await champ.fill('https://api-preprod.demo.invalid/health');
    await champ.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 2);
    assert.equal(await page.locator('.link-add').count(), 0, 'la case n’est plus vide');

    // Échap referme sans rien poser : on doit pouvoir changer d'avis.
    const svc = (await app.api('GET', '/api/links/grid')).body.services[0];
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: svc.urls ? Object.keys(svc.urls)[1] : env.id, url: '' });
  });

  test('le filtre par tag masque les services qui ne le portent pas', async () => {
    await ouvrirLiens();
    await page.locator('.link-tag', { hasText: 'confluence' }).click();
    await page.waitForFunction(() => !document.querySelector('#linkGrid .link-grid'));
    /* Le message ne répète plus le filtre : il renvoie vers l'autre moitié de l'écran, où le
       lien tagué « confluence » se trouve bel et bien. Dire « rien ne correspond » au-dessus
       de résultats présents était un mensonge d'affichage. */
    assert.match(await page.locator('#linkGrid').innerText(), /liens libres/i, 'le vide dit où regarder');
    assert.ok(await page.locator('.link-free-row').count() >= 1);
    await page.locator('.link-tag.active').click();          // on relâche le filtre
    await page.waitForSelector('#linkGrid .link-grid');
  });

  /* La palette s'ancre SOUS son champ : c'est de là qu'on l'ouvre, l'œil y est déjà.
     Centrée au milieu de l'écran, elle obligeait à le déplacer. */
  test('la palette s’ouvre sous le champ de l’en-tête, et se pilote au clavier', async () => {
    await page.locator('#paletteTrigger').click();
    await page.waitForSelector('#paletteModal:not([hidden])');
    const geo = await page.evaluate(() => {
      const t = document.querySelector('#paletteTrigger').getBoundingClientRect();
      const b = document.querySelector('.palette-box').getBoundingClientRect();
      return { sous: b.top >= t.bottom, aligne: Math.abs(b.left - t.left) < 60 };
    });
    assert.equal(geo.sous, true, 'la boîte est SOUS le champ, pas au milieu de l’écran');
    assert.equal(geo.aligne, true, '…et alignée sur lui');

    await page.locator('#paletteInput').fill('api dev');
    await page.waitForFunction(() => /api-core/.test(document.querySelector('#paletteList').textContent));
    assert.match(await page.locator('.palette-item').first().innerText(), /api-core · dev/,
      'la case de la grille remonte en tête');

    // ↓ déplace la sélection, Échap referme sans rien ouvrir.
    await page.locator('#paletteInput').press('ArrowDown');
    await page.locator('#paletteInput').press('Escape');
    await page.waitForSelector('#paletteModal[hidden]', { state: 'attached' });
  });

  test('la touche « o » ouvre la palette, et pas quand on écrit', async () => {
    await page.locator('body').click();
    await page.keyboard.press('o');
    await page.waitForSelector('#paletteModal:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#paletteModal[hidden]', { state: 'attached' });

    await ouvrirLiens();
    await page.locator('#linkSearch').fill('');
    await page.locator('#linkSearch').press('o');
    assert.equal(await page.locator('#paletteModal').isHidden(), true,
      'un « o » tapé dans une recherche est une lettre, pas un raccourci');
    assert.equal(await page.locator('#linkSearch').inputValue(), 'o');
    await page.locator('#linkSearch').fill('');
  });

  /* La sidebar : neuf entrées, un bouton de compaction, un choix qui survit au rechargement.
     Compacte, les libellés sont MASQUÉS et non retirés — le `title` continue de dire où l'on
     va, et les lecteurs d'écran aussi. */
  test('la sidebar se compacte, et s’en souvient', async () => {
    await page.reload();
    await page.waitForSelector('.sidebar button[data-tab]');
    assert.equal(await page.locator('.sidebar button[data-tab]').count(), 9);

    const largeur = () => page.locator('#sidebar').evaluate((e) => e.getBoundingClientRect().width);
    const avant = await largeur();
    await page.locator('#sidebarToggle').click();
    await page.waitForFunction((w) => document.querySelector('#sidebar').getBoundingClientRect().width < w, avant);
    assert.equal(await page.locator('.sidebar button[data-tab] span:not([class])').first().isVisible(), false,
      'les libellés sont masqués');
    assert.ok(await page.locator('nav button[data-tab="links"]').getAttribute('title'),
      '…mais le titre dit toujours où mène l’entrée');

    await page.reload();
    await page.waitForSelector('.sidebar button[data-tab]');
    assert.ok(await largeur() < avant, 'le choix survit au rechargement');
    await page.locator('#sidebarToggle').click();               // on remet en large
    await page.waitForFunction((w) => document.querySelector('#sidebar').getBoundingClientRect().width >= w, avant);
  });

  /* Le bouton de repli est lui aussi un `nav button`. Tant que le gestionnaire d'onglets ne
     filtrait pas sur `[data-tab]`, le replier désactivait TOUS les onglets : l'écran devenait
     blanc, et « undefined » partait dans le dernier onglet mémorisé — le rechargement suivant
     n'affichait rien non plus. Un défaut invisible en lisant le code, criant à l'écran. */
  test('replier la colonne ne vide pas l’écran', async () => {
    await page.reload();
    await page.waitForSelector('.sidebar button[data-tab]');
    await page.locator('nav button[data-tab="dashboard"]').click();
    await page.waitForSelector('#tab-dashboard.active');

    await page.locator('#sidebarToggle').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width < 120);

    assert.equal(await page.locator('#tab-dashboard').isVisible(), true,
      'l’onglet actif reste affiché après le repli');
    assert.equal(await page.evaluate(() => (document.querySelector('.tab.active') || {}).id), 'tab-dashboard');
    assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_tab')), 'dashboard',
      'et le dernier onglet mémorisé reste un vrai onglet');

    // …y compris au rechargement, qui est là que le « undefined » se voyait vraiment.
    await page.reload();
    await page.waitForSelector('.sidebar button[data-tab]');
    assert.equal(await page.evaluate(() => (document.querySelector('.tab.active') || {}).id), 'tab-dashboard');
    await page.locator('#sidebarToggle').click();               // on remet en large
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width >= 120);
  });

  /* LE DÉFAUT LE PLUS GRAVE DE L'ONGLET. Une case remplie n'offrait aucun chemin de retour :
     pour corriger une faute de frappe il fallait supprimer le service — donc perdre ses autres
     URLs et ses liens contextuels — puis tout ressaisir. Le guide promettait pourtant que vider
     le champ efface la case ; la promesse était inatteignable depuis l'écran. */
  test('une case remplie se corrige, se vide, et Échap n’écrit rien', async () => {
    await ouvrirLiens();
    const cell = () => page.locator('.link-grid tbody tr').first().locator('td.link-cell').first();
    await cell().hover();
    await cell().locator('.link-edit').click();
    const champ = page.locator('.link-cell input[data-urlfor]');
    await champ.waitFor();
    assert.match(await champ.inputValue(), /^https?:\/\//, 'le champ s’ouvre PRÉ-REMPLI, pas vide');

    await champ.fill('https://corrige.demo.invalid/x');
    await champ.press('Enter');
    await page.waitForFunction(() => /corrige\.demo/.test(document.querySelector('#linkGrid').textContent));

    // Le champ vidé efface la case : c'est ce que le guide promet, et c'est le geste naturel.
    await cell().hover();
    await cell().locator('.link-edit').click();
    await page.locator('.link-cell input[data-urlfor]').fill('');
    await page.locator('.link-cell input[data-urlfor]').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-add').length > 0);

    // …et on doit pouvoir changer d'avis sans rien écrire.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell input[data-urlfor]').fill('https://jamais.demo.invalid');
    await page.locator('.link-cell input[data-urlfor]').press('Escape');
    await page.waitForTimeout(200);
    assert.doesNotMatch(await page.locator('#linkGrid').innerText(), /jamais\.demo/);

    // On rend le décor tel qu'on l'a trouvé : les tests de ce fichier se suivent.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell input[data-urlfor]').fill('https://api-dev.demo.invalid/health');
    await page.locator('.link-cell input[data-urlfor]').press('Enter');
    await page.waitForFunction(() => /api-dev\.demo/.test(document.querySelector('#linkGrid').textContent));
  });

  /* Une recherche pour les DEUX moitiés de l'écran. Deux champs obligeaient à choisir où
     chercher avant de savoir où était la réponse — et le message « rien ne correspond »
     s'affichait au-dessus de résultats bien présents, plus bas. */
  test('une seule recherche filtre la grille et les liens libres', async () => {
    await ouvrirLiens();
    await page.locator('#linkSearch').fill('api-core');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    assert.equal(await page.locator('.link-free-row').count(), 0);

    await page.locator('#linkSearch').fill('confluence');
    await page.waitForFunction(() => !document.querySelector('#linkGrid .link-grid'));
    assert.match(await page.locator('#linkGrid').innerText(), /liens libres/i,
      'le message renvoie vers l’autre moitié de l’écran au lieu de dire « rien »');
    assert.ok(await page.locator('.link-free-row').count() >= 1, '…où les résultats sont bien là');
    await page.locator('#linkSearch').fill('');
    await page.waitForSelector('#linkGrid .link-grid');
  });

  // Les cases à cocher ne servent qu'à une action rare : elles ne coûtent plus rien au repos.
  test('les cases à cocher n’apparaissent qu’en mode sélection', async () => {
    await ouvrirLiens();
    assert.equal(await page.locator('#linkFreeList input[type=checkbox]').count(), 0);
    await page.locator('#linkFreeSelect').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input[type=checkbox]').length > 0);
    await page.locator('#linkFreeList input[type=checkbox]').first().check();
    assert.equal(await page.locator('#linkToService').isVisible(), true);
    await page.locator('#linkFreeSelect').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input[type=checkbox]').length === 0);
    assert.equal(await page.locator('#linkToService').isHidden(), true, 'sortir du mode oublie la sélection');
  });

  /* L'ordre des colonnes ne se corrigeait pas, et l'en-tête était cliquable sans que rien
     ne le dise. Les boutons n'apparaissent qu'au survol : calme au repos, complet de près. */
  test('une colonne se déplace depuis son en-tête', async () => {
    await ouvrirLiens();
    const cols = async () => (await page.locator('.link-grid thead th').allInnerTexts()).slice(1).map((t) => t.trim().split('\n')[0]);
    const avant = await cols();
    const th = page.locator('.link-grid thead th').nth(2);
    await th.hover();
    await th.locator('[data-dir="-1"]').click();
    await page.waitForFunction((a) => {
      const c = [...document.querySelectorAll('.link-grid thead th')].slice(1).map((e) => e.textContent.trim().split('\n')[0]);
      return c[0] !== a[0];
    }, avant);
    const apres = await cols();
    assert.deepEqual([apres[0], apres[1]], [avant[1], avant[0]], 'les deux premières colonnes ont échangé');
    await page.locator('.link-grid thead th').nth(1).hover();
    await page.locator('.link-grid thead th').nth(1).locator('[data-dir="1"]').click();
    await page.waitForTimeout(600);
  });

  /* EN DERNIER, volontairement : à ce stade tous les écrans de l'onglet ont été traversés. */
  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });

});
