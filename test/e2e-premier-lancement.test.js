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

  /* LE DÉCROCHAGE LE PLUS GRAVE : on saisit l'URL et le jeton, on clique « Tester la
     connexion » — le bouton le plus engageant de l'écran — et on se fait répondre que le
     jeton n'est pas configuré. Le test doit porter sur CE QUI EST À L'ÉCRAN. */
  test('« Tester la connexion » teste le formulaire, et dit quoi faire quand il est vide', async () => {
    await page.locator('#toReviewList [data-empty-act="go-config"]').click();
    await page.waitForSelector('#btnTestGitlab', { timeout: ATTENTE });

    await page.locator('#btnTestGitlab').click();
    await page.waitForSelector('#toasts .toast', { timeout: ATTENTE });
    assert.match(await page.locator('#toasts .toast').first().innerText(), /Renseigne/i,
      'champs vides : on dit quoi faire, on n’expose pas une catégorie interne');

    await page.locator('input[name="gitlab_url"]').fill(app.gitlabUrl);
    await page.locator('input[name="access_token"]').fill(app.state.token);
    await page.locator('#btnTestGitlab').click();
    // Le témoin est le message de succès, pas l'absence d'erreur : il porte le nombre de projets.
    await page.waitForFunction(
      () => /\d/.test(document.querySelector('#configInfoGit')?.textContent || ''),
      null, { timeout: ATTENTE },
    );
    assert.match(await page.locator('#configInfoGit').innerText(), /projet/i);
    assert.equal((await app.api('GET', '/api/config')).body.gitlab_url, '',
      'tester n’enregistre rien — sinon le bouton « Enregistrer » ne voudrait plus rien dire');
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
