'use strict';
/* LES CINQ PREMIÈRES MINUTES, dans un vrai navigateur.
 *
 * Une base vierge, aucun jeton, aucun dépôt. Ce fichier éprouve ce que voit quelqu'un qui
 * ouvre Mergerie pour la première fois — le seul parcours qu'aucun test ne couvrait, et
 * celui où trois défauts se sont accumulés : l'application ouvrait sur le brief du matin (qui
 * annonce « rien ne réclame ton attention » à qui n'a rien branché), « Tester la connexion »
 * lisait la configuration enregistrée au lieu du formulaire, et les étapes de l'assistant ne
 * se cochaient jamais.
 *
 * Un seul `startApp()` : le harnais démarre le serveur EN PROCESSUS, un second appel dans le
 * même fichier attend un « listening » qui ne viendra pas.
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

const ATTENTE = 20000;

describe('Premier lancement', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    /* PAS de `configure()` : c'est tout l'objet du fichier. On pose seulement `brief_on_open`
       à '1' — sa valeur par défaut dans l'application — pour éprouver que le brief NE prend
       PAS la main quand rien n'est configuré. Le harnais le met à '0' d'ordinaire, ce qui
       aurait masqué le défaut. */
    await app.api('PUT', '/api/config', { brief_on_open: '1' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('rien de configuré : on ouvre sur Reviews et son assistant, pas sur le brief', async () => {
    await page.waitForSelector('#tab-review.active', { timeout: ATTENTE });
    assert.equal(await page.locator('#tab-notes').evaluate((e) => e.classList.contains('active')), false,
      'le brief du matin est le bon écran d’accueil à partir du deuxième jour, pas à la première seconde');

    await page.waitForSelector('#toReviewList .steps', { timeout: ATTENTE });
    assert.equal(await page.locator('#toReviewList .step').count(), 3, 'les trois étapes de démarrage');
    assert.equal(await page.locator('#toReviewList .step.done').count(), 0, 'rien n’est fait, rien n’est coché');
  });

  /* TROIS CARTES GRISES PLUTÔT QU'UN BLANC MUET. Le squelette était posé par le JavaScript,
     au moment où partait la requête des merge requests — mais celle-ci ne part qu'APRÈS la
     configuration, qui décide de l'onglet à ouvrir. Sur une instance lente, cela laissait
     plusieurs secondes de vide : mesuré à 400, 900, 1600, 2600 et 3600 ms, la zone de liste
     ne contenait rien du tout. Il est désormais écrit dans le HTML, donc à l'écran dès le
     premier rendu, avant la moindre réponse du serveur. */
  test('la file montre un squelette avant même la première réponse du serveur', async () => {
    let liberer;
    const feuVert = new Promise((r) => { liberer = r; });
    await page.route('**/api/**', async (route) => {
      await feuVert;
      await route.continue().catch(() => { /* page déjà partie */ });
    });
    await page.goto(app.base, { waitUntil: 'domcontentloaded' });

    /* Aucune réponse n'est encore arrivée — c'est tout l'objet du test : ce qu'on voit à cet
       instant ne peut venir que du HTML. */
    assert.equal(await page.locator('#toReviewList .sk').count(), 3,
      'trois cartes fantômes, pas un blanc');
    assert.equal(await page.locator('#reportList .sk').count(), 3);

    liberer();
    await page.unroute('**/api/**').catch(() => {});
    /* Et il laisse la place : ici la base est vierge, donc c'est l'assistant qui vient. */
    await page.waitForSelector('#toReviewList .steps', { timeout: ATTENTE });
    assert.equal(await page.locator('#toReviewList .sk').count(), 0,
      'le squelette ne doit pas rester coincé par-dessus le contenu réel');
  });

  /* LA CONFIGURATION RÉPOND AVANT LA FILE. C'est le cas courant — trois petites requêtes
     contre une liste de merge requests — et l'assistant de démarrage redessine la file dès
     qu'il connaît l'état. Sans garde, il concluait « aucune merge request » sur une liste
     qu'on n'avait pas encore reçue : le squelette laissait place à un écran d'accueil qui
     mentait, puis les cartes arrivaient. Mesuré : sans le garde, l'assistant s'affiche à
     1,5 s alors que la file n'a pas répondu. */
  test('un écran d’accueil ne s’affiche pas à la place d’une file encore en vol', async () => {
    let libererMrs;
    const feuVertMrs = new Promise((r) => { libererMrs = r; });
    await page.route('**/api/mrs**', async (route) => {
      await feuVertMrs;
      await route.continue().catch(() => { /* page déjà partie */ });
    });
    await page.goto(app.base, { waitUntil: 'domcontentloaded' });

    /* Le reste de l'API répond normalement. Le témoin que les petites requêtes SONT revenues :
       les compteurs de segment ont quitté leur état d'attente — ils viennent de `/api/stats`,
       de la même famille que celles qui alimentent l'assistant. */
    await page.waitForFunction(
      () => [...document.querySelectorAll('#tab-review .segmented .seg-count')]
        .every((e) => !e.classList.contains('is-waiting')),
      null, { timeout: ATTENTE },
    );
    await page.waitForSelector('#toReviewList .sk', { timeout: ATTENTE });
    assert.equal(await page.locator('#toReviewList .steps').count(), 0,
      'tant que la file n’a pas répondu, on ne conclut rien sur son contenu');

    libererMrs();
    await page.unroute('**/api/mrs**').catch(() => {});
    await page.waitForSelector('#toReviewList .steps', { timeout: ATTENTE });
  });

  /* Le compteur affichait « 0 » pendant que la requête était en vol : sur une instance lente,
     on lit « rien à traiter » et on conclut que la recherche n'a rien trouvé. On RALENTIT donc
     `/api/stats` pour observer l'état d'attente — sans quoi le test ne prouverait que l'état
     d'après, qui n'a jamais été en cause. */
  test('pendant que la donnée est en vol, le compteur ne dit rien', async () => {
    /* On BLOQUE `/api/stats` jusqu'à un feu vert donné par le test, plutôt que de le retarder
       d'un délai : un délai est un pari sur la vitesse de la machine (sous charge, la réponse
       arrivait avant l'observation), et une route encore endormie au moment de la retirer
       tente de reprendre une requête déjà traitée — « Route is already handled », levé hors
       du test, qui fait tomber tout le fichier. Ici, au feu vert, plus rien ne dort. */
    let liberer;
    const feuVert = new Promise((r) => { liberer = r; });
    await page.route('**/api/stats', async (route) => {
      await feuVert;
      await route.continue().catch(() => { /* page ou route déjà partie */ });
    });
    await page.reload();
    await page.waitForSelector('#tab-review.active', { timeout: ATTENTE });
    const pendant = await page.evaluate(() => [...document.querySelectorAll('#tab-review .segmented .seg-count')]
      .map((s) => s.textContent.trim()));
    assert.deepEqual(pendant, ['', '', ''],
      'affirmer « 0 » avant d’avoir la réponse, c’est dire « rien à traiter » à quelqu’un qui a onze merge requests');

    liberer();
    await page.waitForFunction(
      () => [...document.querySelectorAll('#tab-review .segmented .seg-count')].every((s) => s.textContent.trim() !== ''),
      null, { timeout: ATTENTE },
    );
    await page.unroute('**/api/stats').catch(() => { /* rien à retirer */ });
  });

  test('un compteur ne s’affiche pas avant sa donnée', async () => {
    const vide = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('#tab-review .segmented .seg-count')];
      return spans.map((s) => ({ texte: s.textContent.trim(), attente: s.classList.contains('is-waiting') }));
    });
    // Ici la donnée EST arrivée (funnel à zéro) : ce qu'on vérifie est qu'elle a bien été
    // posée, et que la classe d'attente a été retirée — c'est elle qui masquait le chiffre.
    assert.ok(vide.every((s) => !s.attente), 'la classe d’attente est retirée quand la donnée arrive');
    assert.deepEqual(vide.map((s) => s.texte), ['0', '0', '0'], 'et le vrai zéro, lui, s’affiche');
  });

  /* LE DÉCROCHAGE LE PLUS GRAVE : on saisit l'URL et le jeton, on clique le bouton le plus
     engageant de l'écran — et on se fait répondre que le jeton n'est pas configuré. Le test
     doit porter sur CE QUI EST À L'ÉCRAN. Et l'arrivée depuis l'assistant pose le curseur :
     l'écran changeait sans que le curseur suive, il fallait viser le premier champ. */
  test('« Enregistrer et tester » part du formulaire, et dit sous le champ ce qui manque', async () => {
    await page.locator('#toReviewList [data-empty-act="go-config"]').click();
    await page.waitForSelector('#btnTestGitlab', { timeout: ATTENTE });
    assert.equal(await page.evaluate(() => document.activeElement.name), 'gitlab_url',
      'on arrive sur le champ, pas sur un bouton qui n’existe plus');

    await page.locator('#btnTestGitlab').click();
    await page.waitForSelector('#sub-gitcfg .field-error', { timeout: ATTENTE });
    assert.match(await page.locator('#sub-gitcfg .field-error').first().innerText(), /Renseigne/i,
      'champs vides : on dit quoi faire, sous le champ, sans exposer de catégorie interne');
    assert.equal(await page.locator('#toasts .toast').count(), 0,
      'une erreur de champ n’est pas un toast : le toast annonce un RÉSULTAT d’action');

    await page.locator('input[name="gitlab_url"]').fill(app.gitlabUrl);
    await page.locator('input[name="access_token"]').fill(app.state.token);
    await page.locator('#btnTestGitlab').click();
    // Le témoin est le message de succès, pas l'absence d'erreur : il porte le nombre de projets.
    await page.waitForFunction(
      () => /\d/.test(document.querySelector('#configInfoGit')?.textContent || ''),
      null, { timeout: ATTENTE },
    );
    assert.match(await page.locator('#configInfoGit').innerText(), /projet/i);
    /* LE PARCOURS NOMINAL EN UN CLIC : le bouton principal ENREGISTRE puis teste. Deux boutons
       de même poids laissaient le choix de l'ordre — et tester sans enregistrer donnait un vert
       qui ne survivait pas au rechargement. « Enregistrer seulement » reste à côté. */
    assert.equal((await app.api('GET', '/api/config')).body.gitlab_url, app.gitlabUrl,
      '« Enregistrer et tester » fait bien les deux');
  });

  test('l’étape 1 se coche dès que la connexion est enregistrée', async () => {
    await page.locator('#sub-gitcfg button[type="submit"]').first().click();
    await page.waitForFunction(
      () => /enregistr|saved/i.test(document.querySelector('#configInfoGit')?.textContent || ''),
      null, { timeout: ATTENTE },
    );
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#toReviewList .steps', { timeout: ATTENTE });
    /* On attend le RÉSULTAT, pas un délai : l'assistant se redessine après une relecture de
       l'état, qui est une requête. */
    await page.waitForFunction(
      () => document.querySelectorAll('#toReviewList .step.done').length === 1,
      null, { timeout: ATTENTE },
    );
    const premiere = page.locator('#toReviewList .step').first();
    assert.equal(await premiere.evaluate((e) => e.classList.contains('done')), true,
      'trois boutons sans progression ne sont pas un assistant');
    assert.equal(await premiere.locator('button').count(), 0,
      'une étape faite ne propose plus de la faire');
  });

  test('l’onglet Git sans dépôt suivi montre un vide guidé, pas trois impasses', async () => {
    /* AVANT le test qui ajoute un dépôt : c'est justement l'écran « aucun dépôt suivi » qu'on
       éprouve. Il affichait une ligne de projet désactivée portant « (ajoute d'abord un dépôt) »,
       un combo de branches bloqué sur « chargement… » et un bouton « Vérifier une branche » seul
       en haut — trois impasses au lieu d'une porte. */
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#gitNoRepo .empty', { timeout: ATTENTE });
    assert.match(await page.locator('#gitNoRepo .empty-t').textContent(), /Aucun dépôt suivi/);
    assert.equal(await page.locator('#gitNoRepo [data-empty-act="go-repos"]').count(), 1,
      'et la porte est là : Réglages → Dépôts');
    assert.equal(await page.locator('#gsub-actions .form').evaluate((e) => e.hidden), true,
      'le formulaire disparaît avec ses impasses : deux réponses à la même question en font une de trop');
    /* « Vérifier une branche » a quitté le haut de l'écran pour la rangée d'actions, à côté de
       « Prévisualiser » : un bouton se lit avec ce sur quoi il porte. */
    assert.equal(await page.locator('#gsub-actions .form-actions #btnVerifyBranch').count(), 1);
  });

  test('l’étape 2 se coche dès qu’un dépôt est ajouté', async () => {
    await app.api('POST', '/api/repos', { url: `${app.gitlabUrl}/grp/app.git`, branch_pattern: '' });
    /* On passe par l'écran, comme l'utilisateur : c'est l'ouverture de Réglages → Dépôts qui
       relit la liste, et c'est ce chemin-là qui doit tenir l'assistant à jour. */
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('[data-sub="repos"]').click();
    await page.waitForSelector('#repoList .repo-row', { timeout: ATTENTE });
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('#toReviewList .step.done').length === 2,
      null, { timeout: ATTENTE },
    );
    assert.equal(await page.locator('#toReviewList .step.done').count(), 2);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
