'use strict';
/* MENU « DOCKER » — SOUS-ONGLET LOGS, DANS UN VRAI NAVIGATEUR.
 *
 * Le tail live multi-conteneurs : la liste (en cours d'abord, recherche par nom, projet ou
 * image), la sélection retenue par projet, « Démarrer le tail » (refus sans sélection, nombre
 * de lignes transmis à docker et retenu), les lignes de stdout ET de stderr étiquetées par
 * conteneur, la fin d'un flux, les filtres inclure/exclure (ajout, mise en sourdine, retrait,
 * retenus au rechargement), les couleurs, le retour à la ligne, la pause du défilement, Vider,
 * Arrêter (qui doit TUER les `docker logs -f` côté serveur), et la copie du nom / de la commande.
 *
 * Docker est simulé (helpers/fake-docker.js) : le faux `docker logs` rejoue des lignes
 * connues et note son pid, ce qui permet de vérifier que la fermeture du flux le tue.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker } = require('./helpers/fake-docker');

const { dispo } = navigateurDispo();

const LOGS = {
  'boutique-web-1': ['GET / 200', 'GET /health 200', '\u001b[31mERREUR rouge\u001b[0m', 'POST /panier 201'],
  'boutique-api-1': ['api prête', 'ERR connexion base lente', 'GET /api/produits 200'],
  'vieux-job': ['travail terminé'],
};

describe('Menu Docker — onglet Logs', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux;
  const erreurs = [];

  before(async () => {
    const etat = scenarioDocker();
    etat.logs = LOGS;
    etat.logsTermines = ['vieux-job'];
    faux = installerFauxDocker(etat);
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(t); }, readText: async () => '' },
      });
    });
    await page.goto(app.base);
    await ouvrirLogs();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  async function ouvrirLogs() {
    await page.locator('nav button[data-tab="docker"]').click();
    await page.locator('#tab-docker .subnav [data-dsub="logs"]').click();
    await page.waitForSelector('#dlogContainers .dlog-citem');
  }
  const caseDe = (nom) => page.locator('#dlogContainers .dlog-citem').filter({ has: page.locator(`.dlog-cname[data-copy-txt="${nom}"]`) }).locator('input[type="checkbox"]');
  const noms = () => page.locator('#dlogContainers .dlog-cname').evaluateAll((l) => l.map((x) => x.dataset.copyTxt));
  const lignes = () => page.locator('#dlogView .dlog-row').evaluateAll((l) => l.map((r) => r.querySelector('.dlog-msg').textContent));
  async function attendreLignes(n) {
    await page.waitForFunction((k) => document.querySelectorAll('#dlogView .dlog-row').length === k, n);
  }
  const appelsLogs = () => faux.appels().filter((a) => a.args[0] === 'logs');
  async function arreterEtAttendre() {
    await page.locator('#dlogStop').click();
    await attendreServeur(async () => faux.fluxVivants().length === 0, 'plus aucun `docker logs -f` vivant');
  }

  /* ------------------------------------------------------------ la liste ---- */

  test('tous les conteneurs sont listés, ceux qui tournent d’abord, avec leur projet', async () => {
    const vus = await noms();
    assert.equal(vus.length, 9);
    assert.deepEqual(vus.slice(0, 5), ['boutique-api-1', 'boutique-web-1', 'boutique-worker-1', 'monitoring-grafana-1', 'redis-seul']);
    const web = page.locator('#dlogContainers .dlog-citem').filter({ hasText: 'boutique-web-1' });
    assert.match(await web.locator('.dlog-dot').getAttribute('class'), /\brun\b/);
    assert.equal(await web.locator('.dlog-cproj').innerText(), 'boutique');
    const job = page.locator('#dlogContainers .dlog-citem').filter({ hasText: 'vieux-job' });
    assert.match(await job.locator('.dlog-dot').getAttribute('class'), /\bstop\b/);
    assert.equal(await job.locator('.dlog-cproj').count(), 0, 'hors-compose : pas de projet');
  });

  test('la recherche filtre par nom, par projet ou par image', async () => {
    const chercher = async (q, n) => {
      await page.locator('#dlogSearch').fill(q);
      await page.waitForFunction((k) => document.querySelectorAll('#dlogContainers .dlog-citem').length === k, n);
      return noms();
    };
    assert.deepEqual(await chercher('monitoring', 3), ['monitoring-grafana-1', 'monitoring-alertmanager-1', 'monitoring-prometheus-1']);
    assert.deepEqual(await chercher('busybox', 1), ['vieux-job']);
    assert.deepEqual(await chercher('seul', 1), ['redis-seul']);
    await page.locator('#dlogSearch').fill('rien-de-tel');
    await page.waitForFunction(() => /Aucun container/.test(document.querySelector('#dlogContainers').innerText));
    await chercher('', 9);
  });

  test('copier le nom seul, ou la commande `docker logs` du conteneur — sans cocher sa case', async () => {
    const item = page.locator('#dlogContainers .dlog-citem').filter({ hasText: 'redis-seul' });
    await item.locator('.dlog-cname').click();
    await page.waitForFunction(() => window.__copies.length >= 1);
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'redis-seul');
    await item.locator('[data-copy-cmd]').click();
    await page.waitForFunction(() => window.__copies.length >= 2);
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'docker logs -f --tail=200 redis-seul');
    assert.equal(await caseDe('redis-seul').isChecked(), false);
  });

  /* ------------------------------------------------------------- le flux ---- */

  test('démarrer sans conteneur coché est refusé, sans rien lancer', async () => {
    await page.locator('#dlogStart').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /Coche au moins un container/.test(t.textContent)));
    assert.equal(appelsLogs().length, 0);
    assert.equal(await page.locator('#dlogStop').isDisabled(), true);
  });

  test('le tail suit les conteneurs cochés, stdout et stderr, chaque ligne étiquetée', async () => {
    await caseDe('boutique-web-1').click();
    await caseDe('boutique-api-1').click();
    await page.locator('#dlogStart').click();
    await attendreLignes(7);
    const appels = appelsLogs().map((a) => a.args);
    assert.deepEqual(appels.map((a) => a.at(-1)).sort(), ['c0api', 'c0web']);
    for (const a of appels) assert.deepEqual(a.slice(0, 4), ['logs', '-f', '--tail', '200']);
    const vues = await lignes();
    assert.ok(vues.includes('ERR connexion base lente'), 'la sortie d’erreur est suivie aussi');
    assert.ok(vues.includes('POST /panier 201'));
    const tags = await page.locator('#dlogView .dlog-tag').evaluateAll((l) => [...new Set(l.map((x) => x.textContent))].sort());
    assert.deepEqual(tags, ['boutique-api-1', 'boutique-web-1']);
    assert.equal(await page.locator('#dlogStart').isDisabled(), true);
    assert.equal(await page.locator('#dlogStop').isDisabled(), false);
    assert.match(await page.locator('#dlogStatus').innerText(), /en direct · 7 lignes affichées \/ 7 en mémoire/);
    assert.equal(faux.fluxVivants().length, 2, 'deux `docker logs -f` tournent');
  });

  test('filtres « n’afficher que » et « exclure » : ajout, sourdine, retrait — sans relancer le flux', async () => {
    const avant = appelsLogs().length;
    await page.locator('#dlogIncludeInput').fill('GET');
    await page.locator('#dlogIncludeInput').press('Enter');
    await attendreLignes(3);
    assert.ok((await lignes()).every((l) => l.includes('GET')));
    assert.equal(await page.locator('#dlogIncludeInput').inputValue(), '', 'le champ se vide');
    // Doublon ignoré, à la casse près.
    await page.locator('#dlogIncludeInput').fill('get');
    await page.locator('#dlogIncludeInput').press('Enter');
    assert.equal(await page.locator('#dlogIncludeChips .dlog-chip').count(), 1);

    await page.locator('#dlogExcludeInput').fill('health');
    await page.locator('#dlogExcludeForm button[type="submit"]').click();
    await attendreLignes(2);
    assert.ok(!(await lignes()).some((l) => l.includes('health')));

    // Sourdine : le mot reste, le filtre ne s'applique plus.
    await page.locator('#dlogIncludeChips .dlog-chip [data-tog]').click();
    await attendreLignes(6);
    assert.match(await page.locator('#dlogIncludeChips .dlog-chip').getAttribute('class'), /\boff\b/);
    await page.locator('#dlogIncludeChips .dlog-chip [data-tog]').click();
    await attendreLignes(2);
    await page.locator('#dlogIncludeChips .dlog-chip [data-del]').click();
    await attendreLignes(6);
    assert.match(await page.locator('#dlogIncludeChips').innerText(), /Aucun filtre/);
    assert.equal(appelsLogs().length, avant, 'filtrer ne relance pas docker');
  });

  test('les couleurs de l’application : texte nu par défaut, rendues sur demande', async () => {
    const rouge = page.locator('#dlogView .dlog-row').filter({ hasText: 'ERREUR rouge' });
    assert.equal(await rouge.locator('.ansi-fg-1').count(), 0);
    assert.equal(await rouge.locator('.dlog-msg').textContent(), 'ERREUR rouge', 'séquences retirées');
    await page.locator('#dlogColor').check();
    await page.locator('#dlogView .dlog-row .ansi-fg-1').waitFor();
    assert.equal(await page.locator('#dlogView .ansi-fg-1').textContent(), 'ERREUR rouge');
    await page.locator('#dlogColor').uncheck();
    await page.locator('#dlogView .ansi-fg-1').waitFor({ state: 'detached' });
  });

  test('retour à la ligne, pause du défilement, Vider', async () => {
    await page.locator('#dlogWrap').check();
    assert.match(await page.locator('#dlogView').getAttribute('class'), /\bwrap\b/);
    await page.locator('#dlogWrap').uncheck();
    assert.doesNotMatch(await page.locator('#dlogView').getAttribute('class'), /\bwrap\b/);

    await page.locator('#dlogPause').click();
    assert.equal(await page.locator('#dlogPauseLabel').innerText(), 'Reprendre le défilement');
    assert.match(await page.locator('#dlogPause').getAttribute('class'), /\bactive\b/);
    await page.locator('#dlogPause').click();
    assert.equal(await page.locator('#dlogPauseLabel').innerText(), 'Pause défilement');

    await page.locator('#dlogClear').click();
    await attendreLignes(0);
    assert.match(await page.locator('#dlogStatus').innerText(), /0 lignes affichées \/ 0 en mémoire/);
    assert.equal(faux.fluxVivants().length, 2, 'vider garde le flux ouvert');
  });

  test('Arrêter ferme le flux, et le serveur tue les `docker logs -f`', async () => {
    await arreterEtAttendre();
    assert.equal(await page.locator('#dlogStart').isDisabled(), false);
    assert.equal(await page.locator('#dlogStop').isDisabled(), true);
    assert.match(await page.locator('#dlogStatus').innerText(), /arrêté/);
  });

  test('le nombre de lignes demandé part à docker, et il est retenu', async () => {
    faux.viderJournal();
    await page.locator('#dlogTail').fill('2');
    await page.locator('#dlogStart').click();
    await attendreLignes(4);
    for (const a of appelsLogs()) assert.deepEqual(a.args.slice(2, 4), ['--tail', '2']);
    assert.deepEqual((await lignes()).sort(), ['ERR connexion base lente', 'ERREUR rouge', 'GET /api/produits 200', 'POST /panier 201']);
    await arreterEtAttendre();
  });

  test('la sélection, les filtres et le tail sont retenus au rechargement', async () => {
    await page.locator('#dlogExcludeInput').fill('panier');
    await page.locator('#dlogExcludeInput').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#dlogExcludeChips .dlog-chip').length === 2);
    await page.reload();
    // Le sous-onglet est retenu lui aussi : la liste revient sans recliquer « Logs ».
    await page.locator('nav button[data-tab="docker"]').click();
    await page.waitForSelector('#dlogContainers .dlog-citem');
    assert.equal(await page.locator('#dsub-logs.active').count(), 1);
    assert.equal(await caseDe('boutique-web-1').isChecked(), true);
    assert.equal(await caseDe('boutique-api-1').isChecked(), true);
    assert.equal(await caseDe('boutique-worker-1').isChecked(), false);
    assert.equal(await page.locator('#dlogTail').inputValue(), '2');
    const mots = await page.locator('#dlogExcludeChips .dlog-chip-w').evaluateAll((l) => l.map((x) => x.textContent));
    assert.deepEqual(mots, ['health', 'panier']);
    // Décocher se retient aussi.
    await caseDe('boutique-api-1').click();
    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await page.waitForSelector('#dlogContainers .dlog-citem');
    assert.equal(await caseDe('boutique-api-1').isChecked(), false);
    assert.equal(await caseDe('boutique-web-1').isChecked(), true);
    assert.equal(faux.fluxVivants().length, 0, 'recharger la page n’a laissé aucun flux derrière');
  });

  test('un conteneur dont le flux se termine le dit dans le journal', async () => {
    // boutique-web-1 est resté coché depuis le test précédent.
    await caseDe('vieux-job').click();
    await page.locator('#dlogTail').fill('10');
    await page.locator('#dlogStart').click();
    await page.locator('#dlogView .dlog-sys-closed').waitFor();
    assert.match(await page.locator('#dlogView .dlog-sys-closed').innerText(), /vieux-job[\s\S]*flux du container terminé/);
    assert.ok((await lignes()).includes('travail terminé'));
    await arreterEtAttendre();
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
