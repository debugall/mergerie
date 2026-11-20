'use strict';
/* LES SESSIONS RÉCURRENTES — dans un vrai navigateur, puis par l'API.
 *
 * Le trajet : « Répéter » dans la modale transforme l'envoi en MODÈLE (aucune session créée), la
 * phrase et la prochaine échéance viennent du serveur, la branche s'annonce datée, un codage sans
 * push est refusé sous la case. L'onglet Récurrentes liste les modèles ; « Exploration récurrente »
 * avec « lancer la première tout de suite » crée une session marquée, dont la carte ramène au
 * modèle. Puis le moteur : le tick crée une session neuve par échéance (branche datée, puis
 * « -2 » le même jour), une seule fois par créneau ; il SAUTE quand la précédente tourne et le
 * dit, et « seulement si ça a bougé » saute quand la forge n'a rien de neuf ; la rétention efface
 * l'ancien sauf une MR ouverte ; la pause retient sans rattraper. Enfin modifier, « Rendre
 * récurrente » depuis une carte, supprimer.
 *
 * Le tick est déclenché par sa route : attendre la minute serait un pari sur l'horloge. Une
 * échéance est rendue « due » en reculant `last_fired_at` en base. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Sessions récurrentes', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repoApp;
  const erreurs = [];
  const ids = {};
  const jour = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const modele = (id) => app.db.prepare('SELECT * FROM recurrence WHERE id = ?').get(id);
  const sessionsDe = (id) => app.db.prepare('SELECT * FROM task WHERE recurrence_uid = ? ORDER BY id').all(modele(id).uid);
  const rendreDue = (id) => app.db.prepare("UPDATE recurrence SET last_fired_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  const tick = async () => (await app.api('POST', '/api/recurrences/tick')).body;
  const carte = (id) => `#recurList .card[data-recur="${id}"]`;
  const lignes = () => page.locator('#targetRows .target-row');
  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`).classList.contains('active'), kind);
  };
  const recharger = async () => { await page.evaluate(() => loadTasks()); };
  const libelleBouton = async () => (await page.locator('#taskSubmit').textContent()).trim();

  before(async () => {
    app = await startApp();
    const r1 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r1.mainSha } }];
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: r1.url }];
    await app.configure();
    repoApp = (await app.api('POST', '/api/repos', { url: r1.url, project: 'grp/app' })).body.id;

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* --------------------------------------------------------- la modale ---- */

  test('« Répéter » change l’envoi : jours, phrase et prochaine échéance du serveur, branche datée, push exigé', async () => {
    await aller('code');
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden]) #targetRows .target-row .t-repo-search');
    assert.equal(await page.locator('#taskRepeatRow').isVisible(), true, 'le bloc est là en codage');
    assert.equal(await page.locator('#taskRepeatDetail').isVisible(), false, '« Jamais » par défaut');

    await page.locator('#taskPrompt').fill('Mettre à jour les dépendances');
    await page.locator('#taskForm [name=label]').fill('Dépendances');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/deps');
    await lignes().nth(0).locator('.t-base').fill('main');

    await page.locator('[data-repeat="weekly"]').click();
    await page.waitForSelector('#taskRepeatDetail:not([hidden])');
    assert.equal(await page.locator('.task-repeat-day[aria-pressed="true"]').count(), 1, 'une semaine sans jour ne partirait jamais : celui d’aujourd’hui est proposé');
    assert.equal(await page.locator('#taskScheduleRow').isVisible(), false, '« Lancer plus tard » n’a pas de sens pour un modèle');
    assert.equal(await libelleBouton(), await tr('recur.btn.create'));
    assert.equal(await page.locator('#taskSubmitOnly').isVisible(), false);

    await page.locator('[data-repeat-preset="weekdays"]').click();
    assert.deepEqual(await page.locator('.task-repeat-day[aria-pressed="true"]').evaluateAll((bs) => bs.map((b) => b.dataset.dow)),
      ['mon', 'tue', 'wed', 'thu', 'fri']);
    await page.waitForFunction(() => /du lundi au vendredi à 07:00 — prochaine : \d\d\/\d\d\/\d\d \d\d:\d\d/.test(document.querySelector('#taskRepeatSaid').textContent));
    assert.match(await page.locator('#taskRepeatBranch').textContent(), new RegExp(`ai/deps-${jour}`), 'la branche s’annonce datée');

    // Revenir à « Jamais » rend les boutons d'une session ordinaire.
    await page.locator('[data-repeat=""]').click();
    await page.waitForFunction((lib) => document.querySelector('#taskSubmit').textContent.trim() === lib, await tr('task.btn.create-run'));
    assert.equal(await page.locator('#taskScheduleRow').isVisible(), true);
    await page.locator('[data-repeat="weekly"]').click();
    await page.locator('[data-repeat-preset="weekdays"]').click();

    // Un codage récurrent pousse : sans la case, refus SOUS la case, rien n'est créé.
    const avant = app.db.prepare('SELECT COUNT(*) c FROM recurrence').get().c;
    await page.locator('[name=auto_push]').uncheck();
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskForm .field-error');
    assert.match(await page.locator('#taskForm .field-error').first().textContent(), /Pousser automatiquement/);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM recurrence').get().c, avant);

    const tachesAvant = app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
    await page.locator('[name=auto_push]').check();
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    const r = app.db.prepare('SELECT * FROM recurrence ORDER BY id DESC LIMIT 1').get();
    ids.code = r.id;
    assert.equal(r.spec, 'weekly mon,tue,wed,thu,fri 07:00');
    assert.equal(r.kind, 'code');
    assert.equal(r.label, 'Dépendances');
    const payload = JSON.parse(r.payload_json);
    assert.equal(payload.targets[0].branch, 'ai/deps-{date}', 'le modèle garde le gabarit');
    assert.equal(payload.autoPush, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task').get().c, tachesAvant, 'un modèle, pas une session');

    // On atterrit sur Récurrentes, et la carte dit l'horaire en toutes lettres.
    await page.waitForFunction(() => document.querySelector('#tab-task .subnav [data-kind="recur"]').classList.contains('active'));
    await page.waitForSelector(carte(ids.code));
    assert.match(await page.locator(carte(ids.code)).innerText(), /Dépendances[\s\S]*du lundi au vendredi à 07:00 — prochaine :/);
    assert.match(await page.locator(carte(ids.code)).innerText(), /Aucune session encore/);
    assert.equal((await page.locator('#kindCountRecur').textContent()).trim(), '1');
  });

  test('« Exploration récurrente », lancée tout de suite : une session marquée, dont la carte ramène au modèle', async () => {
    await aller('recur');
    await page.locator('#btnNewRecurExplore').click();
    await page.waitForSelector('#taskModal:not([hidden]) #targetRows .target-row .t-repo-search');
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('recur.title.new-explore'));
    await page.waitForSelector('#taskRepeatDetail:not([hidden])');
    await page.locator('#taskPrompt').fill('Lister les TODO du code');
    await page.locator('#taskForm [name=label]').fill('Audit des TODO');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await page.locator('[data-repeat-preset="first"]').click();
    await page.waitForFunction(() => /le 1 de chaque mois à 07:00/.test(document.querySelector('#taskRepeatSaid').textContent));
    await page.locator('[name=repeat_run_now]').check();
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

    const r = app.db.prepare('SELECT * FROM recurrence ORDER BY id DESC LIMIT 1').get();
    ids.explore = r.id;
    assert.equal(r.spec, 'monthly 1 07:00');
    const [s] = sessionsDe(ids.explore);
    assert.ok(s, 'la première session est née');
    assert.equal(s.kind, 'explore');
    assert.equal(s.triggered_by, 'recurrence');
    assert.equal(s.label, `Audit des TODO — ${jour}`);
    await waitForJobs(app.api);
    await recharger();
    await page.waitForFunction((id) => /Dernière :/.test((document.querySelector(`#recurList .card[data-recur="${id}"]`) || {}).innerText || ''), ids.explore);

    // « voir la session » ouvre l'exploration ; son badge ↻ ramène au modèle.
    await page.locator(`${carte(ids.explore)} [data-recur-open]`).click();
    await page.waitForFunction(() => document.querySelector('#tab-task .subnav [data-kind="explore"]').classList.contains('active'));
    const badge = page.locator(`#taskList .card[data-task="${s.id}"] .task-recur-badge`);
    await badge.waitFor();
    assert.match(await badge.textContent(), /Audit des TODO/);
    await badge.click();
    await page.waitForFunction(() => document.querySelector('#tab-task .subnav [data-kind="recur"]').classList.contains('active'));
  });

  /* ------------------------------------------------------------ le moteur ---- */

  test('le tick crée une session neuve par échéance, branche datée, une seule fois par créneau ; « -2 » le même jour', async () => {
    assert.equal((await tick()).done.length, 0, 'un modèle neuf ne part pas sur le créneau déjà passé');
    rendreDue(ids.code);
    const d = await tick();
    assert.equal(d.done.length, 1);
    await waitForJobs(app.api);
    const [s1] = sessionsDe(ids.code);
    const cible1 = app.db.prepare('SELECT * FROM task_target WHERE task_id = ?').get(s1.id);
    assert.equal(cible1.branch, `ai/deps-${jour}`);
    assert.equal(s1.auto_push, 1);
    assert.equal((await tick()).done.length, 0, 'le créneau est honoré : pas deux fois');

    rendreDue(ids.code);
    await tick();
    await waitForJobs(app.api);
    const s2 = sessionsDe(ids.code)[1];
    assert.equal(app.db.prepare('SELECT branch FROM task_target WHERE task_id = ?').get(s2.id).branch, `ai/deps-${jour}-2`,
      'la branche du jour est prise : la suivante ne commite pas dedans');
  });

  test('la précédente tourne encore : l’échéance est sautée et la carte le dit ; « Maintenant » refuse', async () => {
    const derniere = sessionsDe(ids.code).pop();
    app.db.prepare("UPDATE task SET status = 'running' WHERE id = ?").run(derniere.id);
    const n = sessionsDe(ids.code).length;
    rendreDue(ids.code);
    const d = await tick();
    assert.equal(d.done[0].skipped, 'busy');
    assert.equal(sessionsDe(ids.code).length, n, 'rien de créé');
    assert.equal(modele(ids.code).last_skip, 'busy');
    const refus = await app.api('POST', `/api/recurrences/${ids.code}/run`);
    assert.equal(refus.status, 409);
    await aller('recur');
    await recharger();
    await page.waitForFunction((id) => /sautée.*tournait encore/.test((document.querySelector(`#recurList .card[data-recur="${id}"]`) || {}).innerText || ''), ids.code);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(derniere.id);
  });

  test('« seulement si ça a bougé » : sauté quand la branche de base n’a pas bougé, relancé quand elle bouge', async () => {
    const r = (await app.api('POST', '/api/recurrences', {
      kind: 'explore', label: 'Si ça bouge', prompt: 'Relire main', schedule: 'daily 06:00', skip_unchanged: true,
      targets: [{ repo_id: repoApp, base_branch: 'main' }],
    })).body;
    ids.change = r.id;
    rendreDue(r.id);
    await tick();
    await waitForJobs(app.api);
    assert.equal(sessionsDe(r.id).length, 1, 'la première fois, rien à comparer : elle part');
    assert.ok(modele(r.id).last_shas_json, 'la tête de main est retenue');

    rendreDue(r.id);
    assert.equal((await tick()).done[0].skipped, 'unchanged');
    assert.equal(sessionsDe(r.id).length, 1);

    app.state.branches['grp/app'][0].commit.id = 'f'.repeat(40);
    rendreDue(r.id);
    await tick();
    await waitForJobs(app.api);
    assert.equal(sessionsDe(r.id).length, 2, 'main a bougé : elle repart');
  });

  test('la rétention garde les N dernières — sauf une session dont la merge request est ouverte', async () => {
    await app.api('PUT', `/api/recurrences/${ids.change}`, {
      label: 'Si ça bouge', prompt: 'Relire main', schedule: 'daily 06:00', skip_unchanged: false, keep_last: 1,
      targets: [{ repo_id: repoApp, base_branch: 'main' }],
    });
    const [premiere] = sessionsDe(ids.change);
    app.db.prepare('UPDATE task_target SET mr_iid = 7, mr_merged = 0 WHERE task_id = ?').run(premiere.id);
    const run = await app.api('POST', `/api/recurrences/${ids.change}/run`);
    assert.equal(run.status, 200);
    await waitForJobs(app.api);
    const restantes = sessionsDe(ids.change).map((s) => s.id);
    assert.ok(restantes.includes(premiere.id), 'la MR ouverte la garde');
    assert.ok(restantes.includes(run.body.task_id), 'la plus récente reste');
    assert.equal(restantes.length, 2, 'la session du milieu, finie et sans MR, est effacée');
  });

  test('en pause, rien ne part ; reprendre ne rattrape pas le créneau manqué', async () => {
    await aller('recur');
    await recharger();
    await page.locator(`${carte(ids.change)} [data-recur-pause]`).click();
    await page.waitForFunction((id) => /En pause/.test((document.querySelector(`#recurList .card[data-recur="${id}"]`) || {}).innerText || ''), ids.change);
    assert.equal(modele(ids.change).paused, 1);
    const n = sessionsDe(ids.change).length;
    rendreDue(ids.change);
    assert.ok(!(await tick()).done.some((x) => x.id === ids.change));
    await page.locator(`${carte(ids.change)} [data-recur-pause]`).click();
    await attendreServeur(async () => modele(ids.change).paused === 0, 'la reprise est enregistrée');
    assert.ok(!(await tick()).done.some((x) => x.id === ids.change), 'le créneau manqué pendant la pause ne part pas');
    assert.equal(sessionsDe(ids.change).length, n);
  });

  /* --------------------------------------------------------- les gestes ---- */

  test('modifier un modèle : la branche garde {date}, « Jamais » n’est pas proposé, l’horaire change', async () => {
    await aller('recur');
    await page.locator(`${carte(ids.code)} [data-recur-edit]`).click();
    await page.waitForSelector('#taskModal:not([hidden]) #taskRepeatDetail:not([hidden])');
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('recur.title.edit'));
    assert.equal(await lignes().nth(0).locator('.t-branch').inputValue(), 'ai/deps-{date}');
    assert.equal(await page.locator('[data-repeat=""]').isVisible(), false);
    assert.equal(await page.locator('#taskRepeatRunNowRow').isVisible(), false);
    // Retirer mardi, mercredi et vendredi : il reste lundi et jeudi.
    for (const j of ['tue', 'wed', 'fri']) await page.locator(`.task-repeat-day[data-dow="${j}"]`).click();
    await page.waitForFunction(() => /chaque lundi et jeudi à 07:00/.test(document.querySelector('#taskRepeatSaid').textContent));
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => modele(ids.code).spec === 'weekly mon,thu 07:00', 'l’horaire est enregistré');
    assert.equal(JSON.parse(modele(ids.code).payload_json).targets[0].branch, 'ai/deps-{date}');
  });

  test('« Rendre récurrente » depuis une carte : la copie, sa branche sans suffixe, Répéter ouvert', async () => {
    const s = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Corriger la typo', label: 'Typo', auto_push: false,
      targets: [{ repo_id: repoApp, branch: 'ai/typo-2', base_branch: 'main' }],
    })).body;
    await aller('code');
    await recharger();
    await page.locator(`#taskList .card[data-task="${s.id}"] [data-trecur]`).click();
    await page.waitForSelector('#taskModal:not([hidden]) #taskRepeatDetail:not([hidden])');
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('recur.title.from-session'));
    assert.equal(await lignes().nth(0).locator('.t-branch').inputValue(), 'ai/typo');
    assert.equal(await page.locator('[name=auto_push]').isChecked(), true, 'un codage récurrent pousse');
    assert.equal(await page.locator('#taskPrompt').inputValue(), 'Corriger la typo');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    const r = app.db.prepare('SELECT * FROM recurrence ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.label, 'Typo');
    assert.equal(JSON.parse(r.payload_json).targets[0].branch, 'ai/typo-{date}');
    ids.typo = r.id;
  });

  test('supprimer un modèle : il disparaît, ses sessions restent', async () => {
    const n = sessionsDe(ids.explore).length;
    const uid = modele(ids.explore).uid;
    await aller('recur');
    await recharger();
    await page.locator(`${carte(ids.explore)} [data-recur-del]`).click();
    await page.locator('#confirmOk').click();
    await page.waitForSelector(carte(ids.explore), { state: 'detached' });
    assert.equal(modele(ids.explore), undefined);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task WHERE recurrence_uid = ?').get(uid).c, n);
    assert.equal(erreurs.length, 0, `aucune erreur JS : ${erreurs.join(' | ')}`);
  });
});
