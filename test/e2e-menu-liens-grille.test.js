'use strict';
/* MENU LIENS — LA GRILLE, SES CASES ET LA FICHE D'UN SERVICE, dans un vrai navigateur.
 *
 * Ce que les fichiers voisins ne prouvaient pas par l'écran :
 *   - une case à UNE adresse s'ouvre en entier — et son bouton copier, recouvert par le crayon
 *     (bug, test `todo`) ;
 *   - le panneau d'une case en lecture : tamis qui masque sans rien retirer, flèches, Entrée
 *     et clic sur une ligne qui ouvrent, clic extérieur qui ferme ;
 *   - le panneau en édition : descendre, supprimer, ajouter une ligne, enregistrer — et
 *     « Annuler » qui n'écrit rien ;
 *   - le clavier de la grille : `c` copie, Entrée ouvre le panneau ou l'ajout, Échap ferme ;
 *   - le glisser-déposer des lignes et des colonnes (la frontière des épinglés tient, une
 *     colonne masquée garde sa place) — éprouvé par de VRAIS événements de glisser envoyés au
 *     DOM, là où les fichiers voisins ne passaient que par l'API ;
 *   - la fiche d'un service : l'éclair qui l'ouvre sur les liens contextuels, leur ajout et
 *     leur suppression sur un service existant, le renommage, les tags, l'épingle, la
 *     suppression d'une adresse, Entrée qui enregistre, la suppression du service.
 *
 * Rien ne quitte la page : les ouvertures sont interceptées et notées. Un seul `startApp()`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

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

const NOMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

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

describe('Menu Liens : grille, panneau d’une case et fiche d’un service', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let contexte; let page;
  const envs = {};
  const svcs = {};
  const erreurs = [];

  const grille = async () => (await app.api('GET', '/api/links/grid')).body;
  const service = async (id) => (await grille()).services.find((s) => s.id === id);

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const [name, color] of [['dev', '#2f6fe0'], ['preprod', '#a16207'], ['prod', '#b91c1c']]) {
      envs[name] = (await app.api('POST', '/api/environments', { name, color })).body;
    }
    svcs.api = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    svcs.web = (await app.api('POST', '/api/services', { name: 'web-front', tags: 'frontend' })).body;
    svcs.zeta = (await app.api('POST', '/api/services', { name: 'zeta' })).body;
    await app.api('PUT', `/api/services/${svcs.api.id}/urls`, {
      environment_id: envs.dev.id,
      urls: NOMS.map((n) => ({ label: n, url: `https://api-dev.demo.invalid/${n}` })),
    });
    await app.api('PUT', `/api/services/${svcs.web.id}/urls`, { environment_id: envs.dev.id, url: 'https://web-dev.demo.invalid/accueil' });

    navigateur = await lancerNavigateur();
    contexte = await navigateur.newContext({ viewport: { width: 1400, height: 950 } });
    page = await contexte.newPage();
    await afficherMenusOptionnels(page);
    await atterrirSurLiens(page);
    await intercepterOuvertures(page);
    page.on('pageerror', (e) => erreurs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirLiens = async () => {
    await page.reload();
    // Pas de clic : l'application rouvre « Liens » d'elle-même (voir `atterrirSurLiens`).
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-grid');
  };
  const ouverts = () => page.evaluate(() => window.__ouverts.slice());
  const attendreToast = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast .toast-msg')]
    .some((t) => new RegExp(src).test(t.textContent)), re.source);
  const cellule = (sid, eid) => page.locator(`#linkGrid td[data-cell="${sid}:${eid}"]`);
  const nomsLignes = () => page.locator('#linkGrid tr.link-grid-row .link-svc-btn').allInnerTexts()
    .then((t) => t.map((x) => x.trim()));
  const nomsColonnes = () => page.locator('#linkGrid th.link-col .link-env-name').allInnerTexts()
    .then((t) => t.map((x) => x.trim()));

  /* Un VRAI glisser, au niveau du DOM : `dragstart` sur la source, `dragover` à la position
     voulue de la cible, puis `dragend`. C'est la suite d'événements que l'écran écoute ; la
     souris native de Playwright, elle, ne la produit pas de façon fiable. */
  const glisser = (source, cible, { avant = true } = {}) => page.evaluate(({ source: s, cible: c, avant: av }) => {
    const src = document.querySelector(s);
    const dst = document.querySelector(c);
    const r = dst.getBoundingClientRect();
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: av ? r.left + 2 : r.right - 2,
      clientY: av ? r.top + 2 : r.bottom - 2,
    }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { source, cible, avant });

  /* ---------------------------------------------------- une case, une adresse ---- */

  test('une case à une seule adresse s’ouvre en entier', async () => {
    await ouvrirLiens();
    const td = cellule(svcs.web.id, envs.dev.id);
    assert.equal(await td.evaluate((e) => e.classList.contains('une')), true, 'la case est marquée « une adresse »');
    // Le clic arrive sur le BLANC de la case, pas sur le nom : il ouvre quand même l'adresse.
    await td.dispatchEvent('click');
    await page.waitForFunction(() => window.__ouverts.length === 1);
    assert.deepEqual(await ouverts(), ['https://web-dev.demo.invalid/accueil']);
    await attendreServeur(async () => (((await service(svcs.web.id)).urls[envs.dev.id] || [])[0] || {}).uses === 1,
      'l’ouverture est comptée');
  });

  /* LE BOUTON COPIER EST SOUS LE CRAYON. `.link-cell .link-line` est en `display: flex` sur
     toute la largeur, donc le bouton copier finit collé au bord droit de la case — exactement
     là où `.link-cell .link-edit` est posé en absolu (`right: 8px; top: 50%`). Au survol (le
     seul moment où le bouton copier est visible), le crayon le recouvre : sur une case à une
     adresse, et sur la ligne du milieu d'une case à trois, un clic sur « copier » ouvre
     l'édition. Le clavier (`c`) copie encore — c'est la souris qui n'y a plus accès. */
  test('le bouton copier d’une case à une adresse se clique à la souris', async () => {
    await ouvrirLiens();
    const td = cellule(svcs.web.id, envs.dev.id);
    await contexte.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
    await td.hover();
    const sousLeClic = await td.evaluate((c) => {
      const r = c.querySelector('.link-copy').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el && el.closest('button') ? el.closest('button').className : null;
    });
    assert.equal(sousLeClic, 'link-copy', 'le centre du bouton copier doit être… le bouton copier');
    await td.locator('.link-copy').click({ timeout: 3000 });
    await attendreToast(/Copié : https:\/\/web-dev\.demo\.invalid\/accueil/);
    await attendreServeur(async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'https://web-dev.demo.invalid/accueil',
      'l’URL est dans le presse-papiers', 5000);
    assert.equal(await page.locator('.link-cell-panel').count(), 0, 'copier n’ouvre pas l’édition');
  });

  /* ------------------------------------------------ le panneau, en lecture ---- */

  test('le panneau d’une case chargée : le tamis masque sans retirer, les flèches et Entrée ouvrent', async () => {
    await ouvrirLiens();
    const td = cellule(svcs.api.id, envs.dev.id);
    assert.equal(await td.locator('.link-open').count(), 3, 'la case en montre trois');
    assert.match(await td.locator('.link-more-addr').innerText(), /5 adresses/);
    await td.locator('.link-more-addr').click();
    await page.waitForSelector('.link-cell-panel .lcp-row');
    const panneau = page.locator('.link-cell-panel');
    assert.equal(await panneau.locator('.lcp-row').count(), 5);
    assert.match(await panneau.locator('.lcp-head').innerText(), /api-core[\s\S]*dev/, 'le panneau dit sur quelle case il porte');
    assert.equal(await panneau.locator('.lcp-dot.on').count(), 3, 'les trois montrées dans la case sont marquées');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('lcp-search')), true,
      'le curseur est dans le tamis');

    // Flèches : la ligne courante suit.
    const courante = () => page.evaluate(() => (document.querySelector('.link-cell-panel .lcp-row.cur .lcp-name') || {}).textContent);
    assert.equal(await courante(), 'alpha');
    await page.keyboard.press('ArrowDown');
    assert.equal(await courante(), 'beta');
    await page.keyboard.press('ArrowUp');
    assert.equal(await courante(), 'alpha');

    // Le tamis MASQUE les autres lignes, il ne les retire pas.
    await page.locator('.link-cell-panel .lcp-search').fill('delta');
    await page.waitForFunction(() => [...document.querySelectorAll('.link-cell-panel .lcp-row')].filter((r) => !r.hidden).length === 1);
    assert.equal(await panneau.locator('.lcp-row').count(), 5, 'les autres sont toujours là');
    assert.equal(await courante(), 'delta', 'la seule trouvée devient la courante');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__ouverts.includes('https://api-dev.demo.invalid/delta'));
    await attendreServeur(async () => ((await service(svcs.api.id)).urls[envs.dev.id].find((u) => u.label === 'delta') || {}).uses === 1,
      'Entrée ouvre la ligne courante, et l’ouverture compte');

    // Un clic sur une ligne (pas sur un bouton) l'ouvre aussi.
    await page.locator('.link-cell-panel .lcp-search').fill('');
    await page.waitForFunction(() => [...document.querySelectorAll('.link-cell-panel .lcp-row')].every((r) => !r.hidden));
    await panneau.locator('.lcp-row').filter({ hasText: 'gamma' }).locator('.lcp-name').click();
    await page.waitForFunction(() => window.__ouverts.includes('https://api-dev.demo.invalid/gamma'));

    // Un clic ailleurs le referme.
    await page.locator('#linkSearch').click();
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
  });

  /* ------------------------------------------------ le panneau, en édition ---- */

  test('« Modifier » dans le panneau : descendre, supprimer, ajouter, enregistrer', async () => {
    await ouvrirLiens();
    const td = cellule(svcs.api.id, envs.dev.id);
    await td.locator('.link-more-addr').click();
    await page.waitForSelector('.link-cell-panel .lcp-edit');
    await page.locator('.link-cell-panel .lcp-edit').click();
    await page.waitForSelector('.link-cell-panel.en-edition');
    const panneau = page.locator('.link-cell-panel');
    // Cinq adresses pré-remplies, et une ligne vide où le curseur attend.
    assert.equal(await panneau.locator('.lce-row').count(), 6);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('lce-url') && !document.activeElement.value), true);

    const labels = () => panneau.locator('.lce-label').evaluateAll((els) => els.map((e) => e.value));
    await panneau.locator('.lce-row').nth(0).locator('.lce-down').click();
    assert.deepEqual((await labels()).slice(0, 2), ['beta', 'alpha'], 'la première est descendue d’un rang');
    await panneau.locator('.lce-row').filter({ has: page.locator('.lce-label[value="epsilon"]') }).locator('.lce-del').click();
    assert.deepEqual((await labels()).slice(0, 5), ['beta', 'alpha', 'gamma', 'delta', '']);
    await panneau.locator('.lce-row').last().locator('.lce-label').fill('omega');
    await panneau.locator('.lce-row').last().locator('.lce-url').fill('https://api-dev.demo.invalid/omega');
    // « Ajouter » ouvre une ligne de plus — laissée vide, elle ne pose rien.
    await panneau.locator('.lce-add').click();
    assert.equal(await panneau.locator('.lce-row').count(), 6);
    await panneau.locator('.lce-save').click();
    await attendreServeur(async () => (await service(svcs.api.id)).urls[envs.dev.id].map((u) => u.label).join(',')
      === 'beta,alpha,gamma,delta,omega', 'l’ordre, la suppression et l’ajout sont enregistrés');
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
  });

  test('« Annuler » dans le panneau n’écrit rien', async () => {
    await ouvrirLiens();
    const avant = (await service(svcs.api.id)).urls[envs.dev.id].map((u) => u.url);
    const td = cellule(svcs.api.id, envs.dev.id);
    await td.hover();
    await td.locator('.link-edit').click();
    await page.waitForSelector('.link-cell-panel.en-edition');
    await page.locator('.link-cell-panel .lce-row').first().locator('.lce-del').click();
    await page.locator('.link-cell-panel .lce-cancel').click();
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
    assert.deepEqual((await service(svcs.api.id)).urls[envs.dev.id].map((u) => u.url), avant);
  });

  /* ------------------------------------------------------------------ clavier ---- */

  test('au clavier : `c` copie, Entrée ouvre le panneau ou l’ajout, Échap referme', async () => {
    await ouvrirLiens();
    await contexte.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
    await page.locator('#linkSearch').click();
    await page.keyboard.press('ArrowDown');
    // La première case remplie est celle d'api-core en dev.
    await page.waitForFunction((c) => (document.activeElement.dataset || {}).cell === c, `${svcs.api.id}:${envs.dev.id}`);
    await page.keyboard.press('c');
    await attendreToast(/Copié : https:\/\/api-dev\.demo\.invalid\//);

    // Entrée sur une case chargée ouvre son panneau, pas une adresse au hasard.
    await page.keyboard.press('Enter');
    await page.waitForSelector('.link-cell-panel .lcp-row');
    assert.equal(await page.locator('.link-cell-panel.en-edition').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });

    // Entrée sur une case vide ouvre l'ajout : `j` descend deux lignes, jusqu'à zeta.
    await cellule(svcs.api.id, envs.dev.id).focus();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.waitForFunction((c) => (document.activeElement.dataset || {}).cell === c, `${svcs.zeta.id}:${envs.dev.id}`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.link-cell-panel.en-edition');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
    assert.deepEqual((await service(svcs.zeta.id)).urls[envs.dev.id] || [], [], 'rien n’a été posé');
  });

  /* ------------------------------------------------------- glisser-déposer ---- */

  test('glisser une ligne la déplace, d’un seul enregistrement', async () => {
    await ouvrirLiens();
    assert.deepEqual(await nomsLignes(), ['api-core', 'web-front', 'zeta']);
    await glisser(`#linkGrid tr[data-service="${svcs.zeta.id}"] .link-move`, `#linkGrid tr[data-service="${svcs.api.id}"]`);
    await attendreServeur(async () => (await grille()).services.map((s) => s.name).join(',') === 'zeta,api-core,web-front',
      'l’ordre glissé est enregistré');
    await page.waitForFunction(() => [...document.querySelectorAll('#linkGrid tr.link-grid-row .link-svc-btn')]
      .map((b) => b.textContent.trim()).join(',') === 'zeta,api-core,web-front');
  });

  test('une ligne ne traverse pas la frontière des épinglés', async () => {
    await app.api('PUT', `/api/services/${svcs.web.id}`, { pinned: 1 });
    await ouvrirLiens();
    assert.deepEqual(await nomsLignes(), ['web-front', 'zeta', 'api-core']);
    /* On vise la ligne épinglée : le glisser n'y a pas accès. La dépose enregistre quand même
       l'ordre à l'écran — c'est cette réponse qu'on attend, sans quoi l'état « inchangé » serait
       déjà vrai AVANT le geste et l'assertion ne prouverait rien. */
    const enregistre = page.waitForResponse((r) => r.url().endsWith('/api/services/reorder'));
    await glisser(`#linkGrid tr[data-service="${svcs.api.id}"] .link-move`, `#linkGrid tr[data-service="${svcs.web.id}"]`);
    assert.equal((await enregistre).status(), 200);
    assert.deepEqual((await grille()).services.map((s) => s.name), ['web-front', 'zeta', 'api-core'], 'l’épinglé reste en tête');
    await page.waitForFunction(() => [...document.querySelectorAll('#linkGrid tr.link-grid-row .link-svc-btn')]
      .map((b) => b.textContent.trim()).join(',') === 'web-front,zeta,api-core');
    await app.api('PUT', `/api/services/${svcs.web.id}`, { pinned: 0 });
  });

  test('glisser une colonne la déplace, et une colonne masquée garde sa place', async () => {
    await ouvrirLiens();
    assert.deepEqual(await nomsColonnes(), ['dev', 'preprod', 'prod']);
    await glisser(`#linkGrid th[data-envcol="${envs.dev.id}"]`, `#linkGrid th[data-envcol="${envs.preprod.id}"]`, { avant: false });
    await attendreServeur(async () => (await grille()).environments.map((e) => e.name).join(',') === 'preprod,dev,prod',
      'la colonne glissée est enregistrée');
    await page.waitForFunction(() => [...document.querySelectorAll('#linkGrid th.link-col .link-env-name')]
      .map((b) => b.textContent.trim()).join(',') === 'preprod,dev,prod');

    // On masque « dev », puis on glisse « prod » avant « preprod » : « dev » ne part pas au bout.
    await page.locator(`#linkCols [data-linkenv="${envs.dev.id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid th.link-col').length === 2);
    await glisser(`#linkGrid th[data-envcol="${envs.prod.id}"]`, `#linkGrid th[data-envcol="${envs.preprod.id}"]`);
    await attendreServeur(async () => (await grille()).environments.map((e) => e.name).join(',') === 'prod,dev,preprod',
      'la masquée garde son créneau');
    await page.locator('#linkClearFilters').click();
    await page.waitForFunction(() => document.querySelectorAll('#linkGrid th.link-col').length === 3);
    // On remet l'ordre d'origine pour la suite.
    await app.api('POST', '/api/environments/reorder', { ids: [envs.dev.id, envs.preprod.id, envs.prod.id] });
  });

  /* ------------------------------------------------------ la fiche du service ---- */

  test('l’éclair ouvre la fiche sur ses liens contextuels, qui s’ajoutent et s’effacent aussitôt', async () => {
    await app.api('POST', `/api/services/${svcs.api.id}/context-links`, { label: 'Logs', url_template: 'https://kibana-{env}.demo.invalid/?q={branch}' });
    await ouvrirLiens();
    await page.locator(`#linkGrid [data-ctxopen="${svcs.api.id}"]`).click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ctxLabel');
    assert.match(await page.locator('#serviceCtxList').innerText(), /Logs/);

    // Incomplet : on le dit, rien ne part.
    await page.locator('#ctxLabel').fill('Sonar');
    await page.locator('#ctxAdd').click();
    await attendreToast(/libellé ET un gabarit/);
    const ctx = async () => (await app.api('GET', `/api/services/${svcs.api.id}/context-links`)).body.links;
    assert.equal((await ctx()).length, 1);

    // Sur un service EXISTANT, l'ajout part tout de suite, sans attendre « Enregistrer ».
    await page.locator('#ctxTemplate').fill('https://sonar.demo.invalid/{service}/{mr_iid}');
    await page.locator('#ctxTemplate').press('Enter');
    await attendreServeur(async () => (await ctx()).length === 2, 'le gabarit est posé');
    await page.waitForFunction(() => document.querySelectorAll('#serviceCtxList .link-ctx-row').length === 2);
    assert.equal(await page.locator('#ctxLabel').inputValue(), '', 'les champs se vident pour le suivant');

    const logs = (await ctx()).find((l) => l.label === 'Logs');
    await page.locator(`#serviceCtxList [data-delctx="${logs.id}"]`).click();
    await attendreServeur(async () => (await ctx()).length === 1, 'le gabarit est effacé');
    await page.waitForFunction(() => document.querySelectorAll('#serviceCtxList .link-ctx-row').length === 1);
    await page.locator('#serviceCancel').click();
    await page.waitForSelector('#serviceModal', { state: 'hidden' });
  });

  test('la fiche renomme, retague, épingle et retire une adresse — Entrée enregistre', async () => {
    await ouvrirLiens();
    await page.locator(`#linkGrid [data-editservice="${svcs.web.id}"]`).click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    assert.equal((await page.locator('#serviceModalTitle').innerText()).trim(), 'Modifier le service');
    assert.equal(await page.locator('#serviceName').inputValue(), 'web-front');
    assert.equal(await page.locator('#serviceTags').inputValue(), 'frontend');
    assert.equal(await page.locator('#serviceDelete').isVisible(), true);

    await page.locator('#serviceName').fill('web-vitrine');
    await page.locator('#servicePinned').click();
    // L'adresse de dev part par sa corbeille : la ligne vide qui reste ne pose rien.
    const bloc = page.locator(`#serviceUrlsList [data-svcenv="${envs.dev.id}"]`);
    assert.equal(await bloc.locator('.link-url-row').count(), 2);
    await bloc.locator('.link-url-row').first().locator('.svc-url-del').click();
    assert.equal(await bloc.locator('.link-url-row').count(), 1);
    await page.locator('#serviceTags').fill('frontend, vitrine');
    await page.locator('#serviceTags').press('Enter');
    await page.waitForSelector('#serviceModal', { state: 'hidden' });

    await attendreServeur(async () => (await service(svcs.web.id)).name === 'web-vitrine', 'le service est enregistré');
    const s = await service(svcs.web.id);
    assert.deepEqual(s.tags, ['frontend', 'vitrine']);
    assert.equal(s.pinned, 1);
    assert.deepEqual(s.urls[envs.dev.id] || [], [], 'l’adresse retirée n’existe plus');
    // Épinglé : la ligne remonte en tête.
    await page.waitForFunction(() => /web-vitrine/.test((document.querySelector('#linkGrid tr.link-grid-row .link-svc-btn') || {}).textContent || ''));
  });

  test('supprimer un service se confirme, et renoncer le garde', async () => {
    await ouvrirLiens();
    const ouvrirFiche = async () => {
      await page.locator(`#linkGrid [data-editservice="${svcs.zeta.id}"]`).click();
      await page.waitForSelector('#serviceModal:not([hidden])');
      await page.locator('#serviceDelete').click();
      await page.waitForSelector('#confirmModal:not([hidden])');
    };
    await ouvrirFiche();
    assert.match(await page.locator('#confirmText').innerText(), /Supprimer « zeta » \?/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    await page.locator('#serviceCancel').click();
    await page.waitForSelector('#serviceModal', { state: 'hidden' });
    assert.ok(await service(svcs.zeta.id), 'renoncer ne supprime rien');

    await ouvrirFiche();
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#serviceModal', { state: 'hidden' });
    await attendreServeur(async () => !(await service(svcs.zeta.id)), 'le service est supprimé');
    await page.waitForSelector(`#linkGrid tr[data-service="${svcs.zeta.id}"]`, { state: 'detached' });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });
});
