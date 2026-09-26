'use strict';
/* RÉGLAGES → GÉNÉRAL, VU DE L'ÉCRAN : la jauge d'occupation disque et « Nettoyer maintenant ».
 * « Mesurer » dessine une table (une ligne par catégorie, un total) ; « Nettoyer » lance la
 * rétention et écrit son bilan sous le bouton — « Rien à nettoyer » sur une base neuve, et le
 * compte des jobs supprimés quand il y a quelque chose. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Réglages — occupation disque et nettoyage', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure({ retention_days: '30' });
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="config"]').click();
    await page.waitForSelector('#sub-config.active');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  test('« Mesurer l’occupation disque » dessine la jauge : une ligne par catégorie, un total, le dossier de données', async () => {
    assert.equal(await page.locator('#diskUsage').isVisible(), false, 'rien n’est mesuré avant qu’on le demande');
    await page.locator('#btnDiskMeasure').click();
    await page.waitForSelector('#diskUsage table.disk-table tbody tr');
    const d = (await app.api('GET', '/api/stats/disk')).body;
    assert.equal(await page.locator('#diskUsage tbody tr').count(), d.categories.length, 'une ligne par catégorie mesurée');
    assert.equal(await page.locator('#diskUsage .disk-bar span').count(), d.categories.length, 'chaque ligne porte sa barre');
    const pied = await page.locator('#diskUsage tfoot').textContent();
    assert.match(pied, /Total/);
    assert.ok(pied.includes(d.data_dir), 'le pied nomme le dossier de données');
  });

  test('« Nettoyer maintenant » lance la rétention et écrit son bilan : zéro sur une base neuve, le compte ensuite', async () => {
    await page.locator('#btnRetentionRun').click();
    await page.waitForFunction(() => { const p = document.querySelector('#retentionBilan'); return p && !p.hidden && p.textContent.trim() !== ''; });
    assert.match(await page.locator('#retentionBilan').textContent(), /^0 jobs? et 0 lignes|Rien à nettoyer/, 'base neuve : rien de supprimé, et l’écran le dit');
    // Un job vieux de deux mois : la rétention (30 j) le retire, et le bilan le compte.
    const vieux = new Date(Date.now() - 60 * 86400000).toISOString();
    app.db.prepare("INSERT INTO job (kind, status, total, done_count, started_at, finished_at) VALUES ('review', 'done', 1, 1, ?, ?)").run(vieux, vieux);
    await page.locator('#btnRetentionRun').click();
    await page.waitForFunction(() => /1 job/.test((document.querySelector('#retentionBilan') || {}).textContent || ''));
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM job WHERE finished_at = ?").get(vieux).c, 0, 'le job a bien été retiré');
    assert.deepEqual(erreurs, []);
  });
});
