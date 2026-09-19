'use strict';
/* MENU « DOCKER » — LE BOUTON DU MENU ET CE QUI ARRIVE QUAND RIEN NE VA, DANS UN VRAI NAVIGATEUR.
 *
 *   - les pastilles de santé du bouton Docker : muettes avant la première visite (un badge
 *     rouge sur une installation neuve compterait les conteneurs d'autres projets), puis rouge
 *     = en erreur + sortis en erreur (un arrêt propre n'y entre pas), orange = unhealthy, avec
 *     une bulle qui détaille ;
 *   - démon injoignable : bandeau actionnable, rien d'autre n'est appelé, les pastilles se
 *     taisent ; retour à la normale avec « Rafraîchir » ;
 *   - aucun répertoire local : état vide qui dit où en ajouter un ; un compose que Docker
 *     refuse : la carte montre l'erreur au lieu de disparaître ;
 *   - le sous-onglet ouvert est retenu au rechargement.
 *
 * Docker est simulé (helpers/fake-docker.js).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker, ecrireProjetsCompose } = require('./helpers/fake-docker');

const { dispo } = navigateurDispo();

describe('Menu Docker — santé, démon absent, états vides', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux;
  const erreurs = [];

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="docker"]:not([hidden])');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  const rouge = () => page.locator('#dockerErrBadge');
  const orange = () => page.locator('#dockerUnhealthyBadge');

  test('avant la première visite, le bouton Docker ne montre aucune alarme', async () => {
    // Le résumé de santé a bien des choses à dire…
    const s = (await app.api('GET', '/api/docker/summary')).body;
    assert.deepEqual([s.error, s.crashed, s.unhealthy], [1, 1, 1]);
    // …mais l'écran se tait tant qu'on n'est jamais allé voir.
    assert.equal(await rouge().isHidden(), true);
    assert.equal(await orange().isHidden(), true);
  });

  test('après la visite : rouge = en erreur + sortis en erreur, orange = en mauvaise santé, bulle détaillée', async () => {
    await page.locator('nav button[data-tab="docker"]').click();
    await rouge().waitFor({ state: 'visible' });
    assert.equal(await rouge().innerText(), '2', 'prometheus (redémarre) + db (code 1) ; vieux-job (code 0) n’y est pas');
    const bulle = await rouge().getAttribute('data-tip');
    assert.match(bulle, /1 container en erreur/);
    assert.match(bulle, /1 container sorti en erreur/);
    assert.match(bulle, /1 container arrêté proprement/);
    await orange().waitFor({ state: 'visible' });
    assert.equal(await orange().innerText(), '1');
    assert.match(await orange().getAttribute('aria-label'), /1 container en mauvaise santé/);
  });

  test('la visite est retenue : au rechargement, les pastilles sont là sans ouvrir l’onglet', async () => {
    await page.locator('nav button[data-tab="review"]').click();
    await page.reload();
    await rouge().waitFor({ state: 'visible' });
    assert.equal(await rouge().innerText(), '2');
  });

  test('sans répertoire local, l’onglet Compose dit où en ajouter un', async () => {
    await page.locator('nav button[data-tab="docker"]').click();
    await page.locator('#tab-docker .subnav [data-dsub="compose"]').click();
    await page.waitForFunction(() => /Aucun projet compose/.test(document.querySelector('#dockerComposeBox').innerText));
    assert.match(await page.locator('#dockerComposeBox').innerText(), /Réglages → Dépôts/);
  });

  test('un compose que Docker refuse montre son erreur sur sa carte, les autres s’affichent', async () => {
    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    ecrireProjetsCompose(racine, { makefile: false });
    // « casse » a un compose.yaml sur le disque, mais le faux docker ne sait pas le lire.
    fs.mkdirSync(path.join(racine, 'casse'));
    fs.writeFileSync(path.join(racine, 'casse', 'compose.yaml'), 'services: [\n');
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);
    await page.locator('#dockerRefresh').click();
    const carte = page.locator(`#dockerComposeBox .docker-slot[data-path="${path.join(racine, 'casse', 'compose.yaml')}"]`);
    await carte.locator('text=/no configuration file provided/').waitFor();
    await page.locator('#dockerComposeBox [data-dockeract="up"][data-svc="web"]').waitFor();
    await page.locator('#dockerComposeBox [data-dockeract="up"][data-svc="grafana"]').waitFor();
  });

  test('démon injoignable : bandeau actionnable, écrans vidés, pastilles muettes — puis retour', async () => {
    faux.modifier((e) => { e.daemonDown = true; });
    faux.viderJournal();
    await page.locator('#dockerRefresh').click();
    await page.waitForFunction(() => /démon Docker n’est pas joignable/.test(document.querySelector('#dockerError').innerText));
    assert.match(await page.locator('#dockerError').innerText(), /Démarre Docker Desktop/);
    assert.equal(await page.locator('#dockerComposeBox').innerHTML(), '');
    assert.equal(await page.locator('#dockerOrphansBox').innerHTML(), '');
    assert.equal(await page.locator('#dockerInfo').innerText(), '');
    await rouge().waitFor({ state: 'hidden' });
    await orange().waitFor({ state: 'hidden' });
    // Rien d'autre que la question « le démon répond-il ? » n'est posé à docker.
    assert.ok(faux.appels().every((a) => a.args[0] === 'version'), JSON.stringify(faux.appels()));

    faux.modifier((e) => { e.daemonDown = false; });
    await page.locator('#dockerRefresh').click();
    await page.waitForFunction(() => document.querySelector('#dockerError').innerHTML === ''
      && /Docker 99\.0\.0-faux/.test(document.querySelector('#dockerInfo').innerText));
    await page.locator('#dockerComposeBox [data-dockeract="up"][data-svc="web"]').waitFor();
    await rouge().waitFor({ state: 'visible' });
  });

  test('le sous-onglet ouvert est retenu au rechargement', async () => {
    await page.locator('#tab-docker .subnav [data-dsub="orphans"]').click();
    await page.waitForSelector('#dockerOrphansBox .docker-orphan');
    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await page.waitForSelector('#dsub-orphans.active');
    assert.match(await page.locator('#tab-docker .subnav [data-dsub="orphans"]').getAttribute('class'), /active/);
    await page.waitForSelector('#dockerOrphansBox .docker-orphan');
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
