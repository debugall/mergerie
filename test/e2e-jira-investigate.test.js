'use strict';
/* « ENQUÊTER » DEPUIS UN TICKET JIRA.
 *
 * Une trace arrive dans un ticket : « quel dépôt ? quel fichier ? » se répondait au `grep -r`
 * dans douze clones. Le bouton n'apparaît QUE si le texte du ticket porte réellement une
 * trace — sinon c'est un bouton qui ne sert à rien sur les neuf tickets sur dix, et un bouton
 * inutile finit par être ignoré même le jour où il servirait.
 *
 * Le test prouve les deux côtés : il est là quand il faut, absent sinon. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-inv-home-'));

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

const TRACE = [
  'Depuis ce matin en production :',
  '',
  'TypeError: Cannot read property "items" of undefined',
  '    at CartSession.restore (src/cart/session.js:118)',
  '    at Object.handler (src/http/routes.js:42)',
].join('\n');

describe('Jira → Enquêter', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
    app.state.jiraIssues['INC-1'] = {
      key: 'INC-1',
      fields: { summary: 'Le panier plante à la reconnexion', status: etat('À faire', 'new'), description: TRACE, issuetype: { name: 'Bug' } },
    };
    app.state.jiraIssues['INC-2'] = {
      key: 'INC-2',
      fields: { summary: 'Renommer le bouton « Valider »', status: etat('À faire', 'new'), description: 'Le libellé prête à confusion, on préfère « Commander ».', issuetype: { name: 'Tâche' } },
    };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' });
    await app.api('POST', '/api/jira/watch', { key: 'INC-1' });
    await app.api('POST', '/api/jira/watch', { key: 'INC-2' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrir = async (cle) => {
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.waitForSelector('#jiraWatchList .jira-item');
    await page.locator(`#jiraWatchList [data-jirawatchopen="${cle}"]`).click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    await page.waitForFunction((k) => {
      const d = document.querySelector('#jiraWatchDetail');
      return d && d.textContent.includes(k);
    }, cle);
  };

  test('un ticket qui porte une trace propose « Enquêter »', async () => {
    await ouvrir('INC-1');
    assert.equal(await page.locator('#jiraWatchDetail .btn-jira-investigate').count(), 1);
  });

  test('un ticket sans trace ne le propose pas', async () => {
    // Un bouton présent partout serait un bouton qu'on n'utilise nulle part.
    await ouvrir('INC-2');
    assert.equal(await page.locator('#jiraWatchDetail .btn-jira-investigate').count(), 0);
  });

  test('le bouton ouvre la session portée par l’enquêteur, avec le texte du ticket', async () => {
    await ouvrir('INC-1');
    await page.locator('#jiraWatchDetail .btn-jira-investigate').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => /INC-1/.test(document.querySelector('#taskPrompt').value));
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.match(prompt, /CartSession\.restore/, 'la trace doit partir avec la demande');
    const agent = await page.locator('#taskAgentBox [data-combo="taskAgentVal"]').inputValue();
    assert.match(agent, /Enquêteur/);
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
