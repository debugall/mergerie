'use strict';
/* Rendu du tableau de bord, dans un VRAI navigateur.
 *
 * Ces cellules sont fabriquées côté front à partir de `/api/dashboard/commits` : les tester
 * par l'API ne dirait rien de ce qui est affiché. Le classement « activité récente » a une
 * exigence propre — il doit rendre son ORDRE lisible, ce que la seule date ne permet pas
 * quand plusieurs dépôts ont poussé le même jour.
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

describe('Tableau de bord — Top 5 activité récente', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  // Trois dépôts qui ont poussé LE MÊME JOUR, à des heures différentes : c'est précisément
  // le cas où la date seule fait paraître le classement arbitraire.
  const LE_JOUR = '2026-07-14';
  const POUSSES = [
    { projet: 'grp/tot', heure: '08:12' },
    { projet: 'grp/tard', heure: '17:45' },
    { projet: 'grp/midi', heure: '12:30' },
  ];

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const { projet, heure } of POUSSES) {
      app.state.projects.push({ id: app.state.projects.length + 1, path_with_namespace: projet, http_url_to_repo: `${app.gitlabUrl}/${projet}.git` });
      await app.api('POST', '/api/repos', { project: projet, url: `${app.gitlabUrl}/${projet}.git` });
      app.state.commits[projet] = [{
        id: `${projet.replace(/\W/g, '')}0123456789abcdef`, short_id: 'abc1234',
        title: `dernier commit de ${projet}`, author_name: 'Dev',
        // Heure LOCALE : c'est ce que le navigateur affichera, sans décalage à compenser.
        committed_date: new Date(`${LE_JOUR}T${heure}:00`).toISOString(),
        web_url: `https://gitlab.test/${projet}/-/commit/abc1234`,
      }];
    }

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(app.base);
    await page.locator('[data-tab="dashboard"]').click();
    await page.waitForSelector('#dashTop5 table tbody tr');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const lignes = () => page.$$eval('#dashTop5 table tbody tr',
    (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));

  test('chaque ligne porte la date ET l’heure du dernier commit', async () => {
    const rows = await lignes();
    assert.equal(rows.length, POUSSES.length);
    for (const [projet, quand] of rows) {
      assert.match(quand, /\d{2}[/.]\d{2}[/.]\d{4}.*\d{2}[:h]\d{2}/,
        `${projet} : date et heure attendues, vu « ${quand} »`);
    }
  });

  test('l’heure affichée est celle du commit, et elle explique l’ordre', async () => {
    const rows = await lignes();
    // Le classement va du plus récent au plus ancien…
    assert.deepEqual(rows.map((r) => r[0]), ['grp/tard', 'grp/midi', 'grp/tot']);
    // …et l'heure lue à l'écran le justifie, au lieu de trois fois la même date.
    const heures = rows.map((r) => (r[1].match(/(\d{2})[:h](\d{2})/) || []).slice(1).join(':'));
    assert.deepEqual(heures, ['17:45', '12:30', '08:12'],
      'sans l’heure, trois dépôts du même jour donnent un rang inexplicable');
  });
});
