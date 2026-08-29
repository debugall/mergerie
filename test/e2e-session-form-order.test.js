'use strict';
/* L'ORDRE DES CHAMPS DU FORMULAIRE DE SESSION, DANS SES QUATRE SAVEURS.
 *
 * Le formulaire est unique et se réarrange par saveur : codage, hors dépôt, exploration,
 * question libre. Il raconte quatre choses, et l'ordre EST le propos —
 *
 *   1. OÙ            projets et branches, ou répertoire et dossiers (et l'avertissement
 *                    « en place », qui qualifie ce choix-là) ;
 *   2. QUOI          le ticket Jira qui remplit le prompt, le prompt, les pièces jointes,
 *                    puis le libellé — facultatif, donc après ce qu'il résume ;
 *   3. COMMENT       les options qui portent sur la passe : questions, reprise de session ;
 *   4. APRÈS         ce qui arrive une fois le code écrit : commit, push, vérification.
 *
 * Un champ qui remonte ou qui descend d'un cran ne casse rien et ne se voit dans aucun autre
 * test : c'est exactement ce qui laisse un formulaire redevenir une pile de champs.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Formulaire de session : l’ordre des champs', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    // Jira configuré : sans lui, la ligne « enrichir depuis un ticket » ne s'affiche pas et
    // le test ne prouverait rien de sa place.
    await app.configure({ jira_url: 'https://jira.test', jira_email: 'moi@test', jira_token: 'x' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' });
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(racine, 'outil'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#tab-task .subnav [data-kind="code"]', { state: 'visible' });
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Ce que l'écran montre, de haut en bas, sans les champs masqués. On désigne chaque bloc par
     son `id` ou le `name` de son champ — un libellé traduit changerait avec la langue, un
     intertitre est identifié par sa CLÉ de traduction pour la même raison. */
  const ordreAffiche = async (kind) => {
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    const vu = await page.evaluate(() => {
      const out = [];
      const cle = (el) => {
        if (el.dataset && el.classList.contains('form-group-title')) return `groupe:${el.dataset.i18n}`;
        if (el.id) return el.id;
        const champ = el.querySelector('[name]');
        return champ ? champ.name : el.className;
      };
      const marche = (parent) => {
        for (const el of parent.children) {
          if (el.hidden || el.getClientRects().length === 0) continue;
          if (el.id === 'taskAgentFields' || el.id === 'codeOnlyFields') { marche(el); continue; }
          if (el.classList.contains('modal-actions')) continue;
          out.push(cle(el));
        }
      };
      marche(document.querySelector('#taskForm'));
      return out;
    });
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    return vu;
  };

  test('codage : où → quoi → comment l’IA travaille → une fois le code écrit', async () => {
    assert.deepEqual(await ordreAffiche('code'), [
      'taskReposWrap',                 // OÙ
      'taskJiraRow',                   // QUOI : le ticket remplit le prompt, il le précède
      'prompt',
      'taskImages',
      'label',                         // facultatif : après ce qu'il résume
      'groupe:task.group.agent',       // COMMENT
      'taskAskQuestionsRow',
      'taskSessionRow',
      'groupe:task.group.after',       // APRÈS
      'commit_message',
      'auto_push',
      'verifier_id',
    ]);
    assert.deepEqual(erreurs, []);
  });

  /* Hors dépôt : l'avertissement « l'IA modifie en place, sans commit » suit le choix des
     dossiers qu'il qualifie. Lu en bas du formulaire, il arrivait après la décision. */
  test('hors dépôt : l’avertissement suit le choix des dossiers', async () => {
    const ordre = await ordreAffiche('local');
    assert.deepEqual(ordre, [
      'taskLocalWrap',
      'taskLocalWarn',
      'prompt',
      'taskImages',
      'label',
      'groupe:task.group.agent',
      'taskAskQuestionsRow',
      'taskSessionRow',
    ]);
    assert.ok(ordre.indexOf('taskLocalWarn') < ordre.indexOf('prompt'),
      'on prévient AVANT de faire écrire la demande, pas après');
    assert.ok(!ordre.includes('taskJiraRow'), 'pas de ticket Jira hors dépôt : il n’y a pas de branche');
  });

  test('exploration : rien de ce qui suppose un commit', async () => {
    const ordre = await ordreAffiche('explore');
    assert.deepEqual(ordre, [
      'taskReposWrap',
      'taskJiraRow',
      'prompt',
      'taskImages',
      'label',
      'groupe:task.group.agent',
      'taskAskQuestionsRow',
      'taskSessionRow',
    ]);
    assert.ok(!ordre.includes('groupe:task.group.after'),
      'une exploration ne commite rien : le groupe entier disparaît, intertitre compris');
  });

  /* La question libre n'a ni cible, ni passe sur un dépôt : il ne reste que la demande. Un
     intertitre « comment l'IA travaille » qui surmonterait le vide serait pire que rien. */
  test('question libre : la demande, et rien d’autre', async () => {
    assert.deepEqual(await ordreAffiche('ask'), ['prompt', 'taskImages', 'label']);
    assert.deepEqual(erreurs, []);
  });
});
