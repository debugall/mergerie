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
  /* REPÉRER UNE ITÉRATION PARMI VINGT. Le numéro et la date ne disent rien de ce qui s'y est
     joué. On épingle donc les quelques passes qui comptent — elles remontent en tête — et on
     leur donne un nom. Ni l'un ni l'autre ne part à l'agent : c'est du rangement, comme le
     libellé d'une session. */
  test('une itération se nomme, et le nom se relit après rechargement', async () => {
    await ouvrirRetour(multi.id);
    const premiere = items().first();
    await premiere.locator('[data-passname]').click();
    await page.locator('.pass-rename').fill('corrige le logger');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#taskPassList .pass-item-name');

    assert.equal(await page.locator('#taskPassList .pass-item-name').first().textContent(), 'corrige le logger');
    // Le nom est en BASE, pas seulement à l'écran.
    const enBase = app.db.prepare("SELECT titre FROM agent_pass WHERE scope = 'local' ORDER BY n LIMIT 1").get();
    assert.equal(enBase.titre, 'corrige le logger');

    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector('#localList .card');
    await ouvrirRetour(multi.id);
    assert.equal(await page.locator('#taskPassList .pass-item-name').first().textContent(), 'corrige le logger');
  });

  test('la recherche trouve une itération par son nom', async () => {
    await ouvrirRetour(multi.id);
    await page.locator('#taskPassSearch').fill('corrige le logger');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 2);
    const visibles = await page.locator('#taskPassList .pass-item:visible').allTextContents();
    assert.equal(visibles.length, 1);
    assert.match(visibles[0], /corrige le logger/);
    await page.locator('#taskPassSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#taskPassList .pass-item[hidden]').length === 0);
  });

  /* ÉPINGLER REMONTE EN TÊTE : c'est tout l'intérêt quand la colonne compte vingt lignes. Le
     numéro reste affiché, donc la chronologie se lit encore. */
  test('épingler une itération la remonte en tête, et ça se garde', async () => {
    await ouvrirRetour(multi.id);
    const derniere = items().last();
    const numero = await derniere.getAttribute('data-pass');
    assert.notEqual(numero, await items().first().getAttribute('data-pass'), 'elle n’y est pas déjà');

    await derniere.locator('[data-passfav]').click();
    await page.waitForFunction((n) => document.querySelector('#taskPassList .pass-item').dataset.pass === n, numero);
    assert.equal(await page.locator('#taskPassList .pass-item .pass-star.on').count(), 1,
      'l’étiquette s’allume sur la seule épinglée');

    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector('#localList .card');
    await ouvrirRetour(multi.id);
    assert.equal(await items().first().getAttribute('data-pass'), numero, 'elle est toujours en tête');

    // …et on peut la décrocher : elle retrouve sa place chronologique.
    await items().first().locator('[data-passfav]').click();
    await page.waitForFunction((n) => document.querySelector('#taskPassList .pass-item').dataset.pass !== n, numero);
    assert.equal(await page.locator('#taskPassList .pass-star.on').count(), 0);
  });

  /* Échap pendant qu'on nomme ne doit RIEN enregistrer : renoncer est un geste, pas un accident. */
  test('renoncer au nom ne l’enregistre pas', async () => {
    await ouvrirRetour(multi.id);
    const deuxieme = items().nth(1);
    const avant = await deuxieme.locator('.pass-item-name').count();
    await deuxieme.locator('[data-passname]').click();
    await page.locator('.pass-rename').fill('jamais enregistré');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pass-rename', { state: 'detached' });

    assert.equal(await deuxieme.locator('.pass-item-name').count(), avant);
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM agent_pass WHERE titre = 'jamais enregistré'").get().c, 0);
    assert.deepEqual(erreurs, []);
  });
  /* LE NOM NE PART PAS À L'AGENT. C'est un titre de rangement : le glisser dans un prompt
     changerait ce que l'agent produit, et deux passes au même prompt mais au titre différent
     ne rendraient plus la même chose. Même règle que le libellé d'une session. */
  test('le nom d’une itération reste hors du prompt, et une itération inconnue est refusée', async () => {
    const passe = app.db.prepare("SELECT id FROM agent_pass WHERE scope = 'local' ORDER BY n LIMIT 1").get();
    const r = await app.api('PUT', `/api/agent-passes/${passe.id}`, { titre: 'ne doit pas fuir', favori: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.titre, 'ne doit pas fuir');
    assert.equal(r.body.favori, 1);

    const { body } = await app.api('GET', `/api/local-tasks/${multi.id}/dirs/${(await app.api('GET', `/api/local-tasks/${multi.id}`)).body.task.dirs[0].id}/passes`);
    assert.ok(!JSON.stringify(body.passes.map((p) => p.prompt)).includes('ne doit pas fuir'),
      'aucun prompt archivé ne porte le titre');
    assert.equal(body.passes.find((p) => p.id === passe.id).titre, 'ne doit pas fuir',
      'il voyage bien à part, pour l’écran');

    assert.equal((await app.api('PUT', '/api/agent-passes/999999', { titre: 'x' })).status, 404);
  });
});
