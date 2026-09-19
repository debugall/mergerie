'use strict';
/* MENU « DOCKER » — SOUS-ONGLET ACTIONS (action groupée), DANS UN VRAI NAVIGATEUR.
 *
 * On choisit UNE action, la liste ne montre que les services concernés (Démarrer → ce qui ne
 * tourne pas ; Redémarrer/Stop → ce qui tourne ; Recréer/Build/Pull → tout), les pastilles
 * d'état et la recherche la réduisent SANS décocher, « Tout cocher », le compteur, puis
 * « Appliquer » : un `docker compose` par projet, dans un seul job. Les verbes qui coupent un
 * service (Stop, Recréer) passent par une confirmation qui nomme les services. L'action et le
 * filtre sont retenus ; la sélection, volontairement, non.
 *
 * Docker est simulé (helpers/fake-docker.js) : l'effet se lit dans les appels reçus et l'état
 * du faux démon.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker, ecrireProjetsCompose } = require('./helpers/fake-docker');

const { dispo } = navigateurDispo();

const TOUS = ['web', 'api', 'worker', 'db', 'cache', 'grafana', 'prometheus', 'alertmanager'];

describe('Menu Docker — onglet Actions', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux; let dirs;
  const erreurs = [];

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    await app.configure();
    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    dirs = ecrireProjetsCompose(racine);
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await ouvrirActions();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  async function ouvrirActions() {
    await page.locator('nav button[data-tab="docker"]').click();
    await page.locator('#tab-docker .subnav [data-dsub="actions"]').click();
    await page.waitForSelector('#dactList .dact-item');
  }
  const vus = () => page.locator('#dactList input[type="checkbox"]').evaluateAll((l) => l.map((x) => x.dataset.service));
  const coche = (svc) => page.locator(`#dactList input[data-service="${svc}"]`);
  // Attend que la liste montre exactement ces services (dans n'importe quel ordre).
  async function attendreListe(services) {
    await page.waitForFunction((attendus) => {
      const l = [...document.querySelectorAll('#dactList input[type="checkbox"]')].map((x) => x.dataset.service).sort();
      return JSON.stringify(l) === JSON.stringify([...attendus].sort());
    }, services);
  }
  async function choisirAction(a) {
    await page.locator('#dactAction').selectOption(a);
  }
  async function filtrer(etat) {
    await page.locator(`#dactFilter [data-dstate="${etat}"]`).click();
    await page.waitForFunction((e) => document.querySelector('#dactFilter').dataset.state === e, etat);
  }
  const compteur = () => page.locator('#dactCount').innerText();
  const appelsCompose = (sous) => faux.appels().filter((a) => a.args[0] === 'compose' && a.args[1] === sous);

  /* -------------------------------------------------------------- la liste ---- */

  test('par défaut « Recréer » : tous les services, groupés par projet, avec leurs alertes', async () => {
    assert.equal(await page.locator('#dactAction').inputValue(), 'recreate');
    await attendreListe(TOUS);
    const projets = await page.locator('#dactList .dact-proj-name').evaluateAll((l) => l.map((x) => x.textContent));
    assert.deepEqual(projets, ['boutique', 'monitoring']);
    const item = (s) => page.locator('#dactList .dact-item').filter({ has: page.locator(`input[data-service="${s}"]`) });
    assert.match(await item('api').innerText(), /drift config/);
    assert.match(await item('worker').innerText(), /drift image/);
    assert.match(await item('grafana').innerText(), /compose modifié/);
    assert.equal(await item('grafana').locator('.dact-tag.warn').innerText(), 'unhealthy');
    assert.equal(await item('prometheus').locator('.dact-tag.err').innerText(), 'restarting');
    assert.equal(await item('cache').locator('.dact-state').textContent(), 'non créé');
    assert.equal(await page.locator('#dactApply').isDisabled(), true, 'rien de coché : rien à appliquer');
    assert.match(await page.locator('#dactApply').getAttribute('class'), /btn-danger/, 'Recréer coupe les services : bouton rouge');
  });

  test('la liste suit l’action : Démarrer → ce qui ne tourne pas ; Redémarrer/Stop → ce qui tourne', async () => {
    await choisirAction('up');
    await attendreListe(['db', 'cache', 'prometheus', 'alertmanager']);
    assert.match(await page.locator('#dactApply').getAttribute('class'), /btn-primary/);
    await choisirAction('restart');
    await attendreListe(['web', 'api', 'worker', 'grafana']);
    await choisirAction('stop');
    await attendreListe(['web', 'api', 'worker', 'grafana']);
    assert.match(await page.locator('#dactApply').getAttribute('class'), /btn-danger/);
    for (const a of ['build', 'pull']) {
      await choisirAction(a);
      await attendreListe(TOUS);
    }
  });

  test('les pastilles d’état et la recherche réduisent la liste', async () => {
    const cas = { drift: ['api', 'worker', 'grafana'], crashed: ['db'], missing: ['cache'], created: ['alertmanager'], unhealthy: ['grafana'], restarting: ['prometheus'], exited: ['db'], running: ['web', 'api', 'worker', 'grafana'] };
    for (const [etat, services] of Object.entries(cas)) {
      await filtrer(etat);
      await attendreListe(services);
    }
    await filtrer('all');
    await page.locator('#dactSearch').fill('gra');
    await attendreListe(['grafana']);
    await page.locator('#dactSearch').fill('monitoring');
    await attendreListe(['grafana', 'prometheus', 'alertmanager']);
    await page.locator('#dactSearch').fill('introuvable');
    await page.waitForFunction(() => /Aucun service concerné/.test(document.querySelector('#dactList').innerText));
    await page.locator('#dactSearch').fill('');
    await attendreListe(TOUS);
  });

  test('cocher compte ; filtrer masque sans décocher ; changer d’action vide la sélection', async () => {
    await coche('api').click();
    await coche('worker').click();
    assert.equal(await compteur(), '2 sélectionnés');
    assert.equal(await page.locator('#dactApply').isDisabled(), false);
    await filtrer('crashed');
    await attendreListe(['db']);
    assert.equal(await compteur(), '2 sélectionnés', 'masqués, toujours cochés');
    await filtrer('all');
    await attendreListe(TOUS);
    assert.equal(await coche('api').isChecked(), true);
    assert.equal(await coche('worker').isChecked(), true);

    await choisirAction('build');
    await attendreListe(TOUS);
    assert.equal(await compteur(), '');
    assert.equal(await coche('api').isChecked(), false);
    assert.equal(await page.locator('#dactApply').isDisabled(), true);
  });

  test('« Tout cocher » coche ce qui est affiché, et passe en indéterminé quand on en retire un', async () => {
    await page.locator('#dactAll').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#dactList input[type="checkbox"]')].every((x) => x.checked));
    assert.equal(await compteur(), '8 sélectionnés');
    await coche('db').click();
    assert.equal(await compteur(), '7 sélectionnés');
    assert.equal(await page.locator('#dactAll').evaluate((x) => x.indeterminate), true);
    await page.locator('#dactAll').click();          // indéterminé → coché : tout recoché
    assert.equal(await compteur(), '8 sélectionnés');
    await page.locator('#dactAll').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#dactList input[type="checkbox"]')].every((x) => !x.checked));
    assert.equal(await compteur(), '');
  });

  /* ------------------------------------------------------------ appliquer ---- */

  test('Pull sur trois services de deux projets : un `docker compose` par projet, sans confirmation', async () => {
    await choisirAction('pull');
    await attendreListe(TOUS);
    faux.viderJournal();
    for (const s of ['api', 'worker', 'grafana']) await coche(s).click();
    await page.locator('#dactApply').click();
    await attendreServeur(async () => appelsCompose('pull').length === 2, 'deux pull reçus');
    assert.equal(await page.locator('#confirmModal').isHidden(), true);
    const parDossier = Object.fromEntries(appelsCompose('pull').map((a) => [a.cwd, a.args]));
    assert.deepEqual(parDossier, {
      boutique: ['compose', 'pull', '--', 'api', 'worker'],
      monitoring: ['compose', 'pull', '--', 'grafana'],
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /Action lancée sur 3 services/.test(t.textContent)));
    await waitForJobs(app.api);
    const job = (await app.api('GET', '/api/jobs/current')).body.job;
    assert.equal(job.kind, 'docker');
    assert.equal(job.status, 'done');
    await page.waitForFunction(() => [...document.querySelectorAll('#dactList input[type="checkbox"]')].every((x) => !x.checked));
  });

  test('Stop demande confirmation en nommant les services ; Annuler ne coupe rien', async () => {
    await choisirAction('stop');
    await attendreListe(['web', 'api', 'worker', 'grafana']);
    faux.viderJournal();
    await coche('web').click();
    await page.locator('#dactApply').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmTitle').innerText(), /Interrompre des services/);
    assert.equal((await page.locator('#confirmDetail').innerText()).trim(), '• web');
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal(appelsCompose('stop').length, 0);
    assert.equal(faux.conteneur('boutique-web-1').state, 'running');

    await page.locator('#dactApply').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => faux.conteneur('boutique-web-1').state === 'exited', 'web arrêté');
    assert.deepEqual(appelsCompose('stop').map((a) => [a.cwd, a.args]), [['boutique', ['compose', 'stop', '--', 'web']]]);
    await waitForJobs(app.api);
    // Fin du job → la liste se relit : web ne tourne plus, il sort des cibles de « Stop ».
    await attendreListe(['api', 'worker', 'grafana']);
  });

  test('Démarrer relance ce qui est arrêté ; le nouveau conteneur est créé', async () => {
    await choisirAction('up');
    await attendreListe(['web', 'db', 'cache', 'prometheus', 'alertmanager']);
    for (const s of ['web', 'cache']) await coche(s).click();
    await page.locator('#dactApply').click();
    await attendreServeur(async () => faux.conteneur('boutique-web-1').state === 'running' && Boolean(faux.conteneur('boutique-cache-1')), 'web et cache démarrés');
    assert.equal(await page.locator('#confirmModal').isHidden(), true, 'Démarrer n’interrompt rien : pas de confirmation');
    await waitForJobs(app.api);
    await attendreListe(['db', 'prometheus', 'alertmanager']);
  });

  test('l’action et le filtre sont retenus au rechargement ; la sélection, non', async () => {
    await choisirAction('restart');
    await filtrer('drift');
    await attendreListe(['api', 'worker', 'grafana']);
    await coche('api').click();
    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await page.waitForSelector('#dsub-actions.active');
    await attendreListe(['api', 'worker', 'grafana']);
    assert.equal(await page.locator('#dactAction').inputValue(), 'restart');
    assert.equal(await page.locator('#dactFilter [data-dstate].active').getAttribute('data-dstate'), 'drift');
    assert.equal(await coche('api').isChecked(), false, 'une sélection d’hier ne s’applique pas à l’aveugle');
    assert.equal(await compteur(), '');
    assert.deepEqual((await vus()).length, 3);
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
    assert.ok(dirs.boutique);
  });
});
