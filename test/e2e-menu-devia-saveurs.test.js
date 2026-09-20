'use strict';
/* MENU « DEV IA » — LES GESTES DES TROIS AUTRES SAVEURS, dans un VRAI navigateur :
 * exploration, codage hors dépôt, question libre.
 *
 * Chacune a SA carte et SON câblage — c'est précisément ce qui a laissé passer des boutons
 * inertes par le passé (câblés sur `#taskList` seulement). Chaque geste est donc éprouvé dans
 * la liste où il vit, et jugé à son effet côté serveur : passes d'agent, statut, brouillon de
 * suivi, prompt enregistré.
 *
 * Exploration : lancer, voir la réponse, question de suivi, « coder à partir de la réponse »,
 * répondre aux questions de l'agent.
 * Hors dépôt : retour de l'IA par dossier (et bascule de dossier), relancer UN dossier,
 * relancer les dossiers en échec, suivi ouvert puis annulé, « j'ai répondu au terminal ».
 * Question libre : lancer, relancer (avec confirmation), voir la réponse, suivi enregistré /
 * relu / supprimé / envoyé, « coder à partir de la réponse », modifier la question.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Dev IA — exploration, hors dépôt, question libre', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let page;
  const erreurs = [];
  let repoApp;
  let racine;
  const ids = {};

  const CARTE = {
    explore: (id) => `#taskList .card[data-task="${id}"]`,
    local: (id) => `#localList .card[data-local="${id}"]`,
    ask: (id) => `#askList .card[data-ask="${id}"]`,
  };
  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  const recharger = () => page.evaluate(() => loadTasks());
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const passes = (scope, col, id) => app.db.prepare(`SELECT COUNT(*) c FROM agent_pass WHERE scope = ? AND ${col} = ?`).get(scope, id).c;
  const confirmer = async () => {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
  };
  const fermerVue = async () => {
    await page.locator('#taskMdClose').click();
    await page.waitForSelector('#taskMdView[hidden]', { state: 'attached' });
  };
  const locale = async (id) => (await app.api('GET', `/api/local-tasks/${id}`)).body.task;
  const question = async (id) => (await app.api('GET', `/api/questions/${id}`)).body.task;
  const exploration = async (id) => (await app.api('GET', `/api/tasks/${id}`)).body.task;

  before(async () => {
    app = await startApp();
    const r1 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r1.mainSha } }];
    await app.configure();
    repoApp = (await app.api('POST', '/api/repos', { url: r1.url, project: 'grp/app' })).body.id;

    ids.explore = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est lu le fichier de configuration ?', targets: [{ repo_id: repoApp, branch: 'main' }],
    })).body.id;
    ids.exploreQ = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Comment fonctionne la facturation ?', ask_questions: true,
      targets: [{ repo_id: repoApp, branch: 'main' }],
    })).body.id;

    racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    for (const d of ['scripts', 'outils', 'attente']) fs.mkdirSync(path.join(racine, d), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    ids.local = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Ranger les scripts', dirs: [path.join(racine, 'scripts'), path.join(racine, 'outils')],
    })).body.id;
    ids.localQ = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Nettoyer', ask_questions: true, dirs: [path.join(racine, 'attente')],
    })).body.id;
    // Les sessions hors dépôt tournent d'avance : ce sont leurs GESTES d'après qu'on éprouve ici.
    await app.api('POST', `/api/local-tasks/${ids.local}/run`);
    await app.api('POST', `/api/local-tasks/${ids.localQ}/run`);
    await waitForJobs(app.api, { timeout: 120000 });

    ids.ask = (await app.api('POST', '/api/questions', { prompt: 'Qu’est-ce qu’un quorum ?', label: 'Quorum' })).body.id;

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ================================================================ exploration ==== */

  test('exploration : « Lancer » puis « Voir la réponse »', async () => {
    await aller('explore');
    const carte = CARTE.explore(ids.explore);
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-trun]`).click();
    await attendreServeur(async () => (await exploration(ids.explore)).status === 'done', 'l’exploration a répondu', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    await recharger();
    await page.locator(`${carte} [data-tmd]`).click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    await page.waitForFunction(() => /configuration/.test(document.querySelector('#taskMdBody').textContent));
    await fermerVue();
  });

  test('exploration : une question de suivi repart dans la même session et garde les deux passes', async () => {
    const carte = CARTE.explore(ids.explore);
    await page.locator(`${carte} [data-tfollow]`).click();
    const form = page.locator(`#taskList .followup[data-followform="${ids.explore}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator('.followup-text').fill('Et en production ?');
    assert.equal((await form.locator(`[data-followsubmit="${ids.explore}"]`).textContent()).trim(), await tr('task.btn.ask'));
    await form.locator(`[data-followsubmit="${ids.explore}"]`).click();
    await attendreServeur(async () => (await app.api('GET', `/api/tasks/${ids.explore}/passes`)).body.passes.length === 2,
      'la question de suivi a sa propre passe', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    const { body } = await app.api('GET', `/api/tasks/${ids.explore}/passes`);
    assert.deepEqual(body.passes.map((p) => p.kind), ['run', 'followup']);
  });

  test('exploration : « Coder à partir de la réponse » ouvre un codage sur les mêmes dépôts, réponse en contexte', async () => {
    await recharger();
    await page.locator(`${CARTE.explore(ids.explore)} [data-tcode]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('task.explore-to-code.title'));
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.ok(prompt.startsWith(await tr('task.explore-to-code.header')), 'le contexte ouvre la demande');
    assert.match(prompt, /Où est lu le fichier de configuration/, 'la question posée');
    assert.deepEqual(await page.$$eval('#targetRows .target-row .t-repo', (els) => els.map((e) => Number(e.value))), [repoApp]);
    assert.equal(await page.locator('#targetRows .target-row .t-base').inputValue(), 'main',
      'la branche LUE devient la branche de départ, jamais celle où l’on écrit');
    assert.equal(await page.locator('#codeOnlyFields').isVisible(), true, 'c’est bien un codage');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  test('exploration : les questions de l’agent se répondent depuis la carte, puis la session reprend', async () => {
    await app.api('POST', `/api/tasks/${ids.exploreQ}/run`);
    await waitForJobs(app.api, { timeout: 60000 });
    assert.equal((await exploration(ids.exploreQ)).status, 'needs_input');
    await aller('explore');
    await recharger();
    const carte = CARTE.explore(ids.exploreQ);
    await page.waitForSelector(`${carte} .questions-box`);
    // Répondre à tout : un choix fermé quand l'agent en propose, du texte libre sinon.
    const radios = page.locator(`${carte} .questions-box .q-opts input[type="radio"]`);
    if (await radios.count()) await radios.first().click();
    const libres = page.locator(`${carte} .questions-box .q-free`);
    for (let i = 0; i < await libres.count(); i += 1) await libres.nth(i).fill('Oui, par mois');
    await page.locator(`${carte} [data-qsubmit]`).click();
    await attendreServeur(async () => (await exploration(ids.exploreQ)).status !== 'needs_input', 'l’exploration a repris', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
  });

  /* ================================================================ hors dépôt ==== */

  test('hors dépôt : le retour de l’IA d’un dossier s’ouvre, et bascule vers l’autre dossier', async () => {
    await aller('local');
    const carte = CARTE.local(ids.local);
    await page.waitForSelector(`${carte} [data-tfold]`);
    await page.locator(`${carte} [data-tfold]`).click();
    await page.waitForSelector(`${carte} [data-tfold][aria-expanded="true"]`);
    const dirs = (await locale(ids.local)).dirs;
    await page.locator(`${carte} [data-ldout="${dirs[0].id}"]`).click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    // Deux dossiers ont un retour : le sélecteur permet de passer de l'un à l'autre.
    await page.waitForSelector('#taskPassDir:not([hidden])');
    assert.equal(await page.locator('#taskPassDir').inputValue(), String(dirs[0].id));
    await page.locator('#taskPassDir').selectOption(String(dirs[1].id));
    await page.waitForFunction((id) => document.querySelector('#taskPassDir').value === String(id), dirs[1].id);
    await fermerVue();
  });

  test('hors dépôt : relancer UN dossier demande confirmation, et ne refait que lui', async () => {
    const carte = CARTE.local(ids.local);
    const [d0, d1] = (await locale(ids.local)).dirs;
    const [a0, a1] = [passes('local', 'unit_id', d0.id), passes('local', 'unit_id', d1.id)];
    await page.locator(`${carte} [data-ldrun="${d1.id}"]`).click();
    await confirmer();
    await attendreServeur(async () => passes('local', 'unit_id', d1.id) > a1, 'le dossier relancé a une passe de plus', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    assert.equal(passes('local', 'unit_id', d0.id), a0, 'l’autre dossier n’a pas été retouché');
  });

  test('hors dépôt : « Relancer les échecs » ne reprend que le dossier en erreur', async () => {
    const [d0, d1] = (await locale(ids.local)).dirs;
    app.db.prepare("UPDATE local_task_dir SET status = 'error', last_error = 'disque plein' WHERE id = ?").run(d0.id);
    app.db.prepare("UPDATE local_task SET status = 'error' WHERE id = ?").run(ids.local);
    await recharger();
    const [a0, a1] = [passes('local', 'unit_id', d0.id), passes('local', 'unit_id', d1.id)];
    await page.locator(`${CARTE.local(ids.local)} [data-lrunfailed]`).click();
    await confirmer();
    await attendreServeur(async () => passes('local', 'unit_id', d0.id) > a0, 'le dossier en échec est repris', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    assert.equal(passes('local', 'unit_id', d1.id), a1, 'le dossier réussi n’a pas été refait');
    assert.equal((await locale(ids.local)).dirs.find((d) => d.id === d0.id).status, 'done');
  });

  test('hors dépôt : le formulaire de suivi s’ouvre et « Annuler » le referme', async () => {
    await recharger();
    await page.locator(`${CARTE.local(ids.local)} [data-lfollow]`).click();
    const form = page.locator(`#localList .followup[data-lfollowform="${ids.local}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator(`[data-lfollowcancel="${ids.local}"]`).click();
    await form.waitFor({ state: 'hidden' });
  });

  test('hors dépôt : un suivi enregistré se supprime depuis la carte', async () => {
    await app.api('PUT', `/api/local-tasks/${ids.local}/followup-draft`, { instruction: 'Penser aux droits', auto: false });
    await recharger();
    const carte = CARTE.local(ids.local);
    await page.waitForSelector(`${carte} .followup-draft`);
    await page.locator(`${carte} [data-lfollowdrop="${ids.local}"]`).click();
    await attendreServeur(async () => (await locale(ids.local)).followup_draft == null, 'le suivi est supprimé');
    await page.waitForSelector(`${carte} .followup-draft`, { state: 'detached' });
  });

  test('hors dépôt : « j’ai répondu au terminal » rend le dossier sans relancer l’agent', async () => {
    const d = (await locale(ids.localQ)).dirs[0];
    assert.equal(d.status, 'needs_input');
    const avant = passes('local', 'unit_id', d.id);
    await recharger();
    await page.locator(`${CARTE.local(ids.localQ)} [data-qelsewhere]`).click();
    await confirmer();
    await attendreServeur(async () => (await locale(ids.localQ)).dirs[0].status === 'done', 'le dossier est rendu');
    assert.equal(passes('local', 'unit_id', d.id), avant, 'aucune passe d’agent de plus');
    await page.waitForSelector(`${CARTE.local(ids.localQ)} .questions-box:not(.resuming) [data-qsubmit]`, { state: 'detached' });
  });

  /* ================================================================ question libre ==== */

  test('question libre : « Lancer » la pose sans confirmation, et la réponse s’ouvre', async () => {
    await aller('ask');
    const carte = CARTE.ask(ids.ask);
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-qrun]`).click();
    assert.equal(await page.locator('#confirmModal').isHidden(), true, 'rien n’a tourné : rien à protéger');
    await attendreServeur(async () => (await question(ids.ask)).status === 'done', 'la question a sa réponse', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    await recharger();
    await page.locator(`${carte} [data-qmd]`).click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    await page.waitForFunction(() => /quorum/i.test(document.querySelector('#taskMdBody').textContent));
    await fermerVue();
  });

  test('question libre : un suivi s’enregistre, se relit, se supprime', async () => {
    const carte = CARTE.ask(ids.ask);
    await page.locator(`${carte} [data-qfollow]`).click();
    const form = page.locator(`#askList .followup[data-qfollowform="${ids.ask}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator('.followup-text').fill('Et avec cinq nœuds ?');
    await form.locator(`[data-qfollowsave="${ids.ask}"]`).click();
    await attendreServeur(async () => (await question(ids.ask)).followup_draft === 'Et avec cinq nœuds ?', 'le suivi est enregistré');
    await page.waitForSelector(`${carte} .followup-draft`);

    // « Modifier » rouvre le formulaire avec le texte enregistré.
    await page.locator(`${carte} [data-qfollowedit="${ids.ask}"]`).click();
    await form.waitFor({ state: 'visible' });
    assert.equal(await form.locator('.followup-text').inputValue(), 'Et avec cinq nœuds ?');
    await form.locator(`[data-qfollowcancel="${ids.ask}"]`).click();

    await page.locator(`${carte} [data-qfollowdrop="${ids.ask}"]`).click();
    await attendreServeur(async () => (await question(ids.ask)).followup_draft == null, 'le suivi est supprimé');
    await page.waitForSelector(`${carte} .followup-draft`, { state: 'detached' });
  });

  test('question libre : un suivi enregistré s’envoie depuis la carte', async () => {
    const carte = CARTE.ask(ids.ask);
    await app.api('PUT', `/api/questions/${ids.ask}/followup-draft`, { instruction: 'Et si un nœud tombe ?', auto: false });
    await recharger();
    const avant = passes('ask', 'task_id', ids.ask);
    await page.locator(`${carte} [data-qfollowsend="${ids.ask}"]`).click();
    await attendreServeur(async () => passes('ask', 'task_id', ids.ask) > avant, 'le suivi enregistré est parti', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    assert.equal((await question(ids.ask)).followup_draft, null, 'envoyé, il n’attend plus');
  });

  test('question libre : une question de suivi s’envoie directement', async () => {
    await recharger();
    const carte = CARTE.ask(ids.ask);
    const avant = passes('ask', 'task_id', ids.ask);
    await page.locator(`${carte} [data-qfollow]`).click();
    const form = page.locator(`#askList .followup[data-qfollowform="${ids.ask}"]`);
    await form.locator('.followup-text').fill('Résume en une phrase.');
    // Deux fichiers joints au suivi, dont un qu'on retire avant d'envoyer.
    await form.locator('.followup-file').setInputFiles([
      { name: 'schema.txt', mimeType: 'text/plain', buffer: Buffer.from('le schéma') },
      { name: 'brouillon.txt', mimeType: 'text/plain', buffer: Buffer.from('à retirer') },
    ]);
    await page.waitForFunction((id) => document.querySelectorAll(`#askList .followup[data-qfollowform="${id}"] .followup-prev .task-prev`).length === 2, ids.ask);
    await form.locator('.followup-prev [data-rmfollowimg="1"]').click();
    await page.waitForFunction((id) => document.querySelectorAll(`#askList .followup[data-qfollowform="${id}"] .followup-prev .task-prev`).length === 1, ids.ask);
    const piecesAvant = (await app.api('GET', `/api/questions/${ids.ask}`)).body.images.length;
    await form.locator(`[data-qfollowsubmit="${ids.ask}"]`).click();
    await attendreServeur(async () => passes('ask', 'task_id', ids.ask) > avant, 'la question de suivi est partie', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    const derniere = app.db.prepare("SELECT kind, prompt FROM agent_pass WHERE scope = 'ask' AND task_id = ? ORDER BY n DESC LIMIT 1").get(ids.ask);
    assert.equal(derniere.kind, 'followup');
    assert.match(derniere.prompt, /Résume en une phrase/);
    const pieces = (await app.api('GET', `/api/questions/${ids.ask}`)).body.images;
    assert.equal(pieces.length, piecesAvant + 1, 'seul le fichier gardé part avec le suivi');
    assert.ok(pieces.some((p) => p.name === 'schema.txt'));
  });

  test('question libre : relancer une question déjà posée demande confirmation', async () => {
    await recharger();
    const carte = CARTE.ask(ids.ask);
    const avant = passes('ask', 'task_id', ids.ask);
    await page.locator(`${carte} [data-qrun]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    assert.equal(passes('ask', 'task_id', ids.ask), avant, 'annuler ne relance rien');
    await page.locator(`${carte} [data-qrun]`).click();
    await confirmer();
    await attendreServeur(async () => passes('ask', 'task_id', ids.ask) > avant, 'la question est reposée', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
  });

  test('question libre : « Coder à partir de la réponse » ouvre un codage, question et réponse en contexte', async () => {
    await recharger();
    await page.locator(`${CARTE.ask(ids.ask)} [data-qcode]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => /quorum/i.test(document.querySelector('#taskPrompt').value));
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('task.explore-to-code.title'));
    assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), 'Quorum', 'le libellé de la question suit');
    assert.equal(await page.locator('#taskReposWrap').isVisible(), true, 'les dépôts restent à choisir : une question n’en a pas');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  test('question libre : « Modifier » relit la question et enregistre la correction', async () => {
    // La modale de codage ouverte juste avant a fait passer la saveur courante au codage.
    await aller('ask');
    await page.locator(`${CARTE.ask(ids.ask)} [data-qedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('ask.edit-title'));
    assert.equal(await page.locator('#taskPrompt').inputValue(), 'Qu’est-ce qu’un quorum ?');
    assert.equal(await page.locator('#taskSubmitOnly').isVisible(), false);
    await page.locator('#taskPrompt').fill('Qu’est-ce qu’un quorum, précisément ?');
    await page.locator('#taskSubmit').click();
    await attendreServeur(async () => (await question(ids.ask)).prompt === 'Qu’est-ce qu’un quorum, précisément ?',
      'la question corrigée est enregistrée');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
