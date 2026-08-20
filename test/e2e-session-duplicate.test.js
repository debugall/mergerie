'use strict';
/* DUPLIQUER UNE SESSION DE CODAGE.
 *
 * Le besoin : relancer la même consigne sur un autre dépôt, ou repartir d'une session passée en
 * changeant deux mots. Sans ce geste, il faut tout retaper — ou, pire, modifier la session
 * existante en croyant en créer une autre, et perdre l'originale.
 *
 * Ce qui se joue ici est le CÂBLAGE de l'écran, pas le contrat de l'API : le formulaire est
 * partagé avec l'édition, et c'est l'absence d'identifiant qui fait que « Enregistrer » crée au
 * lieu d'écraser. Un test passant par l'API ne verrait rien de tout ça. Quatre points :
 *
 *   1. le formulaire arrive REMPLI (consigne, dépôt, branche de départ, options, vérificateur) ;
 *   2. enregistrer CRÉE une session de plus — l'originale est intacte ;
 *   3. la branche de travail est DÉCALÉE : deux sessions sur la même branche se marcheraient
 *      dessus, la seconde commitant par-dessus le travail de la première ;
 *   4. la session d'AGENT n'est pas reprise : on démarre une conversation neuve, pas la suite
 *      de celle de l'originale.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Dupliquer une session', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo; let origine; let exploration; let horsDepot; let dossier;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    repo = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body;
    origine = (await app.api('POST', '/api/tasks', {
      kind: 'code',
      prompt: 'Ajoute un timeout de 30 s sur les appels sortants',
      label: 'Timeouts',
      commit_message: 'PROJ-12 timeouts',
      auto_push: 1,
      ask_questions: 1,
      targets: [{ repo_id: repo.id, branch: 'feature/timeout', base_branch: 'main' }],
    })).body;
    /* Une session d'agent sur la cible : c'est CE champ qui ne doit pas être repris — le
       reprendre continuerait la conversation de l'originale au lieu d'en ouvrir une neuve. */
    app.db.prepare('UPDATE task_target SET session_key = ? WHERE task_id = ?').run('cle-agent-origine', origine.id);

    // Une EXPLORATION : sa branche est celle qu'on lit, elle ne doit surtout pas être décalée.
    exploration = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est vérifié le jeton ?', label: 'Auth',
      targets: [{ repo_id: repo.id, branch: 'develop' }],
    })).body;

    // …et une session HORS DÉPÔT, qui a son propre envoi et sa propre relecture.
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    dossier = path.join(racine, 'outil');
    fs.mkdirSync(dossier, { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    horsDepot = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Range les imports de ces scripts', label: 'Imports', ask_questions: 1, dirs: [dossier],
    })).body;
    app.db.prepare('UPDATE local_task_dir SET session_key = ? WHERE task_id = ?').run('cle-agent-locale', horsDepot.id);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#taskList .card');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirCopie = async () => {
    // Une modale laissée ouverte par le test précédent intercepterait le clic.
    if (await page.locator('#taskModal:not([hidden])').count()) {
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    }
    await page.locator(`#taskList .card[data-task="${origine.id}"] [data-tcopy]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#taskForm [name="prompt"]').value !== '');
  };

  const lireForm = () => page.evaluate(() => ({
    prompt: document.querySelector('#taskForm [name="prompt"]').value,
    label: (document.querySelector('#taskForm [name="label"]') || {}).value,
    commit: (document.querySelector('#taskForm [name="commit_message"]') || {}).value,
    push: (document.querySelector('#taskForm [name="auto_push"]') || {}).checked,
    questions: (document.querySelector('#taskForm [name="ask_questions"]') || {}).checked,
    session: (document.querySelector('#taskForm [name="session_id"]') || {}).value,
    rows: [...document.querySelectorAll('#targetRows .target-row')].map((r) => ({
      repo: r.querySelector('.t-repo').value,
      branch: r.querySelector('.t-branch').value,
      base: r.querySelector('.t-base') ? r.querySelector('.t-base').value : '',
    })),
  }));

  test('le formulaire s’ouvre rempli de la session d’origine', async () => {
    await ouvrirCopie();
    const f = await lireForm();
    assert.match(f.prompt, /timeout de 30 s/);
    assert.equal(f.label, 'Timeouts');
    assert.equal(f.commit, 'PROJ-12 timeouts');
    assert.equal(f.push, true, 'les options suivent : sans elles la copie ne ferait pas la même chose');
    assert.equal(f.questions, true);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].repo, String(repo.id), 'le dépôt est repris');
    assert.equal(f.rows[0].base, 'main', 'la branche de départ aussi');
  });

  /* La branche de travail est le SEUL champ volontairement décalé : deux sessions sur la même
     branche se marcheraient dessus, la seconde commitant par-dessus le travail de la première. */
  test('la branche de travail est décalée, la session d’agent n’est pas reprise', async () => {
    await ouvrirCopie();
    const f = await lireForm();
    assert.equal(f.rows[0].branch, 'feature/timeout-2');
    assert.equal(f.session, '', 'reprendre la session d’agent poursuivrait la conversation de l’originale');
  });

  /* LE point du geste : enregistrer CRÉE. Le formulaire est celui de l'édition — s'il gardait
     l'identifiant, on écraserait la session qu'on voulait copier. */
  test('enregistrer crée une session de plus et laisse l’originale intacte', async () => {
    const avant = (await app.api('GET', '/api/tasks')).body.length;
    await ouvrirCopie();
    await page.locator('#taskForm [name="prompt"]').fill('Version B : timeout de 10 s');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

    const apres = (await app.api('GET', '/api/tasks')).body;
    assert.equal(apres.length, avant + 1, 'une session de PLUS, pas une session modifiée');

    const copie = apres.find((t) => t.id !== origine.id);
    assert.match(copie.prompt, /Version B/);
    assert.equal(copie.label, 'Timeouts');
    assert.equal(copie.auto_push, 1);
    assert.equal(copie.targets[0].branch, 'feature/timeout-2');
    assert.equal(copie.targets[0].repo_id, repo.id);
    assert.equal(copie.targets[0].session_key || '', '', 'la copie démarre sans session d’agent');

    // L'ORIGINALE n'a pas bougé — c'est tout ce qui distingue « dupliquer » de « modifier ».
    const avant2 = (await app.api('GET', `/api/tasks/${origine.id}`)).body.task;
    assert.match(avant2.prompt, /timeout de 30 s/);
    assert.equal(avant2.targets[0].branch, 'feature/timeout');
    assert.equal(avant2.targets[0].session_key, 'cle-agent-origine');
  });

  /* Deuxième copie : « -2 » est pris, on propose « -3 ». Sinon la troisième session repartirait
     sur la branche de la deuxième, et le décalage n'aurait servi qu'une fois. */
  test('une deuxième copie évite la branche déjà prise', async () => {
    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#taskList .card');
    await ouvrirCopie();
    const f = await lireForm();
    assert.equal(f.rows[0].branch, 'feature/timeout-3');
    assert.deepEqual(erreurs, []);
  });

  /* LES AUTRES SAVEURS. Le formulaire est partagé, mais chacune a sa relecture — le hors dépôt
     a carrément son propre envoi et sa propre route. Éprouver le codage et supposer le reste est
     exactement ce qui laisse passer un champ perdu. Et ce qui change d'une saveur à l'autre n'est
     pas cosmétique : en exploration la branche est celle qu'on LIT, la décaler pointerait vers
     une branche inexistante et l'exploration échouerait. */
  const allerA = async (kind, liste) => {
    if (await page.locator('#taskModal:not([hidden])').count()) {
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    }
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForSelector(`${liste} .card`);
  };

  test('exploration : la branche lue n’est pas décalée, et enregistrer crée', async () => {
    await allerA('explore', '#taskList');
    const avant = (await app.api('GET', '/api/tasks')).body.length;
    await page.locator(`#taskList .card[data-task="${exploration.id}"] [data-tcopy]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#taskForm [name="prompt"]').value !== '');

    const f = await page.evaluate(() => ({
      info: document.querySelector('#taskExistingImgs').textContent,
      label: (document.querySelector('#taskForm [name="label"]') || {}).value,
      branche: document.querySelector('#targetRows .t-branch').value,
      repo: document.querySelector('#targetRows .t-repo').value,
    }));
    assert.equal(f.branche, 'develop', 'la branche qu’on LIT se recopie telle quelle');
    assert.equal(f.repo, String(repo.id));
    assert.equal(f.label, 'Auth');
    assert.ok(!/branche de travail/i.test(f.info), 'et l’écran ne parle pas d’un décalage qui n’a pas lieu');

    await page.locator('#taskForm [name="prompt"]').fill('Et le rafraîchissement du jeton ?');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

    const apres = (await app.api('GET', '/api/tasks')).body;
    assert.equal(apres.length, avant + 1);
    const copie = apres.find((t) => t.kind === 'explore' && t.id !== exploration.id);
    assert.equal(copie.kind, 'explore', 'la saveur suit : une exploration ne devient pas un codage');
    assert.match(copie.prompt, /rafraîchissement/);
    assert.equal(copie.targets[0].branch, 'develop');
    assert.match((await app.api('GET', `/api/tasks/${exploration.id}`)).body.task.prompt, /Où est vérifié/);
  });

  /* Le hors dépôt a SON envoi et SA route : le formulaire peut être rempli à l'écran et
     l'enregistrement perdre la moitié des champs sans que le codage n'en montre rien. */
  test('hors dépôt : les dossiers et les options se recopient, et « Créer sans lancer » crée', async () => {
    await allerA('local', '#localList');
    const avant = (await app.api('GET', '/api/local-tasks')).body.length;
    await page.locator(`#localList .card[data-local="${horsDepot.id}"] [data-lcopy]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#taskForm [name="prompt"]').value !== '');

    const f = await page.evaluate(() => ({
      label: (document.querySelector('#taskForm [name="label"]') || {}).value,
      questions: (document.querySelector('#taskForm [name="ask_questions"]') || {}).checked,
      session: (document.querySelector('#taskForm [name="session_id"]') || {}).value,
      // « Créer sans lancer » accompagne la création hors dépôt : il doit être là, comme pour une neuve.
      sansLancer: !document.querySelector('#taskSubmitOnly').hidden,
    }));
    assert.equal(f.label, 'Imports');
    assert.equal(f.questions, true);
    assert.equal(f.session, '', 'la session d’agent d’origine n’est pas reprise');
    assert.equal(f.sansLancer, true);

    await page.locator('#taskForm [name="prompt"]').fill('Range aussi les exports');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

    const apres = (await app.api('GET', '/api/local-tasks')).body;
    assert.equal(apres.length, avant + 1, 'une session de PLUS');
    const copie = apres.find((t) => t.id !== horsDepot.id);
    assert.match(copie.prompt, /exports/);
    assert.equal(copie.label, 'Imports');
    assert.equal(copie.ask_questions, 1);
    assert.deepEqual((copie.dirs || []).map((d) => d.path), [dossier], 'le dossier traité est le même');
    assert.equal((copie.dirs[0] || {}).session_key || '', '', 'la copie démarre sans session d’agent');

    // L'originale n'a pas bougé, session d'agent comprise.
    const avant2 = apres.find((t) => t.id === horsDepot.id);
    assert.match(avant2.prompt, /Range les imports/);
    assert.equal(avant2.dirs[0].session_key, 'cle-agent-locale');
    assert.deepEqual(erreurs, []);
  });
});
