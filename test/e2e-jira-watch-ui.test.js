'use strict';
/* Jira → Surveillés : lire le ticket sans quitter Mergerie.
 *
 * Le détail est le MÊME panneau que sous « Mes tickets », avec les mêmes actions. Ce qui se
 * teste ici n'est donc pas son contenu — déjà couvert — mais qu'il s'affiche au bon endroit,
 * qu'il ne perturbe pas les contrôles de la carte (retirer, modifier la raison), et que les
 * actions du détail rechargent le panneau où l'on est, pas l'autre.
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

describe('Jira · Surveillés — le ticket s’ouvre à droite', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
    for (const [cle, titre] of [['WATCH-1', 'Migrer les logs'], ['WATCH-2', 'Refondre le panier']]) {
      app.state.jiraIssues[cle] = {
        key: cle,
        fields: {
          summary: titre,
          status: etat('À faire', 'new'),
          description: `Description de ${cle} — ce que le ticket demande.`,
          issuetype: { name: 'Tâche' },
        },
      };
    }
    // Le faux Jira est servi par le même serveur mock que GitLab (cf. helpers/app).
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-1', note: 'bloque la facturation' });
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-2' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function ouvrirSurveilles() {
    await page.reload();
    await page.locator('[data-tab="jira"]').click();
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.waitForSelector('#jiraWatchList .jira-item');
  }

  test('sélectionner un ticket affiche son contenu à droite', async () => {
    await ouvrirSurveilles();
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'rien n’est affiché tant qu’on n’a rien choisi');

    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    const detail = await page.locator('#jiraWatchDetail').textContent();
    assert.match(detail, /WATCH-1/);
    assert.match(detail, /Migrer les logs/);
    assert.match(detail, /ce que le ticket demande/, 'la description est là, pas seulement le titre');

    // La carte choisie se distingue : sans repère, on ne sait plus ce qu'on lit.
    const actives = await page.$$eval('#jiraWatchList .jira-item.active', (n) => n.map((x) => x.dataset.jirawatchopen));
    assert.deepEqual(actives, ['WATCH-1']);
  });

  test('choisir un autre ticket remplace le contenu affiché', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    await page.locator('#jiraWatchList .jira-item').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#jiraWatchDetail').textContent.includes('WATCH-2'));
    const detail = await page.locator('#jiraWatchDetail').textContent();
    assert.match(detail, /Refondre le panier/);
    assert.ok(!detail.includes('Migrer les logs'), 'le ticket précédent ne doit pas rester affiché');
    const actives = await page.$$eval('#jiraWatchList .jira-item.active', (n) => n.map((x) => x.dataset.jirawatchopen));
    assert.deepEqual(actives, ['WATCH-2'], 'un seul ticket sélectionné à la fois');
  });

  /* La carte porte ses propres contrôles. Cliquer dessus ne doit pas se transformer en
     sélection : ouvrir le formulaire de raison chargerait alors le ticket par surprise. */
  test('les contrôles de la carte gardent leur effet', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList [data-jiranote]').first().click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#jiraWatchList .jira-note-form:not([hidden])').count(), 1,
      'le crayon ouvre bien le champ de raison');
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'et ne charge pas le ticket au passage');

    /* Le champ lui-même est DANS la carte : cliquer dedans pour corriger sa raison ne doit
       pas déclencher le chargement du ticket. C'est ce que l'exclusion des contrôles protège. */
    await page.locator('#jiraWatchList .jira-note-input').first().click();
    await page.keyboard.type(' (précisé)');
    await page.waitForTimeout(300);
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'écrire dans la raison n’ouvre pas le ticket');
    assert.equal(await page.locator('#jiraWatchList .jira-item.active').count(), 0,
      '…et ne sélectionne rien');
  });

  test('retirer le ticket affiché vide le panneau de droite', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    await page.locator('#jiraWatchList [data-jiraunwatch]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#jiraWatchList .jira-item').length === 1);
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'garder à l’écran le détail d’un ticket qu’on ne suit plus n’aurait pas de sens');
  });

  /* Les deux sous-onglets ont chacun leur sélection : revenir sur « Mes tickets » ne doit pas
     hériter du ticket qu'on lisait dans « Surveillés », ni l'inverse. */
  test('les deux panneaux gardent leur propre sélection', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    const cote = await page.locator('#jiraWatchDetail').textContent();

    await page.locator('#tab-jira .subnav [data-jsub="mine"]').click();
    await page.waitForTimeout(400);
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#jiraWatchDetail').textContent(), cote,
      'le ticket lu dans « Surveillés » est toujours là au retour');
  });
});
