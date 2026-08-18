'use strict';
/* LES ITÉRATIONS D'UN RETOUR D'AGENT, EN COLONNE.
 *
 * Une session s'itère : lancement, corrections demandées, reprises après questions. Chaque
 * itération garde le prompt envoyé ET le retour obtenu. Tant que ça vivait dans une liste
 * déroulante, il fallait ouvrir le menu pour savoir ce qu'il contenait, et on ne retrouvait
 * une itération que par son numéro — c'est-à-dire pas du tout : ce dont on se souvient, c'est
 * de ce qu'on a DEMANDÉ.
 *
 * Ce fichier surveille donc ce qui a changé de nature :
 *
 *   1. les itérations sont visibles d'un coup, à gauche, avec leur demande ;
 *   2. en choisir une affiche SON contenu à droite, sans refermer la vue ;
 *   3. la recherche porte sur ce que l'utilisateur a écrit, MASQUE au lieu de retirer, et
 *      survit au changement d'itération — sinon chaque clic rouvrirait la liste entière ;
 *   4. une seule itération n'affiche aucune colonne : il n'y a rien à choisir.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Retour de l’IA · itérations', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let multi; let seule;
  const erreurs = [];

  const mkdir = () => fs.mkdtempSync(path.join(app.dataDir, 'pdir-'));

  before(async () => {
    app = await startApp();
    await app.configure();

    /* Une session à TROIS itérations : le lancement, puis deux corrections dont les demandes
       n'ont aucun mot en commun — c'est ce qui rend la recherche vérifiable. */
    multi = (await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports du dossier', dirs: [mkdir()] })).body;
    await app.api('POST', `/api/local-tasks/${multi.id}/run`);
    await waitForJobs(app.api);
    for (const instruction of ['Renomme la variable compteur en total', 'Ajoute un test sur le parseur CSV']) {
      await app.api('POST', `/api/local-tasks/${multi.id}/followup`, { instruction });
      await waitForJobs(app.api);
    }
    // …et une session lancée UNE fois, pour le cas où il n'y a rien à choisir.
    seule = (await app.api('POST', '/api/local-tasks', { prompt: 'Une seule passe', dirs: [mkdir()] })).body;
    await app.api('POST', `/api/local-tasks/${seule.id}/run`);
    await waitForJobs(app.api);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector('#localList .card');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const items = () => page.locator('#taskPassList .pass-item');

  async function ouvrirRetour(id) {
    if (await page.locator('#taskMdView').isVisible()) await page.locator('#taskMdClose').click();
    await page.locator(`#localList .card[data-local="${id}"] [data-lout]`).click();
    await page.waitForSelector('#taskMdView:not([hidden])');
  }

  test('les itérations sont une liste à gauche, chacune avec sa demande', async () => {
    await ouvrirRetour(multi.id);
    await page.waitForSelector('#taskPassAside:not([hidden])');
    // La liste déroulante d'avant n'existe plus : ce serait deux commandes pour un seul choix.
    assert.equal(await page.locator('#taskPassVersion').count(), 0);

    const textes = await items().allTextContents();
    assert.equal(textes.length, 3, `trois itérations : ${textes.join(' / ')}`);
    assert.match(textes[0], /Range les imports/, 'la 1re porte le prompt de lancement');
    assert.match(textes[1], /Renomme la variable compteur/);
    assert.match(textes[2], /test sur le parseur CSV/);
    // On arrive sur la DERNIÈRE : c'est celle qu'on vient d'obtenir.
    assert.match(await page.locator('.pass-item.active').textContent(), /parseur CSV/);
  });

  test('choisir une itération affiche la sienne à droite', async () => {
    await ouvrirRetour(multi.id);
    await items().first().click();
    await page.waitForFunction(() => /Range les imports/.test(document.querySelector('#taskMdBody').textContent));

    const corps = await page.locator('#taskMdBody').innerText();
    assert.match(corps, /Range les imports/, 'la demande de CETTE itération');
    assert.ok(!/parseur CSV/.test(corps), 'et pas celle d’une autre');
    assert.match(await page.locator('.pass-item.active').textContent(), /Range les imports/,
      'la ligne choisie est celle qui est marquée active');
    assert.equal(await page.locator('.pass-item.active').count(), 1, 'une seule à la fois');
  });

  test('la recherche porte sur mes demandes et masque le reste', async () => {
    await ouvrirRetour(multi.id);
    await page.locator('#taskPassSearch').fill('compteur');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 2);

    const visibles = await page.locator('#taskPassList .pass-item:visible').allTextContents();
    assert.equal(visibles.length, 1);
    assert.match(visibles[0], /Renomme la variable compteur/);
    // MASQUÉ, pas retiré : effacer le filtre ramène tout, sans recharger quoi que ce soit.
    assert.equal(await items().count(), 3);

    await page.locator('#taskPassSearch').fill('mot-qui-n-existe-pas');
    await page.waitForSelector('#taskPassNoMatch:not([hidden])');
    assert.equal(await page.locator('#taskPassList .pass-item:visible').count(), 0);

    await page.locator('#taskPassSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 0);
    assert.equal(await page.locator('#taskPassNoMatch').isVisible(), false);
  });

  /* Le filtre est REPOSÉ après le re-rendu : sans cela, cliquer une itération trouvée par la
     recherche rouvrirait la liste entière, et il faudrait retaper à chaque fois. */
  test('le filtre survit au changement d’itération', async () => {
    await ouvrirRetour(multi.id);
    await page.locator('#taskPassSearch').fill('compteur');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 2);
    await page.locator('#taskPassList .pass-item:visible').first().click();
    await page.waitForFunction(() => /compteur/.test(document.querySelector('#taskMdBody').textContent));

    assert.equal(await page.locator('#taskPassSearch').inputValue(), 'compteur');
    assert.equal(await page.locator('#taskPassList .pass-item:visible').count(), 1, 'la liste reste filtrée');
  });

  test('une seule itération : pas de colonne, la réponse prend toute la largeur', async () => {
    await ouvrirRetour(seule.id);
    assert.equal(await page.locator('#taskPassAside').isVisible(), false);
    assert.ok(await page.locator('#taskMdView .split-body.no-list').count(), 'la vue passe en une colonne');
    assert.match(await page.locator('#taskMdBody').innerText(), /Une seule passe/);
  });

  /* Rouvrir une AUTRE session repart d'une recherche vide : le filtre appartient à ce qu'on
     regardait, pas à l'écran. */
  test('la recherche ne suit pas d’une session à l’autre', async () => {
    await ouvrirRetour(multi.id);
    await page.locator('#taskPassSearch').fill('compteur');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 2);
    await ouvrirRetour(seule.id);
    await ouvrirRetour(multi.id);

    assert.equal(await page.locator('#taskPassSearch').inputValue(), '');
    assert.equal(await page.locator('#taskPassList .pass-item:visible').count(), 3);
    assert.deepEqual(erreurs, []);
  });
});
