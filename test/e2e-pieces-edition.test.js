'use strict';
/* CE QU'ON VOIT DE SES PIÈCES JOINTES QUAND ON ROUVRE UNE SESSION.
 *
 * Le défaut, vu à l'usage : on joint un fichier à une session de codage, on rouvre la session
 * en édition… et la pièce n'y est pas. Le formulaire n'en disait qu'une PHRASE — « 2 captures
 * déjà jointes » — sans dire lesquelles : impossible de vérifier qu'on a joint le bon devis,
 * de le rouvrir, ni d'en retirer un qui n'avait rien à faire là.
 *
 * Le formulaire est le MÊME pour les quatre saveurs, mais chacune a sa relecture : codage et
 * exploration passent par `openTaskEdit`, le hors dépôt par `openLocalTaskEdit`, la question
 * libre par `openQuestionEdit`. Prouver l'API ne prouve donc rien de l'écran, et prouver une
 * saveur ne prouve rien des autres — d'où ce fichier, qui ouvre vraiment les trois écrans.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 devis').toString('base64')}`;

const { dispo } = navigateurDispo();

describe('Pièces jointes : ce que montre le formulaire d’édition', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo; let codage; let horsDepot; let question; let dossier;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    repo = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body;

    codage = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Applique les règles de remise du devis', label: 'Remises',
      files: [{ name: 'devis-client.pdf', data: PDF }, { name: 'maquette.png', data: PNG }],
      targets: [{ repo_id: repo.id, branch: 'feat/remise', base_branch: 'main' }],
    })).body;

    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    dossier = path.join(racine, 'outil');
    fs.mkdirSync(dossier, { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    horsDepot = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Range selon le tableau', dirs: [dossier], files: [{ name: 'tableau.csv', data: PDF.replace('application/pdf', 'text/csv').replace('.pdf', '') }],
    })).body;

    question = (await app.api('POST', '/api/questions', {
      prompt: 'Ce contrat est-il compatible avec notre licence ?',
      files: [{ name: 'contrat.pdf', data: PDF }],
    })).body;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#taskList .card');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const pieces = (scope, id) => app.db
    .prepare('SELECT * FROM piece_jointe WHERE scope = ? AND owner_id = ? ORDER BY id').all(scope, id);

  const allerA = async (kind, liste) => {
    if (await page.locator('#taskModal:not([hidden])').count()) {
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    }
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForSelector(`${liste} .card`);
  };
  // Le formulaire est prêt quand le prompt de la session relue est arrivé dedans.
  const attendreFormulaire = async () => {
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#taskForm [name="prompt"]').value !== '');
  };

  test('codage : les pièces s’affichent pour de vrai, s’ouvrent, et se retirent', async () => {
    await allerA('code', '#taskList');
    await page.locator(`#taskList .card[data-task="${codage.id}"] [data-tedit]`).click();
    await attendreFormulaire();

    await page.waitForSelector('#taskPieces .task-prev');
    assert.equal(await page.locator('#taskPieces .task-prev').count(), 2, 'les DEUX pièces sont là');
    /* Un document n'a pas de vignette : c'est son NOM qui l'identifie — et c'est le nom
       d'origine, pas `pj_1.pdf`, qui est aussi ce que l'agent recevra. */
    assert.deepEqual(await page.locator('#taskPieces .task-prev-nom').allTextContents(), ['devis-client.pdf'],
      'le document est nommé');
    assert.equal(await page.locator('#taskPieces img').count(), 1, 'et l’image est une vignette');

    // La vignette ne « s'affiche » vraiment que si la route sert le fichier.
    const src = await page.locator('#taskPieces img').first().getAttribute('src');
    const idImage = pieces('task', codage.id).find((p) => p.name === 'maquette.png').id;
    assert.equal(src, `/api/pieces/task/${idImage}`);
    const servi = await page.request.get(app.base + src);
    assert.equal(servi.status(), 200);
    assert.match(servi.headers()['content-type'] || '', /image\/png/);
    assert.match(servi.headers()['content-disposition'] || '', /maquette\.png/,
      'le nom d’origine suit le fichier : « pj_2.pdf » ne dit rien à qui l’enregistre');
    /* Le décodage n'est pas instantané : on ATTEND qu'il ait eu lieu — l'affirmer dans la
       foulée du rendu serait un pari sur la vitesse de la machine. */
    await page.waitForFunction(() => {
      const im = document.querySelector('#taskPieces img');
      return !!im && im.complete && im.naturalWidth > 0;
    }, null, { timeout: 10000 });

    /* RETIRER. Le fichier part du disque : c'est irréversible, donc on demande — et on ne
       vérifie pas le message, on vérifie qu'il ne reste rien. */
    const pj = pieces('task', codage.id).find((p) => p.name === 'devis-client.pdf');
    const chemin = pj.path;
    await page.locator(`#taskPieces [data-rmpj="${pj.id}"]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskPieces .task-prev').length === 2);
    assert.equal(pieces('task', codage.id).length, 2, 'renoncer ne retire rien');

    await page.locator(`#taskPieces [data-rmpj="${pj.id}"]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskPieces .task-prev').length === 1);
    assert.equal(pieces('task', codage.id).length, 1, 'la ligne est partie');
    assert.ok(!fs.existsSync(chemin), '…et le fichier avec : une pièce détachée resterait invisible pour toujours');
    assert.deepEqual(erreurs, []);
  });

  /* Une pièce arrivée AVEC UN SUIVI n'appartient pas à la consigne qu'on est en train de
     modifier : elle se voit, mais elle se distingue. */
  test('une pièce de suivi est montrée comme telle', async () => {
    await app.api('POST', `/api/tasks/${codage.id}/followup`, {
      instruction: 'Vois le retour', files: [{ name: 'retour.pdf', data: PDF }],
    });
    await allerA('code', '#taskList');
    await page.locator(`#taskList .card[data-task="${codage.id}"] [data-tedit]`).click();
    await attendreFormulaire();
    await page.waitForFunction(() => document.querySelectorAll('#taskPieces .task-prev').length === 2);
    const suivi = page.locator('#taskPieces .task-prev-suivi');
    assert.equal(await suivi.count(), 1, 'seule celle du suivi est marquée');
    assert.match(await suivi.getAttribute('title'), /retour\.pdf/);
    assert.match(await suivi.getAttribute('title'), /suivi/i, 'et le titre dit d’où elle vient');
  });

  /* Le hors dépôt a SA relecture (`openLocalTaskEdit`) et SA route : le codage peut très bien
     afficher ses pièces pendant que celui-ci n'affiche rien. */
  test('hors dépôt : la pièce est là, servie par la route de sa saveur', async () => {
    await allerA('local', '#localList');
    await page.locator(`#localList .card[data-local="${horsDepot.id}"] [data-ledit]`).click();
    await attendreFormulaire();
    await page.waitForSelector('#taskPieces .task-prev');
    assert.deepEqual(await page.locator('#taskPieces .task-prev-nom').allTextContents(), ['tableau.csv']);
    const href = await page.locator('#taskPieces a').first().getAttribute('href');
    assert.equal(href, `/api/pieces/local/${pieces('local', horsDepot.id)[0].id}`,
      'la saveur voyage dans l’adresse : « task » servirait la pièce d’une autre session');
    assert.equal((await page.request.get(app.base + href)).status(), 200);
    assert.deepEqual(erreurs, []);
  });

  test('question libre : elle aussi montre son document', async () => {
    await allerA('ask', '#askList');
    await page.locator(`#askList .card[data-ask="${question.id}"] [data-qedit]`).click();
    await attendreFormulaire();
    await page.waitForSelector('#taskPieces .task-prev');
    assert.deepEqual(await page.locator('#taskPieces .task-prev-nom').allTextContents(), ['contrat.pdf']);
    assert.equal(await page.locator('#taskPieces a').first().getAttribute('href'),
      `/api/pieces/ask/${pieces('ask', question.id)[0].id}`);
    assert.deepEqual(erreurs, []);
  });

  /* Une session NEUVE ne montre les pièces de personne : le bloc est partagé, et un formulaire
     rouvert derrière une édition garderait sinon les vignettes de la session précédente. */
  test('créer une session part d’un formulaire vide', async () => {
    await allerA('code', '#taskList');
    await page.locator(`#taskList .card[data-task="${codage.id}"] [data-tedit]`).click();
    await attendreFormulaire();
    await page.waitForSelector('#taskPieces .task-prev');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal(await page.locator('#taskPieces .task-prev').count(), 0,
      'les pièces de la session qu’on vient de quitter ne suivent pas');
    assert.deepEqual(erreurs, []);
  });
});
