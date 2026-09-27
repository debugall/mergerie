'use strict';
/* L'ANNEXE D'UNE LIGNE DE JOURNAL, VUE DE L'ÉCRAN. Une ligne d'outil (Edit, Write, texte long)
 * garde ce qu'elle ne montre pas dans une annexe ; le journal n'en porte que le drapeau et un
 * « … voir » qui ouvre la modale : le diff coloré d'un Edit, le contenu d'un Write, le texte
 * complet sinon. Le polling ne charge jamais l'annexe elle-même.
 *
 * Un seul `startApp()` ; `src/jobs/file` est requis APRÈS lui (MERGERIE_DATA_DIR). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Journal — l’annexe d’une ligne s’ouvre à la demande', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let jobId; let ligneEdit; let ligneWrite; let ligneTexte;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const fini = new Date().toISOString();
    jobId = app.db.prepare("INSERT INTO job (kind, status, total, done_count, message, started_at, finished_at) VALUES ('task', 'done', 1, 1, '', ?, ?)").run(fini, fini).lastInsertRowid;
    // eslint-disable-next-line global-require
    const { logLine } = require('../src/jobs/file');
    logLine(jobId, null, '=== Session #1 (run) ===');
    ligneEdit = logLine(jobId, null, '✎ Edit src/a.js (+1 −0)', { kind: 'edit', file: 'src/a.js', edits: [{ old: 'a\nb', new: 'a\nb\nc' }] });
    ligneWrite = logLine(jobId, null, '✎ Write README.md (3 lignes)', { kind: 'write', file: 'README.md', content: '# Titre\n\ntexte du fichier' });
    ligneTexte = logLine(jobId, null, 'agent : Voici un long raisonnement…', { kind: 'text', text: 'Voici un long raisonnement, en entier, sur plusieurs lignes.\nDeuxième ligne.' });
    logLine(jobId, null, 'ligne sans annexe');
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  const volet = () => page.locator(`#logBox .logpane[data-job="${jobId}"]`);

  test('le journal ne porte que le drapeau : « … voir » sur les lignes qui ont une annexe, rien sur les autres', async () => {
    await page.evaluate((id) => ouvrirLogJob(id), jobId);   // eslint-disable-line no-undef
    await page.locator('#logPanel').waitFor({ state: 'visible' });
    if (await page.locator('#logBox').isHidden()) await page.locator('#logToggle').click();
    await volet().locator('.log-voir').first().waitFor();
    assert.equal(await volet().locator('.log-voir').count(), 3, 'trois lignes ont une annexe');
    assert.equal(await volet().locator(`[data-log-annexe="${jobId}:${ligneEdit}"]`).count(), 1);
    assert.equal(await page.locator('#logAnnexeModal').isVisible(), false);
  });

  test('un Edit : la modale nomme le fichier et montre le diff, ligne retirée et ligne ajoutée', async () => {
    await volet().locator(`[data-log-annexe="${jobId}:${ligneEdit}"]`).click();
    await page.waitForSelector('#logAnnexeModal:not([hidden])');
    assert.match(await page.locator('#logAnnexeTitle').textContent(), /src\/a\.js/);
    await page.waitForSelector('#logAnnexeBody .annexe-diff');
    const diff = await page.locator('#logAnnexeBody .annexe-diff').textContent();
    assert.match(diff, /\+\s*c/, 'la ligne ajoutée est là, marquée');
    assert.ok(!/[-−]\s*a\b/.test(diff), 'une ligne inchangée n’est pas marquée retirée');
    await page.locator('#logAnnexeClose').click();
    await page.waitForSelector('#logAnnexeModal[hidden]', { state: 'attached' });
  });

  test('un Write montre le contenu du fichier ; un texte long, le texte entier', async () => {
    await volet().locator(`[data-log-annexe="${jobId}:${ligneWrite}"]`).click();
    await page.waitForSelector('#logAnnexeModal:not([hidden])');
    assert.match(await page.locator('#logAnnexeTitle').textContent(), /README\.md/);
    assert.match(await page.locator('#logAnnexeBody .annexe-texte').textContent(), /# Titre/);
    await page.locator('#logAnnexeClose').click();
    await page.waitForSelector('#logAnnexeModal[hidden]', { state: 'attached' });
    await volet().locator(`[data-log-annexe="${jobId}:${ligneTexte}"]`).click();
    await page.waitForSelector('#logAnnexeModal:not([hidden])');
    assert.match(await page.locator('#logAnnexeBody .annexe-texte').textContent(), /Deuxième ligne\./);
    await page.locator('#logAnnexeClose').click();
    await page.waitForSelector('#logAnnexeModal[hidden]', { state: 'attached' });
    assert.deepEqual(erreurs, []);
  });
});
