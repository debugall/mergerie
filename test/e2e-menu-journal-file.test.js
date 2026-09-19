'use strict';
/* LA FILE D'ATTENTE ET LES JOBS EN PARALLÈLE, DANS LE PANNEAU DE JOURNAL, DANS UN VRAI NAVIGATEUR.
 *
 * Un job de plus pendant qu'un autre tourne attend son tour. Le panneau le dit (« +1 en
 * attente », bouton « En attente » et son compteur), permet de VOIR la file, d'en sortir un job
 * pour le lancer « en parallèle », ou de le retirer. Deux jobs qui tournent ensemble ont chacun
 * leur onglet et leur volet de journal, et chacun son bouton d'arrêt qui ne touche pas l'autre.
 * Au-delà de trois jobs simultanés, la file dit pourquoi elle ne peut plus en lancer. Et le
 * Stop global annonce qu'il vide la file avant de le faire.
 *
 * Les jobs sont des cibles `make` qui attendent un feu vert posé par le test
 * (helpers/journal.js) : ils durent exactement le temps qu'on décide, sur toute machine. Un job
 * docker ne touche aucun dépôt, donc aucun conflit n'interdit la voie parallèle.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, attendreServeur, waitForJobs,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker } = require('./helpers/fake-docker');
const { preparerChantier, jobServeur } = require('./helpers/journal');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Panneau de journal — file d’attente et jobs parallèles', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux; let chantier;
  const erreurs = [];
  const ids = {};

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    await app.configure();
    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    chantier = await preparerChantier(app, racine);
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').waitFor();
  });

  after(async () => {
    if (chantier) chantier.toutLiberer();
    if (app) { try { await waitForJobs(app.api, { timeout: 30000 }); } catch { /* on arrête quand même */ } }
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  const rafraichir = () => page.evaluate(() => refreshStatus()); // eslint-disable-line no-undef
  const statut = async (id) => (await jobServeur(app, id)).status;
  const attendreStatutServeur = (id, st) => attendreServeur(async () => (await statut(id)) === st, `job #${id} ${st}`);
  const attendreBandeau = (re) => page.waitForFunction(
    (src) => new RegExp(src, 'i').test(document.querySelector('#logStatus').textContent || ''),
    re.source, { timeout: ATTENTE },
  );
  const ligneFile = (id) => page.locator('#logQueue .log-queue-row').filter({ has: page.locator(`[data-jobcancel="${id}"]`) });
  const onglet = (id) => page.locator(`#logTabs [data-jobtab="${id}"]`);
  async function ouvrirFile() {
    await page.locator('#logQueueBtn').waitFor({ state: 'visible', timeout: ATTENTE });
    if (await page.locator('#logQueue').isHidden()) await page.locator('#logQueueBtn').click();
    await page.locator('#logQueue').waitFor({ state: 'visible' });
  }

  /* ------------------------------------------------------------ la file ---- */

  test('un second job attend son tour : bandeau « +1 en attente », bouton « En attente » et son compteur', async () => {
    ids.a = await chantier.lancer('porte-a');
    await attendreStatutServeur(ids.a, 'running');
    ids.b = await chantier.lancer('porte-b');
    assert.equal(await statut(ids.b), 'queued', 'la voie séquentielle est occupée : le second attend');
    await rafraichir();
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    await attendreBandeau(/en cours.*\+1 en attente/);
    await page.locator('#logQueueBtn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#logQueueCount').innerText(), '1');
    // Le journal déplié pour la suite : sans lui, les volets ne se voient pas.
    await page.locator('#logToggle').click();
    await page.locator('#logBox').waitFor({ state: 'visible' });
  });

  test('la file se déplie et dit ce qui attend ; elle et l’Activité ne s’ouvrent jamais ensemble', async () => {
    await ouvrirFile();
    const ligne = ligneFile(ids.b);
    await ligne.waitFor({ timeout: ATTENTE });
    assert.equal(await page.locator('#logQueue .log-queue-row').count(), 1);
    assert.equal(await ligne.locator('.tag').innerText(), 'Docker');
    assert.match(await ligne.innerText(), new RegExp(`#${ids.b}`));
    assert.equal(await ligne.locator(`[data-jobnow="${ids.b}"]`).isVisible(), true, 'rien ne bloque : on peut le lancer à côté');

    await page.locator('#logHistBtn').click();
    await page.locator('#logHist').waitFor({ state: 'visible' });
    await page.locator('#logHistBar').waitFor({ state: 'visible' });
    await page.locator('#logQueue').waitFor({ state: 'hidden' });

    await page.locator('#logQueueBtn').click();
    await page.locator('#logQueue').waitFor({ state: 'visible' });
    await page.locator('#logHist').waitFor({ state: 'hidden' });
    await page.locator('#logHistBar').waitFor({ state: 'hidden' });
  });

  /* ----------------------------------------------------- en parallèle ---- */

  test('« Lancer en parallèle » : les deux jobs tournent, chacun son onglet, et la file se vide', async () => {
    await ligneFile(ids.b).locator(`[data-jobnow="${ids.b}"]`).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /lancé en parallèle/.test(t.textContent)));
    await attendreStatutServeur(ids.b, 'running');
    assert.equal(await statut(ids.a), 'running');

    await page.locator('#logTabs').waitFor({ state: 'visible', timeout: ATTENTE });
    await onglet(ids.a).waitFor();
    await onglet(ids.b).waitFor();
    for (const id of [ids.a, ids.b]) {
      await page.waitForFunction((j) => {
        const t = document.querySelector(`#logTabs [data-jobtab="${j}"]`);
        return t && t.classList.contains('running') && !!t.querySelector(`[data-jobstop="${j}"]`);
      }, id, { timeout: ATTENTE });
    }
    /* « principal » désigne le job COURANT du serveur (le plus récent en cours), pas la voie :
       on vérifie qu'il y en a un de chaque, sans présumer lequel. */
    const noms = [await onglet(ids.a).innerText(), await onglet(ids.b).innerText()].map((t) => t.split('\n')[0].trim()).sort();
    assert.deepEqual(noms, ['En parallèle', 'Job principal']);
    await attendreBandeau(/2 jobs en cours/);
    await page.locator('#logQueueBtn').waitFor({ state: 'hidden' });
    await page.locator('#logQueue').waitFor({ state: 'hidden' });
    // Le Stop global le dit : il arrête TOUT.
    await page.waitForFunction(() => /Arrêter les 2 jobs/.test(document.querySelector('#logStop').title));
  });

  test('un onglet montre SON journal ; changer d’onglet ne mélange rien', async () => {
    await page.locator(`#logTabs [data-jobtab="${ids.b}"] .jobtab-pick`).click();
    await page.waitForFunction((j) => {
      const p = document.querySelector('#logBox .logpane:not([hidden])');
      return p && Number(p.dataset.job) === j && p.textContent.includes('porte-b : en attente');
    }, ids.b, { timeout: ATTENTE });
    await page.waitForFunction((j) => document.querySelector(`#logTabs [data-jobtab="${j}"]`).classList.contains('active'), ids.b);
    assert.doesNotMatch(await page.locator('#logBox .logpane:not([hidden])').innerText(), /porte-a/);

    await page.locator(`#logTabs [data-jobtab="${ids.a}"] .jobtab-pick`).click();
    await page.waitForFunction((j) => {
      const p = document.querySelector('#logBox .logpane:not([hidden])');
      return p && Number(p.dataset.job) === j && p.textContent.includes('porte-a : en attente');
    }, ids.a, { timeout: ATTENTE });
  });

  test('l’arrêt d’un onglet n’arrête que ce job : l’autre continue', async () => {
    await page.locator(`#logTabs [data-jobstop="${ids.b}"]`).click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmText').innerText(), new RegExp(`#${ids.b}.*Les autres jobs en cours ne sont pas touchés`));
    await page.locator('#confirmOk').click();
    await attendreStatutServeur(ids.b, 'stopped');
    assert.equal(await statut(ids.a), 'running', 'le voisin tourne toujours');
    await page.waitForFunction((j) => {
      const t = document.querySelector(`#logTabs [data-jobtab="${j}"]`);
      return t && t.classList.contains('stopped') && !t.querySelector('[data-jobstop]');
    }, ids.b, { timeout: ATTENTE });
    assert.equal(await page.locator(`#logTabs [data-jobstop="${ids.a}"]`).count(), 1);
  });

  /* LE BANDEAU COMPTE LES ONGLETS, PAS LES JOBS QUI TOURNENT. Un job arrêté garde son onglet
     (c'est voulu : on veut relire sa sortie), mais `pumpLog` annonce « N jobs en cours » avec
     N = nombre d'onglets, arrêtés compris — et le Stop global promet d'« arrêter les N jobs ».
     Ici : #b vient d'être arrêté, seul #a tourne, et le bandeau dit encore « 2 jobs en cours ». */
  test('le bandeau ne compte que les jobs qui tournent encore', async () => {
    assert.equal(await statut(ids.b), 'stopped');
    assert.equal(await statut(ids.a), 'running');
    await rafraichir();
    await attendreBandeau(/en cours/);
    const bandeau = await page.locator('#logStatus').innerText();
    assert.doesNotMatch(bandeau, /2 jobs en cours/, `un seul job tourne, le bandeau dit : « ${bandeau} »`);
    assert.doesNotMatch(await page.locator('#logStop').getAttribute('title'), /Arrêter les 2 jobs/);
  });

  /* ------------------------------------------------ le plafond et le retrait ---- */

  test('trois jobs simultanés au plus : le suivant reste en file, et la file dit pourquoi', async () => {
    for (const c of ['c', 'd']) {
      ids[c] = await chantier.lancer(`porte-${c}`);
      assert.equal(await statut(ids[c]), 'queued');
      await rafraichir();
      await ouvrirFile();
      const bouton = ligneFile(ids[c]).locator(`[data-jobnow="${ids[c]}"]`);
      await bouton.waitFor({ timeout: ATTENTE });
      await bouton.click();
      await attendreStatutServeur(ids[c], 'running');
    }
    ids.e = await chantier.lancer('porte-e');
    await rafraichir();
    await ouvrirFile();
    const ligne = ligneFile(ids.e);
    await ligne.waitFor({ timeout: ATTENTE });
    await page.waitForFunction((j) => {
      const r = [...document.querySelectorAll('#logQueue .log-queue-row')].find((x) => x.querySelector(`[data-jobcancel="${j}"]`));
      return r && /Maximum de jobs simultanés atteint/.test(r.textContent);
    }, ids.e, { timeout: ATTENTE });
    assert.equal(await ligne.locator('[data-jobnow]').count(), 0, 'pas de bouton qui répondrait par un refus');
  });

  test('retirer un job de la file : confirmation, puis il ne s’exécutera jamais', async () => {
    await ligneFile(ids.e).locator(`[data-jobcancel="${ids.e}"]`).click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmText').innerText(), /Retirer ce job de la file/);
    await page.locator('#confirmOk').click();
    await attendreStatutServeur(ids.e, 'stopped');
    assert.equal((await jobServeur(app, ids.e)).message, 'Annulé (jamais démarré)');
    await page.locator('#logQueueBtn').waitFor({ state: 'hidden', timeout: ATTENTE });
  });

  test('Stop global : la confirmation annonce la file vidée, puis tout s’arrête et rien ne démarre', async () => {
    ids.f = await chantier.lancer('porte-f');
    await rafraichir();
    await page.locator('#logQueueBtn').waitFor({ state: 'visible', timeout: ATTENTE });
    await page.locator('#logStop').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmText').innerText(), /et 1 job en attente sera annulé/);
    await page.locator('#confirmOk').click();
    for (const c of ['a', 'c', 'd', 'f']) await attendreStatutServeur(ids[c], 'stopped');
    assert.equal((await jobServeur(app, ids.f)).message, 'Annulé (jamais démarré)');
    await page.locator('#logStop').waitFor({ state: 'hidden', timeout: ATTENTE });
    await page.locator('#logQueueBtn').waitFor({ state: 'hidden', timeout: ATTENTE });
    await attendreBandeau(/arrêté/);
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
