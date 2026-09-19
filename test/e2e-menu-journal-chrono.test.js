'use strict';
/* LE CHRONO DE SESSION DE TRAVAIL, EN HAUT À DROITE, DANS UN VRAI NAVIGATEUR.
 *
 * À zéro et à l'arrêt, il se réduit à son icône et au bouton ▶ : la remise à zéro d'un zéro
 * ne sert à rien. ▶ le démarre (pause et remise à zéro apparaissent), ⏸ le fige, ↺ le remet à
 * zéro. Son état vit dans le stockage du navigateur : un rechargement le retrouve, et un
 * AUTRE onglet adopte ce qu'un premier vient d'écrire.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Chrono de session de travail', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let contexte; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    contexte = await navigateur.newContext({ viewport: { width: 1400, height: 900 } });
    page = await contexte.newPage();
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('#chrono').waitFor({ state: 'attached' });
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const temps = (p = page) => p.locator('#chronoTime').innerText();
  const enSecondes = (t) => t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  const stocke = (p = page) => p.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('aidevtools_chrono') || 'null'); } catch { return null; }
  });

  test('au repos : réduit à l’icône et au bouton ▶, à 00:00', async () => {
    assert.equal(await temps(), '00:00');
    assert.match(await page.locator('#chrono').getAttribute('class'), /\bidle\b/);
    assert.equal(await page.locator('#chronoStart').isVisible(), true);
    assert.equal(await page.locator('#chronoPause').isHidden(), true);
    assert.equal(await page.locator('#chronoReset').isHidden(), true, 'rien à remettre à zéro');
  });

  test('▶ démarre : le temps avance, ⏸ et ↺ apparaissent', async () => {
    await page.locator('#chronoStart').click();
    await page.locator('#chronoPause').waitFor({ state: 'visible' });
    await page.locator('#chronoReset').waitFor({ state: 'visible' });
    await page.locator('#chronoStart').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#chrono').classList.contains('running'));
    await page.waitForFunction(() => document.querySelector('#chronoTime').textContent !== '00:00', null, { timeout: 20000 });
    const s = await stocke();
    assert.equal(s.running, true, 'l’état est écrit dans le stockage du navigateur');
  });

  test('⏸ fige le temps ; il ne bouge plus tant qu’on ne relance pas', async () => {
    await page.locator('#chronoPause').click();
    await page.locator('#chronoStart').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#chrono').classList.contains('running'));
    const fige = await temps();
    const s = await stocke();
    assert.equal(s.running, false);
    assert.ok(s.ms >= 1000, 'le temps compté est conservé');
    assert.equal(await page.locator('#chronoReset').isVisible(), true, 'un temps non nul se remet à zéro');
    /* « Ne bouge plus » : on attend un effet qui prend du temps côté page — un aller-retour
       complet au serveur, puis deux images — et on relit. Aucune minuterie ne tourne plus. */
    await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await temps(), fige);
  });

  test('un rechargement retrouve le temps en pause', async () => {
    const avant = enSecondes(await temps());
    await page.reload();
    await page.locator('#chronoTime').waitFor({ state: 'attached' });
    await page.waitForFunction((s) => {
      const t = document.querySelector('#chronoTime').textContent.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
      return t === s;
    }, avant, { timeout: 20000 });
    assert.equal(await page.locator('#chronoStart').isVisible(), true, 'toujours en pause');
    assert.doesNotMatch(await page.locator('#chrono').getAttribute('class'), /\bidle\b/);
  });

  test('un autre onglet adopte ce que le premier écrit', async () => {
    const autre = await contexte.newPage();
    autre.on('pageerror', (e) => erreurs.push(e.message));
    await autre.goto(app.base);
    await autre.locator('#chrono').waitFor({ state: 'attached' });
    await page.locator('#chronoStart').click();
    await autre.waitForFunction(() => document.querySelector('#chrono').classList.contains('running'), null, { timeout: 20000 });
    await autre.locator('#chronoPause').waitFor({ state: 'visible' });
    await page.locator('#chronoPause').click();
    await autre.waitForFunction(() => !document.querySelector('#chrono').classList.contains('running'), null, { timeout: 20000 });
    await autre.close();
  });

  test('↺ remet à zéro et le chrono se réduit de nouveau', async () => {
    await page.locator('#chronoReset').click();
    await page.waitForFunction(() => document.querySelector('#chronoTime').textContent === '00:00');
    await page.waitForFunction(() => document.querySelector('#chrono').classList.contains('idle'));
    await page.locator('#chronoReset').waitFor({ state: 'hidden' });
    assert.equal((await stocke()).ms, 0);
    // …et un rechargement le retrouve à zéro.
    await page.reload();
    await page.locator('#chronoTime').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#chrono').classList.contains('idle'), null, { timeout: 20000 });
    assert.equal(await temps(), '00:00');
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
