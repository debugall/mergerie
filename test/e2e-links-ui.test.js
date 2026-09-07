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
const { startApp, attendreServeur } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

/* Une attente d'écran généreuse. Ces suites tournent à plusieurs sur un runner CI de
   quatre cœurs : un délai calibré sur une machine de développement y échoue sans que rien
   ne soit cassé, et l'échec du premier test entraîne tous les suivants qui dépendent de
   son état. Mieux vaut attendre longtemps pour rien que rendre un rouge qui ne veut rien dire. */
const ATTENTE_ECRAN = 20000;

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
  // Sans grille à attendre : les deux derniers tests l'observent justement absente.
  const ouvrirVide = async () => {
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#linkGrid .empty');
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
    const champ = page.locator('.link-cell-panel .lce-url').first();
    await champ.waitFor();
    await champ.fill('https://api-preprod.demo.invalid/health');
    await champ.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 2);
    assert.equal(await page.locator('.link-add').count(), 0, 'la case n’est plus vide');

    // Échap referme sans rien poser : on doit pouvoir changer d'avis.
    const svc = (await app.api('GET', '/api/links/grid')).body.services[0];
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: svc.urls ? Object.keys(svc.urls)[1] : env.id, url: '' });
  });

  /* LES TAGS SONT DANS UN MENU, avec leur compte DÉTAILLÉ : « produit 3 » ne disait pas trois
     quoi — trois services, trois liens libres, ou deux et un. Le filtre porte sur les deux
     moitiés de l'écran, il doit dire ce qu'il va trouver de chaque côté. */
  test('le filtre par tag masque les services qui ne le portent pas', async () => {
    await ouvrirLiens();
    await page.locator('#linkTagBtn').click();
    assert.match(await page.locator('#linkTagMenu [data-linktag="confluence"]').innerText(), /1 lien/,
      'le compte dit de quel côté de l’écran le tag se trouve');
    await page.locator('#linkTagMenu [data-linktag="confluence"]').click();
    await page.waitForSelector('#linkGrid .link-grid-empty');
    /* Le message ne répète plus le filtre : il renvoie vers l'autre moitié de l'écran, où le
       lien tagué « confluence » se trouve bel et bien. Dire « rien ne correspond » au-dessus
       de résultats présents était un mensonge d'affichage. */
    assert.match(await page.locator('.link-grid-empty').innerText(), /liens libres/i, 'le vide dit où regarder');
    assert.ok(await page.locator('.link-free-row').count() >= 1);
    // Le filtre posé s'affiche en pastille à côté du champ, et se retire de là.
    await page.locator('#linkFilterChips [data-untag]').click();
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
    assert.equal(await page.locator('.sidebar button[data-tab]').count(), 10);

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
    const champ = page.locator('.link-cell-panel .lce-url').first();
    await champ.waitFor();
    assert.match(await champ.inputValue(), /^https?:\/\//, 'la ligne existante s’ouvre PRÉ-REMPLIE');
    /* …ET LE FOCUS N'EST PAS DESSUS. `focus()` puis `select()` sur la première URL d'une case
       remplie : on venait AJOUTER une adresse, on tapait, et on écrasait la première sans
       l'avoir vue partir. Le curseur arrive sur une ligne vide, ajoutée à la fin. */
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('lce-url')
      && document.activeElement.value === ''), true, 'le curseur est sur une ligne VIDE');

    await champ.fill('https://corrige.demo.invalid/x');
    await champ.press('Enter');
    /* La case affiche ce qui DISTINGUE l'adresse — le dernier segment du chemin —, pas son URL
       raccourcie : `corrige.demo.invalid/x` répéterait la colonne et la ligne écrites à côté. */
    await page.waitForFunction(() => {
      const c = document.querySelector('#linkGrid tbody tr td.link-cell .link-open');
      return c && c.textContent.trim() === 'x';
    });
    await attendreServeur(async () => (await app.api('GET', '/api/links/grid')).body.services
      .some((svc) => Object.values(svc.urls || {}).flat().some((u) => /corrige\.demo/.test(u.url))),
    'l’adresse corrigée est enregistrée');

    // Tout vider efface la case : c'est ce que le guide promet, et c'est le geste naturel.
    await cell().hover();
    await cell().locator('.link-edit').click();
    await page.locator('.link-cell-panel .lce-url').first().fill('');
    await page.locator('.link-cell-panel .lce-url').first().press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-add').length > 0);

    // …et on doit pouvoir changer d'avis sans rien écrire.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell-panel .lce-url').first().fill('https://jamais.demo.invalid');
    await page.locator('.link-cell-panel .lce-url').first().press('Escape');
    // Échap referme l'édition : c'est cet effet-là qui dit que le geste a été pris en compte.
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
    assert.doesNotMatch(await page.locator('#linkGrid').innerText(), /jamais\.demo/);

    // On rend le décor tel qu'on l'a trouvé : les tests de ce fichier se suivent.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell-panel .lce-url').first().fill('https://api-dev.demo.invalid/health');
    await page.locator('.link-cell-panel .lce-url').first().press('Enter');
    // La case dit « health », pas l'URL : c'est le dernier segment du chemin qu'on y lit.
    await page.waitForFunction(() => {
      const c = document.querySelector('#linkGrid tbody tr td.link-cell .link-open');
      return c && c.textContent.trim() === 'health';
    });
  });

  /* Une recherche pour les DEUX moitiés de l'écran. Deux champs obligeaient à choisir où
     chercher avant de savoir où était la réponse — et le message « rien ne correspond »
     s'affichait au-dessus de résultats bien présents, plus bas. */
  /* LE NOM DE CHAQUE ADRESSE COMPTE, autant que l'URL : c'est « erreurs paiement » qu'on a en
     tête, pas le domaine. Et sous une recherche, la case montre tout — laisser l'adresse trouvée
     derrière un « +7 » obligerait à déplier pour voir ce qu'on vient de chercher. */
  test('la recherche trouve une adresse par son nom, et la montre', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    await app.api('PUT', `/api/services/${g.services[0].id}/urls`, {
      environment_id: env.id,
      urls: [
        { label: 'erreurs paiement', url: 'https://k1.demo.invalid/a' },
        { label: 'latence API', url: 'https://k2.demo.invalid/b' },
        { label: 'journal complet', url: 'https://k3.demo.invalid/c' },
        { label: 'webhooks rejetés', url: 'https://k4.demo.invalid/d' },
        { label: 'lenteurs base', url: 'https://k5.demo.invalid/e' },
        { label: 'erreurs 5xx', url: 'https://k6.demo.invalid/f' },
      ],
    });
    await page.reload();
    await ouvrirLiens();
    assert.ok(await page.locator('.link-more-addr').count() > 0, 'au repos, la case en cache une partie');

    await page.locator('#linkSearch').fill('webhooks');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    /* LA CASE NE MONTRE QUE CE QUI CORRESPOND : afficher les six adresses pour une seule trouvée
       obligerait à relire la case au lieu de lire la réponse. */
    assert.deepEqual(await page.locator('#linkGrid .link-open').allInnerTexts(), ['webhooks rejetés']);

    /* « nom-du-service adresse » : un mot vient de la ligne, l'autre de l'adresse. Exiger que
       chaque mot tienne dans l'adresse seule ne rendrait jamais rien. */
    const nom = (await app.api('GET', '/api/links/grid')).body.services.find((x) => x.id === g.services[0].id).name;
    await page.locator('#linkSearch').fill(`${nom} latence`);
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 1);
    assert.deepEqual(await page.locator('#linkGrid .link-open').allInnerTexts(), ['latence API']);

    /* Chercher la ligne elle-même laisse passer toutes ses adresses — mais la CASE en montre
       toujours trois au plus : c'est ce qui borne la hauteur d'une ligne de grille, quoi qu'on
       cherche. Le reste s'ouvre dans le panneau. */
    await page.locator('#linkSearch').fill(nom);
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 3);
    assert.match(await page.locator('#linkGrid .link-more-addr').first().innerText(), /6/,
      'et le bouton dit combien il en reste');

    // L'URL compte aussi : on cherche parfois par le domaine qu'on a en tête.
    await page.locator('#linkSearch').fill('k5.demo');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    await page.locator('#linkSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-more-addr').length > 0);
  });

  test('une seule recherche filtre la grille et les liens libres', async () => {
    await ouvrirLiens();
    await page.locator('#linkSearch').fill('api-core');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    assert.equal(await page.locator('.link-free-row').count(), 0);

    await page.locator('#linkSearch').fill('confluence');
    await page.waitForSelector('#linkGrid .link-grid-empty');
    assert.match(await page.locator('.link-grid-empty').innerText(), /liens libres/i,
      'le message renvoie vers l’autre moitié de l’écran au lieu de dire « rien »');
    assert.ok(await page.locator('.link-free-row').count() >= 1, '…où les résultats sont bien là');
    await page.locator('#linkSearch').fill('');
    await page.waitForSelector('#linkGrid .link-grid');
  });

  /* LA COCHE EST LÀ, MAIS ELLE NE SE VOIT QU'AU SURVOL. Un mode « Sélectionner » à activer
     d'abord faisait payer chaque jour le prix d'un geste rare ; toujours visible, elle ajoutait
     une colonne de cases à un écran qui sert d'abord à lire. */
  test('la coche d’un lien libre apparaît au survol, et le compte suit', async () => {
    await ouvrirLiens();
    /* On ÉLOIGNE LE POINTEUR avant de regarder le repos : Playwright le laisse où le test
       précédent l'a posé, et une ligne survolée par accident rendrait « au repos » faux. */
    await page.mouse.move(0, 0);
    const ligne = page.locator('#linkFreeList .link-free-row').first();
    await page.waitForFunction(() => {
      const c = document.querySelector('#linkFreeList .lfr-pick');
      return c && getComputedStyle(c).opacity === '0';
    });
    assert.equal(await ligne.locator('.lfr-pick').evaluate((e) => getComputedStyle(e).opacity), '0',
      'au repos, la coche ne coûte rien');
    assert.equal(await page.locator('#linkToService').isHidden(), true);
    await ligne.hover();
    await page.waitForFunction(() => {
      const c = document.querySelector('#linkFreeList .lfr-pick');
      return c && getComputedStyle(c).opacity === '1';
    });
    await ligne.locator('.lfr-pick').click();
    await page.waitForFunction(() => !document.querySelector('#linkToService').hidden);
    // Le compte est SUR le bouton, et il suit la coche — il ne rattrapait qu'au rendu suivant.
    assert.match(await page.locator('#linkToService').innerText(), /1/);
    await page.locator('#linkFreeList .lfr-pick:checked').click();
    await page.waitForFunction(() => document.querySelector('#linkToService').hidden);
  });

  /* Après un import, ranger se fait par paquets : on tamise (« confluence »), on coche tout ce
     qui reste, on range. Cocher deux cents lignes à la main est exactement ce qui fait renoncer. */
  test('« tout sélectionner » porte sur les liens filtrés, et le filtre défait la sélection', async () => {
    await ouvrirLiens();
    await app.api('POST', '/api/free-links', { label: 'Confluence — archi', url: 'https://c2.demo.invalid/a', tags: 'confluence' });
    await page.reload();
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="select"]').click();
    await page.waitForSelector('#linkFreeAll:not([hidden])');

    await page.locator('#linkSearch').fill('confluence');
    await page.waitForFunction(() => document.querySelectorAll('.link-free-row').length === 2);
    await page.locator('#linkFreeAll').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input:checked').length === 2);
    // Le compte est SUR le bouton : « ranger » sans dire combien se fait à l'aveugle.
    assert.match(await page.locator('#linkToService').innerText(), /2/);

    /* CE QU'ON VOIT EST CE SUR QUOI ON AGIT : un lien coché puis filtré hors de vue partirait
       avec les autres au moment de ranger, sans que rien ne l'ait annoncé. */
    await page.locator('#linkSearch').fill('sso');
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input:checked').length === 0);
    assert.equal(await page.locator('#linkToService').isHidden(), true);

    await page.locator('#linkSearch').fill('');
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="select"]').click();
  });

  /* L'ordre des colonnes ne se corrigeait pas, et l'en-tête était cliquable sans que rien
     ne le dise. Les boutons n'apparaissent qu'au survol : calme au repos, complet de près. */
  test('une colonne se déplace depuis son en-tête', async () => {
    await ouvrirLiens();
    const cols = async () => (await page.locator('.link-grid thead th').allInnerTexts()).slice(1).map((t) => t.trim().split('\n')[0]);
    const avant = await cols();
    /* LE NOM EST LE BOUTON. Régler ou supprimer une colonne se cachait derrière une roue dentée
       qui n'apparaissait qu'au survol : la fonction existait, personne ne la trouvait. */
    await page.locator('.link-grid thead th').nth(1).locator('.link-env-name').click();
    await page.waitForSelector('#envModal:not([hidden])');
    assert.equal(await page.locator('#envDelete').isVisible(), true, 'et supprimer est proposé là');
    await page.locator('#envCancel').click();

    const th = page.locator('.link-grid thead th').nth(2);
    await th.hover();
    await th.locator('[data-dir="-1"]').click();
    /* On attend l'état COMPLET attendu, pas « quelque chose a changé » : le tableau passe par
       un instant vide pendant sa réécriture, et `c[0] !== a[0]` y est déjà vrai — l'attente
       rendait la main sur une grille sans colonne, ce qui ne se voit que sous charge. */
    await page.waitForFunction((a) => {
      const c = [...document.querySelectorAll('.link-grid thead th')].slice(1).map((e) => e.textContent.trim().split('\n')[0]);
      return c.length === a.length && c[0] === a[1] && c[1] === a[0];
    }, avant);
    const apres = await cols();
    assert.deepEqual([apres[0], apres[1]], [avant[1], avant[0]], 'les deux premières colonnes ont échangé');
    /* On rend le décor tel qu'on l'a trouvé — et on attend que ce soit fait : le test suivant
       lit ces colonnes, et les retrouver à moitié échangées lui donnerait tort pour rien. */
    await page.locator('.link-grid thead th').nth(1).hover();
    await page.locator('.link-grid thead th').nth(1).locator('[data-dir="1"]').click();
    await page.waitForFunction((a) => {
      const c = [...document.querySelectorAll('.link-grid thead th')].slice(1).map((e) => e.textContent.trim().split('\n')[0]);
      return c[0] === a[0] && c[1] === a[1];
    }, avant);
  });

  /* PLUSIEURS ADRESSES DANS UNE CASE. Un Kibana de production, ce sont autant d'adresses que
     de filtres enregistrés. Dépliées SUR PLACE, cinquante d'entre elles faisaient une ligne de
     sept cents pixels : le nom du service flottait au milieu d'un vide et la section des liens
     libres partait sous l'écran. La case en montre trois et ouvre le reste dans un panneau. */
  test('une case chargée montre trois adresses, et ouvre le reste dans un panneau', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    await app.api('PUT', `/api/services/${g.services[0].id}/urls`, {
      environment_id: env.id,
      urls: [
        { label: 'erreurs paiement', url: 'https://kib.demo.invalid/?q=paiement' },
        { label: 'latence API', url: 'https://kib.demo.invalid/?q=latence' },
        { label: 'journal complet', url: 'https://kib.demo.invalid/all' },
        { label: 'erreurs 5xx', url: 'https://kib.demo.invalid/?q=5xx' },
        { label: 'webhooks rejetés', url: 'https://kib.demo.invalid/?q=webhook' },
        { label: 'lenteurs base', url: 'https://kib.demo.invalid/?q=slow' },
      ],
    });
    await page.reload();
    await ouvrirLiens();
    const cell = page.locator('.link-grid tbody tr').first().locator('td.link-cell').first();
    assert.equal(await cell.locator('.link-open').count(), 3, 'trois au plus, toujours');
    assert.match(await cell.innerText(), /erreurs paiement/, 'le nom prime sur l’URL');

    /* LA HAUTEUR D'UNE LIGNE NE DÉPEND PLUS DE SON CONTENU : c'est tout l'intérêt, et c'est ce
       qu'il faut mesurer. Une ligne chargée reste comparable à une ligne à une seule adresse. */
    const hauteurs = await page.locator('#linkGrid tr.link-grid-row')
      .evaluateAll((rs) => rs.map((r) => Math.round(r.getBoundingClientRect().height)));
    assert.ok(Math.max(...hauteurs) < 200, `une ligne monte à ${Math.max(...hauteurs)}px`);

    // `▸ 6 adresses` ouvre la liste, ancrée sur la case, SANS bouger la grille.
    const avant = await page.locator('#linkGrid .link-grid').evaluate((e) => Math.round(e.getBoundingClientRect().height));
    await cell.locator('.link-more-addr').click();
    await page.waitForSelector('.link-cell-panel');
    assert.equal(await page.locator('.lcp-row').count(), 6, 'le panneau montre TOUT');
    assert.equal(await page.locator('#linkGrid .link-grid').evaluate((e) => Math.round(e.getBoundingClientRect().height)), avant,
      'la grille ne bouge pas sous les doigts');
    // Un point marque les trois que la case montre : pas un tri caché, une explication.
    assert.equal(await page.locator('.lcp-dot.on').count(), 3);

    // Le tamis filtre DANS le panneau — cinquante adresses se réduisent à une en trois lettres.
    await page.locator('.lcp-search').fill('lat');
    await page.waitForFunction(() => [...document.querySelectorAll('.lcp-row')].filter((r) => !r.hidden).length === 1);
    assert.match(await page.locator('.lcp-row:not([hidden])').innerText(), /latence API/);
    await page.locator('.lcp-search').fill('');

    // `✎ Modifier` bascule la MÊME liste en édition.
    await page.locator('.lcp-edit').click();
    await page.waitForSelector('.link-cell-panel.en-edition');
    assert.equal(await page.locator('.lce-row').count(), 7, 'six adresses, plus la ligne vide où écrire');
    // Les flèches réordonnent : « supprimer puis ressaisir » n'était pas un ordre, c'était une perte.
    await page.locator('.lce-row').nth(1).locator('.lce-up').click();
    assert.equal(await page.locator('.lce-row').first().locator('.lce-label').inputValue(), 'latence API');
    await page.locator('.lce-row').nth(5).locator('.lce-del').click();
    await page.locator('.lce-save').click();
    await page.waitForFunction(() => !/lenteurs base/.test(document.querySelector('#linkGrid').textContent));
    const liste = (await app.api('GET', '/api/links/grid')).body.services
      .find((x) => x.id === g.services[0].id).urls[env.id];
    assert.equal(liste.length, 5, 'la ligne retirée est partie');
    assert.equal(liste[0].label, 'latence API', 'et l’ordre posé est celui qu’on a enregistré');
  });

  /* COLLER PLUSIEURS ADRESSES D'UN COUP. Ajouter trois adresses à la même case demandait sept
     clics et deux écrans : ouvrir, ajouter une ligne, coller, ajouter une ligne, coller… */
  test('le panneau colle plusieurs adresses d’un coup', async () => {
    await ouvrirLiens();
    const cell = page.locator('.link-grid tbody tr').first().locator('td.link-cell').first();
    await cell.hover();
    await cell.locator('.link-edit').click();
    await page.waitForSelector('.link-cell-panel.en-edition');
    const avant = await page.locator('.lce-row').count();
    await page.locator('.lcp-multi-on').click();
    await page.locator('.lcp-paste').fill('https://p1.demo.invalid/alpha\nhttps://p2.demo.invalid/beta');
    await page.locator('.lcp-paste-add').click();
    await page.waitForFunction((n) => document.querySelectorAll('.lce-row').length === n, avant + 1);
    /* LE NOM SE PROPOSE DEPUIS LE CHEMIN : c'est ce qui distingue une adresse d'une autre au
       même endroit. L'hôte, lui, est le même pour toutes. */
    const noms = await page.locator('.lce-label').evaluateAll((els) => els.map((e) => e.value));
    assert.ok(noms.includes('alpha') && noms.includes('beta'), `noms proposés : ${noms.join(', ')}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
  });

  /* DES FILTRES À UNE SEULE SÉMANTIQUE. Une pastille d'environnement masquait des colonnes ET
     les lignes sans adresse dedans : filtrer sur la prod pour repérer les trous de prod était
     donc impossible — c'étaient exactement les lignes qui disparaissaient. */
  test('un interrupteur masque une colonne, jamais une ligne', async () => {
    const autre = (await app.api('POST', '/api/services', { name: 'zeta-front' })).body;
    await app.api('PUT', `/api/services/${autre.id}/urls`, { environment_id: env.id, url: 'https://zeta.demo.invalid' });
    await page.reload();
    await ouvrirLiens();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 2);
    const cols = () => page.locator('.link-grid thead th.link-col').count();
    const toutes = await cols();
    assert.ok(toutes >= 2);

    // On masque la colonne qui porte TOUTES les adresses : les lignes doivent rester.
    await page.locator(`#linkCols [data-linkenv="${env.id}"]`).click();
    await page.waitForFunction((n) => document.querySelectorAll('.link-grid thead th.link-col').length === n, toutes - 1);
    assert.equal(await page.locator('#linkGrid tbody tr').count(), 2,
      'les lignes restent : c’est ainsi qu’on voit les trous d’un environnement');

    /* L'ancien comportement reste atteignable — mais il se DEMANDE, il ne surprend plus. */
    await page.locator('#linkHideEmpty').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    assert.match(await page.locator('#linkGrid tbody tr').innerText(), /rien|match|correspond/i);

    // …et le choix survit au rechargement : on le repose sinon chaque matin.
    await page.reload();
    await ouvrirLiens();
    assert.equal(await cols(), toutes - 1, 'le filtre est encore posé');
    await page.locator('#linkClearFilters').click();
    await page.waitForFunction((n) => document.querySelectorAll('.link-grid thead th.link-col').length === n, toutes);
    assert.equal(await page.locator('#linkClearFilters').isHidden(), true,
      'plus de filtre actif, plus de bouton pour les relâcher');

    await app.api('DELETE', `/api/services/${autre.id}`);
  });

  /* LA LIGNE EST BORNÉE, QUOI QU'ELLE PORTE. Le seuil se jugeait « sur la ligne » : sous cinq
     adresses tout s'affichait, au-delà on retombait à deux et un `+N` de 11 px dépliait sur
     place. Le résultat dépendait donc du contenu, ce qui est exactement ce qu'on ne veut pas. */
  test('une case en montre trois, jamais plus, et le dit', async () => {
    const svc = (await app.api('POST', '/api/services', { name: 'petite-ligne' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, {
      environment_id: env.id,
      urls: [{ label: 'un', url: 'https://u1.demo.invalid' }, { label: 'deux', url: 'https://u2.demo.invalid' },
        { label: 'trois', url: 'https://u3.demo.invalid' }],
    });
    await page.reload();
    await ouvrirLiens();

    const petite = page.locator('.link-grid tbody tr').filter({ hasText: 'petite-ligne' });
    assert.equal(await petite.locator('.link-open').count(), 3, 'trois adresses tiennent entièrement');
    assert.equal(await petite.locator('.link-more-addr').count(), 0, '…et sans bouton à cliquer');

    // La quatrième bascule la case dans le panneau, et le bouton NOMME ce qu'il ouvre.
    await app.api('PUT', `/api/services/${svc.id}/urls`, {
      environment_id: env.id,
      urls: [{ label: 'un', url: 'https://u1.demo.invalid' }, { label: 'deux', url: 'https://u2.demo.invalid' },
        { label: 'trois', url: 'https://u3.demo.invalid' }, { label: 'quatre', url: 'https://u4.demo.invalid' }],
    });
    await page.reload();
    await ouvrirLiens();
    assert.equal(await petite.locator('.link-open').count(), 3);
    assert.match(await petite.locator('.link-more-addr').innerText(), /4/);

    await app.api('DELETE', `/api/services/${svc.id}`);
  });

  /* Le groupement par dossier donne une STRUCTURE. Le PREMIER NIVEAU seulement est ouvert :
     tout déplier à cinq niveaux redonne la liste plate qu'on cherchait à quitter, tout replier
     oblige à ouvrir dix dossiers pour retrouver un lien. Deux boutons disent explicitement
     « tout » ou « rien », et recliquer sur celui qui est actif revient au défaut. */
  test('le premier niveau est ouvert, les deux boutons font le reste', async () => {
    /* Le groupement se fait sur le DOSSIER, pas sur les tags : c'est ce qui rend l'arbre du
       navigateur, profondeur comprise. Sans dossier, un lien reste à la racine — à plat. */
    for (let i = 1; i <= 14; i += 1) {
      await app.api('POST', '/api/free-links', {
        label: `Lien ${i}`, url: `https://l${i}.demo.invalid`, folder: i % 3 === 0 ? 'alpha' : (i % 3 === 1 ? 'beta/dedans' : 'beta/autre'),
      });
    }
    await page.reload();
    await ouvrirLiens();
    await page.waitForSelector('.link-free-group');
    const groupes = await page.locator('.link-free-group').count();
    assert.ok(groupes >= 2, 'au-delà d’une douzaine, la liste se groupe');
    assert.equal(await page.locator('.link-free-group .link-free-group').count(), 2,
      'et la profondeur est rendue : « beta » contient « dedans » et « autre »');
    const niveau1 = await page.locator('#linkFreeList > .link-free-group').count();
    assert.equal(await page.locator('#linkFreeList > .link-free-group[open]').count(), niveau1,
      'le premier niveau est ouvert');
    assert.ok(await page.locator('.link-free-group[open]').count() < groupes,
      '…et pas les niveaux du dessous');

    await page.locator('#linkFreeExpand').click();
    await page.waitForFunction((n) => document.querySelectorAll('.link-free-group[open]').length === n, groupes);
    await page.locator('#linkFreeFold').click();
    await page.waitForFunction(() => document.querySelectorAll('.link-free-group[open]').length === 0);

    // Le choix est retenu d'une visite à l'autre.
    await page.reload();
    await ouvrirLiens();
    assert.equal(await page.locator('.link-free-group[open]').count(), 0, 'le pliage survit au rechargement');

    // Recliquer sur le bouton actif revient au défaut : sinon on n'y retournerait plus.
    await page.locator('#linkFreeFold').click();
    await page.waitForFunction((n) => document.querySelectorAll('#linkFreeList > .link-free-group[open]').length === n, niveau1);

    for (const l of (await app.api('GET', '/api/links/grid')).body.free_links) {
      if (/^Lien \d+$/.test(l.label)) await app.api('DELETE', `/api/free-links/${l.id}`);
    }
  });

  /* LE GESTE D'APRÈS L'IMPORT : deux cents adresses à plat, qu'il faut classer. Depuis la
     ligne d'un lien, sans passer par le mode sélection — c'est le cas courant, un à la fois. */
  test('un lien libre se range dans un service existant, en gardant son nom', async () => {
    /* Un libellé QU'AUCUN AUTRE ÉCRAN NE PORTE DÉJÀ : le test précédent a posé une adresse
       nommée « erreurs paiement » dans la grille, et attendre ce texte-là aurait été attendre
       une condition déjà vraie — l'assertion suivante serait passée avant la requête. */
    await app.api('POST', '/api/free-links', { label: 'runbook astreinte', url: 'https://run.demo.invalid/x' });
    await page.reload();
    await ouvrirLiens();

    await page.locator('.link-free-row').filter({ hasText: 'runbook astreinte' }).locator('[data-filefree]').click();
    await page.waitForSelector('#toServiceModal:not([hidden])');

    // Par défaut on crée : le nom est pré-rempli avec celui du lien.
    assert.equal(await page.locator('#toServiceNameRow').isHidden(), false);
    // …et le sélecteur a sa RECHERCHE, comme partout où une liste peut être longue.
    await page.locator('#toServiceBox .cb-search').click();
    await page.locator('#toServiceBox .cb-search').fill('api');
    await page.waitForFunction(() => document.querySelector('#toServiceBox .combo-options')
      && !document.querySelector('#toServiceBox .combo-options').hidden);
    await page.locator('#toServiceBox .combo-options div').first().click();
    await page.waitForFunction(() => document.querySelector('#toServiceNameRow').hidden,
      null, { timeout: ATTENTE_ECRAN });

    await page.locator('#toServiceOk').click();
    /* On attend la DISPARITION du lien libre, pas son apparition dans la grille : la case en
       montre deux au repos, et une troisième adresse se cache derrière le « +N ». */
    await page.waitForFunction(() => !/runbook astreinte/.test(document.querySelector('#linkFreeList').textContent));

    const cellules = (await app.api('GET', '/api/links/grid')).body.services
      .flatMap((svc) => Object.values(svc.urls || {}).flat());
    assert.ok(cellules.some((u) => u.label === 'runbook astreinte' && u.url === 'https://run.demo.invalid/x'),
      'le lien est devenu une adresse NOMMÉE dans une case — son libellé est ce qui la distingue');
  });

  /* RANGER UN LIEN À LA CRÉATION. Choisir dans une liste interdirait de créer un dossier ; un
     champ nu obligerait à retaper un chemin qu'on a déjà. Le champ propose l'existant et accepte
     le nouveau — et une barre oblique crée le sous-dossier au passage. */
  test('un lien libre se range dans un dossier, existant ou nouveau', async () => {
    await app.api('POST', '/api/free-links', { label: 'Runbook', url: 'https://run1.demo.invalid', folder: 'doc/astreinte' });
    await page.reload();
    await ouvrirLiens();

    /* La modale d'un lien libre s'ouvre par le CRAYON de sa ligne : c'est la seule porte depuis
       que l'ajout passe par « Coller une adresse ». La liste se groupe dès qu'un dossier
       existe, et seul le premier niveau est ouvert : on déplie avant de viser. */
    if (await page.locator('#linkFreeExpand').isVisible()) {
      await page.locator('#linkFreeExpand').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.link-free-group')].every((d) => d.open));
    }
    await page.locator('.link-free-row').filter({ hasText: 'Runbook' }).locator('[data-editfree]').click();
    await page.waitForSelector('#freeLinkModal:not([hidden])');
    const proposes = await page.locator('#freeFolders option').evaluateAll((els) => els.map((e) => e.value));
    assert.ok(proposes.includes('doc'), 'les niveaux INTERMÉDIAIRES sont proposés, pas seulement les feuilles');
    assert.ok(proposes.includes('doc/astreinte'));

    await page.locator('#freeLabel').fill('Nouveau');
    await page.locator('#freeUrl').fill('https://run2.demo.invalid');
    await page.locator('#freeFolder').fill('doc/astreinte/2026');
    await page.locator('#freeSave').click();
    await attendreServeur(async () => (await app.api('GET', '/api/links/grid')).body.free_links
      .some((x) => x.label === 'Nouveau'), 'le lien est enregistré');

    const l = (await app.api('GET', '/api/links/grid')).body.free_links.find((x) => x.label === 'Nouveau');
    assert.equal(l.folder, 'doc/astreinte/2026', 'le sous-sous-dossier est créé au passage');
  });

  /* AJOUTER, C'EST COLLER. Le menu demandait de CLASSER avant de coller — un lien simple, un
     service, un environnement — alors que ce qu'on a en main, neuf fois sur dix, c'est une URL
     dans le presse-papiers. Ce qui se vérifie ici n'est pas que la proposition soit juste, mais
     qu'elle ne DÉCIDE rien : elle arrive dans un sélecteur qu'on peut changer, et ce qui n'a pas
     d'environnement reconnu tombe en lien libre plutôt que dans une colonne « probable ». */
  test('coller une adresse propose son rangement, et le pose', async () => {
    await ouvrirLiens();
    const nomEnv = env.name;
    await page.locator('#linkPaste').click();
    await page.waitForSelector('#pasteModal:not([hidden])');
    await page.locator('#pasteText').fill(
      `https://petite-ligne-${nomEnv}.demo.invalid/sante\nhttps://wiki-maison.demo.invalid/page`);
    await page.waitForFunction(() => document.querySelectorAll('#pasteRows .paste-row').length === 2);

    const lignes = await page.locator('#pasteRows .paste-row').evaluateAll((rs) => rs.map((r) => ({
      cible: r.dataset.target, nom: r.querySelector('.pr-label').value,
    })));
    assert.equal(lignes[0].cible, 'cell', 'l’hôte cite un environnement connu : il va dans la grille');
    assert.equal(lignes[0].nom, 'sante', 'le nom vient du dernier segment du chemin');
    assert.equal(lignes[1].cible, 'free',
      'aucun environnement dans l’hôte : lien libre, jamais une colonne « probable »');

    await page.locator('#pasteOk').click();
    await attendreServeur(async () => (await app.api('GET', '/api/links/grid')).body.free_links
      .some((l) => l.url === 'https://wiki-maison.demo.invalid/page'), 'le lien libre est posé');
    const g = (await app.api('GET', '/api/links/grid')).body;
    const cellules = g.services.flatMap((svc) => Object.values(svc.urls || {}).flat());
    assert.ok(cellules.some((u) => u.label === 'sante'), 'et l’adresse est dans une case');
    // Le service n'existait pas : il a été créé au passage, sans qu'on ait eu à le poser avant.
    assert.ok(g.services.some((svc) => svc.name === 'petite-ligne'), 'le service proposé est créé');
    await page.waitForFunction(() => document.querySelector('#pasteModal').hidden);
  });

  /* L'IMPORT NE DÉVERSE PLUS TOUT. Deux cents favoris cochés d'office entraient d'un clic ;
     on passait ensuite la journée à trier une liste plate. */
  test('l’aperçu d’import est replié, et rien n’est coché', async () => {
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="import"]').click();
    await page.waitForSelector('#importModal:not([hidden])');
    await page.locator('#importFile').setInputFiles({
      name: 'favoris.html',
      mimeType: 'text/html',
      buffer: Buffer.from(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
        <DT><H3>Barre de favoris</H3><DL><p>
          <DT><H3>Recettes</H3><DL><p>
            <DT><A HREF="https://r1.demo.invalid/">R1</A>
            <DT><A HREF="https://r2.demo.invalid/">R2</A>
          </DL><p>
        </DL><p></DL><p>`),
    });
    await page.waitForSelector('.import-folder-box');
    assert.equal(await page.locator('#importTree [data-imp]:checked').count(), 0,
      'rien n’est coché : on choisit ce qui entre');
    assert.equal(await page.locator('#importApply').isDisabled(), true);

    // La case d'un dossier prend tout son contenu.
    await page.locator('.imp-folder').first().check();
    await page.waitForFunction(() => document.querySelectorAll('#importTree [data-imp]:checked').length === 2);
    await page.locator('#importApply').click();
    await page.waitForSelector('#importModal[hidden]', { state: 'attached' });

    /* Le tag racine n'est PAS créé : « barre-de-favoris » se retrouverait sur chaque lien, et
       un filtre présent partout ne filtre rien. */
    const tags = await page.locator('#linkTagMenu').evaluate((e) => e.textContent);
    assert.match(tags, /recettes/);
    assert.doesNotMatch(tags, /barre-de-favoris/);
  });

  /* LES DEUX ÉCRANS VIDES. En avant-dernier, parce que ce test DÉTRUIT le décor : il vide la
     grille pour l'observer vide. Tout ce qui précède a déjà eu ce dont il avait besoin.

     Le défaut qu'il garde : après un import de marque-pages, l'écran répondait « aucun lien
     pour l'instant » AU-DESSUS des liens qu'on venait d'importer, en proposant de les importer
     une seconde fois. La grille ne regardait que les services et les environnements. */
  test('grille vide avec des liens libres : le message ne dit plus « aucun lien »', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    for (const s of g.services) await app.api('DELETE', `/api/services/${s.id}`);
    for (const e of g.environments) await app.api('DELETE', `/api/environments/${e.id}`);
    assert.ok(g.free_links.length >= 1, 'il reste bien des liens libres à montrer');

    await page.reload();
    await ouvrirVide();
    assert.equal(await page.locator('#linkGrid [data-empty-act="import"]').count(), 0,
      'ne pas proposer d’importer ce qui vient de l’être');
    assert.match(await page.locator('#linkGrid .empty').innerText(), /grille|grid/i,
      'le message parle de la GRILLE, pas d’une absence de liens');
    assert.ok(await page.locator('.link-free-row').count() >= 1, '…et les liens sont bien là, en dessous');
  });

  test('rien du tout : on propose le chemin le plus court, l’import', async () => {
    for (const l of (await app.api('GET', '/api/links/grid')).body.free_links) {
      await app.api('DELETE', `/api/free-links/${l.id}`);
    }
    await page.reload();
    await ouvrirVide();
    assert.equal(await page.locator('#linkGrid [data-empty-act="import"]').count(), 1,
      'là, et seulement là, l’import est le raccourci vers un outil utile');
  });

  /* EN DERNIER, volontairement : à ce stade tous les écrans de l'onglet ont été traversés. */
  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });


  /* CE QUE LE SYSTÈME DESSINE POUR NOUS. La liste OUVERTE d'un `<select>` n'est pas notre
     élément : c'est l'OS qui la peint, et sans `color-scheme` il la peint toujours en clair —
     texte clair sur fond blanc en thème sombre, illisible, et que des couleurs sur `option`
     ne rattrapent pas (macOS les ignore). Ça ne se relit pas dans la feuille de style : on
     demande au navigateur ce qu'il a retenu. */
  test('les contrôles natifs suivent le thème', async () => {
    for (const [theme, attendu] of [['dark', 'dark'], ['light', 'light']]) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), attendu,
        `thème ${theme} : sans ça, une liste déroulante ouverte est illisible`);
    }
  });
});

