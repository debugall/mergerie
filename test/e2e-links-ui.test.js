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
    const champ = page.locator('.link-cell-edit .lce-url');
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
    await page.locator('#linkTags .link-tag', { hasText: 'confluence' }).click();
    await page.waitForSelector('#linkGrid .link-grid-empty');
    /* Le message ne répète plus le filtre : il renvoie vers l'autre moitié de l'écran, où le
       lien tagué « confluence » se trouve bel et bien. Dire « rien ne correspond » au-dessus
       de résultats présents était un mensonge d'affichage. */
    assert.match(await page.locator('.link-grid-empty').innerText(), /liens libres/i, 'le vide dit où regarder');
    assert.ok(await page.locator('.link-free-row').count() >= 1);
    await page.locator('#linkTags .link-tag.active').click();   // on relâche le filtre — CELUI DES TAGS
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
    const champ = page.locator('.link-cell-edit .lce-url');
    await champ.waitFor();
    assert.match(await champ.inputValue(), /^https?:\/\//, 'le champ s’ouvre PRÉ-REMPLI, pas vide');

    await champ.fill('https://corrige.demo.invalid/x');
    await champ.press('Enter');
    await page.waitForFunction(() => /corrige\.demo/.test(document.querySelector('#linkGrid').textContent));

    // Tout vider efface la case : c'est ce que le guide promet, et c'est le geste naturel.
    await cell().hover();
    await cell().locator('.link-edit').click();
    await page.locator('.link-cell-edit .lce-url').fill('');
    await page.locator('.link-cell-edit .lce-url').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-add').length > 0);

    // …et on doit pouvoir changer d'avis sans rien écrire.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell-edit .lce-url').fill('https://jamais.demo.invalid');
    await page.locator('.link-cell-edit .lce-url').press('Escape');
    await page.waitForTimeout(200);
    assert.doesNotMatch(await page.locator('#linkGrid').innerText(), /jamais\.demo/);

    // On rend le décor tel qu'on l'a trouvé : les tests de ce fichier se suivent.
    await cell().locator('.link-add').click();
    await page.locator('.link-cell-edit .lce-url').fill('https://api-dev.demo.invalid/health');
    await page.locator('.link-cell-edit .lce-url').press('Enter');
    await page.waitForFunction(() => /api-dev\.demo/.test(document.querySelector('#linkGrid').textContent));
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
    assert.ok(await page.locator('.link-plus').count() > 0, 'au repos, la case en cache une partie');

    await page.locator('#linkSearch').fill('webhooks');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    /* LA CASE NE MONTRE QUE CE QUI CORRESPOND : afficher les six adresses pour une seule trouvée
       obligerait à relire la case au lieu de lire la réponse. */
    assert.deepEqual(await page.locator('#linkGrid .link-open').allInnerTexts(), ['webhooks rejetés']);
    assert.equal(await page.locator('.link-plus').count(), 0,
      'et aucun bouton inerte : le dépliage vient de la recherche, pas d’un clic');

    /* « nom-du-service adresse » : un mot vient de la ligne, l'autre de l'adresse. Exiger que
       chaque mot tienne dans l'adresse seule ne rendrait jamais rien. */
    const nom = (await app.api('GET', '/api/links/grid')).body.services.find((x) => x.id === g.services[0].id).name;
    await page.locator('#linkSearch').fill(`${nom} latence`);
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 1);
    assert.deepEqual(await page.locator('#linkGrid .link-open').allInnerTexts(), ['latence API']);

    // Chercher la ligne elle-même, en revanche, laisse passer toutes ses adresses.
    await page.locator('#linkSearch').fill(nom);
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-open').length === 6);

    // L'URL compte aussi : on cherche parfois par le domaine qu'on a en tête.
    await page.locator('#linkSearch').fill('k5.demo');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    await page.locator('#linkSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-plus').length > 0);
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

  // Les cases à cocher ne servent qu'à une action rare : elles ne coûtent plus rien au repos.
  test('les cases à cocher n’apparaissent qu’en mode sélection', async () => {
    await ouvrirLiens();
    assert.equal(await page.locator('#linkFreeList input[type=checkbox]').count(), 0);
    assert.equal(await page.locator('#linkFreeAll').isHidden(), true);
    await page.locator('#linkFreeSelect').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input[type=checkbox]').length > 0);
    await page.locator('#linkFreeList input[type=checkbox]').first().check();
    assert.equal(await page.locator('#linkToService').isVisible(), true);
    await page.locator('#linkFreeSelect').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList input[type=checkbox]').length === 0);
    assert.equal(await page.locator('#linkToService').isHidden(), true, 'sortir du mode oublie la sélection');
  });

  /* Après un import, ranger se fait par paquets : on tamise (« confluence »), on coche tout ce
     qui reste, on range. Cocher deux cents lignes à la main est exactement ce qui fait renoncer. */
  test('« tout sélectionner » porte sur les liens filtrés, et le filtre défait la sélection', async () => {
    await ouvrirLiens();
    await app.api('POST', '/api/free-links', { label: 'Confluence — archi', url: 'https://c2.demo.invalid/a', tags: 'confluence' });
    await page.reload();
    await ouvrirLiens();
    await page.locator('#linkFreeSelect').click();
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
    await page.locator('#linkFreeSelect').click();
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
    await page.locator('.link-grid thead th').nth(1).hover();
    await page.locator('.link-grid thead th').nth(1).locator('[data-dir="1"]').click();
    await page.waitForTimeout(600);
  });

  /* PLUSIEURS ADRESSES DANS UNE CASE. Un Kibana de production, ce sont autant d'adresses que
     de filtres enregistrés ; la case n'en portait qu'une et poser la seconde écrasait la
     première sans rien dire. Au repos on en montre deux, puis « +N » déplie SUR PLACE. */
  test('une case porte plusieurs adresses, dépliables et modifiables', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    await app.api('PUT', `/api/services/${g.services[0].id}/urls`, {
      environment_id: env.id,
      /* SIX adresses : au-delà du seuil de la ligne, sinon la case les montrerait toutes —
         c'est justement ce que fait une ligne peu chargée, et c'est éprouvé plus bas. */
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
    assert.equal(await cell.locator('.link-open').count(), 2, 'deux au repos : la ligne reste régulière');
    assert.match(await cell.innerText(), /erreurs paiement/, 'le nom prime sur l’URL');

    /* La PREMIÈRE case d'une ligne n'est pas son premier `td` : celui-là porte le service.
       Et la condition doit survivre à l'instant où la grille est réécrite — sinon elle lève
       au lieu de rendre `false`, et l'attente s'arrête au lieu de patienter. */
    const nbOuvrables = () => page.evaluate(() => {
      const td = document.querySelectorAll('#linkGrid tbody tr:first-child td.link-cell')[0];
      return td ? td.querySelectorAll('.link-open').length : -1;
    });
    const attendreOuvrables = (n) => page.waitForFunction((k) => {
      const td = document.querySelectorAll('#linkGrid tbody tr:first-child td.link-cell')[0];
      return !!td && td.querySelectorAll('.link-open').length === k;
    }, n);
    await cell.locator('[data-cellopen]').click();
    await attendreOuvrables(6);

    // L'éditeur tient DANS la case : une ligne par adresse, et la case s'étire.
    await cell.hover();
    await cell.locator('.link-edit').click();
    await page.waitForSelector('.link-cell-edit');
    assert.equal(await page.locator('.lce-row').count(), 6);
    await page.locator('.lce-row').nth(5).locator('.lce-del').click();
    /* Cinq après suppression, et la case reste DÉPLIÉE : on l'a ouverte, enregistrer n'est pas
       une raison de la refermer sous les doigts. */
    await page.locator('.lce-save').click();
    await attendreOuvrables(5);
    assert.doesNotMatch(await page.locator('#linkGrid').innerText(), /lenteurs base/, 'la ligne retirée disparaît');

    // Repliée, elle revient à deux et compte le reste.
    await cell.locator('[data-cellopen]').click();
    await attendreOuvrables(2);
  });

  /* LES FILTRES SERVENT TOUS LES JOURS. Les environnements en pastilles, les services dans une
     liste à cocher — avec sa recherche, parce qu'ils peuvent être trente. */
  test('les pastilles filtrent les colonnes, la liste filtre les lignes', async () => {
    // Un second service : à une seule ligne, un filtre de lignes ne se voit pas.
    const autre = (await app.api('POST', '/api/services', { name: 'zeta-front' })).body;
    await app.api('PUT', `/api/services/${autre.id}/urls`, { environment_id: env.id, url: 'https://zeta.demo.invalid' });
    await page.reload();
    await ouvrirLiens();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 2);
    const cols = async () => (await page.locator('.link-grid thead th').allInnerTexts()).slice(1).map((t) => t.trim().split('\n')[0]);
    const toutes = await cols();
    assert.ok(toutes.length >= 2);

    // Depuis « tout affiché », un clic veut dire « celle-là » : c'est le geste courant.
    await page.locator(`[data-linkenv="${env.id}"]`).click();
    await page.waitForFunction((n) => document.querySelectorAll('.link-grid thead th').length === n, 2);
    assert.deepEqual(await cols(), [toutes[0]]);

    await page.locator('#linkClearFilters').click();
    await page.waitForFunction((n) => document.querySelectorAll('.link-grid thead th').length === n, toutes.length + 1);

    /* Les services sont À PLAT : ouvrir un menu pour voir sur quoi on filtre était un clic de
       trop sur un geste quotidien. Le champ qui les tamise n'apparaît qu'au-delà d'une douzaine. */
    assert.equal(await page.locator('#linkSvcChips button').count(), 2);
    assert.equal(await page.locator('#linkSvcSearch').isHidden(), true, 'à deux services, pas de tamis');
    await page.locator('#linkSvcChips button').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 1);
    assert.equal(await page.locator('#linkSvcChips button.active').count(), 1);

    // …et le choix survit au rechargement : on le repose sinon chaque matin.
    await page.reload();
    await ouvrirLiens();
    assert.equal(await page.locator('#linkGrid tbody tr').count(), 1, 'le filtre est encore posé');
    await page.locator('#linkClearFilters').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tbody tr').length === 2);
    assert.equal(await page.locator('#linkClearFilters').isHidden(), true,
      'plus de filtre actif, plus de bouton pour les relâcher');

    await app.api('DELETE', `/api/services/${autre.id}`);
  });

  /* COMBIEN MONTRER. Un chiffre en dur ne convient à personne : à deux, une grille dont chaque
     case en porte trois se déplie sans arrêt ; à dix, une seule case chargée fait une ligne
     haute comme un écran. Le seuil se juge donc sur la LIGNE. */
  test('une ligne peu chargée montre tout ; au-delà, le « +N » dit ce qu’il cache', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    const svc = (await app.api('POST', '/api/services', { name: 'petite-ligne' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, {
      environment_id: env.id,
      urls: [{ label: 'un', url: 'https://u1.demo.invalid' }, { label: 'deux', url: 'https://u2.demo.invalid' },
        { label: 'trois', url: 'https://u3.demo.invalid' }],
    });
    await page.reload();
    await ouvrirLiens();

    const petite = page.locator('.link-grid tbody tr').filter({ hasText: 'petite-ligne' });
    assert.equal(await petite.locator('.link-open').count(), 3, 'trois adresses tiennent sans être repliées');
    assert.equal(await petite.locator('.link-plus').count(), 0, '…et sans bouton à cliquer');

    // La ligne chargée, elle, se replie — et son bouton NOMME ce qu'il cache.
    const chargee = page.locator('.link-grid tbody tr')
      .filter({ has: page.locator(`[data-editservice="${g.services[0].id}"]`) });
    const plus = chargee.locator('.link-plus').first();
    assert.match(await plus.getAttribute('title'), /journal complet/,
      'un compteur seul obligerait à déplier pour savoir si ça valait la peine');

    // « Tout déplier » : un seul geste, et il est retenu.
    await page.locator('#linkExpandAll').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-plus').length === 0);
    await page.reload();
    await ouvrirLiens();
    assert.equal(await page.locator('#linkGrid .link-plus').count(), 0, 'le choix survit au rechargement');
    await page.locator('#linkExpandAll').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid .link-plus').length > 0);

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
      null, { timeout: 5000 });

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

    await page.locator('#linksAdd').click();
    await page.locator('#linkAddMenu [data-add="free"]').click();
    await page.waitForSelector('#freeLinkModal:not([hidden])');
    const proposes = await page.locator('#freeFolders option').evaluateAll((els) => els.map((e) => e.value));
    assert.ok(proposes.includes('doc'), 'les niveaux INTERMÉDIAIRES sont proposés, pas seulement les feuilles');
    assert.ok(proposes.includes('doc/astreinte'));

    await page.locator('#freeLabel').fill('Nouveau');
    await page.locator('#freeUrl').fill('https://run2.demo.invalid');
    await page.locator('#freeFolder').fill('doc/astreinte/2026');
    await page.locator('#freeSave').click();
    await page.waitForFunction(() => !document.querySelector('#freeLinkModal').hidden === false);

    const l = (await app.api('GET', '/api/links/grid')).body.free_links.find((x) => x.label === 'Nouveau');
    assert.equal(l.folder, 'doc/astreinte/2026', 'le sous-sous-dossier est créé au passage');
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
    const tags = await page.locator('#linkTags').innerText();
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

});

