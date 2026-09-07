'use strict';
/* L'onglet Liens, refondu : ce qui ne se prouve que dans un vrai navigateur.
 *
 * Le fichier voisin (`e2e-links-ui.test.js`) couvre la grille, la recherche et les liens
 * libres. Celui-ci prend les gestes ajoutés par la refonte, et chacun garde le défaut qu'il
 * empêche de revenir :
 *
 * — L'ÉPINGLE ÉTAIT DANS LA FICHE, et dessinée avec une icône ÉTIQUETTE : deux raisons de ne
 *   pas la trouver.
 * — RÉORDONNER COÛTAIT CINQ CLICS ET CINQ RECHARGEMENTS pour amener une colonne de la sixième
 *   place à la première — et cinq visées, la colonne bougeant sous le curseur.
 * — L'ONGLET N'AVAIT AUCUNE TOUCHE. La palette faisait mieux que la souris, mais seulement si
 *   l'on savait qu'elle existait.
 * — SUPPRIMER UN LIEN LIBRE demandait le crayon, puis « Supprimer », puis une confirmation.
 * — LA FICHE D'UN SERVICE ne montrait que la PREMIÈRE adresse d'une case, et annonçait le reste
 *   par un compte qu'on ne pouvait pas ouvrir.
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

const ATTENTE = 20000;

describe('Liens · refonte : épingle, ordre, clavier, collage', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let envs = [];
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const [name, color] of [['local', '#8b97ad'], ['dev', '#2f6fe0'], ['preprod', '#a16207']]) {
      envs.push((await app.api('POST', '/api/environments', { name, color })).body);
    }
    const api = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    const web = (await app.api('POST', '/api/services', { name: 'webapp-front' })).body;
    await app.api('PUT', `/api/services/${api.id}/urls`, { environment_id: envs[1].id, url: 'https://api-dev.demo.invalid/health' });
    await app.api('PUT', `/api/services/${web.id}/urls`, { environment_id: envs[1].id, url: 'https://front-dev.demo.invalid' });
    await app.api('POST', '/api/free-links', { label: 'Confluence', url: 'https://confluence.demo.invalid/x', tags: 'doc' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
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
  const grille = async () => (await app.api('GET', '/api/links/grid')).body;

  /* ---------------------------------------------------------------- l'épingle ---- */

  test('l’épingle est dans la ligne, et remonte le service en tête', async () => {
    await ouvrirLiens();
    const ligne = page.locator('#linkGrid tr.link-grid-row').filter({ hasText: 'webapp-front' });
    await ligne.hover();
    await ligne.locator('[data-pin]').click();
    await attendreServeur(async () => ((await grille()).services.find((s) => s.name === 'webapp-front') || {}).pinned === 1,
      'le service est épinglé');
    /* La condition doit SURVIVRE à l'instant où la grille est réécrite : entre le squelette et
       le nouveau tableau, `tbody tr` n'existe pas — lire `.textContent` dessus lève, et
       `waitForFunction` s'arrête au lieu de patienter. */
    await page.waitForFunction(() => {
      const l = document.querySelector('#linkGrid tbody tr');
      return !!l && /webapp-front/.test(l.textContent);
    });
    /* UN TRAIT sépare les épinglés du reste : rien ne disait où s'arrêtait la tête de liste. */
    await page.waitForSelector('#linkGrid tr.apres-epingles');

    // Le même bouton la retire : un bouton qui n'a pas d'inverse visible n'est pas une bascule.
    await ligne.hover();
    await ligne.locator('[data-pin]').click();
    await attendreServeur(async () => ((await grille()).services.find((s) => s.name === 'webapp-front') || {}).pinned === 0,
      'le service n’est plus épinglé');
  });

  /* ------------------------------------------------------------- réordonner ---- */

  /* L'ORDRE POSÉ REMPLACE L'ALPHABÉTIQUE, et un seul enregistrement à la dépose. On éprouve
     l'API que le glisser appelle : le geste natif de glisser-déposer n'est pas reproductible
     de façon fiable sous Playwright, et un test qui rate une fois sur cinq ne prouve rien. */
  test('l’ordre des lignes se pose d’un coup, et survit au rechargement', async () => {
    const avant = (await grille()).services.map((s) => s.name);
    assert.deepEqual(avant, ['api-core', 'webapp-front'], 'sans rien poser, l’alphabétique tient');
    const ids = (await grille()).services.map((s) => s.id).reverse();
    await app.api('POST', '/api/services/reorder', { ids });
    await page.reload();
    await ouvrirLiens();
    const lignes = await page.locator('#linkGrid tr.link-grid-row .link-svc-btn').allInnerTexts();
    assert.deepEqual(lignes.map((t) => t.trim()), ['webapp-front', 'api-core']);
    await app.api('POST', '/api/services/reorder', { ids: ids.reverse() });
  });

  test('l’ordre des colonnes se pose d’un coup, et ce qui n’est pas cité reste derrière', async () => {
    const tout = envs.map((e) => e.id);
    // Le cas réel : on glisse alors qu'une colonne est masquée à l'écran, donc absente de l'envoi.
    await app.api('POST', '/api/environments/reorder', { ids: [tout[2], tout[0]] });
    await page.reload();
    await ouvrirLiens();
    const cols = await page.locator('#linkGrid thead th.link-col .link-env-name').allInnerTexts();
    assert.deepEqual(cols.map((t) => t.trim()), ['preprod', 'local', 'dev'],
      'la masquée garde son rang derrière, elle ne disparaît pas');
    await app.api('POST', '/api/environments/reorder', { ids: tout });
  });

  /* ---------------------------------------------------------------- clavier ---- */

  test('la grille se parcourt au clavier, et Entrée ouvre', async () => {
    await page.reload();
    await ouvrirLiens();
    // `↓` depuis la recherche entre dans la grille : c'est le pont entre les deux.
    await page.locator('#linkSearch').click();
    await page.keyboard.press('ArrowDown');
    const premiere = await page.evaluate(() => (document.activeElement.dataset || {}).cell);
    assert.ok(premiere, 'le focus est sur une case');

    await page.keyboard.press('ArrowRight');
    assert.notEqual(await page.evaluate(() => (document.activeElement.dataset || {}).cell), premiere);
    await page.keyboard.press('j');
    const apresJ = await page.evaluate(() => (document.activeElement.dataset || {}).cell);
    await page.keyboard.press('k');
    assert.notEqual(await page.evaluate(() => (document.activeElement.dataset || {}).cell), apresJ);

    // `e` modifie la case sous le curseur, `Échap` referme sans rien écrire.
    await page.keyboard.press('e');
    await page.waitForSelector('.link-cell-panel.en-edition');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.link-cell-panel', { state: 'detached' });
  });

  /* --------------------------------------------------------- les liens libres ---- */

  test('un lien libre se supprime au survol, et l’annulation le remet', async () => {
    await page.reload();
    await ouvrirLiens();
    const ligne = page.locator('#linkFreeList .link-free-row').filter({ hasText: 'Confluence' });
    await ligne.hover();
    await ligne.locator('[data-delfree]').click();
    await attendreServeur(async () => !(await grille()).free_links.some((l) => l.label === 'Confluence'),
      'le lien est parti');
    /* L'ANNULATION, pas une confirmation : on voit ce qui est parti, et on le récupère si l'on
       s'est trompé. Le toast le propose le temps qu'il faut. */
    await page.locator('.toast-btn').click();
    await attendreServeur(async () => (await grille()).free_links.some((l) => l.label === 'Confluence'),
      'le lien est revenu');
    // Le tag suit : le remettre à moitié serait pire que ne pas le remettre.
    assert.deepEqual((await grille()).free_links.find((l) => l.label === 'Confluence').tags, ['doc']);
  });

  /* ------------------------------------------------------ la fiche du service ---- */

  test('la fiche montre TOUTES les adresses d’une case, et sait en ajouter', async () => {
    const g = await grille();
    const api = g.services.find((s) => s.name === 'api-core');
    await app.api('PUT', `/api/services/${api.id}/urls`, {
      environment_id: envs[1].id,
      urls: [{ label: 'santé', url: 'https://api-dev.demo.invalid/health' },
        { label: 'metrics', url: 'https://api-dev.demo.invalid/metrics' }],
    });
    await page.reload();
    await ouvrirLiens();
    await page.locator(`#linkGrid [data-editservice="${api.id}"]`).first().click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    const bloc = page.locator(`#serviceUrlsList [data-svcenv="${envs[1].id}"]`);
    /* Les DEUX adresses, plus une ligne vide : la fiche n'en montrait qu'une et annonçait
       « 1 adresse » de plus, invisible et non modifiable ici. */
    assert.equal(await bloc.locator('.link-url-row').count(), 3);
    assert.deepEqual(await bloc.locator('.svc-url-label').evaluateAll((els) => els.map((e) => e.value)),
      ['santé', 'metrics', '']);

    // Écrire dans la ligne vide en ouvre une autre : ajouter n'a pas besoin d'un bouton de plus.
    await bloc.locator('.svc-url').last().fill('https://api-dev.demo.invalid/ready');
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .link-url-row`).length === 4,
      `#serviceUrlsList [data-svcenv="${envs[1].id}"]`);
    await page.locator('#serviceSave').click();
    await attendreServeur(async () => {
      const liste = ((await grille()).services.find((s) => s.id === api.id).urls[envs[1].id] || []);
      return liste.length === 3;
    }, 'la troisième adresse est posée');
    const liste = (await grille()).services.find((s) => s.id === api.id).urls[envs[1].id];
    assert.deepEqual(liste.map((u) => u.label), ['santé', 'metrics', ''],
      'les deux premières ne sont pas parties avec l’enregistrement');
  });

  /* LE GABARIT SE RÈGLE DÈS LA CRÉATION. La section était masquée tant que le service n'existait
     pas : on posait le service, on rouvrait sa fiche, on ajoutait le gabarit. */
  test('un lien contextuel se saisit avant que le service existe', async () => {
    await page.reload();
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="newservice"]').click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    assert.equal(await page.locator('#serviceCtxBox').isVisible(), true, 'la section est là à la création');
    await page.locator('#serviceName').fill('grafana');
    await page.locator('#ctxLabel').fill('Tableau');
    await page.locator('#ctxTemplate').fill('https://grafana-{env}.demo.invalid/d/{service}');
    await page.locator('#ctxAdd').click();
    await page.waitForSelector('#serviceCtxList .link-ctx-row');
    await page.locator('#serviceSave').click();
    /* On attend le GABARIT, pas le service : il est posé juste après la création, donc une
       fraction de seconde après que le service existe. Lire le compte à ce moment-là, c'est
       lire un état que le serveur n'a pas encore atteint. */
    await attendreServeur(async () => ((await grille()).services.find((s) => s.name === 'grafana') || {}).context_links === 1,
      'le gabarit saisi avant la création est posé');
    const svc = (await grille()).services.find((s) => s.name === 'grafana');
    /* …et la grille le MONTRE : le chip « 1 lien contextuel » avait le style d'un tag et ne
       menait nulle part ; l'icône dit maintenant ce qu'elle ouvrirait. */
    await page.reload();
    await ouvrirLiens();
    const zap = page.locator(`#linkGrid [data-ctxopen="${svc.id}"]`);
    assert.match(await zap.getAttribute('title'), /grafana-\w+\.demo\.invalid\/d\/grafana/,
      'le gabarit est résolu sur un exemple');
  });

  /* DEUX SERVICES SUR LE MÊME DÉPÔT étaient acceptés en silence, et seul le premier alimentait
     les boutons des merge requests : le second existait sans jamais rien produire. */
  test('un dépôt déjà pris est annoncé avant d’enregistrer', async () => {
    const repo = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/api-core.git', project: 'groupe/api-core' })).body;
    const g = await grille();
    const api = g.services.find((s) => s.name === 'api-core');
    await app.api('PUT', `/api/services/${api.id}`, { repo_id: repo.id });
    await page.reload();
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="newservice"]').click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    /* LE DÉPÔT SE PROPOSE DEPUIS LE NOM TAPÉ quand un seul lui correspond : le sélecteur restait
       vide et il fallait retrouver « groupe/api-core » dans une liste de deux cents. */
    await page.locator('#serviceName').fill('api-core');
    await page.waitForFunction(() => (document.querySelector('#serviceRepoBox .rc-id') || {}).value);
    // On change ensuite le nom : le dépôt proposé RESTE, on ne lui court pas après.
    await page.locator('#serviceName').fill('api-core-bis');
    await page.locator('#serviceSave').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmModal').innerText(), /api-core/,
      'le dialogue nomme le service qui tient déjà le dépôt');
    await page.locator('#confirmCancel').click();
    await page.locator('#serviceCancel').click();
  });

  /* ------------------------------------------------------------- Ctrl + V ---- */

  test('coller sur l’onglet ouvre le dialogue, pré-rempli', async () => {
    await page.reload();
    await ouvrirLiens();
    await page.locator('#linkGrid').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://sonar-preprod.demo.invalid/projet');
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('#pasteModal:not([hidden])');
    assert.equal(await page.locator('#pasteText').inputValue(), 'https://sonar-preprod.demo.invalid/projet');
    await page.waitForSelector('#pasteRows .paste-row');
    await page.locator('#pasteCancel').click();
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });
});
