'use strict';
/* MENU LIENS — LA BARRE ET CE QU'ELLE PILOTE, dans un vrai navigateur.
 *
 * Les fichiers voisins (`e2e-links-ui`, `e2e-links-refonte`) couvrent la grille, les cases et le
 * collage. Celui-ci prend ce qui restait sans preuve par l'écran :
 *   - le menu est replié d'office, et n'apparaît que demandé ;
 *   - le menu des tags : bouton qui porte le tag posé, second clic qui le relâche, filtre qui
 *     survit au rechargement, « Tout afficher » qui vide AUSSI la recherche ;
 *   - la recherche sans résultat, de chaque côté, et Entrée qui ouvre la première réponse ;
 *   - « ouvrir toute la colonne » : rien, peu (direct), beaucoup (confirmation) ;
 *   - « Autres actions » : créer, renommer, recolorer et supprimer un environnement, le mode
 *     sélection, et « Supprimer tous les liens libres » ;
 *   - l'écran vide : son champ d'adresse et son raccourci vers l'import.
 *
 * Rien ne quitte vraiment la page : `window.open` et les liens `target=_blank` sont interceptés
 * et NOTÉS, pour affirmer ce qui aurait été ouvert. L'usage (frécence), lui, est lu sur l'API.
 * Un seul `startApp()` : les tests partagent l'app et le navigateur, et se suivent. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

/* Ce que la page AURAIT ouvert. Posé avant chaque chargement : l'application lit `window.open`
   au moment du clic, et un lien `_blank` s'ouvre par le comportement par défaut du clic — qu'on
   empêche en capture, sans empêcher l'écouteur de l'application (qui note l'usage) de tourner. */
async function intercepterOuvertures(page) {
  await page.addInitScript(() => {
    window.__ouverts = [];
    window.open = (u) => { window.__ouverts.push(String(u)); return null; };
    window.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
      if (a) { e.preventDefault(); window.__ouverts.push(a.href); }
    }, true);
  });
}

/* L'APPLICATION ROUVRE ELLE-MÊME LE DERNIER ONGLET, après avoir lu `/api/config` : cliquer
   « Liens » juste après un rechargement lance DEUX chargements de la grille, et le second —
   arrivé tard sur un runner chargé — efface ce que le test vient d'ouvrir (un panneau, une
   fiche). On pose donc « Liens » comme dernier onglet avant chaque chargement, et l'on attend
   que l'application y atterrisse, au lieu de cliquer. */
async function atterrirSurLiens(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('aidevtools_tab', 'links'); } catch { /* stockage refusé */ }
  });
}

describe('Menu Liens : la barre, les filtres et « Autres actions »', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const envs = {};
  const svcs = {};
  const erreurs = [];

  const grille = async () => (await app.api('GET', '/api/links/grid')).body;

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const [name, color] of [['dev', '#2f6fe0'], ['prod', '#b91c1c'], ['vide', '#888888']]) {
      const r = await app.api('POST', '/api/environments', { name, color });
      assert.equal(r.status, 200, r.text);
      envs[name] = r.body;
    }
    svcs.api = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    svcs.web = (await app.api('POST', '/api/services', { name: 'web-front', tags: 'frontend' })).body;
    await app.api('PUT', `/api/services/${svcs.api.id}/urls`, { environment_id: envs.dev.id, url: 'https://api-dev.demo.invalid/health' });
    await app.api('PUT', `/api/services/${svcs.web.id}/urls`, { environment_id: envs.dev.id, url: 'https://web-dev.demo.invalid/accueil' });
    await app.api('PUT', `/api/services/${svcs.api.id}/urls`, {
      environment_id: envs.prod.id,
      urls: [1, 2, 3, 4].map((i) => ({ label: `p${i}`, url: `https://api-prod.demo.invalid/p${i}` })),
    });
    await app.api('POST', '/api/free-links', { label: 'Wiki équipe', url: 'https://wiki.demo.invalid/equipe', tags: 'doc' });
    await app.api('POST', '/api/free-links', { label: 'Grafana', url: 'https://grafana.demo.invalid/d/1', tags: 'backend' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    await afficherMenusOptionnels(page);
    await atterrirSurLiens(page);
    await intercepterOuvertures(page);
    page.on('pageerror', (e) => erreurs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(app.base);
    // L'application atterrit d'elle-même sur « Liens » : on attend ce chargement-là, pour que le
    // clic des tests ne le croise jamais.
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-grid');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirLiens = async () => {
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-grid');
  };
  // Après un rechargement, pas de clic : l'application rouvre « Liens » d'elle-même.
  const recharger = async () => {
    await page.reload();
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-grid');
  };
  const lignes = () => page.locator('#linkGrid tr.link-grid-row').count();
  const ouverts = () => page.evaluate(() => window.__ouverts.slice());
  const viderOuverts = () => page.evaluate(() => { window.__ouverts.length = 0; });
  const attendreToast = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast .toast-msg')]
    .some((t) => new RegExp(src).test(t.textContent)), re.source);
  const autresActions = async (quoi) => {
    await page.locator('#linkMore').click();
    await page.waitForSelector('#linkMoreMenu:not([hidden])');
    await page.locator(`#linkMoreMenu [data-more="${quoi}"]`).click();
  };

  /* ------------------------------------------------------------ le menu replié ---- */

  test('le menu Liens est replié d’office : un navigateur neuf ne le montre pas', async () => {
    const neuve = await navigateur.newPage();
    try {
      await neuve.goto(app.base);
      await neuve.waitForSelector('nav button[data-tab="dashboard"]');
      assert.equal(await neuve.locator('nav button[data-tab="links"]').isHidden(), true,
        'Liens est une commodité : la barre ne le porte pas tant qu’on ne l’a pas demandé');
    } finally { await neuve.close(); }
    // …et la page du test, qui l'a demandé, le montre.
    assert.equal(await page.locator('nav button[data-tab="links"]').isVisible(), true);
  });

  /* ---------------------------------------------------------------- les tags ---- */

  test('le tag posé se lit sur le bouton, survit au rechargement, et un second clic le relâche', async () => {
    await ouvrirLiens();
    assert.equal(await lignes(), 2);
    await page.locator('#linkTagBtn').click();
    await page.waitForSelector('#linkTagMenu:not([hidden])');
    // Le compte dit de quel côté de l'écran se trouve le tag : un service ET un lien libre.
    const entree = await page.locator('#linkTagMenu [data-linktag="backend"]').innerText();
    assert.match(entree, /1 service/);
    assert.match(entree, /1 lien/);
    await page.locator('#linkTagMenu [data-linktag="backend"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 1);
    assert.match(await page.locator('#linkGrid tr.link-grid-row').innerText(), /api-core/);
    assert.equal((await page.locator('#linkTagBtn').innerText()).trim(), 'backend', 'le bouton porte le tag posé');
    assert.equal(await page.locator('#linkTagBtn').evaluate((b) => b.classList.contains('active')), true);
    // Le filtre porte AUSSI sur les liens libres.
    assert.deepEqual((await page.locator('#linkFreeList .link-free-label').allInnerTexts()).map((t) => t.trim()), ['Grafana']);
    assert.equal(await page.locator('#linkClearFilters').isVisible(), true);

    // Un filtre de tous les jours ne se repose pas à chaque visite.
    await recharger();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 1);
    assert.equal((await page.locator('#linkTagBtn').innerText()).trim(), 'backend');

    // Recliquer le tag actif dans le menu le relâche.
    await page.locator('#linkTagBtn').click();
    await page.locator('#linkTagMenu [data-linktag="backend"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 2);
    assert.equal((await page.locator('#linkTagBtn').innerText()).trim(), 'Tag');
    assert.equal(await page.locator('#linkClearFilters').isHidden(), true, 'plus rien à relâcher');
  });

  test('« Tout afficher » relâche le tag ET vide la recherche', async () => {
    await ouvrirLiens();
    await page.locator('#linkTagBtn').click();
    await page.locator('#linkTagMenu [data-linktag="frontend"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 1);
    await page.locator('#linkSearch').fill('web');
    await page.waitForSelector('#linkClearFilters:not([hidden])');
    await page.locator('#linkClearFilters').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 2);
    assert.equal(await page.locator('#linkSearch').inputValue(), '', 'la recherche est vidée, comme la phrase le promet');
    assert.equal(await page.locator('#linkFilterChips [data-untag]').count(), 0, 'la pastille du tag est partie');
    assert.equal(await page.locator('#linkFreeList .link-free-row').count(), 2, 'les deux liens libres reviennent');
    assert.equal(await page.locator('#linkClearFilters').isHidden(), true);
  });

  /* ------------------------------------------------------------- la recherche ---- */

  test('une recherche sans réponse le dit de chaque côté, sans message trompeur', async () => {
    await ouvrirLiens();
    await page.locator('#linkSearch').fill('introuvable-xyz');
    await page.waitForSelector('#linkGrid .link-grid-empty');
    assert.match(await page.locator('#linkGrid .link-grid-empty').innerText(), /ni dans la grille ni dans les liens libres/);
    assert.match(await page.locator('#linkFreeList').innerText(), /Aucun lien libre ne correspond/);
    assert.equal((await page.locator('#linkFreeCount').innerText()).trim(), '', 'aucun compte à annoncer');

    // Trouvée seulement en bas : la grille renvoie vers les liens libres au lieu de dire « rien ».
    await page.locator('#linkSearch').fill('wiki');
    await page.waitForFunction(() => /regarde les liens libres/.test((document.querySelector('#linkGrid .link-grid-empty') || {}).textContent || ''));
    assert.match(await page.locator('#linkFreeCount').innerText(), /1 lien libre/);
    await page.locator('#linkSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 2);
  });

  test('Entrée dans la recherche ouvre la première réponse, et l’ouverture compte', async () => {
    await ouvrirLiens();
    await viderOuverts();
    await page.locator('#linkSearch').fill('wiki');
    await page.waitForFunction(() => document.querySelectorAll('#linkFreeList .link-free-row').length === 1);
    await page.locator('#linkSearch').press('Enter');
    await page.waitForFunction(() => window.__ouverts.length === 1);
    assert.deepEqual(await ouverts(), ['https://wiki.demo.invalid/equipe']);
    await attendreServeur(async () => ((await grille()).free_links.find((l) => l.label === 'Wiki équipe') || {}).uses === 1,
      'l’ouverture nourrit la frécence du lien libre');

    // Dans la grille, c'est l'adresse de la case qui part.
    await viderOuverts();
    await page.locator('#linkSearch').fill('web-front');
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid tr.link-grid-row').length === 1);
    await page.locator('#linkSearch').press('Enter');
    await page.waitForFunction(() => window.__ouverts.length === 1);
    assert.deepEqual(await ouverts(), ['https://web-dev.demo.invalid/accueil']);
    await attendreServeur(async () => {
      const s = (await grille()).services.find((x) => x.id === svcs.web.id);
      return ((s.urls[envs.dev.id] || [])[0] || {}).uses === 1;
    }, 'l’ouverture nourrit la frécence de l’adresse');
    await page.locator('#linkSearch').fill('');
  });

  /* ------------------------------------------------- ouvrir toute la colonne ---- */

  test('ouvrir toute une colonne : rien, peu (direct) ou beaucoup (confirmé)', async () => {
    await recharger();
    const ouvrirColonne = async (id) => {
      const th = page.locator(`#linkGrid th[data-envcol="${id}"]`);
      await th.hover();
      await th.locator(`[data-envopen="${id}"]`).click();
    };
    // Une colonne sans adresse : on le dit, on n'ouvre rien.
    await ouvrirColonne(envs.vide.id);
    await attendreToast(/Aucune adresse dans cette colonne/);
    assert.deepEqual(await ouverts(), []);

    // Deux adresses : elles partent sans question.
    await ouvrirColonne(envs.dev.id);
    await page.waitForFunction(() => window.__ouverts.length === 2);
    assert.deepEqual((await ouverts()).sort(), ['https://api-dev.demo.invalid/health', 'https://web-dev.demo.invalid/accueil']);
    assert.equal(await page.locator('#confirmModal').isHidden(), true, 'pas de confirmation sous quatre');

    // Quatre : on prévient — et renoncer n'ouvre rien.
    await viderOuverts();
    await ouvrirColonne(envs.prod.id);
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmModal').innerText(), /Ouvrir 4 onglets/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.deepEqual(await ouverts(), [], 'renoncer n’ouvre rien');

    await ouvrirColonne(envs.prod.id);
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => window.__ouverts.length === 4);
    assert.deepEqual((await ouverts()).sort(), [1, 2, 3, 4].map((i) => `https://api-prod.demo.invalid/p${i}`));
    // Chaque adresse ouverte d'un coup compte, comme si on l'avait cliquée.
    await attendreServeur(async () => {
      const s = (await grille()).services.find((x) => x.id === svcs.api.id);
      return (s.urls[envs.prod.id] || []).every((u) => u.uses === 1);
    }, 'les quatre ouvertures sont notées');
  });

  /* ------------------------------------------------------- les environnements ---- */

  test('« Autres actions → Un environnement » crée une colonne, Entrée enregistre', async () => {
    await ouvrirLiens();
    await autresActions('newenv');
    await page.waitForSelector('#envModal:not([hidden])');
    assert.equal((await page.locator('#envModalTitle').innerText()).trim(), 'Nouvel environnement');
    assert.equal(await page.locator('#envDelete').isHidden(), true, 'rien à supprimer à la création');
    await page.locator('#envName').fill('recette');
    await page.locator('#envName').press('Enter');
    await page.waitForSelector('#envModal', { state: 'hidden' });
    await attendreServeur(async () => (await grille()).environments.some((e) => e.name === 'recette'), 'la colonne est créée');
    await page.waitForFunction(() => [...document.querySelectorAll('#linkGrid th.link-col .link-env-name')]
      .some((b) => b.textContent.trim() === 'recette'));
    // …et l'interrupteur de colonne la connaît aussitôt.
    const id = (await grille()).environments.find((e) => e.name === 'recette').id;
    await page.waitForSelector(`#linkCols [data-linkenv="${id}"]`);
  });

  test('le nom d’une colonne ouvre ses réglages : renommer, recolorer, annuler n’écrit rien', async () => {
    await ouvrirLiens();
    const id = (await grille()).environments.find((e) => e.name === 'recette').id;
    // Annuler : rien n'est écrit.
    await page.locator(`#linkGrid [data-envedit="${id}"]`).click();
    await page.waitForSelector('#envModal:not([hidden])');
    assert.equal((await page.locator('#envModalTitle').innerText()).trim(), 'Modifier l’environnement');
    assert.equal(await page.locator('#envName').inputValue(), 'recette', 'le nom actuel est pré-rempli');
    await page.locator('#envName').fill('jamais');
    await page.locator('#envCancel').click();
    await page.waitForSelector('#envModal', { state: 'hidden' });
    assert.equal((await grille()).environments.find((e) => e.id === id).name, 'recette');

    await page.locator(`#linkGrid [data-envedit="${id}"]`).click();
    await page.waitForSelector('#envModal:not([hidden])');
    await page.locator('#envName').fill('qualif');
    await page.locator('#envColor').fill('#12a150');
    await page.locator('#envSave').click();
    await page.waitForSelector('#envModal', { state: 'hidden' });
    await attendreServeur(async () => (await grille()).environments.find((e) => e.id === id).name === 'qualif', 'renommé');
    assert.equal((await grille()).environments.find((e) => e.id === id).color, '#12a150');
    await page.waitForFunction((i) => (document.querySelector(`#linkGrid [data-envedit="${i}"]`) || {}).textContent === 'qualif', id);
  });

  test('supprimer une colonne dit combien d’adresses partent avec, et renoncer la garde', async () => {
    await ouvrirLiens();
    // La colonne chargée : le compte est dit, et on renonce.
    await page.locator(`#linkGrid [data-envedit="${envs.prod.id}"]`).click();
    await page.waitForSelector('#envModal:not([hidden])');
    await page.locator('#envDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /« prod » \? 4 adresses y sont posées/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    await page.locator('#envCancel').click();
    await page.waitForSelector('#envModal', { state: 'hidden' });
    assert.ok((await grille()).environments.some((e) => e.id === envs.prod.id), 'renoncer ne supprime rien');

    // La colonne vide : on le dit aussi, et on supprime.
    const id = (await grille()).environments.find((e) => e.name === 'qualif').id;
    await page.locator(`#linkGrid [data-envedit="${id}"]`).click();
    await page.waitForSelector('#envModal:not([hidden])');
    await page.locator('#envDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Aucune adresse n’y est posée/);
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#envModal', { state: 'hidden' });
    await attendreServeur(async () => !(await grille()).environments.some((e) => e.id === id), 'la colonne est supprimée');
    await page.waitForSelector(`#linkGrid [data-envedit="${id}"]`, { state: 'detached' });
  });

  /* ------------------------------------------------------- le mode sélection ---- */

  test('« Sélectionner » bascule le mode, et « Terminer » défait la sélection', async () => {
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    assert.equal((await page.locator('#linkMoreMenu [data-more="select"]').innerText()).trim(), 'Sélectionner');
    await page.locator('#linkMoreMenu [data-more="select"]').click();
    await page.waitForFunction(() => document.querySelector('#linkFreeList').classList.contains('mode-select'));
    assert.equal(await page.locator('#linkFreeAll').isVisible(), true, '« Tout sélectionner » apparaît en sélection');

    await page.locator('#linkFreeList .link-free-row').first().locator('.lfr-pick').click();
    await page.waitForSelector('#linkToService:not([hidden])');
    assert.match(await page.locator('#linkToService').innerText(), /Ranger 1 lien/);

    await page.locator('#linkMore').click();
    assert.equal((await page.locator('#linkMoreMenu [data-more="select"]').innerText()).trim(), 'Terminer');
    await page.locator('#linkMoreMenu [data-more="select"]').click();
    await page.waitForFunction(() => !document.querySelector('#linkFreeList').classList.contains('mode-select'));
    assert.equal(await page.locator('#linkToService').isHidden(), true, 'la sélection est défaite');
    assert.equal(await page.locator('#linkFreeList .lfr-pick:checked').count(), 0);
    assert.equal(await page.locator('#linkFreeAll').isHidden(), true);
  });

  /* ------------------------------------------- supprimer tous les liens libres ---- */

  test('« Supprimer tous les liens libres » annonce le nombre, et ne touche pas la grille', async () => {
    await ouvrirLiens();
    const avant = await grille();
    assert.equal(avant.free_links.length, 2);
    await autresActions('wipe');
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Supprimer les 2 liens libres \? La grille/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal((await grille()).free_links.length, 2, 'renoncer ne supprime rien');

    await autresActions('wipe');
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await grille()).free_links.length === 0, 'les liens libres sont partis');
    await attendreToast(/2 liens supprimés/);
    const apres = await grille();
    assert.equal(apres.services.length, avant.services.length, 'les services restent');
    assert.deepEqual(apres.services.map((s) => s.urls), avant.services.map((s) => s.urls), 'et leurs adresses aussi');
    // La section disparaît, et l'action destructrice ne se propose plus : il n'y a plus rien.
    await page.waitForSelector('.link-free-bar', { state: 'hidden' });
    assert.equal(await page.locator('#linkMoreMenu [data-more="wipe"]').evaluate((b) => b.hidden), true);
    assert.equal(await page.locator('#linkMoreMenu [data-more="select"]').evaluate((b) => b.hidden), true);
  });

  /* ------------------------------------------------------------- l'écran vide ---- */

  test('écran vide : le champ d’adresse ouvre le collage pré-rempli, le bouton ouvre l’import', async () => {
    const g = await grille();
    for (const s of g.services) await app.api('DELETE', `/api/services/${s.id}`);
    for (const e of g.environments) await app.api('DELETE', `/api/environments/${e.id}`);
    await page.reload();
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-empty');

    await page.locator('#linkEmptyUrl').fill('https://kibana-dev.demo.invalid/app/logs');
    await page.locator('#linkGrid [data-empty-act="paste"]').click();
    await page.waitForSelector('#pasteModal:not([hidden])');
    assert.equal(await page.locator('#pasteText').inputValue(), 'https://kibana-dev.demo.invalid/app/logs');
    // L'analyse part d'elle-même : l'adresse est proposée à la ligne, sans rien retaper.
    await page.waitForSelector('#pasteRows .paste-row');
    assert.equal(await page.locator('#pasteOk').isDisabled(), false);
    await page.locator('#pasteCancel').click();
    await page.waitForSelector('#pasteModal', { state: 'hidden' });
    assert.equal((await grille()).free_links.length, 0, 'annuler ne pose rien');

    await page.locator('#linkGrid [data-empty-act="import"]').click();
    await page.waitForSelector('#importModal:not([hidden])');
    assert.equal(await page.locator('#importApply').isDisabled(), true, 'rien à importer tant qu’aucun fichier n’est choisi');
    await page.locator('#importCancel').click();
    await page.waitForSelector('#importModal', { state: 'hidden' });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });
});
