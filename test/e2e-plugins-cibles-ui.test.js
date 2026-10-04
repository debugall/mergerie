'use strict';
/* CE QUE LE CŒUR RENDRE AUX PLUGINS, DANS UN VRAI NAVIGATEUR : la ligne d'un dépôt (cible `repo-row`) reçoit la décoration d'un plugin et le dépôt qu'elle
 * décore, un job inscrit par un plugin (`ctx.jobs`) est nommé du nom du plugin dans le journal d'activité, et le bus front dit sa fin (`job.finished`).
 * C'est ce qu'utilise le plugin Docker (la porte vers l'onglet sur un dépôt qui porte un compose, le rechargement après une action) — ici avec un plugin
 * de test, pour que le cœur le prouve sans lui. */
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'ui-cibles');

describe('Plugins — cibles d’écran repo-row, job.finished et nom des jobs de plugin', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repo;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r.mainSha } }];
    await app.configure();
    repo = (await app.api('POST', '/api/repos', { url: r.url, project: 'grp/app' })).body;
    assert.equal((await app.api('POST', '/api/plugins/install', { path: FIXTURE })).status, 200);
    assert.equal((await app.api('POST', '/api/plugins/ui-cibles/enable')).body.ok, true);
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  test('la ligne d’un dépôt porte la décoration du plugin, qui reçoit le dépôt (et ce que le cœur sait de son clone)', async () => {
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="repos"]').click();
    const porte = page.locator(`#repoList .repo-row[data-repo="${repo.id}"] [data-fixture-porte]`);
    await porte.waitFor();
    assert.equal(await porte.innerText(), 'porte grp/app', 'sans compose dans le clone, pas de « (compose) »');
    // Un compose dans le clone : le dépôt arrive au plugin avec `has_compose`, au rechargement de la liste.
    assert.equal((await app.api('POST', `/api/repos/${repo.id}/reclone`)).status, 200);
    const depot = async () => (await app.api('GET', '/api/repos')).body.find((x) => x.id === repo.id);
    await attendreServeur(async () => (await depot()).clone_state === 'present', 'le clone est posé', 60000);
    fs.writeFileSync(path.join((await depot()).clone_dir, 'docker-compose.yml'), 'services: {}\n');
    await page.reload();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="repos"]').click();
    await page.waitForFunction((id) => /\(compose\)/.test((document.querySelector(`#repoList .repo-row[data-repo="${id}"] [data-fixture-porte]`) || {}).textContent || ''), repo.id);
  });

  test('un job de plugin s’appelle du nom du plugin, ne se relance pas d’ici (et dit pourquoi), et le bus front dit sa fin', async () => {
    const lance = await app.api('POST', '/api/plugins/ui-cibles/lancer');
    assert.equal(lance.status, 200, JSON.stringify(lance.body));
    await attendreServeur(async () => (await app.api('GET', '/api/jobs/history')).body.jobs.some((j) => j.id === lance.body.id && j.status === 'done'), 'le job de plugin est fini');
    // Le navigateur apprend la fin par le suivi de la file : l'événement part avec le genre `plugin:<nom>`.
    await page.waitForFunction((id) => window.__jobsFinis.some((j) => j.id === id && j.kind === 'plugin:ui-cibles' && j.status === 'done'), lance.body.id);
    // Le journal d'activité le nomme du nom du plugin (son `displayName`), pas de son genre technique.
    if (await page.locator('#logHist').isHidden()) await page.locator('#logHistBtn').click();
    const ligne = page.locator('#logHist .log-queue-row').filter({ has: page.locator(`[data-histlog="${lance.body.id}"]`) });
    await ligne.waitFor();
    assert.equal(await ligne.locator('.tag').innerText(), 'UI cibles');
    // Et le job ne se rejoue pas d'ici : le serveur le dit, avec la raison.
    const log = (await app.api('GET', `/api/jobs/${lance.body.id}/log`)).body;
    assert.equal(log.can_retry, false);
    assert.deepEqual(erreurs, [], 'aucune erreur de page');
  });
});
