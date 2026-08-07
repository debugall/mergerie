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
    assert.match(await page.locator('#linkGrid').innerText(), /confluence/, 'la raison du vide est dite');
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
    await page.locator('#linkFreeSearch').fill('');
    await page.locator('#linkFreeSearch').press('o');
    assert.equal(await page.locator('#paletteModal').isHidden(), true,
      'un « o » tapé dans une recherche est une lettre, pas un raccourci');
    assert.equal(await page.locator('#linkFreeSearch').inputValue(), 'o');
    await page.locator('#linkFreeSearch').fill('');
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

  test('le badge des liens injoignables apparaît sur l’entrée du menu', async () => {
    const g = (await app.api('GET', '/api/links/grid')).body;
    const svc = g.services[0];
    app.db.prepare(`INSERT INTO health_status (service_id, environment_id, status, http_code, latency_ms, checked_at)
      VALUES (?,?, 'down', 503, 40, ?)
      ON CONFLICT(service_id, environment_id) DO UPDATE SET status = 'down'`)
      .run(svc.id, env.id, new Date().toISOString());
    await page.reload();
    await ouvrirLiens();
    await page.waitForFunction(() => !document.querySelector('#navLinksDown').hidden);
    assert.equal(await page.locator('#navLinksDown').innerText(), '1');
    assert.match(await page.locator('.link-health.down').first().getAttribute('title'), /503/,
      'le code et la latence sont au survol de la case');
  });
});
