'use strict';
/* MENU « DOCKER » — SOUS-ONGLET HORS-COMPOSE, DANS UN VRAI NAVIGATEUR.
 *
 * Les conteneurs sans projet compose : leur état, leur statut et leurs ports ; « Reconstituer
 * la commande » (un `docker run` lisible, secrets masqués, variables héritées de l'image
 * écartées) ; Stop (désactivé sur un conteneur arrêté) ; « Ajouter aux todos » ; Supprimer, qui
 * SAUVEGARDE l'inspect d'abord ; puis le bloc des sauvegardes : copier la commande, Restaurer
 * (avec les VRAIES valeurs, pas les astérisques affichés), Oublier. Et l'état vide.
 *
 * Docker est simulé (helpers/fake-docker.js) : chaque geste est jugé sur l'appel reçu, l'état
 * du faux démon et la base — jamais sur un libellé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker } = require('./helpers/fake-docker');

const { dispo } = navigateurDispo();

describe('Menu Docker — onglet Hors-compose', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
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
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(t); }, readText: async () => '' },
      });
    });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="docker"]').click();
    await page.locator('#tab-docker .subnav [data-dsub="orphans"]').click();
    await page.waitForSelector('#dockerOrphansBox .docker-orphan');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  const carte = (nom) => page.locator('#dockerOrphansBox .docker-orphan').filter({ hasText: nom });
  const sauvegardes = async () => (await app.api('GET', '/api/docker/backups')).body;

  test('les conteneurs sans projet compose sont listés, avec état, statut et ports', async () => {
    assert.equal(await page.locator('#dsub-orphans.active').count(), 1);
    assert.equal(await page.locator('#dockerOrphansBox .docker-orphan').count(), 2, 'les conteneurs compose n’y sont pas');
    assert.match(await carte('redis-seul').locator('.docker-state').getAttribute('class'), /docker-state-running/);
    assert.match(await carte('redis-seul').locator('.meta').innerText(), /Up 2 hours · 0\.0\.0\.0:6379->6379\/tcp/);
    assert.match(await carte('redis-seul').locator('.title code').innerText(), /redis:7/);
    assert.match(await carte('vieux-job').locator('.docker-state').getAttribute('class'), /docker-state-exited/);
    assert.equal(await carte('vieux-job').locator('[data-dockerstop]').isDisabled(), true, 'arrêté : Stop indisponible');
    assert.equal(await carte('redis-seul').locator('[data-dockerstop]').isDisabled(), false);
  });

  test('« Reconstituer la commande » affiche un docker run lisible, secret masqué, puis se replie', async () => {
    await carte('redis-seul').locator('[data-dockerrun]').click();
    const pre = carte('redis-seul').locator('pre.docker-run');
    await pre.waitFor({ state: 'visible' });
    const cmd = await pre.textContent();
    for (const morceau of ['docker run -d', '--name redis-seul', '--restart unless-stopped', '-p 6379:6379/tcp',
      '-e REDIS_PASSWORD=***', '-e MODE=standalone', 'redis:7', 'redis-server --appendonly yes']) {
      assert.ok(cmd.includes(morceau), `« ${morceau} » dans la commande`);
    }
    assert.ok(!cmd.includes('motdepasse-tres-secret'), 'le mot de passe n’est jamais affiché');
    assert.ok(!cmd.includes('PATH='), 'une variable héritée de l’image est écartée');
    await carte('redis-seul').locator('[data-dockerrun]').click();
    await pre.waitFor({ state: 'hidden' });
  });

  test('« Ajouter aux todos » crée une todo liée au conteneur', async () => {
    await carte('vieux-job').locator('[data-add-todo="container"]').click();
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.match(await page.locator('#captureTitle').inputValue(), /vieux-job/);
    await page.locator('#captureOk').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    const trouver = async () => ((await app.api('GET', '/api/todos')).body.todos || [])
      .find((t) => t.link_kind === 'container' && t.link_ref === 'vieux-job');
    await attendreServeur(async () => Boolean(await trouver()), 'la todo est créée');
  });

  test('Stop arrête le conteneur (sans le supprimer)', async () => {
    faux.viderJournal();
    await carte('redis-seul').locator('[data-dockerstop]').click();
    await attendreServeur(async () => faux.conteneur('redis-seul').state === 'exited', 'conteneur arrêté');
    assert.deepEqual(faux.appels().find((a) => a.args[0] === 'stop').args, ['stop', '--', 'c0redis']);
    await waitForJobs(app.api);
    // Fin du job → l'onglet se relit : Stop devient indisponible.
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dockerstop="c0redis"]');
      return b && b.disabled;
    });
    assert.ok(faux.conteneur('redis-seul'), 'toujours là');
  });

  test('Supprimer demande confirmation ; Annuler ne touche à rien', async () => {
    faux.viderJournal();
    await carte('redis-seul').locator('[data-dockerrm]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /redis-seul/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.deepEqual(await sauvegardes(), []);
    assert.ok(!faux.appels().some((a) => a.args[0] === 'rm'));
    assert.equal(await page.locator('#dockerBackupsBox .dk-backup').count(), 0, 'rien à restaurer : pas de bloc');
  });

  test('Supprimer confirmé sauvegarde l’inspect PUIS supprime ; la sauvegarde apparaît', async () => {
    await carte('redis-seul').locator('[data-dockerrm]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => !faux.conteneur('redis-seul'), 'conteneur supprimé');
    assert.deepEqual(faux.appels().find((a) => a.args[0] === 'rm').args, ['rm', '-f', '--', 'c0redis']);
    const [b] = await sauvegardes();
    assert.equal(b.name, 'redis-seul');
    assert.equal(b.image, 'redis:7');
    assert.match(b.run_command, /-e REDIS_PASSWORD=\*\*\*/);
    await waitForJobs(app.api);
    await page.locator('#dockerBackupsBox .dk-backup').waitFor();
    assert.match(await page.locator('#dockerBackupsBox .dk-backup strong').innerText(), /redis-seul/);
    assert.match(await page.locator('#dockerBackupsBox .dk-backup-cmd').textContent(), /--name redis-seul/);
    await carte('redis-seul').waitFor({ state: 'detached' });
  });

  test('copier la commande d’une sauvegarde', async () => {
    await page.locator('#dockerBackupsBox .dk-backup [data-copy-cmd]').click();
    await page.waitForFunction(() => window.__copies.length >= 1);
    const [b] = await sauvegardes();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), b.run_command);
  });

  test('Restaurer recrée le conteneur avec ses VRAIES variables, pas les astérisques affichés', async () => {
    faux.viderJournal();
    await page.locator('#dockerBackupsBox [data-dk-restore]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmTitle').innerText(), /Recréer ce container/);
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => Boolean(faux.conteneur('redis-seul')), 'conteneur recréé');
    const c = faux.conteneur('redis-seul');
    assert.ok(c.env.includes('REDIS_PASSWORD=motdepasse-tres-secret'), 'la vraie valeur, pas ***');
    assert.ok(c.env.includes('MODE=standalone'));
    assert.ok(!c.env.some((v) => v.startsWith('PATH=')), 'la variable de l’image n’est pas figée');
    assert.equal(c.restart, 'unless-stopped');
    assert.equal(c.image, 'redis:7');
    assert.deepEqual(c.cmd, ['redis-server', '--appendonly', 'yes']);
    await waitForJobs(app.api);
    await carte('redis-seul').waitFor();
  });

  test('Oublier une sauvegarde la retire, et le bloc disparaît', async () => {
    await page.locator('#dockerBackupsBox [data-dk-bk-del]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await sauvegardes()).length === 0, 'sauvegarde oubliée');
    await page.waitForFunction(() => document.querySelector('#dockerBackupsBox').innerHTML === '');
  });

  test('sans conteneur hors-compose, l’écran le dit', async () => {
    faux.modifier((e) => { e.containers = e.containers.filter((c) => c.project); });
    await page.locator('#dockerRefresh').click();
    // Le texte de l'état vide, et non « la boîte n'est plus vide » : le squelette la remplit d'abord.
    await page.waitForFunction(() => /Aucun container hors-compose/.test(document.querySelector('#dockerOrphansBox').innerText));
    assert.equal(await page.locator('#dockerOrphansBox .docker-orphan').count(), 0);
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
