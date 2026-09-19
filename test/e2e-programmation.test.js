'use strict';
/* LANCER PLUS TARD — dans un vrai navigateur, puis par l'API.
 *
 * Le trajet : une date dans la modale change le bouton (« Créer et programmer »), la session
 * est créée SANS job et sa carte porte la date ; la croix l'annule ; le tick la lance quand la
 * date est là, et pas avant ; lancer à la main annule la date. Puis le suivi : écrit sur la
 * carte avec sa date, il s'affiche « programmé », part au tick avec son texte, sans la case
 * « automatiquement ». Et le hors dépôt suit le même contrat, par sa propre route.
 *
 * Le tick est déclenché par une route dédiée : attendre soixante secondes serait un pari sur
 * l'horloge. La date « due » est posée en base : le serveur refuse une date passée, à raison. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Lancer plus tard : sessions et suivis programmés', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repoApp; let dossier;
  const erreurs = [];
  const ids = {};
  // Une date à venir, en heure LOCALE : celle que le champ affiche, celle que le poste lancera.
  const DATE_LOCALE = '2031-06-15T07:30';
  const DATE_ISO = new Date(DATE_LOCALE).toISOString();
  const PASSEE = '2020-01-01T00:00:00.000Z';

  const carte = (id) => `#taskList .card[data-task="${id}"]`;
  const carteLocale = (id) => `#localList .card[data-local="${id}"]`;
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const jobs = () => app.db.prepare('SELECT COUNT(*) c FROM job').get().c;
  const dernierJob = () => app.db.prepare('SELECT * FROM job ORDER BY id DESC LIMIT 1').get();
  const session = async (id) => (await app.api('GET', `/api/tasks/${id}`)).body.task;
  const locale = async (id) => (await app.api('GET', `/api/local-tasks/${id}`)).body.task;
  // La date, mise dans le passé EN BASE : c'est ainsi qu'un tick la trouve due.
  const rendreDue = (kind, uid, cle) => app.db.prepare('UPDATE local_pref SET value = ? WHERE kind = ? AND ref = ? AND key = ?')
    .run(PASSEE, kind, uid, cle);
  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  const ouvrir = async (kind) => {
    await aller(kind);
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    if (kind === 'code' || kind === 'explore') await page.waitForSelector('#targetRows .target-row .t-repo-search');
  };
  const lignes = () => page.locator('#targetRows .target-row');

  before(async () => {
    app = await startApp();
    const r1 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r1.mainSha } }];
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: r1.url }];
    await app.configure();
    repoApp = (await app.api('POST', '/api/repos', { url: r1.url, project: 'grp/app' })).body.id;
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    dossier = path.join(racine, 'outils');
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, 'a.txt'), 'a\n');
    await app.api('POST', '/api/local-roots', { path: racine, label: 'mes projets' });

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ------------------------------------------------------------ la modale ---- */

  test('une date dans la modale : le bouton dit « Créer et programmer », la session est créée sans job, avec sa date', async () => {
    const avantJobs = jobs();
    await ouvrir('code');
    assert.equal(await page.locator('#taskScheduleRow').isVisible(), true, 'le champ est là en codage');
    assert.equal((await page.locator('#taskSubmit').textContent()).trim(), await tr('task.btn.create-run'));
    await page.locator('#taskPrompt').fill('Session programmée');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/programmee');
    await lignes().nth(0).locator('.t-base').fill('main');
    await page.locator('#taskScheduleAt').fill(DATE_LOCALE);
    // Le bouton change avec la date, et « Créer sans lancer » n'a plus de sens.
    await page.waitForFunction((lib) => document.querySelector('#taskSubmit').textContent.trim() === lib, await tr('task.btn.create-schedule'));
    assert.equal(await page.locator('#taskSubmitOnly').isVisible(), false);
    // Effacer la date rend les boutons d'avant ; la remettre les reprend.
    await page.locator('#taskScheduleAt').fill('');
    await page.waitForFunction((lib) => document.querySelector('#taskSubmit').textContent.trim() === lib, await tr('task.btn.create-run'));
    assert.equal(await page.locator('#taskSubmitOnly').isVisible(), true);
    await page.locator('#taskScheduleAt').fill(DATE_LOCALE);
    await page.waitForFunction((lib) => document.querySelector('#taskSubmit').textContent.trim() === lib, await tr('task.btn.create-schedule'));

    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    const t = app.db.prepare('SELECT * FROM task ORDER BY id DESC LIMIT 1').get();
    ids.code = t.id;
    await attendreServeur(async () => (await session(ids.code)).scheduled_at === DATE_ISO, 'la date est enregistrée sur la session');
    assert.equal(jobs(), avantJobs, 'aucun job : la session attend sa date');
    assert.equal((await session(ids.code)).status, 'new');
    // La carte porte la date, et « Lancer » reste là — lancer maintenant reste possible.
    await page.waitForSelector(`${carte(ids.code)} .tag-programme`);
    assert.equal(await page.locator(`${carte(ids.code)} [data-trun]`).isVisible(), true);
  });

  test('une date passée est signalée sous le champ, rien n’est créé', async () => {
    const avant = app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
    await ouvrir('explore');
    assert.equal(await page.locator('#taskScheduleRow').isVisible(), true, 'le champ est là en exploration');
    await page.locator('#taskPrompt').fill('Trop tard');
    await page.locator('#taskScheduleAt').fill('2020-01-01T08:00');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskScheduleRow .field-error');
    assert.equal(await page.locator('#taskModal').isVisible(), true, 'la modale reste ouverte');
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task').get().c, avant);
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  test('la question libre ne se programme pas : pas de champ', async () => {
    await ouvrir('ask');
    assert.equal(await page.locator('#taskScheduleRow').isVisible(), false);
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  /* ------------------------------------------------------------ la carte ---- */

  test('la croix de la carte annule la date', async () => {
    await aller('code');
    await page.waitForSelector(`${carte(ids.code)} [data-unschedule]`);
    await page.locator(`${carte(ids.code)} [data-unschedule]`).click();
    await attendreServeur(async () => (await session(ids.code)).scheduled_at === null, 'la date est retirée');
    await page.waitForSelector(`${carte(ids.code)} .tag-programme`, { state: 'detached' });
  });

  test('l’édition relit la date et l’enregistre avec le reste', async () => {
    await aller('code');
    await page.locator(`${carte(ids.code)} [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal(await page.locator('#taskScheduleAt').inputValue(), '', 'plus de date après la croix');
    await page.locator('#taskScheduleAt').fill(DATE_LOCALE);
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => (await session(ids.code)).scheduled_at === DATE_ISO, 'la date posée à l’édition est enregistrée');
    // Rouverte, la modale montre la date ; enregistrer sans y toucher la laisse en place.
    await page.locator(`${carte(ids.code)} [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal(await page.locator('#taskScheduleAt').inputValue(), DATE_LOCALE);
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    assert.equal((await session(ids.code)).scheduled_at, DATE_ISO);
  });

  /* ------------------------------------------------------------ l’API et le tick ---- */

  test('l’API refuse une date passée ou illisible', async () => {
    for (const at of [PASSEE, 'demain matin']) {
      const r = await app.api('PUT', `/api/tasks/${ids.code}/schedule`, { at });
      assert.equal(r.status, 400, at);
    }
    assert.equal((await session(ids.code)).scheduled_at, DATE_ISO, 'la date en place n’a pas bougé');
  });

  test('le tick ne lance rien avant la date, puis lance la session une fois', async () => {
    const avantJobs = jobs();
    let r = await app.api('POST', '/api/schedule/tick');
    assert.equal(r.body.started, 0);
    assert.equal(jobs(), avantJobs);
    const { uid } = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(ids.code);
    rendreDue('task', uid, 'run_at');
    r = await app.api('POST', '/api/schedule/tick');
    assert.equal(r.body.started, 1, r.body.log.join('\n'));
    assert.equal(jobs(), avantJobs + 1);
    assert.equal(dernierJob().target_id, ids.code);
    await waitForJobs(app.api, { timeout: 120000 });
    const t = await session(ids.code);
    assert.equal(t.scheduled_at, null, 'la date est partie avec le lancement');
    assert.notEqual(t.status, 'new', 'la session a tourné');
    // Un second tick ne relance rien.
    r = await app.api('POST', '/api/schedule/tick');
    assert.equal(r.body.started, 0);
    assert.equal(jobs(), avantJobs + 1);
  });

  test('lancer à la main annule la date programmée', async () => {
    assert.equal((await app.api('PUT', `/api/tasks/${ids.code}/schedule`, { at: DATE_ISO })).body.scheduled_at, DATE_ISO);
    await app.api('POST', `/api/tasks/${ids.code}/run`);
    assert.equal((await session(ids.code)).scheduled_at, null);
    await waitForJobs(app.api, { timeout: 120000 });
  });

  /* ------------------------------------------------------------ le suivi ---- */

  test('un suivi écrit avec sa date s’affiche « programmé », sans la case automatique', async () => {
    await aller('code');
    await page.waitForSelector(`${carte(ids.code)} [data-tfollow]`);
    await page.locator(`${carte(ids.code)} [data-tfollow]`).click();
    const form = `${carte(ids.code)} .followup[data-followform="${ids.code}"]`;
    await page.waitForSelector(`${form}:not([hidden])`);
    await page.locator(`${form} .followup-text`).fill('Ajoute des tests');
    await page.locator(`${form} .followup-auto`).check();
    await page.locator(`${form} .followup-at`).fill(DATE_LOCALE);
    await page.locator(`${form} [data-followsave]`).click();
    await attendreServeur(async () => (await session(ids.code)).followup_at === DATE_ISO, 'la date du suivi est enregistrée');
    const t = await session(ids.code);
    assert.equal(t.followup_draft, 'Ajoute des tests');
    assert.equal(t.followup_auto, 0, 'une date remplace la case : un seul armement');
    await page.waitForSelector(`${carte(ids.code)} .followup-draft.is-auto`);
    assert.match(await page.locator(`${carte(ids.code)} .followup-draft-head`).textContent(), new RegExp(await tr('task.followup.draft-scheduled')));
  });

  test('le suivi programmé part au tick avec son texte, et le brouillon s’efface', async () => {
    const avantJobs = jobs();
    const { uid } = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(ids.code);
    rendreDue('task', uid, 'followup_at');
    const r = await app.api('POST', '/api/schedule/tick');
    assert.equal(r.body.started, 1, r.body.log.join('\n'));
    assert.equal(jobs(), avantJobs + 1);
    const spec = JSON.parse(dernierJob().retry);
    assert.equal(spec.action, 'followup');
    assert.equal(spec.opts.instruction, 'Ajoute des tests');
    await waitForJobs(app.api, { timeout: 120000 });
    const t = await session(ids.code);
    assert.equal(t.followup_draft, null);
    assert.equal(t.followup_at, null);
  });

  test('supprimer le suivi emporte sa date', async () => {
    await app.api('PUT', `/api/tasks/${ids.code}/followup-draft`, { instruction: 'Encore', at: DATE_ISO });
    assert.equal((await session(ids.code)).followup_at, DATE_ISO);
    await app.api('PUT', `/api/tasks/${ids.code}/followup-draft`, { instruction: '' });
    const t = await session(ids.code);
    assert.equal(t.followup_draft, null);
    assert.equal(t.followup_at, null);
  });

  /* ------------------------------------------------------------ hors dépôt ---- */

  test('hors dépôt : même contrat, sa carte porte la date et la croix l’annule', async () => {
    ids.local = (await app.api('POST', '/api/local-tasks', { prompt: 'Hors dépôt programmé', dirs: [dossier] })).body.id;
    assert.equal((await app.api('PUT', `/api/local-tasks/${ids.local}/schedule`, { at: DATE_ISO })).body.scheduled_at, DATE_ISO);
    assert.equal((await locale(ids.local)).scheduled_at, DATE_ISO);
    assert.equal((await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === ids.local).scheduled_at, DATE_ISO, 'la liste aussi');
    await aller('local');
    await page.waitForSelector(`${carteLocale(ids.local)} .tag-programme`);
    await page.locator(`${carteLocale(ids.local)} [data-lunschedule]`).click();
    await attendreServeur(async () => (await locale(ids.local)).scheduled_at === null, 'la date est retirée');
    await page.waitForSelector(`${carteLocale(ids.local)} .tag-programme`, { state: 'detached' });
  });

  test('hors dépôt : le tick lance la session par la file « local »', async () => {
    const avantJobs = jobs();
    await app.api('PUT', `/api/local-tasks/${ids.local}/schedule`, { at: DATE_ISO });
    const { uid } = app.db.prepare('SELECT uid FROM local_task WHERE id = ?').get(ids.local);
    rendreDue('local_task', uid, 'run_at');
    const r = await app.api('POST', '/api/schedule/tick');
    assert.equal(r.body.started, 1, r.body.log.join('\n'));
    assert.equal(jobs(), avantJobs + 1);
    assert.equal(dernierJob().kind, 'local');
    await waitForJobs(app.api, { timeout: 120000 });
    assert.equal((await locale(ids.local)).scheduled_at, null);
    assert.notEqual((await locale(ids.local)).status, 'new');
  });

  test('ce qui est programmé se liste, et la page n’a levé aucune erreur', async () => {
    await app.api('PUT', `/api/local-tasks/${ids.local}/schedule`, { at: DATE_ISO });
    const { body } = await app.api('GET', '/api/schedule');
    assert.deepEqual(body.items.map((p) => [p.kind, p.quoi, p.at]), [['local_task', 'run', DATE_ISO]]);
    assert.deepEqual(erreurs, []);
  });
});
